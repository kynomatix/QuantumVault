/**
 * SOL Loop Vault — WO3: HOLD→best-LST rotation decision (PURE).
 *
 * ONE shared brain for "what should an UNLEVERED (HOLD) loop position do?",
 * called by BOTH the allocation tick (decide + journal + dispatch) and the
 * hop executor's in-lock guard (checkpoint A re-verification). A single
 * implementation is the point: the executor must never derive a different
 * answer than the tick that authorized the rotation.
 *
 * Decision contract (seven steps, every unreadable input fails closed):
 *  1. currentHoldApy = the source vault's own staking APY (what plain holding
 *     earns today). Unreadable → intent 'none', reason 'rates_unreadable'.
 *  2. Source dynamic target leverage + sourceLoopApy (net carry at that
 *     target) via the SAME `computeLoopTargetLeverage`/`netCarryAt` the open
 *     path uses. No computable target (LT/rates unreadable, carry
 *     non-positive, cap too low) → sourceLoopApy null: the source simply
 *     cannot re-lever this tick.
 *  3. sourceReleverEligible = sourceLoopApy − currentHoldApy > minEvGapApy.
 *     (Identical to the legacy single-pair relever gate: sourceLoopApy −
 *     currentHoldApy ≡ (L−1)·(s−b).)
 *  4. Best NO-SWITCH action: when relever is eligible the default intent is
 *     'relever' and the benchmark is sourceLoopApy; otherwise the default is
 *     staying in hold and the benchmark is currentHoldApy.
 *  5. Best ALTERNATIVE loop via the existing `pickBestLoopVault` (each
 *     vault's OWN dynamic target, deterministic lower-vault-id tie-break),
 *     EXCLUDING the current vault — a rotation is always a real move.
 *  6. marginalSwitchGainApy = altLoopApy − noSwitchBenchmarkApy.
 *  7. Rotate (intent 'hop') iff marginalSwitchGainApy STRICTLY exceeds
 *     `LOOP_ALLOCATION_POLICY.holdRotationMinGainApy`; otherwise fall back to
 *     the no-switch default ('relever' / stay-hold 'none').
 *
 * PURE by construction: imports only pure helpers from the rate oracle and
 * the risk policy — no storage, no executor, no I/O. loop-executor imports
 * THIS module, never the reverse (no import cycle).
 */

import { netCarryAt, pickBestLoopVault, type FreshLoopRate } from "./loop-rate-oracle";
import { computeLoopTargetLeverage, LOOP_ALLOCATION_POLICY } from "./loop-risk-policy";

export type HoldAllocationIntent = "hop" | "relever" | "none";

export interface HoldAllocationInput {
  /** The HOLD position's current vault id. */
  currentVaultId: number;
  /** Fresh, staleness-gated rate map — the SAME table the whole brain reads. */
  rates: Map<number, FreshLoopRate>;
  /** Allowlisted vault ids the brain may act on. */
  allowedVaultIds: number[];
  /** Test seam; production always uses LOOP_ALLOCATION_POLICY. */
  policy?: typeof LOOP_ALLOCATION_POLICY;
}

export interface HoldAllocationDecision {
  intent: HoldAllocationIntent;
  /**
   * 'rates_unreadable'        — currentHoldApy unreadable (fail closed → none).
   * 'hold_rotation_favorable' — intent 'hop' (rotate onto altVaultId).
   * 'ev_gap_favorable'        — intent 'relever' (matches the legacy journal
   *                             reason so hysteresis streaks stay contiguous).
   * 'stay_hold'               — intent 'none'.
   */
  reason: "rates_unreadable" | "hold_rotation_favorable" | "ev_gap_favorable" | "stay_hold";
  /** Unleveraged staking APY of the CURRENT vault (fraction); null = unreadable. */
  currentHoldApy: number | null;
  /** Source's dynamic target leverage (null = source cannot re-lever). */
  sourceTargetLeverage: number | null;
  /** Net carry at the source's dynamic target (fraction APY); null = no target. */
  sourceLoopApy: number | null;
  /** True when re-levering the source clears minEvGapApy over holding. */
  sourceReleverEligible: boolean;
  /** The no-switch action a rotation must beat. */
  defaultIntent: "relever" | "stay_hold";
  /** Benchmark APY of that no-switch action; null only when rates unreadable. */
  noSwitchBenchmarkApy: number | null;
  /** Best alternative vault (never the current one); null = no alternative. */
  altVaultId: number | null;
  altSymbol: string | null;
  /** Alternative's dynamic target leverage; null when no alternative. */
  altTargetLeverage: number | null;
  /** Alternative's net carry at ITS dynamic target (fraction APY). */
  altLoopApy: number | null;
  /** altLoopApy − noSwitchBenchmarkApy; null when either side is unreadable. */
  marginalSwitchGainApy: number | null;
  /** The threshold the rotation compared against (name + value, for audit). */
  thresholdName: "holdRotationMinGainApy";
  thresholdApy: number;
}

/**
 * Decide the best action for a HOLD (debt-free) loop position: rotate onto a
 * better pair, re-lever in place, or keep holding. See the module header for
 * the seven-step contract. PURE — no I/O, fail closed on every unreadable.
 */
export function decideHoldAllocationTarget(input: HoldAllocationInput): HoldAllocationDecision {
  const policy = input.policy ?? LOOP_ALLOCATION_POLICY;
  const thresholdApy = policy.holdRotationMinGainApy;

  // (1) What plain holding earns today — the rotation's ultimate fallback
  // benchmark. Without it NOTHING is decidable (fail closed).
  const cur = input.rates.get(input.currentVaultId);
  const currentHoldApy =
    typeof cur?.stakingApy === "number" && Number.isFinite(cur.stakingApy) ? cur.stakingApy : null;
  if (cur === undefined || currentHoldApy === null) {
    return {
      intent: "none",
      reason: "rates_unreadable",
      currentHoldApy: null,
      sourceTargetLeverage: null,
      sourceLoopApy: null,
      sourceReleverEligible: false,
      defaultIntent: "stay_hold",
      noSwitchBenchmarkApy: null,
      altVaultId: null,
      altSymbol: null,
      altTargetLeverage: null,
      altLoopApy: null,
      marginalSwitchGainApy: null,
      thresholdName: "holdRotationMinGainApy",
      thresholdApy,
    };
  }

  // (2) The source's own levered alternative, at its dynamic target (live LT
  // + health buffer + caps + positive carry — same function as the open path).
  const sourceTarget = computeLoopTargetLeverage({
    vaultId: input.currentVaultId,
    liquidationThreshold: cur.liquidationThreshold,
    stakingApy: cur.stakingApy,
    borrowApr: cur.borrowApr,
  });
  const sourceLoopApy =
    sourceTarget.leverage !== null ? netCarryAt(cur.stakingApy, cur.borrowApr, sourceTarget.leverage) : null;

  // (3) Would the single-pair brain re-lever here? (Strictly-greater gate,
  // identical to the legacy ev_gap_favorable condition.)
  const sourceReleverEligible =
    sourceLoopApy !== null && sourceLoopApy - currentHoldApy > policy.minEvGapApy;

  // (4) Best no-switch action = the benchmark any rotation must beat. A
  // rotation that merely beats HOLDING while the source could re-lever for
  // more would be a net-negative move — always benchmark the better one.
  const defaultIntent: "relever" | "stay_hold" = sourceReleverEligible ? "relever" : "stay_hold";
  const noSwitchBenchmarkApy = sourceReleverEligible ? (sourceLoopApy as number) : currentHoldApy;

  // (5) Best alternative loop (dynamic targets, lower-id tie-break), never
  // the current vault.
  const altIds = input.allowedVaultIds.filter((id) => id !== input.currentVaultId);
  const best = pickBestLoopVault(input.rates, altIds);

  // (6) Marginal edge over the best no-switch action.
  const marginalSwitchGainApy = best !== null ? best.netCarryAtTarget - noSwitchBenchmarkApy : null;

  const facts = {
    currentHoldApy,
    sourceTargetLeverage: sourceTarget.leverage,
    sourceLoopApy,
    sourceReleverEligible,
    defaultIntent,
    noSwitchBenchmarkApy,
    altVaultId: best?.vaultId ?? null,
    altSymbol: best?.symbol ?? null,
    altTargetLeverage: best?.targetLeverage ?? null,
    altLoopApy: best?.netCarryAtTarget ?? null,
    marginalSwitchGainApy,
    thresholdName: "holdRotationMinGainApy" as const,
    thresholdApy,
  };

  // (7) Rotate only on a STRICT beat of the rotation threshold.
  if (best !== null && marginalSwitchGainApy !== null && marginalSwitchGainApy > thresholdApy) {
    return { intent: "hop", reason: "hold_rotation_favorable", ...facts };
  }
  if (sourceReleverEligible) {
    return { intent: "relever", reason: "ev_gap_favorable", ...facts };
  }
  return { intent: "none", reason: "stay_hold", ...facts };
}
