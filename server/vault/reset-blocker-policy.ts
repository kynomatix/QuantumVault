import type { BorrowOperation, BorrowPosition } from "@shared/schema";
import { PublicKey } from "@solana/web3.js";

/**
 * Terminal allowlists shared by the ordinary reset preflight and the
 * transaction-bound reset finalizer. Unknown/future/null statuses block by
 * construction; never replace these with a list of statuses believed active.
 */
export const TERMINAL_POSITION_STATUSES: ReadonlySet<string> = new Set(["closed", "failed"]);

export const TERMINAL_OPERATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "completed",
  "failed",
]);

export interface ResetTradingBotProjection {
  driftSubaccountId: number | null;
  protocolSubaccountId: string | null;
}

export interface ResetAiTraderProjection {
  protocolSubaccountId: string | null;
}

export interface ResetProtocolSubaccountProjection {
  protocolSubaccountId: string | null;
  agentPublicKey: string | null;
  status: string | null;
  subaccountKeyEncryptedV3: string | null;
  lastVerifiedEmptyAt: Date | null;
}

export interface ResetOrphanProjection {
  agentPublicKey: string | null;
}

export interface ResetBlockerRows {
  classicPositions: BorrowPosition[];
  loopPositions: BorrowPosition[];
  operations: BorrowOperation[];
  tradingBots: ResetTradingBotProjection[];
  aiTraderBots: ResetAiTraderProjection[];
  protocolSubaccounts: ResetProtocolSubaccountProjection[];
  orphanedSubaccounts: ResetOrphanProjection[];
  observedAgentPublicKey: string;
}

export type ResetBlockerReason =
  | "active_vault_state"
  | "agent_authority_custody"
  | "custody_transition_in_flight"
  | "vault_state_unreadable";

export type ResetBlockerAssessment =
  | { blocked: false }
  | { blocked: true; reason: ResetBlockerReason };

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalAgentPublicKey(value: unknown): value is string {
  if (!hasText(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/** Pure row assessment so transaction-bound reads cannot drift from checkpoint 1. */
export function assessResetBlockerRows(rows: ResetBlockerRows): ResetBlockerAssessment {
  const hasActivePosition = [...rows.classicPositions, ...rows.loopPositions].some(
    (p) => !TERMINAL_POSITION_STATUSES.has(String((p as { status?: unknown }).status ?? "")),
  );
  const hasActiveOperation = rows.operations.some(
    (o) => !TERMINAL_OPERATION_STATUSES.has(String((o as { status?: unknown }).status ?? "")),
  );
  if (hasActivePosition || hasActiveOperation) {
    return { blocked: true, reason: "active_vault_state" };
  }

  for (const bot of rows.tradingBots) {
    const hasLinkage = (
      bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined
    ) || hasText(bot.protocolSubaccountId);
    if (!hasLinkage) continue;

    // A per-bot key does not make the linkage independent of the agent-wallet
    // generation. Auto-withdraw, delete, unsubscribe, and recovery paths can
    // still return value through the agent/main-account namespace. The link
    // itself therefore remains custody evidence until it is durably removed.
    return { blocked: true, reason: "agent_authority_custody" };
  }

  for (const bot of rows.aiTraderBots) {
    // AI settlement/recovery has the same return-to-agent dependency. Do not
    // infer reset safety merely from an independently encrypted bot key.
    if (hasText(bot.protocolSubaccountId)) {
      return { blocked: true, reason: "agent_authority_custody" };
    }
  }

  for (const account of rows.protocolSubaccounts) {
    // Nullable, unlinked Phase-B scaffolding is not evidence of custody. Apply
    // the generation fail-closed rule only once a concrete venue identity is
    // linked to the row.
    if (!hasText(account.protocolSubaccountId)) continue;
    if (!isCanonicalAgentPublicKey(account.agentPublicKey)) {
      return { blocked: true, reason: "agent_authority_custody" };
    }
    if (account.agentPublicKey !== rows.observedAgentPublicKey) continue;

    switch (account.status) {
      case "reserving":
        return { blocked: true, reason: "custody_transition_in_flight" };
      case "stuck_funds":
        return { blocked: true, reason: "agent_authority_custody" };
      case "active":
        // An active registry row can still be swept or settled back through
        // the retiring agent generation, even when its external key is kept.
        return { blocked: true, reason: "agent_authority_custody" };
      case "spare":
        if (!hasText(account.subaccountKeyEncryptedV3) || account.lastVerifiedEmptyAt == null) {
          return { blocked: true, reason: "agent_authority_custody" };
        }
        break;
      default:
        return { blocked: true, reason: "custody_transition_in_flight" };
    }
  }

  for (const orphan of rows.orphanedSubaccounts) {
    if (!isCanonicalAgentPublicKey(orphan.agentPublicKey)) {
      return { blocked: true, reason: "agent_authority_custody" };
    }
    if (orphan.agentPublicKey === rows.observedAgentPublicKey) {
      return { blocked: true, reason: "agent_authority_custody" };
    }
  }

  return { blocked: false };
}
