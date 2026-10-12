import { btcTrendExpiresAt, BTC_TREND_NEGATIVE_CACHE_MS, BTC_TREND_PERIODS, BTC_TREND_WEEK_MS, type GridDirectionSuggestion } from '../../shared/grid-direction';
import type { PlannerCandle, PlannerDeps } from './types';

const unavailable = (now: number, reason: string): GridDirectionSuggestion => ({ regime: 'unavailable',
  sourceVenue: null, asOf: null, movingAverage: null, lastClose: null, retrievedAt: now,
  serverNow: now, expiresAt: now + BTC_TREND_NEGATIVE_CACHE_MS, reason });

const aggregation = (c: PlannerCandle) => c.provenance.source === 'pacifica' ? c.provenance.aggregation : undefined;

export function computeBtcDirection(raw: PlannerCandle[], now: number): GridDirectionSuggestion {
  // A forming candle never participates, even if its close would reverse the suggestion.
  const candles = raw.filter(c => c.provenance?.finality === 'finalized').sort((a, b) => a.time - b.time).slice(-BTC_TREND_PERIODS);
  if (candles.length !== BTC_TREND_PERIODS) return unavailable(now, 'Fewer than 50 finalized BTC weekly candles.');
  const venue = candles[0].provenance.source;
  const sourceAggregation = aggregation(candles[0]);
  if (!['okx', 'gate', 'hyperliquid', 'pacifica'].includes(venue)
    || (sourceAggregation !== undefined && sourceAggregation !== 'weekly-from-daily') || !candles.every((c, i) =>
    Number.isSafeInteger(c.time) && c.time > 0 && c.time + BTC_TREND_WEEK_MS <= now
    && (!i || c.time - candles[i - 1].time === BTC_TREND_WEEK_MS)
    && [c.open, c.high, c.low, c.close].every(n => Number.isFinite(n) && n > 0)
    && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)
    && c.provenance.source === venue && c.provenance.venue === venue && c.provenance.basis === 'perp'
    && aggregation(c) === sourceAggregation
    && c.provenance.proxy === 'direct' && c.provenance.timeSemantic === 'open_time')) {
    return unavailable(now, 'BTC weekly history is incomplete or its source cannot be verified.');
  }
  const last = candles[candles.length - 1], asOf = last.time + BTC_TREND_WEEK_MS;
  if (now - asOf >= BTC_TREND_WEEK_MS) return unavailable(now, 'BTC weekly history is stale.');
  const movingAverage = candles.reduce((sum, candle) => sum + candle.close / BTC_TREND_PERIODS, 0);
  if (!Number.isFinite(movingAverage) || movingAverage <= 0 || last.close === movingAverage) {
    return unavailable(now, 'BTC has no above/below 50-week average suggestion.');
  }
  return { regime: last.close > movingAverage ? 'above' : 'below', sourceVenue: venue as 'okx' | 'gate' | 'hyperliquid' | 'pacifica',
    ...(sourceAggregation ? { sourceAggregation } : {}),
    asOf, movingAverage, lastClose: last.close, retrievedAt: now, serverNow: now,
    // Hold this completed week's result through the next Monday's publication grace.
    expiresAt: btcTrendExpiresAt(asOf) };
}

// One instance belongs to the Planner route registration: one BTC cache and one shared upstream job.
export class PlannerDirection {
  private cached?: { insertedAt: number; value: GridDirectionSuggestion };
  private job?: Promise<GridDirectionSuggestion>;
  constructor(private deps: Pick<PlannerDeps, 'now' | 'btcWeeklyCandles'>) {}

  async read(): Promise<GridDirectionSuggestion> {
    const now = this.deps.now();
    if (this.cached && now >= this.cached.insertedAt && now < this.cached.value.expiresAt) {
      const value = this.cached.value;
      return { ...value, serverNow: now };
    }
    if (this.job) return this.job;
    this.job = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let value: GridDirectionSuggestion;
      try {
        const candles = await Promise.race([
          this.deps.btcWeeklyCandles?.(controller.signal) ?? Promise.resolve([]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(new Error('BTC weekly candle deadline exceeded'));
          }, 15_000); }),
        ]);
        value = computeBtcDirection(candles, this.deps.now());
      } catch { value = unavailable(this.deps.now(), 'BTC weekly candles are unavailable.'); }
      finally { clearTimeout(timer); }
      this.cached = { insertedAt: this.deps.now(), value };
      return value;
    })().finally(() => { this.job = undefined; });
    return this.job;
  }
}
