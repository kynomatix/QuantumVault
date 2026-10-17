import type { MarketStats, StatsCard, CycleStats } from '../../shared/market-stats';
import type { GridDirectionSuggestion } from '../../shared/grid-direction';
import type { PlannerCandle } from '../grid-planner/types';
import { MarketStatsCache } from './cache';
import { cycleStats, dowStats, cotStats, fundingStats, unavailable, type CotDisplay, type FundingCapture } from './sources';

export interface MarketStatsDeps {
  cache: MarketStatsCache;
  now: () => number;
  direction: () => Promise<GridDirectionSuggestion>;
  dailyCandles: () => Promise<{ candles: PlannerCandle[]; fetchedAt: number }>;
  cot: () => Promise<CotDisplay | null>;
  funding: () => Promise<FundingCapture | null>;
}

/** Backing service for the future AI companion's read-only get_market_stats tool. */
export async function getMarketStats(deps: MarketStatsDeps, now: number): Promise<MarketStats> {
  const read = <T extends { expiresAt: number }>(key: string, load: () => Promise<T>, fallback: () => T) =>
    deps.cache.read(key, now, async () => { try { return await load(); } catch { return fallback(); } }, value => value.expiresAt);
  const [cycleResult, dowResult, cotResult, fundingResult] = await Promise.all([
    read('cycle', async () => cycleStats(await deps.direction(), deps.now()),
      () => unavailable<CycleStats>('Shared BTC weekly store', '50-week simple moving average', deps.now(), 'BTC weekly history is unavailable.')),
    read('dow', async () => {
      const { candles, fetchedAt } = await deps.dailyCandles(), value = dowStats(candles, deps.now(), fetchedAt);
      return { value, expiresAt: Math.min(value.daily.expiresAt, value.weekly.expiresAt) };
    }, () => { const value = dowStats([], deps.now(), deps.now()); return { value, expiresAt: Math.min(value.daily.expiresAt, value.weekly.expiresAt) }; }),
    read('cot', async () => cotStats(await deps.cot(), deps.now()), () => cotStats(null, deps.now())),
    read('funding', async () => fundingStats(await deps.funding(), deps.now()), () => fundingStats(null, deps.now())),
  ]);
  const serverNow = deps.now();
  const fresh = <T>(card: StatsCard<T>): StatsCard<T> => card.status === 'available' && card.expiresAt <= serverNow
    ? { ...card, status: 'unavailable', value: null, reason: 'The observation expired while loading; check again.' } : card;
  const cycle = fresh(cycleResult), cot = fresh(cotResult), funding = fresh(fundingResult);
  const dow = { daily: fresh(dowResult.value.daily), weekly: fresh(dowResult.value.weekly) };
  return { serverNow, cycle, dow, cot, funding,
    expiresAt: Math.min(cycle.expiresAt, dow.daily.expiresAt, dow.weekly.expiresAt, cot.expiresAt, funding.expiresAt) };
}
