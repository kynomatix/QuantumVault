/**
 * BORROW ENGINE CORE — Phase D, brick #2 (PURE, no I/O, no SDK import).
 *
 * The decision/verification heart of the Jupiter Lend borrow money engine,
 * isolated from all I/O so it is fully unit-testable with mocked facts. The
 * executor (brick #3) does the on-chain work (sign / send / confirm / read) and
 * delegates every "what params?" and "did it really happen?" question here.
 *
 * Two pieces:
 *   1. PLAN builders translate a high-level intent (open / full-close) into the
 *      exact `getOperateIx` parameters, expressed as SDK-FREE data so this file
 *      never imports @jup-ag/lend. The executor maps `AmountSpec` to the SDK's
 *      BN / MAX_REPAY_AMOUNT / MAX_WITHDRAW_AMOUNT sentinels.
 *   2. VERIFY predicates judge an operation's realized on-chain facts.
 *
 * MONEY-SAFETY CONTRACT (enforced by the executor, documented here):
 *   - VERIFY predicates are ADVISORY *after* a transaction has confirmed and
 *     funds have moved. Once money moves, the executor MUST persist the
 *     AUTHORITATIVE on-chain position (nftId + observed debt/collateral) and
 *     mark the position open — it must NEVER mark a confirmed-but-mismatched
 *     open as `failed`, because that would lose track of real debt and silently
 *     over-report equity. A verify miss post-confirm is a logged warning, not a
 *     fund-losing failure. `failed` is reserved for "no money moved".
 *   - For a close, only transition to `closed` when debt is truly cleared
 *     (`verifyCloseOutcome.ok`); otherwise keep the position open with the
 *     re-read on-chain amounts.
 */

/**
 * An operate amount, SDK-free. `max` maps to MAX_REPAY/MAX_WITHDRAW sentinels.
 *
 * `exact.raw` is SIGNED. The SDK's `getOperateIx` reads a signed BN per leg:
 *   - collateral: POSITIVE deposits, NEGATIVE withdraws, `0n` = no change.
 *   - debt:       POSITIVE borrows,  NEGATIVE repays,    `0n` = no change.
 * The executor maps a negative `raw` straight to `new BN(raw.toString())`
 * (bn.js parses the leading "-"); `withinToleranceBps` already handles negatives.
 */
export type AmountSpec = { kind: "exact"; raw: bigint } | { kind: "max" };

/** The SDK-free shape of a `getOperateIx` call. positionId 0 => mint a new one. */
export interface OperatePlan {
  /** 0 = open a fresh position (SDK prepends initPosition and assigns the nftId). */
  positionId: number;
  /** Collateral leg: + deposits, - withdraws, `max` withdraws all (subject to LTV). */
  colAmount: AmountSpec;
  /** Debt leg: + borrows, - repays, `max` repays all. */
  debtAmount: AmountSpec;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Sanity tolerance for "exact" amount checks (interest accrual + tick rounding). */
export const DEFAULT_TOLERANCE_BPS = 50; // 0.5%
/** Residual debt (raw USDC, 6 dp) treated as fully repaid. 10_000 = 0.01 USDC. */
export const DEFAULT_DEBT_DUST_RAW = 10_000n;

export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** True when |observed - expected| <= |expected| * toleranceBps / 10000. */
export function withinToleranceBps(observed: bigint, expected: bigint, toleranceBps: number): boolean {
  if (!Number.isFinite(toleranceBps) || toleranceBps < 0) return false;
  if (expected === 0n) return observed === 0n;
  const mag = expected < 0n ? -expected : expected;
  const allowed = (mag * BigInt(Math.round(toleranceBps))) / 10_000n;
  return absDiff(observed, expected) <= allowed;
}

/**
 * SCALING — Jupiter Lend / Fluid normalize on-chain POSITION amounts.
 *
 * `getCurrentPosition` / `getFinalPosition` return `colRaw` / `debtRaw`
 * normalized to max(tokenDecimals, 9) decimals: a mint with fewer than 9
 * decimals is upscaled by 10^(9 - decimals); a mint with >= 9 decimals is left
 * at native scale. So USDC (6 dp) comes back at 9 dp — 1e3x its native raw —
 * while INF (9 dp) comes back unchanged. This is the OPPOSITE of the operate
 * INPUTS, which are passed at native token decimals and upscaled by the SDK
 * internally. These pure helpers are the single source of truth for converting a
 * normalized position-raw back to native token raw, so no call site hardcodes a
 * 1e3/1e9 factor. SDK-free by design (this file never imports @jup-ag/lend).
 */
export function positionScaleDecimals(tokenDecimals: number): number {
  return Math.max(tokenDecimals, 9);
}

/** 10^(positionScale - tokenDecimals): divide a position-raw by this for native raw. */
function positionToNativeDivisor(tokenDecimals: number): bigint {
  return 10n ** BigInt(positionScaleDecimals(tokenDecimals) - tokenDecimals);
}

/**
 * Convert a normalized SDK position-raw to NATIVE token raw with EXPLICIT
 * rounding (the caller picks the money-safe direction):
 *   - debt/liability -> "ceil" (never under-report what is owed),
 *   - collateral/asset and any repay CAP -> "floor" (never over-report an asset,
 *     and never let an exact partial repay overshoot the true on-chain debt,
 *     which reverts with Jupiter VaultUserDebtTooLow).
 * Throws on invalid decimals or a negative input (fail closed; the caller must
 * never feed an unreadable amount here — convert a `null` read to a null result,
 * not a fabricated zero).
 */
export function positionRawToNativeRaw(
  positionRaw: bigint,
  tokenDecimals: number,
  rounding: "floor" | "ceil",
): bigint {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    throw new Error(`positionRawToNativeRaw: invalid tokenDecimals ${tokenDecimals}`);
  }
  if (positionRaw < 0n) throw new Error("positionRawToNativeRaw: positionRaw must be >= 0");
  const divisor = positionToNativeDivisor(tokenDecimals);
  if (divisor === 1n) return positionRaw;
  if (rounding === "ceil") return (positionRaw + divisor - 1n) / divisor;
  return positionRaw / divisor;
}

export interface BorrowOpenRequest {
  /** Collateral to deposit, raw base units of the collateral mint. Must be > 0. */
  collateralRaw: bigint;
  /** USDC to borrow, raw base units (6 dp). Must be > 0. */
  debtRaw: bigint;
  /**
   * OPTIONAL position NFT to REUSE instead of minting. 0 (default) tells the SDK
   * to mint a fresh position; a real (minted) positionId deposits+borrows into an
   * existing EMPTY (fully-closed but on-chain-alive) position, reclaiming the rent
   * already locked in that NFT. The executor proves the position is empty before
   * passing it here, so reuse only ever lands on a verified-empty NFT.
   */
  positionId?: number;
}

/**
 * Plan a NEW borrow: deposit `collateralRaw` collateral and borrow `debtRaw`
 * USDC in one atomic operate. positionId 0 (default) tells the SDK to mint a
 * fresh position and return its nftId (which the executor must persist); a real
 * positionId reuses an existing empty position instead of minting.
 */
export function planBorrowOpen(req: BorrowOpenRequest): OperatePlan {
  if (req.collateralRaw <= 0n) throw new Error("planBorrowOpen: collateralRaw must be > 0");
  if (req.debtRaw <= 0n) throw new Error("planBorrowOpen: debtRaw must be > 0");
  const positionId = req.positionId ?? 0;
  if (!Number.isInteger(positionId) || positionId < 0) {
    throw new Error("planBorrowOpen: positionId must be a non-negative integer (0 = mint)");
  }
  return {
    positionId,
    colAmount: { kind: "exact", raw: req.collateralRaw },
    debtAmount: { kind: "exact", raw: req.debtRaw },
  };
}

/**
 * Plan a FULL close of an existing position: repay ALL debt and withdraw ALL
 * collateral in one atomic operate. Mirrors the Vault's all-in/all-out model
 * (no partial-amount knob). Requires a real (minted) positionId.
 */
export function planBorrowClose(positionId: number): OperatePlan {
  if (!Number.isInteger(positionId) || positionId <= 0) {
    throw new Error("planBorrowClose: a real (minted) positionId is required");
  }
  return {
    positionId,
    colAmount: { kind: "max" },
    debtAmount: { kind: "max" },
  };
}

/**
 * Plan a SUPPLY-ONLY deposit: add `collateralRaw` collateral, NO debt change.
 * positionId 0 mints a fresh supply-only position; a real positionId adds to an
 * existing one (the executor prefers add-to-existing over minting a 2nd position
 * for the same wallet+vault). Supply only IMPROVES health, so it carries no LTV
 * gate — but it has NO positive output delta (collateral LEAVES the wallet), so
 * the executor proves success by an AUTHORITATIVE position re-read, not a delta.
 */
export function planSupplyCollateral(positionId: number, collateralRaw: bigint): OperatePlan {
  if (!Number.isInteger(positionId) || positionId < 0) {
    throw new Error("planSupplyCollateral: positionId must be a non-negative integer (0 = new)");
  }
  if (collateralRaw <= 0n) throw new Error("planSupplyCollateral: collateralRaw must be > 0");
  return {
    positionId,
    colAmount: { kind: "exact", raw: collateralRaw },
    debtAmount: { kind: "exact", raw: 0n },
  };
}

/**
 * Plan a BORROW-MORE: borrow additional `debtRaw` USDC against an EXISTING
 * position's collateral (no new collateral). Requires a real (minted) positionId.
 * Debt-increasing, so the executor MUST re-run the enforced risk gate
 * (`evaluateBorrowRequest` with LIVE total collateral + debt) before signing.
 */
export function planBorrowMore(positionId: number, debtRaw: bigint): OperatePlan {
  if (!Number.isInteger(positionId) || positionId <= 0) {
    throw new Error("planBorrowMore: a real (minted) positionId is required");
  }
  if (debtRaw <= 0n) throw new Error("planBorrowMore: debtRaw must be > 0");
  return {
    positionId,
    colAmount: { kind: "exact", raw: 0n },
    debtAmount: { kind: "exact", raw: debtRaw },
  };
}

/**
 * Plan a REPAY: reduce an existing position's debt, NO collateral change. Pass a
 * positive `bigint` for a partial repay (mapped to a NEGATIVE debt leg) or
 * `"max"` to repay ALL debt while KEEPING the collateral (the MAX_REPAY
 * sentinel). Repay only IMPROVES health, so it carries no LTV gate — but USDC
 * LEAVES the wallet with no positive output delta, so the executor proves the
 * repay by an AUTHORITATIVE position re-read (debt decreased), failing CLOSED on
 * the dangerous direction (never reduce recorded debt without on-chain proof).
 */
export function planRepayPartial(positionId: number, amount: bigint | "max"): OperatePlan {
  if (!Number.isInteger(positionId) || positionId <= 0) {
    throw new Error("planRepayPartial: a real (minted) positionId is required");
  }
  if (amount !== "max" && amount <= 0n) {
    throw new Error("planRepayPartial: amount (USDC to repay) must be > 0 or 'max'");
  }
  return {
    positionId,
    colAmount: { kind: "exact", raw: 0n },
    debtAmount: amount === "max" ? { kind: "max" } : { kind: "exact", raw: -amount },
  };
}

/**
 * Plan a WITHDRAW: pull collateral out of an existing position, NO debt change.
 * Pass a positive `bigint` for a partial withdraw (mapped to a NEGATIVE
 * collateral leg) or `"max"` to withdraw ALL withdrawable collateral (the
 * MAX_WITHDRAW sentinel; the protocol caps it at the LTV limit when debt
 * remains). Withdrawing collateral WORSENS health, so the executor MUST re-run
 * the collateral-withdraw risk gate (`evaluateCollateralWithdraw`) before
 * signing. Requires a real positionId.
 */
export function planWithdrawPartial(positionId: number, amount: bigint | "max"): OperatePlan {
  if (!Number.isInteger(positionId) || positionId <= 0) {
    throw new Error("planWithdrawPartial: a real (minted) positionId is required");
  }
  if (amount !== "max" && amount <= 0n) {
    throw new Error("planWithdrawPartial: amount (collateral to withdraw) must be > 0 or 'max'");
  }
  return {
    positionId,
    colAmount: amount === "max" ? { kind: "max" } : { kind: "exact", raw: -amount },
    debtAmount: { kind: "exact", raw: 0n },
  };
}

export interface OpenVerifyFacts {
  requestedCollateralRaw: bigint;
  requestedDebtRaw: bigint;
  /** Realized borrowed-USDC delta on the wallet (executeAgentInstructions proof). */
  usdcDeltaRaw: bigint;
  /** getCurrentPosition.colRaw after the open. */
  observedColRaw: bigint;
  /** getCurrentPosition.debtRaw after the open. */
  observedDebtRaw: bigint;
  toleranceBps?: number;
}

/**
 * ADVISORY sanity check of an open (see the money-safety contract above). The
 * authoritative debt/collateral is always what getCurrentPosition returns; this
 * only flags a surprising mismatch. usdcDelta>0 is the independent proof money
 * actually landed in the wallet.
 */
export function verifyOpenOutcome(f: OpenVerifyFacts): VerifyResult {
  const tol = f.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  if (f.usdcDeltaRaw <= 0n) return { ok: false, reason: "no_borrowed_usdc_received" };
  if (f.observedDebtRaw > f.requestedDebtRaw && !withinToleranceBps(f.observedDebtRaw, f.requestedDebtRaw, tol)) {
    return { ok: false, reason: "debt_exceeds_requested" };
  }
  if (!withinToleranceBps(f.observedDebtRaw, f.requestedDebtRaw, tol)) {
    return { ok: false, reason: "debt_mismatch" };
  }
  if (!withinToleranceBps(f.observedColRaw, f.requestedCollateralRaw, tol)) {
    return { ok: false, reason: "collateral_mismatch" };
  }
  if (!withinToleranceBps(f.usdcDeltaRaw, f.requestedDebtRaw, tol)) {
    return { ok: false, reason: "received_usdc_mismatch" };
  }
  return { ok: true };
}

export interface CloseVerifyFacts {
  /** getCurrentPosition.debtRaw after the close (must be <= dust). */
  observedDebtRaw: bigint;
  /** Realized collateral delta returned to the wallet (must be > 0). */
  collateralDeltaRaw: bigint;
  dustThresholdRaw?: bigint;
}

/**
 * A close is complete only when debt is cleared (<= dust) AND collateral came
 * back to the wallet. The executor must NOT mark `closed` unless this is ok.
 */
export function verifyCloseOutcome(f: CloseVerifyFacts): VerifyResult {
  const dust = f.dustThresholdRaw ?? DEFAULT_DEBT_DUST_RAW;
  if (f.collateralDeltaRaw <= 0n) return { ok: false, reason: "no_collateral_returned" };
  if (f.observedDebtRaw > dust) return { ok: false, reason: "debt_not_cleared" };
  return { ok: true };
}

/**
 * Pre-close guard: the wallet must hold enough USDC to repay the full debt
 * (plus an optional buffer for interest accrued before the tx lands). The
 * operate tx pulls repayment USDC from the signer; an insufficient balance just
 * reverts on-chain, but this lets the executor fail fast with a clear message.
 */
export function hasSufficientRepayBalance(usdcBalanceRaw: bigint, debtRaw: bigint, bufferRaw: bigint = 0n): boolean {
  return usdcBalanceRaw >= debtRaw + bufferRaw;
}

/**
 * Cap a POSITIVE collateral deposit one raw unit below the agent's held balance.
 *
 * Fluid / Jupiter Lend rounds a positive collateral deposit UP by up to one raw
 * unit during the liquidity-layer supply CPI, so depositing the agent wallet's
 * EXACT held balance reverts on-chain with SPL Token "insufficient funds" (0x1)
 * — the protocol tries to pull one wei more than the wallet holds (live-verified:
 * held=100000000 fails, 99999999 succeeds). Capping one raw unit below the held
 * balance lets the round-up still fit.
 *
 * We NEVER deposit more than the user requested; when the request equals the held
 * balance the spare wei stays as recoverable dust in the agent wallet (we do NOT
 * silently transfer an extra buffer on the user's behalf). Returns 0n when nothing
 * can safely be deposited (the caller must reject).
 */
export function capPositiveCollateralDeposit(requestedRaw: bigint, heldRaw: bigint): bigint {
  if (requestedRaw <= 0n || heldRaw <= 1n) return 0n;
  const cap = heldRaw - 1n;
  return requestedRaw < cap ? requestedRaw : cap;
}

// --- New-op verify predicates ----------------------------------------------
// Two classes, mirroring the open/close contract:
//   * borrow-more / withdraw HAVE a positive output delta (USDC / collateral
//     lands in the wallet). The delta is the independent money-moved proof and
//     these predicates are ADVISORY (a miss is a logged warning post-confirm).
//   * supply / repay have NO positive output delta (funds LEAVE the wallet).
//     There the position re-read IS the proof, so the executor treats a non-ok
//     here as a fail-CLOSED on the dangerous direction (never record more
//     collateral / less debt than the chain proves).

export interface SupplyVerifyFacts {
  /** getCurrentPosition.colRaw BEFORE the supply (0 when minting a new position). */
  preColRaw: bigint;
  /** getCurrentPosition.colRaw AFTER the supply. */
  postColRaw: bigint;
  /** Collateral the caller intended to deposit, raw. */
  depositedRaw: bigint;
  toleranceBps?: number;
}

/** Supply is proven only when collateral INCREASED by ~the deposit. */
export function verifySupplyOutcome(f: SupplyVerifyFacts): VerifyResult {
  const tol = f.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  const delta = f.postColRaw - f.preColRaw;
  if (delta <= 0n) return { ok: false, reason: "collateral_not_increased" };
  if (!withinToleranceBps(delta, f.depositedRaw, tol)) return { ok: false, reason: "collateral_delta_mismatch" };
  return { ok: true };
}

export interface RepayVerifyFacts {
  /** getCurrentPosition.debtRaw BEFORE the repay. */
  preDebtRaw: bigint;
  /** getCurrentPosition.debtRaw AFTER the repay. */
  postDebtRaw: bigint;
  /** USDC the caller intended to repay (ignored when fullRepay). */
  repaidRaw: bigint;
  /** True for a `max` (repay-all-keep-collateral) repay: assert debt <= dust. */
  fullRepay?: boolean;
  dustThresholdRaw?: bigint;
  toleranceBps?: number;
}

/** Repay is proven only when debt DECREASED by ~the repay (or cleared, if full). */
export function verifyRepayOutcome(f: RepayVerifyFacts): VerifyResult {
  const tol = f.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  const reduced = f.preDebtRaw - f.postDebtRaw;
  if (reduced <= 0n) return { ok: false, reason: "debt_not_reduced" };
  if (f.fullRepay) {
    const dust = f.dustThresholdRaw ?? DEFAULT_DEBT_DUST_RAW;
    if (f.postDebtRaw > dust) return { ok: false, reason: "debt_not_cleared" };
    return { ok: true };
  }
  if (!withinToleranceBps(reduced, f.repaidRaw, tol)) return { ok: false, reason: "repay_delta_mismatch" };
  return { ok: true };
}

export interface RepaidHistoryFacts {
  /** Live debt read BEFORE the repay (raw, native debt units). */
  preDebtRaw: bigint;
  /** Debt read AFTER the repay (raw). On an unreadable re-read the caller passes
   *  `preDebtRaw` here (observed reduction => 0), which falls through to the sent amount. */
  observedDebtRaw: bigint;
  /** Amount actually SENT to repay (raw): max => preDebt, partial => capped at the floored true debt. */
  repayRaw: bigint;
  /** True ONLY when the post-repay re-read SUCCEEDED and `verifyRepayOutcome` passed. */
  cleanVerified: boolean;
}

export interface RepaidHistory {
  /** Principal to record in the repay history/tax row (raw). NEVER exceeds `repayRaw`. */
  realizedRepaidRaw: bigint;
  /** True => `realizedRepaidRaw` is the EXACT verified on-chain reduction; false => mark "pending re-read". */
  exact: boolean;
}

/**
 * Resolve the principal to record in the repay history row. The caller has ALREADY
 * proven the repay confirmed on-chain (signature present, not on-chain-failed), so
 * this only resolves the AMOUNT — it never decides whether money moved:
 *   - EXACT observed reduction when the re-read succeeded AND verified cleanly;
 *   - else a positive observed reduction is still a real, conservative on-chain
 *     figure, CAPPED at the sent amount so a noisy read can never over-report principal;
 *   - else (re-read lagged the tx -> non-positive delta, or was unreadable -> caller
 *     passed preDebt so delta is 0) the on-chain-derived sent amount.
 * ALWAYS yields a positive figure for a real repay, so a confirmed repay never gets
 * skipped from the history/tax feed. Result is always `<= repayRaw`.
 */
export function resolveRepaidHistoryRaw(f: RepaidHistoryFacts): RepaidHistory {
  const observedDelta = f.preDebtRaw - f.observedDebtRaw;
  if (observedDelta > 0n) {
    const capped = observedDelta > f.repayRaw ? f.repayRaw : observedDelta;
    return { realizedRepaidRaw: capped, exact: f.cleanVerified };
  }
  return { realizedRepaidRaw: f.repayRaw, exact: false };
}

export interface BorrowMoreVerifyFacts {
  preDebtRaw: bigint;
  postDebtRaw: bigint;
  /** Realized borrowed-USDC delta on the wallet (executeAgentInstructions proof). */
  usdcDeltaRaw: bigint;
  /** USDC the caller intended to borrow, raw. */
  borrowedRaw: bigint;
  toleranceBps?: number;
}

/** ADVISORY: borrow-more landed USDC AND debt grew by ~the borrowed amount. */
export function verifyBorrowMoreOutcome(f: BorrowMoreVerifyFacts): VerifyResult {
  const tol = f.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  if (f.usdcDeltaRaw <= 0n) return { ok: false, reason: "no_borrowed_usdc_received" };
  const added = f.postDebtRaw - f.preDebtRaw;
  if (added <= 0n) return { ok: false, reason: "debt_not_increased" };
  if (!withinToleranceBps(f.usdcDeltaRaw, f.borrowedRaw, tol)) return { ok: false, reason: "received_usdc_mismatch" };
  if (!withinToleranceBps(added, f.borrowedRaw, tol)) return { ok: false, reason: "debt_delta_mismatch" };
  return { ok: true };
}

export interface WithdrawVerifyFacts {
  preColRaw: bigint;
  postColRaw: bigint;
  /** Realized collateral delta returned to the wallet (must be > 0). */
  collateralDeltaRaw: bigint;
  /** Collateral the caller intended to withdraw (ignored when fullWithdraw). */
  withdrawnRaw: bigint;
  /** True for a `max` withdraw: skip the exact-amount tolerance check. */
  fullWithdraw?: boolean;
  toleranceBps?: number;
}

/** ADVISORY: withdraw returned collateral AND the position's collateral shrank. */
export function verifyWithdrawOutcome(f: WithdrawVerifyFacts): VerifyResult {
  const tol = f.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  if (f.collateralDeltaRaw <= 0n) return { ok: false, reason: "no_collateral_returned" };
  const reduced = f.preColRaw - f.postColRaw;
  if (reduced <= 0n) return { ok: false, reason: "collateral_not_reduced" };
  if (!f.fullWithdraw && !withinToleranceBps(f.collateralDeltaRaw, f.withdrawnRaw, tol)) {
    return { ok: false, reason: "collateral_delta_mismatch" };
  }
  return { ok: true };
}
