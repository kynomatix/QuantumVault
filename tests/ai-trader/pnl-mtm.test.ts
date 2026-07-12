// WO-8g — unit tests for the shared computeUnrealizedPnl formula.
// This is the single source of truth used by: the list-route PnL block,
// the detail-route PnL block, and (via the daily-loss breaker) the monitor.
// Tests verify correctness for long/short paper cases and all null-safety guards.
import { describe, it, expect } from "vitest";
import { computeUnrealizedPnl } from "../../server/ai-trader/monitor";
import type { OpenDecisionView } from "../../server/ai-trader/monitor";
import type { AiTraderDecision } from "@shared/schema";

// Minimal stub — computeUnrealizedPnl only reads side, sizeBase, entryPrice.
function makeView(
  side: "long" | "short",
  entryPrice: number | null,
  sizeBase: number,
): OpenDecisionView {
  return {
    decision: {} as AiTraderDecision,
    side,
    sizeBase,
    marginUsdc: 100,
    stopLossPrice: 1,
    takeProfitPrice: 9999,
    entryPrice,
    decidedAtMs: Date.now(),
  };
}

describe("computeUnrealizedPnl — long positions", () => {
  it("returns positive PnL when price moves above entry", () => {
    const view = makeView("long", 100, 2);
    // mark 105, entry 100, size 2 → (105-100)*2*1 = +10
    expect(computeUnrealizedPnl(view, 105)).toBeCloseTo(10, 10);
  });

  it("returns negative PnL when price falls below entry", () => {
    const view = makeView("long", 100, 2);
    // mark 90, entry 100, size 2 → (90-100)*2*1 = -20
    expect(computeUnrealizedPnl(view, 90)).toBeCloseTo(-20, 10);
  });

  it("returns zero when mark equals entry exactly", () => {
    const view = makeView("long", 150, 3);
    expect(computeUnrealizedPnl(view, 150)).toBeCloseTo(0, 10);
  });
});

describe("computeUnrealizedPnl — short positions", () => {
  it("returns positive PnL when price falls below entry", () => {
    const view = makeView("short", 100, 2);
    // mark 90, entry 100, size 2 → (90-100)*2*(-1) = +20
    expect(computeUnrealizedPnl(view, 90)).toBeCloseTo(20, 10);
  });

  it("returns negative PnL when price rises above entry", () => {
    const view = makeView("short", 100, 2);
    // mark 110, entry 100, size 2 → (110-100)*2*(-1) = -20
    expect(computeUnrealizedPnl(view, 110)).toBeCloseTo(-20, 10);
  });

  it("returns zero when mark equals entry exactly", () => {
    const view = makeView("short", 75, 5);
    expect(computeUnrealizedPnl(view, 75)).toBeCloseTo(0, 10);
  });
});

describe("computeUnrealizedPnl — null-safety", () => {
  it("returns null when entryPrice is null (live bot pre-reconciliation)", () => {
    const view = makeView("long", null, 2);
    expect(computeUnrealizedPnl(view, 105)).toBeNull();
  });

  it("returns null when markPrice is NaN", () => {
    const view = makeView("long", 100, 2);
    expect(computeUnrealizedPnl(view, NaN)).toBeNull();
  });

  it("returns null when markPrice is Infinity", () => {
    const view = makeView("short", 100, 2);
    expect(computeUnrealizedPnl(view, Infinity)).toBeNull();
  });

  it("returns null when sizeBase is zero", () => {
    const view = makeView("long", 100, 0);
    expect(computeUnrealizedPnl(view, 110)).toBeNull();
  });

  it("returns null when sizeBase is negative (invalid view)", () => {
    const view = makeView("long", 100, -1);
    expect(computeUnrealizedPnl(view, 110)).toBeNull();
  });
});

describe("computeUnrealizedPnl — fixture price scenario", () => {
  it("paper SOL long: entry $175, mark $177.50, 0.5714 SOL → +$1.43", () => {
    const view = makeView("long", 175, 0.5714);
    const result = computeUnrealizedPnl(view, 177.5);
    // (177.5 - 175) * 0.5714 * 1 = 2.5 * 0.5714 = 1.4285
    expect(result).toBeCloseTo(1.4285, 3);
  });

  it("paper SOL short: entry $180, mark $176, 0.5 SOL → +$2.00", () => {
    const view = makeView("short", 180, 0.5);
    const result = computeUnrealizedPnl(view, 176);
    // (176 - 180) * 0.5 * (-1) = (-4) * 0.5 * (-1) = +2
    expect(result).toBeCloseTo(2, 10);
  });
});
