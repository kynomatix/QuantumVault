/** Offline research only. Importing this module does not authorize any live action. */
import Decimal from 'decimal.js';
import { qualifyGridDow } from './move-policy';
import type { GridPolicy } from './policy-hmac';
import type { PlannerCandle } from '../grid-planner/types';

export const GRID_TRAIL_POLICY = Object.freeze({
  version: 'trail-research-1', indicatorBars: 100, indicatorPeriod: 14,
  exhaustionAdx: 40, decliningBars: 2, maximumEdgeAtr: 2,
  cooldownMs: 60 * 60_000, rollingWindowMs: 24 * 60 * 60_000,
  rollingMoves: 3, lifetimeMoves: 10, originalWidths: 1, maximumEdgeIntervals: 2,
  latencyMs: 1,
});
export type TrailVariant = 'a' | 'b' | 'c' | 'd' | 'e';
export interface TrailMove {
  decisionAt: number; activatedAt: number; lower: string; upper: string;
  actor: 'manual' | 'automatic';
}
/** An immutable input ledger: serialize it with the bot, never with a UI mode. */
export interface TrailHistory {
  direction: 'long' | 'short'; originalLower: string; originalUpper: string;
  createdAt: number; lastDecisionAt: number; moves: TrailMove[];
}
export const trailHistory = (p: GridPolicy, createdAt: number): TrailHistory => ({
  direction: p.direction, originalLower: p.lowerPrice, originalUpper: p.upperPrice,
  createdAt, lastDecisionAt: createdAt - 1, moves: [],
});
export type TrailDecision = { eligible: false; reason: string } |
  { eligible: true; decisionAt: number; close: string; confirmedAt: number | null };

/** Shared by all research arms; never repairs, interpolates or relabels provenance. */
export function trailDataHold(bars: PlannerCandle[], timeframe: string, now: number): string | null {
  const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : timeframe === '4h' ? 14_400_000 : 0;
  if (!duration || !Number.isSafeInteger(now)) return 'clock_or_timeframe';
  if (!bars.length) return 'warmup';
  if (bars.some(c => c.provenance?.source !== 'pacifica' || c.provenance.venue !== 'pacifica'
    || c.provenance.basis !== 'perp' || c.provenance.proxy !== 'direct' || c.provenance.timeSemantic !== 'open_time')) return 'source';
  if (bars.some(c => c.provenance.finality !== 'finalized' || c.time + duration > now)) return 'forming';
  if (bars.some(c => !Number.isSafeInteger(c.time) || c.time <= 0 || c.time % duration !== 0
    || ![c.open,c.high,c.low,c.close].every(v => Number.isFinite(v) && v > 0)
    || !Number.isFinite(c.volume) || c.volume < 0 || c.low > Math.min(c.open,c.close)
    || c.high < Math.max(c.open,c.close))) return 'invalid_bar';
  if (bars.some((c,i) => i > 0 && c.time !== bars[i-1].time + duration)) return 'gap';
  if (bars.at(-1)!.time + duration !== Math.floor(now / duration) * duration) return 'stale';
  if (bars.length < GRID_TRAIL_POLICY.indicatorBars || bars.length > 200) return 'warmup';
  return null;
}

export function trailCapHold(p: GridPolicy, h: TrailHistory, now: number,
  proposed?: { lowerPrice: string; upperPrice: string }): string | null {
  try {
    const originalWidth = new Decimal(h.originalUpper).minus(h.originalLower), long = h.direction === 'long';
    if (!originalWidth.gt(0) || p.direction !== h.direction || !Number.isSafeInteger(h.createdAt)
      || !Number.isSafeInteger(h.lastDecisionAt) || now < h.createdAt || h.lastDecisionAt > now) return 'history';
    let lower = new Decimal(h.originalLower), upper = new Decimal(h.originalUpper), previous = h.createdAt - 1;
    for (const move of h.moves) {
      const nextLower = new Decimal(move.lower), nextUpper = new Decimal(move.upper);
      if (!Number.isSafeInteger(move.activatedAt) || !Number.isSafeInteger(move.decisionAt)
        || move.decisionAt < h.createdAt || move.activatedAt < move.decisionAt + GRID_TRAIL_POLICY.latencyMs
        || move.activatedAt <= previous || move.activatedAt > now || !['manual','automatic'].includes(move.actor)
        || !nextUpper.minus(nextLower).eq(originalWidth)
        || !(long ? nextLower.gt(lower) : nextLower.lt(lower))) return 'history';
      lower = nextLower; upper = nextUpper; previous = move.activatedAt;
    }
    if (!lower.eq(p.lowerPrice) || !upper.eq(p.upperPrice)) return 'history';
    if (h.moves.length >= GRID_TRAIL_POLICY.lifetimeMoves) return 'lifetime_cap';
    if (h.moves.filter(m => now - m.activatedAt < GRID_TRAIL_POLICY.rollingWindowMs).length >= GRID_TRAIL_POLICY.rollingMoves) return 'rolling_cap';
    if (h.moves.length && now - previous < GRID_TRAIL_POLICY.cooldownMs) return 'cooldown';
    const limit = originalWidth.mul(GRID_TRAIL_POLICY.originalWidths);
    if (proposed) {
      const nextLower = new Decimal(proposed.lowerPrice), nextUpper = new Decimal(proposed.upperPrice);
      const shift = nextLower.minus(lower), edge = long ? upper.minus(p.levels.at(-2)!.price) : new Decimal(p.levels[1].price).minus(lower);
      if (!nextUpper.minus(nextLower).eq(originalWidth) || !(long ? shift.gt(0) : shift.lt(0))) return 'direction';
      if (!edge.gt(0) || shift.abs().gt(edge.mul(GRID_TRAIL_POLICY.maximumEdgeIntervals))) return 'move_size';
      if (nextLower.minus(h.originalLower).abs().gt(limit) || nextUpper.minus(h.originalUpper).abs().gt(limit)) return 'distance_cap';
    } else if (lower.minus(h.originalLower).abs().gte(limit)) return 'distance_cap';
    return null;
  } catch { return 'history'; }
}

export function qualifyAutomaticTrail(input: {
  policy: GridPolicy; history: TrailHistory; candles: PlannerCandle[];
  timeframe: string; now: number; variant?: TrailVariant;
}): TrailDecision {
  const {policy: p, history: h, candles: bars, now} = input, variant = input.variant ?? 'd';
  const hold = (reason: string): TrailDecision => ({eligible: false, reason});
  const data = trailDataHold(bars,input.timeframe,now);
  if (data) return hold(data);
  if (variant === 'a') return hold('fixed_range');
  if (now <= h.lastDecisionAt) return hold('duplicate');
  const cap = trailCapHold(p,h,now); if (cap) return hold(cap);
  const close = bars.at(-1)!.close, long = p.direction === 'long';
  if (!(long ? close > Number(p.upperPrice) : close < Number(p.lowerPrice))) return hold('inside_or_adverse');
  if (variant === 'c') return {eligible: true, decisionAt: now, close: String(close), confirmedAt: null};
  try {
    const dow = qualifyGridDow({policy:p, candles:bars, timeframe:input.timeframe, now,
      after:h.moves.at(-1)?.activatedAt ?? h.createdAt});
    if (variant !== 'b') {
      const q = dow.information;
      if (q.state !== 'available') return hold('indicators');
      if (!(long ? q.plusDi > q.minusDi : q.minusDi > q.plusDi)) return hold('directional_di');
      if (variant !== 'e' && q.adx > GRID_TRAIL_POLICY.exhaustionAdx && q.adxDeclining) return hold('exhaustion');
      if (q.edgeAtr > GRID_TRAIL_POLICY.maximumEdgeAtr) return hold('overextension');
    }
    return {eligible:true,decisionAt:dow.closedAt,close:dow.close,confirmedAt:dow.confirmedAt};
  } catch { return hold('dow_unconfirmed'); }
}
