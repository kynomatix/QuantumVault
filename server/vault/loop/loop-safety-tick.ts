/**
 * SOL LOOP VAULT (qntSOL) — P3 SAFETY-TICK REFLEX (60s).
 *
 * Rides the EXISTING borrow-health monitor tick (NO second scanner — plan
 * §4.4): the monitor collects a health observation for every open kind='loop'
 * row during its normal scan, and hands them here AFTER its persist loop,
 * inside the SAME in-flight guard. This module decides (keeper
 * `decideDeleverage`) and executes autonomous deleverage:
 *
 *   reduce          → executeLoopPartialUnwind (one reduceStep, e.g. 25%)
 *   unwind          → executeLoopDeleverToHold (zero debt, collateral stays
 *                     supplied — the LEVERED→HOLD transition)
 *
 * Money-safety contract:
 *  - RISK-REDUCING ONLY. This path can never open or increase leverage, so it
 *    is deliberately NOT oracle-gated (`evaluateOracle` gates only opens).
 *  - FAIL CLOSED on unreadable inputs: a row whose live health could not be
 *    read (status 'unavailable' / non-numeric HF / unreadable debt) is SKIPPED
 *    — the monitor's 'unavailable' band alert covers telling the owner. We
 *    never act on a guess; the executors re-read on-chain and fail closed
 *    themselves before any broadcast.
 *  - Candidates are selected by LIVE DEBT (> 0) and numeric HF, never by
 *    policyState: a NULL policyState with debt is treated as levered, and a
 *    stale 'levered' row whose debt already cleared is filtered out
 *    (architect notes, T103 review).
 *  - Exactly-once per window: a per-position atomic DB claim
 *    (claimBorrowPositionPolicyAction) is taken BEFORE any key material is
 *    touched; losing the claim means another tick already acted recently.
 *  - Carry-based reduce consumes ONLY persisted, staleness-gated rate samples
 *    (getFreshLoopRates). Stale/absent → the carry rule silently skips; the
 *    health bands never depend on the rate table.
 *  - Signing uses the execution-wrapped UMK path (getUmkForWebhook — gated on
 *    executionEnabled + emergency stop), injected from routes.ts because the
 *    scope helpers live there. Keys are wiped in a finally.
 *  - Every attempted action lands one loop_policy_decisions row (tick
 *    'safety') with the execution outcome in `details`; Telegram delivery is
 *    best-effort and can never block or falsify the reflex.
 */

import type { BorrowPosition } from "@shared/schema";
import { storage } from "../../storage";
import type { PerBotPositionHealth } from "../borrow-health";
import { sendLoopSafetyNotification, type LoopSafetyNotification } from "../../notification-service";
import { decideDeleverage } from "./keeper/policy";
import type { DeleverageDecision, PositionHealth, VenueState } from "./keeper/types";
import { getFreshLoopRates, netCarryAt, type FreshLoopRate } from "./loop-rate-oracle";
import { LOOP_DELEVERAGE_POLICY, LOOP_VAULT_ALLOWLIST } from "./loop-risk-policy";
import {
  executeLoopPartialUnwind,
  executeLoopDeleverToHold,
  type LoopPartialUnwindParams,
  type LoopPartialUnwindResult,
  type LoopDeleverParams,
  type LoopDeleverResult,
} from "./loop-executor";

/** One open loop row + the health the monitor just computed for it. */
export interface LoopHealthObservation {
  row: BorrowPosition;
  health: PerBotPositionHealth;
}

/** Decrypted autonomous signer for a wallet's ACCOUNT agent (loop scope). */
export interface LoopSafetySigner {
  agentPublicKey: string;
  secretKey: Uint8Array;
  cleanup: () => void;
}

export interface LoopSafetyTickDeps {
  /**
   * Autonomous key resolution (execution-wrapped UMK). REQUIRED — wired from
   * routes.ts where the vault-scope helpers live. Null = no execution
   * authorization / re-key needed → the action is refused, never guessed.
   */
  resolveSigner(walletAddress: string): Promise<LoopSafetySigner | null>;
  getFreshRates(maxAgeMs: number): Promise<Map<number, FreshLoopRate>>;
  claimPolicyAction(positionId: string, cooldownMs: number): Promise<BorrowPosition | null>;
  executeReduce(params: LoopPartialUnwindParams): Promise<LoopPartialUnwindResult>;
  executeUnwindToHold(params: LoopDeleverParams): Promise<LoopDeleverResult>;
  persistDecision(d: {
    walletAddress: string;
    borrowPositionId: string | null;
    vaultId: number;
    tick: string;
    action: string;
    fraction: string | null;
    reason: string;
    details: Record<string, unknown> | null;
  }): Promise<void>;
  notify(walletAddress: string, n: LoopSafetyNotification): Promise<"sent" | "skipped" | "failed">;
  now(): Date;
}

/** Production deps. `resolveSigner` must be supplied by the caller (routes.ts). */
export function buildLoopSafetyDeps(
  resolveSigner: LoopSafetyTickDeps["resolveSigner"],
): LoopSafetyTickDeps {
  return {
    resolveSigner,
    getFreshRates: getFreshLoopRates,
    claimPolicyAction: (id, cooldownMs) => storage.claimBorrowPositionPolicyAction(id, cooldownMs),
    executeReduce: executeLoopPartialUnwind,
    executeUnwindToHold: executeLoopDeleverToHold,
    persistDecision: async (d) => {
      await storage.insertLoopPolicyDecision(d);
    },
    notify: sendLoopSafetyNotification,
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// PURE input builder — unit-testable candidate filtering + keeper input shapes.
// ---------------------------------------------------------------------------

export interface LoopSafetyCandidate {
  row: BorrowPosition;
  vaultId: number;
  healthFactor: number;
  liveDebtRaw: bigint;
}

export interface LoopSafetyInputs {
  candidates: LoopSafetyCandidate[];
  positions: PositionHealth[];
  states: Map<string, VenueState>;
  /** Rows that were open loop rows but could not be safely assessed. */
  skipped: Array<{ rowId: string; reason: string }>;
}

const venueKey = (vaultId: number): string => `vault:${vaultId}`;

/**
 * Filter observations down to actionable levered candidates and build the
 * keeper inputs. FAIL CLOSED: anything unreadable is skipped with a reason,
 * never guessed. HOLD rows (zero debt) are excluded here — the keeper contract
 * says they must NEVER reach decideDeleverage.
 */
export function buildLoopSafetyInputs(
  observations: LoopHealthObservation[],
  rates: Map<number, FreshLoopRate>,
  policy: typeof LOOP_DELEVERAGE_POLICY = LOOP_DELEVERAGE_POLICY,
): LoopSafetyInputs {
  const candidates: LoopSafetyCandidate[] = [];
  const positions: PositionHealth[] = [];
  const states = new Map<string, VenueState>();
  const skipped: Array<{ rowId: string; reason: string }> = [];

  for (const { row, health } of observations) {
    // Defensive re-check — the monitor should only hand us open loop rows.
    if ((row.kind ?? "borrow") !== "loop" || row.status !== "open") {
      skipped.push({ rowId: row.id, reason: `not an open loop row (kind=${row.kind}, status=${row.status})` });
      continue;
    }

    const vaultId = Number(row.venueVaultId);
    if (!Number.isInteger(vaultId) || vaultId <= 0) {
      skipped.push({ rowId: row.id, reason: `unreadable venueVaultId '${row.venueVaultId}'` });
      continue;
    }

    if (health.status !== "available") {
      // Fail closed: no live read → no action. The monitor's 'unavailable'
      // band alert already tells the owner; acting blind could size wrong.
      skipped.push({ rowId: row.id, reason: `health unavailable: ${health.reason ?? "unknown"}` });
      continue;
    }

    // Candidate selection by LIVE DEBT, never policyState (a stale 'levered'
    // row whose delever verify-leg failed after the debt cleared must NOT be
    // unwound again; a NULL policyState with debt IS levered).
    let liveDebtRaw: bigint | null = null;
    if (health.liveDebtRaw !== null && /^\d+$/.test(health.liveDebtRaw)) {
      liveDebtRaw = BigInt(health.liveDebtRaw);
    }
    if (liveDebtRaw === null) {
      skipped.push({ rowId: row.id, reason: "live debt unreadable" });
      continue;
    }
    if (liveDebtRaw <= BigInt(0)) {
      // HOLD (or already-flat) row — nothing to deleverage.
      continue;
    }

    if (typeof health.healthFactor !== "number" || !Number.isFinite(health.healthFactor)) {
      skipped.push({ rowId: row.id, reason: "health factor unreadable with live debt > 0" });
      continue;
    }

    candidates.push({ row, vaultId, healthFactor: health.healthFactor, liveDebtRaw });

    // Carry at the position's ACTUAL leverage, derived from the live health
    // factor: HF = colSol·LT/debtSol and L = col/(col−debt) give the identity
    // L = HF/(HF−LT). Keyed PER POSITION (not per vault) because two wallets
    // on the same vault can sit at different leverage. Guards, all fail closed
    // to "no carry state" (health bands are unaffected):
    //  - LT unreadable/invalid → skip carry rule.
    //  - HF ≤ LT → leverage identity degenerates (at/inside liquidation
    //    territory) → skip carry rule; the health bands own this position.
    const posKey = `${venueKey(vaultId)}:pos:${row.id}`;
    positions.push({
      venue: posKey,
      positionId: row.id,
      healthFactor: health.healthFactor,
      liquidationFloor: policy.liquidationFloor,
    });
    const rate = rates.get(vaultId);
    const lt = rate?.liquidationThreshold ?? null;
    if (rate && typeof lt === "number" && Number.isFinite(lt) && lt > 0 && lt < 1 && health.healthFactor > lt) {
      const actualLeverage = health.healthFactor / (health.healthFactor - lt);
      const carryAtActual = netCarryAt(rate.stakingApy, rate.borrowApr, actualLeverage);
      if (carryAtActual !== null) {
        states.set(posKey, {
          venue: posKey,
          borrowRateApy: rate.borrowApr ?? 0,
          stakingYieldApy: rate.stakingApy ?? 0,
          netCarryApy: carryAtActual,
          borrowLiquiditySol: 0, // unused by decideDeleverage
          isFixedRate: false, // Jupiter Lend is variable-rate
          paused: false,
        });
      }
    }
  }

  return { candidates, positions, states, skipped };
}

// ---------------------------------------------------------------------------
// Orchestrator — decide + claim + execute + journal + notify.
// ---------------------------------------------------------------------------

export interface LoopSafetyTickResult {
  evaluated: number;
  acted: number;
  failed: number;
  skipped: number;
}

const symbolFor = (vaultId: number): string =>
  LOOP_VAULT_ALLOWLIST[vaultId]?.symbol ?? `vault ${vaultId}`;

/**
 * Run one safety-tick pass over the loop observations the health monitor just
 * collected. Never throws — every failure is isolated, logged, journaled.
 */
export async function runLoopSafetyTick(
  observations: LoopHealthObservation[],
  deps: LoopSafetyTickDeps,
): Promise<LoopSafetyTickResult> {
  const result: LoopSafetyTickResult = { evaluated: 0, acted: 0, failed: 0, skipped: 0 };
  if (observations.length === 0) return result;

  let rates: Map<number, FreshLoopRate>;
  try {
    rates = await deps.getFreshRates(LOOP_DELEVERAGE_POLICY.rateStalenessMs);
  } catch (e) {
    // Fail closed to "no carry data" — health bands still run.
    console.error(`[LoopSafetyTick] rate read failed (carry rule skipped): ${e instanceof Error ? e.message : String(e)}`);
    rates = new Map();
  }

  const { candidates, positions, states, skipped } = buildLoopSafetyInputs(observations, rates);
  result.skipped = skipped.length;
  for (const s of skipped) {
    console.warn(`[LoopSafetyTick] skipped row ${s.rowId}: ${s.reason}`);
  }
  if (positions.length === 0) return result;
  result.evaluated = positions.length;

  let decisions: DeleverageDecision[];
  try {
    decisions = decideDeleverage(positions, states, LOOP_DELEVERAGE_POLICY);
  } catch (e) {
    // Only reachable on a misconfigured policy (unwind >= reduce multiple).
    console.error(`[LoopSafetyTick] decideDeleverage refused (policy misconfigured?): ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  for (const decision of decisions) {
    if (decision.action === "none") continue;
    const cand = candidates.find((c) => c.row.id === decision.positionId);
    if (!cand) continue; // impossible by construction; defensive

    try {
      await executeSafetyAction(cand, decision, deps, result);
    } catch (e) {
      // Isolate per position — one failure must not stop the other loops.
      result.failed++;
      console.error(`[LoopSafetyTick] row ${cand.row.id} action failed unexpectedly:`, e);
    }
  }

  if (result.acted > 0 || result.failed > 0) {
    console.log(
      `[LoopSafetyTick] pass complete: evaluated=${result.evaluated} acted=${result.acted} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

async function executeSafetyAction(
  cand: LoopSafetyCandidate,
  decision: DeleverageDecision,
  deps: LoopSafetyTickDeps,
  result: LoopSafetyTickResult,
): Promise<void> {
  const { row, vaultId } = cand;
  const journalAction = decision.action === "unwind" ? "unwind_to_hold" : "reduce";
  const fraction = decision.action === "unwind" ? "1" : String(decision.fraction);

  // 1) Atomic per-position cooldown claim FIRST — before any key material.
  //    Losing the claim = another pass acted (or attempted) within the window.
  const claimed = await deps.claimPolicyAction(row.id, LOOP_DELEVERAGE_POLICY.cooldownMs);
  if (!claimed) return;

  const journal = async (details: Record<string, unknown>) => {
    try {
      await deps.persistDecision({
        walletAddress: row.walletAddress,
        borrowPositionId: row.id,
        vaultId,
        tick: "safety",
        action: journalAction,
        fraction,
        reason: decision.reason,
        details: {
          healthFactor: cand.healthFactor,
          liveDebtRaw: cand.liveDebtRaw.toString(),
          ...details,
        },
      });
    } catch (e) {
      // Journal is telemetry/audit — a write failure must never block the reflex.
      console.error(`[LoopSafetyTick] decision journal write failed for ${row.id}:`, e);
    }
  };

  // 2) Resolve the autonomous signer (execution-wrapped UMK; executionEnabled
  //    + emergency-stop gated inside). No signer → refuse, journal, alert.
  let signer: LoopSafetySigner | null = null;
  try {
    signer = await deps.resolveSigner(row.walletAddress);
  } catch (e) {
    console.error(`[LoopSafetyTick] signer resolution threw for ${row.walletAddress}:`, e);
  }
  if (!signer) {
    result.failed++;
    console.warn(`[LoopSafetyTick] no execution authorization for ${row.walletAddress} — cannot ${journalAction} row ${row.id}`);
    await journal({ executed: false, error: "no execution authorization (execution disabled, emergency stop, or re-key needed)" });
    await deps
      .notify(row.walletAddress, {
        symbol: symbolFor(vaultId),
        action: journalAction as "reduce" | "unwind_to_hold",
        ok: false,
        reason: decision.reason,
        detail: "we couldn't access execution authorization — reconnect your wallet to re-enable it",
      })
      .catch(() => {});
    return;
  }

  // 3) Execute. The executors re-read on-chain, fail closed pre-broadcast, and
  //    are resumable — a failure here safely retries next cooldown window.
  const clientRequestId = `loop-safety-${row.id}-${deps.now().getTime()}`;
  let ok = false;
  let signature: string | undefined;
  let errorText: string | undefined;
  let verifyWarning: string | undefined;
  let selfHeal = false;
  try {
    if (decision.action === "unwind") {
      const res = await deps.executeUnwindToHold({
        walletAddress: row.walletAddress,
        agentPublicKey: signer.agentPublicKey,
        agentSecretKey: signer.secretKey,
        borrowPositionId: row.id,
        clientRequestId,
        policyReason: decision.reason,
      });
      ok = res.success;
      signature = res.signature;
      errorText = res.error;
      verifyWarning = res.verifyWarning;
      selfHeal = res.selfHeal === true;
    } else {
      const unwindBps = Math.round(decision.fraction * 10000);
      const res = await deps.executeReduce({
        walletAddress: row.walletAddress,
        agentPublicKey: signer.agentPublicKey,
        agentSecretKey: signer.secretKey,
        borrowPositionId: row.id,
        unwindBps,
        clientRequestId,
      });
      ok = res.success;
      signature = res.signature;
      errorText = res.error;
      verifyWarning = res.verifyWarning;
    }
  } catch (e) {
    errorText = e instanceof Error ? e.message : String(e);
  } finally {
    signer.cleanup();
  }

  if (ok) {
    result.acted++;
    console.log(`[LoopSafetyTick] ${journalAction} EXECUTED for row ${row.id} (${decision.reason})${signature ? ` sig=${signature}` : ""}`);
  } else {
    result.failed++;
    console.error(`[LoopSafetyTick] ${journalAction} FAILED for row ${row.id}: ${errorText ?? "unknown error"}`);
  }

  await journal({
    executed: ok,
    clientRequestId,
    ...(signature ? { signature } : {}),
    ...(selfHeal ? { selfHeal: true } : {}),
    ...(verifyWarning ? { verifyWarning } : {}),
    ...(errorText ? { error: errorText.slice(0, 500) } : {}),
  });

  await deps
    .notify(row.walletAddress, {
      symbol: symbolFor(vaultId),
      action: journalAction as "reduce" | "unwind_to_hold",
      ok,
      reason: decision.reason,
      detail: ok ? null : (errorText ?? "unknown error"),
    })
    .catch(() => {});
}
