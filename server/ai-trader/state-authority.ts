export type AiTraderAuthorityAction =
  | "analyze"
  | "execute"
  | "resume"
  | "restart_trial"
  | "proposal_skip"
  | "proposal_expire"
  | "close"
  | "cancel"
  | "reconcile";

export type AiTraderAuthoritySource =
  | "external_http"
  | "internal_cycle"
  | "state_reconciler"
  | "risk_reducing";

export type AiTraderPositionTruth = "flat" | "open" | "maybe_open" | "read_failed";

export type AiTraderRequiredClaim =
  | "idle_to_analyzing"
  | "analyzing_decision_to_proposed"
  | "proposed_decision_to_executing"
  | "analyzing_decision_to_executing"
  | "conditional_lifecycle_transition"
  | "none";

export type AiTraderAuthorityVerdict =
  | {
      allowed: true;
      requiredClaim: AiTraderRequiredClaim;
      decisionTerminalization?: {
        decisionId: string;
        outcome: "aborted_trial_restart";
      };
    }
  | {
      allowed: false;
      reason:
        | "bot_busy"
        | "state_denied"
        | "malformed_authority"
        | "decision_mismatch"
        | "decision_expired"
        | "position_uncertain";
    };

export const AI_TRADER_PROPOSAL_EXPIRY_MS = 10 * 60 * 1000;

export interface AiTraderAuthorityInput {
  action: AiTraderAuthorityAction;
  source: AiTraderAuthoritySource;
  bot: Readonly<{
    id: string;
    status: string;
    pauseReason: string | null;
    graduationState: string;
    paperMode: boolean;
  }>;
  requestedDecisionId: string | null;
  decision: Readonly<{
    id: string;
    botId: string;
    outcome: string | null;
    decidedAtMs: number;
  }> | null;
  unresolvedDecisionCount: number;
  positionTruth: AiTraderPositionTruth;
  internalAnalysisClaimHeld: boolean;
  nowMs: number;
  proposalExpiryMs: number;
}

const KNOWN_STATUSES = new Set([
  "idle",
  "proposed",
  "analyzing",
  "executing",
  "open",
  "paused",
  "stopped",
]);

const NON_GENERIC_PAUSES = new Set([
  "policy_hmac_mismatch",
  "position_unconfirmed",
  "bracket_failed",
  "liquidation",
  "daily_loss_breaker",
  "reconcile_orphan_position",
]);

function denied(reason: Extract<AiTraderAuthorityVerdict, { allowed: false }>["reason"]): AiTraderAuthorityVerdict {
  return { allowed: false, reason };
}

function decisionMatches(input: AiTraderAuthorityInput): boolean {
  return input.requestedDecisionId !== null
    && input.decision !== null
    && input.decision.id === input.requestedDecisionId
    && input.decision.botId === input.bot.id
    && input.decision.outcome === null
    && input.unresolvedDecisionCount === 1;
}

/**
 * Pure, exhaustive risk-authority decision. A positive verdict names the storage
 * claim which must still succeed atomically; it is never authority by itself.
 */
export function evaluateAiTraderStateAuthority(input: Readonly<AiTraderAuthorityInput>): AiTraderAuthorityVerdict {
  const { action, source, bot, positionTruth } = input;

  // Risk-reducing authority is deliberately evaluated before lifecycle-shape
  // validation. A malformed bot row may block every new-risk action, but it
  // must not take away close/cancel authority when exposure may exist.
  if (action === "close" || action === "cancel") {
    if (source !== "risk_reducing") return denied("state_denied");
    return positionTruth === "flat" ? denied("state_denied") : { allowed: true, requiredClaim: "none" };
  }

  if (!KNOWN_STATUSES.has(bot.status)) return denied("malformed_authority");
  if ((bot.status === "paused") !== (bot.pauseReason !== null)) return denied("malformed_authority");

  if (positionTruth === "read_failed" || positionTruth === "maybe_open") return denied("position_uncertain");
  if (positionTruth === "open" && action !== "reconcile") return denied("bot_busy");

  if (action === "analyze") {
    if (bot.status !== "idle" || bot.pauseReason !== null || input.unresolvedDecisionCount !== 0) {
      return denied("bot_busy");
    }
    if (source !== "external_http" && source !== "internal_cycle") return denied("state_denied");
    return { allowed: true, requiredClaim: "idle_to_analyzing" };
  }

  if (action === "execute") {
    if (!decisionMatches(input)) return denied("decision_mismatch");
    if (!Number.isFinite(input.decision!.decidedAtMs)
      || input.nowMs - input.decision!.decidedAtMs > input.proposalExpiryMs) {
      return denied("decision_expired");
    }
    if (source === "external_http" && bot.status === "proposed") {
      return { allowed: true, requiredClaim: "proposed_decision_to_executing" };
    }
    if (source === "internal_cycle" && bot.status === "analyzing" && input.internalAnalysisClaimHeld) {
      return { allowed: true, requiredClaim: "analyzing_decision_to_executing" };
    }
    return denied("state_denied");
  }

  if (action === "proposal_skip" || action === "proposal_expire") {
    if (action === "proposal_skip" && source !== "external_http") return denied("state_denied");
    if (action === "proposal_expire" && source !== "state_reconciler") return denied("state_denied");
    if (bot.status !== "proposed" || !decisionMatches(input)) return denied("decision_mismatch");
    if (action === "proposal_expire"
      && input.nowMs - input.decision!.decidedAtMs <= input.proposalExpiryMs) {
      return denied("state_denied");
    }
    return { allowed: true, requiredClaim: "conditional_lifecycle_transition" };
  }

  if (action === "resume") {
    if (source !== "external_http" || bot.status !== "paused") return denied("state_denied");
    if (bot.pauseReason === "user_requested" && input.unresolvedDecisionCount === 0) {
      return { allowed: true, requiredClaim: "conditional_lifecycle_transition" };
    }
    if (bot.pauseReason === "position_unconfirmed_expired"
      && input.decision?.outcome === "aborted_order"
      && input.unresolvedDecisionCount === 0
      && positionTruth === "flat") {
      return { allowed: true, requiredClaim: "conditional_lifecycle_transition" };
    }
    return denied(NON_GENERIC_PAUSES.has(bot.pauseReason ?? "") ? "state_denied" : "malformed_authority");
  }

  if (action === "restart_trial") {
    if (source !== "external_http" || positionTruth !== "flat") {
      return denied("state_denied");
    }
    if (!bot.paperMode || bot.graduationState !== "failed") return denied("state_denied");
    const lifecycleEligible = bot.status === "idle"
      || bot.status === "stopped"
      || (bot.status === "paused" && bot.pauseReason === "user_requested");
    if (!lifecycleEligible) return denied("state_denied");
    if (input.unresolvedDecisionCount === 0) {
      return { allowed: true, requiredClaim: "conditional_lifecycle_transition" };
    }
    if (input.unresolvedDecisionCount !== 1 || !decisionMatches(input)) {
      return denied("decision_mismatch");
    }
    const decidedAtMs = input.decision!.decidedAtMs;
    if (!Number.isFinite(input.nowMs)
      || !Number.isFinite(decidedAtMs)
      || !Number.isFinite(input.proposalExpiryMs)
      || input.proposalExpiryMs < 0) {
      return denied("decision_mismatch");
    }
    if (input.nowMs - decidedAtMs <= input.proposalExpiryMs) return denied("state_denied");
    return {
      allowed: true,
      requiredClaim: "conditional_lifecycle_transition",
      decisionTerminalization: {
        decisionId: input.decision!.id,
        outcome: "aborted_trial_restart",
      },
    };
  }

  if (action === "reconcile") {
    if (source !== "state_reconciler") return denied("state_denied");
    return { allowed: true, requiredClaim: "conditional_lifecycle_transition" };
  }

  return denied("state_denied");
}
