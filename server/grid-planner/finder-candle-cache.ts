import { PERP_CHART_INTERVAL_MS } from './pacifica-candles';
import { GRID_HISTORY_MAX_BARS } from '../../shared/grid-lookback';
import type { PlannerCandle, PlannerDeps } from './types';

/** Opt-in finalized history cache. Each finder owns its cache and in-flight reads. */
export function createFinderCandleReader(read: PlannerDeps['candles'], now: () => number = Date.now): PlannerDeps['candles'] {
  const finalizedPoolCache = new Map<string, { market: string; timeframe: string; end: number; candles: PlannerCandle[] }>();
  const finalizedPoolJobs = new Map<string, { controller: AbortController; users: number; promise: Promise<PlannerCandle[]> }>();

  return async function finderCandles(market: string, timeframe: string, bars: number, signal: AbortSignal): Promise<PlannerCandle[]> {
    signal.throwIfAborted();
    const duration = PERP_CHART_INTERVAL_MS[timeframe];
    if (!['15m', '1h', '4h'].includes(timeframe) || !duration || !Number.isSafeInteger(bars) || bars < 1 || bars > GRID_HISTORY_MAX_BARS
      || !/^[A-Za-z0-9-]+$/.test(market.replace(/-PERP$/, ''))) return [];
    const end = Math.floor(now() / duration) * duration, key = `${market}:${timeframe}:${bars}:${end}`;
    for (const entry of finalizedPoolCache.values()) {
      if (entry.market === market && entry.timeframe === timeframe && entry.end === end && entry.candles.length >= bars)
        return entry.candles.slice(-bars);
    }
    let job = finalizedPoolJobs.get(key);
    if (job?.controller.signal.aborted) throw Error('Previous candle read is cancelling; try again');
    if (!job) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), bars > 200 ? 30_000 : 15_000);
      const created = { controller, users: 0, promise: Promise.resolve<PlannerCandle[]>([]) };
      finalizedPoolJobs.set(key, created);
      created.promise = read(market, timeframe, bars, controller.signal).then(candles => {
        controller.signal.throwIfAborted();
        if (candles.length === bars) {
          finalizedPoolCache.set(key, { market, timeframe, end, candles });
          if (finalizedPoolCache.size > 64) finalizedPoolCache.delete(finalizedPoolCache.keys().next().value!);
        }
        return candles;
      }).finally(() => { clearTimeout(timer); if (finalizedPoolJobs.get(key) === created) finalizedPoolJobs.delete(key); });
      job = created;
    }
    const owned = job;
    owned.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (candles?: PlannerCandle[], error?: unknown) => {
        if (settled) return; settled = true;
        signal.removeEventListener('abort', abort);
        if (!--owned.users) owned.controller.abort();
        if (error) reject(error); else resolve(candles!);
      };
      const abort = () => finish(undefined, signal.reason ?? Error('Candle request cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      owned.promise.then(candles => finish(candles), error => finish(undefined, error));
      if (signal.aborted) abort();
    });
  };
}
