import type { FlatReason } from "./ai-trader-flat-reasons";

export const CYCLE_REASONS = [
  "paused", "position_open", "auto_next_off", "mode_suggest", "venue_retired",
  "venue_unavailable", "schema_not_ready", "cooldown", "daily_cap", "model_key_missing",
  "reauth_required", "model_unsupported", "state_unresolved", "claim_lost", "scanner_disabled",
  "shortlist_empty", "shortlist_stale", "feed_basis_unavailable", "feed_stale", "feed_cache_degraded",
  "gateway_timeout", "gateway_error", "model_malformed", "audit_write_failed", "model_flat",
  "model_entry", "model_close", "guardrail_rejected", "close_without_position", "proposal_created",
  "entry_executed", "execution_rejected", "position_management", "scanner_boundary_lane_timeout",
  "scanner_boundary_lane_wait_failed", "cycle_interrupted", "internal_error", "wallet_agent_missing",
  "malfunction_ceiling",
] as const;
export type CycleReason = (typeof CYCLE_REASONS)[number];
export type CycleOutcome = "running" | "skipped" | "failed" | "model_decided" | "proposed" | "executed" | "position_managed";
export type CyclePhase = "initial" | "boundary_lane" | "preflight" | "claim" | "context" | "model" | "execution" | "position" | "settlement";

const FAILED: readonly CycleReason[] = ["gateway_timeout", "gateway_error", "model_malformed", "audit_write_failed", "internal_error", "cycle_interrupted"];
const DECIDED: readonly CycleReason[] = ["model_flat", "model_entry", "model_close", "guardrail_rejected", "close_without_position", "execution_rejected"];
export function outcomeForCycleReason(reason: CycleReason): Exclude<CycleOutcome, "running"> {
  if (FAILED.includes(reason)) return "failed";
  if (DECIDED.includes(reason)) return "model_decided";
  if (reason === "entry_executed") return "executed";
  if (reason === "proposal_created") return "proposed";
  if (reason === "position_management") return "position_managed";
  return "skipped";
}

export interface CycleStart {
  id: string;
  botId: string;
  plannedBoundary: Date;
  startedAt: Date;
  botUpdatedAt: Date | null;
  protocol: string;
  market: string;
  timeframe: string;
  marketSource: string;
  paperMode: boolean;
  model: string;
  ownerBootId: string;
  details: Record<string, unknown>;
}
export interface CycleFinish {
  phase: CyclePhase;
  outcome: Exclude<CycleOutcome, "running">;
  reasonCode: CycleReason;
  finishedAt: Date;
  rearmed: boolean;
  nextPlannedBoundary: Date | null;
  candidateCount: number;
  modelCallCount: number;
  decisionIds: string[];
  promptVersionHash: string | null;
  contextVersionHash: string | null;
  details: Record<string, unknown>;
}
export interface LatestCycle {
  status: "available" | "unavailable";
  cycle: null | {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    outcome: CycleOutcome;
    reasonCode: CycleReason | null;
    rearmed: boolean | null;
    nextPlannedBoundary: string | null;
    completionUnknown: boolean;
    flatReasons: FlatReason[] | null;
    rationale: string | null;
    detailCodes: string[];
  };
}

export function assertCycleFinish(value: CycleFinish): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!CYCLE_REASONS.includes(value.reasonCode) || outcomeForCycleReason(value.reasonCode) !== value.outcome
      || value.decisionIds.length > 2 || new Set(value.decisionIds).size !== value.decisionIds.length
      || !value.decisionIds.every(id => uuid.test(id))
      || !Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0
      || !Number.isSafeInteger(value.modelCallCount) || value.modelCallCount < 0
      || !Number.isFinite(value.finishedAt.getTime())
      || JSON.stringify(value.details).length > 6000) throw new Error("invalid_cycle_receipt");
}
