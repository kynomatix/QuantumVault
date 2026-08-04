import Decimal from "decimal.js";

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
