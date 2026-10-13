import { adx } from '../lab/indicators';
import { gridAdxLabel } from '../grid-bot/runtime-policy';
import { gridTimeframeMs } from '../grid-bot/range';
import type { ProvenancedOHLCV } from '../lab/datafeed';
import type { GridRegime } from '../../shared/grid-regime';

/** Advisory only: finalized direct perpetual observations, independent of range detection. */
export function plannerRegime(market: string, timeframe: string, candles: ProvenancedOHLCV[], now: number): GridRegime {
  const unknown = (reason: string): GridRegime => ({ state: 'unavailable', reason });
  const duration = gridTimeframeMs(timeframe), first = candles[0]?.provenance;
  if (!duration || !Number.isSafeInteger(now) || candles.length < 28 || candles.length > 200)
    return unknown('At least 28 finalized candles are needed');
  if (!first || !['okx', 'gate', 'hyperliquid'].includes(first.source) || first.source !== first.venue)
    return unknown('Direct perpetual provenance unavailable');
  if (!candles.every((c, i) => Number.isSafeInteger(c.time) && c.time > 0 && c.time % duration === 0 && c.time + duration <= now
    && (i === 0 || c.time === candles[i - 1].time + duration)
    && [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0)
    && Number.isFinite(c.volume) && c.volume >= 0 && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)
    && c.provenance?.source === first.source && c.provenance.venue === first.venue && c.provenance.basis === 'perp'
    && c.provenance.proxy === 'direct' && c.provenance.finality === 'finalized' && c.provenance.timeSemantic === 'open_time'))
    return unknown('Invalid, forming, gapped or mixed-basis history');
  const latest = candles.at(-1)!;
  if (now - (latest.time + duration) >= duration) return unknown('Finalized history is stale');
  const value = adx(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close), 14).at(-1) ?? null;
  const label = gridAdxLabel(value);
  if (value === null || label === 'UNKNOWN') return unknown('ADX unavailable');
  return { state: 'available', market, timeframe, adx: value, label,
    venue: first.venue as 'okx' | 'gate' | 'hyperliquid', bars: candles.length, latestFinalizedTime: latest.time };
}
