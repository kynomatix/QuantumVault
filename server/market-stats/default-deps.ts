import { pool } from '../db';
import { PlannerDirection } from '../grid-planner/direction';
import { PostgresBtcWeeklyStore } from '../grid-planner/weekly-store';
import { plannerBtcWeeklyCandles } from '../grid-planner/btc-candles';
import { readPlannerPerpSource } from '../lab/datafeed';
import { pacificaPerpWindow } from '../grid-planner/pacifica-candles';
import { getCotDisplaySnapshot } from '../ai-trader/cot-service';
import { fetchHlDisplaySnapshot } from '../ai-trader/hl-context';
import { boundedStatsPool } from './bounded-db';
import { DAY, utcDayStart, validDailyWindow } from './sources';
import { MarketStatsCache } from './cache';
import type { MarketStatsDeps } from './service';

export async function statsDailyCandles() {
  const now = Date.now(), end = utcDayStart(now), start = end - 364 * DAY;
  const signal = AbortSignal.timeout(12_000);
  for (const source of ['okx', 'gate', 'hyperliquid', 'pacifica'] as const) {
    signal.throwIfAborted();
    try {
      const entry = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
      const raw = source === 'pacifica' ? await pacificaPerpWindow('BTC', '1d', start, end, entry)
        : await readPlannerPerpSource(source, 'BTC', '1d', start, end, entry);
      signal.throwIfAborted();
      const candles = raw.filter(c => c.time >= start && c.time < end);
      if (validDailyWindow(candles, Date.now())) return { candles, fetchedAt: Date.now() };
    } catch { signal.throwIfAborted(); }
  }
  return { candles: [], fetchedAt: Date.now() };
}

export const defaultMarketStatsDeps: MarketStatsDeps = {
  cache: new MarketStatsCache(), now: Date.now,
  direction: () => new PlannerDirection({ now: Date.now, btcWeeklyCandles: plannerBtcWeeklyCandles,
    btcWeeklyStore: new PostgresBtcWeeklyStore(boundedStatsPool(pool, Date.now() + 24_000)) }).read(),
  dailyCandles: statsDailyCandles,
  cot: () => getCotDisplaySnapshot(boundedStatsPool(pool, Date.now() + 24_000), Date.now()),
  funding: () => fetchHlDisplaySnapshot('BTC-PERP'),
};
