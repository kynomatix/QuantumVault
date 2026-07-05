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
 * JupSOL + mSOL proven with live mainnet round trips in P1 (see
 * docs/qntsol/SOL_LOOP_VAULT_PLAN.md §P1 for signatures). JitoSOL + INF added
 * 2026-07-04 at the owner's direction (owner runs the live proof himself).
 * dfdvSOL (DeFi Development Corp Staked SOL) added 2026-07-05 at owner's
 * direction; LT=0.80 floors the HF gate to 2.6× effective leverage (lower
 * than the other pairs), but its staking APY is currently the highest.
 * The executor is vault-generic (mint/oracle/LT all come from the vault
 * config by id), so no per-token code exists beyond this entry.
 */
export const LOOP_VAULT_ALLOWLIST: Readonly<Record<number, LoopVaultPolicy>> = {
  // Per-vault caps are VENUE-QUALITY overrides (pool depth / liquidity
  // judgment), not the binding safety constraint — the minOpenHealthFactor
  // gate binds first (LT .95 → ~3.7x for JupSOL/JitoSOL/INF, LT .90 →
  // ~3.2x for mSOL, LT .80 → ~2.6x for dfdvSOL).
  4: { symbol: "JupSOL", maxLeverage: 5 },
  5: { symbol: "JitoSOL", maxLeverage: 5 },
  42: { symbol: "INF", maxLeverage: 4 },
  47: { symbol: "mSOL", maxLeverage: 4 },
  // dfdvSOL: MULTIPLY vault 62 (LT=0.93). vault 63 is the BORROW vault (USDC
  // debt) — wrong for the loop. maxLeverage: 3 is a conservative hard cap;
  // the live HF gate will compute ~3.7× from LT=0.93 but we run dfdvSOL
  // cautiously until it has more on-chain history.
  62: { symbol: "dfdvSOL", maxLeverage: 3 },
} as const;

export const LOOP_RISK_POLICY = {
  /**
   * Platform-wide ABSOLUTE leverage ceiling. Never binding by itself today
   * (the health-buffer gate cuts in earlier at current LTs) — it exists so a
   * future high-LT vault can never push effective leverage into the zone
   * where a small stake-pool rate hiccup closes the distance to liquidation.
   */
  hardCapLeverage: 5,
  /**
   * Minimum health factor a fresh open / re-lever must land at, evaluated on
   * the THEORETICAL requested leverage (HF = L·LT/(L−1)) — never a
   * post-slippage re-check (that would fail every at-target open). Must stay
   * ABOVE the safety tick's reduce band (1.25) or the keeper would fight
   * fresh opens. Positive-carry loops self-IMPROVE health over time
   * (collateral compounds at staking APY, debt at the lower borrow APR), so
   * opening near this buffer does not churn.
   */
  minOpenHealthFactor: 1.3,
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

/**
 * P3 SAFETY-TICK deleverage policy (60s reflex). The health/carry fields are
 * the keeper `DeleveragePolicyParams` (structurally compatible — pass this
 * object straight to `decideDeleverage`); the rest configure the reflex around
 * the keeper decision. Deleverage is NEVER oracle-gated (plan §4.4).
 */
export const LOOP_DELEVERAGE_POLICY = {
  /**
   * Jupiter Lend Multiply liquidates below health factor 1.0 (the read boundary
   * already normalizes HF so 1 = at liquidation, matching borrow-health.ts).
   */
  liquidationFloor: 1.0,
  /** Start shaving the loop when HF ≤ floor × this (HF ≤ 1.25). */
  healthReduceMultiple: 1.25,
  /** Fully unwind to HOLD when HF ≤ floor × this (HF ≤ 1.10). MUST stay < reduce multiple (keeper throws otherwise). */
  healthUnwindMultiple: 1.10,
  /**
   * Fast bleed-stopper only: reduce one step when the persisted net carry (at
   * the position's ACTUAL leverage, derived from its live HF and the vault's
   * LT) falls below this. The full LEVERED→HOLD carry decision with hysteresis
   * belongs to the ALLOCATION tick (P3 T105) — this floor just stops paying to
   * hold leverage between hourly ticks.
   */
  carryReduceApy: 0.005,
  /** Fraction shaved per reduce action (25% partial unwind). */
  reduceStep: 0.25,
  /**
   * Max age of a persisted rate sample the 60s carry check may consume. The
   * sampler cadence is ~hourly (allocation tick); anything older than this is
   * treated as UNREADABLE → carry rule silently skipped (health bands never
   * depend on the rate table). The safety tick must NEVER fetch rates upstream.
   */
  rateStalenessMs: 3 * 60 * 60 * 1000,
  /**
   * Per-position atomic cooldown between autonomous action attempts (mirrors
   * the auto-topup throttle). The executors are resumable/idempotent, so a
   * failed attempt safely retries next window.
   */
  cooldownMs: 10 * 60 * 1000,
} as const;

/**
 * P3 ALLOCATION-TICK policy (~hourly brain, plan §4.4). Owns the REAL
 * LEVERED↔HOLD carry decision with hysteresis; the safety tick's
 * `carryReduceApy` above is only the fast bleed-stopper between these ticks.
 *
 * EV model (single-pair v0.5 — HOP across pairs is P4):
 *   EV(hold)    = stakingApy                        (unleveraged LST yield)
 *   EV(levered) = netCarryAt(L) = s·L − b·(L−1)
 *   EV(levered) − EV(hold) = (L−1)·(s − b)
 * So levered beats hold exactly when staking APY exceeds the borrow APR.
 */
export const LOOP_ALLOCATION_POLICY = {
  /**
   * Minimum EV edge (fraction APY) re-levering must clear over holding before
   * it fires: (L−1)·(s−b) > this. A simple constant switching-cost cover
   * (~2 swaps of slippage+fees amortized over weeks), NOT a cost model —
   * keeps the brain auditable (architect plan, 2026-07-03).
   */
  minEvGapApy: 0.01,
  /**
   * P4 HOP: minimum net-carry improvement (fraction APY) a BETTER allowlisted
   * pair must beat the current pair by before the brain fully unwinds one loop
   * and re-loops onto the other. A hop pays TWO full-notional swaps (close leg
   * LST→SOL + open leg SOL→LST) plus possible NFT-mint rent — materially more
   * than a re-lever's single incremental swap — so this gate is DELIBERATELY
   * higher than `minEvGapApy` (~2× as a conservative default). Owner-tunable
   * (plan §6): raise it to hop less often, lower it to chase yield harder.
   * Same "simple switching-cost cover, not a cost model" philosophy as
   * `minEvGapApy` — keeps the brain auditable.
   */
  hopMinCarryGainApy: 0.02,
  /**
   * Unwind to HOLD when the levered net carry falls below this floor even if
   * the EV gap alone would not trigger (paying to stay levered is never worth
   * it). Matches the safety tick's bleed-stopper threshold.
   */
  carryFloorApy: 0.005,
  /**
   * Consecutive allocation ticks that must agree on the SAME intent before it
   * executes (current tick + the last N−1 persisted decision rows). Hysteresis
   * substrate is the journal itself — restart-safe, no in-memory counter.
   */
  hysteresisTicks: 3,
  /**
   * Max age of the OLDEST row in a qualifying streak. A streak spanning a long
   * outage is stale information and must NOT fire (~2×N×hourly cadence).
   */
  streakMaxAgeMs: 6 * 60 * 60 * 1000,
  /**
   * Per-position atomic cooldown for allocation-driven actions. SHARED claim
   * column with the safety tick (last_policy_action_at) — mutual exclusion
   * between opposing autonomous actions on one row is desirable. Residual
   * risk accepted: an allocation claim can delay the safety reflex ≤ this
   * window; every open is gated to HF ≥ minOpenHealthFactor (1.3) on a pegged
   * pair, so that matters only in a catastrophic depeg.
   */
  cooldownMs: 30 * 60 * 1000,
  /**
   * Rate samples older than this are unreadable to the allocation brain →
   * intent 'none' (fail closed). The tick samples upstream FIRST, so in the
   * healthy path the reading is seconds old; this only gates the fallback
   * where sampling failed and we would otherwise decide off yesterday's rates.
   */
  rateStalenessMs: 3 * 60 * 60 * 1000,
} as const;

/**
 * Max leverage that still lands at `minOpenHealthFactor` for a vault with
 * liquidation threshold `lt` (fraction, 0<lt<1): from HF = L·LT/(L−1) ≥ minHF,
 * L ≤ minHF/(minHF − LT). Fail closed: unreadable/out-of-range LT → null.
 */
export function maxLeverageForHealthBuffer(lt: number | null | undefined): number | null {
  if (typeof lt !== "number" || !Number.isFinite(lt) || lt <= 0 || lt >= 1) return null;
  const minHF = LOOP_RISK_POLICY.minOpenHealthFactor;
  if (minHF <= lt) return null; // degenerate config — never trust it
  return minHF / (minHF - lt);
}

export interface LoopTargetLeverageInput {
  vaultId: number;
  /** Live vault liquidation threshold (fraction). null = unreadable → no target. */
  liquidationThreshold: number | null;
  /** LST staking APY (fraction). null = unreadable → no target. */
  stakingApy: number | null;
  /** Vault WSOL borrow APR (fraction). null = unreadable → no target. */
  borrowApr: number | null;
}

export interface LoopTargetLeverageResult {
  /** Target leverage quantized DOWN to 0.1x, or null (do not lever). */
  leverage: number | null;
  /** Theoretical HF at that leverage (L·LT/(L−1)); null when leverage is null. */
  healthAtOpen: number | null;
  /**
   * Why there is no target (only set when leverage is null):
   *  - vault_not_allowlisted / lt_unreadable / rates_unreadable: fail closed.
   *  - carry_nonpositive: staking APY ≤ borrow APR — levering LOSES money, hold instead.
   */
  reason?: "vault_not_allowlisted" | "lt_unreadable" | "rates_unreadable" | "carry_nonpositive" | "cap_too_low";
}

/**
 * DYNAMIC target leverage for a loop open / re-lever: the max leverage that
 * (a) respects the per-vault cap and the platform hard cap, (b) lands at or
 * above `minOpenHealthFactor` for the vault's LIVE liquidation threshold, and
 * (c) is actually PROFITABLE to hold (staking APY > borrow APR — otherwise
 * null: the position should sit unlevered, exactly what the allocation brain
 * enforces on existing rows). PURE, fail closed on every unreadable input.
 */
export function computeLoopTargetLeverage(input: LoopTargetLeverageInput): LoopTargetLeverageResult {
  const vaultPolicy = LOOP_VAULT_ALLOWLIST[input.vaultId];
  if (!vaultPolicy) return { leverage: null, healthAtOpen: null, reason: "vault_not_allowlisted" };

  const healthMax = maxLeverageForHealthBuffer(input.liquidationThreshold);
  if (healthMax === null) return { leverage: null, healthAtOpen: null, reason: "lt_unreadable" };

  const s = input.stakingApy;
  const b = input.borrowApr;
  if (
    typeof s !== "number" || !Number.isFinite(s) ||
    typeof b !== "number" || !Number.isFinite(b) || b < 0
  ) {
    return { leverage: null, healthAtOpen: null, reason: "rates_unreadable" };
  }
  if (s - b <= 0) return { leverage: null, healthAtOpen: null, reason: "carry_nonpositive" };

  const raw = Math.min(vaultPolicy.maxLeverage, LOOP_RISK_POLICY.hardCapLeverage, healthMax);
  const leverage = Math.floor(raw * 10) / 10; // quantize DOWN — never round INTO the buffer
  if (!(leverage > 1)) return { leverage: null, healthAtOpen: null, reason: "cap_too_low" };

  const lt = input.liquidationThreshold as number;
  return { leverage, healthAtOpen: (leverage * lt) / (leverage - 1) };
}

export interface LoopOpenPolicyInput {
  /** Jupiter Lend Multiply vault id (must be allowlisted). */
  vaultId: number;
  /** Requested leverage multiple (e.g. 2 = 2x). */
  requestedLeverage: number;
  /** Live vault liquidation threshold (fraction). null = unreadable → deny (fail closed). */
  liquidationThreshold: number | null;
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
  } else if (input.requestedLeverage > LOOP_RISK_POLICY.hardCapLeverage) {
    reasons.push({
      code: "loop_leverage_exceeds_hard_cap",
      severity: "deny",
      message: `Requested leverage ${input.requestedLeverage}x exceeds the platform hard cap of ${LOOP_RISK_POLICY.hardCapLeverage}x.`,
      facts: { requestedLeverage: input.requestedLeverage, hardCap: LOOP_RISK_POLICY.hardCapLeverage },
    });
  }

  // Health-buffer gate — evaluated on the THEORETICAL requested-L health
  // (HF = L·LT/(L−1)); LT unreadable → deny (fail closed). This is what keeps
  // fresh opens clear of the safety tick's 1.25 reduce band.
  if (!isReadable(input.liquidationThreshold) || input.liquidationThreshold <= 0 || input.liquidationThreshold >= 1) {
    reasons.push({
      code: "loop_liquidation_threshold_unreadable",
      severity: "deny",
      message: "Vault liquidation threshold is unreadable — opens are paused (fail closed).",
    });
  } else if (Number.isFinite(input.requestedLeverage) && input.requestedLeverage > 1) {
    const hfAtOpen = (input.requestedLeverage * input.liquidationThreshold) / (input.requestedLeverage - 1);
    if (hfAtOpen < LOOP_RISK_POLICY.minOpenHealthFactor) {
      reasons.push({
        code: "loop_health_buffer_violated",
        severity: "deny",
        message: `Opening at ${input.requestedLeverage}x would land at health ${hfAtOpen.toFixed(3)}, below the ${LOOP_RISK_POLICY.minOpenHealthFactor} minimum open buffer.`,
        facts: {
          requestedLeverage: input.requestedLeverage,
          liquidationThreshold: input.liquidationThreshold,
          healthAtOpen: hfAtOpen,
          minOpenHealthFactor: LOOP_RISK_POLICY.minOpenHealthFactor,
        },
      });
    }
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

// ---------------------------------------------------------------------------
// P4 HOP — returned-SOL reconstruction after the close leg
// ---------------------------------------------------------------------------
export type HopSolReturnedResult =
  | { ok: true; solReturnedRaw: bigint }
  | { ok: false; reason: string };

/**
 * Reconstruct the lamports the close leg of a hop returned to the agent wallet,
 * so the re-loop can be sized. Money-safety rules (architect review, P4):
 *
 *   1. PREFER the close op's own reported figure (`closeSolReturnedRaw`) — it is
 *      the exact confirmed delta the close executor measured.
 *   2. Otherwise fall back to the STRICT on-chain delta `now − baseline`, where
 *      `baselineRaw` is the PERSISTED PRE-close reading. Never a fresh
 *      (post-close) baseline: after the unwind, `now − now ≈ 0` would size the
 *      re-loop to nothing and strand the returned SOL un-levered.
 *   3. Fail closed (never guess): a missing/zero/negative figure, a missing
 *      persisted baseline, or an unreadable current balance all STOP the hop
 *      resumably — the SOL is safe in the agent wallet, retry once measurable.
 *
 * Pure and side-effect free so it can be unit-tested directly; the executor
 * supplies the strict reads.
 */
export function recoverHopSolReturned(input: {
  /** `solReturnedLamports` from the close leg / its persisted op result. */
  closeSolReturnedRaw?: string | bigint | null;
  /** Persisted PRE-close agent-wallet lamports (write-ahead baseline). */
  baselineRaw?: bigint | null;
  /** Current strict agent-wallet lamports; null = unreadable (fail closed). */
  agentLamportsNowRaw?: bigint | null;
}): HopSolReturnedResult {
  // 1. Trust the close leg's own figure when present and positive.
  const fig = input.closeSolReturnedRaw;
  if (fig != null && fig !== "") {
    let parsed: bigint | null = null;
    try {
      parsed = typeof fig === "bigint" ? fig : BigInt(fig);
    } catch {
      parsed = null;
    }
    if (parsed != null && parsed > 0n) return { ok: true, solReturnedRaw: parsed };
    // A present-but-unusable figure (unparseable / ≤0) falls through to the
    // delta path rather than being trusted.
  }

  // 2. Strict delta vs the PERSISTED pre-close baseline.
  if (input.baselineRaw == null) {
    return { ok: false, reason: "no persisted pre-close baseline to measure the returned SOL against" };
  }
  if (input.agentLamportsNowRaw == null) {
    return { ok: false, reason: "current agent-wallet balance is unreadable" };
  }
  const delta = input.agentLamportsNowRaw - input.baselineRaw;
  if (delta <= 0n) {
    return { ok: false, reason: "no positive SOL delta since the pre-close baseline yet" };
  }
  return { ok: true, solReturnedRaw: delta };
}
