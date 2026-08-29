import { describe, expect, it } from "vitest";
import type { AiTraderDecision } from "@shared/schema";
import {
  computeUnrealizedPnl,
  parseOpenDecision,
  resolvePaperPositionState,
} from "../../server/ai-trader/paper-position-authority";

function makeOpenDecision(overrides: Partial<AiTraderDecision> = {}): AiTraderDecision {
  return {
    id: "decision-open",
    botId: "bot-1",
    outcome: "executed",
    clampedDecision: {
      action: "long",
      sizeBase: 2,
      marginUsdc: 100,
      stopLossPrice: 95,
      takeProfitPrice: 110,
    },
    entryPrice: "100",
    closedAt: null,
    decidedAt: new Date("2026-08-11T00:00:00.000Z"),
    ...overrides,
  } as unknown as AiTraderDecision;
}

describe("resolvePaperPositionState", () => {
  it("resolves paused plus one valid row as open", () => {
    const row = makeOpenDecision();
    const result = resolvePaperPositionState("paused", [row]);
    expect(result).toMatchObject({
      positionState: "open",
      positionAuthority: "paper_ledger",
      reason: null,
    });
    expect(result.view?.decision).toBe(row);
  });

  it("resolves idle plus zero rows as flat", () => {
    expect(resolvePaperPositionState("idle", [])).toEqual({
      positionState: "flat",
      positionAuthority: "paper_ledger",
      view: null,
      reason: null,
    });
  });

  it("keeps open plus zero rows unknown", () => {
    expect(resolvePaperPositionState("open", [])).toEqual({
      positionState: "unknown",
      positionAuthority: "unknown",
      view: null,
      reason: "status_requires_open_row",
    });
  });

  it("keeps an unrecognised runtime status unknown", () => {
    expect(resolvePaperPositionState("future_status" as string, [])).toEqual({
      positionState: "unknown",
      positionAuthority: "unknown",
      view: null,
      reason: "unrecognised_status",
    });
  });

  it.each(["analyzing", "executing"])("keeps genuinely transient %s-without-row unknown", (status) => {
    expect(resolvePaperPositionState(status, [])).toMatchObject({
      positionState: "unknown",
      positionAuthority: "unknown",
      reason: "status_requires_open_row",
    });
  });

  it("marks status/row mismatch unknown", () => {
    expect(resolvePaperPositionState("idle", [makeOpenDecision()])).toMatchObject({
      positionState: "unknown",
      positionAuthority: "unknown",
      reason: "status_row_mismatch",
    });
  });

  it("marks duplicate or malformed rows unknown", () => {
    expect(resolvePaperPositionState("open", [makeOpenDecision(), makeOpenDecision({ id: "second" })])).toMatchObject({
      positionState: "unknown",
      reason: "multiple_open_rows",
    });
    expect(
      resolvePaperPositionState("open", [makeOpenDecision({ clampedDecision: { action: "flat" } })]),
    ).toMatchObject({ positionState: "unknown", reason: "malformed_open_row" });
  });
});

describe("shared paper-position parser and PnL", () => {
  it("retains breakeven-aware open-row parsing", () => {
    const row = makeOpenDecision({
      clampedDecision: {
        action: "short",
        sizeBase: 3,
        marginUsdc: 120,
        stopLossPrice: 105,
        takeProfitPrice: 90,
        breakevenProtect: {
          movedAt: "2026-08-11T00:01:00.000Z",
          originalStopLossPrice: 105,
          stopLossPrice: 99,
        },
      },
    });
    const view = parseOpenDecision([row]);
    expect(view).toMatchObject({ side: "short", sizeBase: 3, entryPrice: 100 });
    expect(view?.breakevenProtect).not.toBeNull();
  });

  it("retains mark-to-market arithmetic and null safety", () => {
    const view = parseOpenDecision([makeOpenDecision()]);
    expect(view).not.toBeNull();
    expect(computeUnrealizedPnl(view!, 105)).toBe(10);
    expect(computeUnrealizedPnl({ ...view!, entryPrice: null }, 105)).toBeNull();
  });
});
