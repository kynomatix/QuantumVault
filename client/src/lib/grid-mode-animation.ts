import { gridCyclePair, gridOneShotOwners, type GridBehaviourMode } from '../../../shared/grid-behaviour';
import { GRID_SETUP_INITIAL } from './grid-setup-view';

// Only presentation geometry/timing lives here. Ownership and pairing come from the product.
export const GRID_ANIMATION_TIMING = { intro: 900, run: 5600, hold: 1600, tagFade: 200, tagLife: 260 };
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
    return [{ ownerOrdinal, ...pair, opening, recycles, enabled,
      closeAt: !opening && seed ? cross(direction * (prices[pair.closingOrdinal] - reference), false) : Infinity,
      openAt: enabled && recycles ? cross(direction * (prices[pair.openingOrdinal] - reference), true) : Infinity }];
  });
  const fills = owners.flatMap(owner => [
    { at: owner.closeAt, ordinal: owner.closingOrdinal, ownerOrdinal: owner.ownerOrdinal, leg: 'closing' as const, label: long ? 'SELL' : 'BUY' },
    { at: owner.openAt, ordinal: owner.openingOrdinal, ownerOrdinal: owner.ownerOrdinal, leg: 'opening' as const, label: long ? 'BUY' : 'SELL' },
  ]).filter(fill => Number.isFinite(fill.at)).sort((a, b) => a.at - b.at);
  return { prices, reference, side, seed, mode, once, owners, fills, peak, price };
}
export type GridAnimationModel = ReturnType<typeof gridAnimationModel>;

export function gridAnimationFrame(model: GridAnimationModel, elapsed: number) {
  const progress = Math.max(0, Math.min(1, (elapsed - GRID_ANIMATION_TIMING.intro) / GRID_ANIMATION_TIMING.run));
  const price = model.price(progress);
  const states: AnimationLineState[] = model.prices.map(() => 'active');
  const pending: { ordinal: number; leg: 'opening' | 'closing'; ownerOrdinal: number }[] = [];
  for (const owner of model.owners) {
    const opened = progress >= owner.openAt, closed = progress >= owner.closeAt;
    states[owner.ownerOrdinal] = !owner.enabled ? 'unused' : closed && !owner.recycles ? 'dark'
      : !owner.opening && !opened && (closed || !model.seed) ? 'waiting' : 'active';
    if (!owner.enabled || closed && !owner.recycles) continue;
    const leg = opened || !owner.opening && model.seed && !closed ? 'closing' : 'opening';
    const ordinal = leg === 'closing' ? owner.closingOrdinal : owner.openingOrdinal;
    // A resting buy is below the dot; a resting sell is above it. Seed-off profit
    // owners become eligible on the return, never sell an invented starting position.
    const sell = (leg === 'closing') === (model.side === 'long');
    if (sell ? model.prices[ordinal] > price : model.prices[ordinal] < price) pending.push({ ordinal, leg, ownerOrdinal: owner.ownerOrdinal });
  }
  const tags = model.fills.flatMap(fill => {
    const age = elapsed - GRID_ANIMATION_TIMING.intro - fill.at * GRID_ANIMATION_TIMING.run;
    return age >= 0 && age < GRID_ANIMATION_TIMING.tagLife ? [{ ...fill,
      opacity: Math.min(1, (age + 16) / GRID_ANIMATION_TIMING.tagFade) * Math.min(1, (GRID_ANIMATION_TIMING.tagLife - age) / 60) }] : [];
  });
  return { progress, price, states, pending, tags };
}
