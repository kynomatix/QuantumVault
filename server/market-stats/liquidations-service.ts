import type { LiquidationStatsCard } from '../../shared/market-stats';
import { alignLiquidationInputs, modelLiquidations, LiquidationInputError, MODEL_DAYS, DISPLAY_DAYS,
  LIQUIDATION_DAY, HOUR, type LiquidationInputs } from './liquidations-model';
import { loadOkxLiquidationHistory, loadOkxLiquidationInputs } from './liquidations-okx';
import type { LiquidationStats } from '../../shared/market-stats';

const NEGATIVE_WINDOW = 15 * 60_000;
const FRESHNESS = 26 * HOUR;
const SOURCE = 'OKX BTC-USDT-SWAP';
const BASIS = 'oi-leverage-v2; hourly BTC OI changes, closes spread across venue OI, assumed 50/50 long/short and fixed leverage; USD-equivalent notional';
export class LiquidationStatsCache {
  good?: Extract<LiquidationStatsCard, { status: 'available' }>;
  successfulDay?: number;
  retryAt = 0;
  failure?: LiquidationStatsCard;
  pending?: Promise<LiquidationStatsCard>;
}
export type LiquidationStatsDeps = { cache: LiquidationStatsCache; now: () => number;
  loadInputs: (now: number) => Promise<LiquidationInputs>;
  loadHistory?: (now: number) => Promise<NonNullable<LiquidationStats['candles']>> };

function missing(now: number, error: unknown): LiquidationStatsCard {
  return { status: 'unavailable', value: null, source: SOURCE, basis: BASIS, asOf: null, fetchedAt: now,
    expiresAt: now + NEGATIVE_WINDOW, gaps: error instanceof LiquidationInputError ? error.gaps : [],
    reason: error instanceof LiquidationInputError ? error.message : 'OKX hourly history could not be loaded within its deadline.' };
}

/** Read-only companion-ready entry point. No DB, worker, startup fetch or recurring work. */
export async function getLiquidationStats(deps: LiquidationStatsDeps, now: number): Promise<LiquidationStatsCard> {
  const cache = deps.cache, day = Math.floor(now / LIQUIDATION_DAY) * LIQUIDATION_DAY;
  const fallback = (): LiquidationStatsCard => cache.good && deps.now() < cache.good.expiresAt ? cache.good
    : cache.failure ?? missing(deps.now(), new LiquidationInputError('The last modelled observation is older than 26 hours.'));
  if (cache.successfulDay === day && cache.good && now < cache.good.expiresAt) return cache.good;
  if (now < cache.retryAt) return fallback();
  if (!cache.pending) {
    cache.pending = (async () => {
      try {
        const inputs = await deps.loadInputs(now);
        const candles = await deps.loadHistory?.(now);
        const hours = alignLiquidationInputs(inputs, day - MODEL_DAYS * LIQUIDATION_DAY, day);
        const { value } = modelLiquidations(hours, day - DISPLAY_DAYS * LIQUIDATION_DAY);
        if (candles) value.candles = candles;
        if (deps.now() >= day + FRESHNESS) throw new LiquidationInputError('The modelled observation exceeded its 26-hour freshness limit.');
        cache.good = { status: 'available', value, source: SOURCE, basis: BASIS, asOf: day,
          fetchedAt: inputs.fetchedAt, expiresAt: day + FRESHNESS, gaps: [] };
        cache.successfulDay = day; cache.retryAt = 0; cache.failure = undefined;
        return cache.good;
      } catch (error) {
        cache.failure = missing(deps.now(), error); cache.retryAt = deps.now() + NEGATIVE_WINDOW;
        return fallback();
      }
    })().finally(() => { cache.pending = undefined; });
  }
  const result = await cache.pending;
  return result.status === 'available' && deps.now() >= result.expiresAt ? fallback() : result;
}

export const defaultLiquidationStatsDeps: LiquidationStatsDeps = {
  cache: new LiquidationStatsCache(), now: Date.now, loadInputs: loadOkxLiquidationInputs, loadHistory: loadOkxLiquidationHistory,
};
