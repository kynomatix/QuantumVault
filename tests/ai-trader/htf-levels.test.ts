// Brick 4 fixture tests: server/ai-trader/htf-levels.ts
// All tests use n=1 (smallest fractal, easiest to construct fixtures for),
// parentBars=[] (selected-only simplifies time-mapping), and synthetic
// OHLCV bars with known range so ATR(14) is predictable.
//
// Bar fixture convention:
//   flatBar(t)            → neutral bar:  H=52 L=48 C=50  TR=4
//   spikeHigh(t, price)   → resistance:   H=price L=48 C=50
//   spikeLow(t, price)    → support:      H=52 L=price C=50
//   closeBar(t, close)    → custom close for status tests (H=close+2, L=close-2)
//
// Buffer-bar rule: every spikeHigh/spikeLow pivot needs a flatBar as its
// immediate right neighbor inside the closed-bar range; otherwise the *next*
// bar (closeBar or another spike) can undercut the pivot's n=1 strict-inequality
// check and silently drop the pivot.

import { describe, it, expect } from "vitest";
import type { OHLCV } from "../../server/lab/engine";
import { detectHTFLevels } from "../../server/ai-trader/htf-levels";

// ─── Bar helpers ──────────────────────────────────────────────────────────────

const MS = 60_000; // 1-minute step

function flatBar(t: number): OHLCV {
  return { time: t * MS, open: 50, high: 52, low: 48, close: 50, volume: 1_000 };
}

function spikeHigh(t: number, price: number): OHLCV {
  return { time: t * MS, open: 50, high: price, low: 48, close: 50, volume: 1_000 };
}

function spikeLow(t: number, price: number): OHLCV {
  return { time: t * MS, open: 50, high: 52, low: price, close: 50, volume: 1_000 };
}

/**
 * A bar with a specific close used for status-test tails.
 * High/low are chosen so that close is inside [low, high] and the bar's
 * range (4 units) matches the flatBar ATR contribution.
 * IMPORTANT: set high=52, low=48 so this bar cannot disrupt any adjacent
 * pivot's n=1 check via an extreme high or low — only the close matters here.
 */
function closeBar(t: number, close: number): OHLCV {
  return { time: t * MS, open: 50, high: 52, low: 48, close, volume: 1_000 };
}

/**
 * Build the ATR-warmup prefix: 15 flat bars (indices 0–14).
 * With TR=4 for every bar, ATR(14) converges to exactly 4 after bar 13.
 * Warmup bars occupy t=0..14 so caller can start pivots at t=15.
 */
function warmup(): OHLCV[] {
  return Array.from({ length: 15 }, (_, i) => flatBar(i));
}

// ─── Describe blocks ──────────────────────────────────────────────────────────

describe("htf-levels — multi-touch cluster formation", () => {
  /**
   * Series: 15 warmup bars, then alternating HIGH/LOW pivots whose prices
   * are deliberately close enough to cluster:
   *   3 spike highs at 56 / 56.3 / 55.9  → one cluster  (touchCount=3)
   *   2 spike lows  at 44 / 43.8          → one cluster  (touchCount=2)
   * Forming bar at the end.
   *
   * With ATR≈4–5, clusterThreshold≈2–2.5.
   * All intra-cluster gaps (0.1–0.4) are well inside threshold.
   * Inter-cluster gap (≈12) is far outside threshold.
   *
   * Buffer-bar layout (n=1):
   *   spikeHigh(15) → flatBar(16) → spikeLow(17) → flatBar(18) → spikeHigh(19) →
   *   flatBar(20) → spikeLow(21) → flatBar(22) → spikeHigh(23) → flatBar(24) → forming(25)
   * Each pivot has a flatBar as its right neighbor within the closed-bar range.
   */
  const PIVOT_SERIES: OHLCV[] = [
    ...warmup(),              // t=0..14
    spikeHigh(15, 56),        // HIGH pivot  — 1st resistance touch (idx 15)
    flatBar(16),              // right neighbor for bar[15]
    spikeLow(17, 44),         // LOW pivot   — 1st support touch (idx 17)
    flatBar(18),
    spikeHigh(19, 56.3),      // HIGH pivot  — 2nd resistance touch (idx 19)
    flatBar(20),
    spikeLow(21, 43.8),       // LOW pivot   — 2nd support touch (idx 21)
    flatBar(22),              // right neighbor for bar[21] (keeps pivot intact)
    spikeHigh(23, 55.9),      // HIGH pivot  — 3rd resistance touch (idx 23)
    flatBar(24),              // right neighbor for bar[23]
    flatBar(25),              // FORMING BAR (stripped by detectPivots)
  ];

  it("groups nearby high pivots into one cluster with correct counts", () => {
    const result = detectHTFLevels(PIVOT_SERIES, [], { n: 1 });

    expect(result.levels.length).toBeGreaterThanOrEqual(1);
    expect(result.atr14).toBeGreaterThan(0);

    const highLevel = result.levels.find((l) => l.price > 50);
    const lowLevel  = result.levels.find((l) => l.price < 50);

    expect(highLevel).toBeDefined();
    expect(highLevel!.touchCount).toBe(3);
    expect(highLevel!.rejectedFromAbove).toBe(3);
    expect(highLevel!.defendedFromBelow).toBe(0);
    // median([55.9, 56, 56.3]) = 56
    expect(highLevel!.price).toBeCloseTo(56, 4);

    expect(lowLevel).toBeDefined();
    expect(lowLevel!.touchCount).toBe(2);
    expect(lowLevel!.defendedFromBelow).toBe(2);
    expect(lowLevel!.rejectedFromAbove).toBe(0);
    // median([43.8, 44]) = 43.9
    expect(lowLevel!.price).toBeCloseTo(43.9, 4);
  });

  it("assigns correct barsSinceLastTouch", () => {
    // Last HIGH touch: spikeHigh at bar index 23.
    // selectedClosed = PIVOT_SERIES[0..24] (length=25), lastClosedIdx=24.
    // barsSinceLastTouch = 24 − 23 = 1.
    const result = detectHTFLevels(PIVOT_SERIES, [], { n: 1 });
    const highLevel = result.levels.find((l) => l.price > 50)!;
    expect(highLevel.barsSinceLastTouch).toBe(1);
  });
});

// ─── Status transitions ───────────────────────────────────────────────────────

describe("htf-levels — intact / lost / reclaimed status", () => {
  /**
   * Base for status tests:
   *   2 HIGH pivots at bars 15 (56) and 19 (56.3) → resistance cluster, lastTouch=19
   *   2 LOW  pivots at bars 17 (44) and 21 (43.8) → support cluster, lastTouch=21
   *   flatBar(22) is the BUFFER so the pivot at bar[21] has a safe right neighbor.
   *
   * Status-test "tails" are appended from bar[23] onward.
   * Tail bars use closeBar() which keeps H=52, L=48, so they never disrupt the
   * n=1 pivot checks of bars 19 or 21.
   *
   * Pivot check verification for bar[21] (n=1):
   *   bar[21].low=43.8 < bar[20].low=48 ✓  AND  bar[21].low=43.8 < bar[22].low=48 ✓
   */
  function baseSeries(): OHLCV[] {
    return [
      ...warmup(),           // t=0..14
      spikeHigh(15, 56),     // HIGH #1 (idx 15)
      flatBar(16),
      spikeLow(17, 44),      // LOW #1  (idx 17)
      flatBar(18),
      spikeHigh(19, 56.3),   // HIGH #2 — last resistance touch (idx 19)
      flatBar(20),
      spikeLow(21, 43.8),    // LOW #2  — last support touch    (idx 21)
      flatBar(22),           // BUFFER: right neighbor for bar[21]
    ];
  }

  // ── Resistance (majority highs) ──────────────────────────────────────────────
  it("status=intact when no close has crossed the resistance level after last touch", () => {
    const bars: OHLCV[] = [
      ...baseSeries(),
      closeBar(23, 50),   // close=50 < 56 → no breach
      flatBar(24),        // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const highLevel = result.levels.find((l) => l.price > 50)!;
    expect(highLevel).toBeDefined();
    expect(highLevel.status).toBe("intact");
  });

  it("status=lost when a close breaches the resistance level after last touch", () => {
    const bars: OHLCV[] = [
      ...baseSeries(),
      closeBar(23, 58),   // close=58 > 56 → resistance breached
      flatBar(24),        // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const highLevel = result.levels.find((l) => l.price > 50)!;
    expect(highLevel).toBeDefined();
    expect(highLevel.status).toBe("lost");
  });

  it("status=reclaimed when price closes back through resistance after losing it", () => {
    const bars: OHLCV[] = [
      ...baseSeries(),
      closeBar(23, 58),   // breaches resistance (lost)
      closeBar(24, 54),   // closes back below 56 (reclaimed)
      flatBar(25),        // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const highLevel = result.levels.find((l) => l.price > 50)!;
    expect(highLevel).toBeDefined();
    expect(highLevel.status).toBe("reclaimed");
  });

  // ── Support (majority lows) ───────────────────────────────────────────────────
  it("status=intact for a support level when no close falls below it", () => {
    const bars: OHLCV[] = [
      ...baseSeries(),
      closeBar(23, 50),   // close=50 > 43.9 → no breach of support
      flatBar(24),        // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const lowLevel = result.levels.find((l) => l.price < 50)!;
    expect(lowLevel).toBeDefined();
    expect(lowLevel.status).toBe("intact");
  });

  it("status=lost for a support level when price closes below it", () => {
    const bars: OHLCV[] = [
      ...baseSeries(),
      closeBar(23, 40),   // close=40 < 43.9 → support breached
      flatBar(24),        // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const lowLevel = result.levels.find((l) => l.price < 50)!;
    expect(lowLevel).toBeDefined();
    expect(lowLevel.status).toBe("lost");
  });

  it("status=reclaimed for a support level after it was lost and price closed back above", () => {
    const bars: OHLCV[] = [
      ...baseSeries(),
      closeBar(23, 40),   // below support → lost
      closeBar(24, 47),   // back above 43.9 → reclaimed
      flatBar(25),        // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const lowLevel = result.levels.find((l) => l.price < 50)!;
    expect(lowLevel).toBeDefined();
    expect(lowLevel.status).toBe("reclaimed");
  });
});

// ─── ATR-proximity clustering edge ───────────────────────────────────────────

describe("htf-levels — ATR-proximity clustering edge", () => {
  /**
   * Three groups of pivot prices:
   *   Group A (lows):  43.8, 44, 44.2  — all within 0.4 of each other → one cluster
   *   Group B (highs): 60, 60.3        — within 0.3 → one cluster
   *   Group C (high):  75              — 15 away from Group B → touchCount=1, filtered
   *
   * ATR ≈ 4–5 → threshold ≈ 2–2.5.
   * Intra-group gaps (≤ 0.4) always merge; inter-group gap (≥ 14.7) always splits.
   * Validates the greedy anchor-based clustering without depending on the exact ATR.
   *
   * Buffer-bar layout (n=1): every spike is followed by a flatBar before the next spike.
   */
  function clusterEdgeSeries(): OHLCV[] {
    return [
      ...warmup(),              // t=0..14
      spikeHigh(15, 60),        // HIGH #1 — Group B anchor
      flatBar(16),
      spikeLow(17, 44),         // LOW #1  — Group A
      flatBar(18),
      spikeHigh(19, 60.3),      // HIGH #2 — Group B (gap=0.3 from anchor)
      flatBar(20),
      spikeLow(21, 43.8),       // LOW #2  — Group A (gap=0.2 from anchor)
      flatBar(22),              // buffer for bar[21]
      spikeHigh(23, 75),        // HIGH #3 — Group C (gap=15 from Group B, alone)
      flatBar(24),              // buffer for bar[23]
      spikeLow(25, 44.2),       // LOW #3  — Group A (gap=0.4 from anchor, merged)
      flatBar(26),              // buffer for bar[25]
      flatBar(27),              // FORMING
    ];
  }

  it("merges pivot prices within threshold into the same cluster", () => {
    const result = detectHTFLevels(clusterEdgeSeries(), [], { n: 1 });
    const lowLevel = result.levels.find((l) => l.price < 50)!;
    expect(lowLevel).toBeDefined();
    expect(lowLevel.touchCount).toBe(3);   // 43.8, 44, 44.2 all merged
    // median([43.8, 44, 44.2]) = 44
    expect(lowLevel.price).toBeCloseTo(44, 4);
  });

  it("merges two nearby high pivots into one level", () => {
    const result = detectHTFLevels(clusterEdgeSeries(), [], { n: 1 });
    const highLevel = result.levels.find((l) => l.price > 50 && l.price < 70)!;
    expect(highLevel).toBeDefined();
    expect(highLevel.touchCount).toBe(2);   // 60 and 60.3 merged
    expect(highLevel.price).toBeCloseTo(60.15, 2);
  });

  it("does not merge pivots that are far apart (gap >> threshold)", () => {
    const result = detectHTFLevels(clusterEdgeSeries(), [], { n: 1 });
    // The pivot at 75 is alone (touchCount=1) → filtered by minTouches=2.
    const spurious = result.levels.find((l) => l.price > 70);
    expect(spurious).toBeUndefined();
  });

  it("the two major clusters are separate (inter-cluster gap ≈ 16)", () => {
    const result = detectHTFLevels(clusterEdgeSeries(), [], { n: 1 });
    // Exactly 2 qualified levels: one near 44, one near 60
    expect(result.levels.length).toBe(2);
    expect(result.levels[0].price).toBeLessThan(50);    // support cluster
    expect(result.levels[1].price).toBeGreaterThan(55); // resistance cluster
  });
});

// ─── Nearest-4 selection ─────────────────────────────────────────────────────

describe("htf-levels — nearest-4 selection (≤2 above + ≤2 below)", () => {
  /**
   * Build a series with 5 qualified levels:
   *   below price=50:  ~30.5 (3 lows), ~40.05 (2 lows)
   *   above price=50:  ~60.1 (2 highs), ~70.1 (2 highs), ~80.05 (2 highs)
   *
   * Expected selection (nearest 2 below + nearest 2 above):
   *   [~30.5, ~40.05, ~60.1, ~70.1]   — level at ~80.05 is excluded (3rd above)
   *
   * Key ZigZag constraint: spikeHigh(31,70.2) and spikeHigh(33,80.1) would be
   * consecutive highs → ZigZag would replace H(70.2) with H(80.1), leaving H(70)
   * with only 1 touch. Fix: insert spikeLow(32, 30.5) between them so both H
   * pivots survive with their own cluster touch.
   */
  function fiveLevelSeries(): OHLCV[] {
    return [
      ...warmup(),               // t=0..14
      spikeHigh(15, 60),         // H60 #1
      flatBar(16),
      spikeLow(17, 40),          // L40 #1
      flatBar(18),
      spikeHigh(19, 70),         // H70 #1
      flatBar(20),
      spikeLow(21, 30),          // L30 #1
      flatBar(22),
      spikeHigh(23, 80),         // H80 #1
      flatBar(24),
      spikeLow(25, 31),          // L30 #2 (near L30 — gap=1, same cluster)
      flatBar(26),
      spikeHigh(27, 60.2),       // H60 #2 (near H60 — gap=0.2, same cluster)
      flatBar(28),
      spikeLow(29, 40.1),        // L40 #2 (near L40 — gap=0.1, same cluster)
      flatBar(30),
      spikeHigh(31, 70.2),       // H70 #2 (near H70 — gap=0.2, same cluster)
      spikeLow(32, 30.5),        // L30 #3 (near L30) — separates H70.2 from H80.1 so ZigZag keeps both
      spikeHigh(33, 80.1),       // H80 #2 (near H80 — gap=0.1, same cluster)
      flatBar(34),               // buffer for bar[33]
      flatBar(35),               // FORMING
    ];
  }

  it("returns exactly 4 levels when enough qualified levels exist (2 above + 2 below)", () => {
    const result = detectHTFLevels(fiveLevelSeries(), [], { n: 1 });
    expect(result.levels.length).toBe(4);
  });

  it("selected levels are the 2 nearest below and 2 nearest above current price", () => {
    const result = detectHTFLevels(fiveLevelSeries(), [], { n: 1 });
    // current price = forming bar close = 50
    const below = result.levels.filter((l) => l.price <= 50);
    const above = result.levels.filter((l) => l.price > 50);
    expect(below.length).toBe(2);
    expect(above.length).toBe(2);
    // The 2 lowest above: ~60 and ~70  (not ~80)
    expect(above.every((l) => l.price < 75)).toBe(true);
    expect(above.find((l) => l.price > 75)).toBeUndefined();
  });

  it("returns fewer than 4 when fewer qualified levels exist", () => {
    // Only 2 qualified levels: 1 below, 1 above → should return both (total 2)
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),
      flatBar(16),
      spikeLow(17, 44),
      flatBar(18),
      spikeHigh(19, 56.3),
      flatBar(20),
      spikeLow(21, 43.8),
      flatBar(22),
      flatBar(23), // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    expect(result.levels.length).toBe(2);
    expect(result.levels.filter((l) => l.price > 50).length).toBe(1);
    expect(result.levels.filter((l) => l.price < 50).length).toBe(1);
  });
});

// ─── Sub-2-touch exclusion ────────────────────────────────────────────────────

describe("htf-levels — sub-minTouches cluster exclusion", () => {
  /**
   * Series with two groups of high pivots:
   *   Group near 56: 2 touches → qualifies
   *   Lone pivot at 75: 1 touch → filtered (too far to merge with the 56 group)
   */
  it("excludes single-pivot clusters (touchCount < minTouches=2)", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),         // HIGH #1 at 56
      flatBar(16),
      spikeLow(17, 44),          // alternating LOW (enables next HIGH to survive ZigZag)
      flatBar(18),
      spikeHigh(19, 56.2),       // HIGH #2 near 56 → cluster qualifies
      flatBar(20),
      spikeLow(21, 43.5),        // LOW #2 → forms support cluster
      flatBar(22),               // buffer for bar[21]
      spikeHigh(23, 75),         // LONE HIGH at 75 — far from 56 (touchCount=1)
      flatBar(24),               // buffer for bar[23]
      flatBar(25),               // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });

    // Pivot at 75 is alone (far from 56) → touchCount=1 → filtered
    expect(result.levels.find((l) => l.price > 70)).toBeUndefined();

    // The level near 56 should be present
    const highLevel = result.levels.find((l) => l.price > 50 && l.price < 70);
    expect(highLevel).toBeDefined();
    expect(highLevel!.touchCount).toBe(2);
  });

  it("returns empty levels when no cluster reaches minTouches", () => {
    // Just one HIGH and one LOW pivot each — both touchCount=1, both filtered
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),
      flatBar(16),
      spikeLow(17, 44),
      flatBar(18),
      flatBar(19), // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    expect(result.levels).toHaveLength(0);
  });

  it("honours a custom minTouches=1 to include single-pivot clusters", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),
      flatBar(16),
      spikeLow(17, 44),
      flatBar(18),
      flatBar(19), // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1, minTouches: 1 });
    // Both the lone HIGH and lone LOW should appear
    expect(result.levels.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Edge / guard cases ───────────────────────────────────────────────────────

describe("htf-levels — edge and guard cases", () => {
  it("returns empty when selectedBars has fewer than 15 bars (ATR warmup unmet)", () => {
    // 14 bars total = 13 closed bars — not enough for ATR(14) → clusterThreshold=0 → early return
    const bars = Array.from({ length: 14 }, (_, i) => flatBar(i));
    const result = detectHTFLevels(bars, [], { n: 1 });
    expect(result.levels).toHaveLength(0);
    expect(result.atr14).toBe(0);
    expect(result.clusterThreshold).toBe(0);
  });

  it("handles empty parentBars without error", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),
      flatBar(16),
      spikeLow(17, 44),
      flatBar(18),
      spikeHigh(19, 56.2),
      flatBar(20),
      spikeLow(21, 43.8),
      flatBar(22),
      flatBar(23), // FORMING
    ];
    expect(() => detectHTFLevels(bars, [], { n: 1 })).not.toThrow();
    const result = detectHTFLevels(bars, [], { n: 1 });
    expect(result.levels.length).toBeGreaterThan(0);
  });

  it("output levels are sorted ascending by price", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),
      flatBar(16),
      spikeLow(17, 44),
      flatBar(18),
      spikeHigh(19, 56.3),
      flatBar(20),
      spikeLow(21, 43.8),
      flatBar(22),
      flatBar(23), // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1 });
    const prices = result.levels.map((l) => l.price);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThan(prices[i - 1]);
    }
  });

  it("atrClusterMult=0 short-circuits and returns empty (threshold=0 guard)", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      spikeHigh(15, 56),
      flatBar(16),
      spikeLow(17, 44),
      flatBar(18),
      flatBar(19), // FORMING
    ];
    const result = detectHTFLevels(bars, [], { n: 1, atrClusterMult: 0 });
    expect(result.levels).toHaveLength(0);
    expect(result.clusterThreshold).toBe(0);
  });
});
