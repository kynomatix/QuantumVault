/**
 * SOL Loop Vault P3 — allocation tick tests (T105).
 *
 * Covers the PURE relever sizing/verify core, the PURE intent + hysteresis
 * brain, and the orchestrator's money-safety ordering (journal EVERY tick,
 * streak-before-claim, claim-before-key-material, fail-closed on stale rates,
 * refuse-without-signer, per-position failure isolation).
 */
import { describe, expect, it } from "vitest";
import type { BorrowOperation, BorrowPosition, LoopPolicyDecision } from "@shared/schema";
import {
  computeLoopReleverAmounts,
  verifyLoopReleverOutcome,
} from "../../server/vault/borrow-engine-core";
import type { FreshLoopRate } from "../../server/vault/loop/loop-rate-oracle";
import { LOOP_ALLOCATION_POLICY } from "../../server/vault/loop/loop-risk-policy";
import type { LoopSafetySigner } from "../../server/vault/loop/loop-safety-tick";
import {
  decideAllocationIntent,
  decideHopTarget,
  hasIntentStreak,
  runLoopAllocationTick,
  type LoopAllocationTickDeps,
} from "../../server/vault/loop/loop-allocation-tick";

// ─── pure core: relever sizing ───────────────────────────────────────────────

describe("computeLoopReleverAmounts", () => {
  it("sizes equity and flash leg from live collateral at the venue rate (floor)", () => {
    // 10 LST (1e9 scale) at 1.05 SOL/LST, target 2x → equity 10.5 SOL, flash (2-1)×10.5.
    const r = computeLoopReleverAmounts(10_000_000_000n, 1.05, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.equityLamports).toBe(10_500_000_000n);
    expect(r.flashLamports).toBe(10_500_000_000n);
  });

  it("floors fractional leverage in bps", () => {
    const r = computeLoopReleverAmounts(10_000_000_000n, 1.0, 1.5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.equityLamports).toBe(10_000_000_000n);
    expect(r.flashLamports).toBe(5_000_000_000n); // (1.5−1) = 5000 bps
  });

  it("fails closed on zero collateral, bad rate, and out-of-bounds leverage", () => {
    expect(computeLoopReleverAmounts(0n, 1.05, 2).ok).toBe(false);
    expect(computeLoopReleverAmounts(10n ** 9n, NaN, 2).ok).toBe(false);
    expect(computeLoopReleverAmounts(10n ** 9n, 0, 2).ok).toBe(false);
    expect(computeLoopReleverAmounts(10n ** 9n, -1, 2).ok).toBe(false);
    expect(computeLoopReleverAmounts(10n ** 9n, 1.05, 1).ok).toBe(false);
    expect(computeLoopReleverAmounts(10n ** 9n, 1.05, 11).ok).toBe(false);
    expect(computeLoopReleverAmounts(10n ** 9n, 1.05, NaN).ok).toBe(false);
  });
});

describe("verifyLoopReleverOutcome", () => {
  const base = {
    preColRaw: 10_000_000_000n,
    flashDebtRaw: 10_000_000_000n,
    minCollateralAddRaw: 9_500_000_000n,
  };

  it("accepts debt ≈ flash leg and collateral grown by at least minOut", () => {
    const r = verifyLoopReleverOutcome({
      ...base,
      observedDebtRaw: 10_000_000_500n, // within tolerance
      observedColRaw: 19_600_000_000n, // pre + more than minOut
    });
    expect(r.ok).toBe(true);
  });

  it("rejects collateral below pre + minOut (swap under-delivered)", () => {
    const r = verifyLoopReleverOutcome({
      ...base,
      observedDebtRaw: 10_000_000_000n,
      observedColRaw: 19_000_000_000n, // < pre + minOut
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("loop_relever_collateral_below_min_add");
  });

  it("rejects debt exceeding the flash leg beyond tolerance (dangerous direction)", () => {
    const r = verifyLoopReleverOutcome({
      ...base,
      observedDebtRaw: 10_200_000_000n, // +2%
      observedColRaw: 19_600_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("loop_relever_debt_exceeds_flash_leg");
  });

  it("rejects a large debt shortfall as a mismatch", () => {
    const r = verifyLoopReleverOutcome({
      ...base,
      observedDebtRaw: 8_000_000_000n,
      observedColRaw: 19_600_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("loop_relever_debt_mismatch");
  });
});

// ─── pure brain: intent ──────────────────────────────────────────────────────

describe("decideAllocationIntent", () => {
  it("fails closed to none when rates are unreadable", () => {
    expect(decideAllocationIntent({ levered: true, stakingApy: null, borrowApr: 0.05, leverage: 2 }).intent).toBe("none");
    expect(decideAllocationIntent({ levered: false, stakingApy: 0.07, borrowApr: null, leverage: 2 }).intent).toBe("none");
    const r = decideAllocationIntent({ levered: true, stakingApy: NaN, borrowApr: 0.05, leverage: 2 });
    expect(r.intent).toBe("none");
    expect(r.reason).toBe("rates_unreadable");
  });

  it("levered + inverted carry (b > s) → unwind carry_inverted", () => {
    const r = decideAllocationIntent({ levered: true, stakingApy: 0.05, borrowApr: 0.08, leverage: 2 });
    expect(r.intent).toBe("unwind");
    expect(r.reason).toBe("carry_inverted");
  });

  it("levered + net carry below the floor → unwind carry_below_floor", () => {
    // s=0.05, b=0.098 would invert; use s=0.06, b=0.118 at 2x → carry 0.002 < 0.005 floor
    // but b>s inverts first — pick s=0.06, b=0.059: carry = 0.12−0.059 = 0.061? No.
    // netCarryAt(s,b,L) = s·L − b·(L−1) = 2s − b at 2x. Want 0 < 2s−b < 0.005 with b<s:
    // s=0.004, b=0.0039 → carry 0.0041 < 0.005.
    const r = decideAllocationIntent({ levered: true, stakingApy: 0.004, borrowApr: 0.0039, leverage: 2 });
    expect(r.intent).toBe("unwind");
    expect(r.reason).toBe("carry_below_floor");
  });

  it("levered + healthy carry → stay levered", () => {
    const r = decideAllocationIntent({ levered: true, stakingApy: 0.07, borrowApr: 0.05, leverage: 2 });
    expect(r.intent).toBe("none");
    expect(r.reason).toBe("stay_levered");
    expect(r.netCarryApy).toBeCloseTo(0.09, 10);
  });

  it("holding + EV gap above the minimum → relever", () => {
    // (2−1)(0.07−0.05) = 0.02 > 0.01
    const r = decideAllocationIntent({ levered: false, stakingApy: 0.07, borrowApr: 0.05, leverage: 2 });
    expect(r.intent).toBe("relever");
    expect(r.reason).toBe("ev_gap_favorable");
    expect(r.evGapApy).toBeCloseTo(0.02, 10);
  });

  it("holding + thin EV gap → stay hold (hysteresis dead-band)", () => {
    // (2−1)(0.056−0.05) = 0.006 ≤ 0.01
    const r = decideAllocationIntent({ levered: false, stakingApy: 0.056, borrowApr: 0.05, leverage: 2 });
    expect(r.intent).toBe("none");
    expect(r.reason).toBe("stay_hold");
  });
});

// ─── pure brain: hysteresis streak ───────────────────────────────────────────

function decisionRow(intent: string, ageMs: number, now: Date): Pick<LoopPolicyDecision, "details" | "createdAt"> {
  return {
    details: { intent },
    createdAt: new Date(now.getTime() - ageMs),
  } as unknown as Pick<LoopPolicyDecision, "details" | "createdAt">;
}

function hopRow(targetVaultId: number, ageMs: number, now: Date): Pick<LoopPolicyDecision, "details" | "createdAt"> {
  return {
    details: { intent: "hop", hopTargetVaultId: targetVaultId },
    createdAt: new Date(now.getTime() - ageMs),
  } as unknown as Pick<LoopPolicyDecision, "details" | "createdAt">;
}

describe("hasIntentStreak", () => {
  const now = new Date("2026-07-03T12:00:00Z");
  const HOUR = 60 * 60 * 1000;

  it("fires when the last N−1 rows all match the current intent within the age window", () => {
    const prior = [decisionRow("unwind", 1 * HOUR, now), decisionRow("unwind", 2 * HOUR, now)];
    const r = hasIntentStreak({ currentIntent: "unwind", priorDecisions: prior, now });
    expect(r.fires).toBe(true);
    expect(r.streak).toBe(LOOP_ALLOCATION_POLICY.hysteresisTicks);
  });

  it("a single blip ('none' row) breaks the streak", () => {
    const prior = [decisionRow("none", 1 * HOUR, now), decisionRow("unwind", 2 * HOUR, now)];
    const r = hasIntentStreak({ currentIntent: "unwind", priorDecisions: prior, now });
    expect(r.fires).toBe(false);
    expect(r.streak).toBe(1);
  });

  it("an opposing intent breaks the streak", () => {
    const prior = [decisionRow("relever", 1 * HOUR, now), decisionRow("unwind", 2 * HOUR, now)];
    expect(hasIntentStreak({ currentIntent: "unwind", priorDecisions: prior, now }).fires).toBe(false);
  });

  it("a streak spanning an outage (row older than streakMaxAgeMs) does NOT fire", () => {
    const prior = [
      decisionRow("relever", 1 * HOUR, now),
      decisionRow("relever", LOOP_ALLOCATION_POLICY.streakMaxAgeMs + HOUR, now),
    ];
    expect(hasIntentStreak({ currentIntent: "relever", priorDecisions: prior, now }).fires).toBe(false);
  });

  it("too few prior rows → still building", () => {
    const prior = [decisionRow("relever", 1 * HOUR, now)];
    const r = hasIntentStreak({ currentIntent: "relever", priorDecisions: prior, now });
    expect(r.fires).toBe(false);
    expect(r.streak).toBe(2);
  });

  it("HOP: prior rows toward the SAME target count as a streak", () => {
    const prior = [hopRow(5, 1 * HOUR, now), hopRow(5, 2 * HOUR, now)];
    const r = hasIntentStreak({ currentIntent: "hop", priorDecisions: prior, now, matchTargetVaultId: 5 });
    expect(r.fires).toBe(true);
    expect(r.streak).toBe(LOOP_ALLOCATION_POLICY.hysteresisTicks);
  });

  it("HOP: a DIFFERENT prior target breaks the streak (yield leader flapping)", () => {
    const prior = [hopRow(42, 1 * HOUR, now), hopRow(5, 2 * HOUR, now)];
    const r = hasIntentStreak({ currentIntent: "hop", priorDecisions: prior, now, matchTargetVaultId: 5 });
    expect(r.fires).toBe(false);
    expect(r.streak).toBe(1);
  });

  it("HOP: a prior hop row with NO recorded target breaks the streak", () => {
    const prior = [decisionRow("hop", 1 * HOUR, now), hopRow(5, 2 * HOUR, now)];
    const r = hasIntentStreak({ currentIntent: "hop", priorDecisions: prior, now, matchTargetVaultId: 5 });
    expect(r.fires).toBe(false);
    expect(r.streak).toBe(1);
  });
});

// ─── pure brain: hop decision ────────────────────────────────────────────────

describe("decideHopTarget", () => {
  const ALLOWED = [4, 5, 42, 47]; // JupSOL, JitoSOL, INF, mSOL

  it("hops to an alternative pair whose carry gain clears the bar", () => {
    // current (4): 3.7·0.06 − 2.7·0.05 = 0.087; alt (5): 3.7·0.09 − 2.7·0.05 = 0.198.
    const rates = new Map([
      [4, makeRate(4, 0.06, 0.05)],
      [5, makeRate(5, 0.09, 0.05)],
    ]);
    const r = decideHopTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(r.reason).toBe("hop_carry_favorable");
    expect(r.targetVaultId).toBe(5);
    expect(r.carryGainApy!).toBeGreaterThan(LOOP_ALLOCATION_POLICY.hopMinCarryGainApy);
  });

  it("does NOT hop when the best alternative's gain is below the bar", () => {
    // alt (5) barely better: gain ≈ 0.011 < 0.02 bar.
    const rates = new Map([
      [4, makeRate(4, 0.06, 0.05)],
      [5, makeRate(5, 0.063, 0.05)],
    ]);
    const r = decideHopTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(r.reason).toBe("gain_below_threshold");
    expect(r.targetVaultId).toBeNull();
    expect(r.carryGainApy).not.toBeNull();
    expect(r.carryGainApy!).toBeLessThanOrEqual(LOOP_ALLOCATION_POLICY.hopMinCarryGainApy);
  });

  it("fails closed when the CURRENT pair's carry is unreadable", () => {
    // rates has an alternative but nothing for the current vault → never hop.
    const rates = new Map([[5, makeRate(5, 0.09, 0.05)]]);
    const r = decideHopTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(r.reason).toBe("current_carry_unreadable");
    expect(r.targetVaultId).toBeNull();
  });

  it("does NOT hop when no alternative pair has a computable target", () => {
    // only the current pair is readable → no alternative to move to.
    const rates = new Map([[4, makeRate(4, 0.06, 0.05)]]);
    const r = decideHopTarget({ currentVaultId: 4, rates, allowedVaultIds: ALLOWED });
    expect(r.reason).toBe("no_alternative_target");
    expect(r.targetVaultId).toBeNull();
    expect(r.currentNetCarryApy).not.toBeNull();
  });
});

// ─── orchestrator fixtures ───────────────────────────────────────────────────

function makeRow(overrides: Partial<BorrowPosition> = {}): BorrowPosition {
  return {
    id: overrides.id ?? "row-1",
    walletAddress: "WALLET_A",
    kind: "loop",
    status: "open",
    venueVaultId: "4", // JupSOL on the allowlist
    debtAmountRaw: "1000000000", // levered by default
    policyState: "levered",
    ...overrides,
  } as unknown as BorrowPosition;
}

function makeRate(
  vaultId: number,
  stakingApy: number,
  borrowApr: number,
  liquidationThreshold: number | null = 0.95, // JupSOL live LT → dynamic target 3.7x
): FreshLoopRate {
  return {
    vaultId,
    symbol: "JupSOL",
    stakingApy,
    stakingApyMean30d: stakingApy,
    borrowApr,
    liquidationThreshold,
    netCarry2x: 2 * stakingApy - borrowApr,
    asOf: new Date(),
  } as unknown as FreshLoopRate;
}

interface Calls {
  sampleCalls: number;
  claims: Array<{ id: string; cooldownMs: number }>;
  signerRequests: string[];
  relevers: Array<Record<string, unknown>>;
  unwinds: Array<Record<string, unknown>>;
  hops: Array<Record<string, unknown>>;
  pendingHopFetches: number;
  decisions: Array<Record<string, any>>;
  notifications: Array<Record<string, unknown>>;
  cleanups: number;
  order: string[];
}

function makeDeps(overrides: Partial<LoopAllocationTickDeps> = {}): { deps: LoopAllocationTickDeps; calls: Calls } {
  const calls: Calls = {
    sampleCalls: 0,
    claims: [],
    signerRequests: [],
    relevers: [],
    unwinds: [],
    hops: [],
    pendingHopFetches: 0,
    decisions: [],
    notifications: [],
    cleanups: 0,
    order: [],
  };
  const signer: LoopSafetySigner = {
    agentPublicKey: "AGENT_PUB",
    secretKey: new Uint8Array(64),
    cleanup: () => {
      calls.cleanups++;
      calls.order.push("cleanup");
    },
  };
  const deps: LoopAllocationTickDeps = {
    sampleRates: async () => {
      calls.sampleCalls++;
      calls.order.push("sampleRates");
      return [];
    },
    getFreshRates: async () => {
      calls.order.push("getFreshRates");
      return new Map();
    },
    listActivePositions: async () => [makeRow()],
    getRecentDecisions: async () => [],
    resolveSigner: async (wallet) => {
      calls.signerRequests.push(wallet);
      calls.order.push("resolveSigner");
      return signer;
    },
    claimPolicyAction: async (id, cooldownMs) => {
      calls.claims.push({ id, cooldownMs });
      calls.order.push("claim");
      return makeRow({ id });
    },
    executeRelever: async (params) => {
      calls.relevers.push(params as unknown as Record<string, unknown>);
      calls.order.push("executeRelever");
      return { success: true, signature: "SIG_RELEVER" };
    },
    executeUnwindToHold: async (params) => {
      calls.unwinds.push(params as unknown as Record<string, unknown>);
      calls.order.push("executeUnwind");
      return { success: true, signature: "SIG_UNWIND" };
    },
    executeHop: async (params) => {
      calls.hops.push(params as unknown as Record<string, unknown>);
      calls.order.push("executeHop");
      return {
        success: true,
        openSignature: "SIG_HOP_OPEN",
        closeSignature: "SIG_HOP_CLOSE",
        borrowPositionId: "NEW_LOOP",
      };
    },
    getPendingHops: async () => {
      calls.pendingHopFetches++;
      calls.order.push("getPendingHops");
      return [];
    },
    persistDecision: async (d) => {
      calls.decisions.push(d as unknown as Record<string, any>);
      calls.order.push("persist");
    },
    notify: async (_wallet, n) => {
      calls.notifications.push(n as unknown as Record<string, unknown>);
      calls.order.push("notify");
      return "sent";
    },
    now: () => new Date("2026-07-03T12:00:00Z"),
    ...overrides,
  };
  return { deps, calls };
}

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-07-03T12:00:00Z");

function priorRows(intent: string, count: number): LoopPolicyDecision[] {
  return Array.from({ length: count }, (_, i) =>
    decisionRow(intent, (i + 1) * HOUR, NOW),
  ) as unknown as LoopPolicyDecision[];
}

function priorHopRows(targetVaultId: number, count: number): LoopPolicyDecision[] {
  return Array.from({ length: count }, (_, i) =>
    hopRow(targetVaultId, (i + 1) * HOUR, NOW),
  ) as unknown as LoopPolicyDecision[];
}

function makeHopOp(overrides: Record<string, any> = {}): BorrowOperation {
  return {
    id: "op-hop-1",
    walletAddress: "WALLET_A",
    clientRequestId: "creq-1",
    borrowPositionId: "row-1",
    metadata: { sourceBorrowPositionId: "row-1", toVaultId: 5, policyReason: "hop_carry_favorable" },
    ...overrides,
  } as unknown as BorrowOperation;
}

// ─── orchestrator behavior ───────────────────────────────────────────────────

describe("runLoopAllocationTick", () => {
  it("samples rates FIRST, then reads them back through the staleness gate", async () => {
    const { deps, calls } = makeDeps();
    await runLoopAllocationTick(deps);
    expect(calls.sampleCalls).toBe(1);
    expect(calls.order.indexOf("sampleRates")).toBeLessThan(calls.order.indexOf("getFreshRates"));
  });

  it("stale/absent rates → journals intent none (rates_unreadable), never acts", async () => {
    const { deps, calls } = makeDeps(); // getFreshRates returns empty map
    const res = await runLoopAllocationTick(deps);
    expect(res.evaluated).toBe(1);
    expect(res.acted).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.signerRequests).toHaveLength(0);
    expect(calls.decisions).toHaveLength(1);
    expect(calls.decisions[0].action).toBe("none");
    expect(calls.decisions[0].reason).toBe("rates_unreadable");
    expect(calls.decisions[0].tick).toBe("allocation");
  });

  it("carry inversion with a full streak → unwinds to hold and journals executed", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.04, 0.08)]]), // b > s
      getRecentDecisions: async () => priorRows("unwind", 2),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(1);
    expect(calls.unwinds).toHaveLength(1);
    expect(calls.relevers).toHaveLength(0);
    expect(calls.unwinds[0].policyReason).toBe("carry_inverted");
    expect(calls.decisions[0].action).toBe("unwind_to_hold");
    expect(calls.decisions[0].details.executed).toBe(true);
    expect(calls.notifications[0]).toMatchObject({ action: "unwind_to_hold", ok: true });
    expect(calls.cleanups).toBe(1);
    // Money-safety ordering: claim BEFORE key material.
    expect(calls.order.indexOf("claim")).toBeLessThan(calls.order.indexOf("resolveSigner"));
  });

  it("a blip resets the streak — no action, journals hysteresis building", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.04, 0.08)]]),
      getRecentDecisions: async () => [
        ...priorRows("none", 1),
        ...priorRows("unwind", 1),
      ],
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.unwinds).toHaveLength(0);
    expect(calls.decisions[0].details.hysteresis).toBe("building");
    expect(calls.decisions[0].details.executed).toBe(false);
  });

  it("an outage-stale streak does NOT fire", async () => {
    const staleRows = [
      decisionRow("unwind", 1 * HOUR, NOW),
      decisionRow("unwind", LOOP_ALLOCATION_POLICY.streakMaxAgeMs + HOUR, NOW),
    ] as unknown as LoopPolicyDecision[];
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.04, 0.08)]]),
      getRecentDecisions: async () => staleRows,
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.unwinds).toHaveLength(0);
  });

  it("HOLD row with a favorable EV gap and full streak → re-levers at the DYNAMIC target leverage", async () => {
    const { deps, calls } = makeDeps({
      listActivePositions: async () => [makeRow({ debtAmountRaw: "0", policyState: "hold" })],
      getFreshRates: async () => new Map([[4, makeRate(4, 0.08, 0.05)]]), // gap 0.03 > 0.01
      getRecentDecisions: async () => priorRows("relever", 2),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(1);
    expect(calls.relevers).toHaveLength(1);
    expect(calls.unwinds).toHaveLength(0);
    // LT 0.95 → min(cap 5, hard cap 5, 1.3/(1.3−0.95) ≈ 3.714) quantized DOWN → 3.7x
    expect(calls.relevers[0].leverage).toBe(3.7);
    expect(calls.relevers[0].policyReason).toBe("ev_gap_favorable");
    expect(calls.decisions[0].action).toBe("relever");
    expect(calls.decisions[0].details.executed).toBe(true);
    expect(calls.notifications[0]).toMatchObject({ action: "relever", ok: true });
  });

  it("streak read is POSITION-scoped — a re-opened position never inherits the closed position's journal rows", async () => {
    // Same wallet + vault, but the journal only holds rows for the OLD
    // (closed) position id. The scoped read must return nothing for the new
    // position → streak broken → no action despite a favorable gap.
    const seen: Array<Record<string, unknown>> = [];
    const oldRows = priorRows("relever", 2);
    const { deps, calls } = makeDeps({
      listActivePositions: async () => [makeRow({ id: "pos-new", debtAmountRaw: "0" })],
      getFreshRates: async () => new Map([[4, makeRate(4, 0.08, 0.05)]]),
      getRecentDecisions: async (opts) => {
        seen.push({ ...opts });
        // Faithful position-scoped journal: old rows belong to "pos-old".
        return opts.borrowPositionId === "pos-old" ? oldRows : [];
      },
    });
    const res = await runLoopAllocationTick(deps);
    expect(seen).toHaveLength(1);
    expect(seen[0].borrowPositionId).toBe("pos-new");
    expect(res.acted).toBe(0);
    expect(calls.relevers).toHaveLength(0);
    // Still journaled this tick (the journal IS the streak substrate).
    expect(calls.decisions).toHaveLength(1);
    expect(calls.decisions[0].details.intent).toBe("relever");
  });

  it("HOLD row with a thin gap → stays hold, journaled, no claim", async () => {
    const { deps, calls } = makeDeps({
      listActivePositions: async () => [makeRow({ debtAmountRaw: "0" })],
      // At the 3.7x dynamic target, gap = (L−1)(s−b) = 2.7·0.002 ≈ 0.0054 < 0.01 → thin.
      getFreshRates: async () => new Map([[4, makeRate(4, 0.052, 0.05)]]),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.decisions[0].reason).toBe("stay_hold");
  });

  it("claim lost → skips execution silently (another pass owns the window), journals claimLost", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.04, 0.08)]]),
      getRecentDecisions: async () => priorRows("unwind", 2),
      claimPolicyAction: async () => null,
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.signerRequests).toHaveLength(0); // never touched key material
    expect(calls.unwinds).toHaveLength(0);
    expect(calls.decisions[0].details.claimLost).toBe(true);
  });

  it("no signer → refuses, journals the error, notifies not-ok", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.04, 0.08)]]),
      getRecentDecisions: async () => priorRows("unwind", 2),
      resolveSigner: async () => null,
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(res.failed).toBe(1);
    expect(calls.unwinds).toHaveLength(0);
    expect(calls.decisions[0].details.executed).toBe(false);
    expect(String(calls.decisions[0].details.error)).toMatch(/execution authorization/);
    expect(calls.notifications[0]).toMatchObject({ action: "unwind_to_hold", ok: false });
  });

  it("executor policy-deny is journaled (policyDenied) and notified not-ok", async () => {
    const { deps, calls } = makeDeps({
      listActivePositions: async () => [makeRow({ debtAmountRaw: "0" })],
      getFreshRates: async () => new Map([[4, makeRate(4, 0.08, 0.05)]]),
      getRecentDecisions: async () => priorRows("relever", 2),
      executeRelever: async () => ({
        success: false,
        error: "Loop Re-Lever blocked by risk policy: depeg",
        policyReasons: [{ code: "loop_depeg_paused", severity: "deny", message: "depeg", facts: {} }],
      }),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(res.failed).toBe(1);
    expect(calls.decisions[0].details.policyDenied).toBe(true);
    expect(calls.notifications[0]).toMatchObject({ action: "relever", ok: false });
  });

  it("non-allowlisted vault rows are skipped, never journaled as decisions", async () => {
    const { deps, calls } = makeDeps({
      listActivePositions: async () => [makeRow({ venueVaultId: "999" })],
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.evaluated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(calls.decisions).toHaveLength(0);
  });

  it("non-loop and closed rows are ignored entirely", async () => {
    const { deps, calls } = makeDeps({
      listActivePositions: async () => [
        makeRow({ id: "b1", kind: "borrow" } as Partial<BorrowPosition>),
        makeRow({ id: "c1", status: "closed" } as Partial<BorrowPosition>),
      ],
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.evaluated).toBe(0);
    expect(calls.sampleCalls).toBe(1); // rates still sampled for the table
    expect(calls.decisions).toHaveLength(0);
  });

  it("one position's unexpected throw does not stop the pass", async () => {
    const rows = [
      makeRow({ id: "boom", debtAmountRaw: "0" }),
      makeRow({ id: "ok-row", walletAddress: "WALLET_B", debtAmountRaw: "0" }),
    ];
    const { deps, calls } = makeDeps({
      listActivePositions: async () => rows,
      getFreshRates: async () => new Map([[4, makeRate(4, 0.08, 0.05)]]),
      getRecentDecisions: async (opts) => {
        if (opts.walletAddress === "WALLET_A") throw new Error("journal read boom");
        return priorRows("relever", 2);
      },
    });
    const res = await runLoopAllocationTick(deps);
    // WALLET_A's streak read failed → treated as broken (no action, journaled);
    // WALLET_B proceeds to a full re-lever.
    expect(res.acted).toBe(1);
    expect(calls.relevers).toHaveLength(1);
    expect((calls.relevers[0] as any).walletAddress).toBe("WALLET_B");
  });

  // ─── HOP (P4) ──────────────────────────────────────────────────────────────

  it("levered position kept by the single-pair brain HOPS to a better pair when the gain clears the bar and the streak is full", async () => {
    const { deps, calls } = makeDeps({
      // current (4) healthy carry → single-pair brain says stay_levered;
      // alt (5) beats it by ≫ the hop bar.
      getFreshRates: async () => new Map([[4, makeRate(4, 0.06, 0.05)], [5, makeRate(5, 0.09, 0.05)]]),
      getRecentDecisions: async () => priorHopRows(5, 2),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(1);
    expect(calls.hops).toHaveLength(1);
    expect(calls.hops[0].targetVaultId).toBe(5);
    expect(calls.hops[0].borrowPositionId).toBe("row-1");
    expect(calls.hops[0].policyReason).toBe("hop_carry_favorable");
    expect(calls.relevers).toHaveLength(0);
    expect(calls.unwinds).toHaveLength(0);
    expect(calls.decisions[0].action).toBe("hop");
    expect(calls.decisions[0].reason).toBe("hop_carry_favorable");
    expect(calls.decisions[0].details.hopTargetVaultId).toBe(5);
    expect(calls.decisions[0].details.executed).toBe(true);
    expect(calls.notifications[0]).toMatchObject({ action: "hop", ok: true });
    expect(calls.cleanups).toBe(1);
    // Money-safety ordering: claim BEFORE key material.
    expect(calls.order.indexOf("claim")).toBeLessThan(calls.order.indexOf("resolveSigner"));
  });

  it("hop is streak-gated — a single prior tick toward the target does NOT fire (building)", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.06, 0.05)], [5, makeRate(5, 0.09, 0.05)]]),
      getRecentDecisions: async () => priorHopRows(5, 1),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.hops).toHaveLength(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.decisions[0].action).toBe("hop");
    expect(calls.decisions[0].details.hysteresis).toBe("building");
    expect(calls.decisions[0].details.executed).toBe(false);
  });

  it("hop streak toward a DIFFERENT prior target does NOT fire (flapping suppression)", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.06, 0.05)], [5, makeRate(5, 0.09, 0.05)]]),
      getRecentDecisions: async () => priorHopRows(42, 2), // prior hops targeted vault 42, this tick targets 5
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.hops).toHaveLength(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.decisions[0].details.hysteresis).toBe("building");
  });

  it("gain below the hop bar → stays levered, no hop, no claim", async () => {
    const { deps, calls } = makeDeps({
      // alt (5) only marginally better → gain below the 0.02 bar.
      getFreshRates: async () => new Map([[4, makeRate(4, 0.06, 0.05)], [5, makeRate(5, 0.063, 0.05)]]),
      getRecentDecisions: async () => priorHopRows(5, 2),
    });
    const res = await runLoopAllocationTick(deps);
    expect(res.acted).toBe(0);
    expect(calls.hops).toHaveLength(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.decisions[0].action).toBe("none");
    expect(calls.decisions[0].reason).toBe("stay_levered");
  });

  it("resume sweep drives a mid-flight hop to terminal with the SAME key BEFORE the per-row pass, and skips a second action on that position", async () => {
    const { deps, calls } = makeDeps({
      getPendingHops: async () => {
        calls.pendingHopFetches++;
        calls.order.push("getPendingHops");
        return [makeHopOp()];
      },
      // source row is still open; if the resume didn't claim it, the per-row
      // pass could mint a rival hop once the cooldown lapses.
      listActivePositions: async () => [makeRow({ id: "row-1" })],
      getFreshRates: async () => new Map([[4, makeRate(4, 0.06, 0.05)], [5, makeRate(5, 0.09, 0.05)]]),
      getRecentDecisions: async () => priorHopRows(5, 2),
    });
    const res = await runLoopAllocationTick(deps);
    // Exactly ONE hop — the resume — with the persisted (idempotent) key.
    expect(calls.hops).toHaveLength(1);
    expect(calls.hops[0].clientRequestId).toBe("creq-1");
    expect(calls.hops[0].targetVaultId).toBe(5);
    expect(calls.hops[0].borrowPositionId).toBe("row-1");
    expect(res.acted).toBe(1);
    expect(res.skipped).toBe(1); // per-row pass skipped the in-flight source
    expect(calls.claims).toHaveLength(0); // the per-row pass never claimed it
    expect(calls.decisions).toHaveLength(0); // skipped rows are not journaled
    // The resume (getPendingHops → executeHop) runs before the per-row pass.
    expect(calls.order.indexOf("getPendingHops")).toBeLessThan(calls.order.indexOf("executeHop"));
  });

  it("a resumable hop failure is NOT counted as failed; a terminal one is", async () => {
    const resumable = makeDeps({
      getPendingHops: async () => [makeHopOp()],
      listActivePositions: async () => [],
      executeHop: async () => ({ success: false, resumable: true }),
    });
    const r1 = await runLoopAllocationTick(resumable.deps);
    expect(r1.acted).toBe(0);
    expect(r1.failed).toBe(0); // still in flight — will be retried next pass

    const terminal = makeDeps({
      getPendingHops: async () => [makeHopOp()],
      listActivePositions: async () => [],
      executeHop: async () => ({ success: false, resumable: false, error: "hard fail" }),
    });
    const r2 = await runLoopAllocationTick(terminal.deps);
    expect(r2.acted).toBe(0);
    expect(r2.failed).toBe(1);
  });
});
