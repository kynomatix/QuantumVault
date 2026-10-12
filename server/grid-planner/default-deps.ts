import { getAdapter } from '../protocol/adapter-registry';
import { fetchOHLCV, CHART_CANDLE_POLICY } from '../lab/datafeed';
import type { PlannerDeps } from './types';
import { pacificaPlannerCandles } from './pacifica-candles';

export const defaultPlannerDeps: PlannerDeps = {
  now: Date.now,
  getMarkets: () => getAdapter('pacifica').getMarkets(),
  cachedReference: market => {
    const adapter = getAdapter('pacifica');
    const price = adapter.getCachedPrices?.([market])[market];
    const observedAt = adapter.getCachedPriceMeta?.([market]).oldestFetchedAt ?? null;
    return price === undefined ? null : { price, observedAt };
  },
  candles: async (market, timeframe, bars, signal) => {
    const end = Date.now(), duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 14_400_000;
    signal.throwIfAborted();
    try {
      const candles = await pacificaPlannerCandles(market.replace(/-PERP$/, ''), timeframe, bars, end,
        AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
      if (candles.length) { signal.throwIfAborted(); return candles; }
    } catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    const remaining = 15_000 - (Date.now() - end);
    if (remaining <= 0) return [];
    return fetchOHLCV(market.replace(/-PERP$/, ''), timeframe, end - bars * duration, end, undefined, {
      basisPolicy: CHART_CANDLE_POLICY, skipSpotFallback: true, bypassCache: true,
      cacheWritePolicy: 'skip', deadlineMs: remaining, signal,
    });
  },
};
