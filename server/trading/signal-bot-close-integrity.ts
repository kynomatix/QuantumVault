import Decimal from "decimal.js";
import type { FeeRateQuoteResult } from "../protocol/adapter";
import type { TradeRecord } from "../protocol/protocol-types";
import type { ClassifiedSignal } from "./signal-classifier";

export type CloseFeeEvidence =
  | {
      kind: "venue_exact";
      amount: number;
      protocol: "pacifica";
    }
  | {
      kind: "rate_estimate";
      amount: number;
      notional: number;
      rate: number;
      protocol: string;
      provenance: string;
      observedAt: number;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

export interface ClassifyCloseFeeEvidenceInput {
  protocol: string;
  venueFee?: number | null;
  notional?: number | null;
  rateQuote?: FeeRateQuoteResult | null;
}

/**
 * Classify fee evidence without ever turning absence into zero. Pacifica is
 * the only adapter whose returned OrderResult.fee has proven venue-exact
 * semantics. Other protocols may still use a separately validated quote as
 * an explicitly labelled estimate.
 */
export function classifyCloseFeeEvidence(
  input: ClassifyCloseFeeEvidenceInput,
): CloseFeeEvidence {
  const protocol = typeof input.protocol === "string" ? input.protocol.trim().toLowerCase() : "";
  const venueFeePresent = input.venueFee !== null && input.venueFee !== undefined;
  const venueFeeValid = venueFeePresent
    && typeof input.venueFee === "number"
    && Number.isFinite(input.venueFee)
    && input.venueFee >= 0;

  if (venueFeeValid && protocol === "pacifica") {
    return { kind: "venue_exact", amount: input.venueFee as number, protocol: "pacifica" };
  }

  const quote = input.rateQuote;
  const notional = input.notional;
  if (
    quote?.availability === "available"
    && typeof notional === "number"
    && Number.isFinite(notional)
    && notional >= 0
  ) {
    return {
      kind: "rate_estimate",
      amount: notional * quote.effectiveRate,
      notional,
      rate: quote.effectiveRate,
      protocol: quote.protocol,
      provenance: quote.provenance,
      observedAt: quote.observedAt,
    };
  }

  if (venueFeePresent && !venueFeeValid) {
    return { kind: "unavailable", reason: "invalid_venue_fee" };
  }
  if (venueFeeValid && protocol !== "pacifica") {
    return { kind: "unavailable", reason: `unproven_exact_fee_semantics:${protocol || "unknown"}` };
  }
  if (quote?.availability === "unavailable") {
    return { kind: "unavailable", reason: `fee_rate_${quote.reason}` };
  }
  if (typeof notional !== "number" || !Number.isFinite(notional) || notional < 0) {
    return { kind: "unavailable", reason: "close_notional_unavailable" };
  }
  return { kind: "unavailable", reason: "fee_evidence_unavailable" };
}

export function closeFeeAmount(evidence: CloseFeeEvidence): number | null {
  return evidence.kind === "unavailable" ? null : evidence.amount;
}

/** Explicit DB-bound values: unavailable is SQL NULL, never omitted/default 0. */
export function closeFeePersistence(
  evidence: CloseFeeEvidence,
  pnl: number | null,
): {
  fee: string | null;
  pnl: string | null;
  feeDelta: number;
  pnlDelta: number;
  feeEvidence: CloseFeeEvidence;
} {
  const fee = closeFeeAmount(evidence);
  return {
    fee: fee === null ? null : String(fee),
    pnl: pnl === null ? null : String(pnl),
    feeDelta: fee ?? 0,
    pnlDelta: pnl ?? 0,
    feeEvidence: evidence,
  };
}

export type ReconcilerCloseAccountingEvidence =
  | {
      kind: "venue_exact";
      fillPrice: number;
      pnl: number;
      fee: number;
      protocolFillId: string;
      observedAt: number;
    }
  | {
      kind: "unavailable";
      reason: "venue_fill_unattributed" | "liquidation_fill_unattributed";
      observedAt: number;
      observationPrice: number | null;
    };

/**
 * A confirmed-flat venue position proves exposure, not execution money truth.
 * Only an attributed venue fill may authorize numeric close price/PnL/fee.
 */
export function classifyReconcilerCloseAccounting(input: {
  protocolFillId?: string | null;
  fillPrice?: number | null;
  pnl?: number | null;
  fee?: number | null;
  observedAt: number;
  observationPrice?: number | null;
  liquidation?: boolean;
}): ReconcilerCloseAccountingEvidence {
  const exact = typeof input.protocolFillId === "string" && input.protocolFillId.trim().length > 0
    && typeof input.fillPrice === "number" && Number.isFinite(input.fillPrice) && input.fillPrice > 0
    && typeof input.pnl === "number" && Number.isFinite(input.pnl)
    && typeof input.fee === "number" && Number.isFinite(input.fee) && input.fee >= 0;
  if (exact) {
    return {
      kind: "venue_exact",
      fillPrice: input.fillPrice as number,
      pnl: input.pnl as number,
      fee: input.fee as number,
      protocolFillId: input.protocolFillId!.trim(),
      observedAt: input.observedAt,
    };
  }
  const observationPrice = typeof input.observationPrice === "number"
    && Number.isFinite(input.observationPrice) && input.observationPrice > 0
    ? input.observationPrice
    : null;
  return {
    kind: "unavailable",
    reason: input.liquidation ? "liquidation_fill_unattributed" : "venue_fill_unattributed",
    observedAt: input.observedAt,
    observationPrice,
  };
}

export function isReconcilerAccountingIncompletePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const closeAccounting = (payload as { closeAccounting?: unknown }).closeAccounting;
  return !!closeAccounting
    && typeof closeAccounting === "object"
    && (closeAccounting as { kind?: unknown }).kind === "unavailable";
}

export type SignalBotCloseOutcome =
  | "executed"
  | "already_flat"
  | "position_unavailable"
  | "partial"
  | "accounting_incomplete"
  | "confirmation_pending"
  | "executed_state_unavailable";

const CLOSE_OUTCOME_HTTP_STATUS: Record<SignalBotCloseOutcome, number> = {
  executed: 200,
  already_flat: 409,
  position_unavailable: 503,
  partial: 200,
  accounting_incomplete: 200,
  confirmation_pending: 202,
  executed_state_unavailable: 500,
};

export interface SignalBotCloseFillConfirmation {
  fillPrice: number;
  filledSize: number;
  fee: number;
  realizedPnl: number | null;
  fillIds: string[];
  fillTimestampMs: number;
}

function normalizedCloseMarket(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Aggregate only venue rows that can authoritatively represent the expected
 * close. Pacifica's semantic event kind wins; adapters without that optional
 * detail retain the legacy inverse-side fallback.
 */
export function summarizeSignalBotCloseFills(input: {
  trades: TradeRecord[];
  market: string;
  openSide: "long" | "short";
  expectedSize: number;
  notBeforeMs: number;
}): SignalBotCloseFillConfirmation | null {
  if (!Number.isFinite(input.expectedSize) || input.expectedSize <= 0
      || !Number.isFinite(input.notBeforeMs)) return null;
  const closeSide = input.openSide === "long" ? "short" : "long";
  const closeKind = input.openSide === "long" ? "close_long" : "close_short";
  const candidates = input.trades
    .filter((trade) => normalizedCloseMarket(trade.internalSymbol) === normalizedCloseMarket(input.market))
    .filter((trade) => trade.timestamp >= input.notBeforeMs)
    .filter((trade) => trade.venueEventKind ? trade.venueEventKind === closeKind : trade.side === closeSide)
    .sort((left, right) => left.timestamp - right.timestamp);

  let filledSize = 0;
  let weightedPrice = 0;
  let fee = 0;
  let realizedPnl = 0;
  let hasExactPnl = true;
  const fillIds: string[] = [];
  let fillTimestampMs = 0;
  for (const trade of candidates) {
    if (!Number.isFinite(trade.size) || trade.size <= 0
        || !Number.isFinite(trade.price) || trade.price <= 0
        || !Number.isFinite(trade.fee) || trade.fee < 0) return null;
    filledSize += trade.size;
    weightedPrice += trade.price * trade.size;
    fee += trade.fee;
    if (trade.realizedPnl === undefined || !Number.isFinite(trade.realizedPnl)) {
      hasExactPnl = false;
    } else {
      realizedPnl += trade.realizedPnl;
    }
    fillIds.push(trade.tradeId);
    fillTimestampMs = Math.max(fillTimestampMs, trade.timestamp);
    if (filledSize >= input.expectedSize * 0.95) break;
  }
  if (filledSize < input.expectedSize * 0.95 || weightedPrice <= 0 || fillIds.length === 0) return null;
  return {
    fillPrice: weightedPrice / filledSize,
    filledSize,
    fee,
    realizedPnl: hasExactPnl ? realizedPnl : null,
    fillIds,
    fillTimestampMs,
  };
}

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
  /** Reconciler closes retain the entry epoch used by the no-fill dedup key. */
  preservePositionEpoch?: boolean;
}

export interface ExistingPositionAccounting {
  avgEntryPrice?: string | null;
  realizedPnl?: string | null;
  totalFees?: string | null;
  lastTradeId?: string | null;
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
    // Only the reconciler's no-fill identity is tied to the entry epoch. Other
    // confirmed-close paths retain their established close-row identity.
    lastTradeId: input.preservePositionEpoch
      ? existing?.lastTradeId ?? input.tradeId
      : input.tradeId,
    lastTradeAt: input.closedAt,
  };
}

/** Flatten proven exposure while preserving the last exact money totals. */
export function buildAccountingIncompleteFlatPosition(
  existing: ExistingPositionAccounting | undefined,
  input: { tradeId: string; closedAt: Date },
): ReturnType<typeof buildConfirmedFlatPosition> {
  return {
    baseSize: "0",
    avgEntryPrice: existing?.avgEntryPrice ?? "0",
    costBasis: "0",
    realizedPnl: new Decimal(existing?.realizedPnl ?? "0").toFixed(6),
    totalFees: new Decimal(existing?.totalFees ?? "0").toFixed(6),
    // An incomplete close proves flat exposure but not a new economic epoch.
    // Preserve the open position's durable entry identity so a false flatten,
    // venue resync and later real close all derive the same no-fill dedup key.
    lastTradeId: existing?.lastTradeId ?? input.tradeId,
    lastTradeAt: input.closedAt,
  };
}

/**
 * Apply later venue money truth without touching current exposure. A bot may
 * have reopened the same market before remediation runs, so this helper owns
 * only the cumulative money columns; base size, basis and epoch identity stay
 * under the current position writer.
 */
export function buildRemediatedPositionAccounting(
  existing: ExistingPositionAccounting | undefined,
  input: { realizedPnlDelta: number; feeDelta: number },
): { realizedPnl: string; totalFees: string } {
  return {
    realizedPnl: new Decimal(existing?.realizedPnl ?? "0")
      .plus(input.realizedPnlDelta)
      .toFixed(6),
    totalFees: new Decimal(existing?.totalFees ?? "0")
      .plus(input.feeDelta)
      .toFixed(6),
  };
}

export interface ConfirmedPartialPositionInput {
  residualBaseSize: number;
  residualEntryPrice: number;
  realizedPnlDelta: number;
  feeDelta: number;
  tradeId: string;
  closedAt: Date;
}

/**
 * Build the exact position values persisted after fresh venue authority proves
 * the residual state of a signed partial close. The caller owns row locking
 * and epoch comparison; this helper owns finite-value validation and Decimal
 * accounting so an unavailable read can never become calculated position
 * truth.
 */
export function buildConfirmedPartialPosition(
  existing: ExistingPositionAccounting | undefined,
  input: ConfirmedPartialPositionInput,
): {
  baseSize: string;
  avgEntryPrice: string;
  costBasis: string;
  realizedPnl: string;
  totalFees: string;
  lastTradeId: string;
  lastTradeAt: Date;
} {
  if (![input.residualBaseSize, input.residualEntryPrice, input.realizedPnlDelta, input.feeDelta]
    .every(Number.isFinite)
      || input.residualEntryPrice < 0 || input.feeDelta < 0
      || !(input.closedAt instanceof Date) || !Number.isFinite(input.closedAt.getTime())) {
    throw new Error("confirmed_partial_position_invalid_input");
  }
  const residual = new Decimal(input.residualBaseSize);
  const entry = residual.isZero()
    ? new Decimal(existing?.avgEntryPrice ?? "0")
    : new Decimal(input.residualEntryPrice);
  if (!residual.isZero() && entry.lte(0)) {
    throw new Error("confirmed_partial_position_invalid_entry_price");
  }
  return {
    baseSize: residual.toFixed(8),
    avgEntryPrice: entry.toFixed(6),
    costBasis: residual.abs().times(entry).toFixed(6),
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

export interface PartialClosePositionAuthority {
  size: number;
  side: "LONG" | "SHORT" | "FLAT";
  entryPrice: number;
}

export const PARTIAL_CLOSE_BASE_DUST = 0.0001;

export function confirmedPartialPositionEpochMatches(input: {
  actualBaseSize: string;
  actualLastTradeId: string | null;
  expectedBaseSize: string;
  expectedLastTradeId: string | null;
}): boolean {
  try {
    return new Decimal(input.actualBaseSize).toFixed(8) === new Decimal(input.expectedBaseSize).toFixed(8)
      && input.actualLastTradeId === input.expectedLastTradeId;
  } catch {
    return false;
  }
}

export type PartialCloseAuthorityOutcome =
  | {
      kind: "confirmed";
      residualBaseSize: number;
      residualEntryPrice: number;
      becameFlat: false;
      attempts: number;
      elapsedMs: number;
    }
  | {
      kind: "unavailable";
      reason: string;
      retryable: boolean;
      attempts: number;
      elapsedMs: number;
    };

type ClassifiedPartialCloseAuthority =
  | Omit<Extract<PartialCloseAuthorityOutcome, { kind: "confirmed" }>, "attempts" | "elapsedMs">
  | Omit<Extract<PartialCloseAuthorityOutcome, { kind: "unavailable" }>, "attempts" | "elapsedMs">;

export function classifyPartialClosePositionAuthority(input: {
  preCloseBaseSize: number;
  requestedClosedSize: number;
  authority: PartialClosePositionAuthority;
}): ClassifiedPartialCloseAuthority {
  const { preCloseBaseSize, requestedClosedSize, authority } = input;
  if (!Number.isFinite(preCloseBaseSize) || Math.abs(preCloseBaseSize) < PARTIAL_CLOSE_BASE_DUST) {
    return { kind: "unavailable", reason: "pre_close_position_unavailable", retryable: false };
  }
  if (!Number.isFinite(requestedClosedSize)
      || requestedClosedSize < PARTIAL_CLOSE_BASE_DUST
      || requestedClosedSize >= Math.abs(preCloseBaseSize)) {
    return { kind: "unavailable", reason: "partial_close_requested_size_invalid", retryable: false };
  }
  if (!Number.isFinite(authority.size) || !Number.isFinite(authority.entryPrice)) {
    return { kind: "unavailable", reason: "post_close_position_non_finite", retryable: false };
  }
  if (authority.side === "FLAT" || Math.abs(authority.size) < PARTIAL_CLOSE_BASE_DUST) {
    return { kind: "unavailable", reason: "post_close_position_unexpected_flat", retryable: false };
  }
  const expectedSide = preCloseBaseSize > 0 ? "LONG" : "SHORT";
  if (authority.side !== expectedSide || Math.sign(authority.size) !== Math.sign(preCloseBaseSize)) {
    return { kind: "unavailable", reason: "post_close_position_side_mismatch", retryable: false };
  }
  if (authority.entryPrice <= 0) {
    return { kind: "unavailable", reason: "post_close_entry_price_invalid", retryable: false };
  }
  const reduction = new Decimal(preCloseBaseSize).abs().minus(new Decimal(authority.size).abs());
  if (reduction.lte(PARTIAL_CLOSE_BASE_DUST)) {
    return { kind: "unavailable", reason: "post_close_position_not_reduced", retryable: true };
  }
  const requested = new Decimal(requestedClosedSize);
  const dust = new Decimal(PARTIAL_CLOSE_BASE_DUST);
  if (reduction.lt(requested.minus(dust))) {
    return { kind: "unavailable", reason: "post_close_position_under_delivered", retryable: true };
  }
  if (reduction.gt(requested.plus(dust))) {
    return { kind: "unavailable", reason: "post_close_position_reduction_exceeds_request", retryable: false };
  }
  return {
    kind: "confirmed",
    residualBaseSize: authority.size,
    residualEntryPrice: authority.entryPrice,
    becameFlat: false,
  };
}

export async function resolvePartialClosePositionAuthority(input: {
  preCloseBaseSize: number;
  requestedClosedSize: number;
  readAuthority: () => Promise<PartialClosePositionAuthority>;
  retryCount?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
}): Promise<PartialCloseAuthorityOutcome> {
  const retryCount = input.retryCount ?? 3;
  const retryDelayMs = input.retryDelayMs ?? 1_500;
  const wait = input.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = input.now ?? Date.now;
  const startedAt = now();
  let lastReason = "post_close_position_unavailable";
  let attempts = 0;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    attempts = attempt + 1;
    try {
      const outcome = classifyPartialClosePositionAuthority({
        preCloseBaseSize: input.preCloseBaseSize,
        requestedClosedSize: input.requestedClosedSize,
        authority: await input.readAuthority(),
      });
      if (outcome.kind === "confirmed") {
        return { ...outcome, attempts, elapsedMs: Math.max(0, now() - startedAt) };
      }
      lastReason = outcome.reason;
      if (!outcome.retryable) {
        return { ...outcome, attempts, elapsedMs: Math.max(0, now() - startedAt) };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retryCount) await wait(retryDelayMs);
  }
  return {
    kind: "unavailable",
    reason: lastReason,
    retryable: true,
    attempts,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

export type PartialClosePriceAuthority = "venue_execution" | "adapter_submit_oracle_estimate";

export function resolvePartialCloseExecutionPrice(input: {
  protocol: string;
  adapterFillPrice?: number | null;
  signalPrice?: number | null;
}): {
  price: number | null;
  authority: PartialClosePriceAuthority | null;
  signalPriceContext: number | null;
  reason: string | null;
} {
  const adapterPrice = Number(input.adapterFillPrice);
  const signalPrice = Number(input.signalPrice);
  const signalPriceContext = Number.isFinite(signalPrice) && signalPrice > 0 ? signalPrice : null;
  if (!Number.isFinite(adapterPrice) || adapterPrice <= 0) {
    return {
      price: null,
      authority: null,
      signalPriceContext,
      reason: "partial_close_execution_price_unavailable",
    };
  }
  const protocol = input.protocol.trim().toLowerCase();
  return {
    price: adapterPrice,
    authority: protocol === "pacifica" ? "venue_execution" : "adapter_submit_oracle_estimate",
    signalPriceContext,
    reason: null,
  };
}

export function normalizePartialCloseIdentity(value: unknown): string | null {
  let normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  while (normalized.startsWith("tx-")) normalized = normalized.slice(3);
  if (normalized.startsWith("partial-")) normalized = normalized.slice(8);
  return normalized.trim() || null;
}

export function partialCloseIdentityMatches(input: {
  transactionSignature?: unknown;
  protocolFillId?: unknown;
  orderId?: unknown;
  tradeId?: unknown;
}): boolean {
  const signature = typeof input.transactionSignature === "string"
    ? input.transactionSignature.trim()
    : "";
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  if (signature && orderId && signature === orderId) return true;
  const protocol = normalizePartialCloseIdentity(input.protocolFillId);
  if (!protocol) return false;
  return protocol === normalizePartialCloseIdentity(input.orderId)
    || protocol === normalizePartialCloseIdentity(input.tradeId);
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
  feeEvidence: CloseFeeEvidence;
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
