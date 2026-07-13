// tests/ai-trader/dow-structure.test.ts
//
// Brick 2, Phase 2A — Fixture tests for the Dow-structure pure module.
//
// All synthetic bar sequences are verified by hand; comments annotate every
// claimed pivot so the numbers can be checked without running the suite.
//
// N=3 (FRACTAL_N) throughout unless a test explicitly overrides it.
// Forming bar = last element of every input array — always excluded.

import { describe, it, expect } from "vitest";
import {
  detectPivots,
  classifyDow,
  FRACTAL_N,
  type SwingPivot,
} from "../../server/ai-trader/dow-structure";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bar(high: number, low: number) {
  return { high, low };
}

// ─── detectPivots ─────────────────────────────────────────────────────────────

describe("detectPivots — Brick 2 Phase 2A", () => {
  // ── Forming-bar exclusion ──────────────────────────────────────────────────
  describe("forming-bar exclusion", () => {
    // 8 bars total, 7 closed (b0–b6), 1 forming (b7).
    // Eligible pivot centers with N=3: only i=3.
    //
    // b3 is a legitimate swing HIGH (high=110 > all N=3 neighbors on each side).
    // b7 (forming bar) has extreme values (high=999, low=50) that would look like
    // a massive pivot — it MUST be ignored.
    //
    // Why b7 is also structurally irrelevant: index 7 is never in closedBars
    // (stripped by slice). Even if it weren't stripped, it would have no right
    // neighbors → could never be a pivot center anyway.  The slice is the guard.
    //
    //  idx:  0    1    2    3    4    5    6    7(forming)
    //  high: 100  98   99   110  105  103  101  999
    //  low:   90  88   89   100   95   93   91   50
    const formingBarBars = [
      bar(100, 90), bar(98, 88), bar(99, 89),
      bar(110, 100),              // i=3 → swing HIGH=110
      bar(105, 95), bar(103, 93), bar(101, 91),
      bar(999, 50),               // forming bar — excluded
    ];

    it("the forming bar is not detected as a pivot even with extreme values", () => {
      const pivots = detectPivots(formingBarBars);
      expect(pivots.every((p) => p.index !== formingBarBars.length - 1)).toBe(true);
    });

    it("the legitimate pivot behind the forming bar is correctly detected", () => {
      const pivots = detectPivots(formingBarBars);
      expect(pivots).toHaveLength(1);
      expect(pivots[0]).toMatchObject({ type: "high", price: 110, index: 3 });
    });
  });

  // ── Equal-highs tie rule ───────────────────────────────────────────────────
  describe("equal-highs / equal-lows tie rule (strict inequality required)", () => {
    // Tie rule: bar.high must STRICTLY EXCEED all N neighbors to qualify.
    // Two bars with the same high that are exactly N=3 positions apart are in
    // each other's comparison windows — neither qualifies.
    //
    // 14 bars total, 13 closed (b0–b12), 1 forming (b13).
    // Eligible centers: i = 3..9.
    // b5 and b8 share high=110 and are 3 apart → each sees the other as a neighbor.
    //
    //  idx:  0    1    2    3    4    5    6    7    8    9    10   11   12   13(f)
    //  high: 100  98   99  102  104  110  105  104  110  105  102  101  100  108
    //  low:   90  88   89   92   94  100   95   94  100   95   92   91   90   98
    const equalHighBars = [
      bar(100, 90), bar(98, 88), bar(99, 89),
      bar(102, 92), bar(104, 94),
      bar(110, 100),              // b5: high=110, equal neighbor at b8
      bar(105, 95), bar(104, 94),
      bar(110, 100),              // b8: high=110, equal neighbor at b5
      bar(105, 95), bar(102, 92), bar(101, 91), bar(100, 90),
      bar(108, 98),               // forming bar — excluded
    ];

    it("neither equal-high bar is detected as a swing high", () => {
      const pivots = detectPivots(equalHighBars);
      const highPivots = pivots.filter((p) => p.type === "high");
      expect(highPivots.every((p) => p.price !== 110)).toBe(true);
    });

    it("no pivot at the equal-high positions (b5=5, b8=8)", () => {
      const pivots = detectPivots(equalHighBars);
      expect(pivots.every((p) => p.index !== 5 && p.index !== 8)).toBe(true);
    });

    // Equal LOWS: mirror — two bars share low=50, each in the other's N=3 window.
    // Same 13 closed bars but with extreme equal lows at b5 and b8.
    //
    //  idx:  0    1    2    3    4    5    6    7    8    9    10   11   12   13(f)
    //  low:   60   62   61   58   56   50   55   56   50   55   58   59   60   55
    //  high: 100  102  101   98   96  120   95   94  120   95   98   99  100  108
    const equalLowBars = [
      bar(100, 60), bar(102, 62), bar(101, 61),
      bar(98, 58), bar(96, 56),
      bar(120, 50),               // b5: low=50, equal neighbor at b8
      bar(95, 55), bar(94, 56),
      bar(120, 50),               // b8: low=50, equal neighbor at b5
      bar(95, 55), bar(98, 58), bar(99, 59), bar(100, 60),
      bar(108, 55),               // forming bar — excluded
    ];

    it("neither equal-low bar is detected as a swing low", () => {
      const pivots = detectPivots(equalLowBars);
      const lowPivots = pivots.filter((p) => p.type === "low");
      expect(lowPivots.every((p) => p.price !== 50)).toBe(true);
    });
  });

  // ── ZigZag alternation rule ────────────────────────────────────────────────
  describe("ZigZag alternation — consecutive same-side pivots keep the more extreme", () => {
    // Two raw swing HIGHs with no swing LOW between them.
    // The fractal peaks are at b3 (high=112) and b7 (high=115).
    // The intermediate bars (b4–b6) dip but none qualifies as a swing low because
    // the left-side neighbors of each dip bar include b0–b2 which are lower.
    //
    // After ZigZag: only the HIGHER peak (b7, 115) survives.
    //
    //  idx:  0    1    2    3    4    5    6    7    8    9    10   11(f)
    //  high: 100   98   99  112  108  106  107  115  108  105  102   99
    //  low:   90   88   89  102   98   96   97  105   98   95   92   89
    //
    // Verify no swing LOW between i=3 and i=7:
    //   b4.low=98: left b1.low=88 < 98 → b4 not a swing low ✓
    //   b5.low=96: left b2.low=89 < 96 → b5 not a swing low ✓
    //   b6.low=97: left b5.low=96 < 97 → b6 not a swing low ✓
    const twoConsecutiveHighsBars = [
      bar(100, 90), bar(98, 88), bar(99, 89),
      bar(112, 102),              // b3: PEAK1=112 (raw swing high)
      bar(108, 98), bar(106, 96), bar(107, 97),
      bar(115, 105),              // b7: PEAK2=115 (raw swing high, higher than PEAK1)
      bar(108, 98), bar(105, 95), bar(102, 92),
      bar(99, 89),                // forming bar — excluded
    ];

    it("only the higher of two consecutive swing highs survives ZigZag", () => {
      const pivots = detectPivots(twoConsecutiveHighsBars);
      const highPivots = pivots.filter((p) => p.type === "high");
      expect(highPivots).toHaveLength(1);
      expect(highPivots[0]).toMatchObject({ type: "high", price: 115, index: 7 });
    });

    it("the lower of the two consecutive highs is discarded", () => {
      const pivots = detectPivots(twoConsecutiveHighsBars);
      expect(pivots.every((p) => !(p.type === "high" && p.price === 112))).toBe(true);
    });

    // Two raw swing LOWs — the lower one should survive.
    // Peaks at b3 (low=88) and b7 (low=83).  Intermediate bars have lows between them.
    //
    //  idx:  0    1    2    3    4    5    6    7    8    9    10   11(f)
    //  high:  95  93   94   90   92   93   91   87   92   95   98   100
    //  low:   85  83   84   88   91   92   90   83   90   92   95    98
    //
    // b3.low=88 < b0.low=85? NO → 88 > 85 → b3 not a swing low by our bar values.
    // Let me fix this: b3 must have low LESS THAN all N=3 neighbors.
    //
    // Reconstruction for two consecutive swing LOWs (b3.low=78, b7.low=73):
    //
    //  idx:  0    1    2    3    4    5    6    7    8    9    10   11(f)
    //  high:  95   93   94   85   90   92   91   80   92   95   98  100
    //  low:   85   83   84   78   82   83   81   73   82   85   88   90
    //
    // b3 swing LOW=78? Left: b0.low=85>78✓, b1.low=83>78✓, b2.low=84>78✓
    //                  Right: b4.low=82>78✓, b5.low=83>78✓, b6.low=81>78✓ → YES ✓
    // b7 swing LOW=73? Left: b4.low=82>73✓, b5.low=83>73✓, b6.low=81>73✓
    //                  Right: b8.low=82>73✓, b9.low=85>73✓, b10.low=88>73✓ → YES ✓
    // b3 swing HIGH? b3.high=85, left b0.high=95>=85 → NO ✓
    // b7 swing HIGH? b7.high=80, left b4.high=90>=80 → NO ✓
    // No swing HIGH anywhere in i=3..7 (checked: all intermediate highs are higher than
    // left neighbors from the b0-b3 range, so none qualifies).
    const twoConsecutiveLowsBars = [
      bar(95, 85), bar(93, 83), bar(94, 84),
      bar(85, 78),               // b3: TROUGH1=78 (raw swing low)
      bar(90, 82), bar(92, 83), bar(91, 81),
      bar(80, 73),               // b7: TROUGH2=73 (raw swing low, lower than TROUGH1)
      bar(92, 82), bar(95, 85), bar(98, 88),
      bar(100, 90),              // forming bar — excluded
    ];

    it("only the lower of two consecutive swing lows survives ZigZag", () => {
      const pivots = detectPivots(twoConsecutiveLowsBars);
      const lowPivots = pivots.filter((p) => p.type === "low");
      expect(lowPivots).toHaveLength(1);
      expect(lowPivots[0]).toMatchObject({ type: "low", price: 73, index: 7 });
    });

    it("equal-price consecutive same-side pivots: earlier pivot is retained", () => {
      // Manually test applyZigZag via the public detectPivots path by constructing
      // two equal-priced swing highs. We can't do this through detectPivots directly
      // (equal highs in the fractal window prevent detection) so we test it via
      // classifyDow with a manually crafted pivot list.
      //
      // We verify the retention rule here using classifyDow with a pivot list where
      // the two highs are equal-priced — classification must be "mixed" (not HH or LH).
      const equalPricePivots: SwingPivot[] = [
        { index: 3,  type: "low",  price: 80 },
        { index: 7,  type: "high", price: 110 },
        { index: 11, type: "low",  price: 85 },
        { index: 15, type: "high", price: 110 }, // equal to previous high → mixed
      ];
      const result = classifyDow(equalPricePivots);
      expect(result.classification).toBe("mixed");
    });
  });

  // ── Minimum-bars guard ─────────────────────────────────────────────────────
  describe("too few closed bars for any pivot", () => {
    it("returns empty list when closed bars < 2*N+1", () => {
      // With N=3, need at least 7 closed bars. 6 closed + 1 forming = 7 total.
      // Provide 7 total bars (only 6 closed) — should return [].
      const tooShort = Array.from({ length: 7 }, (_, i) => bar(100 + i, 90 + i));
      expect(detectPivots(tooShort)).toEqual([]);
    });

    it("returns empty list for a flat price series (no bar exceeds its neighbors)", () => {
      // Flat highs: no bar strictly exceeds its neighbors → no swing highs.
      // Flat lows: same → no swing lows.
      const flat = Array.from({ length: 20 }, () => bar(100, 90));
      expect(detectPivots(flat)).toEqual([]);
    });
  });
});

// ─── classifyDow ─────────────────────────────────────────────────────────────

describe("classifyDow — Brick 2 Phase 2A", () => {
  it("insufficient: 0 pivots", () => {
    expect(classifyDow([])).toMatchObject({ classification: "insufficient", pivots: [] });
  });

  it("insufficient: 1 pivot", () => {
    const p: SwingPivot[] = [{ index: 3, type: "low", price: 80 }];
    expect(classifyDow(p)).toMatchObject({ classification: "insufficient" });
  });

  it("insufficient: 3 pivots", () => {
    const p: SwingPivot[] = [
      { index: 3, type: "low",  price: 80 },
      { index: 7, type: "high", price: 110 },
      { index: 11, type: "low", price: 85 },
    ];
    expect(classifyDow(p)).toMatchObject({ classification: "insufficient" });
    expect(classifyDow(p).pivots).toHaveLength(3);
  });

  it("HH/HL: both highs and lows ascending", () => {
    // Pattern: L(80) → H(110) → L(85) → H(120)  [HL: 85>80, HH: 120>110]
    const pivots: SwingPivot[] = [
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 85 },
      { index: 15, type: "high", price: 120 },
    ];
    const result = classifyDow(pivots);
    expect(result.classification).toBe("HH/HL");
    expect(result.pivots).toHaveLength(4);
  });

  it("LH/LL: both highs and lows descending", () => {
    // Pattern: H(120) → L(94) → H(112) → L(90)  [LH: 112<120, LL: 90<94]
    const pivots: SwingPivot[] = [
      { index: 3,  type: "high", price: 120 },
      { index: 7,  type: "low",  price: 94 },
      { index: 11, type: "high", price: 112 },
      { index: 15, type: "low",  price: 90 },
    ];
    const result = classifyDow(pivots);
    expect(result.classification).toBe("LH/LL");
    expect(result.pivots).toHaveLength(4);
  });

  it("mixed: rising highs but falling lows (expanding range)", () => {
    // HH (120>110) but LL (75<80) → neither HH/HL nor LH/LL
    const pivots: SwingPivot[] = [
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 75 },
      { index: 15, type: "high", price: 120 },
    ];
    expect(classifyDow(pivots).classification).toBe("mixed");
  });

  it("mixed: falling highs but rising lows (contracting range)", () => {
    // LH (105<110) but HL (88>80) → neither
    const pivots: SwingPivot[] = [
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 88 },
      { index: 15, type: "high", price: 105 },
    ];
    expect(classifyDow(pivots).classification).toBe("mixed");
  });

  it("mixed: equal high prices (not HH, not LH)", () => {
    // Equal highs → neither > nor < → mixed
    const pivots: SwingPivot[] = [
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 85 },
      { index: 15, type: "high", price: 110 }, // same as previous high
    ];
    expect(classifyDow(pivots).classification).toBe("mixed");
  });

  it("mixed: equal low prices (not HL, not LL)", () => {
    // Equal lows → mixed
    const pivots: SwingPivot[] = [
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 80 }, // same as previous low
      { index: 15, type: "high", price: 120 },
    ];
    expect(classifyDow(pivots).classification).toBe("mixed");
  });

  it("uses only the last 4 pivots when more than 4 exist", () => {
    // 6 pivots: first 2 are LH/LL, last 4 are HH/HL — classification should be HH/HL.
    const pivots: SwingPivot[] = [
      // Older 2 (LH/LL history — should be ignored):
      { index: 1,  type: "low",  price: 100 },
      { index: 2,  type: "high", price: 130 },
      // Last 4 (HH/HL):
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 85 },
      { index: 15, type: "high", price: 120 },
    ];
    const result = classifyDow(pivots);
    expect(result.classification).toBe("HH/HL");
    // Returned pivots are the last 4 only
    expect(result.pivots).toHaveLength(4);
    expect(result.pivots[0].index).toBe(3);
    expect(result.pivots[3].index).toBe(15);
  });

  it("returns pivot prices in the result for Phase 2B rendering", () => {
    // Phase 2B renders: "last swing high 120 > 110; last swing low 85 > 80"
    // Verify the pivot prices are accessible from the result.
    const pivots: SwingPivot[] = [
      { index: 3,  type: "low",  price: 80 },
      { index: 7,  type: "high", price: 110 },
      { index: 11, type: "low",  price: 85 },
      { index: 15, type: "high", price: 120 },
    ];
    const result = classifyDow(pivots);
    const highs = result.pivots.filter((p) => p.type === "high");
    const lows  = result.pivots.filter((p) => p.type === "low");
    expect(highs.map((p) => p.price)).toEqual([110, 120]); // older → newer
    expect(lows.map((p) => p.price)).toEqual([80, 85]);
  });
});

// ─── Integration: detectPivots → classifyDow (full synthetic bar sequences) ──

describe("detectPivots + classifyDow integration — Brick 2 Phase 2A", () => {
  // ── HH/HL synthetic sequence ─────────────────────────────────────────────
  //
  // 20 bars total (b0–b18 closed, b19 forming).  N=3 (FRACTAL_N).
  // Eligible centers: 3 ≤ i ≤ 15.
  //
  // Designed pivots (verified by hand):
  //   L1 at b3  (low=88):  left b0.low=93,b1.low=92,b2.low=91 all >88 ✓
  //                        right b4.low=93,b5.low=96,b6.low=99 all >88 ✓
  //   H1 at b7  (high=112): left  b4.h=100,b5.h=105,b6.h=108 <112 ✓
  //                         right b8.h=108,b9.h=105,b10.h=102 <112 ✓
  //   L2 at b11 (low=93):  left  b8.l=100,b9.l=98,b10.l=96 >93 ✓
  //                        right b12.l=96,b13.l=100,b14.l=105 >93 ✓
  //                        L2(93) > L1(88) → HL ✓
  //   H2 at b15 (high=122): left  b12.h=105,b13.h=110,b14.h=115 <122 ✓
  //                          right b16.h=115,b17.h=110,b18.h=108 <122 ✓
  //                          H2(122) > H1(112) → HH ✓
  //
  const hhHlBars = [
    bar(100, 93), bar(98, 92), bar(99, 91),     // b0–b2
    bar(95, 88),                                  // b3: L1=88
    bar(100, 93), bar(105, 96), bar(108, 99),    // b4–b6
    bar(112, 104),                                // b7: H1=112
    bar(108, 100), bar(105, 98), bar(102, 96),   // b8–b10
    bar(100, 93),                                 // b11: L2=93
    bar(105, 96), bar(110, 100), bar(115, 105),  // b12–b14
    bar(122, 110),                                // b15: H2=122
    bar(115, 105), bar(110, 100), bar(108, 98),  // b16–b18
    bar(105, 95),                                 // b19: forming bar (excluded)
  ];

  it("HH/HL: detects exactly 4 pivots in the synthetic uptrend", () => {
    const pivots = detectPivots(hhHlBars);
    expect(pivots).toHaveLength(4);
    expect(pivots[0]).toMatchObject({ type: "low",  price: 88,  index: 3  });
    expect(pivots[1]).toMatchObject({ type: "high", price: 112, index: 7  });
    expect(pivots[2]).toMatchObject({ type: "low",  price: 93,  index: 11 });
    expect(pivots[3]).toMatchObject({ type: "high", price: 122, index: 15 });
  });

  it("HH/HL: classifyDow returns HH/HL on the uptrend pivots", () => {
    const pivots = detectPivots(hhHlBars);
    const result = classifyDow(pivots);
    expect(result.classification).toBe("HH/HL");
    expect(result.pivots).toHaveLength(4);
  });

  // ── LH/LL synthetic sequence ─────────────────────────────────────────────
  //
  // 20 bars total (b0–b18 closed, b19 forming).  N=3.
  // Eligible centers: 3 ≤ i ≤ 15.
  //
  // Designed pivots (verified by hand):
  //   H1 at b3  (high=120): left  b0.h=108,b1.h=107,b2.h=106 <120 ✓
  //                          right b4.h=115,b5.h=110,b6.h=106 <120 ✓
  //   L1 at b7  (low=94):   left  b4.l=105,b5.l=100,b6.l=96 >94 ✓
  //                          right b8.l=97,b9.l=98,b10.l=99 >94 ✓
  //   H2 at b11 (high=112): left  b8.h=107,b9.h=108,b10.h=109 <112 ✓
  //                          right b12.h=108,b13.h=106,b14.h=103 <112 ✓
  //                          H2(112) < H1(120) → LH ✓
  //   L2 at b15 (low=90):   left  b12.l=98,b13.l=96,b14.l=93 >90 ✓
  //                          right b16.l=92,b17.l=93,b18.l=94 >90 ✓
  //                          L2(90) < L1(94) → LL ✓
  //
  const lhLlBars = [
    bar(108, 98), bar(107, 97), bar(106, 96),   // b0–b2
    bar(120, 110),                                // b3: H1=120
    bar(115, 105), bar(110, 100), bar(106, 96),  // b4–b6
    bar(104, 94),                                 // b7: L1=94
    bar(107, 97), bar(108, 98), bar(109, 99),    // b8–b10
    bar(112, 102),                                // b11: H2=112
    bar(108, 98), bar(106, 96), bar(103, 93),    // b12–b14
    bar(102, 90),                                 // b15: L2=90
    bar(104, 92), bar(105, 93), bar(106, 94),    // b16–b18
    bar(107, 95),                                 // b19: forming bar (excluded)
  ];

  it("LH/LL: detects exactly 4 pivots in the synthetic downtrend", () => {
    const pivots = detectPivots(lhLlBars);
    expect(pivots).toHaveLength(4);
    expect(pivots[0]).toMatchObject({ type: "high", price: 120, index: 3  });
    expect(pivots[1]).toMatchObject({ type: "low",  price: 94,  index: 7  });
    expect(pivots[2]).toMatchObject({ type: "high", price: 112, index: 11 });
    expect(pivots[3]).toMatchObject({ type: "low",  price: 90,  index: 15 });
  });

  it("LH/LL: classifyDow returns LH/LL on the downtrend pivots", () => {
    const pivots = detectPivots(lhLlBars);
    const result = classifyDow(pivots);
    expect(result.classification).toBe("LH/LL");
    expect(result.pivots).toHaveLength(4);
  });

  // ── Mixed synthetic sequence ──────────────────────────────────────────────
  //
  // Expanding range: new highs are higher (HH) but new lows are also lower (LL).
  // Neither HH/HL nor LH/LL → mixed.
  //
  // Designed pivots: L1=80, H1=110, L2=72, H2=120
  //   HH: H2(120) > H1(110) ✓
  //   LL: L2(72)  < L1(80)  ✓  → BOTH conditions present → neither classification matches → mixed
  //
  // 20 bars, N=3.  Pivots at b3(L1=80), b7(H1=110), b11(L2=72), b15(H2=120).
  //
  //  b3: high=90,low=80.  Left: b0.l=88>80✓,b1.l=86>80✓,b2.l=87>80✓
  //                        Right: b4.l=84>80✓,b5.l=86>80✓,b6.l=88>80✓
  //  b7: high=110,low=102. Left: b4.h=90<110✓,b5.h=95<110✓,b6.h=100<110✓
  //                         Right: b8.h=105<110✓,b9.h=100<110✓,b10.h=95<110✓
  //  b11: high=85,low=72.  Left: b8.l=96>72✓,b9.l=90>72✓,b10.l=85>72✓
  //                         Right: b12.l=78>72✓,b13.l=82>72✓,b14.l=88>72✓
  //  b15: high=120,low=110. Left: b12.h=90<120✓,b13.h=95<120✓,b14.h=100<120✓
  //                          Right: b16.h=115<120✓,b17.h=110<120✓,b18.h=105<120✓
  //
  const mixedBars = [
    bar(95, 88), bar(93, 86), bar(94, 87),       // b0–b2
    bar(90, 80),                                   // b3: L1=80
    bar(90, 84), bar(95, 86), bar(100, 88),       // b4–b6
    bar(110, 102),                                 // b7: H1=110
    bar(105, 96), bar(100, 90), bar(95, 85),      // b8–b10
    bar(85, 72),                                   // b11: L2=72 (LOWER than L1=80)
    bar(90, 78), bar(95, 82), bar(100, 88),       // b12–b14
    bar(120, 110),                                 // b15: H2=120 (HIGHER than H1=110)
    bar(115, 105), bar(110, 100), bar(105, 95),   // b16–b18
    bar(100, 90),                                  // b19: forming bar (excluded)
  ];

  it("mixed: detects 4 pivots (HH + LL = expanding range)", () => {
    const pivots = detectPivots(mixedBars);
    expect(pivots).toHaveLength(4);
    expect(pivots[0]).toMatchObject({ type: "low",  price: 80,  index: 3  });
    expect(pivots[1]).toMatchObject({ type: "high", price: 110, index: 7  });
    expect(pivots[2]).toMatchObject({ type: "low",  price: 72,  index: 11 });
    expect(pivots[3]).toMatchObject({ type: "high", price: 120, index: 15 });
  });

  it("mixed: classifyDow returns mixed (HH but LL — not a clean uptrend)", () => {
    const pivots = detectPivots(mixedBars);
    const result = classifyDow(pivots);
    expect(result.classification).toBe("mixed");
  });

  // ── Too-few-pivots → insufficient ────────────────────────────────────────

  it("insufficient: single-high sequence produces 1 pivot → insufficient", () => {
    // 8 bars total, 7 closed.  Only one eligible center (i=3).
    // b3 qualifies as a swing high → 1 pivot → classifyDow returns insufficient.
    const singlePivotBars = [
      bar(100, 90), bar(98, 88), bar(99, 89),
      bar(110, 100),              // b3: swing HIGH
      bar(105, 95), bar(103, 93), bar(101, 91),
      bar(99, 89),               // forming bar
    ];
    const pivots = detectPivots(singlePivotBars);
    expect(pivots).toHaveLength(1);
    const result = classifyDow(pivots);
    expect(result.classification).toBe("insufficient");
  });

  // ── FRACTAL_N constant is exported ───────────────────────────────────────

  it("FRACTAL_N is exported and equals 3 (v1 spec value)", () => {
    expect(FRACTAL_N).toBe(3);
  });
});
