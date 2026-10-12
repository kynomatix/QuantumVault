import Decimal from 'decimal.js';
import { detectActiveRange, deriveStructuralSafeZones } from '../ai-trader/active-range';
import { atr, adx } from '../lab/indicators';
import type { ProvenancedOHLCV } from '../lab/datafeed';
import { GRID_RUNTIME_POLICY, gridAdxLabel } from './runtime-policy';

export const GRID_RANGE_POLICY = Object.freeze({ finalizedOnly:true as const, intrabarAtr:3, driftAtr:6, maximumBars:400 });
export const gridTimeframeMs = (tf: string) => tf==='15m'?900_000:tf==='1h'?3_600_000:tf==='4h'?14_400_000:null;
export function suggestGridRange(market: string, timeframe: '15m'|'1h'|'4h', lookback: 100|200, candles: ProvenancedOHLCV[], now: number) {
  const deny = (reason: string) => ({ state:'unavailable' as const, reason, manualAvailable:true, policyVersion:GRID_RUNTIME_POLICY.version });
  const duration = gridTimeframeMs(timeframe);
  if (!duration || ![100,200].includes(lookback) || candles.length !== lookback || !Number.isSafeInteger(now)) return deny('Complete finalized history unavailable');
  const first = candles[0]?.provenance;
  if (!first || !['okx','gate','hyperliquid'].includes(first.source) || first.source !== first.venue) return deny('Direct perpetual provenance unavailable');
  if (!candles.every((c,i) => Number.isSafeInteger(c.time) && c.time > 0 && c.time % duration === 0 && c.time+duration <= now
    && (i===0 || c.time === candles[i-1].time+duration) && [c.open,c.high,c.low,c.close].every(v=>Number.isFinite(v)&&v>0)
    && Number.isFinite(c.volume) && c.volume>=0 && c.low<=Math.min(c.open,c.close) && c.high>=Math.max(c.open,c.close)
    && c.provenance?.source===first.source && c.provenance.venue===first.venue && c.provenance.basis==='perp'
    && c.provenance.proxy==='direct' && c.provenance.finality==='finalized' && c.provenance.timeSemantic==='open_time')) return deny('Invalid, partial, forming or mixed-basis candles');
  const latest = candles.at(-1)!;
  if (now-(latest.time+duration)>=duration) return deny('Finalized history is stale');
  const range = detectActiveRange(candles,latest.close,GRID_RANGE_POLICY);
  const highs=candles.map(c=>c.high), lows=candles.map(c=>c.low), closes=candles.map(c=>c.close);
  const atrValue=atr(highs,lows,closes,14).at(-1) ?? NaN;
  if (!range) return deny('Structural range unavailable');
  const zones=deriveStructuralSafeZones(range.high,range.low,atrValue,Number(GRID_RUNTIME_POLICY.stop.atrBuffers[timeframe]));
  if (zones.state!=='available') return deny(zones.reason);
  const adxValue=adx(highs,lows,closes,14).at(-1) ?? null;
  const value=adxValue!==null && Number.isFinite(adxValue)?adxValue:null;
  const plain=(v:number)=>new Decimal(v).toFixed();
  return { state:'available' as const, manualAvailable:true, policyVersion:GRID_RUNTIME_POLICY.version, market,timeframe,lookback,
    latestFinalizedTime:latest.time, provenance:first, lowerPrice:plain(range.low),upperPrice:plain(range.high),includedBars:range.bars,
    atr:plain(atrValue), buffer:plain(zones.buffer),longStop:plain(zones.longStop),shortStop:plain(zones.shortStop),
    adx:value===null?null:plain(value),adxLabel:gridAdxLabel(value),stopReachability:'unavailable' as const };
}
