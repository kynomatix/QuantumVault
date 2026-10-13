import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';
import { validateCandles } from './chart';
import type { PlannerCandle } from './types';

// Venue trade candles, not mark/index candles: https://docs.pacifica.fi/api-documentation/api/rest-api/markets/get-candle-data
export async function pacificaPlannerCandles(symbol: string, timeframe: string, bars: number,
  end: number, signal: AbortSignal): Promise<PlannerCandle[]> {
  signal.throwIfAborted();
  const durations: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
  const duration = durations[timeframe];
  if (!duration || ![100, 200].includes(bars) || !/^[A-Z0-9]+$/.test(symbol)) return [];
  // Optional chart work preserves the adapter's critical-request headroom. No quota waiting/retries.
  const refuse = (reason: string) => { console.info(`[GridPlannerCandles] source=pacifica market=${symbol}-PERP reason=${reason}`); return []; };
  if (!pacificaQuota.tryClaimImmediate('/kline', 'background')) return refuse('quota');
  const start = Math.floor(end / duration) * duration - bars * duration;
  const query = new URLSearchParams({ symbol, interval: timeframe, start_time: String(start), end_time: String(end - 1), limit: String(bars) });
  const response = await fetch(`https://api.pacifica.fi/api/v1/kline?${query}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) return refuse(`http status=${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { return refuse('validation'); }
  if (payload?.success !== true || !Array.isArray(payload.data) || !payload.data.length || payload.data.length > bars) return refuse('validation');
  const candles: PlannerCandle[] = [];
  for (const row of payload.data) {
    if (!row || row.s !== symbol || row.i !== timeframe || !Number.isSafeInteger(row.t) || row.t < start || row.t > end
      || row.t % duration !== 0 || !Number.isSafeInteger(row.T) || ![row.t + duration, row.t + duration - 1].includes(row.T)
      || !['o', 'h', 'l', 'c', 'v'].every(key => typeof row[key] === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(row[key]))) return refuse('validation');
    const volume = Number(row.v);
    if (!Number.isFinite(volume) || volume < 0) return refuse('validation');
    candles.push({ time: row.t, open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume,
      provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time',
        finality: row.t + duration <= end ? 'finalized' : 'forming' } });
  }
  candles.sort((a, b) => a.time - b.time);
  return validateCandles(candles, end) ? candles : refuse('validation');
}
