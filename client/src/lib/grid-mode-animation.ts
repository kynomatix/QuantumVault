import { gridCyclePair, gridOneShotOwners, type GridBehaviourMode } from '../../../shared/grid-behaviour';
import { GRID_SETUP_INITIAL } from './grid-setup-view';

// Only presentation geometry/timing lives here. Ownership and pairing come from the product.
// v5 modes_anim.py:83,150,233: live for 3% of the run, hold full opacity for
// the first 35% of that lifetime, then fade out. There is no fade-in.
export const GRID_ANIMATION_TIMING = { intro: 900, run: 5600, hold: 1600, morph: 5600 * 3.5 / 100, tagLife: 5600 * 0.03, tagHold: 0.35 };
export const GRID_ANIMATION_DURATION = GRID_ANIMATION_TIMING.intro + GRID_ANIMATION_TIMING.run + GRID_ANIMATION_TIMING.hold;
export const GRID_ANIMATION_LINES = Array.from({ length: Number(GRID_SETUP_INITIAL.intervals) + 1 },
  (_, i) => 90 + 20 * i / Number(GRID_SETUP_INITIAL.intervals));
export interface GridModeAnimationOptions {
  /** Ascending prices, with zero-based ordinals (as in a planner result). */
  lines?: readonly number[];
  start?: number;
  side?: 'long' | 'short';
  seed?: boolean;
  mode?: GridBehaviourMode;
}
export type AnimationLineState = 'active' | 'waiting' | 'dark' | 'unused';
export const gridAnimationEase = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

// The scene owns the numeric palette. This weight mixes the active colour with the muted
// state, and drives brightness, width and bloom from the very same event clock.
function lineLook(muted: Exclude<AnimationLineState, 'active'>, active: number) {
  const glow = muted === 'waiting' ? .15 : 0;
  const opacity = muted === 'waiting' ? .4 : .5;
  return { muted, active, glow: glow + (1 - glow) * active,
    opacity: opacity + (1 - opacity) * active, width: 1.5 + 1.5 * active };
}

export function gridAnimationModel({ lines = GRID_ANIMATION_LINES, start, side = GRID_SETUP_INITIAL.side as 'long' | 'short',
  seed = GRID_SETUP_INITIAL.seed, mode = GRID_SETUP_INITIAL.behaviourMode }: GridModeAnimationOptions = {}) {
  const prices = lines.length >= 3 && lines.every((p, i) => Number.isFinite(p) && (!i || p > lines[i - 1]))
    ? [...lines] : [...GRID_ANIMATION_LINES];
  const low = prices[0], high = prices[prices.length - 1];
  const reference = start !== undefined && start > low && start < high ? start : (low + high) / 2;
  const long = side === 'long', direction = long ? 1 : -1;
  const profit = prices.flatMap((p, i) => direction * (p - reference) > 0 ? [i] : []);
  const once = new Set(gridOneShotOwners(mode, profit, prices.length - 1, long));
  const gap = Math.min(...prices.slice(1).map((p, i) => p - prices[i]));
  const amplitude = (long ? high - reference : reference - low) * 1.06;
  const drift = Math.min(gap * 0.4, amplitude * 0.08);
  const peak = Math.acos(drift / (Math.PI * amplitude)) / Math.PI;
  const price = (progress: number) => reference + direction * (amplitude * Math.sin(Math.PI * progress) - drift * progress);
  const cross = (level: number, returning: boolean) => {
    let a = returning ? peak : 0, b = returning ? 1 : peak;
    if (level > direction * (price(peak) - reference) || level < direction * (price(returning ? 1 : 0) - reference)) return Infinity;
    for (let i = 0; i < 48; i++) {
      const mid = (a + b) / 2;
      if ((direction * (price(mid) - reference) < level) !== returning) a = mid; else b = mid;
    }
    return (a + b) / 2;
  };
  const owners = prices.flatMap((p, ownerOrdinal) => {
    if (p === reference) return [];
    const opening = direction * (p - reference) < 0;
    const pair = gridCyclePair(ownerOrdinal, opening, long);
    const recycles = !once.has(ownerOrdinal), enabled = recycles || seed;
    const closeAt = !opening && seed ? cross(direction * (prices[pair.closingOrdinal] - reference), false) : Infinity;
    const openAt = enabled && recycles ? cross(direction * (prices[pair.openingOrdinal] - reference), true) : Infinity;
    return [{ ownerOrdinal, ...pair, opening, recycles, enabled, closeAt, openAt,
      closeTimeMs: GRID_ANIMATION_TIMING.intro + closeAt * GRID_ANIMATION_TIMING.run,
      openTimeMs: GRID_ANIMATION_TIMING.intro + openAt * GRID_ANIMATION_TIMING.run }];
  });
  const fills = owners.flatMap(owner => [
    { at: owner.closeAt, timeMs: owner.closeTimeMs, ordinal: owner.closingOrdinal, ownerOrdinal: owner.ownerOrdinal, leg: 'closing' as const, label: long ? 'SELL' : 'BUY' },
    { at: owner.openAt, timeMs: owner.openTimeMs, ordinal: owner.openingOrdinal, ownerOrdinal: owner.ownerOrdinal, leg: 'opening' as const, label: long ? 'BUY' : 'SELL' },
  ]).filter(fill => Number.isFinite(fill.at)).sort((a, b) => a.at - b.at);
  return { prices, reference, side, seed, mode, once, owners, fills, peak, price };
}
export type GridAnimationModel = ReturnType<typeof gridAnimationModel>;

/** Spend at least one rendered frame on every fill, discarding overshoot after a hitch. */
export function gridAnimationAdvance(model: GridAnimationModel, elapsed: number, deltaMs: number) {
  const next = Math.min(elapsed + Math.max(0, deltaMs), GRID_ANIMATION_DURATION);
  return model.fills.find(fill => fill.timeMs > elapsed && fill.timeMs <= next)?.timeMs ?? next;
}

export function gridAnimationFrame(model: GridAnimationModel, elapsed: number) {
  // Only snap at the stored crossing time: an epsilon would allow an early reaction.
  const arrival = model.fills.find(fill => fill.timeMs === elapsed);
  const progress = arrival?.at ?? Math.max(0, Math.min(1, (elapsed - GRID_ANIMATION_TIMING.intro) / GRID_ANIMATION_TIMING.run));
  const price = arrival ? model.prices[arrival.ordinal] : model.price(progress);
  const states: AnimationLineState[] = model.prices.map(() => 'active');
  const looks = model.prices.map(() => lineLook('waiting', 1));
  const pending: { ordinal: number; leg: 'opening' | 'closing'; ownerOrdinal: number }[] = [];
  for (const owner of model.owners) {
    // Use the same stored event times as the tags; reconstructing progress can
    // round to the other side of a crossing on its exact fill frame.
    const opened = elapsed >= owner.openTimeMs, closed = elapsed >= owner.closeTimeMs;
    states[owner.ownerOrdinal] = !owner.enabled ? 'unused' : closed && !owner.recycles ? 'dark'
      : !owner.opening && !opened && (closed || !model.seed) ? 'waiting' : 'active';
    if (!owner.enabled) looks[owner.ownerOrdinal] = lineLook('unused', 0);
    else if (!owner.opening) {
      // Clamp the closing fade at the opening event before fading back to active.
      // This also stays continuous when custom grid crossings overlap the morph.
      const closeElapsed = Math.min(elapsed, owner.openTimeMs);
      const afterClose = model.seed ? 1 - gridAnimationEase((closeElapsed - owner.closeTimeMs) / GRID_ANIMATION_TIMING.morph) : 0;
      const opening = gridAnimationEase((elapsed - owner.openTimeMs) / GRID_ANIMATION_TIMING.morph);
      looks[owner.ownerOrdinal] = lineLook(owner.recycles ? 'waiting' : 'dark', afterClose + (1 - afterClose) * opening);
    }
    if (!owner.enabled || closed && !owner.recycles) continue;
    const leg = opened || !owner.opening && model.seed && !closed ? 'closing' : 'opening';
    const ordinal = leg === 'closing' ? owner.closingOrdinal : owner.openingOrdinal;
    // A resting buy is below the dot; a resting sell is above it. Seed-off profit
    // owners become eligible on the return, never sell an invented starting position.
    const sell = (leg === 'closing') === (model.side === 'long');
    if (sell ? model.prices[ordinal] > price : model.prices[ordinal] < price) pending.push({ ordinal, leg, ownerOrdinal: owner.ownerOrdinal });
  }
  const tags = model.fills.flatMap(fill => {
    const age = elapsed - fill.timeMs;
    return elapsed >= fill.timeMs && elapsed < fill.timeMs + GRID_ANIMATION_TIMING.tagLife ? [{ ...fill,
      opacity: 1 - Math.max(0, (age / GRID_ANIMATION_TIMING.tagLife - GRID_ANIMATION_TIMING.tagHold) / (1 - GRID_ANIMATION_TIMING.tagHold)) }] : [];
  });
  const move = model.reference === 0 ? 0 : (price - model.reference) / Math.abs(model.reference) * 100;
  const roundedMove = Math.round(move * 10) / 10;
  const readout = `${roundedMove < 0 ? '\u2212' : '+'}${Math.abs(roundedMove).toFixed(1)}%`;
  return { progress, price, readout, states, looks, pending, tags,
    sceneOpacity: gridAnimationEase(elapsed / GRID_ANIMATION_TIMING.intro) };
}
