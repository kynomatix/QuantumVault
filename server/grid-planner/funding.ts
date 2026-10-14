import type { FundingSignal } from '../../shared/grid-signals';
import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';

const TTL = 300_000;
export function parsePlannerFunding(payload: unknown, observedAt: number): Map<string, FundingSignal> {
  const result = new Map<string, FundingSignal>();
  if (!payload || typeof payload !== 'object' || !Number.isSafeInteger(observedAt) || observedAt <= 0) return result;
  const p = payload as { success?: unknown; data?: unknown };
  if (p.success !== true || !Array.isArray(p.data) || p.data.length > 512) return result;
  for (const row of p.data) {
    if (!row || typeof row.symbol !== 'string' || !/^[A-Za-z0-9-]+$/.test(row.symbol) || row.instrument_type === 'spot') continue;
    const market = `${row.symbol}-PERP`;
    const unknown = (reason: string): FundingSignal => ({ state: 'unavailable', reason });
    if (result.has(market)) { result.set(market, unknown('Duplicate Pacifica funding rows.')); continue; }
    const next = Object.hasOwn(row, 'next_funding_rate'), raw = next ? row.next_funding_rate : row.funding_rate;
    if (typeof raw !== 'string' || raw.length > 80 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)
      || !Number.isFinite(Number(raw)) || !Number.isFinite(Number(raw) * 24 * 100)) {
      result.set(market, unknown('Pacifica hourly funding rate is missing or invalid.')); continue;
    }
    result.set(market, { state: 'available', market, hourlyRate: Number(raw),
      basis: next ? 'next-hour estimate' : 'last settled hour', observedAt, expiresAt: observedAt + TTL });
  }
  return result;
}

/** Adapter metadata drops the next-hour field and its timestamp. One cheap /info read serves all markets. */
export class PlannerFunding {
  private cache: { rows: Map<string, FundingSignal>; observedAt: number } | undefined;
  private job: Promise<Map<string, FundingSignal>> | undefined;
  private lastAttempt = -Infinity;
  constructor(private now = Date.now, private fetcher: typeof fetch = fetch,
    private claim = () => pacificaQuota.tryClaimImmediate('/info', 'background', 'grid-planner.funding')) {}
  async read(market: string): Promise<FundingSignal> {
    const now = this.now(), unknown = (reason: string): FundingSignal => ({ state: 'unavailable', reason });
    let rows: Map<string, FundingSignal>;
    if (this.cache && now >= this.cache.observedAt && now < this.cache.observedAt + TTL) rows = this.cache.rows;
    else {
      if (!this.job) {
        if (now - this.lastAttempt < 60_000) return unknown('Pacifica funding unavailable; refresh later.');
        this.lastAttempt = now;
        if (!this.claim()) return unknown('Pacifica funding quota unavailable; refresh later.');
        const startedAt = now;
        this.job = this.fetcher('https://api.pacifica.fi/api/v1/info', { signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' } })
          .then(async response => {
            if (!response.ok) throw Error('Pacifica funding read failed.');
            const parsed = parsePlannerFunding(await response.json(), startedAt);
            if (parsed.size === 0 || this.now() < startedAt || this.now() >= startedAt + TTL) throw Error('Pacifica funding observation unavailable.');
            this.cache = { rows: parsed, observedAt: startedAt }; return parsed;
          }).finally(() => { this.job = undefined; });
      }
      try { rows = await this.job; } catch { return unknown('Pacifica /info funding read failed or returned invalid data.'); }
    }
    const value = rows.get(market);
    if (value?.state === 'available' && this.now() >= value.expiresAt) return unknown('Pacifica funding observation expired.');
    return value ?? unknown('Pacifica /info has no funding rate for this market.');
  }
}
