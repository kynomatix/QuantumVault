import { z } from 'zod';
import type { LiquidationCoverageReason, LiquidationVenueCoverage } from '../../shared/market-stats';
import { HOUR, MODEL_DAYS, LIQUIDATION_DAY, type OiHour } from './liquidations-model';

export const RELAY_VENUES = ['binance', 'bybit', 'hyperliquid'] as const;
export type RelayVenue = typeof RELAY_VENUES[number];
export type RelaySeries = { venue: RelayVenue; rows: (OiHour & { fetchedAt: number })[] };
export type RelayRead = { series: RelaySeries[]; coverage: LiquidationVenueCoverage[] };
type SafeReason = Extract<LiquidationCoverageReason, 'disabled' | 'deadline' | 'http' | 'malformed'>;
export type CollectResult = { status: 'done' | 'not-ready' | SafeReason; httpStatus?: number; durationMs: number; partial?: boolean };
export type DataRelayClient = { read: (start: number, lastHour: number) => Promise<RelayRead>; collect: () => Promise<CollectResult> };
type Options = { url?: string; token?: string; fetch?: typeof fetch; now?: () => number };
const MAX_BODY = 2 * 1024 * 1024;
const MAX_HOURS = MODEL_DAYS * 24;
const utc = z.string().max(32).datetime();
const nonnegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const rowSchema = z.object({ hour: utc, oiCoins: nonnegative, oiUsd: nonnegative.nullable(),
  open: positive, high: positive, low: positive, close: positive,
  sourceKind: z.string().min(1).max(80), fetchedAt: utc });
const venueSchema = z.object({ venue: z.enum(RELAY_VENUES).optional(), symbol: z.literal('BTC').optional(),
  interval: z.literal('1h').optional(), rows: z.array(rowSchema).max(MAX_HOURS),
  gaps: z.array(z.object({ hour: utc, reason: z.string().max(256) })).max(MAX_HOURS) });
const venueMap = z.object({ binance: z.unknown(), bybit: z.unknown(), hyperliquid: z.unknown() });
const envelopeSchema = z.object({ symbol: z.literal('BTC'), interval: z.literal('1h'), generatedAt: utc,
  // Both layouts retain the same explicit venue identities; never infer a venue from row order.
  venues: venueMap.optional(), binance: z.unknown(), bybit: z.unknown(), hyperliquid: z.unknown() });
function validWindow(start: number, lastHour: number) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(lastHour) && start % HOUR === 0 && lastHour % HOUR === 0
    && Math.abs(start) <= 8.64e15 && Math.abs(lastHour) <= 8.64e15
    && lastHour >= start && lastHour - start < MODEL_DAYS * LIQUIDATION_DAY;
}

class SafeFailure extends Error { constructor(public reason: SafeReason, public httpStatus?: number) { super(reason); } }
export function omittedRelay(reason: SafeReason): RelayRead {
  return { series: [], coverage: RELAY_VENUES.map(venue => ({ venue, status: 'omitted', reason,
    firstObservation: null, lastObservation: null, lastFetchedAt: null, gaps: [], gapHours: 0, terminalLagHours: 0 })) };
}

/** Missing hours are derived from the rows, even if an upstream gap record is absent. */
export function parseRelayRead(raw: unknown, start: number, lastHour: number, now: number): RelayRead {
  if (!validWindow(start, lastHour)) return omittedRelay('malformed');
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success || !Number.isFinite(Date.parse(envelope.data.generatedAt))
    || Date.parse(envelope.data.generatedAt) > now + 5 * 60_000) return omittedRelay('malformed');
  const result: RelayRead = { series: [], coverage: [] };
  for (const venue of RELAY_VENUES) {
    const invalid = () => result.coverage.push(omittedRelay('malformed').coverage.find(c => c.venue === venue)!);
    const parsed = venueSchema.safeParse((envelope.data.venues ?? envelope.data)[venue]);
    if (!parsed.success || (parsed.data.venue !== undefined && parsed.data.venue !== venue)) { invalid(); continue; }
    const rows: RelaySeries['rows'] = [], seen = new Set<number>();
    let bad = false, previous = -Infinity;
    for (const row of parsed.data.rows) {
      const time = Date.parse(row.hour), fetchedAt = Date.parse(row.fetchedAt);
      if (!Number.isSafeInteger(time) || time % HOUR || time < start || time > lastHour || time <= previous
        || !Number.isFinite(fetchedAt) || fetchedAt < time + HOUR || fetchedAt > now + 5 * 60_000
        || fetchedAt > Date.parse(envelope.data.generatedAt) + 5 * 60_000
        || row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) || row.low > row.high) { bad = true; break; }
      rows.push({ time, btc: row.oiCoins, fetchedAt }); seen.add(time); previous = time;
    }
    const gapTimes = new Set<number>();
    for (const gap of parsed.data.gaps) {
      const time = Date.parse(gap.hour);
      if (!Number.isSafeInteger(time) || time % HOUR || time < start || time > lastHour || seen.has(time) || gapTimes.has(time)) { bad = true; break; }
      gapTimes.add(time);
    }
    if (bad) { invalid(); continue; }
    const first = rows[0], last = rows.at(-1);
    const coverage: LiquidationVenueCoverage = { venue, status: 'omitted', firstObservation: first?.time ?? null,
      lastObservation: last?.time ?? null, lastFetchedAt: last?.fetchedAt ?? null, gaps: [], gapHours: 0,
      terminalLagHours: last ? (lastHour - last.time) / HOUR : 0 };
    if (first && last) for (let time = first.time; time <= last.time; time += HOUR) {
      if (seen.has(time)) continue;
      coverage.gapHours++;
      const range = coverage.gaps.at(-1);
      if (range && range.end === time - HOUR) range.end = time;
      else coverage.gaps.push({ start: time, end: time });
    }
    if (!last) coverage.reason = 'empty';
    else if (lastHour - last.time > 3 * HOUR) coverage.reason = 'stale';
    else if (!rows.some((r, i) => i > 0 && r.time === rows[i - 1].time + HOUR)) coverage.reason = 'baseline-only';
    else { coverage.status = 'included'; result.series.push({ venue, rows }); }
    result.coverage.push(coverage);
  }
  return result;
}

/** Server-only, bounded transport. No exception or upstream text crosses this boundary. */
export function createDataRelayClient(options: Options): DataRelayClient {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  let origin: URL | undefined;
  try {
    if (options.url && options.token) {
      const candidate = new URL(options.url);
      if (candidate.protocol === 'https:' && !candidate.username && !candidate.password
        && candidate.pathname === '/' && !candidate.search && !candidate.hash) origin = candidate;
    }
  } catch { /* Invalid configuration disables this optional source. */ }
  async function request(path: string, method: 'GET' | 'POST', budget: number, cap: number,
    validate: (raw: unknown) => unknown): Promise<{ value: unknown; httpStatus: number }> {
    if (!origin) throw new SafeFailure('disabled');
    const controller = new AbortController(), started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SafeFailure('deadline')); }, budget);
    });
    const work = (async () => {
      const response = await fetcher(new URL(path, origin), { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' } });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new SafeFailure('deadline'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new SafeFailure('http', response.status); }
      reader = response.body?.getReader();
      if (!reader || Number(response.headers.get('content-length')) > cap) throw new SafeFailure('malformed');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) throw new SafeFailure('malformed');
        chunks.push(value);
      }
      controller.signal.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (now() - started >= budget) throw new SafeFailure('deadline');
      return { value, httpStatus: response.status };
    })();
    try { return await Promise.race([work, deadline]); }
    catch (error) { throw error instanceof SafeFailure ? error : new SafeFailure(controller.signal.aborted ? 'deadline' : 'malformed'); }
    finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
  return {
    async read(start, lastHour) {
      if (!validWindow(start, lastHour)) return omittedRelay('malformed');
      const query = new URLSearchParams({ symbol: 'BTC', start: new Date(start).toISOString(), end: new Date(lastHour).toISOString() });
      try { return (await request(`/v1/oi/all?${query}`, 'GET', 4_000, MAX_BODY,
        raw => parseRelayRead(raw, start, lastHour, now()))).value as RelayRead; }
      catch (error) { return omittedRelay(error instanceof SafeFailure ? error.reason : 'malformed'); }
    },
    async collect() {
      const started = now();
      try {
        const { value, httpStatus } = await request('/v1/collect', 'POST', 75_000, 32 * 1024, raw => raw);
        const partial = value && typeof value === 'object' && 'partial' in value && typeof value.partial === 'boolean' ? value.partial : undefined;
        return { status: 'done', httpStatus, durationMs: Math.max(0, now() - started), ...(partial === undefined ? {} : { partial }) };
      } catch (error) {
        const failure = error instanceof SafeFailure ? error : new SafeFailure('malformed');
        return { status: failure.httpStatus === 404 || failure.httpStatus === 405 ? 'not-ready' : failure.reason,
          httpStatus: failure.httpStatus, durationMs: Math.max(0, now() - started) };
      }
    },
  };
}
