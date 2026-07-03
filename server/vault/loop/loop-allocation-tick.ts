/**
 * SOL LOOP VAULT (qntSOL) — P3 ALLOCATION TICK (~hourly EV brain, plan §4.4).
 *
 * The SLOW policy loop that owns the LEVERED↔HOLD carry decision. The 60s
 * safety tick is the fast reflex (health bands + carry bleed-stopper); this
 * tick is the only path that can INCREASE leverage (HOLD → re-lever).
 *
 *   levered + carry inverted/below floor  → executeLoopDeleverToHold
 *   holding + EV gap clears the minimum   → executeLoopRelever
 *
 * EV model (single-pair v0.5): EV(levered) − EV(hold) = (L−1)·(s − b), so the
 * whole brain reduces to "does staking APY beat the borrow APR by enough?"
 *
 * Money-safety contract:
 *  - Rates are sampled+persisted UPSTREAM FIRST each tick, then read back
 *    through the staleness gate — the brain only ever consumes persisted,
 *    fresh samples. Stale/absent → intent 'none' (fail closed, journaled).
 *  - Intent is derived from the PERSISTED row (debtAmountRaw); the executors
 *    re-read on-chain and fail closed themselves (a stale row cannot cause a
 *    wrong-direction action — relever refuses on live debt, delever refuses
 *    on a debt-free position; both self-heal the row instead).
 *  - HYSTERESIS: an action fires only when the last `hysteresisTicks`
 *    consecutive allocation decisions (this tick + the last N−1 persisted
 *    journal rows) agree on the SAME intent, and the oldest row of the streak
 *    is younger than `streakMaxAgeMs` (a streak spanning an outage is stale
 *    information). The journal IS the streak substrate — restart-safe.
 *  - Re-lever is leverage-INCREASING and therefore additionally gated inside
 *    the executor by `evaluateLoopOpenRequest` (depeg band / borrow APR
 *    ceiling / utilization) — a deny there is journaled, not retried blindly.
 *  - Exactly-once per window: the SAME atomic claim column as the safety tick
 *    (claimBorrowPositionPolicyAction) — mutual exclusion between opposing
 *    autonomous actions on one row is deliberate.
 *  - Every candidate lands EXACTLY ONE loop_policy_decisions row per tick
 *    (tick 'allocation'), including intent 'none' — the journal doubles as
 *    the hysteresis substrate, so silence would break the streak logic.
 */

import type { BorrowPosition, LoopPolicyDecision } from "@shared/schema";
import { storage } from "../../storage";
import { sendLoopSafetyNotification, type LoopSafetyNotification } from "../../notification-service";
import { DEFAULT_SOL_DEBT_DUST_RAW } from "../borrow-engine-core";
import { getFreshLoopRates, LOOP_CARRY_REFERENCE_LEVERAGE, netCarryAt, sampleAndPersistLoopRates, type FreshLoopRate, type LoopRateReading } from "./loop-rate-oracle";
import { computeLoopTargetLeverage, LOOP_ALLOCATION_POLICY, LOOP_VAULT_ALLOWLIST } from "./loop-risk-policy";
import type { LoopSafetySigner } from "./loop-safety-tick";
import {
  executeLoopRelever,
  executeLoopDeleverToHold,
  type LoopReleverParams,
  type LoopReleverResult,
  type LoopDeleverParams,
  type LoopDeleverResult,
} from "./loop-executor";

// ---------------------------------------------------------------------------
// Deps (injected for tests; production wiring in buildLoopAllocationDeps).
// ---------------------------------------------------------------------------

export interface LoopAllocationTickDeps {
  /** Sample + persist fresh rate readings FIRST (fail-soft; never throws). */
  sampleRates(): Promise<LoopRateReading[]>;
  /** Staleness-gated read-back of the persisted samples. */
  getFreshRates(maxAgeMs: number): Promise<Map<number, FreshLoopRate>>;
  /** All open positions platform-wide; the tick filters to kind='loop'. */
  listActivePositions(): Promise<BorrowPosition[]>;
  /** Newest-first allocation journal rows for ONE position (streak substrate). */
  getRecentDecisions(opts: {
    walletAddress: string;
    vaultId: number;
    tick?: string;
    borrowPositionId?: string;
    limit: number;
  }): Promise<LoopPolicyDecision[]>;
  /** Autonomous key resolution (execution-wrapped UMK) — wired from routes.ts. */
  resolveSigner(walletAddress: string): Promise<LoopSafetySigner | null>;
  claimPolicyAction(positionId: string, cooldownMs: number): Promise<BorrowPosition | null>;
  executeRelever(params: LoopReleverParams): Promise<LoopReleverResult>;
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
export function buildLoopAllocationDeps(
  resolveSigner: LoopAllocationTickDeps["resolveSigner"],
): LoopAllocationTickDeps {
  return {
    sampleRates: sampleAndPersistLoopRates,
    getFreshRates: getFreshLoopRates,
    listActivePositions: () => storage.getActiveBorrowPositionsAllWallets(),
    getRecentDecisions: (opts) => storage.getRecentLoopPolicyDecisions(opts),
    resolveSigner,
    claimPolicyAction: (id, cooldownMs) => storage.claimBorrowPositionPolicyAction(id, cooldownMs),
    executeRelever: executeLoopRelever,
    executeUnwindToHold: executeLoopDeleverToHold,
    persistDecision: async (d) => {
      await storage.insertLoopPolicyDecision(d);
    },
    notify: sendLoopSafetyNotification,
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// PURE intent + hysteresis — unit-testable, no I/O.
// ---------------------------------------------------------------------------

export type AllocationIntent = "relever" | "unwind" | "none";

export interface AllocationIntentResult {
  intent: AllocationIntent;
  reason: string;
  /** (L−1)·(s−b) — levered-minus-hold EV edge (fraction APY); null = unreadable. */
  evGapApy: number | null;
  /** Net carry AT the target leverage (fraction APY); null = unreadable. */
  netCarryApy: number | null;
}

/**
 * Decide this tick's intent for one position from persisted state + fresh
 * rates. PURE and FAIL CLOSED: any unreadable rate → 'none' with the reason.
 */
export function decideAllocationIntent(input: {
  levered: boolean;
  stakingApy: number | null;
  borrowApr: number | null;
  leverage: number;
  policy?: typeof LOOP_ALLOCATION_POLICY;
}): AllocationIntentResult {
  const policy = input.policy ?? LOOP_ALLOCATION_POLICY;
  const { levered, stakingApy, borrowApr, leverage } = input;

  if (
    typeof stakingApy !== "number" || !Number.isFinite(stakingApy) ||
    typeof borrowApr !== "number" || !Number.isFinite(borrowApr) ||
    !Number.isFinite(leverage) || leverage <= 1
  ) {
    return { intent: "none", reason: "rates_unreadable", evGapApy: null, netCarryApy: null };
  }

  const netCarryApy = netCarryAt(stakingApy, borrowApr, leverage);
  const evGapApy = (leverage - 1) * (stakingApy - borrowApr);
  if (netCarryApy === null) {
    return { intent: "none", reason: "rates_unreadable", evGapApy: null, netCarryApy: null };
  }

  if (levered) {
    if (borrowApr > stakingApy) {
      return { intent: "unwind", reason: "carry_inverted", evGapApy, netCarryApy };
    }
    if (netCarryApy < policy.carryFloorApy) {
      return { intent: "unwind", reason: "carry_below_floor", evGapApy, netCarryApy };
    }
    return { intent: "none", reason: "stay_levered", evGapApy, netCarryApy };
  }

  if (evGapApy > policy.minEvGapApy) {
    return { intent: "relever", reason: "ev_gap_favorable", evGapApy, netCarryApy };
  }
  return { intent: "none", reason: "stay_hold", evGapApy, netCarryApy };
}

/**
 * PURE streak check over the persisted journal (newest first). The current
 * tick counts as tick #N; the last N−1 rows must ALL carry the same intent
 * (details.intent) and the OLDEST of them must be younger than
 * `streakMaxAgeMs`. Any mismatch, gap, or stale row → no fire.
 */
export function hasIntentStreak(opts: {
  currentIntent: Exclude<AllocationIntent, "none">;
  priorDecisions: Array<Pick<LoopPolicyDecision, "details" | "createdAt">>;
  now: Date;
  policy?: typeof LOOP_ALLOCATION_POLICY;
}): { fires: boolean; streak: number } {
  const policy = opts.policy ?? LOOP_ALLOCATION_POLICY;
  const needed = Math.max(1, policy.hysteresisTicks) - 1; // current tick is #N
  if (needed === 0) return { fires: true, streak: 1 };

  let streak = 1; // current tick
  for (let i = 0; i < opts.priorDecisions.length && streak <= needed; i++) {
    const row = opts.priorDecisions[i];
    const intent = (row.details as Record<string, unknown> | null)?.intent;
    if (intent !== opts.currentIntent) break; // streak broken (incl. 'none')
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string);
    if (!Number.isFinite(created.getTime())) break;
    if (opts.now.getTime() - created.getTime() > policy.streakMaxAgeMs) break; // stale streak
    streak++;
  }
  return { fires: streak >= needed + 1, streak };
}

// ---------------------------------------------------------------------------
// Orchestrator — sample → decide → hysteresis → claim → execute → journal.
// ---------------------------------------------------------------------------

export interface LoopAllocationTickResult {
  evaluated: number;
  acted: number;
  failed: number;
  journaled: number;
  skipped: number;
}

const symbolFor = (vaultId: number): string =>
  LOOP_VAULT_ALLOWLIST[vaultId]?.symbol ?? `vault ${vaultId}`;

/**
 * Run one allocation pass over every open loop position platform-wide.
 * Never throws — every failure is isolated, logged, journaled.
 */
export async function runLoopAllocationTick(deps: LoopAllocationTickDeps): Promise<LoopAllocationTickResult> {
  const result: LoopAllocationTickResult = { evaluated: 0, acted: 0, failed: 0, journaled: 0, skipped: 0 };

  // 1) Sample + persist fresh rates FIRST (fail-soft — a sampling outage
  //    degrades to the staleness gate below, never to stale decisions).
  try {
    await deps.sampleRates();
  } catch (e) {
    console.error(`[LoopAllocationTick] rate sampling failed (staleness gate decides): ${e instanceof Error ? e.message : String(e)}`);
  }

  let rows: BorrowPosition[];
  try {
    rows = await deps.listActivePositions();
  } catch (e) {
    console.error(`[LoopAllocationTick] position list failed — skipping pass: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const loops = rows.filter((r) => (r.kind ?? "borrow") === "loop" && r.status === "open");
  if (loops.length === 0) return result;

  let rates: Map<number, FreshLoopRate>;
  try {
    rates = await deps.getFreshRates(LOOP_ALLOCATION_POLICY.rateStalenessMs);
  } catch (e) {
    console.error(`[LoopAllocationTick] rate read failed (all intents fail closed to none): ${e instanceof Error ? e.message : String(e)}`);
    rates = new Map();
  }

  for (const row of loops) {
    try {
      await processAllocationCandidate(row, rates, deps, result);
    } catch (e) {
      result.failed++;
      console.error(`[LoopAllocationTick] row ${row.id} failed unexpectedly:`, e);
    }
  }

  if (result.acted > 0 || result.failed > 0) {
    console.log(
      `[LoopAllocationTick] pass complete: evaluated=${result.evaluated} acted=${result.acted} failed=${result.failed} journaled=${result.journaled} skipped=${result.skipped}`,
    );
  }
  return result;
}

async function processAllocationCandidate(
  row: BorrowPosition,
  rates: Map<number, FreshLoopRate>,
  deps: LoopAllocationTickDeps,
  result: LoopAllocationTickResult,
): Promise<void> {
  const vaultId = Number(row.venueVaultId);
  if (!Number.isInteger(vaultId) || vaultId <= 0) {
    result.skipped++;
    console.warn(`[LoopAllocationTick] skipped row ${row.id}: unreadable venueVaultId '${row.venueVaultId}'`);
    return;
  }
  const vaultPolicy = LOOP_VAULT_ALLOWLIST[vaultId];
  if (!vaultPolicy) {
    result.skipped++;
    console.warn(`[LoopAllocationTick] skipped row ${row.id}: vault ${vaultId} not allowlisted`);
    return;
  }
  result.evaluated++;

  const rate = rates.get(vaultId) ?? null;

  // DYNAMIC target leverage from the SAME fresh persisted sample the intent
  // reads (live vault LT + min open health buffer + caps, positive carry
  // required). No computable target = NEVER lever up this tick.
  const target = computeLoopTargetLeverage({
    vaultId,
    liquidationThreshold: rate?.liquidationThreshold ?? null,
    stakingApy: rate?.stakingApy ?? null,
    borrowApr: rate?.borrowApr ?? null,
  });
  // Leverage the intent math runs at: the dynamic target when computable.
  // When it is not, LEVERED rows still need their unwind rules evaluated —
  // the decisions that matter there (carry inverted, unreadable rates) are
  // leverage-independent; the 2x reference only affects the floor check and
  // matches the previously shipped behavior. HOLD rows with no target are
  // forced to 'none' below regardless of this value.
  const leverage = target.leverage ?? LOOP_CARRY_REFERENCE_LEVERAGE;

  // Intent from the PERSISTED debt (executors re-verify live and self-heal).
  let levered = false;
  try {
    levered = BigInt(row.debtAmountRaw || "0") > DEFAULT_SOL_DEBT_DUST_RAW;
  } catch {
    levered = false;
  }

  let intentRes = decideAllocationIntent({
    levered,
    stakingApy: rate?.stakingApy ?? null,
    borrowApr: rate?.borrowApr ?? null,
    leverage,
  });
  if (target.leverage === null && intentRes.intent === "relever") {
    // FAIL CLOSED: no computable target → a HOLD row STAYS unlevered, however
    // favorable the EV gap looks (reachable when the LT is unreadable in the
    // sample — carry alone must never size a levered position).
    intentRes = {
      intent: "none",
      reason: `no_target_${target.reason ?? "unknown"}`,
      evGapApy: intentRes.evGapApy,
      netCarryApy: intentRes.netCarryApy,
    };
  }

  const journalAction = intentRes.intent === "unwind" ? "unwind_to_hold" : intentRes.intent;
  const baseDetails: Record<string, unknown> = {
    intent: intentRes.intent,
    levered,
    leverage,
    targetLeverage: target.leverage,
    targetReason: target.reason ?? null,
    liquidationThreshold: rate?.liquidationThreshold ?? null,
    stakingApy: rate?.stakingApy ?? null,
    borrowApr: rate?.borrowApr ?? null,
    evGapApy: intentRes.evGapApy,
    netCarryApy: intentRes.netCarryApy,
  };

  const journal = async (details: Record<string, unknown>) => {
    try {
      await deps.persistDecision({
        walletAddress: row.walletAddress,
        borrowPositionId: row.id,
        vaultId,
        tick: "allocation",
        action: journalAction,
        fraction: null,
        reason: intentRes.reason,
        details: { ...baseDetails, ...details },
      });
      result.journaled++;
    } catch (e) {
      // Journal write failures must never block the pass — but they DO break
      // the streak substrate, so shout.
      console.error(`[LoopAllocationTick] decision journal write failed for ${row.id}:`, e);
    }
  };

  if (intentRes.intent === "none") {
    await journal({ executed: false });
    return;
  }

  // Hysteresis: read the streak BEFORE this tick's row is written — the
  // current tick counts as tick #N of the streak.
  let prior: LoopPolicyDecision[] = [];
  try {
    prior = await deps.getRecentDecisions({
      walletAddress: row.walletAddress,
      vaultId,
      tick: "allocation",
      // Position-scoped: a re-opened position on the same vault must build a
      // FRESH streak, never inherit the closed position's journal rows.
      borrowPositionId: row.id,
      limit: Math.max(1, LOOP_ALLOCATION_POLICY.hysteresisTicks - 1),
    });
  } catch (e) {
    // Unreadable journal → treat as no streak (fail closed for actions).
    console.error(`[LoopAllocationTick] streak read failed for ${row.id} (treating as broken):`, e);
  }
  const streakRes = hasIntentStreak({ currentIntent: intentRes.intent, priorDecisions: prior, now: deps.now() });
  if (!streakRes.fires) {
    await journal({ executed: false, streak: streakRes.streak, hysteresis: "building" });
    return;
  }

  // Atomic per-position cooldown claim BEFORE any key material. Losing it =
  // another pass (safety or allocation) acted within the window.
  const claimed = await deps.claimPolicyAction(row.id, LOOP_ALLOCATION_POLICY.cooldownMs);
  if (!claimed) {
    await journal({ executed: false, streak: streakRes.streak, claimLost: true });
    return;
  }

  let signer: LoopSafetySigner | null = null;
  try {
    signer = await deps.resolveSigner(row.walletAddress);
  } catch (e) {
    console.error(`[LoopAllocationTick] signer resolution threw for ${row.walletAddress}:`, e);
  }
  if (!signer) {
    result.failed++;
    console.warn(`[LoopAllocationTick] no execution authorization for ${row.walletAddress} — cannot ${journalAction} row ${row.id}`);
    await journal({ executed: false, streak: streakRes.streak, error: "no execution authorization (execution disabled, emergency stop, or re-key needed)" });
    await deps
      .notify(row.walletAddress, {
        symbol: symbolFor(vaultId),
        action: journalAction as "relever" | "unwind_to_hold",
        ok: false,
        reason: intentRes.reason,
        detail: "we couldn't access execution authorization — reconnect your wallet to re-enable it",
      })
      .catch(() => {});
    return;
  }

  const clientRequestId = `loop-alloc-${row.id}-${deps.now().getTime()}`;
  let ok = false;
  let signature: string | undefined;
  let errorText: string | undefined;
  let verifyWarning: string | undefined;
  let selfHeal = false;
  let policyDenied = false;
  try {
    if (intentRes.intent === "unwind") {
      const res = await deps.executeUnwindToHold({
        walletAddress: row.walletAddress,
        agentPublicKey: signer.agentPublicKey,
        agentSecretKey: signer.secretKey,
        borrowPositionId: row.id,
        clientRequestId,
        policyReason: intentRes.reason,
      });
      ok = res.success;
      signature = res.signature;
      errorText = res.error;
      verifyWarning = res.verifyWarning;
      selfHeal = res.selfHeal === true;
    } else {
      const res = await deps.executeRelever({
        walletAddress: row.walletAddress,
        agentPublicKey: signer.agentPublicKey,
        agentSecretKey: signer.secretKey,
        borrowPositionId: row.id,
        leverage,
        clientRequestId,
        policyReason: intentRes.reason,
      });
      ok = res.success;
      signature = res.signature;
      errorText = res.error;
      verifyWarning = res.verifyWarning;
      selfHeal = res.selfHeal === true;
      policyDenied = !ok && (res.policyReasons?.some((r) => r.severity === "deny") ?? false);
    }
  } catch (e) {
    errorText = e instanceof Error ? e.message : String(e);
  } finally {
    signer.cleanup();
  }

  if (ok) {
    result.acted++;
    console.log(`[LoopAllocationTick] ${journalAction} EXECUTED for row ${row.id} (${intentRes.reason})${signature ? ` sig=${signature}` : ""}`);
  } else {
    result.failed++;
    console.error(`[LoopAllocationTick] ${journalAction} FAILED for row ${row.id}: ${errorText ?? "unknown error"}`);
  }

  await journal({
    executed: ok,
    streak: streakRes.streak,
    clientRequestId,
    ...(signature ? { signature } : {}),
    ...(selfHeal ? { selfHeal: true } : {}),
    ...(verifyWarning ? { verifyWarning } : {}),
    ...(policyDenied ? { policyDenied: true } : {}),
    ...(errorText ? { error: errorText.slice(0, 500) } : {}),
  });

  await deps
    .notify(row.walletAddress, {
      symbol: symbolFor(vaultId),
      action: journalAction as "relever" | "unwind_to_hold",
      ok,
      reason: intentRes.reason,
      detail: ok ? null : (errorText ?? "unknown error"),
    })
    .catch(() => {});
}
