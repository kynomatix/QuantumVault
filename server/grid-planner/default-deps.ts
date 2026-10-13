import { getAdapter } from '../protocol/adapter-registry';
import { plannerPoolCandles } from './candle-pool';
import { plannerBtcWeeklyCandles } from './btc-candles';
import { pool } from '../db';
import { PostgresBtcWeeklyStore } from './weekly-store';
import type { PlannerDeps } from './types';
import { PlannerReferences } from './pacifica-reference';

const references = new PlannerReferences();

export const defaultPlannerDeps: PlannerDeps = {
  now: Date.now,
  btcWeeklyCandles: plannerBtcWeeklyCandles,
  btcWeeklyStore: new PostgresBtcWeeklyStore(pool),
  getMarkets: () => getAdapter('pacifica').getMarkets(),
  rangeCandles: plannerPoolCandles,
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
  candles: plannerPoolCandles,
};
