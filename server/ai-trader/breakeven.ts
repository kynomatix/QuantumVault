// Breakeven Protect — pure math + types for the AI Trader monitor's one-way
// stop-loss ratchet. PURE MODULE (paper-math conventions): no I/O, no storage,
// no adapter access — everything here is unit-testable in isolation.
//
// Rule (owner-approved 2026-07-17): once an open position's max favorable
// excursion since entry has covered >= 75% of the entry→TP distance, move the
// stop loss to entry ± a small fee buffer so a stop-out from that point on is
// a tiny net win instead of a full loss. Fires once per position, only ever
// tightens, never loosens. Applies to ALL AI Trader bots (paper + live,
// scanner included) — always-on, no user knob (defaults over choices).

import Decimal from 'decimal.js';
import type { LiveBreakevenAuthorityPermit, LiveBreakevenNativeSnapshot } from '../protocol/protocol-types';
import { liveBreakevenFingerprint } from '../protocol/protocol-types';

import {
  evaluatePaperBracket,
  paperExitPrice,
  paperRealizedPnl,
  PAPER_SLIPPAGE_PER_LEG,
  type PaperCandle,
  type PaperSide,
  type PaperBracketHit,
} from "./paper-math";

/** Fire when the favorable extreme has covered this fraction of entry→TP. */
export const BREAKEVEN_TRIGGER_PROGRESS = 0.75;

/**
 * Legacy live New-SL offset from entry, in the favorable direction. It was
 * originally sized from an assumed fee schedule:
 *   2 × 0.04% taker legs + 0.05% stop-fill slippage allowance (matches the
 *   paper synthetic slippage per leg) + 0.02% cushion = 0.15%.
 * A plain entry-price stop would net a small LOSS after fees — the owner
 * explicitly asked for "at least a small amount of profit".
 * This fixed value remains live-only legacy behavior and does not guarantee
 * non-negative net PnL at arbitrary effective fee rates.
 */
export const BREAKEVEN_BUFFER_RATE = 0.0015;

/** Bounded venue-move retries per decision (live only). */
export const BREAKEVEN_MAX_MOVE_ATTEMPTS = 5;

/** Numerical runaway bound, not an economic cushion. */
export const MAX_PAPER_BREAKEVEN_ULP_CORRECTION_STEPS = 8;

export type PaperBreakevenStopFailureReason =
  | "malformed_quote"
  | "numerical_postcondition_unproven";

export type PaperBreakevenStopResult =
  | { ok: true; stopPrice: number }
  | { ok: false; reason: PaperBreakevenStopFailureReason };

/**
 * Audit blob persisted inside clampedDecision when the ratchet fires. Its
 * PRESENCE is the fire-once flag. clampedDecision.stopLossPrice is mutated to
 * the moved stop at the same write, so every existing reader (parseOpenDecision,
 * G10 self-heal, exit classification, DTOs) sees the CURRENT stop; the original
 * is preserved here (and in rawDecision) for the audit trail.
 */
export interface BreakevenProtectState {
  originalStopLossPrice: number;
  movedStopLossPrice: number;
  /** ISO timestamp of the move (paper segmentation boundary derives from it). */
  movedAt: string;
  /** Progress toward TP (0..1+) measured when the ratchet fired. */
  progressAtFire: number;
  /** Historical analytical progress, retained separately from mutation authority. */
  analyticalProgressAtFire?: number;
  liveAuthority?: {
    protocol: 'pacifica';
    basis: 'last_trade_price';
    sourceFingerprint: string;
    positionEpochFingerprint: string;
    positionStateFingerprint: string;
    bracketFingerprint: string;
    sourceTimeMs: number;
    readCompletedAtMs: number;
    attemptId: string;
    attemptOrdinal: number;
    requestedTakeProfitPrice: number;
    requestedStopLossPrice: number;
    appliedTakeProfitPrice: number;
    appliedStopLossPrice: number;
    postCallVerified: true;
    postVerificationSourceFingerprint: string;
    postVerificationBracketFingerprint: string;
    postVerificationReadCompletedAtMs: number;
    restorationOutcome: 'not_needed';
  };
}

/**
 * Validate a raw clampedDecision.breakevenProtect blob. Returns null when the
 * blob is absent; a PRESENT-but-malformed blob is coerced into a conservative
 * "already fired" state anchored at the moved/current stop so the ratchet
 * never re-fires or re-calls the venue on corrupt state.
 */
export function parseBreakevenProtect(
  raw: unknown,
  currentStopLossPrice: number,
  fallbackMovedAtMs: number
): BreakevenProtectState | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const numOk = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const movedAtMs = typeof o.movedAt === "string" ? new Date(o.movedAt).getTime() : NaN;
  const analyticalProgressAtFire = numOk(o.analyticalProgressAtFire)
    ? o.analyticalProgressAtFire
    : undefined;
  const authority = o.liveAuthority && typeof o.liveAuthority === "object"
    ? o.liveAuthority as Record<string, unknown>
    : null;
  const liveAuthority = authority
    && authority.protocol === "pacifica"
    && authority.basis === "last_trade_price"
    && typeof authority.sourceFingerprint === "string"
    && LIVE_BREAKEVEN_HEX.test(authority.sourceFingerprint)
    && typeof authority.positionEpochFingerprint === "string"
    && LIVE_BREAKEVEN_HEX.test(authority.positionEpochFingerprint)
    && typeof authority.positionStateFingerprint === "string"
    && LIVE_BREAKEVEN_HEX.test(authority.positionStateFingerprint)
    && typeof authority.bracketFingerprint === "string"
    && LIVE_BREAKEVEN_HEX.test(authority.bracketFingerprint)
    && Number.isSafeInteger(authority.sourceTimeMs)
    && Number.isSafeInteger(authority.readCompletedAtMs)
    && typeof authority.attemptId === "string"
    && authority.attemptId.length > 0
    && Number.isSafeInteger(authority.attemptOrdinal)
    && Number(authority.attemptOrdinal) >= 1
    && Number(authority.attemptOrdinal) <= BREAKEVEN_MAX_MOVE_ATTEMPTS
    && numOk(authority.requestedTakeProfitPrice)
    && numOk(authority.requestedStopLossPrice)
    && numOk(authority.appliedTakeProfitPrice)
    && numOk(authority.appliedStopLossPrice)
    && authority.postCallVerified === true
    && typeof authority.postVerificationSourceFingerprint === "string"
    && LIVE_BREAKEVEN_HEX.test(authority.postVerificationSourceFingerprint)
    && typeof authority.postVerificationBracketFingerprint === "string"
    && LIVE_BREAKEVEN_HEX.test(authority.postVerificationBracketFingerprint)
    && Number.isSafeInteger(authority.postVerificationReadCompletedAtMs)
    && authority.restorationOutcome === "not_needed"
    ? {
        protocol: "pacifica" as const,
        basis: "last_trade_price" as const,
        sourceFingerprint: authority.sourceFingerprint,
        positionEpochFingerprint: authority.positionEpochFingerprint,
        positionStateFingerprint: authority.positionStateFingerprint,
        bracketFingerprint: authority.bracketFingerprint,
        sourceTimeMs: Number(authority.sourceTimeMs),
        readCompletedAtMs: Number(authority.readCompletedAtMs),
        attemptId: authority.attemptId,
        attemptOrdinal: Number(authority.attemptOrdinal),
        requestedTakeProfitPrice: authority.requestedTakeProfitPrice,
        requestedStopLossPrice: authority.requestedStopLossPrice,
        appliedTakeProfitPrice: authority.appliedTakeProfitPrice,
        appliedStopLossPrice: authority.appliedStopLossPrice,
        postCallVerified: true as const,
        postVerificationSourceFingerprint: authority.postVerificationSourceFingerprint,
        postVerificationBracketFingerprint: authority.postVerificationBracketFingerprint,
        postVerificationReadCompletedAtMs: Number(authority.postVerificationReadCompletedAtMs),
        restorationOutcome: "not_needed" as const,
      }
    : undefined;
  return {
    originalStopLossPrice: numOk(o.originalStopLossPrice) ? o.originalStopLossPrice : currentStopLossPrice,
    movedStopLossPrice: numOk(o.movedStopLossPrice) ? o.movedStopLossPrice : currentStopLossPrice,
    movedAt: Number.isFinite(movedAtMs) ? (o.movedAt as string) : new Date(fallbackMovedAtMs).toISOString(),
    progressAtFire: numOk(o.progressAtFire) ? o.progressAtFire : BREAKEVEN_TRIGGER_PROGRESS,
    ...(analyticalProgressAtFire !== undefined ? { analyticalProgressAtFire } : {}),
    ...(liveAuthority ? { liveAuthority } : {}),
  };
}

/**
 * Max favorable excursion across the given candles: highest high for a long,
 * lowest low for a short. Null when there are no candles.
 */
export function favorableExtreme(candles: readonly PaperCandle[], side: PaperSide): number | null {
  if (candles.length === 0) return null;
  let extreme = side === "long" ? -Infinity : Infinity;
  for (const c of candles) {
    if (side === "long") {
      if (c.high > extreme) extreme = c.high;
    } else if (c.low < extreme) {
      extreme = c.low;
    }
  }
  return Number.isFinite(extreme) ? extreme : null;
}

/**
 * Fraction of the entry→TP distance covered by the favorable extreme.
 * Returns 0 on degenerate inputs (zero/negative distance, bad numbers) —
 * a degenerate bracket must never fire the ratchet.
 */
export function progressTowardTp(
  side: PaperSide,
  entryPrice: number,
  takeProfitPrice: number,
  extreme: number
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(takeProfitPrice) || !Number.isFinite(extreme)) return 0;
  const distance = side === "long" ? takeProfitPrice - entryPrice : entryPrice - takeProfitPrice;
  if (distance <= 0) return 0;
  const travelled = side === "long" ? extreme - entryPrice : entryPrice - extreme;
  return travelled <= 0 ? 0 : travelled / distance;
}

/** The moved stop: entry nudged in the favorable direction by the fee buffer. */
export function breakevenStopPrice(side: PaperSide, entryPrice: number): number {
  return side === "long"
    ? entryPrice * (1 + BREAKEVEN_BUFFER_RATE)
    : entryPrice * (1 - BREAKEVEN_BUFFER_RATE);
}

const float64Bits = new DataView(new ArrayBuffer(8));

/** Prices are positive, so IEEE-754 bit order matches numeric order. */
function nextPositiveRepresentable(value: number, direction: "up" | "down"): number {
  float64Bits.setFloat64(0, value, false);
  const bits = float64Bits.getBigUint64(0, false);
  if (direction === "down" && bits === 0n) return Number.NaN;
  float64Bits.setBigUint64(0, direction === "up" ? bits + 1n : bits - 1n, false);
  return float64Bits.getFloat64(0, false);
}

/**
 * Dynamic paper breakeven floor proven through the exact paper exit and
 * accounting functions. `maxCorrectionSteps` is an injectable bounded proof
 * seam for the exhaustion control; production callers use the default.
 */
export function paperBreakevenStopPrice(
  side: PaperSide,
  entryPrice: number,
  takerFeeRate: number,
  maxCorrectionSteps = MAX_PAPER_BREAKEVEN_ULP_CORRECTION_STEPS,
): PaperBreakevenStopResult {
  if (
    !Number.isFinite(entryPrice)
    || entryPrice <= 0
    || !Number.isFinite(takerFeeRate)
    || takerFeeRate < 0
    || takerFeeRate >= 1
    || !Number.isInteger(maxCorrectionSteps)
    || maxCorrectionSteps < 0
    || maxCorrectionSteps > MAX_PAPER_BREAKEVEN_ULP_CORRECTION_STEPS
  ) {
    return { ok: false, reason: "malformed_quote" };
  }

  const slip = PAPER_SLIPPAGE_PER_LEG;
  let candidate = side === "long"
    ? entryPrice * (1 + takerFeeRate) / ((1 - takerFeeRate) * (1 - slip))
    : entryPrice * (1 - takerFeeRate) / ((1 + takerFeeRate) * (1 + slip));
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return { ok: false, reason: "malformed_quote" };
  }

  for (let step = 0; step <= maxCorrectionSteps; step += 1) {
    const exitPrice = paperExitPrice(candidate, side);
    const { netPnl } = paperRealizedPnl({
      side,
      entryPrice,
      exitPrice,
      sizeBase: 1,
      takerFeeRate,
    });
    if (Number.isFinite(netPnl) && netPnl >= 0) {
      return { ok: true, stopPrice: candidate };
    }
    if (step === maxCorrectionSteps) break;
    candidate = nextPositiveRepresentable(candidate, side === "long" ? "up" : "down");
    if (!Number.isFinite(candidate) || candidate <= 0) break;
  }
  return { ok: false, reason: "numerical_postcondition_unproven" };
}

/** Is `price` on the favorable (still-open) side of `level` for this side? */
export function isFavorableSideOf(side: PaperSide, price: number, level: number): boolean {
  return side === "long" ? price > level : price < level;
}

/**
 * One-way ratchet guard: the candidate stop must be strictly TIGHTER than the
 * current stop (closer to/beyond entry in the favorable direction). Protects
 * against loosening when the AI already set a stop at or above breakeven.
 */
export function isTighterStop(side: PaperSide, candidateSl: number, currentSl: number): boolean {
  return side === "long" ? candidateSl > currentSl : candidateSl < currentSl;
}

export type LiveBreakevenAuthorityDenial =
  | 'unsupported_protocol' | 'identity_mismatch' | 'malformed_snapshot'
  | 'position_or_bracket_mismatch'
  | 'stale_snapshot' | 'future_snapshot' | 'ambiguous_trade'
  | 'no_recent_trade'
  | 'protective_pair_not_proven' | 'trigger_basis_mismatch'
  | 'analytical_threshold_not_met' | 'native_threshold_not_met'
  | 'candidate_not_tighter' | 'candidate_outside_trade_range' | 'price_retraced';

export type LiveBreakevenAuthorityResult =
  | { authorized: true; permit: LiveBreakevenAuthorityPermit; nativeProgress: number }
  | { authorized: false; reason: LiveBreakevenAuthorityDenial };

const LIVE_BREAKEVEN_MAX_AGE_MS = 5_000;
const LIVE_BREAKEVEN_HEX = /^[0-9A-F]{64}$/;
const LIVE_BREAKEVEN_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const LIVE_BREAKEVEN_INTEGER = /^(?:0|[1-9][0-9]*)$/;

function exactLiveKeys(value: unknown, keys: readonly string[]): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).sort().join('\u0000')
      === [...keys].sort().join('\u0000');
}

function exactLiveDecimal(value: unknown, positive = true): Decimal | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80
      || !LIVE_BREAKEVEN_DECIMAL.test(value)) return null;
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite() || (positive ? !parsed.gt(0) : parsed.lt(0))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function liveStateBody(snapshot: LiveBreakevenNativeSnapshot): unknown {
  return {
    protocol: snapshot.protocol,
    account: snapshot.account,
    subaccountId: snapshot.subaccountId,
    internalSymbol: snapshot.internalSymbol,
    protocolSymbol: snapshot.protocolSymbol,
    positionLastOrderId: snapshot.positionLastOrderId,
    ordersLastOrderId: snapshot.ordersLastOrderId,
    triggerBasisStatus: snapshot.triggerBasisStatus,
    position: snapshot.position,
    protectiveOrders: snapshot.protectiveOrders,
  };
}

function livePositionBody(snapshot: LiveBreakevenNativeSnapshot): unknown {
  return {
    protocol: snapshot.protocol,
    account: snapshot.account,
    subaccountId: snapshot.subaccountId,
    internalSymbol: snapshot.internalSymbol,
    protocolSymbol: snapshot.protocolSymbol,
    position: snapshot.position,
  };
}

function liveBracketBody(snapshot: LiveBreakevenNativeSnapshot): unknown {
  return {
    protocol: snapshot.protocol,
    account: snapshot.account,
    subaccountId: snapshot.subaccountId,
    internalSymbol: snapshot.internalSymbol,
    protocolSymbol: snapshot.protocolSymbol,
    triggerBasisStatus: snapshot.triggerBasisStatus,
    protectiveOrders: snapshot.protectiveOrders,
  };
}

function liveSourceBody(snapshot: LiveBreakevenNativeSnapshot): unknown {
  return {
    ...(liveStateBody(snapshot) as Record<string, unknown>),
    readStartedAtMs: snapshot.readStartedAtMs,
    readCompletedAtMs: snapshot.readCompletedAtMs,
    recentTrades: snapshot.recentTrades,
  };
}

export function qualifyLiveBreakevenAuthority(input: {
  decisionId: string;
  botId: string;
  side: PaperSide;
  candidateStopPrice: string;
  expectedEntryPrice: string;
  expectedTakeProfitPrice: string;
  expectedCurrentStopPrice: string;
  analyticalProgress: number;
  analyticalWindowFingerprint: string;
  expectedAccount: string;
  expectedInternalSymbol: string;
  snapshot: LiveBreakevenNativeSnapshot;
  nowMs: number;
}): LiveBreakevenAuthorityResult {
  const snapshot = input.snapshot;
  if (!exactLiveKeys(snapshot, [
    'schemaVersion', 'protocol', 'account', 'subaccountId', 'internalSymbol',
    'protocolSymbol', 'readStartedAtMs', 'readCompletedAtMs', 'position',
    'positionLastOrderId', 'ordersLastOrderId', 'triggerBasisStatus', 'protectiveOrders', 'recentTrades', 'positionFingerprint',
    'bracketFingerprint', 'stateFingerprint', 'sourceFingerprint',
  ]) || !exactLiveKeys(snapshot.position, ['sourceRecordId', 'side', 'baseSize', 'entryPrice'])
      || !exactLiveKeys(snapshot.recentTrades, ['lastOrderId', 'rows'])
      || !Array.isArray(snapshot.protectiveOrders)
      || snapshot.protectiveOrders.some((row) => !exactLiveKeys(row, [
        'orderId', 'orderAccount', 'orderType', 'side', 'triggerBasis',
        'triggerPrice', 'initialSize', 'remainingSize', 'reduceOnly',
      ])) || !Array.isArray(snapshot.recentTrades.rows)
      || snapshot.recentTrades.rows.some((row) => !exactLiveKeys(
        row,
        ['symbol', 'price', 'createdAtMs', 'sourceRecordFingerprint'],
      ))) return { authorized: false, reason: 'malformed_snapshot' };
  if (snapshot.protocol !== 'pacifica') return { authorized: false, reason: 'unsupported_protocol' };
  if (snapshot.schemaVersion !== 1
      || typeof snapshot.positionLastOrderId !== 'string'
      || typeof snapshot.ordersLastOrderId !== 'string'
      || typeof snapshot.recentTrades.lastOrderId !== 'string'
      || snapshot.positionLastOrderId.length > 80
      || snapshot.ordersLastOrderId.length > 80
      || snapshot.recentTrades.lastOrderId.length > 80
      || !LIVE_BREAKEVEN_INTEGER.test(snapshot.positionLastOrderId)
      || !LIVE_BREAKEVEN_INTEGER.test(snapshot.ordersLastOrderId)
      || !LIVE_BREAKEVEN_INTEGER.test(snapshot.recentTrades.lastOrderId)) {
    return { authorized: false, reason: 'malformed_snapshot' };
  }
  if (typeof input.decisionId !== 'string' || input.decisionId.length === 0
      || typeof input.botId !== 'string' || input.botId.length === 0
      || typeof input.expectedAccount !== 'string' || input.expectedAccount.length === 0
      || typeof input.expectedInternalSymbol !== 'string' || input.expectedInternalSymbol.length === 0
      || typeof snapshot.account !== 'string' || typeof snapshot.internalSymbol !== 'string'
      || typeof snapshot.protocolSymbol !== 'string'
      || snapshot.account !== input.expectedAccount || snapshot.subaccountId !== null
      || snapshot.internalSymbol !== input.expectedInternalSymbol || snapshot.protocolSymbol.length === 0
      || snapshot.position.side !== input.side) return { authorized: false, reason: 'identity_mismatch' };
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(snapshot.readStartedAtMs)
      || !Number.isSafeInteger(snapshot.readCompletedAtMs)
      || snapshot.readStartedAtMs > snapshot.readCompletedAtMs
      || typeof input.analyticalWindowFingerprint !== 'string'
      || typeof snapshot.positionFingerprint !== 'string'
      || typeof snapshot.bracketFingerprint !== 'string'
      || typeof snapshot.stateFingerprint !== 'string'
      || typeof snapshot.sourceFingerprint !== 'string'
      || !LIVE_BREAKEVEN_HEX.test(input.analyticalWindowFingerprint)
      || !LIVE_BREAKEVEN_HEX.test(snapshot.positionFingerprint)
      || !LIVE_BREAKEVEN_HEX.test(snapshot.bracketFingerprint)
      || !LIVE_BREAKEVEN_HEX.test(snapshot.stateFingerprint)
      || !LIVE_BREAKEVEN_HEX.test(snapshot.sourceFingerprint)
      || snapshot.positionFingerprint !== liveBreakevenFingerprint(livePositionBody(snapshot))
      || snapshot.bracketFingerprint !== liveBreakevenFingerprint(liveBracketBody(snapshot))
      || snapshot.stateFingerprint !== liveBreakevenFingerprint(liveStateBody(snapshot))
      || snapshot.sourceFingerprint !== liveBreakevenFingerprint(liveSourceBody(snapshot))) {
    return { authorized: false, reason: 'malformed_snapshot' };
  }
  if (snapshot.readCompletedAtMs > input.nowMs) return { authorized: false, reason: 'future_snapshot' };
  if (input.nowMs - snapshot.readCompletedAtMs > LIVE_BREAKEVEN_MAX_AGE_MS
      || snapshot.readCompletedAtMs - snapshot.readStartedAtMs > LIVE_BREAKEVEN_MAX_AGE_MS) {
    return { authorized: false, reason: 'stale_snapshot' };
  }
  if (!Number.isFinite(input.analyticalProgress)
      || input.analyticalProgress < BREAKEVEN_TRIGGER_PROGRESS) {
    return { authorized: false, reason: 'analytical_threshold_not_met' };
  }
  const entry = exactLiveDecimal(snapshot.position.entryPrice);
  const positionSize = exactLiveDecimal(snapshot.position.baseSize);
  const candidate = exactLiveDecimal(input.candidateStopPrice);
  const expectedEntry = exactLiveDecimal(input.expectedEntryPrice);
  const expectedTakeProfit = exactLiveDecimal(input.expectedTakeProfitPrice);
  const expectedCurrentStop = exactLiveDecimal(input.expectedCurrentStopPrice);
  if (!entry || !positionSize || !candidate || !expectedEntry || !expectedTakeProfit
      || !expectedCurrentStop
      || typeof snapshot.position.sourceRecordId !== 'string'
      || !LIVE_BREAKEVEN_HEX.test(snapshot.position.sourceRecordId)) {
    return { authorized: false, reason: 'malformed_snapshot' };
  }
  if (!Array.isArray(snapshot.protectiveOrders) || snapshot.protectiveOrders.length !== 2) {
    return { authorized: false, reason: 'protective_pair_not_proven' };
  }
  if (snapshot.triggerBasisStatus !== 'last_trade_price') {
    return { authorized: false, reason: 'trigger_basis_mismatch' };
  }
  const expectedSide = input.side === 'long' ? 'sell' : 'buy';
  for (const order of snapshot.protectiveOrders) {
    const trigger = exactLiveDecimal(order.triggerPrice);
    const initial = exactLiveDecimal(order.initialSize);
    const remaining = exactLiveDecimal(order.remainingSize, false);
    if (typeof order.orderId !== 'string' || order.orderId.length > 80
        || !LIVE_BREAKEVEN_INTEGER.test(order.orderId)
        || order.orderAccount !== snapshot.account || order.side !== expectedSide
        || order.reduceOnly !== true || !trigger || !initial || !remaining || remaining.gt(initial)) {
      return { authorized: false, reason: 'protective_pair_not_proven' };
    }
    if (order.triggerBasis !== 'last_trade_price') {
      return { authorized: false, reason: 'trigger_basis_mismatch' };
    }
    if (remaining.lt(positionSize)) return { authorized: false, reason: 'protective_pair_not_proven' };
  }
  const stops = snapshot.protectiveOrders.filter((order) => order.orderType === 'stop_loss');
  const takeProfits = snapshot.protectiveOrders.filter((order) => order.orderType === 'take_profit');
  if (stops.length !== 1 || takeProfits.length !== 1) {
    return { authorized: false, reason: 'protective_pair_not_proven' };
  }
  const currentStop = new Decimal(stops[0].triggerPrice);
  const takeProfit = new Decimal(takeProfits[0].triggerPrice);
  if (!entry.eq(expectedEntry) || !takeProfit.eq(expectedTakeProfit)
      || !currentStop.eq(expectedCurrentStop)) {
    return { authorized: false, reason: 'position_or_bracket_mismatch' };
  }
  const candidateInTradeRange = input.side === 'long'
    ? candidate.gt(entry) && candidate.lt(takeProfit)
    : candidate.lt(entry) && candidate.gt(takeProfit);
  if (!candidateInTradeRange) {
    return { authorized: false, reason: 'candidate_outside_trade_range' };
  }
  const tighter = input.side === 'long' ? candidate.gt(currentStop) : candidate.lt(currentStop);
  if (!tighter) return { authorized: false, reason: 'candidate_not_tighter' };
  if (!snapshot.recentTrades || !snapshot.recentTrades.lastOrderId
      || !Array.isArray(snapshot.recentTrades.rows)) {
    return { authorized: false, reason: 'malformed_snapshot' };
  }
  if (snapshot.recentTrades.rows.length === 0) {
    return { authorized: false, reason: 'no_recent_trade' };
  }
  let newest = -1;
  const newestPrices = new Set<string>();
  for (const row of snapshot.recentTrades.rows) {
    if (row.symbol !== snapshot.protocolSymbol || !Number.isSafeInteger(row.createdAtMs)
        || typeof row.sourceRecordFingerprint !== 'string'
        || !LIVE_BREAKEVEN_HEX.test(row.sourceRecordFingerprint)
        || row.createdAtMs < 0 || !exactLiveDecimal(row.price)) {
      return { authorized: false, reason: 'malformed_snapshot' };
    }
    if (row.createdAtMs > newest) {
      newest = row.createdAtMs;
      newestPrices.clear();
      newestPrices.add(row.price);
    } else if (row.createdAtMs === newest) {
      newestPrices.add(row.price);
    }
  }
  if (newest > snapshot.readCompletedAtMs || newest > input.nowMs) {
    return { authorized: false, reason: 'future_snapshot' };
  }
  if (input.nowMs - newest > LIVE_BREAKEVEN_MAX_AGE_MS) return { authorized: false, reason: 'stale_snapshot' };
  if (newestPrices.size !== 1) return { authorized: false, reason: 'ambiguous_trade' };
  const price = new Decimal([...newestPrices][0]);
  const distance = input.side === 'long' ? takeProfit.minus(entry) : entry.minus(takeProfit);
  if (!distance.gt(0)) return { authorized: false, reason: 'malformed_snapshot' };
  const nativeProgressDecimal = input.side === 'long'
    ? price.minus(entry).div(distance)
    : entry.minus(price).div(distance);
  if (nativeProgressDecimal.lt(BREAKEVEN_TRIGGER_PROGRESS)) {
    return { authorized: false, reason: 'native_threshold_not_met' };
  }
  const stillFavorable = input.side === 'long' ? price.gt(candidate) : price.lt(candidate);
  if (!stillFavorable) return { authorized: false, reason: 'price_retraced' };
  const expiresAtMs = Math.min(newest + LIVE_BREAKEVEN_MAX_AGE_MS,
    snapshot.readCompletedAtMs + LIVE_BREAKEVEN_MAX_AGE_MS);
  const binding: LiveBreakevenAuthorityPermit['binding'] = {
    policyVersion: 'owner-accepted-v1.1',
    decisionId: input.decisionId,
    botId: input.botId,
    protocol: 'pacifica',
    account: snapshot.account,
    subaccountId: null,
    internalSymbol: snapshot.internalSymbol,
    protocolSymbol: snapshot.protocolSymbol,
    side: input.side,
    entryPrice: snapshot.position.entryPrice,
    takeProfitPrice: takeProfits[0].triggerPrice,
    currentStopPrice: stops[0].triggerPrice,
    candidateStopPrice: input.candidateStopPrice,
    positionSize: snapshot.position.baseSize,
    analyticalProgress: new Decimal(input.analyticalProgress).toFixed(),
    nativeProgress: nativeProgressDecimal.toFixed(),
    analyticalWindowFingerprint: input.analyticalWindowFingerprint,
    nativeSourceFingerprint: snapshot.sourceFingerprint,
    positionEpochFingerprint: snapshot.position.sourceRecordId,
    positionStateFingerprint: snapshot.positionFingerprint,
    bracketFingerprint: snapshot.bracketFingerprint,
    positionLastOrderId: snapshot.positionLastOrderId,
    ordersLastOrderId: snapshot.ordersLastOrderId,
    tradesLastOrderId: snapshot.recentTrades.lastOrderId,
    sourceTimeMs: newest,
    readStartedAtMs: snapshot.readStartedAtMs,
    readCompletedAtMs: snapshot.readCompletedAtMs,
    issuedAtMs: input.nowMs,
    expiresAtMs,
    triggerBasis: 'last_trade_price',
  };
  return {
    authorized: true,
    permit: { schemaVersion: 1, binding, fingerprint: liveBreakevenFingerprint(binding) },
    nativeProgress: nativeProgressDecimal.toNumber(),
  };
}

/**
 * Segmented paper-bracket evaluation across a mid-trade stop move.
 *
 * Boundary convention mirrors the entry-candle exclusion (monitor WO-5): the
 * candle DURING which the move happened (`time <= moveCandleOpen`) still
 * evaluates against the ORIGINAL stop — its extremes predate the move, so it
 * must never test the new tighter stop (false-trigger otherwise). Strictly
 * later candles evaluate against the MOVED stop. TP is unchanged throughout.
 * Chronological correctness: the pre-move segment is evaluated first.
 */
export function evaluatePaperBracketWithMove(
  candles: readonly PaperCandle[],
  side: PaperSide,
  originalStopLossPrice: number,
  movedStopLossPrice: number,
  takeProfitPrice: number,
  moveCandleOpen: number
): PaperBracketHit | null {
  const pre = candles.filter((c) => c.time <= moveCandleOpen);
  const post = candles.filter((c) => c.time > moveCandleOpen);
  const preHit = evaluatePaperBracket(pre, side, originalStopLossPrice, takeProfitPrice);
  if (preHit) return preHit;
  return evaluatePaperBracket(post, side, movedStopLossPrice, takeProfitPrice);
}

/**
 * G8 consecutive-loss predicate (architect correction, breakeven-protect PR):
 * a stop-loss exit only counts toward the consecutive-loss streak when it
 * actually LOST money. A breakeven-protect stop-out is `exitReason: "sl"` with
 * a small positive PnL — three of those in a row must not pause the bot for
 * "consecutive stop-losses". Unknown PnL (null) on an SL exit still counts:
 * an exit we cannot account for is never treated as a win (fail closed).
 */
export function countsAsSlLoss(exitReason: string | null | undefined, realizedPnl: number | null | undefined): boolean {
  if (exitReason !== "sl") return false;
  return !(typeof realizedPnl === "number" && Number.isFinite(realizedPnl) && realizedPnl >= 0);
}
