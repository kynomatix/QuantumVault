/**
 * SOL Loop Vault P3 — safety-tick reflex tests (T104).
 *
 * Covers the PURE input builder (fail-closed candidate filtering, keeper input
 * shapes, staleness-gated carry states) and the orchestrator's money-safety
 * ordering (atomic claim BEFORE key material, refuse-without-signer, journal +
 * notify outcomes, per-position failure isolation).
 */
import { describe, expect, it } from "vitest";
import type { BorrowPosition } from "@shared/schema";
import type { PerBotPositionHealth } from "../../server/vault/borrow-health";
import type { FreshLoopRate } from "../../server/vault/loop/loop-rate-oracle";
import { LOOP_DELEVERAGE_POLICY } from "../../server/vault/loop/loop-risk-policy";
import {
  buildLoopSafetyInputs,
  runLoopSafetyTick,
  type LoopHealthObservation,
  type LoopSafetySigner,
  type LoopSafetyTickDeps,
} from "../../server/vault/loop/loop-safety-tick";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<BorrowPosition> = {}): BorrowPosition {
  return {
    id: overrides.id ?? "row-1",
    walletAddress: "WALLET_A",
    kind: "loop",
    status: "open",
    venueVaultId: "4",
    policyState: "levered",
    ...overrides,
  } as unknown as BorrowPosition;
}

function makeHealth(overrides: Partial<PerBotPositionHealth> = {}): PerBotPositionHealth {
  return {
    status: "available",
    healthFactor: 1.9,
    liveDebtRaw: "1000000000",
    band: "healthy",
    ...overrides,
  } as unknown as PerBotPositionHealth;
}

function obs(row: Partial<BorrowPosition>, health: Partial<PerBotPositionHealth>): LoopHealthObservation {
  return { row: makeRow(row), health: makeHealth(health) };
}

function makeRate(vaultId: number, netCarry2x: number | null): FreshLoopRate {
  return {
    vaultId,
    symbol: "JupSOL",
    stakingApy: 0.07,
    stakingApyMean30d: 0.07,
    borrowApr: 0.05,
    netCarry2x,
    asOf: new Date(),
  } as unknown as FreshLoopRate;
}

interface Calls {
  claims: Array<{ id: string; cooldownMs: number }>;
  signerRequests: string[];
  reduces: Array<Record<string, unknown>>;
  unwinds: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  cleanups: number;
  order: string[];
}

function makeDeps(overrides: Partial<LoopSafetyTickDeps> = {}): { deps: LoopSafetyTickDeps; calls: Calls } {
  const calls: Calls = {
    claims: [],
    signerRequests: [],
    reduces: [],
    unwinds: [],
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
  const deps: LoopSafetyTickDeps = {
    resolveSigner: async (wallet) => {
      calls.signerRequests.push(wallet);
      calls.order.push("resolveSigner");
      return signer;
    },
    getFreshRates: async () => new Map(),
    claimPolicyAction: async (id, cooldownMs) => {
      calls.claims.push({ id, cooldownMs });
      calls.order.push("claim");
      return makeRow({ id });
    },
    executeReduce: async (params) => {
      calls.reduces.push(params as unknown as Record<string, unknown>);
      calls.order.push("executeReduce");
      return { success: true, signature: "SIG_REDUCE" };
    },
    executeUnwindToHold: async (params) => {
      calls.unwinds.push(params as unknown as Record<string, unknown>);
      calls.order.push("executeUnwind");
      return { success: true, signature: "SIG_UNWIND" };
    },
    persistDecision: async (d) => {
      calls.decisions.push(d as unknown as Record<string, unknown>);
      calls.order.push("persist");
    },
    notify: async (_wallet, n) => {
      calls.notifications.push(n as unknown as Record<string, unknown>);
      calls.order.push("notify");
      return "sent";
    },
    now: () => new Date("2026-07-03T00:00:00Z"),
    ...overrides,
  };
  return { deps, calls };
}

// ─── buildLoopSafetyInputs (pure) ────────────────────────────────────────────

describe("buildLoopSafetyInputs", () => {
  it("builds a keeper position for a levered loop row with readable health", () => {
    const { candidates, positions, skipped } = buildLoopSafetyInputs(
      [obs({ id: "r1" }, { healthFactor: 1.42 })],
      new Map(),
    );
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].vaultId).toBe(4);
    expect(candidates[0].liveDebtRaw).toBe(1_000_000_000n);
    expect(positions).toEqual([
      { venue: "vault:4", positionId: "r1", healthFactor: 1.42, liquidationFloor: LOOP_DELEVERAGE_POLICY.liquidationFloor },
    ]);
  });

  it("silently excludes HOLD rows (zero live debt) — they must NEVER reach decideDeleverage", () => {
    const { candidates, positions, skipped } = buildLoopSafetyInputs(
      [obs({ policyState: "holding" }, { healthFactor: null, liveDebtRaw: "0" })],
      new Map(),
    );
    expect(candidates).toEqual([]);
    expect(positions).toEqual([]);
    expect(skipped).toEqual([]); // flat is a normal state, not an anomaly
  });

  it("treats a NULL policyState with live debt as levered (candidate)", () => {
    const { candidates } = buildLoopSafetyInputs(
      [obs({ policyState: null }, { healthFactor: 1.3 })],
      new Map(),
    );
    expect(candidates).toHaveLength(1);
  });

  it("excludes a stale 'levered' row whose debt already cleared on-chain", () => {
    const { candidates, skipped } = buildLoopSafetyInputs(
      [obs({ policyState: "levered" }, { liveDebtRaw: "0", healthFactor: null })],
      new Map(),
    );
    expect(candidates).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("FAILS CLOSED: skips unavailable health, unreadable debt, and non-finite HF with debt", () => {
    const { candidates, skipped } = buildLoopSafetyInputs(
      [
        obs({ id: "bad-health" }, { status: "unavailable", healthFactor: null, liveDebtRaw: null, reason: "rpc down" } as Partial<PerBotPositionHealth>),
        obs({ id: "bad-debt" }, { liveDebtRaw: "not-a-number" }),
        obs({ id: "bad-hf" }, { healthFactor: null, liveDebtRaw: "5000" }),
        obs({ id: "bad-vault", venueVaultId: null }, {}),
      ],
      new Map(),
    );
    expect(candidates).toEqual([]);
    expect(skipped.map((s) => s.rowId).sort()).toEqual(["bad-debt", "bad-health", "bad-hf", "bad-vault"]);
  });

  it("skips rows that are not open loop rows (defensive re-check)", () => {
    const { candidates, skipped } = buildLoopSafetyInputs(
      [
        obs({ id: "borrow-row", kind: "borrow" }, {}),
        obs({ id: "closed-row", status: "closed" }, {}),
      ],
      new Map(),
    );
    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it("builds a VenueState only from a fresh rate with a finite net carry", () => {
    const rates = new Map<number, FreshLoopRate>([
      [4, makeRate(4, 0.031)],
      [47, makeRate(47, null)],
    ]);
    const { states } = buildLoopSafetyInputs(
      [
        obs({ id: "r4", venueVaultId: "4" }, {}),
        obs({ id: "r47", venueVaultId: "47" }, {}),
      ],
      rates,
    );
    expect(states.size).toBe(1);
    expect(states.get("vault:4")).toMatchObject({ venue: "vault:4", netCarryApy: 0.031, paused: false });
    expect(states.has("vault:47")).toBe(false); // unreadable carry → carry rule skips
  });
});

// ─── runLoopSafetyTick (orchestrator) ────────────────────────────────────────

describe("runLoopSafetyTick", () => {
  it("does nothing for healthy positions: no claim, no signer, no execution", async () => {
    const { deps, calls } = makeDeps();
    const result = await runLoopSafetyTick([obs({}, { healthFactor: 1.9 })], deps);
    expect(result).toEqual({ evaluated: 1, acted: 0, failed: 0, skipped: 0 });
    expect(calls.claims).toEqual([]);
    expect(calls.signerRequests).toEqual([]);
    expect(calls.decisions).toEqual([]); // no 'none' journal flood from the 60s tick
  });

  it("REDUCE at HF ≤ 1.25: claims BEFORE keys, executes one reduceStep, journals + notifies", async () => {
    const { deps, calls } = makeDeps();
    const result = await runLoopSafetyTick([obs({ id: "r1" }, { healthFactor: 1.2 })], deps);

    expect(result.acted).toBe(1);
    expect(calls.claims).toEqual([{ id: "r1", cooldownMs: LOOP_DELEVERAGE_POLICY.cooldownMs }]);
    // Money-safety ordering: atomic claim FIRST, then key material, then execute.
    expect(calls.order.indexOf("claim")).toBeLessThan(calls.order.indexOf("resolveSigner"));
    expect(calls.order.indexOf("resolveSigner")).toBeLessThan(calls.order.indexOf("executeReduce"));
    expect(calls.reduces).toHaveLength(1);
    expect(calls.reduces[0]).toMatchObject({
      walletAddress: "WALLET_A",
      agentPublicKey: "AGENT_PUB",
      borrowPositionId: "r1",
      unwindBps: Math.round(LOOP_DELEVERAGE_POLICY.reduceStep * 10000),
    });
    expect(calls.cleanups).toBe(1);
    expect(calls.decisions).toHaveLength(1);
    expect(calls.decisions[0]).toMatchObject({
      tick: "safety",
      action: "reduce",
      borrowPositionId: "r1",
      vaultId: 4,
    });
    expect((calls.decisions[0].details as Record<string, unknown>).executed).toBe(true);
    expect((calls.decisions[0].details as Record<string, unknown>).signature).toBe("SIG_REDUCE");
    expect(calls.notifications[0]).toMatchObject({ action: "reduce", ok: true });
  });

  it("UNWIND TO HOLD at HF ≤ 1.10: threads the policy reason into the executor", async () => {
    const { deps, calls } = makeDeps();
    const result = await runLoopSafetyTick([obs({ id: "r2" }, { healthFactor: 1.05 })], deps);

    expect(result.acted).toBe(1);
    expect(calls.reduces).toEqual([]);
    expect(calls.unwinds).toHaveLength(1);
    const reason = calls.decisions[0].reason as string;
    expect(calls.unwinds[0]).toMatchObject({ borrowPositionId: "r2", policyReason: reason });
    expect(calls.decisions[0]).toMatchObject({ action: "unwind_to_hold", fraction: "1" });
    expect(calls.notifications[0]).toMatchObject({ action: "unwind_to_hold", ok: true });
  });

  it("carry reflex: reduces a HEALTHY loop when the fresh net carry is below the floor", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => new Map([[4, makeRate(4, 0.001)]]), // below carryReduceApy 0.005
    });
    const result = await runLoopSafetyTick([obs({ id: "r3" }, { healthFactor: 1.9 })], deps);
    expect(result.acted).toBe(1);
    expect(calls.reduces).toHaveLength(1);
  });

  it("stale/absent rates: the carry rule silently skips (no action on a healthy loop)", async () => {
    const { deps, calls } = makeDeps(); // getFreshRates returns empty map
    const result = await runLoopSafetyTick([obs({}, { healthFactor: 1.9 })], deps);
    expect(result.acted).toBe(0);
    expect(calls.claims).toEqual([]);
  });

  it("rate read FAILURE never blocks the health reflex (fail closed to no-carry-data)", async () => {
    const { deps, calls } = makeDeps({
      getFreshRates: async () => {
        throw new Error("rates table on fire");
      },
    });
    const result = await runLoopSafetyTick([obs({ id: "r4" }, { healthFactor: 1.05 })], deps);
    expect(result.acted).toBe(1);
    expect(calls.unwinds).toHaveLength(1);
  });

  it("cooldown claim lost → NOTHING else happens for that position", async () => {
    const { deps, calls } = makeDeps({ claimPolicyAction: async () => null });
    const result = await runLoopSafetyTick([obs({}, { healthFactor: 1.05 })], deps);
    expect(result.acted).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls.signerRequests).toEqual([]);
    expect(calls.unwinds).toEqual([]);
    expect(calls.decisions).toEqual([]);
    expect(calls.notifications).toEqual([]);
  });

  it("no execution authorization → refuse, journal executed:false, attention alert, NO execution", async () => {
    const { deps, calls } = makeDeps({ resolveSigner: async () => null });
    const result = await runLoopSafetyTick([obs({ id: "r5" }, { healthFactor: 1.05 })], deps);
    expect(result.failed).toBe(1);
    expect(calls.unwinds).toEqual([]);
    expect(calls.reduces).toEqual([]);
    expect(calls.decisions).toHaveLength(1);
    expect((calls.decisions[0].details as Record<string, unknown>).executed).toBe(false);
    expect(calls.notifications[0]).toMatchObject({ action: "unwind_to_hold", ok: false });
  });

  it("executor failure → failed counter, error journaled, attention alert, key still wiped", async () => {
    const { deps, calls } = makeDeps({
      executeUnwindToHold: async () => ({ success: false, error: "swap route unavailable" }),
    });
    const result = await runLoopSafetyTick([obs({ id: "r6" }, { healthFactor: 1.05 })], deps);
    expect(result.failed).toBe(1);
    expect(result.acted).toBe(0);
    expect(calls.cleanups).toBe(1);
    expect((calls.decisions[0].details as Record<string, unknown>).executed).toBe(false);
    expect((calls.decisions[0].details as Record<string, unknown>).error).toBe("swap route unavailable");
    expect(calls.notifications[0]).toMatchObject({ ok: false, detail: "swap route unavailable" });
  });

  it("executor THROW is contained: key wiped, error journaled, other positions still processed", async () => {
    let first = true;
    const { deps, calls } = makeDeps({
      executeUnwindToHold: async (params) => {
        if (first) {
          first = false;
          throw new Error("rpc exploded");
        }
        return { success: true, signature: `SIG_${params.borrowPositionId}` };
      },
    });
    const result = await runLoopSafetyTick(
      [
        obs({ id: "boom", walletAddress: "WALLET_A" }, { healthFactor: 1.02 }),
        obs({ id: "fine", walletAddress: "WALLET_A" }, { healthFactor: 1.03 }),
      ],
      deps,
    );
    expect(result.failed).toBe(1);
    expect(result.acted).toBe(1);
    expect(calls.cleanups).toBe(2);
    const byId = Object.fromEntries(calls.decisions.map((d) => [d.borrowPositionId as string, d]));
    expect((byId.boom.details as Record<string, unknown>).executed).toBe(false);
    expect((byId.boom.details as Record<string, unknown>).error).toContain("rpc exploded");
    expect((byId.fine.details as Record<string, unknown>).executed).toBe(true);
  });

  it("journal write failure never blocks the reflex or the notification", async () => {
    const { deps, calls } = makeDeps({
      persistDecision: async () => {
        throw new Error("db hiccup");
      },
    });
    const result = await runLoopSafetyTick([obs({}, { healthFactor: 1.05 })], deps);
    expect(result.acted).toBe(1);
    expect(calls.notifications).toHaveLength(1);
  });

  it("unreadable rows are counted skipped and never acted on", async () => {
    const { deps, calls } = makeDeps();
    const result = await runLoopSafetyTick(
      [obs({ id: "r7" }, { status: "unavailable", healthFactor: null, liveDebtRaw: null } as Partial<PerBotPositionHealth>)],
      deps,
    );
    expect(result).toEqual({ evaluated: 0, acted: 0, failed: 0, skipped: 1 });
    expect(calls.claims).toEqual([]);
  });

  it("returns immediately on an empty observation list without touching rates", async () => {
    let ratesTouched = false;
    const { deps } = makeDeps({
      getFreshRates: async () => {
        ratesTouched = true;
        return new Map();
      },
    });
    const result = await runLoopSafetyTick([], deps);
    expect(result).toEqual({ evaluated: 0, acted: 0, failed: 0, skipped: 0 });
    expect(ratesTouched).toBe(false);
  });
});
