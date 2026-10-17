import { CHART_CANDLE_POLICY, type ProvenancedOHLCV } from '../lab/datafeed';
import { getCachedCandles, saveCandlesToDb } from '../lab/candle-store';
import { chartPoolCandles, validPerpChartSeries, type PerpChartSource } from '../grid-planner/candle-pool';
import { PERP_CHART_INTERVAL_MS } from '../grid-planner/pacifica-candles';
import type { PlannerCandle } from '../grid-planner/types';

type ChartCacheEntry = { candles: PlannerCandle[]; observedAt: number };
// Chart-only fallback cache: the shared DB schema does not admit Pacifica. Keeping
// fallback history here also leaves scanner/Lab cache admission unchanged.
const chartCache = new Map<string, ChartCacheEntry>();
const MAX_SERIES = 32, MAX_BARS = 16_000, MAX_TOTAL_BARS = 100_000;
export class ChartCandlesUnavailableError extends Error {
  constructor(public readonly reason: 'cache_read_failed_pool_empty' | 'cache_read_failed_pool_unavailable' | 'candle_pool_unavailable') {
    super(`Chart candles unavailable: ${reason}`);
    this.name = 'ChartCandlesUnavailableError';
  }
}
function remember(key: string, timeframe: string, candles: PlannerCandle[]) {
  const prior = chartCache.get(key);
  if (prior && Date.now() - prior.observedAt <= 600_000 && prior.candles[0]?.provenance.source === candles[0]?.provenance.source) {
    const byTime = new Map(prior.candles.map(c => [c.time, c]));
    for (const candle of candles) byTime.set(candle.time, candle);
    const appended = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (validPerpChartSeries(appended, timeframe)) candles = appended;
  }
  chartCache.delete(key);
  chartCache.set(key, { candles: candles.slice(-MAX_BARS), observedAt: Date.now() });
  let count = [...chartCache.values()].reduce((sum, entry) => sum + entry.candles.length, 0);
  while (chartCache.size > MAX_SERIES || count > MAX_TOTAL_BARS) {
    const oldest = chartCache.keys().next().value!;
    count -= chartCache.get(oldest)!.candles.length;
    chartCache.delete(oldest);
  }
}

/** Cache and append only within one venue identity; switch by replacing the window. */
export async function fetchChartCandles(symbol: string, timeframe: string, startValue: number | string,
  endValue: number | string, _onProgress?: unknown,
  options?: { bypassCache?: boolean; cacheWritePolicy?: 'skip' | 'background'; deadlineMs?: number; signal?: AbortSignal }): Promise<PlannerCandle[]> {
  const start = typeof startValue === 'number' ? startValue : Date.parse(startValue);
  const end = typeof endValue === 'number' ? endValue : Date.parse(endValue);
  const duration = PERP_CHART_INTERVAL_MS[timeframe];
  if (!duration || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return [];
  const signal = AbortSignal.any([options?.signal ?? new AbortController().signal, AbortSignal.timeout(options?.deadlineMs ?? 60_000)]);
  signal.throwIfAborted();
  const key = `${symbol}:${timeframe}`, now = Date.now();
  let entry = options?.bypassCache ? undefined : chartCache.get(key);
  let cacheDegraded = false;
  if (entry && now - entry.observedAt > 600_000) { chartCache.delete(key); entry = undefined; }
  if (!entry && !options?.bypassCache) {
    let cached;
    try {
      cached = await getCachedCandles(symbol, timeframe, start, end, {
        basisPolicy: CHART_CANDLE_POLICY, callerClass: 'grid-bot', queryTimeoutMs: 5_000,
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
    } catch {
      signal.throwIfAborted();
      cacheDegraded = true;
      console.warn('[TradeChartCandles] cache read degraded; using display candle pool');
    }
    signal.throwIfAborted();
    if (cached && validPerpChartSeries(cached, timeframe)) entry = { candles: cached, observedAt: 0 };
  }
  const cached = entry?.candles.filter(c => c.time >= start && c.time < end) ?? [];
  const coversStart = cached.length > 0 && cached[0].time <= start + duration;
  const coversEnd = cached.length > 0 && cached.at(-1)!.time + duration >= end - duration;
  const live = end > now - 2 * duration;
  if (entry && coversStart && coversEnd && validPerpChartSeries(cached, timeframe)
    && (!live || now - entry.observedAt < 10_000)) return cached;

  let candles: PlannerCandle[] = [];
  if (entry && coversStart && validPerpChartSeries(cached, timeframe)) {
    const source = cached[0].provenance.source as PerpChartSource;
    const tail = await chartPoolCandles(symbol, timeframe, cached.at(-1)!.time, end, signal, source);
    if (tail.length) {
      const byTime = new Map(cached.map(c => [c.time, c]));
      for (const candle of tail) byTime.set(candle.time, candle);
      const appended = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (validPerpChartSeries(appended, timeframe)) candles = appended;
    }
  }
  // A failed same-source tail must restart the full window through the pool.
  if (!candles.length) {
    try {
      candles = await chartPoolCandles(symbol, timeframe, start, end, signal);
    } catch {
      signal.throwIfAborted();
      throw new ChartCandlesUnavailableError(cacheDegraded ? 'cache_read_failed_pool_unavailable' : 'candle_pool_unavailable');
    }
  }
  signal.throwIfAborted();
  if (!candles.length && cacheDegraded) throw new ChartCandlesUnavailableError('cache_read_failed_pool_empty');
  if (candles.length) {
    remember(key, timeframe, candles);
    if (!cacheDegraded && options?.cacheWritePolicy !== 'skip' && candles[0].provenance.source === 'okx') {
      void saveCandlesToDb(symbol, timeframe, candles as ProvenancedOHLCV[])
        .catch(error => console.warn('[TradeChartCandles] cache write failed', error));
    }
  }
  return candles;
}

export function __testResetChartCache() { chartCache.clear(); }
