/**
 * SOL LOOP VAULT (qntSOL) — RISK POLICY (P2, G1).
 *
 * PURE, SDK-free gate for loop opens/leverage-increases. This is a SEPARATE
 * policy namespace from `borrow-risk-policy.ts` and deliberately NEVER imports
 * `evaluateBorrowRequest`: the borrow policy prices a stable-debt-vs-volatile-
 * collateral book (every SOL move hits LTV), while a loop is a CORRELATED pair
 * (LST collateral / WSOL debt move together — only the LST/SOL *rate* axis
 * moves LTV). Mixing the two evaluators would apply the wrong LTV mindset in
 * both directions (owner policy stance, plan §4.1, 2026-07-02).
 *
 * Money-safety contract (same as the borrow engine):
 *  - FAIL CLOSED: any unreadable input (null/NaN/non-finite) that a gate needs
 *    produces a DENY reason, never a skipped check.
 *  - Deleverage is never gated here — partial/full unwinds must always be
 *    allowed to run. This evaluator is for OPEN / lever-up only.
 */

export type LoopPolicySeverity = "deny" | "warn" | "info";

export interface LoopPolicyReason {
  code: string;
  severity: LoopPolicySeverity;
  message: string;
  facts?: Record<string, unknown>;
}

export interface LoopVaultPolicy {
  symbol: string;
  /** Per-vault leverage cap (overrides the platform default, never exceeds it upward without an owner policy change). */
  maxLeverage: number;
}

/**
 * Launch allowlist — the ONLY Jupiter Lend Multiply vaults a loop may open on.
 * Both proven with live mainnet round trips in P1 (see
 * docs/qntsol/SOL_LOOP_VAULT_PLAN.md §P1 for signatures).
 */
export const LOOP_VAULT_ALLOWLIST: Readonly<Record<number, LoopVaultPolicy>> = {
  4: { symbol: "JupSOL", maxLeverage: 2 },
  47: { symbol: "mSOL", maxLeverage: 2 },
} as const;

export const LOOP_RISK_POLICY = {
  /**
   * Platform default + hard leverage cap for P2. Conservative launch value —
   * the venue's CF 94/LT 95 would allow ~16x, but the cap is stress math
   * (depeg tolerance + rate drift + unwind cost vs distance-to-LT), raisable
   * per-vault via LOOP_VAULT_ALLOWLIST once P3 keeper policy lands.
   */
  defaultMaxLeverage: 2,
  /**
   * Max |market LST/SOL rate − stake-pool rate| deviation (basis points) before
   * opens are PAUSED. Pegged vaults liquidate on the stake-pool rate, so a
   * market depeg does not itself liquidate — but opening INTO a depeg buys the
   * LST off-peg and realizes the gap on unwind. Deleverage stays allowed.
   */
  depegBandBps: 100,
  /** Pause opens when the vault's WSOL borrow APR exceeds this (fraction). */
  borrowAprCeiling: 0.15,
  /** Pause opens when pool utilization exceeds this — a near-full pool can block the unwind's withdraw leg. */
  utilizationCeiling: 0.9,
} as const;

export interface LoopOpenPolicyInput {
  /** Jupiter Lend Multiply vault id (must be allowlisted). */
  vaultId: number;
  /** Requested leverage multiple (e.g. 2 = 2x). */
  requestedLeverage: number;
  /** SOL principal for the open, raw lamports. */
  principalLamports: bigint;
  /** Stake-pool LST/SOL rate (SOL per 1 LST). null = unreadable → deny. */
  stakePoolSolPerLst: number | null;
  /** Market LST/SOL rate from the swap route (SOL per 1 LST). null = unreadable → deny. */
  marketSolPerLst: number | null;
  /** Vault WSOL borrow APR (fraction, e.g. 0.05 = 5%). null = unreadable → deny. */
  borrowApr: number | null;
  /** Pool utilization (fraction). null = unreadable → deny. */
  utilization: number | null;
  /**
   * LST staking APY (fraction), OPTIONAL. When readable and the carry
   * (stakingApy − borrowApr) is negative, the open gets a WARN (not a deny in
   * P2 — owner-gated dust testing must not be blocked by a dust-sized carry).
   */
  stakingApy?: number | null;
}

export interface LoopPolicyDecision {
  /** True only when NO reason has severity "deny". */
  allowed: boolean;
  /** Effective leverage cap for this vault (null when not allowlisted). */
  effectiveMaxLeverage: number | null;
  /** |market − stakePool| / stakePool in bps; null when either rate is unreadable. */
  depegBps: number | null;
  reasons: LoopPolicyReason[];
}

function isReadable(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Evaluate a loop OPEN (or lever-up). PURE — no I/O, fail closed on unreadables. */
export function evaluateLoopOpenRequest(input: LoopOpenPolicyInput): LoopPolicyDecision {
  const reasons: LoopPolicyReason[] = [];

  const vaultPolicy = LOOP_VAULT_ALLOWLIST[input.vaultId];
  if (!vaultPolicy) {
    reasons.push({
      code: "loop_vault_not_allowlisted",
      severity: "deny",
      message: `Vault ${input.vaultId} is not on the loop launch allowlist.`,
      facts: { vaultId: input.vaultId, allowlisted: Object.keys(LOOP_VAULT_ALLOWLIST) },
    });
  }
  // The per-vault cap is authoritative (caps are set — and raisable — per-LST
  // by owner policy change); the platform default is only the fallback value
  // used when adding a new allowlist row.
  const effectiveMaxLeverage = vaultPolicy ? vaultPolicy.maxLeverage : null;

  if (!Number.isFinite(input.requestedLeverage) || input.requestedLeverage <= 1) {
    reasons.push({
      code: "loop_leverage_invalid",
      severity: "deny",
      message: `Requested leverage ${input.requestedLeverage} must be > 1.`,
      facts: { requestedLeverage: input.requestedLeverage },
    });
  } else if (effectiveMaxLeverage !== null && input.requestedLeverage > effectiveMaxLeverage) {
    reasons.push({
      code: "loop_leverage_exceeds_cap",
      severity: "deny",
      message: `Requested leverage ${input.requestedLeverage}x exceeds the ${vaultPolicy!.symbol} cap of ${effectiveMaxLeverage}x.`,
      facts: { requestedLeverage: input.requestedLeverage, cap: effectiveMaxLeverage },
    });
  }

  if (input.principalLamports <= 0n) {
    reasons.push({
      code: "loop_principal_invalid",
      severity: "deny",
      message: "Principal must be > 0 lamports.",
      facts: { principalLamports: input.principalLamports.toString() },
    });
  }

  // Depeg gate — BOTH rates must be readable (fail closed), deviation within band.
  let depegBps: number | null = null;
  if (!isReadable(input.stakePoolSolPerLst) || input.stakePoolSolPerLst <= 0) {
    reasons.push({
      code: "loop_stake_pool_rate_unreadable",
      severity: "deny",
      message: "Stake-pool LST/SOL rate is unreadable — opens are paused (fail closed).",
    });
  }
  if (!isReadable(input.marketSolPerLst) || input.marketSolPerLst <= 0) {
    reasons.push({
      code: "loop_market_rate_unreadable",
      severity: "deny",
      message: "Market LST/SOL rate is unreadable — opens are paused (fail closed).",
    });
  }
  if (
    isReadable(input.stakePoolSolPerLst) && input.stakePoolSolPerLst > 0 &&
    isReadable(input.marketSolPerLst) && input.marketSolPerLst > 0
  ) {
    depegBps = Math.abs(input.marketSolPerLst / input.stakePoolSolPerLst - 1) * 10_000;
    if (depegBps > LOOP_RISK_POLICY.depegBandBps) {
      reasons.push({
        code: "loop_depeg_exceeds_band",
        severity: "deny",
        message: `Market rate deviates ${depegBps.toFixed(1)} bps from the stake-pool rate (band: ${LOOP_RISK_POLICY.depegBandBps} bps). Opens paused; unwinds unaffected.`,
        facts: {
          depegBps,
          bandBps: LOOP_RISK_POLICY.depegBandBps,
          stakePoolSolPerLst: input.stakePoolSolPerLst,
          marketSolPerLst: input.marketSolPerLst,
        },
      });
    }
  }

  // Borrow-APR ceiling (fail closed on unreadable).
  if (!isReadable(input.borrowApr) || input.borrowApr < 0) {
    reasons.push({
      code: "loop_borrow_apr_unreadable",
      severity: "deny",
      message: "WSOL borrow APR is unreadable — opens are paused (fail closed).",
    });
  } else if (input.borrowApr > LOOP_RISK_POLICY.borrowAprCeiling) {
    reasons.push({
      code: "loop_borrow_apr_ceiling",
      severity: "deny",
      message: `WSOL borrow APR ${(input.borrowApr * 100).toFixed(2)}% exceeds the ${LOOP_RISK_POLICY.borrowAprCeiling * 100}% ceiling.`,
      facts: { borrowApr: input.borrowApr, ceiling: LOOP_RISK_POLICY.borrowAprCeiling },
    });
  }

  // Utilization ceiling (fail closed on unreadable).
  if (!isReadable(input.utilization) || input.utilization < 0) {
    reasons.push({
      code: "loop_utilization_unreadable",
      severity: "deny",
      message: "Pool utilization is unreadable — opens are paused (fail closed).",
    });
  } else if (input.utilization > LOOP_RISK_POLICY.utilizationCeiling) {
    reasons.push({
      code: "loop_utilization_ceiling",
      severity: "deny",
      message: `Pool utilization ${(input.utilization * 100).toFixed(1)}% exceeds the ${LOOP_RISK_POLICY.utilizationCeiling * 100}% ceiling — the unwind's withdraw leg could be blocked.`,
      facts: { utilization: input.utilization, ceiling: LOOP_RISK_POLICY.utilizationCeiling },
    });
  }

  // Carry check — WARN only in P2 (optional input; unreadable = no check, the
  // carry gate proper is P3 keeper policy, not this evaluator).
  if (isReadable(input.stakingApy) && isReadable(input.borrowApr)) {
    const carry = input.stakingApy - input.borrowApr;
    if (carry <= 0) {
      reasons.push({
        code: "loop_negative_carry",
        severity: "warn",
        message: `Negative carry: staking APY ${(input.stakingApy * 100).toFixed(2)}% <= borrow APR ${(input.borrowApr * 100).toFixed(2)}%. The loop loses money while held.`,
        facts: { stakingApy: input.stakingApy, borrowApr: input.borrowApr, carry },
      });
    }
  }

  return {
    allowed: !reasons.some((r) => r.severity === "deny"),
    effectiveMaxLeverage,
    depegBps,
    reasons,
  };
}
