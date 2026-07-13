/**
 * Brick 4: Higher-timeframe (HTF) support/resistance level detection.
 *
 * Consumes detectPivots over the selected and (optionally) parent bar windows,
 * clusters nearby pivots by price proximity (within ATR_CLUSTER_MULT × ATR(14)),
 * and returns the top-4 nearest qualified levels (≤2 above, ≤2 below current
 * price) that have accumulated at least MIN_TOUCHES confirmed touches.
 *
 * Pure function — no IO, no side-effects. Safe to call inside the decision loop.
 */
import type { OHLCV } from "../lab/engine";
import { atr } from "../lab/indicators";
import { detectPivots, FRACTAL_N, type SwingPivot, type SwingType } from "./dow-structure";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Cluster proximity multiplier applied to ATR(14).
 * Two pivots join the same level if |p1.price − p0.price| < ATR_CLUSTER_MULT × ATR(14).
 * Tunable via detectHTFLevels options.
 */
export const ATR_CLUSTER_MULT = 0.5;

/** Minimum confirmed touches for a cluster to qualify as an HTF level. */
export const MIN_TOUCHES = 2;

// ─── Public types ─────────────────────────────────────────────────────────────

/** A single confirmed support/resistance level and its descriptive statistics. */
export interface HtfLevel {
  /** Median price of all pivot members in this cluster. */
  price: number;
  /** Total number of pivots in this cluster (= confirmed touches). */
  touchCount: number;
  /** Swing-high members at this level (resistance / "rejected from above" touches). */
  rejectedFromAbove: number;
  /** Swing-low members at this level (support / "defended from below" touches). */
  defendedFromBelow: number;
  /**
   * Structural status since the most recent touch:
   *   'intact'    — no close has crossed through the level.
   *   'lost'      — at least one close crossed through since last touch.
   *   'reclaimed' — level was lost but price subsequently closed back through it.
   * Direction is determined by the majority touch type (resistance if more highs;
   * support if more lows; tie breaks to the most-recent touch's type).
   */
  status: "intact" | "lost" | "reclaimed";
  /**
   * Number of selected-timeframe closed bars elapsed since the most recent
   * pivot in this cluster.
   */
  barsSinceLastTouch: number;
}

/** Output of detectHTFLevels. */
export interface HtfLevelsResult {
  /**
   * Up to 4 qualified levels nearest to the current price:
   * at most 2 above and at most 2 below, sorted by price ascending.
   */
  levels: HtfLevel[];
  /** ATR(14) computed from the closed selected bars; 0 when insufficient data. */
  atr14: number;
  /** Clustering distance threshold applied (= atrClusterMult × atr14). */
  clusterThreshold: number;
}

// ─── Internal types ───────────────────────────────────────────────────────────

/**
 * A pivot annotated with a wall-clock timestamp and its resolved index into
 * the selected-timeframe closed-bar slice.  Used for barsSinceLastTouch and
 * the post-touch close scan for status computation.
 */
interface TimedPivot {
  price: number;
  type: SwingType;
  time: number;              // bar's .time (ms epoch)
  selectedClosedIdx: number; // 0-based index into selectedBars.slice(0, -1)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Rightmost index in `arr` (sorted ascending by .time) where arr[i].time <= target.
 * Returns 0 when target is before all entries (clamps to the start).
 */
function floorTimeIdx(arr: OHLCV[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= target) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** Median of a non-empty numeric array. */
function median(prices: number[]): number {
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect HTF support/resistance levels from fractal pivot clustering.
 *
 * Forming-bar contract: both `selectedBars` and `parentBars` must include the
 * forming (unclosed) bar as their last element — consistent with detectPivots.
 * Pass `parentBars = []` when the selected timeframe has no parent (e.g. "1d").
 *
 * @param selectedBars  Candles at the bot's selected timeframe.
 * @param parentBars    Candles at the parent timeframe, or [] when unavailable.
 * @param options       Override fractal N, cluster multiplier, or min-touch floor.
 */
export function detectHTFLevels(
  selectedBars: OHLCV[],
  parentBars: OHLCV[],
  options?: {
    /** Fractal width (default: FRACTAL_N = 3). */
    n?: number;
    /** ATR multiplier for cluster proximity (default: ATR_CLUSTER_MULT = 0.5). */
    atrClusterMult?: number;
    /** Minimum confirmed touches to qualify a level (default: MIN_TOUCHES = 2). */
    minTouches?: number;
  }
): HtfLevelsResult {
  const n             = options?.n             ?? FRACTAL_N;
  const atrClusterMult = options?.atrClusterMult ?? ATR_CLUSTER_MULT;
  const minTouches    = options?.minTouches    ?? MIN_TOUCHES;

  // ── 1. ATR(14) from the selected window (closed bars only) ──────────────────
  // The forming bar (last element) is excluded so its partial range does not
  // inflate the ATR and distort the cluster threshold.
  const selectedClosed = selectedBars.slice(0, -1);

  let atr14 = 0;
  if (selectedClosed.length >= 14) {
    const highs  = selectedClosed.map((b) => b.high);
    const lows   = selectedClosed.map((b) => b.low);
    const closes = selectedClosed.map((b) => b.close);
    const series = atr(highs, lows, closes, 14);
    const last   = series[series.length - 1];
    atr14 = Number.isFinite(last) && last > 0 ? last : 0;
  }
  const clusterThreshold = atrClusterMult * atr14;

  // Guard: if we cannot compute a meaningful threshold, clustering with 0 would
  // merge every pivot into one, so return empty early.
  if (clusterThreshold === 0) {
    return { levels: [], atr14, clusterThreshold };
  }

  // ── 2. Detect pivots in both windows ────────────────────────────────────────
  const selPivots: SwingPivot[] = detectPivots(selectedBars, n);
  const parPivots: SwingPivot[] = parentBars.length > 0
    ? detectPivots(parentBars, n)
    : [];
  const parentClosed = parentBars.slice(0, -1);

  if (selPivots.length + parPivots.length === 0) {
    return { levels: [], atr14, clusterThreshold };
  }

  // ── 3. Map every pivot to a TimedPivot with a resolved selectedClosedIdx ────
  // For selected pivots: pivot.index IS the index into selectedClosed (both
  // are derived from the same bar array — bars.slice(0,-1) is the same set
  // of indices since we only strip the last element).
  // For parent pivots: resolve by wall-clock time so barsSinceLastTouch is
  // expressed in selected-timeframe bars, not parent-timeframe bars.
  const allPivots: TimedPivot[] = [];

  for (const p of selPivots) {
    const bar = selectedClosed[p.index];
    if (!bar) continue;
    allPivots.push({ price: p.price, type: p.type, time: bar.time, selectedClosedIdx: p.index });
  }

  for (const p of parPivots) {
    const bar = parentClosed[p.index];
    if (!bar) continue;
    const selectedClosedIdx = selectedClosed.length > 0
      ? floorTimeIdx(selectedClosed, bar.time)
      : 0;
    allPivots.push({ price: p.price, type: p.type, time: bar.time, selectedClosedIdx });
  }

  if (allPivots.length === 0) {
    return { levels: [], atr14, clusterThreshold };
  }

  // ── 4. Sort by price and greedy-cluster (anchor = first member's price) ──────
  // Using the first member as the anchor guarantees a deterministic, O(n) pass
  // and a cluster width bounded by threshold from the first encountered price
  // in the sorted order.
  allPivots.sort((a, b) => a.price - b.price);

  interface RawCluster { anchor: number; members: TimedPivot[] }
  const rawClusters: RawCluster[] = [];

  for (const p of allPivots) {
    const last = rawClusters[rawClusters.length - 1];
    if (!last || p.price - last.anchor >= clusterThreshold) {
      rawClusters.push({ anchor: p.price, members: [p] });
    } else {
      last.members.push(p);
    }
  }

  // ── 5. Build HtfLevel per qualified cluster ──────────────────────────────────
  const lastClosedIdx = selectedClosed.length - 1; // index of the last closed bar
  // Current price: use the forming bar's close (the price the market is at now).
  const currentPrice  = selectedBars[selectedBars.length - 1].close;

  const qualifiedLevels: HtfLevel[] = [];

  for (const cluster of rawClusters) {
    if (cluster.members.length < minTouches) continue;

    const price             = median(cluster.members.map((m) => m.price));
    const rejectedFromAbove = cluster.members.filter((m) => m.type === "high").length;
    const defendedFromBelow = cluster.members.filter((m) => m.type === "low").length;

    // Most-recent touch determines barsSinceLastTouch and the status direction.
    const lastTouchIdx      = Math.max(...cluster.members.map((m) => m.selectedClosedIdx));
    const barsSinceLastTouch = Math.max(0, lastClosedIdx - lastTouchIdx);

    // Primary direction for status evaluation:
    //   majority highs → resistance (lost = close above level)
    //   majority lows  → support    (lost = close below level)
    //   tie            → use the most-recent touch's type
    let isResistance: boolean;
    if (rejectedFromAbove !== defendedFromBelow) {
      isResistance = rejectedFromAbove > defendedFromBelow;
    } else {
      const mostRecent = cluster.members.reduce((best, m) =>
        m.selectedClosedIdx > best.selectedClosedIdx ? m : best
      );
      isResistance = mostRecent.type === "high";
    }

    // Scan selected-bar closes AFTER the last touch for structural status.
    const closesAfter = selectedClosed.slice(lastTouchIdx + 1).map((b) => b.close);

    let status: "intact" | "lost" | "reclaimed" = "intact";
    const lostIdx = isResistance
      ? closesAfter.findIndex((c) => c > price)
      : closesAfter.findIndex((c) => c < price);

    if (lostIdx !== -1) {
      const closesAfterLost = closesAfter.slice(lostIdx + 1);
      const reclaimed = isResistance
        ? closesAfterLost.some((c) => c < price)
        : closesAfterLost.some((c) => c > price);
      status = reclaimed ? "reclaimed" : "lost";
    }

    qualifiedLevels.push({
      price,
      touchCount: cluster.members.length,
      rejectedFromAbove,
      defendedFromBelow,
      status,
      barsSinceLastTouch,
    });
  }

  // qualifiedLevels is already sorted by price (clusters built from ascending-sorted pivots).

  // ── 6. Select nearest 4: ≤2 above + ≤2 below current price ─────────────────
  const above = qualifiedLevels.filter((l) => l.price > currentPrice);
  const below = qualifiedLevels.filter((l) => l.price <= currentPrice);

  // 2 nearest above (lowest two in the above group = first two ascending)
  const nearestAbove = above.slice(0, 2);
  // 2 nearest below (highest two in the below group = last two ascending)
  const nearestBelow = below.slice(-2);

  // Merge and preserve ascending price order for the caller.
  const selected = [...nearestBelow, ...nearestAbove];

  return { levels: selected, atr14, clusterThreshold };
}
