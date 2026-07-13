// server/ai-trader/dow-structure.ts
//
// Brick 2, Phase 2A — Dow trend-structure via fractal swing pivot detection.
// Pure module: no app imports, no I/O, no external dependencies.
//
// Consumed by:
//   Phase 2B  — context-builder.ts (prompt injection + digest stamp)
//   Brick 3   — wm-detector.ts (W/M double-top/bottom, requires this pivot engine)
//   Brick 4   — HTF-levels (ZEC pattern, requires this pivot engine)
//
// Public API:
//   detectPivots(bars, n?)  — the reusable fractal pivot engine; kept independent
//                              of the classification layer for Brick 3/4 reuse.
//   classifyDow(pivots)     — classifies Dow structure from the last 4 alternating pivots.
//
// ─── Forming-bar contract (BINDING) ───────────────────────────────────────────
//
//   The LAST element of the `bars` input array is always treated as the forming
//   (currently open, unclosed) bar and is stripped before any computation.
//   Consequence: the forming bar can neither MINT (be a pivot center) nor UNMAKE
//   (appear in a neighbor comparison that could eliminate an existing pivot) a pivot.
//
//   Callers with a stream of OHLCV bars (including the live, updating bar at the end)
//   pass the full array without modification — the slice is done internally.
//   If you only have closed bars and no forming bar, append a sentinel `{ high: 0, low: 0 }`
//   at the end, or equivalently treat the last closed bar as "forming" (it will be
//   excluded from pivot detection, which is the conservative choice).
//
// ─── Tie rule for equal-priced neighbors (BINDING) ────────────────────────────
//
//   Strict inequality (>) is required for pivot qualification:
//     Swing HIGH: bar.high must be STRICTLY GREATER than every neighbor's high within N bars.
//     Swing LOW:  bar.low must be STRICTLY LESS than every neighbor's low within N bars.
//
//   A bar whose high exactly equals any neighbor's high within the N-bar window is NOT
//   a swing high — equal highs represent a double-top at the neighbor level, not a fractal
//   pivot at this bar. The same applies to equal lows.
//
//   ZigZag tie rule for consecutive same-side pivots of equal price: the EARLIER pivot
//   is retained (replacement uses strict >, so equal does not replace).

export const FRACTAL_N = 3;

export type SwingType = "high" | "low";

/** A single fractal swing pivot. `index` is into the original `bars` array (0-based). */
export interface SwingPivot {
  /**
   * 0-based index into the original `bars` array passed to detectPivots.
   * Equivalently: 0-based index into the closed-bars slice (bars[0..length-2])
   * because we only remove the last element.
   */
  index: number;
  type: SwingType;
  /**
   * bar.high for a swing high, bar.low for a swing low.
   * Phase 2B renders this as the measurement in the prompt line.
   */
  price: number;
}

export type DowClassification = "HH/HL" | "LH/LL" | "mixed" | "insufficient";

/** Result of Dow structure classification. */
export interface DowStructureResult {
  classification: DowClassification;
  /**
   * The last 4 alternating pivots used for classification (fewer if insufficient).
   * Phase 2B uses `pivots` to render actual prices in the prompt line, e.g.:
   * "last swing high 64,230 > 63,940; last swing low 63,580 > 63,200"
   */
  pivots: SwingPivot[];
}

type Bar = { high: number; low: number };

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Apply the ZigZag alternation rule to raw (possibly non-alternating) pivots.
 *
 * Rules:
 *   - Output must alternate high/low.
 *   - Consecutive same-side pivots: keep the more extreme (higher of two highs,
 *     lower of two lows). Equal prices: the EARLIER pivot is retained.
 */
function applyZigZag(rawPivots: SwingPivot[]): SwingPivot[] {
  const result: SwingPivot[] = [];
  for (const pivot of rawPivots) {
    if (result.length === 0) {
      result.push(pivot);
      continue;
    }
    const last = result[result.length - 1];
    if (last.type === pivot.type) {
      // Same side — keep the more extreme; strict > means equal retains the earlier.
      if (pivot.type === "high" && pivot.price > last.price) {
        result[result.length - 1] = pivot;
      } else if (pivot.type === "low" && pivot.price < last.price) {
        result[result.length - 1] = pivot;
      }
      // else: current is less extreme or equal → keep existing (no replacement)
    } else {
      result.push(pivot);
    }
  }
  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect fractal swing pivots in a bar series.
 *
 * A swing HIGH at bar i requires bar[i].high to STRICTLY EXCEED the highs of every bar
 * within N positions on each side (bar[i-N..i-1] and bar[i+1..i+N]).
 * A swing LOW mirrors: bar[i].low must be STRICTLY LESS than every neighbor's low.
 *
 * Forming-bar contract: `bars[bars.length - 1]` is always stripped (treated as the
 * unclosed forming bar) before detection. See module header for full contract.
 *
 * Returns ZigZag-alternated pivots sorted ascending by index (oldest first).
 *
 * @param bars  All bars INCLUDING the forming bar as the last element.
 * @param n     Fractal width — bars required on each side (default: FRACTAL_N = 3).
 */
export function detectPivots(bars: Bar[], n: number = FRACTAL_N): SwingPivot[] {
  // Strip the forming bar (bars[length-1]) — it can neither mint nor unmake a pivot.
  const closed = bars.slice(0, -1);

  if (closed.length < 2 * n + 1) {
    // Not enough closed bars for any pivot to have N neighbors on each side.
    return [];
  }

  const raw: SwingPivot[] = [];
  const maxI = closed.length - 1 - n;

  for (let i = n; i <= maxI; i++) {
    const bar = closed[i];
    let isHigh = true;
    let isLow = true;

    for (let offset = 1; offset <= n; offset++) {
      const left = closed[i - offset];
      const right = closed[i + offset];

      // Strict inequality: equal neighbor prevents pivot (see tie rule in module header).
      if (left.high >= bar.high || right.high >= bar.high) isHigh = false;
      if (left.low <= bar.low || right.low <= bar.low) isLow = false;

      if (!isHigh && !isLow) break; // short-circuit
    }

    if (isHigh) raw.push({ index: i, type: "high", price: bar.high });
    if (isLow) raw.push({ index: i, type: "low", price: bar.low });
  }

  return applyZigZag(raw);
}

/**
 * Classify Dow trend structure from a list of ZigZag-alternated pivots.
 *
 * Uses the last 4 alternating pivots (the minimum required to compare two same-side
 * extremes). Classification:
 *   HH/HL       — the most recent high > previous high, AND most recent low > previous low
 *   LH/LL       — the most recent high < previous high, AND most recent low < previous low
 *   mixed       — any other combination (said plainly; equal prices also yield mixed)
 *   insufficient — fewer than 4 pivots available
 *
 * @param pivots  Output of detectPivots() — already ZigZag-alternated.
 */
export function classifyDow(pivots: SwingPivot[]): DowStructureResult {
  if (pivots.length < 4) {
    return { classification: "insufficient", pivots: [...pivots] };
  }

  const last4 = pivots.slice(-4);

  // In a properly alternating ZigZag walk, last 4 contains exactly 2 highs and 2 lows.
  // filter() preserves order, so highs[0]/lows[0] are the earlier pivots.
  const highs = last4.filter((p) => p.type === "high");
  const lows = last4.filter((p) => p.type === "low");

  if (highs.length !== 2 || lows.length !== 2) {
    // Defensive: should not occur with well-formed ZigZag input.
    return { classification: "mixed", pivots: last4 };
  }

  const hhFlag = highs[1].price > highs[0].price; // most recent high > previous high
  const hlFlag = lows[1].price > lows[0].price;   // most recent low  > previous low
  const lhFlag = highs[1].price < highs[0].price;
  const llFlag = lows[1].price < lows[0].price;

  let classification: DowClassification;
  if (hhFlag && hlFlag) {
    classification = "HH/HL";
  } else if (lhFlag && llFlag) {
    classification = "LH/LL";
  } else {
    classification = "mixed";
  }

  return { classification, pivots: last4 };
}
