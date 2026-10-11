import { getAdapter } from '../protocol/adapter-registry';
import { fetchOHLCV, CHART_CANDLE_POLICY } from '../lab/datafeed';
import type { PlannerDeps } from './types';

export const defaultPlannerDeps: PlannerDeps = {
  now: Date.now,
  getMarkets: () => getAdapter('pacifica').getMarkets(),
  cachedReference: market => {
    const adapter = getAdapter('pacifica');
    const price = adapter.getCachedPrices?.([market])[market];
    const observedAt = adapter.getCachedPriceMeta?.([market]).oldestFetchedAt ?? null;
    return price === undefined ? null : { price, observedAt };
  },
  candles: (market, timeframe, bars, signal) => {
    const end = Date.now(), duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 14_400_000;
    return fetchOHLCV(market.replace(/-PERP$/, ''), timeframe, end - bars * duration, end, undefined, {
      basisPolicy: CHART_CANDLE_POLICY, skipSpotFallback: true, bypassCache: true,
      cacheWritePolicy: 'skip', deadlineMs: 15_000, signal,
    });
  },
};
