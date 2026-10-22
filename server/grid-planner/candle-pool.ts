import { readPlannerPerpSource, readChartPerpSource } from '../lab/datafeed';
import { pacificaPlannerCandles, pacificaPerpWindow, PERP_CHART_INTERVAL_MS } from './pacifica-candles';
import { validateCandles } from './chart';
import type { PlannerCandle } from './types';
import { GRID_HISTORY_MAX_BARS } from '../../shared/grid-lookback';

/** Every entry reads native perpetual trades; no spot, index or relabelled proxy history. */
export const PLANNER_CANDLE_SOURCES = ['okx', 'gate', 'hyperliquid', 'pacifica'] as const;
export type PerpChartSource = typeof PLANNER_CANDLE_SOURCES[number];

export function validPerpChartSeries(candles: readonly PlannerCandle[], timeframe: string, now = Date.now()): boolean {
  const duration = PERP_CHART_INTERVAL_MS[timeframe];
  return !!duration && validateCandles([...candles], now) && candles.every((c, i) =>
    Number.isFinite(c.volume) && c.volume >= 0 && (!i || c.time === candles[i - 1].time + duration));
}

/** Shared ordered pool, with native chart intervals and forming candles admitted. */
export async function chartPoolCandles(symbol: string, timeframe: string, start: number, end: number,
  signal: AbortSignal, onlySource?: PerpChartSource): Promise<PlannerCandle[]> {
  symbol = symbol.replace(/\/USDT$/, '');
  const duration = PERP_CHART_INTERVAL_MS[timeframe];
  if (!duration || !/^[A-Za-z0-9-]+$/.test(symbol) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return [];
  for (const source of PLANNER_CANDLE_SOURCES) {
    signal.throwIfAborted();
    if (onlySource && source !== onlySource) continue;
    // Gate futures has no native 2h/12h interval. Never substitute another interval or spot.
    if (source === 'gate' && ['2h', '12h'].includes(timeframe)) continue;
    if (source === 'hyperliquid' && Math.floor((end - start) / duration) + 1 > 5_000) continue;
    try {
      const entrySignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const raw = source === 'pacifica'
        ? await pacificaPerpWindow(symbol, timeframe, start, end, entrySignal)
        : await readChartPerpSource(source, symbol, timeframe, start, end, entrySignal);
      signal.throwIfAborted();
      const candles = raw.filter(c => c.time >= start && c.time < end);
      if (validPerpChartSeries(candles, timeframe) && candles.every(c => c.provenance.source === source)
        && candles.at(-1)!.time + duration >= end - duration) return candles;
      console.info(`[TradeChartCandles] source=${source} market=${symbol} reason=validation bars=${candles.length}`);
    } catch (error) {
      signal.throwIfAborted();
      console.info(`[TradeChartCandles] source=${source} market=${symbol} reason=${error instanceof Error ? error.name : 'unavailable'}`);
    }
  }
  return [];
}

export async function plannerPoolCandles(market: string, timeframe: string, bars: number,
  signal: AbortSignal): Promise<PlannerCandle[]> {
  signal.throwIfAborted();
  const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : timeframe === '4h' ? 14_400_000 : timeframe === '1d' ? 86_400_000 : 0;
  const symbol = market.replace(/-PERP$/, '');
  if (!duration || !Number.isSafeInteger(bars) || bars < 1 || bars > GRID_HISTORY_MAX_BARS || !/^[A-Za-z0-9-]+$/.test(symbol)) return [];
  const now = Date.now(), end = Math.floor(now / duration) * duration;
  let partial: PlannerCandle[] = [];
  for (const source of PLANNER_CANDLE_SOURCES) {
    signal.throwIfAborted();
    try {
      const entrySignal = AbortSignal.any([signal, AbortSignal.timeout(bars > 200 ? 6_000 : 3_000)]);
      const raw = source === 'pacifica'
        ? await pacificaPlannerCandles(symbol, timeframe, bars, end, entrySignal)
        : await readPlannerPerpSource(source, symbol, timeframe, end - bars * duration, end, entrySignal);
      signal.throwIfAborted();
      const candles = raw.filter(c => c.provenance.finality === 'finalized' && c.time >= end - bars * duration && c.time < end).slice(-bars);
      const valid = validateCandles(candles, now) && candles.every((c, i) => c.provenance.source === source
        && c.time % duration === 0 && c.time + duration <= now && Number.isFinite(c.volume) && c.volume >= 0
        && (!i || c.time === candles[i - 1].time + duration)) && candles.at(-1)!.time + duration === end;
      if (valid && candles.length === bars) return candles;
      if (valid && candles.length > partial.length) partial = candles;
      console.info(`[GridPlannerCandles] source=${source} market=${market} reason=${valid ? 'partial' : 'validation'} bars=${candles.length}`);
    } catch (error) {
      signal.throwIfAborted();
      const timeout = error !== null && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError';
      const detail = error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'unavailable';
      console.info(`[GridPlannerCandles] source=${source} market=${market} reason=${timeout ? 'timeout' : 'transport'} detail=${detail}`);
    }
  }
  return partial;
}
