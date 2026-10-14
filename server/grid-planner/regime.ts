import { adx, atr, rma } from '../lab/indicators';
import { gridAdxLabel } from '../grid-bot/runtime-policy';
import { gridTimeframeMs } from '../grid-bot/range';
import type { PlannerCandle } from './types';
import type { GridRegime } from '../../shared/grid-regime';

/** Advisory only: finalized direct perpetual observations, independent of range detection. */
export function plannerRegime(market: string, timeframe: string, candles: PlannerCandle[], now: number): GridRegime {
  const unknown = (reason: string): GridRegime => ({ state: 'unavailable', reason });
  const duration = gridTimeframeMs(timeframe), first = candles[0]?.provenance;
  if (!duration) return unknown('ADX timeframe is unsupported');
  if (!Number.isSafeInteger(now)) return unknown('ADX clock is invalid');
  if (candles.length < 28) return unknown('ADX needs 28 bars');
  if (candles.length > 200) return unknown('ADX history exceeds 200 bars');
  if (!first || !['okx', 'gate', 'hyperliquid', 'pacifica'].includes(first.source) || first.source !== first.venue)
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
  // Wilder directional movement, using the same smoothing and ATR as the existing ADX.
  const plus = [0], minus = [0];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high, down = candles[i - 1].low - candles[i].low;
    plus.push(up > down && up > 0 ? up : 0); minus.push(down > up && down > 0 ? down : 0);
  }
  const volatility = atr(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close), 14).at(-1)!;
  const plusDi = volatility === 0 ? 0 : rma(plus, 14).at(-1)! / volatility * 100;
  const minusDi = volatility === 0 ? 0 : rma(minus, 14).at(-1)! / volatility * 100;
  if (![plusDi, minusDi].every(Number.isFinite)) return unknown('Directional movement unavailable');
  return { state: 'available', market, timeframe, adx: value, label,
    venue: first.venue as 'okx' | 'gate' | 'hyperliquid' | 'pacifica', bars: candles.length, latestFinalizedTime: latest.time, plusDi, minusDi };
}
