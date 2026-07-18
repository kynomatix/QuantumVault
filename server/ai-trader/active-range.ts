// SL-PLACE Phase A: Active-range detector.
//
// Walks backward from the newest CLOSED bar accumulating the raw price envelope
// (max high, min low). The walk stops when a bar's intrabar range (high − low)
// exceeds k × ATR(14) — a structural-boundary signal — or the 400-bar cap is hit.
//
// Design rationale vs HTF-levels:
//   • HTF-levels require ≥2 fractal-confirmed pivot touches; these gates reject
//     lone extremes that still define real price boundaries (the "AAVE 91.78" gap).
//   • detectActiveRange uses raw extremes — no fractal qualification, no touch
//     minimum. The range high/low ARE the extremes; they need no other credentials.
//
// Null convention: returns null for insufficient data (< 14 closed bars), a
// degenerate range (envHigh ≤ envLow), or an invalid ATR. The caller (context-
// builder) treats null identically in both the "not-enough-data" and "error" cases.

import type { OHLCV } from "../lab/engine";
import { atr } from "../lab/indicators";

export const ACTIVE_RANGE_K = 3; // k multiplier: intrabar range > k×ATR = structural escape
export const DRIFT_ESCAPE_MULT = 6; // drift escape: |bar.close − newest.close| > 6×ATR = steady drift out of range

export interface ActiveRange {
  /** Raw maximum high of the walk-back span (newest-closed bar included). */
  high: number;
  /** Raw minimum low of the walk-back span (newest-closed bar included). */
  low: number;
  /** Number of bars in the active range (≥ 1; starts counting at newest-closed). */
  bars: number;
  /** Bars back from the newest-closed bar where the range high first occurred. */
  ageOfHigh: number;
  /** Bars back from the newest-closed bar where the range low first occurred. */
  ageOfLow: number;
  /** (price − low) / (high − low), clamped to [0, 1]. */
  pctInRange: number;
}

/**
 * Detect the active trading range by walking back from the newest closed bar.
 *
 * Forming-bar contract: `bars` must include the forming (current unclosed) bar
 * as its LAST element. It is stripped before any computation.
 *
 * @param bars    Candle array including the forming bar as the last element.
 * @param price   Current live price used to compute `pctInRange`.
 * @param k       ATR multiplier for the escape threshold (default: 3).
 * @param capBars Maximum number of bars to walk back from the newest-closed bar
 *                (default: 400 — matches INDICATOR_BARS in context-builder).
 * @returns       ActiveRange, or null when the range cannot be computed.
 */
export function detectActiveRange(
  bars: OHLCV[],
  price: number,
  k = ACTIVE_RANGE_K,
  capBars = 400,
): ActiveRange | null {
  const closed = bars.slice(0, -1); // strip forming bar
  const len = closed.length;

  if (len < 14) return null; // need ≥ 14 bars for ATR(14) to be defined

  const highs  = closed.map((b) => b.high);
  const lows   = closed.map((b) => b.low);
  const closes = closed.map((b) => b.close);
  const atrSeries = atr(highs, lows, closes, 14);
  const atr14 = atrSeries[len - 1];

  if (!Number.isFinite(atr14) || atr14 <= 0) return null;

  const threshold = k * atr14;

  // Seed the envelope from the newest closed bar (ageOf* = 0).
  const newest = closed[len - 1];
  let envHigh   = newest.high;
  let envLow    = newest.low;
  let ageOfHigh = 0;
  let ageOfLow  = 0;
  let walkCount = 1; // bars included so far (starts with newest-closed)

  // Walk backward; respect the cap.
  // floorIdx = len - capBars so that walkCount ≤ capBars (the starting bar is already
  // counted in walkCount=1, so we walk back at most capBars-1 additional bars).
  const floorIdx = Math.max(0, len - capBars);
  for (let i = len - 2; i >= floorIdx; i--) {
    const bar = closed[i];

    // Escape 1: bar's own intrabar volatility crosses the structural-boundary
    // threshold → stop WITHOUT including this bar.
    if (bar.high - bar.low > threshold) break;

    // Escape 2 (drift): bar's close has drifted more than DRIFT_ESCAPE_MULT×ATR
    // from the newest-closed bar's close. Catches steady directional drift that
    // never produces a single wide bar (each bar individually passes the intrabar
    // check) but whose close is already in a different price regime. Stop WITHOUT
    // including this bar.
    if (Math.abs(bar.close - newest.close) > DRIFT_ESCAPE_MULT * atr14) break;

    if (bar.high > envHigh) {
      envHigh   = bar.high;
      ageOfHigh = walkCount; // how many steps back from newest-closed
    }
    if (bar.low < envLow) {
      envLow   = bar.low;
      ageOfLow = walkCount;
    }
    walkCount++;
  }

  const rangeWidth = envHigh - envLow;
  if (rangeWidth <= 0) return null; // degenerate (flat candles)

  const pctInRange = Math.min(1, Math.max(0, (price - envLow) / rangeWidth));

  return { high: envHigh, low: envLow, bars: walkCount, ageOfHigh, ageOfLow, pctInRange };
}
