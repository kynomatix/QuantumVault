import { createHash } from "node:crypto";
import type {
  AiTraderDecision,
  InsertAiTraderQualificationRecord,
} from "@shared/schema";
import type { GraduationEvaluation } from "./graduation";

export type QualificationEvidenceDecision = Pick<
  AiTraderDecision,
  | "id"
  | "outcome"
  | "decidedAt"
  | "closedAt"
  | "realizedPnl"
  | "feesPaid"
  | "contextDigest"
  | "qualificationEraDigest"
>;

export type JsonSafeProfitFactor =
  | { kind: "finite"; value: number }
  | { kind: "positive_infinity" };

export type QualificationFees =
  | { status: "complete"; total: number }
  | { status: "unavailable"; missingDecisionIds: string[] };

export interface QualificationEquityPoint {
  kind: "start" | "close" | "evaluation";
  at: string;
  equity: number;
  decisionId?: string;
}

export interface QualificationLeverageObservation {
  observedAt: string;
  decisionId: string;
  effectiveMaxLeverage: number;
  smartLeverageCap: number;
}

interface BuildQualificationRecordInput {
  botId: string;
  qualificationEraDigest: string;
  trialStartedAt: Date;
  evaluatedAt: Date;
  allocationUsdc: number;
  openPositionMtm: number;
  decisions: QualificationEvidenceDecision[];
  evaluation: GraduationEvaluation;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex")
    .toUpperCase();
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`qualification evidence ${label} is not finite`);
  return number;
}

function toIso(value: Date | null, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`qualification evidence ${label} is unavailable`);
  }
  return value.toISOString();
}

function leverageObservation(
  decisions: QualificationEvidenceDecision[],
): QualificationLeverageObservation | null {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    const context = decision.contextDigest;
    if (!context || typeof context !== "object") continue;
    const echo = (context as Record<string, unknown>).guardrailEcho;
    if (!echo || typeof echo !== "object") continue;
    const record = echo as Record<string, unknown>;
    const effectiveMaxLeverage = Number(record.maxLeverage);
    const smartLeverageCap = Number(record.smartLeverageCap);
    if (!Number.isFinite(effectiveMaxLeverage) || !Number.isFinite(smartLeverageCap)) continue;
    return {
      observedAt: toIso(decision.decidedAt, "leverage observation timestamp"),
      decisionId: decision.id,
      effectiveMaxLeverage,
      smartLeverageCap,
    };
  }
  return null;
}

export function buildQualificationRecord(
  input: BuildQualificationRecordInput,
): InsertAiTraderQualificationRecord {
  if (!input.botId || !input.qualificationEraDigest) {
    throw new Error("qualification evidence identity is unavailable");
  }
  const allocation = finiteNumber(input.allocationUsdc, "allocation");
  const openPositionMtm = finiteNumber(input.openPositionMtm, "open-position MTM");
  if (allocation <= 0) throw new Error("qualification evidence allocation must be positive");

  const trialStartedMs = input.trialStartedAt.getTime();
  const evaluatedMs = input.evaluatedAt.getTime();
  if (!Number.isFinite(trialStartedMs) || !Number.isFinite(evaluatedMs) || evaluatedMs < trialStartedMs) {
    throw new Error("qualification evidence trial window is invalid");
  }

  const decisions = [...input.decisions].sort((left, right) => {
    const timeDelta = (left.closedAt?.getTime() ?? 0) - (right.closedAt?.getTime() ?? 0);
    return timeDelta || left.id.localeCompare(right.id);
  });
  let cumulativePnl = 0;
  const equitySeries: QualificationEquityPoint[] = [{
    kind: "start",
    at: input.trialStartedAt.toISOString(),
    equity: allocation,
  }];
  const missingFeeIds: string[] = [];
  let totalFees = 0;

  for (const decision of decisions) {
    if (decision.outcome !== "executed"
        || decision.qualificationEraDigest !== input.qualificationEraDigest) {
      throw new Error(`qualification evidence decision ${decision.id} is outside the exact era`);
    }
    const closedAt = toIso(decision.closedAt, `close timestamp for ${decision.id}`);
    const closedMs = decision.closedAt!.getTime();
    if (closedMs < trialStartedMs || closedMs > evaluatedMs) {
      throw new Error(`qualification evidence decision ${decision.id} is outside the trial window`);
    }
    cumulativePnl += finiteNumber(decision.realizedPnl, `realized PnL for ${decision.id}`);
    equitySeries.push({
      kind: "close",
      at: closedAt,
      equity: allocation + cumulativePnl,
      decisionId: decision.id,
    });
    if (decision.feesPaid === null || decision.feesPaid === undefined) {
      missingFeeIds.push(decision.id);
    } else {
      totalFees += finiteNumber(decision.feesPaid, `fees for ${decision.id}`);
    }
  }
  equitySeries.push({
    kind: "evaluation",
    at: input.evaluatedAt.toISOString(),
    equity: allocation + cumulativePnl + openPositionMtm,
  });

  if (input.evaluation.tradeCount !== decisions.length
      || Math.abs(input.evaluation.netPnl - cumulativePnl) > 1e-8) {
    throw new Error("qualification evaluation does not bind the exact decision population");
  }

  const fees: QualificationFees = missingFeeIds.length === 0
    ? { status: "complete", total: totalFees }
    : { status: "unavailable", missingDecisionIds: missingFeeIds };
  const profitFactor: JsonSafeProfitFactor = Number.isFinite(input.evaluation.profitFactor)
    ? { kind: "finite", value: input.evaluation.profitFactor }
    : { kind: "positive_infinity" };
  const decisionIds = decisions.map((decision) => decision.id);
  const sourcePopulation = decisions.map((decision) => ({
    id: decision.id,
    decidedAt: toIso(decision.decidedAt, `decision timestamp for ${decision.id}`),
    closedAt: toIso(decision.closedAt, `close timestamp for ${decision.id}`),
    realizedPnl: finiteNumber(decision.realizedPnl, `realized PnL for ${decision.id}`),
    feesPaid: decision.feesPaid === null || decision.feesPaid === undefined
      ? null
      : finiteNumber(decision.feesPaid, `fees for ${decision.id}`),
    contextDigestSha256: digest(decision.contextDigest),
    qualificationEraDigest: decision.qualificationEraDigest,
  }));

  return {
    botId: input.botId,
    qualificationEraDigest: input.qualificationEraDigest,
    trialStartedAt: input.trialStartedAt,
    evaluatedAt: input.evaluatedAt,
    criteria: input.evaluation.criteria,
    allocationUsdc: allocation.toFixed(2),
    decisionIds,
    equitySeries,
    equitySeriesDigest: digest(equitySeries),
    tradeCount: decisions.length,
    netPnl: input.evaluation.netPnl.toFixed(6),
    fees,
    profitFactor,
    maxDrawdownPct: input.evaluation.maxDrawdownPct.toFixed(6),
    openPositionMtm: openPositionMtm.toFixed(6),
    leverageObservation: leverageObservation(decisions),
    evidenceSourceDigest: digest({
      botId: input.botId,
      qualificationEraDigest: input.qualificationEraDigest,
      trialStartedAt: input.trialStartedAt.toISOString(),
      evaluatedAt: input.evaluatedAt.toISOString(),
      allocation,
      openPositionMtm,
      criteria: input.evaluation.criteria,
      decisions: sourcePopulation,
      equitySeriesDigest: digest(equitySeries),
    }),
  };
}

