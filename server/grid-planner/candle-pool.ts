import { readPlannerPerpSource } from '../lab/datafeed';
import { pacificaPlannerCandles } from './pacifica-candles';
import { validateCandles } from './chart';
import type { PlannerCandle } from './types';

/** Every entry reads native perpetual trades; no spot, index or relabelled proxy history. */
export const PLANNER_CANDLE_SOURCES = ['okx', 'gate', 'hyperliquid', 'pacifica'] as const;

export async function plannerPoolCandles(market: string, timeframe: string, bars: number,
  signal: AbortSignal): Promise<PlannerCandle[]> {
  signal.throwIfAborted();
  const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : timeframe === '4h' ? 14_400_000 : 0;
  const symbol = market.replace(/-PERP$/, '');
  if (!duration || ![100, 200].includes(bars) || !/^[A-Z0-9]+$/.test(symbol)) return [];
  const now = Date.now(), end = Math.floor(now / duration) * duration;
  let partial: PlannerCandle[] = [];
  for (const source of PLANNER_CANDLE_SOURCES) {
    signal.throwIfAborted();
    try {
      const entrySignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
      const raw = source === 'pacifica'
        ? await pacificaPlannerCandles(symbol, timeframe, bars, end, entrySignal)
        : await readPlannerPerpSource(source, symbol, timeframe, end - bars * duration, end, entrySignal);
      signal.throwIfAborted();
      const candles = raw.filter(c => c.provenance.finality === 'finalized' && c.time < end).slice(-bars);
      const valid = validateCandles(candles, now) && candles.every((c, i) => c.provenance.source === source
        && c.time % duration === 0 && c.time + duration <= now && Number.isFinite(c.volume) && c.volume >= 0
        && (!i || c.time === candles[i - 1].time + duration)) && candles.at(-1)!.time + duration === end;
      if (valid && candles.length >= 28) return candles;
      if (valid && candles.length > partial.length) partial = candles;
      console.info(`[GridPlannerCandles] source=${source} market=${market} reason=${valid ? 'partial' : 'validation'} bars=${candles.length}`);
    } catch (error) {
      signal.throwIfAborted();
      console.info(`[GridPlannerCandles] source=${source} market=${market} reason=transport detail=${error instanceof Error ? error.message : 'unavailable'}`);
    }
  }
  return partial;
}
