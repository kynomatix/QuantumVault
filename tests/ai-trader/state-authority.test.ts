import { describe, expect, it } from "vitest";
import {
  AI_TRADER_PROPOSAL_EXPIRY_MS,
  evaluateAiTraderStateAuthority,
  type AiTraderAuthorityAction,
  type AiTraderAuthorityInput,
  type AiTraderAuthoritySource,
} from "../../server/ai-trader/state-authority";

const NOW = Date.parse("2026-08-14T00:00:00.000Z");
const STATUSES = ["idle", "proposed", "analyzing", "executing", "open", "paused", "stopped"] as const;
const ACTIONS: AiTraderAuthorityAction[] = [
  "analyze", "execute", "resume", "restart_trial", "proposal_skip",
  "proposal_expire", "close", "cancel", "reconcile",
];
const SOURCES: AiTraderAuthoritySource[] = [
  "external_http", "internal_cycle", "state_reconciler", "risk_reducing",
];

function input(overrides: Partial<AiTraderAuthorityInput> = {}): AiTraderAuthorityInput {
  return {
    action: "analyze",
    source: "external_http",
    bot: {
      id: "bot-1",
      status: "idle",
      pauseReason: null,
      graduationState: "failed",
      paperMode: true,
    },
    requestedDecisionId: null,
    decision: null,
    unresolvedDecisionCount: 0,
    positionTruth: "flat",
    internalAnalysisClaimHeld: false,
    nowMs: NOW,
    proposalExpiryMs: AI_TRADER_PROPOSAL_EXPIRY_MS,
    ...overrides,
  };
}

function decision(overrides: Partial<NonNullable<AiTraderAuthorityInput["decision"]>> = {}) {
  return { id: "d-1", botId: "bot-1", outcome: null, decidedAtMs: NOW - 1_000, ...overrides };
}

function matrixInput(
  status: typeof STATUSES[number],
  action: AiTraderAuthorityAction,
  source: AiTraderAuthoritySource,
): AiTraderAuthorityInput {
  const needsDecision = action === "execute" || action === "proposal_skip" || action === "proposal_expire";
  return input({
    action,
    source,
    bot: {
      id: "bot-1",
      status,
      pauseReason: status === "paused" ? "user_requested" : null,
      graduationState: "failed",
      paperMode: true,
    },
    requestedDecisionId: needsDecision ? "d-1" : null,
    decision: needsDecision
      ? decision({ decidedAtMs: action === "proposal_expire" ? NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 : NOW - 1_000 })
      : null,
    unresolvedDecisionCount: needsDecision ? 1 : 0,
    positionTruth: action === "close" || action === "cancel" ? "open" : "flat",
    internalAnalysisClaimHeld: action === "execute" && source === "internal_cycle",
  });
}

function expectedAllowed(status: typeof STATUSES[number], action: AiTraderAuthorityAction, source: AiTraderAuthoritySource): boolean {
  if (action === "close" || action === "cancel") return source === "risk_reducing";
  if (action === "analyze") return status === "idle" && (source === "external_http" || source === "internal_cycle");
  if (action === "execute") {
    return (status === "proposed" && source === "external_http")
      || (status === "analyzing" && source === "internal_cycle");
  }
  if (action === "resume") return status === "paused" && source === "external_http";
  if (action === "restart_trial") {
    return (status === "idle" || status === "paused" || status === "stopped") && source === "external_http";
  }
  if (action === "proposal_skip") return status === "proposed" && source === "external_http";
  if (action === "proposal_expire") return status === "proposed" && source === "state_reconciler";
  if (action === "reconcile") return source === "state_reconciler";
  return false;
}

describe("evaluateAiTraderStateAuthority", () => {
  it("exhaustively checks every known state/action/source pair", () => {
    for (const status of STATUSES) {
      for (const action of ACTIONS) {
        for (const source of SOURCES) {
          expect(
            evaluateAiTraderStateAuthority(matrixInput(status, action, source)).allowed,
            `${status}/${action}/${source}`,
          ).toBe(expectedAllowed(status, action, source));
        }
      }
    }
  });

  it("names the required claim for each admitted risk-increasing owner", () => {
    expect(evaluateAiTraderStateAuthority(matrixInput("idle", "analyze", "external_http")))
      .toEqual({ allowed: true, requiredClaim: "idle_to_analyzing" });
    expect(evaluateAiTraderStateAuthority(matrixInput("proposed", "execute", "external_http")))
      .toEqual({ allowed: true, requiredClaim: "proposed_decision_to_executing" });
    expect(evaluateAiTraderStateAuthority(matrixInput("analyzing", "execute", "internal_cycle")))
      .toEqual({ allowed: true, requiredClaim: "analyzing_decision_to_executing" });
  });

  it("red control: removing any exact-decision guard makes an admitted execute case fail this test", () => {
    const valid = matrixInput("proposed", "execute", "external_http");
    const guardDeletions: AiTraderAuthorityInput[] = [
      { ...valid, requestedDecisionId: "other" },
      { ...valid, decision: decision({ botId: "other" }) },
      { ...valid, decision: decision({ outcome: "flat" }) },
      { ...valid, unresolvedDecisionCount: 0 },
      { ...valid, unresolvedDecisionCount: 2 },
      { ...valid, decision: decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 }) },
    ];
    for (const candidate of guardDeletions) {
      expect(evaluateAiTraderStateAuthority(candidate).allowed).toBe(false);
    }
  });

  it("denies malformed overlays for new risk while preserving exposure-bound close/cancel", () => {
    const malformed = [
      { id: "bot-1", status: "idle", pauseReason: "user_requested", graduationState: "failed", paperMode: true },
      { id: "bot-1", status: "paused", pauseReason: null, graduationState: "failed", paperMode: true },
      { id: "bot-1", status: "future", pauseReason: null, graduationState: "failed", paperMode: true },
    ];
    for (const bot of malformed) {
      expect(evaluateAiTraderStateAuthority(input({ bot }))).toEqual({ allowed: false, reason: "malformed_authority" });
      expect(evaluateAiTraderStateAuthority(input({ action: "close", source: "risk_reducing", bot, positionTruth: "open" })))
        .toEqual({ allowed: true, requiredClaim: "none" });
      expect(evaluateAiTraderStateAuthority(input({ action: "cancel", source: "risk_reducing", bot, positionTruth: "read_failed" })))
        .toEqual({ allowed: true, requiredClaim: "none" });
    }
  });

  it("keeps position uncertainty ahead of every non-risk-reducing action", () => {
    for (const action of ACTIONS.filter((candidate) => candidate !== "close" && candidate !== "cancel")) {
      expect(evaluateAiTraderStateAuthority(input({ action, positionTruth: "read_failed" })).allowed).toBe(false);
      expect(evaluateAiTraderStateAuthority(input({ action, positionTruth: "maybe_open" })).allowed).toBe(false);
    }
  });

  it("requires the source-specific proposal owner and strict expiry boundary", () => {
    expect(evaluateAiTraderStateAuthority(matrixInput("proposed", "proposal_skip", "state_reconciler")).allowed).toBe(false);
    expect(evaluateAiTraderStateAuthority(matrixInput("proposed", "proposal_expire", "external_http")).allowed).toBe(false);
    expect(evaluateAiTraderStateAuthority(input({
      ...matrixInput("proposed", "proposal_expire", "state_reconciler"),
      decision: decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS }),
    })).allowed).toBe(false);
  });

  it("requires zero unresolved decisions for every resumable pause class", () => {
    expect(evaluateAiTraderStateAuthority(matrixInput("paused", "resume", "external_http")).allowed).toBe(true);
    expect(evaluateAiTraderStateAuthority(input({
      action: "resume",
      source: "external_http",
      bot: {
        id: "bot-1",
        status: "paused",
        pauseReason: "position_unconfirmed_expired",
        graduationState: "failed",
        paperMode: true,
      },
      decision: decision({ outcome: "aborted_order" }),
      unresolvedDecisionCount: 1,
    })).allowed).toBe(false);
  });

  it("admits only the exact flat decision-clean consecutive-loss owner resume", () => {
    const consecutiveLossResume = input({
      action: "resume",
      source: "external_http",
      bot: {
        id: "bot-1",
        status: "paused",
        pauseReason: "consecutive_losses",
        graduationState: "in_trial",
        paperMode: true,
      },
      unresolvedDecisionCount: 0,
      positionTruth: "flat",
    });
    expect(evaluateAiTraderStateAuthority(consecutiveLossResume)).toEqual({
      allowed: true,
      requiredClaim: "conditional_lifecycle_transition",
    });
    for (const candidate of [
      { ...consecutiveLossResume, source: "internal_cycle" as const },
      { ...consecutiveLossResume, unresolvedDecisionCount: 1 },
      { ...consecutiveLossResume, positionTruth: "open" as const },
      { ...consecutiveLossResume, positionTruth: "maybe_open" as const },
      { ...consecutiveLossResume, positionTruth: "read_failed" as const },
    ]) {
      expect(evaluateAiTraderStateAuthority(candidate).allowed).toBe(false);
    }
  });

  it("classifies close-policy pauses explicitly without widening generic resume", () => {
    for (const pauseReason of ["malfunction_ceiling", "daily_loss_breaker"]) {
      expect(evaluateAiTraderStateAuthority(input({
        action: "resume",
        bot: {
          id: "bot-1", status: "paused", pauseReason,
          graduationState: "in_trial", paperMode: true,
        },
      }))).toEqual({ allowed: false, reason: "state_denied" });
    }
    expect(evaluateAiTraderStateAuthority(input({
      action: "resume",
      bot: {
        id: "bot-1", status: "paused", pauseReason: "future_pause_reason",
        graduationState: "in_trial", paperMode: true,
      },
    }))).toEqual({ allowed: false, reason: "malformed_authority" });
  });

  it("admits exactly one expired orphan only with its exact terminalization identity", () => {
    const verdict = evaluateAiTraderStateAuthority(input({
      action: "restart_trial",
      requestedDecisionId: "d-1",
      decision: decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 }),
      unresolvedDecisionCount: 1,
    }));
    expect(verdict).toEqual({
      allowed: true,
      requiredClaim: "conditional_lifecycle_transition",
      decisionTerminalization: {
        decisionId: "d-1",
        outcome: "aborted_trial_restart",
      },
    });
  });

  it("keeps fresh duplicate mismatched and malformed orphan decisions denied", () => {
    const expired = decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 });
    const candidates: AiTraderAuthorityInput[] = [
      input({
        action: "restart_trial", requestedDecisionId: "d-1",
        decision: decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS }),
        unresolvedDecisionCount: 1,
      }),
      input({ action: "restart_trial", requestedDecisionId: "d-1", decision: expired, unresolvedDecisionCount: 2 }),
      input({ action: "restart_trial", requestedDecisionId: "other", decision: expired, unresolvedDecisionCount: 1 }),
      input({
        action: "restart_trial", requestedDecisionId: "d-1",
        decision: decision({ botId: "other", decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 }),
        unresolvedDecisionCount: 1,
      }),
      input({
        action: "restart_trial", requestedDecisionId: "d-1",
        decision: decision({ decidedAtMs: Number.NaN }), unresolvedDecisionCount: 1,
      }),
    ];
    for (const candidate of candidates) {
      expect(evaluateAiTraderStateAuthority(candidate).allowed).toBe(false);
    }
  });

  it("restricts trial restart to failed paper bots with flat truth", () => {
    const base = input({ action: "restart_trial" });
    expect(evaluateAiTraderStateAuthority(base).allowed).toBe(true);
    expect(evaluateAiTraderStateAuthority({
      ...base, bot: { ...base.bot, graduationState: "in_trial" },
    }).allowed).toBe(false);
    expect(evaluateAiTraderStateAuthority({
      ...base, bot: { ...base.bot, paperMode: false },
    }).allowed).toBe(false);
    expect(evaluateAiTraderStateAuthority({ ...base, positionTruth: "maybe_open" }).allowed).toBe(false);
  });
});
