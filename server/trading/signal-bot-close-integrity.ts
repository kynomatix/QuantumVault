import Decimal from "decimal.js";
import type { ClassifiedSignal } from "./signal-classifier";

export type SignalBotCloseOutcome =
  | "executed"
  | "already_flat"
  | "position_unavailable"
  | "partial"
  | "executed_state_unavailable";

const CLOSE_OUTCOME_HTTP_STATUS: Record<SignalBotCloseOutcome, number> = {
  executed: 200,
  already_flat: 409,
  position_unavailable: 503,
  partial: 200,
  executed_state_unavailable: 500,
};

export function buildSignalBotCloseResponse<T extends Record<string, unknown>>(
  closeOutcome: SignalBotCloseOutcome,
  payload: T,
): { statusCode: number; body: T & { closeOutcome: SignalBotCloseOutcome } } {
  return {
    statusCode: CLOSE_OUTCOME_HTTP_STATUS[closeOutcome],
    body: { ...payload, closeOutcome },
  };
}

export interface ConfirmedPositionCloseInput {
  realizedPnlDelta: number;
  feeDelta: number;
  tradeId: string;
  closedAt: Date;
}

export interface ExistingPositionAccounting {
  avgEntryPrice?: string | null;
  realizedPnl?: string | null;
  totalFees?: string | null;
}

/**
 * Produce the position values written when an authoritative venue read has
 * confirmed a full close. The caller owns transactionality and row locking;
 * this helper owns exact decimal accumulation and the invariant that a full
 * close retains the historical entry reference while zeroing exposure/basis.
 */
export function buildConfirmedFlatPosition(
  existing: ExistingPositionAccounting | undefined,
  input: ConfirmedPositionCloseInput,
): {
  baseSize: string;
  avgEntryPrice: string;
  costBasis: string;
  realizedPnl: string;
  totalFees: string;
  lastTradeId: string;
  lastTradeAt: Date;
} {
  return {
    baseSize: "0",
    avgEntryPrice: existing?.avgEntryPrice ?? "0",
    costBasis: "0",
    realizedPnl: new Decimal(existing?.realizedPnl ?? "0")
      .plus(input.realizedPnlDelta)
      .toFixed(6),
    totalFees: new Decimal(existing?.totalFees ?? "0")
      .plus(input.feeDelta)
      .toFixed(6),
    lastTradeId: input.tradeId,
    lastTradeAt: input.closedAt,
  };
}

export interface SignalBotFlipPosition {
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  source: "venue_authoritative" | "durable_risk_reducing_fallback";
}

export type SignalBotFlipAuthorityRead =
  | { kind: "authoritative_flat" }
  | { kind: "position"; position: SignalBotFlipPosition }
  | { kind: "unavailable"; reason: string };

export interface SignalBotFlipCloseExecution {
  success: boolean;
  signature: string | null;
  fillPrice?: number;
  executionMethod?: string;
  error?: string;
  context?: Record<string, unknown>;
}

export type SignalBotFlipCloseLeg =
  | { kind: "authoritative_flat" }
  | { kind: "executed"; signature: string; position: SignalBotFlipPosition; execution: SignalBotFlipCloseExecution }
  | { kind: "position_unavailable"; reason: string }
  | { kind: "execution_rejected"; reason: string }
  | { kind: "no_signature"; reason: string }
  | { kind: "partial"; remainingSide: "LONG" | "SHORT"; remainingSize: number }
  | { kind: "post_close_unreadable"; reason: string }
  | { kind: "finalization_failed"; signature: string; reason: string };

export type SignalBotFlipOpenRejectionCategory =
  | "direction"
  | "funding"
  | "sizing"
  | "admission"
  | "execution";

export type SignalBotFlipOpenLeg =
  | { kind: "not_evaluated"; reason: string }
  | { kind: "admitted" }
  | { kind: "rejected"; category: SignalBotFlipOpenRejectionCategory; reason: string }
  | { kind: "deferred"; reason: string }
  | { kind: "executed"; signature: string | null };

export interface SignalBotFlipDisposition {
  close: SignalBotFlipCloseLeg;
  open: SignalBotFlipOpenLeg;
}

export interface ResolveSignalBotFlipInput {
  classifiedSignal: ClassifiedSignal & { type: "FLIP" };
  readAuthority(stage: "initial" | "post_close"): Promise<SignalBotFlipAuthorityRead>;
  executeReduceOnlyClose(position: SignalBotFlipPosition): Promise<SignalBotFlipCloseExecution>;
  finalizeConfirmedClose(
    position: SignalBotFlipPosition,
    execution: SignalBotFlipCloseExecution & { signature: string },
  ): Promise<void>;
}

/**
 * Resolve the risk-reducing leg of a reversal before the caller is allowed to
 * consider its risk-increasing leg.  Venue FLAT is represented explicitly;
 * read failure can only become `position_unavailable`, never FLAT.
 */
export async function resolveSignalBotFlipCloseThenOpen(
  input: ResolveSignalBotFlipInput,
): Promise<SignalBotFlipDisposition> {
  if (input.classifiedSignal.type !== "FLIP") {
    throw new Error("FLIP resolver requires the classifier's FLIP verdict");
  }

  const initial = await input.readAuthority("initial");
  if (initial.kind === "authoritative_flat") {
    return { close: { kind: "authoritative_flat" }, open: { kind: "admitted" } };
  }
  if (initial.kind === "unavailable") {
    return {
      close: { kind: "position_unavailable", reason: initial.reason },
      open: { kind: "not_evaluated", reason: "position_unavailable" },
    };
  }

  let execution: SignalBotFlipCloseExecution;
  try {
    execution = await input.executeReduceOnlyClose(initial.position);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      close: { kind: "execution_rejected", reason },
      open: { kind: "not_evaluated", reason: "close_execution_rejected" },
    };
  }
  if (!execution.success) {
    return {
      close: { kind: "execution_rejected", reason: execution.error ?? "reduce-only close rejected" },
      open: { kind: "not_evaluated", reason: "close_execution_rejected" },
    };
  }
  if (!execution.signature) {
    return {
      close: { kind: "no_signature", reason: "reduce-only close returned no signature" },
      open: { kind: "not_evaluated", reason: "close_signature_missing" },
    };
  }

  let confirmed: SignalBotFlipAuthorityRead;
  try {
    confirmed = await input.readAuthority("post_close");
  } catch (error) {
    confirmed = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (confirmed.kind === "unavailable") {
    return {
      close: { kind: "post_close_unreadable", reason: confirmed.reason },
      open: { kind: "not_evaluated", reason: "post_close_position_unreadable" },
    };
  }
  if (confirmed.kind === "position") {
    return {
      close: {
        kind: "partial",
        remainingSide: confirmed.position.side,
        remainingSize: confirmed.position.size,
      },
      open: { kind: "not_evaluated", reason: "close_left_residual_position" },
    };
  }

  const signedExecution = execution as SignalBotFlipCloseExecution & { signature: string };
  try {
    await input.finalizeConfirmedClose(initial.position, signedExecution);
  } catch (error) {
    return {
      close: {
        kind: "finalization_failed",
        signature: signedExecution.signature,
        reason: error instanceof Error ? error.message : String(error),
      },
      open: { kind: "not_evaluated", reason: "confirmed_close_finalization_failed" },
    };
  }

  return {
    close: {
      kind: "executed",
      signature: signedExecution.signature,
      position: initial.position,
      execution: signedExecution,
    },
    open: { kind: "admitted" },
  };
}

export function rejectSignalBotFlipOpen(
  disposition: SignalBotFlipDisposition,
  category: SignalBotFlipOpenRejectionCategory,
  reason: string,
): SignalBotFlipDisposition {
  if (disposition.open.kind !== "admitted") return disposition;
  return { ...disposition, open: { kind: "rejected", category, reason } };
}

export function deferSignalBotFlipOpen(
  disposition: SignalBotFlipDisposition,
  reason: string,
): SignalBotFlipDisposition {
  if (disposition.open.kind !== "admitted") return disposition;
  return { ...disposition, open: { kind: "deferred", reason } };
}

export function markSignalBotFlipOpenExecuted(
  disposition: SignalBotFlipDisposition,
  signature: string | null,
): SignalBotFlipDisposition {
  if (disposition.open.kind !== "admitted") return disposition;
  return { ...disposition, open: { kind: "executed", signature } };
}
