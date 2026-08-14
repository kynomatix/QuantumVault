import { describe, expect, it } from "vitest";
import {
  AI_TRADER_PROPOSAL_EXPIRY_MS,
  evaluateAiTraderStateAuthority,
  type AiTraderAuthorityInput,
} from "../../server/ai-trader/state-authority";

const NOW = Date.parse("2026-08-14T00:00:00.000Z");

function input(overrides: Partial<AiTraderAuthorityInput> = {}): AiTraderAuthorityInput {
  return {
    action: "analyze",
    source: "external_http",
    bot: { id: "bot-1", status: "idle", pauseReason: null },
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

describe("evaluateAiTraderStateAuthority", () => {
  it("admits only a clean idle analysis and names its CAS", () => {
    expect(evaluateAiTraderStateAuthority(input())).toEqual({ allowed: true, requiredClaim: "idle_to_analyzing" });
    expect(evaluateAiTraderStateAuthority(input({ unresolvedDecisionCount: 1 }))).toMatchObject({ allowed: false });
    expect(evaluateAiTraderStateAuthority(input({ positionTruth: "read_failed" }))).toEqual({ allowed: false, reason: "position_uncertain" });
  });

  it("distinguishes external proposed and internal analyzing execution ownership", () => {
    const common = { action: "execute" as const, requestedDecisionId: "d-1", decision: decision(), unresolvedDecisionCount: 1 };
    expect(evaluateAiTraderStateAuthority(input({ ...common, bot: { id: "bot-1", status: "proposed", pauseReason: null } })))
      .toEqual({ allowed: true, requiredClaim: "proposed_decision_to_executing" });
    expect(evaluateAiTraderStateAuthority(input({
      ...common,
      source: "internal_cycle",
      bot: { id: "bot-1", status: "analyzing", pauseReason: null },
      internalAnalysisClaimHeld: true,
    }))).toEqual({ allowed: true, requiredClaim: "analyzing_decision_to_executing" });
  });

  it("denies mismatched, duplicate, resolved and expired decisions", () => {
    const common = {
      action: "execute" as const,
      bot: { id: "bot-1", status: "proposed", pauseReason: null },
      requestedDecisionId: "d-1",
      unresolvedDecisionCount: 1,
    };
    expect(evaluateAiTraderStateAuthority(input({ ...common, decision: decision({ botId: "other" }) }))).toEqual({ allowed: false, reason: "decision_mismatch" });
    expect(evaluateAiTraderStateAuthority(input({ ...common, decision: decision(), unresolvedDecisionCount: 2 }))).toEqual({ allowed: false, reason: "decision_mismatch" });
    expect(evaluateAiTraderStateAuthority(input({ ...common, decision: decision({ outcome: "flat" }) }))).toEqual({ allowed: false, reason: "decision_mismatch" });
    expect(evaluateAiTraderStateAuthority(input({ ...common, decision: decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 }) })))
      .toEqual({ allowed: false, reason: "decision_expired" });
  });

  it("allows proposal skip and expiry only for the exact unresolved proposal", () => {
    const common = {
      source: "state_reconciler" as const,
      bot: { id: "bot-1", status: "proposed", pauseReason: null },
      requestedDecisionId: "d-1",
      decision: decision({ decidedAtMs: NOW - AI_TRADER_PROPOSAL_EXPIRY_MS - 1 }),
      unresolvedDecisionCount: 1,
    };
    expect(evaluateAiTraderStateAuthority(input({ ...common, action: "proposal_expire" }))).toMatchObject({ allowed: true });
    expect(evaluateAiTraderStateAuthority(input({ ...common, action: "proposal_skip", source: "external_http" }))).toMatchObject({ allowed: true });
  });

  it("permits ordinary resume only for a clean user pause", () => {
    expect(evaluateAiTraderStateAuthority(input({
      action: "resume",
      bot: { id: "bot-1", status: "paused", pauseReason: "user_requested" },
    }))).toMatchObject({ allowed: true });
    for (const pauseReason of ["policy_hmac_mismatch", "position_unconfirmed", "bracket_failed", "liquidation", "daily_loss_breaker", "reconcile_orphan_position"]) {
      expect(evaluateAiTraderStateAuthority(input({ action: "resume", bot: { id: "bot-1", status: "paused", pauseReason } })))
        .toMatchObject({ allowed: false });
    }
  });

  it("rejects malformed status/pause combinations and unknown states", () => {
    expect(evaluateAiTraderStateAuthority(input({ bot: { id: "bot-1", status: "idle", pauseReason: "user_requested" } })))
      .toEqual({ allowed: false, reason: "malformed_authority" });
    expect(evaluateAiTraderStateAuthority(input({ bot: { id: "bot-1", status: "future", pauseReason: null } })))
      .toEqual({ allowed: false, reason: "malformed_authority" });
  });

  it("keeps close/cancel risk-reducing and exposure-bound", () => {
    expect(evaluateAiTraderStateAuthority(input({ action: "close", source: "risk_reducing", positionTruth: "open" })))
      .toEqual({ allowed: true, requiredClaim: "none" });
    expect(evaluateAiTraderStateAuthority(input({ action: "cancel", source: "risk_reducing", positionTruth: "read_failed" })))
      .toEqual({ allowed: true, requiredClaim: "none" });
    expect(evaluateAiTraderStateAuthority(input({ action: "close", source: "external_http", positionTruth: "open" })))
      .toMatchObject({ allowed: false });
  });
});
