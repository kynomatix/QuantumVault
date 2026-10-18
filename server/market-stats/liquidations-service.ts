import type { LiquidationStatsCard } from '../../shared/market-stats';
import { alignLiquidationInputs, modelMultiVenueLiquidations, LiquidationInputError, MODEL_DAYS, DISPLAY_DAYS,
  LIQUIDATION_DAY, HOUR, type LiquidationInputs, type ModelHour } from './liquidations-model';
import { loadOkxLiquidationHistory, loadOkxLiquidationInputs } from './liquidations-okx';
import type { LiquidationStats } from '../../shared/market-stats';
import { omittedRelay, type RelayRead } from './liquidations-relay';
import { dataRelayClient } from '../data-relay-client';

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
  relayRetryAt = 0;
  /** One bounded, current-day OKX snapshot, retained only while enrichment can recover. */
  recovery?: { day: number; hours: ModelHour[]; candles?: LiquidationStats['candles']; fetchedAt: number };
}
export type LiquidationStatsDeps = { cache: LiquidationStatsCache; now: () => number;
  loadInputs: (now: number) => Promise<LiquidationInputs>;
  loadHistory?: (now: number) => Promise<NonNullable<LiquidationStats['candles']>>;
  loadRelay?: (start: number, lastHour: number) => Promise<RelayRead> };

function missing(now: number, error: unknown): LiquidationStatsCard {
  return { status: 'unavailable', value: null, source: SOURCE, basis: BASIS, asOf: null, fetchedAt: now,
    expiresAt: now + NEGATIVE_WINDOW, gaps: error instanceof LiquidationInputError ? error.gaps : [],
    reason: error instanceof LiquidationInputError ? error.message : 'OKX hourly history could not be loaded within its deadline.' };
}

/** Read-only, in-memory daily model. Collection is independently owned by the server timer. */
export async function getLiquidationStats(deps: LiquidationStatsDeps, now: number): Promise<LiquidationStatsCard> {
  const cache = deps.cache, day = Math.floor(now / LIQUIDATION_DAY) * LIQUIDATION_DAY;
  const fallback = (): LiquidationStatsCard => cache.good && deps.now() < cache.good.expiresAt ? cache.good
    : cache.failure ?? missing(deps.now(), new LiquidationInputError('The last modelled observation is older than 26 hours.'));
  const recover = cache.successfulDay === day && cache.recovery?.day === day && now >= cache.relayRetryAt;
  if (cache.successfulDay === day && cache.good && now < cache.good.expiresAt && !recover && !cache.pending) return cache.good;
  if (now < cache.retryAt) return fallback();
  if (!cache.pending) {
    // Consume the hourly attempt before starting work, including concurrent callers/failures.
    cache.relayRetryAt = now + HOUR;
    if (cache.recovery?.day !== day) cache.recovery = undefined;
    cache.pending = (async () => {
      try {
        const start = day - MODEL_DAYS * LIQUIDATION_DAY;
        // Start the optional 4s budget alongside OKX, never after its pagination.
        const relayPromise = (async () => {
          try { return await deps.loadRelay?.(start, day - HOUR) ?? omittedRelay('disabled'); }
          catch { return omittedRelay('malformed'); }
        })();
        const okxPromise = (async () => {
          if (recover && cache.recovery) return cache.recovery;
          const inputs = await deps.loadInputs(now);
          const candles = await deps.loadHistory?.(now);
          return { day, hours: alignLiquidationInputs(inputs, start, day), candles, fetchedAt: inputs.fetchedAt };
        })();
        const [relay, snapshot] = await Promise.all([relayPromise, okxPromise]);
        const { hours, candles } = snapshot;
        const { value } = modelMultiVenueLiquidations(hours, day - DISPLAY_DAYS * LIQUIDATION_DAY, relay.series);
        if (candles) value.candles = candles;
        if (deps.now() >= day + FRESHNESS) throw new LiquidationInputError('The modelled observation exceeded its 26-hour freshness limit.');
        const venuesUsed = ['okx' as const, ...relay.series.map(s => s.venue)];
        const labels = { okx: 'OKX', binance: 'Binance', bybit: 'Bybit', hyperliquid: 'Hyperliquid' };
        cache.good = { status: 'available', value, source: relay.series.length ? venuesUsed.map(v => labels[v]).join(' + ') : SOURCE,
          basis: value.methodologyVersion === 'oi-leverage-v2' ? BASIS : BASIS.replace('oi-leverage-v2', 'oi-leverage-v3'), asOf: day,
          fetchedAt: snapshot.fetchedAt, expiresAt: day + FRESHNESS, gaps: [],
          coverage: { venuesUsed, priceVenue: 'okx', venues: relay.coverage } };
        cache.recovery = deps.loadRelay && relay.coverage.some(c => c.status === 'omitted') ? snapshot : undefined;
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
  loadRelay: dataRelayClient.read,
};
