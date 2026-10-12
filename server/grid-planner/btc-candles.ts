import { fetchOHLCV, CHART_CANDLE_POLICY } from '../lab/datafeed';
import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';
import { BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import { computeBtcDirection } from './direction';
import type { PlannerCandle } from './types';

const DAY = WEEK / 7, MONDAY = Date.UTC(1970, 0, 5);
const weekStart = (time: number) => Math.floor((time - MONDAY) / WEEK) * WEEK + MONDAY;
const validPrices = (c: PlannerCandle) => [c.open, c.high, c.low, c.close].every(n => Number.isFinite(n) && n > 0)
  && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close);

/** Only seven finalized native perpetual days on UTC Monday boundaries form a week. */
export function aggregatePacificaDailyWeeks(raw: PlannerCandle[], now: number): PlannerCandle[] {
  const weeks = new Map<number, PlannerCandle[]>();
  for (const c of raw) {
    if (c.provenance?.finality !== 'finalized') continue;
    if (!Number.isSafeInteger(c.time) || c.time <= 0 || c.time % DAY !== 0 || c.time + DAY > now
      || !validPrices(c) || !Number.isFinite(c.volume) || c.volume < 0
      || c.provenance.source !== 'pacifica' || c.provenance.venue !== 'pacifica'
      || c.provenance.basis !== 'perp' || c.provenance.proxy !== 'direct'
      || c.provenance.timeSemantic !== 'open_time' || c.provenance.aggregation !== undefined) return [];
    const start = weekStart(c.time), days = weeks.get(start) ?? [];
    days.push(c); weeks.set(start, days);
  }
  const result: PlannerCandle[] = [];
  for (const [time, days] of weeks) {
    days.sort((a, b) => a.time - b.time);
    if (time + WEEK > now || days.length !== 7 || !days.every((c, i) => c.time === time + i * DAY)) continue;
    const volume = days.reduce((sum, c) => sum + c.volume, 0);
    if (!Number.isFinite(volume)) return [];
    result.push({ time, open: days[0].open, high: Math.max(...days.map(c => c.high)), low: Math.min(...days.map(c => c.low)),
      close: days[6].close, volume, provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct',
        finality: 'finalized', timeSemantic: 'open_time', aggregation: 'weekly-from-daily' } });
  }
  return result.sort((a, b) => a.time - b.time);
}

/** Venue trade candles (/kline), never spot or mark/index candles. */
export async function pacificaBtcWeeklyCandles(now: number, signal: AbortSignal, interval: '1w' | '1d' = '1w'): Promise<PlannerCandle[]> {
  signal.throwIfAborted();
  if (!pacificaQuota.tryClaimImmediate('/kline', 'background')) return [];
  const duration = interval === '1w' ? WEEK : DAY, start = weekStart(now) - 56 * WEEK;
  const limit = interval === '1w' ? 57 : 400;
  const query = new URLSearchParams({ symbol: 'BTC', interval, start_time: String(start), end_time: String(now), limit: String(limit) });
  const response = await fetch(`https://api.pacifica.fi/api/v1/kline?${query}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const payload = await response.json();
  if (payload?.success !== true || !Array.isArray(payload.data) || !payload.data.length || payload.data.length > limit) return [];
  const candles: PlannerCandle[] = [];
  for (const row of payload.data) {
    if (!row || row.s !== 'BTC' || row.i !== interval || !Number.isSafeInteger(row.t) || row.t < start || row.t > now
      || (interval === '1w' ? weekStart(row.t) !== row.t : row.t % DAY !== 0)
      || !Number.isSafeInteger(row.T) || ![row.t + duration, row.t + duration - 1].includes(row.T)
      || !['o', 'h', 'l', 'c', 'v'].every(key => typeof row[key] === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(row[key]))) return [];
    const candle: PlannerCandle = { time: row.t, open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v),
      provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time',
        finality: row.t + duration <= now ? 'finalized' : 'forming' } };
    if (!validPrices(candle) || !Number.isFinite(candle.volume) || candle.volume < 0) return [];
    candles.push(candle);
  }
  candles.sort((a, b) => a.time - b.time);
  if (candles.some((c, i) => i > 0 && c.time === candles[i - 1].time)) return [];
  return interval === '1d' ? aggregatePacificaDailyWeeks(candles, now) : candles;
}

export async function plannerBtcWeeklyCandles(signal: AbortSignal): Promise<PlannerCandle[]> {
  const end = Date.now();
  signal.throwIfAborted();
  try {
    const candles = await fetchOHLCV('BTC/USDT', '1w', end - 56 * WEEK, end, undefined, {
      basisPolicy: { ...CHART_CANDLE_POLICY, acceptedFinality: ['finalized'] }, skipSpotFallback: true,
      bypassCache: true, cacheWritePolicy: 'skip', deadlineMs: 10_000,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    signal.throwIfAborted();
    if (computeBtcDirection(candles, Date.now()).regime !== 'unavailable') return candles;
  } catch { signal.throwIfAborted(); }
  const remaining = 15_000 - (Date.now() - end);
  if (remaining <= 0) return [];
  const fallbackSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(5_000, remaining))]);
  for (const interval of ['1w', '1d'] as const) {
    if (fallbackSignal.aborted) break;
    try {
      const candles = await pacificaBtcWeeklyCandles(Date.now(), fallbackSignal, interval);
      signal.throwIfAborted();
      if (computeBtcDirection(candles, Date.now()).regime !== 'unavailable') return candles;
    } catch { signal.throwIfAborted(); }
  }
  return [];
}
