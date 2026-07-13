// Brick 3, Phase 3A fixture tests: server/ai-trader/wm-detector.ts
//
// All tests use n=1 (smallest fractal, easiest to construct fixtures for).
// This matches the htf-levels test convention and keeps fixtures small (<50 bars).
//
// Bar fixture convention (n=1 pivot rules):
//   flatBar(t)         → neutral bar:   H=52 L=48 C=50 V=1000  TR=4
//   spikeLow(t,price)  → swing-low:     H=52 L=price C=50 V=1000
//   spikeHigh(t,price) → swing-high:    H=price L=48 C=50 V=1000
//   forming(t,close)   → forming bar:   H=52 L=48 C=close V=1000
//   bigBar(t)          → large-ATR bar: H=250 L=-150 C=50 V=1000  TR≈400
//
// n=1 pivot rule: bar[i].high must strictly exceed bar[i-1].high AND bar[i+1].high,
// meaning every spikeHigh/spikeLow needs at least one flatBar on each side.
//
// ATR convention: after 20 consecutive flatBars (TR=4), ATR(14) ≈ 4.
// bigBars produce TR≈400; after 20 bigBars, ATR≈400 (Wilder's SMA then RMA).
// Consecutive bigBars have equal H=250 (strict > fails) → no spurious pivots.
//
// ─── Textbook W fixture ──────────────────────────────────────────────────────
//   bars[0-19]  20 flatBars  ATR→4
//   bars[20]    flatBar       left buffer for extreme1
//   bars[21]    spikeLow(44)  extreme1 (closed-bar idx=21)
//   bars[22]    flatBar       right buffer / gap
//   bars[23-30] flatBars      gap filler (8 bars)
//   bars[31]    flatBar       left buffer for neckline
//   bars[32]    spikeHigh(55.5) neckline (idx=32)
//   bars[33]    flatBar       right buffer / left buffer for extreme2
//   bars[34]    spikeLow(44.5) extreme2 (idx=34)  barSep=13 ✓
//   bars[35]    flatBar       right buffer
//   bars[36]    forming(55.6)  0.18% from neckline ✓  ← forming bar
//
//   ZigZag: low@21 · high@32 · low@34
//   extremeDelta=0.5  ATR≈4  threshold=1.0   0.5 ≤ 1.0 ✓
//   patternHeight=11.5  RETRACE_MIN=0.30×4=1.2  11.5 ≥ 1.2 ✓
//   barSep=13  ∈ [10,60] ✓
//
// ─── Textbook M fixture ──────────────────────────────────────────────────────
//   Same layout, extremes are swing HIGHS, neckline is a swing LOW:
//   bars[21]    spikeHigh(56)   extreme1 (idx=21)
//   bars[32]    spikeLow(44.5)  neckline (idx=32)
//   bars[34]    spikeHigh(55.8) extreme2 (idx=34)  barSep=13 ✓
//   bars[36]    forming(44.6)   0.22% from neckline ✓

import { describe, it, expect } from "vitest";
import type { OHLCV } from "../../server/lab/engine";
import {
  detectWM,
  MIN_BAR_SEP,
  MAX_BAR_SEP,
  EXTREME_ATR_MULT,
  RETRACE_MIN_FRAC,
  NECKLINE_WINDOW,
  MAX_PATTERN_AGE_BARS,
} from "../../server/ai-trader/wm-detector";

// ─── Bar helpers ──────────────────────────────────────────────────────────────

const MS = 60_000;

function flatBar(t: number): OHLCV {
  return { time: t * MS, open: 50, high: 52, low: 48, close: 50, volume: 1_000 };
}
function spikeLow(t: number, price: number, volume = 1_000): OHLCV {
  return { time: t * MS, open: 50, high: 52, low: price, close: 50, volume };
}
function spikeHigh(t: number, price: number, volume = 1_000): OHLCV {
  return { time: t * MS, open: 50, high: price, low: 48, close: 50, volume };
}
function forming(t: number, close: number): OHLCV {
  return { time: t * MS, open: 50, high: 52, low: 48, close, volume: 1_000 };
}
/** Large-range bar: TR≈400. 20 consecutive bigBars give ATR≈400 via Wilder's RMA.
 *  Consecutive bigBars have equal high=250, so strict inequality prevents them
 *  from becoming spurious swing-high pivots. */
function bigBar(t: number): OHLCV {
  return { time: t * MS, open: 50, high: 250, low: -150, close: 50, volume: 1_000 };
}

/** 20 flat-bar warmup: after bar 13, ATR(14) converges to ≈4 and stays there. */
function warmup(): OHLCV[] {
  return Array.from({ length: 20 }, (_, i) => flatBar(i));
}

/** Standard textbook-W bar array. extreme2 at idx=34, neckline at idx=32, barSep=13. */
function textbookW(opts: {
  extreme1Price?: number;
  extreme2Price?: number;
  necklinePrice?: number;
  formingClose?: number;
  extreme1Volume?: number;
  extreme2Volume?: number;
} = {}): OHLCV[] {
  const e1p = opts.extreme1Price ?? 44;
  const e2p = opts.extreme2Price ?? 44.5;
  const nk  = opts.necklinePrice ?? 55.5;
  const fc  = opts.formingClose  ?? 55.6;
  const v1  = opts.extreme1Volume ?? 1_000;
  const v2  = opts.extreme2Volume ?? 1_000;
  return [
    ...warmup(),                      // 0-19: ATR→4
    flatBar(20),                      // left buffer for extreme1
    spikeLow(21, e1p, v1),            // extreme1 (idx=21)
    flatBar(22),
    flatBar(23), flatBar(24), flatBar(25), flatBar(26),
    flatBar(27), flatBar(28), flatBar(29), flatBar(30),
    flatBar(31),                      // left buffer for neckline
    spikeHigh(32, nk),                // neckline (idx=32)
    flatBar(33),                      // right buffer / left buffer for extreme2
    spikeLow(34, e2p, v2),            // extreme2 (idx=34) — barSep=34-21=13
    flatBar(35),                      // right buffer
    forming(36, fc),                  // FORMING: close near neckline
  ];
}

/** Standard textbook-M bar array. Mirrors textbook-W with highs↔lows. */
function textbookM(opts: {
  extreme1Price?: number;
  extreme2Price?: number;
  necklinePrice?: number;
  formingClose?: number;
  extreme1Volume?: number;
  extreme2Volume?: number;
} = {}): OHLCV[] {
  const e1p = opts.extreme1Price ?? 56;
  const e2p = opts.extreme2Price ?? 55.8;
  const nk  = opts.necklinePrice ?? 44.5;
  const fc  = opts.formingClose  ?? 44.6;
  const v1  = opts.extreme1Volume ?? 1_000;
  const v2  = opts.extreme2Volume ?? 1_000;
  return [
    ...warmup(),                      // 0-19
    flatBar(20),                      // left buffer
    spikeHigh(21, e1p, v1),           // extreme1 (idx=21)
    flatBar(22),
    flatBar(23), flatBar(24), flatBar(25), flatBar(26),
    flatBar(27), flatBar(28), flatBar(29), flatBar(30),
    flatBar(31),                      // left buffer for neckline
    spikeLow(32, nk),                 // neckline (idx=32)
    flatBar(33),
    spikeHigh(34, e2p, v2),           // extreme2 (idx=34) — barSep=13
    flatBar(35),
    forming(36, fc),                  // FORMING: close near neckline
  ];
}

// ─── Textbook detections ──────────────────────────────────────────────────────

describe("wm-detector — textbook detections", () => {
  it("detects a textbook W (double bottom) with correct field values", () => {
    const bars = textbookW();
    const result = detectWM(bars, { n: 1 });

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");

    expect(result.type).toBe("W");

    // Extremes
    expect(result.extreme1.price).toBe(44);
    expect(result.extreme1.index).toBe(21);
    expect(result.extreme2.price).toBe(44.5);
    expect(result.extreme2.index).toBe(34);
    expect(result.barSeparation).toBe(13);

    // Neckline
    expect(result.neckline.price).toBe(55.5);
    expect(result.neckline.index).toBe(32);

    // Pattern height: neckline - min(44, 44.5) = 55.5 - 44 = 11.5
    expect(result.patternHeight).toBeCloseTo(11.5, 5);

    // Delta ATR: |44 - 44.5| / atr14 = 0.5 / atr14
    expect(result.atr14).toBeGreaterThan(0);
    expect(result.deltaAtr).toBeCloseTo(0.5 / result.atr14, 5);
    // extremes are well within EXTREME_ATR_MULT threshold
    expect(result.deltaAtr).toBeLessThan(EXTREME_ATR_MULT);

    // Actionability: (55.6 - 55.5) / 55.5 ≈ 0.0018
    expect(Math.abs(result.currentPriceDistFromNeckline)).toBeLessThan(NECKLINE_WINDOW);
    expect(result.currentPriceDistFromNeckline).toBeCloseTo(0.1 / 55.5, 5);

    // Volume: same volume (1000 ≤ 1000 → true)
    expect(result.secondExtremeVolumeLower).toBe(true);
  });

  it("detects a textbook M (double top) with correct field values", () => {
    const bars = textbookM();
    const result = detectWM(bars, { n: 1 });

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");

    expect(result.type).toBe("M");

    expect(result.extreme1.price).toBe(56);
    expect(result.extreme1.index).toBe(21);
    expect(result.extreme2.price).toBe(55.8);
    expect(result.extreme2.index).toBe(34);
    expect(result.barSeparation).toBe(13);

    expect(result.neckline.price).toBe(44.5);
    expect(result.neckline.index).toBe(32);

    // Pattern height for M: max(56,55.8) - 44.5 = 56 - 44.5 = 11.5
    expect(result.patternHeight).toBeCloseTo(11.5, 5);

    // Actionability: (44.6 - 44.5) / 44.5 ≈ 0.00225
    expect(Math.abs(result.currentPriceDistFromNeckline)).toBeLessThan(NECKLINE_WINDOW);

    expect(result.secondExtremeVolumeLower).toBe(true); // 1000 ≤ 1000
  });

  it("reports secondExtremeVolumeLower=true when second extreme volume < first", () => {
    const bars = textbookW({ extreme1Volume: 2_000, extreme2Volume: 800 });
    const result = detectWM(bars, { n: 1 });
    expect(result).not.toBeNull();
    expect(result!.secondExtremeVolumeLower).toBe(true);
    expect(result!.extreme1.volume).toBe(2_000);
    expect(result!.extreme2.volume).toBe(800);
  });

  it("reports secondExtremeVolumeLower=false when second extreme volume > first", () => {
    const bars = textbookW({ extreme1Volume: 800, extreme2Volume: 2_000 });
    const result = detectWM(bars, { n: 1 });
    expect(result).not.toBeNull();
    expect(result!.secondExtremeVolumeLower).toBe(false);
  });

  it("returns the most recent qualifying pattern when multiple triplets qualify", () => {
    // Two qualifying W patterns in the same window: the detector returns the newest.
    // Older W: extremes at indices 21/34 (same as textbook), neckline@32.
    // Newer W: extremes at indices 47/60, neckline@58.
    // Current price (forming bar close) must be near the NEWEST neckline.
    const bars: OHLCV[] = [
      ...warmup(),                   // 0-19
      flatBar(20),
      spikeLow(21, 44),              // older extreme1
      flatBar(22),
      ...Array.from({ length: 9 }, (_, i) => flatBar(23 + i)),
      spikeHigh(32, 55.5),           // older neckline
      flatBar(33),
      spikeLow(34, 44.5),            // older extreme2  (barSep=13)
      flatBar(35),
      ...Array.from({ length: 10 }, (_, i) => flatBar(36 + i)),
      flatBar(46),                   // left buffer for newer extreme1
      spikeLow(47, 44.2),            // newer extreme1
      flatBar(48),
      ...Array.from({ length: 8 }, (_, i) => flatBar(49 + i)),
      spikeHigh(57, 55.3),           // newer neckline — price here is the actionable level
      flatBar(58),                   // right buffer
      // Note: spikeHigh is at 57 (with n=1 left=flat@56 H=52<55.3 ✓, right=flat@58 H=52<55.3 ✓)
      spikeLow(59, 44.3),            // newer extreme2 (barSep=59-47=12 ✓)
      flatBar(60),
      forming(61, 55.4),             // forming: 0.18% above newer neckline 55.3
    ];
    const result = detectWM(bars, { n: 1 });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    // Most recent qualifying pattern: extremes at 47/59 with neckline at 57.
    expect(result.extreme1.index).toBe(47);
    expect(result.extreme2.index).toBe(59);
    expect(result.neckline.index).toBe(57);
    expect(result.type).toBe("W");
  });
});

// ─── Near-miss table ─────────────────────────────────────────────────────────
//
// Each test fails exactly ONE criterion; all others pass.
// This encodes the founder's overfit complaint: a detector that admits partial
// patterns produces noise; the strict all-or-nothing gate must be verified
// criterion by criterion.

describe("wm-detector — near-miss table (each failing criterion yields null)", () => {
  it("null when barSep=9 (< MIN_BAR_SEP=10) — one bar short of the minimum", () => {
    // Textbook-W layout but extreme2 moved to barSep=9 from extreme1.
    // Neckline at idx=23 (2 bars after extreme1@21), extreme2 at idx=30 (barSep=9).
    // All other criteria pass.
    const bars: OHLCV[] = [
      ...warmup(),           // 0-19
      flatBar(20),           // left buffer
      spikeLow(21, 44),      // extreme1 (idx=21)
      flatBar(22),
      spikeHigh(23, 55.5),   // neckline (idx=23)
      flatBar(24),
      flatBar(25), flatBar(26), flatBar(27), flatBar(28), flatBar(29),
      spikeLow(30, 44.5),    // extreme2 (idx=30)  barSep=30-21=9 < 10 → FAIL
      flatBar(31),
      forming(32, 55.6),     // forming near neckline ✓
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when barSep=61 (> MAX_BAR_SEP=60) — one bar past the maximum", () => {
    // Neckline at idx=23, extreme2 at idx=82 (barSep=82-21=61 > 60).
    // Intervening bars are all flat → no spurious pivots (strict > prevents equal-H pivots).
    // All other criteria pass.
    const bars: OHLCV[] = [
      ...warmup(),           // 0-19
      flatBar(20),
      spikeLow(21, 44),      // extreme1 (idx=21)
      flatBar(22),
      spikeHigh(23, 55.5),   // neckline (idx=23)
      ...Array.from({ length: 58 }, (_, i) => flatBar(24 + i)),   // 58 flat bars
      spikeLow(82, 44.5),    // extreme2 (idx=82)  barSep=82-21=61 > 60 → FAIL
      flatBar(83),
      forming(84, 55.6),
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when extremes are too far apart (extremeDelta > EXTREME_ATR_MULT × ATR)", () => {
    // Standard layout (ATR≈4, threshold=0.25×4=1.0) but extreme2 price=45.5.
    // extremeDelta=|44-45.5|=1.5 > 1.0 → FAIL.
    // patternHeight=55.5-44=11.5 >> 1.2 ✓, barSep=13 ✓, actionability ✓.
    const bars = textbookW({ extreme2Price: 45.5 });
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when patternHeight < RETRACE_MIN_FRAC × ATR (retrace too small)", () => {
    // Large-ATR warmup: 20 bigBars (TR≈400) drive ATR≈124 at the pattern area.
    // patternHeight = 55.5 - 44 = 11.5; RETRACE_MIN_FRAC × 124 ≈ 37 >> 11.5 → FAIL.
    // All other criteria pass (extremeDelta=0.5 << 0.25×124=31 ✓, barSep=13 ✓,
    // actionability 0.18% ✓). Big bars have H=250 so standard flat pivots still
    // detected normally (n=1 only checks immediate neighbors, which are flatBars).
    const bars: OHLCV[] = [
      ...Array.from({ length: 20 }, (_, i) => bigBar(i)),  // large-ATR warmup
      flatBar(20),
      spikeLow(21, 44),            // extreme1
      flatBar(22),
      flatBar(23), flatBar(24), flatBar(25), flatBar(26),
      flatBar(27), flatBar(28), flatBar(29), flatBar(30),
      flatBar(31),
      spikeHigh(32, 55.5),         // neckline
      flatBar(33),
      spikeLow(34, 44.5),          // extreme2  barSep=13
      flatBar(35),
      forming(36, 55.6),
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when current price is 1.1% from neckline (outside NECKLINE_WINDOW=0.5%)", () => {
    // Standard textbook-W but forming close = 55.5 × 1.011 ≈ 56.11 (1.1% above neckline).
    // Math.abs((56.11 - 55.5) / 55.5) ≈ 1.10% > 1% → FAIL.
    // All other criteria identical to textbook-W → pass.
    const bars = textbookW({ formingClose: 56.12 });
    // Verify 1.1% distance explicitly.
    expect(Math.abs((56.12 - 55.5) / 55.5)).toBeGreaterThan(NECKLINE_WINDOW);
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("detects when current price is 0.49% from neckline (inside NECKLINE_WINDOW=0.5%)", () => {
    // Locks in the new 0.5% boundary: close = 55.5 × 1.0049 ≈ 55.77 → 0.487% above neckline.
    // dist = (55.77 − 55.5) / 55.5 ≈ 0.00486 < NECKLINE_WINDOW (0.005) → detects.
    const bars = textbookW({ formingClose: 55.77 });
    expect(Math.abs((55.77 - 55.5) / 55.5)).toBeLessThan(NECKLINE_WINDOW);
    expect(detectWM(bars, { n: 1 })).not.toBeNull();
  });

  it("null when current price is 0.51% from neckline (outside NECKLINE_WINDOW=0.5%)", () => {
    // Just outside the new 0.5% boundary: close = 55.5 × 1.0051 ≈ 55.78 → 0.505% above neckline.
    // dist = (55.78 − 55.5) / 55.5 ≈ 0.00505 > NECKLINE_WINDOW (0.005) → null.
    const bars = textbookW({ formingClose: 55.78 });
    expect(Math.abs((55.78 - 55.5) / 55.5)).toBeGreaterThan(NECKLINE_WINDOW);
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });
});

// ─── Noisy-chop fixtures (zero detections across the whole window) ─────────────

describe("wm-detector — noisy chop (zero detections required)", () => {
  it("null for a pure flat series (no pivots → pivots.length < 3)", () => {
    // 40 identical flatBars + forming. No bar is ever a swing extreme (strict >
    // requires exceeding neighbors; equal neighbors are not pivots).
    const bars: OHLCV[] = [
      ...Array.from({ length: 40 }, (_, i) => flatBar(i)),
      forming(40, 50),
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when many W-shaped triplets exist but current price is far from every neckline", () => {
    // Three W-shaped pivot triplets (all other criteria pass), but the forming bar
    // closes at 50, which is ~9.9% below every neckline (55.5). The actionability
    // criterion eliminates all candidates.
    // W triplets: lows at ~44, highs (necklines) at 55.5, barSeps ≥ 13.
    // Forming close = 50 → |50-55.5|/55.5 ≈ 9.9% >> 1% → null.
    const bars: OHLCV[] = [
      ...warmup(),               // 0-19
      flatBar(20),
      spikeLow(21, 44),          // low pivot
      flatBar(22), flatBar(23), flatBar(24), flatBar(25),
      flatBar(26), flatBar(27), flatBar(28), flatBar(29), flatBar(30), flatBar(31),
      spikeHigh(32, 55.5),       // neckline #1
      flatBar(33),
      spikeLow(34, 44.3),        // low pivot  (W triplet: barSep=34-21=13)
      flatBar(35), flatBar(36), flatBar(37), flatBar(38), flatBar(39), flatBar(40),
      flatBar(41), flatBar(42), flatBar(43), flatBar(44), flatBar(45), flatBar(46),
      spikeHigh(47, 55.5),       // neckline #2
      flatBar(48),
      spikeLow(49, 44.1),        // low pivot  (W triplet: barSep=49-34=15)
      flatBar(50), flatBar(51), flatBar(52), flatBar(53), flatBar(54), flatBar(55),
      flatBar(56), flatBar(57), flatBar(58), flatBar(59), flatBar(60), flatBar(61),
      spikeHigh(62, 55.5),       // neckline #3
      flatBar(63),
      spikeLow(64, 44.2),        // low pivot  (W triplet: barSep=64-49=15)
      flatBar(65),
      forming(66, 50),           // FORMING: close=50 → 9.9% from every neckline → null
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when zigzag pitch is too tight (all barSeps < MIN_BAR_SEP=10)", () => {
    // Alternating spikeLow / spikeHigh with pitch=5. Same-side separation=5 < 10 → null.
    // No consecutive same-side pivots are ever 10 bars apart.
    // warmup + [spikeLow, flat, flat, flat, spikeHigh, flat, flat, flat, spikeLow ...] × 5
    const tightZigzag: OHLCV[] = [...warmup()];  // 0-19
    let t = 20;
    // Repeat 5× to generate many triplets — none with barSep ≥ 10.
    for (let rep = 0; rep < 5; rep++) {
      tightZigzag.push(spikeLow(t,   44));     // low
      tightZigzag.push(flatBar(t+1));           // buffer
      tightZigzag.push(flatBar(t+2));
      tightZigzag.push(spikeHigh(t+3, 55.5));  // high
      tightZigzag.push(flatBar(t+4));
      t += 5;
    }
    // Same-side separation between consecutive lows: 5 < 10 → all fail criterion 1.
    tightZigzag.push(forming(t, 50));           // FORMING: price far from neckline anyway
    expect(detectWM(tightZigzag, { n: 1 })).toBeNull();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("wm-detector — edge cases", () => {
  it("null when bars.length < 2 (no closed bars)", () => {
    expect(detectWM([], { n: 1 })).toBeNull();
    expect(detectWM([flatBar(0)], { n: 1 })).toBeNull();
  });

  it("null when fewer than 14 closed bars (ATR cannot be computed)", () => {
    // Only 13 closed bars + forming. ATR(14) requires 14 closed bars for even the SMA seed.
    const bars: OHLCV[] = [
      ...Array.from({ length: 13 }, (_, i) => flatBar(i)),
      forming(13, 50),
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("null when fewer than 3 pivots in the ZigZag (cannot form any triplet)", () => {
    // 20 warmup flat bars + 1 single spike (only 1 pivot total) + forming.
    // The single pivot cannot form a triplet.
    const bars: OHLCV[] = [
      ...warmup(),
      spikeLow(20, 44),
      flatBar(21),
      forming(22, 50),
    ];
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });

  it("skips an outside-bar triplet (shared pivot index) deterministically", () => {
    // An outside bar at index i can produce BOTH a swing-high and a swing-low pivot
    // at the same .index (see dow-structure.ts module header + wm-detector.ts header).
    // The detector must skip any triplet where two pivots share an index.
    //
    // Construction: to get an outside bar that qualifies as BOTH, its high must strictly
    // exceed all n neighbors' highs AND its low must strictly beat all n neighbors' lows.
    // With n=1 and flatBar neighbors (H=52, L=48):
    //   bar[i].high > 52 AND bar[i].low < 48 simultaneously.
    //   outsideBar: H=60, L=40 — qualifies as both swing high AND swing low.
    //
    // To isolate the outside-bar behavior without other confounds, build a series where
    // the ONLY triplet involves the outside bar (i.e., the pivot at the outside-bar index
    // appears in at least one triplet position). The detector must return null for that
    // triplet regardless of other criteria.
    //
    // ZigZag result from: spikeLow@21, outsideBar@22 (→ high@22 · low@22), spikeLow@23:
    //   pivots: [low@21, high@22, low@22, ...]  ← high@22 and low@22 share index=22
    //   Triplet (i=0): (low@21, high@22, low@22) → p1.index===p2.index → SKIP ✓
    //   Triplet (i=1): (high@22, low@22, ...) → p0.index===p1.index → SKIP ✓
    // Neither triplet with the shared index qualifies → null.
    const outsideBar = (t: number): OHLCV =>
      ({ time: t * MS, open: 50, high: 60, low: 40, close: 50, volume: 1_000 });

    const bars: OHLCV[] = [
      ...warmup(),              // 0-19, ATR→4
      flatBar(20),              // left buffer
      spikeLow(21, 44),         // swing low at 21
      outsideBar(22),           // BOTH swing high (60) AND swing low (40) at 22
      flatBar(23),              // right buffer
      // The ZigZag will produce [low@21, high@22, low@22, ...] — shared index=22.
      // Any triplet involving idx=22 twice is skipped.
      forming(24, 55.5),
    ];
    // Regardless of whether other criteria would pass, outside-bar triplets are skipped.
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });
});

// ─── Criterion 6: recency near-misses ─────────────────────────────────────────
//
// Construct a textbook-W pattern with e2 at index 34, then extend the bar array
// with flat filler bars so that e2 sits at exactly 60 (passes) or 61 (fails)
// closed bars before the last closed bar.
//
// Fixture layout for "exactly 60 bars ago":
//   bars[0-35]   original textbookW closed bars  (e1@21, neckline@32, e2@34)
//   bars[36-94]  59 flat filler bars (t=36..94)   ← new closed bars
//   bars[95]     forming bar (close=55.6, 0.18% above neckline 55.5)
//   closed.length=95, last closed index=94
//   age of e2 = 94 − 34 = 60  ≤  MAX_PATTERN_AGE_BARS(60)  → detects ✓
//
// For "61 bars ago": add one more filler bar (60 fillers, forming at index 96).
//   age of e2 = 95 − 34 = 61  >  60  → null ✓
//
// All other criteria still hold (ATR≈4 from filler-bar window, neckline price
// unchanged, forming close 0.18% from neckline, barSep=13 ∈ [10,60]).

describe("wm-detector — criterion 6: recency near-misses", () => {
  /** Build a textbook-W array with N flat filler bars inserted between the
   *  last closed bar (index 35) and the new forming bar. */
  function textbookWAged(fillerCount: number): OHLCV[] {
    // textbookW() produces bars[0..36]: closed 0-35, forming at 36.
    // We drop the original forming bar and append fillerCount flat bars + new forming.
    const base = textbookW();                        // 37 bars
    const closed36 = base.slice(0, 36);              // indices 0-35 (closed)
    // Filler flat bars (H=52,L=48,C=50) produce no pivots with n=1 (strict > fails for
    // equal H=52 neighbors). ATR(14) computed from the last 14 closed bars (all flat,
    // TR=4) ≈ 4 — identical to the warmup period, so all five original criteria still hold.
    const fillers = Array.from({ length: fillerCount }, (_, k) => flatBar(36 + k));
    const newForming = forming(36 + fillerCount, 55.6); // 0.18% above neckline 55.5
    return [...closed36, ...fillers, newForming];
  }

  it("second extreme exactly MAX_PATTERN_AGE_BARS bars ago → detects", () => {
    // age of e2 = 60 = MAX_PATTERN_AGE_BARS → boundary passes (≤ not <)
    const bars = textbookWAged(59); // closed.length=95, last closed=94; age=94-34=60
    expect(bars.length).toBe(96);   // 36 original closed + 59 fillers + 1 forming
    const result = detectWM(bars, { n: 1 });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("W");
    expect(result?.extreme2.index).toBe(34); // e2 unchanged
    // barSeparation, neckline, and other fields are identical to textbook-W.
    expect(result?.barSeparation).toBe(13);
    expect(result?.neckline.price).toBeCloseTo(55.5);
  });

  it("second extreme MAX_PATTERN_AGE_BARS + 1 bars ago → null (stale pattern)", () => {
    // age of e2 = 61 > MAX_PATTERN_AGE_BARS → criterion 6 fails; null returned.
    const bars = textbookWAged(60); // closed.length=96, last closed=95; age=95-34=61
    expect(bars.length).toBe(97);
    expect(detectWM(bars, { n: 1 })).toBeNull();
  });
});
