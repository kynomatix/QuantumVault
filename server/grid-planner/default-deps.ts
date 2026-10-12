import { getAdapter } from '../protocol/adapter-registry';
import { fetchOHLCV, CHART_CANDLE_POLICY } from '../lab/datafeed';
import { plannerBtcWeeklyCandles } from './btc-candles';
import { pool } from '../db';
import { PostgresBtcWeeklyStore } from './weekly-store';
import type { PlannerDeps } from './types';
import { pacificaPlannerCandles } from './pacifica-candles';
import { PlannerReferences } from './pacifica-reference';
import { validateCandles } from './chart';

const references = new PlannerReferences();

export const defaultPlannerDeps: PlannerDeps = {
  now: Date.now,
  btcWeeklyCandles: plannerBtcWeeklyCandles,
  btcWeeklyStore: new PostgresBtcWeeklyStore(pool),
  getMarkets: () => getAdapter('pacifica').getMarkets(),
  refreshReference: (market, symbol, signal) => references.refresh(market, symbol, signal),
  cachedReference: market => {
    const refreshed = references.cached(market);
    const adapter = getAdapter('pacifica');
    const price = adapter.getCachedPrices?.([market])[market];
    const observedAt = adapter.getCachedPriceMeta?.([market]).oldestFetchedAt ?? null;
    const cached = price === undefined ? null : { price, observedAt };
    if (!refreshed) return cached;
    // Neither cache may renew the other: choose the newer valid real observation.
    return cached && Number.isFinite(cached.price) && cached.price > 0 && cached.observedAt !== null
      && Number.isSafeInteger(cached.observedAt) && cached.observedAt <= Date.now() && cached.observedAt > refreshed.observedAt
      ? cached : refreshed;
  },
  candles: async (market, timeframe, bars, signal) => {
    const end = Date.now(), duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 14_400_000;
    signal.throwIfAborted();
    try {
      const candles = await fetchOHLCV(market.replace(/-PERP$/, ''), timeframe, end - bars * duration, end, undefined, {
        basisPolicy: CHART_CANDLE_POLICY, skipSpotFallback: true, bypassCache: true,
        cacheWritePolicy: 'skip', deadlineMs: 10_000,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      signal.throwIfAborted();
      if (validateCandles(candles, Date.now())) return candles;
    } catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    const remaining = 15_000 - (Date.now() - end);
    if (remaining <= 0) return [];
    try {
      return await pacificaPlannerCandles(market.replace(/-PERP$/, ''), timeframe, bars, Date.now(),
        AbortSignal.any([signal, AbortSignal.timeout(Math.min(5_000, remaining))]));
    } catch { signal.throwIfAborted(); return []; }
  },
};
