// Breakeven Protect — pure module tests (server/ai-trader/breakeven.ts).
// No mocks needed: the module is pure by contract (paper-math conventions).

import { describe, it, expect } from "vitest";
import {
  BREAKEVEN_TRIGGER_PROGRESS,
  BREAKEVEN_BUFFER_RATE,
  parseBreakevenProtect,
  favorableExtreme,
  progressTowardTp,
  breakevenStopPrice,
  isFavorableSideOf,
  isTighterStop,
  evaluatePaperBracketWithMove,
  countsAsSlLoss,
} from "../../server/ai-trader/breakeven";
import { PAPER_SLIPPAGE_PER_LEG } from "../../server/ai-trader/paper-math";

function candle(time: number, open: number, high: number, low: number, close: number) {
  return { time, open, high, low, close, volume: 100 };
}

const T0 = Date.UTC(2026, 6, 8, 11, 0, 0);
const TF = 900_000;

describe("parseBreakevenProtect", () => {
  it("returns null when the blob is absent", () => {
    expect(parseBreakevenProtect(undefined, 145, T0)).toBeNull();
    expect(parseBreakevenProtect(null, 145, T0)).toBeNull();
  });

  it("passes a well-formed blob through", () => {
    const raw = {
      originalStopLossPrice: 145,
      movedStopLossPrice: 150.225,
      movedAt: "2026-07-08T11:45:00.000Z",
      progressAtFire: 0.8,
    };
    expect(parseBreakevenProtect(raw, 150.225, T0)).toEqual(raw);
  });

  it("coerces a PRESENT-but-malformed blob to fired-at-current-stop (never re-fires)", () => {
    const parsed = parseBreakevenProtect({ garbage: true }, 150.225, T0);
    expect(parsed).not.toBeNull();
    expect(parsed!.originalStopLossPrice).toBe(150.225);
    expect(parsed!.movedStopLossPrice).toBe(150.225);
    expect(new Date(parsed!.movedAt).getTime()).toBe(T0);
    expect(parsed!.progressAtFire).toBe(BREAKEVEN_TRIGGER_PROGRESS);
  });

  it("coerces non-finite/negative numbers field-by-field", () => {
    const parsed = parseBreakevenProtect(
      { originalStopLossPrice: -1, movedStopLossPrice: NaN, movedAt: "not-a-date", progressAtFire: 0.9 },
      150,
      T0
    );
    expect(parsed!.originalStopLossPrice).toBe(150);
    expect(parsed!.movedStopLossPrice).toBe(150);
    expect(new Date(parsed!.movedAt).getTime()).toBe(T0);
    expect(parsed!.progressAtFire).toBe(0.9);
  });
});

describe("favorableExtreme", () => {
  const candles = [candle(T0, 150, 155, 148, 152), candle(T0 + TF, 152, 158, 151, 157)];

  it("highest high for a long, lowest low for a short", () => {
    expect(favorableExtreme(candles, "long")).toBe(158);
    expect(favorableExtreme(candles, "short")).toBe(148);
  });

  it("null on empty input", () => {
    expect(favorableExtreme([], "long")).toBeNull();
  });
});

describe("progressTowardTp", () => {
  it("long: fraction of entry→TP covered by the high", () => {
    expect(progressTowardTp("long", 150, 160, 157.5)).toBeCloseTo(0.75, 10);
    expect(progressTowardTp("long", 150, 160, 161)).toBeCloseTo(1.1, 10);
  });

  it("short: fraction of entry→TP covered by the low", () => {
    expect(progressTowardTp("short", 150, 140, 142.5)).toBeCloseTo(0.75, 10);
  });

  it("0 on adverse-only travel and on degenerate brackets", () => {
    expect(progressTowardTp("long", 150, 160, 149)).toBe(0);
    expect(progressTowardTp("long", 150, 150, 155)).toBe(0); // zero distance
    expect(progressTowardTp("long", 150, 145, 155)).toBe(0); // TP below entry (long)
    expect(progressTowardTp("long", NaN, 160, 155)).toBe(0);
  });
});

describe("breakevenStopPrice / isFavorableSideOf / isTighterStop", () => {
  it("nudges the stop in the favorable direction by the buffer", () => {
    expect(breakevenStopPrice("long", 150)).toBeCloseTo(150 * (1 + BREAKEVEN_BUFFER_RATE), 10);
    expect(breakevenStopPrice("short", 150)).toBeCloseTo(150 * (1 - BREAKEVEN_BUFFER_RATE), 10);
  });

  it("buffer covers 2 taker legs + paper slippage (BE stop-out nets ≥ 0 on paper)", () => {
    // exit = newSl*(1-slip); net = (exit-entry)*size − fee*(entry+exit)*size must be ≥ 0
    const entry = 150;
    const exit = breakevenStopPrice("long", entry) * (1 - PAPER_SLIPPAGE_PER_LEG);
    const net = (exit - entry) - 0.0004 * (entry + exit);
    expect(net).toBeGreaterThan(0);
  });

  it("favorable side: strictly above for long, strictly below for short", () => {
    expect(isFavorableSideOf("long", 151, 150.5)).toBe(true);
    expect(isFavorableSideOf("long", 150.5, 150.5)).toBe(false);
    expect(isFavorableSideOf("short", 149, 149.5)).toBe(true);
  });

  it("one-way ratchet: candidate must be strictly tighter", () => {
    expect(isTighterStop("long", 150.225, 145)).toBe(true);
    expect(isTighterStop("long", 150.225, 152)).toBe(false); // AI already set tighter — never loosen
    expect(isTighterStop("long", 150.225, 150.225)).toBe(false);
    expect(isTighterStop("short", 149.775, 155)).toBe(true);
    expect(isTighterStop("short", 149.775, 148)).toBe(false);
  });
});

describe("evaluatePaperBracketWithMove", () => {
  // long, entry 150, original SL 145, moved SL 150.225, TP 160
  const ORIG = 145;
  const MOVED = 150.225;
  const TP = 160;
  const MOVE_OPEN = T0 + 2 * TF; // candle DURING which the move happened

  it("a pre-move dip below the MOVED stop (but above the original) does NOT trigger", () => {
    const candles = [
      candle(T0 + TF, 150, 151, 148, 150.5), // below moved SL, above original — pre-move
      candle(MOVE_OPEN, 150.5, 152, 150.4, 151), // move candle: still original SL
      candle(MOVE_OPEN + TF, 151, 152, 150.5, 151.5), // post-move: above moved SL
    ];
    expect(evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN)).toBeNull();
  });

  it("the move candle itself (time === boundary) still tests the ORIGINAL stop", () => {
    const candles = [candle(MOVE_OPEN, 151, 152, 150.0, 151)]; // low < moved SL but > original
    expect(evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN)).toBeNull();
  });

  it("a strictly-later candle triggers on the MOVED stop", () => {
    const candles = [candle(MOVE_OPEN + TF, 151, 152, 150.0, 151.8)];
    const hit = evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN);
    expect(hit).not.toBeNull();
    expect(hit!.leg).toBe("sl");
    expect(hit!.exitPrice).toBeCloseTo(MOVED * (1 - PAPER_SLIPPAGE_PER_LEG), 10);
  });

  it("chronology: a pre-move ORIGINAL-stop hit wins over a later moved-stop hit", () => {
    const candles = [
      candle(T0 + TF, 150, 151, 144, 146), // original SL 145 touched pre-move
      candle(MOVE_OPEN + TF, 146, 152, 150.0, 151), // would also touch moved SL
    ];
    const hit = evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN);
    expect(hit!.candleTime).toBe(T0 + TF);
    expect(hit!.exitPrice).toBeCloseTo(ORIG * (1 - PAPER_SLIPPAGE_PER_LEG), 10);
  });

  it("TP still triggers normally after the move", () => {
    const candles = [candle(MOVE_OPEN + TF, 151, 160.5, 150.5, 160.2)];
    const hit = evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN);
    expect(hit!.leg).toBe("tp");
  });
});

describe("countsAsSlLoss (G8 predicate)", () => {
  it("SL exit with negative PnL counts", () => {
    expect(countsAsSlLoss("sl", -12.5)).toBe(true);
  });

  it("SL exit with POSITIVE PnL (breakeven-protect stop-out) does NOT count", () => {
    expect(countsAsSlLoss("sl", 0.06)).toBe(false);
    expect(countsAsSlLoss("sl", 0)).toBe(false);
  });

  it("unknown PnL on an SL exit still counts (fail closed)", () => {
    expect(countsAsSlLoss("sl", null)).toBe(true);
    expect(countsAsSlLoss("sl", undefined)).toBe(true);
    expect(countsAsSlLoss("sl", NaN)).toBe(true);
  });

  it("non-SL exits never count", () => {
    expect(countsAsSlLoss("tp", -5)).toBe(false);
    expect(countsAsSlLoss("circuit_breaker", -50)).toBe(false);
    expect(countsAsSlLoss(null, -5)).toBe(false);
  });
});
