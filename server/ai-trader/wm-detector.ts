// server/ai-trader/wm-detector.ts
//
// Brick 3, Phase 3A — W/M (double bottom / top) formation detector.
//
// Strict all-criteria-required definition — if ANY single criterion misses,
// returns null. No partial matches, no "possibly forming" state, ever.
//
// Depends on: Brick 2's detectPivots (never a second swing system).
// Pure module: no I/O, no side-effects. Safe to call inside the decision loop.
//
// ─── Criteria (all must pass simultaneously) ─────────────────────────────────
//
//   1. Two same-side swing extremes separated by MIN_BAR_SEP..MAX_BAR_SEP closed bars.
//   2. Extremes within EXTREME_ATR_MULT × ATR(14) of each other (peak symmetry).
//   3. One intervening opposite pivot (the neckline); pattern height (|neckline −
//      nearer extreme|) must be ≥ RETRACE_MIN_FRAC × ATR(14). This ensures the
//      neckline represents a meaningful retrace, not a micro-noise pivot.
//   4. Actionability: |currentPrice − neckline| / neckline ≤ NECKLINE_WINDOW (1%).
//      A fully-formed pattern from months ago is history, not context.
//   5. Volume fact (reported as context, NOT a gate): second extreme volume ≤ first.
//
// ─── Outside-bar edge ────────────────────────────────────────────────────────
//
//   A bar can simultaneously qualify as BOTH a swing high AND a swing low if
//   its high strictly exceeds all N neighbors' highs AND its low beats them all.
//   detectPivots pushes BOTH to `raw` in HIGH-BEFORE-LOW order; after applyZigZag
//   two consecutive alternating pivots appear at the same `.index`.
//   Rule here: any triplet where two pivots share the same bar index is skipped
//   deterministically. Geometry is undefined in that case (neckline cannot coincide
//   with an extreme; two extremes cannot exist on the same bar).
//   See dow-structure.ts module header "Outside-bar edge" for the full contract.
//
// ─── Current price ───────────────────────────────────────────────────────────
//
//   `bars[bars.length - 1].close` is treated as the live price (the forming bar's
//   close). This mirrors how context-builder.ts passes the OHLCV array and is
//   consistent with how detectPivots strips the same element as the forming bar.

import type { OHLCV } from "../lab/engine";
import { atr } from "../lab/indicators";
import { detectPivots, FRACTAL_N } from "./dow-structure";

// ─── Constants (all tunable in one place) ─────────────────────────────────────

/** Minimum bar separation (extreme2.index − extreme1.index) for a valid pattern. */
export const MIN_BAR_SEP = 10;
/** Maximum bar separation (extreme2.index − extreme1.index) for a valid pattern. */
export const MAX_BAR_SEP = 60;
/** Extremes must be within this multiple of ATR(14) of each other (peak symmetry). */
export const EXTREME_ATR_MULT = 0.25;
/**
 * Pattern height — |neckline.price − min/max extreme| — must be at least this
 * fraction of ATR(14). Excludes micro-pivots where the neckline barely departs
 * from the extremes ("retraced at least 30% of ATR" per spec).
 */
export const RETRACE_MIN_FRAC = 0.30;
/** Current price must be within this fraction of neckline price (actionability window). */
export const NECKLINE_WINDOW = 0.01; // 1%

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WMExtreme {
  /** bar.low (W) or bar.high (M). */
  price: number;
  /** 0-based index into the original bars array. */
  index: number;
  /** Volume of the bar at this extreme — used for the volume comparison fact. */
  volume: number;
}

export interface WMNeckline {
  /** bar.high (W = intervening swing high) or bar.low (M = intervening swing low). */
  price: number;
  /** 0-based index into the original bars array. */
  index: number;
}

/** Return shape when a qualifying W or M is found. null when any criterion misses. */
export interface WMFormation {
  /** "W" = double bottom; "M" = double top. */
  type: "W" | "M";
  /** First (older) swing extreme. */
  extreme1: WMExtreme;
  /** Second (more recent) swing extreme. */
  extreme2: WMExtreme;
  /** extreme2.index − extreme1.index. Must satisfy MIN_BAR_SEP ≤ x ≤ MAX_BAR_SEP. */
  barSeparation: number;
  /** |extreme1.price − extreme2.price| / atr14. */
  deltaAtr: number;
  /** The intervening opposite-side pivot between the two extremes. */
  neckline: WMNeckline;
  /**
   * |neckline.price − min(extreme1,extreme2)| for W.
   * |max(extreme1,extreme2) − neckline.price| for M.
   * Must be ≥ RETRACE_MIN_FRAC × atr14.
   */
  patternHeight: number;
  /**
   * (currentPrice − neckline.price) / neckline.price.
   * Positive = current price is above neckline; negative = below.
   * Passes when Math.abs(distFromNeckline) ≤ NECKLINE_WINDOW.
   */
  currentPriceDistFromNeckline: number;
  /**
   * Volume fact — NOT a gate. true when second extreme bar volume ≤ first extreme's.
   * Classic divergence: waning participation on the second test of the level.
   */
  secondExtremeVolumeLower: boolean;
  /** ATR(14) used for threshold calculations (reported for transparency in prompt rendering). */
  atr14: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect the most recent qualifying W or M pattern in a bar series.
 *
 * @param bars     Full bar array INCLUDING the forming bar as the last element.
 *                 bars[bars.length - 1].close is used as the current (live) price.
 * @param options  Optional overrides for testability or calibration:
 *                   n           — fractal pivot width (default: FRACTAL_N = 3).
 *                                 Lower values (n=1) make fixtures smaller and more predictable.
 *                   retraceFrac — override for RETRACE_MIN_FRAC (default: RETRACE_MIN_FRAC).
 *                                 Used by the fire-rate calibration script; not for production calls.
 * @returns        The most recent qualifying WMFormation, or null if none qualifies.
 */
export function detectWM(
  bars: OHLCV[],
  options?: { n?: number; retraceFrac?: number }
): WMFormation | null {
  if (bars.length < 2) return null;

  const n = options?.n ?? FRACTAL_N;
  const retraceFrac = options?.retraceFrac ?? RETRACE_MIN_FRAC;

  // bars[bars.length - 1] is the forming bar; its close = live price proxy.
  const currentPrice = bars[bars.length - 1].close;

  // Strip the forming bar for indicator computation (mirrors detectPivots contract).
  const closed = bars.slice(0, -1);

  // ── ATR(14) from closed bars ──────────────────────────────────────────────
  // Return null when insufficient data — ATR-based thresholds are meaningless otherwise.
  let atr14 = 0;
  if (closed.length >= 14) {
    const highs  = closed.map((b) => b.high);
    const lows   = closed.map((b) => b.low);
    const closes = closed.map((b) => b.close);
    const series = atr(highs, lows, closes, 14);
    const last   = series[series.length - 1];
    if (Number.isFinite(last) && last > 0) atr14 = last;
  }

  if (atr14 === 0) return null;

  // ── Pivot detection ───────────────────────────────────────────────────────
  // detectPivots strips the forming bar internally and returns ZigZag-alternated pivots.
  const pivots = detectPivots(bars, n);
  if (pivots.length < 3) return null;

  // ── Scan triplets from most-recent to oldest ──────────────────────────────
  // ZigZag pivots alternate: triplet [pivots[i], pivots[i+1], pivots[i+2]] is either
  //   (low, high, low) → W (double bottom), or
  //   (high, low, high) → M (double top).
  // Scanning newest-first ensures we return the most actionable (most recent) pattern.
  for (let i = pivots.length - 3; i >= 0; i--) {
    const p0 = pivots[i];     // extreme1 (older)
    const p1 = pivots[i + 1]; // neckline candidate
    const p2 = pivots[i + 2]; // extreme2 (more recent)

    const isW = p0.type === "low"  && p2.type === "low";
    const isM = p0.type === "high" && p2.type === "high";
    if (!isW && !isM) continue; // well-formed ZigZag only; skip any anomaly

    // Outside-bar edge: skip any triplet where two pivots share the same bar index.
    // Geometry is undefined (neckline coinciding with an extreme, or same-bar extremes).
    // Deterministic rule: skip. See module header and dow-structure.ts for full context.
    if (p0.index === p1.index || p1.index === p2.index || p0.index === p2.index) continue;

    // ── Criterion 1: bar separation ──────────────────────────────────────────
    const barSep = p2.index - p0.index;
    if (barSep < MIN_BAR_SEP || barSep > MAX_BAR_SEP) continue;

    // ── Criterion 2: extreme proximity ──────────────────────────────────────
    const extremeDelta = Math.abs(p0.price - p2.price);
    if (extremeDelta > EXTREME_ATR_MULT * atr14) continue;

    // ── Criterion 3: neckline retrace (pattern height ≥ retraceFrac × ATR) ──────
    // W: neckline is a swing high above the lows → height = neckline - min_extreme.
    // M: neckline is a swing low below the highs → height = max_extreme - neckline.
    // retraceFrac defaults to RETRACE_MIN_FRAC; overridable via options for calibration.
    const minExtreme = Math.min(p0.price, p2.price);
    const maxExtreme = Math.max(p0.price, p2.price);
    const patternHeight = isW
      ? p1.price - minExtreme
      : maxExtreme - p1.price;
    if (patternHeight < retraceFrac * atr14) continue;

    // ── Criterion 4: actionability — current price within 1% of neckline ────
    const distFromNeckline = (currentPrice - p1.price) / p1.price;
    if (Math.abs(distFromNeckline) > NECKLINE_WINDOW) continue;

    // ── All criteria pass — build the result ─────────────────────────────────
    const vol1 = closed[p0.index]?.volume ?? 0;
    const vol2 = closed[p2.index]?.volume ?? 0;

    return {
      type: isW ? "W" : "M",
      extreme1: { price: p0.price, index: p0.index, volume: vol1 },
      extreme2: { price: p2.price, index: p2.index, volume: vol2 },
      barSeparation: barSep,
      deltaAtr: extremeDelta / atr14,
      neckline: { price: p1.price, index: p1.index },
      patternHeight,
      currentPriceDistFromNeckline: distFromNeckline,
      secondExtremeVolumeLower: vol2 <= vol1,
      atr14,
    };
  }

  return null;
}
