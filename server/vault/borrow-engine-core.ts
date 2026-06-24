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

/** An operate amount, SDK-free. `max` maps to MAX_REPAY/MAX_WITHDRAW sentinels. */
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

export interface BorrowOpenRequest {
  /** Collateral to deposit, raw base units of the collateral mint. Must be > 0. */
  collateralRaw: bigint;
  /** USDC to borrow, raw base units (6 dp). Must be > 0. */
  debtRaw: bigint;
}

/**
 * Plan a NEW borrow: deposit `collateralRaw` collateral and borrow `debtRaw`
 * USDC in one atomic operate. positionId 0 tells the SDK to mint a fresh
 * position and return its nftId (which the executor must persist).
 */
export function planBorrowOpen(req: BorrowOpenRequest): OperatePlan {
  if (req.collateralRaw <= 0n) throw new Error("planBorrowOpen: collateralRaw must be > 0");
  if (req.debtRaw <= 0n) throw new Error("planBorrowOpen: debtRaw must be > 0");
  return {
    positionId: 0,
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
