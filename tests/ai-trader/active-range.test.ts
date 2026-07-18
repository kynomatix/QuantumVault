// SL-PLACE Phase A fixture tests: server/ai-trader/active-range.ts
//
// Algorithm under test:
//   Walk backward from the newest CLOSED bar accumulating a raw price envelope
//   (envHigh = max high, envLow = min low). Stop when a bar's intrabar range
//   (high − low) exceeds k × ATR(14) — a structural-boundary signal. Return
//   high/low/bars/ageOfHigh/ageOfLow/pctInRange, or null on insufficient data.
//
// Bar fixture convention:
//   flatBar(t)              → H=51 L=49 C=50  intrabar-range=2
//   spikeBar(t, h, l)       → H=h  L=l  C=(h+l)/2
//   escapeBar(t)            → H=55 L=45 C=50  intrabar-range=10 (> threshold)
//   forming(t)              → identical to flatBar — LAST element, stripped by detectActiveRange
//
// Warmup convention:
//   15 flatBars (t=0..14) → ATR(14) converges to ~2 → k=3 → threshold ≈ 6.
//   Any bar with H-L > 6 triggers the structural-escape stop.

import { describe, it, expect } from "vitest";
import type { OHLCV } from "../../server/lab/engine";
import { detectActiveRange } from "../../server/ai-trader/active-range";

// ─── Bar helpers ───────────────────────────────────────────────────────────────

const MS = 60_000;

function flatBar(t: number): OHLCV {
  return { time: t * MS, open: 50, high: 51, low: 49, close: 50, volume: 1_000 };
}

function spikeBar(t: number, h: number, l: number): OHLCV {
  return { time: t * MS, open: 50, high: h, low: l, close: (h + l) / 2, volume: 1_000 };
}

/** Intrabar range = 10, always > threshold (≈6 with ATR≈2, k=3). */
function escapeBar(t: number): OHLCV {
  return { time: t * MS, open: 50, high: 55, low: 45, close: 50, volume: 1_000 };
}

function warmup(): OHLCV[] {
  return Array.from({ length: 15 }, (_, i) => flatBar(i));
}

// ─── Describe blocks ──────────────────────────────────────────────────────────

describe("detectActiveRange — basic range detection", () => {
  /**
   * Series: 15 warmup bars (ATR→2, threshold≈6), then:
   *   bar15: spike H=60 L=59.6 range=0.4 (within threshold — included)
   *   bar16: flat
   *   bar17: flat  ← newest closed
   *   bar18: forming (stripped)
   *
   * Walking backward from bar17:
   *   bar16 range=2 ≤ 6 → include
   *   bar15 range=0.4 ≤ 6 → include (envHigh=60, ageOfHigh=2)
   *   warmup bars range=2 ≤ 6 → include (all 15 bars)
   *
   * Expected: high=60, low=49, bars=18 (bar17 + bar16 + bar15 + 15 warmup = 18), ageOfHigh=2
   */
  const BARS: OHLCV[] = [
    ...warmup(),                         // t=0..14
    spikeBar(15, 60, 59.6),              // range=0.4 — spike HIGH
    flatBar(16),
    flatBar(17),                         // newest closed
    flatBar(18),                         // FORMING
  ];

  it("returns the raw max high including a within-threshold spike", () => {
    const r = detectActiveRange(BARS, 50);
    expect(r).not.toBeNull();
    expect(r!.high).toBeCloseTo(60, 4);
  });

  it("returns the raw min low (from quiet bars)", () => {
    const r = detectActiveRange(BARS, 50);
    expect(r!.low).toBeCloseTo(49, 4);
  });

  it("bars count equals total bars walked back", () => {
    const r = detectActiveRange(BARS, 50);
    // 15 warmup + bar15 + bar16 + bar17 = 18 closed bars included
    expect(r!.bars).toBe(18);
  });

  it("ageOfHigh is bars back from newest-closed to the spike bar", () => {
    // bar17=newest (age 0), bar16 (age 1), bar15=spike (age 2)
    const r = detectActiveRange(BARS, 50);
    expect(r!.ageOfHigh).toBe(2);
  });

  it("ageOfLow is 0 when the newest-closed bar holds the range low", () => {
    // bar17: L=49 — same as all other bars, first encountered is newest-closed
    const r = detectActiveRange(BARS, 50);
    expect(r!.ageOfLow).toBe(0);
  });

  it("pctInRange: price=60 (at high) → 100%", () => {
    const r = detectActiveRange(BARS, 60);
    expect(r!.pctInRange).toBeCloseTo(1, 4);
  });

  it("pctInRange: price=49 (at low) → 0%", () => {
    const r = detectActiveRange(BARS, 49);
    expect(r!.pctInRange).toBeCloseTo(0, 4);
  });

  it("pctInRange: price=54.5 (midrange of 49–60) → ≈50%", () => {
    const r = detectActiveRange(BARS, 54.5);
    expect(r!.pctInRange).toBeCloseTo(0.5, 2);
  });

  it("pctInRange is clamped to [0, 1] when price is above the range high", () => {
    const r = detectActiveRange(BARS, 70);
    expect(r!.pctInRange).toBe(1);
  });

  it("pctInRange is clamped to [0, 1] when price is below the range low", () => {
    const r = detectActiveRange(BARS, 30);
    expect(r!.pctInRange).toBe(0);
  });
});

// ─── Escape bar stops walk-back ────────────────────────────────────────────────

describe("detectActiveRange — escape bar stops the walk-back", () => {
  /**
   * Series:
   *   warmup(0-14) → ATR≈2, threshold≈6
   *   bar15: escapeBar (H=55 L=45 range=10 > threshold) — structural boundary
   *   bar16: spikeBar H=53 L=52.5 range=0.5 — between escape and newest; included
   *          (H=53 stays near base price 50 to avoid gap-inflating the ATR)
   *   bar17: flat  ← newest closed
   *   bar18: forming
   *
   * Walking backward from bar17:
   *   bar16 range=0.5 ≤ threshold → include (walkCount=2, envHigh=53)
   *   bar15 range=10 > threshold → STOP
   *
   * Expected: high=53 (bar16), bars=2 (bar17+bar16), ageOfHigh=1
   *
   * Note: spike prices must stay close to the base (~50) so the gap-based
   * TRUE RANGE of adjacent bars does not inflate the ATR beyond 10/3, which
   * would suppress the escape. With H=53 (gap of 3 from C=50 of escapeBar),
   * the ATR at newest-closed is ≈2.7 → threshold≈8.1 < 10 → escape fires.
   */
  const BARS_BEYOND_ESCAPE: OHLCV[] = [
    ...warmup(),                      // t=0..14
    escapeBar(15),                    // ESCAPE — range=10 → structural boundary
    spikeBar(16, 53, 52.5),           // H=53 — between escape and newest; included
    flatBar(17),                      // newest closed
    flatBar(18),                      // FORMING
  ];

  it("stops walk-back at the escape bar and does not include it", () => {
    const r = detectActiveRange(BARS_BEYOND_ESCAPE, 50);
    expect(r).not.toBeNull();
    // Only bar17 and bar16 are included — bar15 triggers escape
    expect(r!.bars).toBe(2);
  });

  it("includes the bar immediately before the escape bar", () => {
    // bar16 (H=53) is included; the escape is bar15 (range=10 > threshold)
    const r = detectActiveRange(BARS_BEYOND_ESCAPE, 50);
    expect(r!.high).toBeCloseTo(53, 4);
    expect(r!.ageOfHigh).toBe(1); // bar16 is 1 bar back from bar17
  });

  it("escape bar immediately adjacent to newest-closed → bars=1", () => {
    // bar16=escape, bar17=newest-closed (forming=bar18)
    const bars: OHLCV[] = [
      ...warmup(),
      escapeBar(15),  // escape — NOT reached (walk starts at bar17 and immediately hits bar16)
      escapeBar(16),  // escape — FIRST bar walked into → stops immediately
      flatBar(17),    // newest closed
      flatBar(18),    // FORMING
    ];
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(1); // only bar17 (newest closed)
    // single-bar range: high=51, low=49 (not degenerate)
    expect(r!.high).toBeCloseTo(51, 4);
    expect(r!.low).toBeCloseTo(49, 4);
  });

  it("warmup bars themselves do not escape (range=2 < threshold≈6)", () => {
    // No escape bar inserted — walk-back should traverse all warmup bars
    const bars: OHLCV[] = [
      ...warmup(),
      flatBar(15),  // newest closed
      flatBar(16),  // FORMING
    ];
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
    // All 16 closed bars (15 warmup + bar15) included
    expect(r!.bars).toBe(16);
  });
});

// ─── ageOfHigh / ageOfLow accuracy ────────────────────────────────────────────

describe("detectActiveRange — ageOfHigh and ageOfLow accuracy", () => {
  /**
   * Series:
   *   warmup (0-14)
   *   bar15: spikeBar H=65 L=49 range=16 > threshold=6 → ESCAPE barrier
   *   bar16: spikeBar H=63 L=62.5 range=0.5 — the range high (4 bars back from bar20)
   *   bar17: flat
   *   bar18: spikeBar H=49.5 L=43 range=6.5 > threshold → ESCAPE; so this stops walk-back
   *
   * Hmm, let me redesign so the escape is clean.
   *
   * Revised design:
   *   warmup(0-14)
   *   bar15: escapeBar (range=10 > 6) — stops walk-back at bar15
   *   bar16: spikeBar H=63 L=62.5 range=0.5 (included, 3 bars back from bar19)
   *   bar17: spikeBar H=49.5 L=43 range=6.5? No, I want a low spike here
   *
   * Let me use a cleaner approach:
   *   warmup(0-14) → ATR≈2, threshold≈6
   *   bar15: escapeBar — range=10 > 6, STOPS here (not included)
   *   bar16: spikeBar H=63 L=62.5 range=0.5 — HIGH SPIKE (included, ageOfHigh = bars back from newest)
   *   bar17: spikeBar H=49.5 L=41 range=8.5 ... that's > 6, bad
   *   bar17: spikeBar H=49.5 L=46 range=3.5 — LOW SPIKE (included, ageOfLow = bars back from newest)
   *   bar18: flat (newest closed)
   *   bar19: forming
   *
   * Walk from bar18: bar17(range=3.5≤6)→include, bar16(range=0.5≤6)→include, bar15(range=10>6)→STOP
   * bars=3 (bar18, bar17, bar16)
   * envHigh=63 (bar16, 2 bars back), ageOfHigh=2
   * envLow=46 (bar17, 1 bar back), ageOfLow=1
   */
  // Note: H=53 (not H=63) keeps the gap from C=50 small → TR≈3 → ATR stays low
  // → threshold ≈ 8, well below the escapeBar's H-L=10, so the escape fires.
  // H=63 would give TR=13 at bar16, pushing ATR to ~3.3, threshold to ~9.9, which
  // is > 10 and would suppress the escape, causing the walk to include all bars.
  const BARS: OHLCV[] = [
    ...warmup(),                        // t=0..14
    escapeBar(15),                      // range=10 → STOP (not included)
    spikeBar(16, 53, 52.5),             // range=0.5 → HIGH SPIKE (ageOfHigh=2)
    spikeBar(17, 50.5, 47),             // range=3.5 → LOW SPIKE (ageOfLow=1)
    flatBar(18),                        // newest closed (ageOf*=0 for starting bar)
    flatBar(19),                        // FORMING
  ];

  it("ageOfHigh reflects bars back from newest-closed to the spike bar", () => {
    const r = detectActiveRange(BARS, 50);
    expect(r).not.toBeNull();
    expect(r!.ageOfHigh).toBe(2); // bar16 is 2 bars back from bar18
    expect(r!.high).toBeCloseTo(53, 4);
  });

  it("ageOfLow reflects bars back from newest-closed to the low spike", () => {
    const r = detectActiveRange(BARS, 50);
    expect(r!.ageOfLow).toBe(1); // bar17 is 1 bar back from bar18
    expect(r!.low).toBeCloseTo(47, 4);
  });

  it("ageOfHigh=0 when the newest-closed bar itself is the range high", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      flatBar(15),
      spikeBar(16, 70, 69.5), // newest closed — RANGE HIGH
      flatBar(17),             // FORMING
    ];
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
    expect(r!.high).toBeCloseTo(70, 4);
    expect(r!.ageOfHigh).toBe(0);
  });

  it("ageOfLow=0 when the newest-closed bar itself is the range low", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      flatBar(15),
      spikeBar(16, 51, 40), // newest closed — RANGE LOW (range=11>6, escape? No: 11>6 → escape stops IMMEDIATELY)
      flatBar(17),          // FORMING
    ];
    // bar16 range = 51-40 = 11 > threshold≈6 → it IS the start bar (newest closed), not walked-into
    // Starting bar is always included (no escape check on it). envHigh=51, envLow=40.
    // Walk back to bar15: range=2 ≤ 6 → include (envHigh stays 51, envLow=40)
    // Walk back through warmup: include
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
    // The starting bar (bar16) has L=40, so ageOfLow should be 0
    expect(r!.ageOfLow).toBe(0);
    expect(r!.low).toBeCloseTo(40, 4);
  });
});

// ─── AAVE-like fixture: single-touch high captured, single-touch filtered ──────

describe("detectActiveRange — AAVE-like: single-touch high in range", () => {
  /**
   * This fixture reproduces the Phase 0 AAVE diagnosis:
   *   "The 91.78 high was a real price boundary but FAILED htf-levels' minTouches=2
   *    gate because it was a lone spike. detectActiveRange captures it as the raw
   *    range high without requiring any touch credentials."
   *
   * Setup:
   *   warmup(0-14) → ATR≈2, threshold≈6
   *   bar15: escapeBar — range=10 > 6 → hard stop (simulates descent-from-peak)
   *   bar16: spikeBar H=59 L=58.6 range=0.4 (LONE high — only 1 bar at this level)
   *   bar17: flat
   *   bar18: flat
   *   bar19: flat (newest closed)
   *   bar20: FORMING
   *
   * Walk from bar19: bar18→bar17→bar16(envHigh=59)→bar15(escape→STOP)
   * Active range: high=59 (from bar16, ageOfHigh=3), low=49 (from bar19/18/17, ageOfLow=0)
   *
   * Cross-reference with htf-levels: if we ran detectHTFLevels on the same series,
   * bar16's lone high (touchCount=1) would be EXCLUDED by minTouches=2.
   * detectActiveRange surfaces it unconditionally as the raw range high.
   */
  const BARS: OHLCV[] = [
    ...warmup(),                     // t=0..14
    escapeBar(15),                   // ESCAPE — range=10 > 6 (simulates descent-from-peak)
    spikeBar(16, 59, 58.6),          // LONE HIGH — range=0.4 within threshold
    flatBar(17),
    flatBar(18),
    flatBar(19),                     // newest closed
    flatBar(20),                     // FORMING
  ];

  it("captures the lone high spike as range.high (no fractal/touch gate applied)", () => {
    const r = detectActiveRange(BARS, 50);
    expect(r).not.toBeNull();
    expect(r!.high).toBeCloseTo(59, 4);
  });

  it("ageOfHigh correctly points to the spike bar", () => {
    const r = detectActiveRange(BARS, 50);
    // bar19=newest(age 0), bar18(1), bar17(2), bar16=spike(3)
    expect(r!.ageOfHigh).toBe(3);
  });

  it("does not walk through the escape bar into older irrelevant structure", () => {
    const r = detectActiveRange(BARS, 50);
    // bars=4 (bar19+bar18+bar17+bar16); escape at bar15 stops it
    expect(r!.bars).toBe(4);
  });

  it("price at 62% of range when price is in the upper portion", () => {
    // range: low=49, high=59 → width=10
    // price=55.2 → pct=(55.2-49)/10=0.62
    const r = detectActiveRange(BARS, 55.2);
    expect(r!.pctInRange).toBeCloseTo(0.62, 2);
  });
});

// ─── Cap at capBars ────────────────────────────────────────────────────────────

describe("detectActiveRange — capBars limits walk-back depth", () => {
  it("stops at capBars even without an escape bar", () => {
    // Build a long quiet series with no escape bar (all range=2 ≤ 6)
    const bars: OHLCV[] = [
      ...Array.from({ length: 30 }, (_, i) => flatBar(i)), // 30 quiet bars
      flatBar(30), // FORMING
    ];
    // capBars=10 → only 10 bars from the newest closed
    const r = detectActiveRange(bars, 50, 3, 10);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(10);
  });

  it("when capBars equals available closed bars, uses them all", () => {
    // 20 quiet bars + forming = 21 total; capBars=19 → 19 closed bars
    const bars: OHLCV[] = [
      ...Array.from({ length: 20 }, (_, i) => flatBar(i)),
      flatBar(20), // FORMING
    ];
    const r = detectActiveRange(bars, 50, 3, 19);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(19);
  });
});

// ─── Custom k values ───────────────────────────────────────────────────────────

describe("detectActiveRange — custom k parameter", () => {
  /**
   * Use a borderline bar: spikeBar(16, 55, 43) range=12.
   * With ATR≈2: threshold = k * 2.
   *   k=3 → threshold=6  → 12>6 → ESCAPE
   *   k=7 → threshold=14 → 12<14 → INCLUDE
   */
  const BARS_WITH_BORDERLINE: OHLCV[] = [
    ...warmup(),
    spikeBar(15, 55, 43),   // range=12 — borderline escape depending on k
    flatBar(16),             // newest closed
    flatBar(17),             // FORMING
  ];

  it("k=3 (default): bar with range=12 triggers escape → bars=1", () => {
    const r = detectActiveRange(BARS_WITH_BORDERLINE, 50, 3);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(1); // escape at bar15, only bar16 included
  });

  it("k=7: bar with range=12 does NOT trigger escape → bar is included", () => {
    const r = detectActiveRange(BARS_WITH_BORDERLINE, 50, 7);
    expect(r).not.toBeNull();
    expect(r!.bars).toBeGreaterThan(1); // bar15 included → more than just bar16
    expect(r!.high).toBeCloseTo(55, 4); // spike high captured
  });
});

// ─── Edge / guard cases ────────────────────────────────────────────────────────

describe("detectActiveRange — edge and guard cases", () => {
  it("returns null when fewer than 14 closed bars (ATR warmup not met)", () => {
    // 13 closed bars + forming = 14 total → len=13 < 14 → null
    const bars = Array.from({ length: 14 }, (_, i) => flatBar(i));
    const r = detectActiveRange(bars, 50);
    expect(r).toBeNull();
  });

  it("returns non-null with exactly 14 closed bars (minimum valid)", () => {
    // 14 closed bars + forming = 15 total → len=14, ATR seeded with SMA
    const bars = Array.from({ length: 15 }, (_, i) => flatBar(i));
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
  });

  it("returns null for a degenerate range (high === low on all bars)", () => {
    // All bars perfectly flat: high=50, low=50, range=0 → rangeWidth=0 → null
    const bars = Array.from({ length: 15 }, (_, i) => ({
      time: i * MS, open: 50, high: 50, low: 50, close: 50, volume: 1_000,
    }));
    const r = detectActiveRange(bars, 50);
    // ATR would be 0 (range=0) → atr14<=0 → null
    expect(r).toBeNull();
  });

  it("handles a series with only the newest-closed bar after warmup (bars=1)", () => {
    // warmup(0-14) → escapeBar(15) → flatBar(16) → flatBar(17, forming)
    // newest closed=bar16; walk back: bar15(range=10>6)→STOP → bars=1
    const bars: OHLCV[] = [
      ...warmup(),
      escapeBar(15),
      flatBar(16),  // newest closed
      flatBar(17),  // FORMING
    ];
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(1);
    expect(r!.high).toBeCloseTo(51, 4);
    expect(r!.low).toBeCloseTo(49, 4);
    expect(r!.ageOfHigh).toBe(0);
    expect(r!.ageOfLow).toBe(0);
  });

  it("ageOfHigh and ageOfLow are both 0 for a 1-bar range", () => {
    const bars: OHLCV[] = [
      ...warmup(),
      escapeBar(15),
      flatBar(16),  // newest closed
      flatBar(17),  // FORMING
    ];
    const r = detectActiveRange(bars, 50);
    expect(r!.ageOfHigh).toBe(0);
    expect(r!.ageOfLow).toBe(0);
  });

  it("does not throw on a large series (400-bar series + forming)", () => {
    const bars = [
      ...Array.from({ length: 400 }, (_, i) => flatBar(i)),
      flatBar(400), // FORMING
    ];
    expect(() => detectActiveRange(bars, 50)).not.toThrow();
    const r = detectActiveRange(bars, 50);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(400); // full walk-back, no escape
  });
});

// ─── Low-escape symmetry ───────────────────────────────────────────────────────

describe("detectActiveRange — low spike is captured symmetrically", () => {
  /**
   * Mirror of the spike-high test: a lone below-range low should appear as range.low.
   *
   * Series:
   *   warmup(0-14)
   *   bar15: spikeBar H=51 L=38 range=13 > threshold=6 → ESCAPE (bars before this not included)
   *   bar16: spikeBar H=51 L=40 range=11 > threshold → ESCAPE too — stops immediately
   *
   * Let me use a within-threshold low spike instead:
   *   bar15: escapeBar (structural escape)
   *   bar16: spikeBar H=51 L=41 range=10 > threshold → ESCAPE too
   *
   * Cleaner design: escapeBar at bar15, spikeBar(16) with range ≤ 6 for the low:
   *   bar16: spikeBar H=50 L=44.5 range=5.5 ≤ 6 → WITHIN threshold, LOW=44.5
   */
  const BARS: OHLCV[] = [
    ...warmup(),                     // t=0..14
    escapeBar(15),                   // ESCAPE → structural boundary
    spikeBar(16, 50, 44.5),          // LOW SPIKE (range=5.5 ≤ 6, within threshold)
    flatBar(17),                     // newest closed
    flatBar(18),                     // FORMING
  ];

  it("captures the lone low spike as range.low", () => {
    const r = detectActiveRange(BARS, 50);
    expect(r).not.toBeNull();
    expect(r!.low).toBeCloseTo(44.5, 4);
  });

  it("ageOfLow points to the low-spike bar", () => {
    // bar17=newest(0), bar16=low spike(1)
    const r = detectActiveRange(BARS, 50);
    expect(r!.ageOfLow).toBe(1);
  });
});
