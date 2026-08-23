import { describe, expect, it } from "vitest";
import type { AiTraderDecision } from "@shared/schema";
import { evaluateGraduation } from "../../server/ai-trader/graduation";
import { buildQualificationRecord } from "../../server/ai-trader/qualification-record";

const DAY = 86_400_000;
const evaluatedAt = new Date("2026-08-23T12:00:00.000Z");
const trialStartedAt = new Date(evaluatedAt.getTime() - 10 * DAY);
const era = "ERA-EXACT";

function decision(id: string, daysAgo: number, pnl: number, fee: string | null = "0.10") {
  const closedAt = new Date(evaluatedAt.getTime() - daysAgo * DAY);
  return {
    id,
    outcome: "executed",
    decidedAt: new Date(closedAt.getTime() - 60_000),
    closedAt,
    realizedPnl: String(pnl),
    feesPaid: fee,
    qualificationEraDigest: era,
    contextDigest: {
      guardrailEcho: { maxLeverage: 5, smartLeverageCap: 3 },
    },
  } as unknown as AiTraderDecision;
}

function build(decisions: AiTraderDecision[]) {
  const evaluation = evaluateGraduation({
    criteria: { periodDays: 7, minTrades: 3, minNetPnl: 0, maxDrawdownPct: 30, minProfitFactor: 1.1 },
    trades: decisions.map((row) => ({ closedAt: row.closedAt!, netPnl: Number(row.realizedPnl) })),
    trialStartedAt,
    allocation: 1000,
    openPositionMtm: 0,
    now: evaluatedAt.getTime(),
  });
  expect(evaluation.verdict).toBe("graduated");
  return buildQualificationRecord({
    botId: "bot-qualification",
    qualificationEraDigest: era,
    trialStartedAt,
    evaluatedAt,
    allocationUsdc: 1000,
    openPositionMtm: 0,
    decisions,
    evaluation,
  });
}

describe("immutable AI Trader qualification record", () => {
  it("binds the exact sorted decision population, equity series, and JSON-safe infinity", () => {
    const rows = [decision("late", 1, 8), decision("early", 3, 5), decision("middle", 2, 7)];
    const record = build(rows);
    const reordered = build([...rows].reverse());

    expect(record.decisionIds).toEqual(["early", "middle", "late"]);
    expect(record.equitySeries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "start", equity: 1000 }),
      expect.objectContaining({ kind: "evaluation", equity: 1020 }),
    ]));
    expect(record.profitFactor).toEqual({ kind: "positive_infinity" });
    expect(JSON.stringify(record)).not.toContain("Infinity");
    expect(record.equitySeriesDigest).toBe(reordered.equitySeriesDigest);
    expect(record.evidenceSourceDigest).toBe(reordered.evidenceSourceDigest);
    expect(record.leverageObservation).toMatchObject({
      decisionId: "late",
      effectiveMaxLeverage: 5,
      smartLeverageCap: 3,
    });
  });

  it("preserves fee unavailability without fabricating a total", () => {
    const record = build([decision("one", 3, 5), decision("two", 2, 7, null), decision("three", 1, 8)]);
    expect(record.fees).toEqual({ status: "unavailable", missingDecisionIds: ["two"] });
  });

  it("rejects mismatched-era and out-of-window evidence", () => {
    const mismatched = decision("wrong-era", 1, 8) as any;
    mismatched.qualificationEraDigest = "OTHER";
    expect(() => build([decision("one", 3, 5), decision("two", 2, 7), mismatched]))
      .toThrow("outside the exact era");

    const late = decision("late", -1, 8);
    expect(() => build([decision("one", 3, 5), decision("two", 2, 7), late]))
      .toThrow("outside the trial window");
  });
});
