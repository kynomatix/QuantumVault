import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';
import { validateCandles } from './chart';
import type { PlannerCandle } from './types';
import { GRID_HISTORY_MAX_BARS } from '../../shared/grid-lookback';

// Venue trade candles, not mark/index candles: https://docs.pacifica.fi/api-documentation/api/rest-api/markets/get-candle-data
export async function pacificaPlannerCandles(symbol: string, timeframe: string, bars: number,
  end: number, signal: AbortSignal): Promise<PlannerCandle[]> {
  if (!['15m', '1h', '4h'].includes(timeframe) || !Number.isSafeInteger(bars) || bars < 1 || bars > GRID_HISTORY_MAX_BARS) return [];
  const duration = PERP_CHART_INTERVAL_MS[timeframe];
  return pacificaPerpWindow(symbol, timeframe, Math.floor(end / duration) * duration - bars * duration, end, signal, end, bars);
}

export const PERP_CHART_INTERVAL_MS: Readonly<Record<string, number>> = {
  '15m': 900_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '12h': 43_200_000, '1d': 86_400_000,
};

/** The same verified native trade-candle parser serves Planner and trade charts. */
export async function pacificaPerpWindow(symbol: string, timeframe: string, start: number,
  end: number, signal: AbortSignal, now = Date.now(), maxPageBars = 4_000): Promise<PlannerCandle[]> {
  signal.throwIfAborted();
  const duration = PERP_CHART_INTERVAL_MS[timeframe];
  if (!duration || !/^[A-Za-z0-9-]+$/.test(symbol) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return [];
  if (!Number.isSafeInteger(maxPageBars) || maxPageBars < 1) return [];
  const bars = Math.min(4_000, maxPageBars, Math.ceil((end - start) / duration));
  // Optional chart work preserves the adapter's critical-request headroom. No quota waiting/retries.
  const refuse = (reason: string) => { console.info(`[GridPlannerCandles] source=pacifica market=${symbol}-PERP reason=${reason}`); return []; };
  const candles: PlannerCandle[] = [];
  for (let cursor = start; cursor < end;) {
    signal.throwIfAborted();
    if (!pacificaQuota.tryClaimImmediate('/kline', 'background')) return refuse('quota');
    const pageEnd = Math.min(end, cursor + bars * duration);
    const query = new URLSearchParams({ symbol, interval: timeframe, start_time: String(cursor), end_time: String(pageEnd - 1), limit: String(bars) });
    const response = await fetch(`https://api.pacifica.fi/api/v1/kline?${query}`, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return refuse(`http status=${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { return refuse('validation'); }
    if (payload?.success !== true || !Array.isArray(payload.data) || !payload.data.length || payload.data.length > bars) return refuse('validation');
    for (const row of payload.data) {
      if (!row || row.s !== symbol || row.i !== timeframe || !Number.isSafeInteger(row.t) || row.t < cursor || row.t >= pageEnd
        || row.t % duration !== 0 || !Number.isSafeInteger(row.T) || ![row.t + duration, row.t + duration - 1].includes(row.T)
        || !['o', 'h', 'l', 'c', 'v'].every(key => typeof row[key] === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(row[key]))) return refuse('validation');
      const volume = Number(row.v);
      if (!Number.isFinite(volume) || volume < 0) return refuse('validation');
      candles.push({ time: row.t, open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume,
        provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time',
          finality: row.t + duration <= now ? 'finalized' : 'forming' } });
    }
    cursor = pageEnd;
  }
  candles.sort((a, b) => a.time - b.time);
  return validateCandles(candles, now) ? candles : refuse('validation');
}
