// Boundary tests for the Phase A toolkit harness + current-lab adapter (T4).
//
// These verify the SEAM, not the lab: capability-bounding, wallet-scope
// enforcement, input/output contract validation, typed errors (never throws),
// the wired read methods over a fake storage, and that deferred methods return
// a typed `not_implemented`.

import { describe, it, expect } from "vitest";
import { LabAgentToolkit, type LabAgentAdapter } from "../../server/lab-agent/toolkit";
import { createCurrentLabAdapter, type AdapterStorage } from "../../server/lab-agent/current-lab-adapter";
import { DEFAULT_LAB_SLIPPAGE } from "../../server/lab/friction";
import { robustnessRank } from "../../server/lab/metrics";

const WALLET = "wallet-AAA";
const OTHER = "wallet-BBB";

// ---------------------------------------------------------------------------
// Fake storage — only the AdapterStorage subset, with controllable data.
// ---------------------------------------------------------------------------

function makeFakeStorage() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const fake = {
    lastGetStrategiesArg: undefined as string | undefined,
    activeRun: false,
    jobsAhead: 0,

    // T5 control surface state.
    nextRunId: 1000,
    queueSeq: 0,
    lastCreated: undefined as any,
    lastCreatedStrategy: undefined as any,
    nextCreateError: null as { code: string } | null,

    strategies: [
      { id: 1, userId: WALLET, name: "FLUX MOMENTUM", description: "trend rider", createdAt: now },
      { id: 2, userId: WALLET, name: "RSI Reversal", description: null, createdAt: now },
      { id: 3, userId: OTHER, name: "Hidden Whale", description: null, createdAt: now },
    ] as any[],

    runs: [
      { id: 10, userId: WALLET, strategyId: 1, status: "complete", queueOrder: null, oosFraction: 0.2, totalConfigsTested: 500, checkpoint: { currentStage: "deep" }, createdAt: now, completedAt: now },
      { id: 11, userId: WALLET, strategyId: 1, status: "queued", queueOrder: 5, oosFraction: null, totalConfigsTested: null, checkpoint: null, createdAt: now, completedAt: null },
      { id: 12, userId: OTHER, strategyId: 3, status: "running", queueOrder: null, oosFraction: 0.1, totalConfigsTested: 10, checkpoint: null, createdAt: now, completedAt: null },
    ] as any[],

    topResults: {
      1: [
        {
          id: 100, runId: 10, rank: 1, ticker: "SOL", timeframe: "2h",
          netProfitPercent: 50, winRatePercent: 60, maxDrawdownPercent: 10,
          profitFactor: 1.8, totalTrades: 40, sharpeRatio: 1.2,
          params: { length: 14 }, isMetrics: null,
          oosMetrics: { sufficient: true, netProfitPercent: 30, winRatePercent: 55, maxDrawdownPercent: 12, sharpeRatio: 1.0, totalTrades: 12 },
        },
      ],
    } as Record<number, any[]>,

    reports: {
      1: { id: 1, strategyId: 1, reportData: { summary: "Solid trend strategy.", directionalBias: "long", paramSensitivity: [{ param: "length", impact: 0.8 }] }, totalResults: 5, totalRuns: 1, createdAt: now },
    } as Record<number, any>,

    // Strategy-level ticker×timeframe grid (each cell aggregates that combo's runs).
    heatmapCells: {
      1: [
        { ticker: "SOL", timeframe: "2h", avgSharpe: 1.2 },
        { ticker: "ETH", timeframe: "4h", avgSharpe: 0.8 },
      ],
    } as Record<number, any[]>,

    async getStrategies(wallet?: string) {
      this.lastGetStrategiesArg = wallet;
      return this.strategies.filter((s) => !wallet || s.userId === wallet);
    },
    async getStrategy(id: number) {
      return this.strategies.find((s) => s.id === id);
    },
    async getRuns(strategyId?: number, userId?: string) {
      return this.runs
        .filter((r) => (strategyId == null || r.strategyId === strategyId) && (userId == null || r.userId === userId))
        .sort((a, b) => b.id - a.id); // emulate desc createdAt via id
    },
    async getRun(id: number) {
      return this.runs.find((r) => r.id === id);
    },
    async getTopResultsForStrategy(strategyId: number, limit = 10) {
      return (this.topResults[strategyId] ?? []).slice(0, limit);
    },
    async getHeatmapCells(_wallet: string, strategyId: number) {
      return { cells: this.heatmapCells[strategyId] ?? [] };
    },
    async createStrategy(data: any) {
      const row = { id: ++this.nextRunId, createdAt: now, ...data };
      this.lastCreatedStrategy = row;
      return row;
    },
    getJobByRunId(_runId: number) {
      return undefined; // no in-memory job in this (main-process-like) fake
    },
    async getLatestInsightsReport(strategyId: number) {
      return this.reports[strategyId];
    },
    async getJobsAheadCount(_queueOrder: number) {
      return this.jobsAhead;
    },
    async hasActiveRun(_wallet?: string) {
      return this.activeRun;
    },
    async walletHasManualRunAhead(_wallet?: string) {
      return false;
    },

    // --- T5 control surface ---
    async getNextQueueOrder(_wallet?: string) {
      return ++this.queueSeq;
    },
    async getAgentRun(wallet: string, taskId: number, key: string) {
      return this.runs.find(
        (r) => r.userId === wallet && r.agentTaskId === taskId && r.agentIdempotencyKey === key,
      );
    },
    async getAgentRunsForTask(wallet: string, taskId: number) {
      return this.runs.filter((r) => r.userId === wallet && r.agentTaskId === taskId);
    },
    async createRun(data: any) {
      // Simulate a concurrent winner committing the SAME idempotency key, then the
      // UNIQUE index rejecting our insert. The adapter must reselect + return it.
      if (this.nextCreateError) {
        const code = this.nextCreateError.code;
        this.nextCreateError = null;
        const winner = { id: ++this.nextRunId, createdAt: now, completedAt: null, ...data };
        this.runs.push(winner);
        throw Object.assign(new Error("duplicate key value"), { code });
      }
      const row = { id: ++this.nextRunId, createdAt: now, completedAt: null, ...data };
      this.runs.push(row);
      this.lastCreated = row;
      return row;
    },
    async markAgentRunCancelled(id: number) {
      const run = this.runs.find((r) => r.id === id);
      if (!run || run.status !== "queued") return false;
      run.status = "failed";
      run.queueOrder = null;
      run.completedAt = now;
      run.checkpoint = { userCancelled: true };
      return true;
    },
  };
  return fake;
}

function makeToolkit() {
  const fake = makeFakeStorage();
  const toolkit = new LabAgentToolkit(createCurrentLabAdapter(fake as unknown as AdapterStorage));
  return { fake, toolkit };
}

const ctx = { walletAddress: WALLET };
// Control writes carry an owning agent task; this is the (wallet, taskId) scope.
const wctx = { walletAddress: WALLET, taskId: 1 };

/**
 * A toolkit over an ISOLATED fake seeded with control-tool fixtures (a strategy
 * WITH params, one WITHOUT, a refine source whose config snapshot must win, and
 * agent-owned runs in each cancel-relevant state). Kept separate from the read
 * fixtures so the read-test assertions (counts, latestRunId) stay untouched.
 */
function makeControlToolkit() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const fake = makeFakeStorage();
  fake.strategies.push({
    id: 4, userId: WALLET, name: "AGENT STRAT", description: null,
    parsedInputs: [{ name: "length", type: "int", defaultValue: 14 }],
    pineScript: "//@version=5\nstrategy('x')", strategySettings: {}, createdAt: now,
  });
  fake.strategies.push({
    id: 5, userId: WALLET, name: "NO PARAMS", description: null,
    parsedInputs: [], pineScript: "//", strategySettings: {}, createdAt: now,
  });
  // Refine source: config-snapshot OOS/slippage (0.33/0.0007) must WIN over the
  // run columns (0.15/0.0006) — the GOOD refine path re-threads the holdout.
  fake.runs.push({
    id: 30, userId: WALLET, strategyId: 4, status: "complete", queueOrder: null,
    oosFraction: 0.15, slippage: 0.0006, tickers: ["SOL"], timeframes: ["2h"],
    startDate: "2025-01-01", endDate: "2025-12-31",
    randomSamples: 800, topK: 15, refinementsPerSeed: 40, minTrades: 8, maxDrawdownCap: 80,
    configSnapshot: { type: "new", config: { outOfSampleFraction: 0.33, slippage: 0.0007, startDate: "2025-02-01", endDate: "2025-11-30" } },
    checkpoint: null, agentOwned: true, totalConfigsTested: 300, createdAt: now, completedAt: now,
  });
  // Agent-owned runs in each cancel-relevant state.
  fake.runs.push({ id: 40, userId: WALLET, strategyId: 4, status: "queued", queueOrder: 9, oosFraction: 0.2, agentOwned: true, checkpoint: null, totalConfigsTested: null, createdAt: now, completedAt: null });
  fake.runs.push({ id: 41, userId: WALLET, strategyId: 4, status: "complete", queueOrder: null, oosFraction: 0.2, agentOwned: true, checkpoint: null, totalConfigsTested: 100, createdAt: now, completedAt: now });
  fake.runs.push({ id: 42, userId: WALLET, strategyId: 4, status: "running", queueOrder: null, oosFraction: 0.2, agentOwned: true, checkpoint: null, totalConfigsTested: 5, createdAt: now, completedAt: null });
  // Refine source with NO holdout anywhere (run column null + snapshot carries none):
  // the refine path must REJECT this rather than silently drop out-of-sample.
  fake.runs.push({
    id: 31, userId: WALLET, strategyId: 4, status: "complete", queueOrder: null,
    oosFraction: null, slippage: 0.0006, tickers: ["SOL"], timeframes: ["2h"],
    startDate: "2025-01-01", endDate: "2025-12-31",
    configSnapshot: { type: "new", config: { slippage: 0.0006 } },
    checkpoint: null, agentOwned: true, totalConfigsTested: 100, createdAt: now, completedAt: now,
  });
  // Strategy 4 has a usable top result (sourced from run 30) so `improve` can
  // reach the key gate; the row's runId must resolve to an owned run.
  fake.topResults[4] = [
    { id: 400, runId: 30, rank: 1, ticker: "SOL", timeframe: "2h", netProfitPercent: 40, winRatePercent: 55, maxDrawdownPercent: 12, profitFactor: 1.6, totalTrades: 30, sharpeRatio: 1.0, params: { length: 14 }, isMetrics: null, oosMetrics: null },
  ];
  // Agent-owned replay run for improve idempotency (same wallet + taskId + key).
  fake.runs.push({
    id: 50, userId: WALLET, strategyId: 4, status: "queued", queueOrder: 12,
    oosFraction: 0.2, agentOwned: true, agentTaskId: 1,
    agentIdempotencyKey: "imp-replay", agentCorrelationId: "corr-imp",
    checkpoint: null, totalConfigsTested: null, createdAt: now, completedAt: null,
  });
  const toolkit = new LabAgentToolkit(createCurrentLabAdapter(fake as unknown as AdapterStorage));
  return { fake, toolkit };
}

/** A toolkit whose adapter has a BYO-key resolver wired (T002 plumbing). Lets us
 *  exercise the key gate WITHOUT calling the real LLM: a resolver returning null
 *  must surface ToolkitError("conflict", needs key). */
function makeToolkitWithResolver(resolveLlmKey: (wallet: string) => Promise<Buffer | null>) {
  const fake = makeFakeStorage();
  const toolkit = new LabAgentToolkit(
    createCurrentLabAdapter(fake as unknown as AdapterStorage, undefined, resolveLlmKey),
  );
  return { fake, toolkit };
}

// ---------------------------------------------------------------------------
// Capability-bounding + wallet binding
// ---------------------------------------------------------------------------

describe("harness: capability + wallet binding", () => {
  it("rejects an unknown method with forbidden", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "bogusMethod" as any, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("rejects a call with no wallet bound", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call({ walletAddress: "" }, "listStrategies", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("enforces the write capability gate", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(
      { walletAddress: WALLET, allow: { read: true, write: false } },
      "runOptimization",
      { strategyId: 1, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "k1" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("enforces the read capability gate", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(
      { walletAddress: WALLET, allow: { read: false } },
      "listStrategies",
      {},
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Input / output contract validation
// ---------------------------------------------------------------------------

describe("harness: contract validation", () => {
  it("rejects bad input with invalid_input", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getTopResults", { strategyId: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("converts an output-contract violation into a typed internal error (never leaks)", async () => {
    const badAdapter = {
      async listStrategies() {
        return [{ not: "a strategy" }];
      },
    } as unknown as LabAgentAdapter;
    const toolkit = new LabAgentToolkit(badAdapter);
    const res = await toolkit.call(ctx, "listStrategies", {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal");
      // The bad shape must not bleed through.
      expect(JSON.stringify(res.error)).not.toContain("not");
    }
  });
});

// ---------------------------------------------------------------------------
// Wired reads
// ---------------------------------------------------------------------------

describe("reads: listStrategies", () => {
  it("returns wallet-scoped, contract-valid strategies with hasResults + latestRunId", async () => {
    const { fake, toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "listStrategies", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fake.lastGetStrategiesArg).toBe(WALLET);
    expect(res.data).toHaveLength(2); // wallet's two; other wallet's hidden
    const flux = res.data.find((s) => s.id === 1)!;
    expect(flux.hasResults).toBe(true);
    expect(flux.latestRunId).toBe(11); // newest run for strategy 1
    const rsi = res.data.find((s) => s.id === 2)!;
    expect(rsi.hasResults).toBe(false);
    expect(rsi.latestRunId).toBeNull();
  });
});

describe("reads: findStrategy", () => {
  it("fuzzy-matches the wallet's strategies and excludes other wallets", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "findStrategy", { query: "flux" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0].id).toBe(1);
    expect(res.data[0].score).toBeGreaterThan(0.8);
    expect(res.data.find((m) => m.id === 3)).toBeUndefined();
  });

  it("returns an empty list for no match (still contract-valid)", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "findStrategy", { query: "zzzznomatch" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual([]);
  });
});

describe("reads: getTopResults", () => {
  it("returns robustness ranking with per-run OOS resolved", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getTopResults", { strategyId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rankedBy).toBe("robustness");
    expect(res.data.runId).toBeNull(); // spans runs
    expect(res.data.results).toHaveLength(1);
    const r = res.data.results[0];
    expect(r.runId).toBe(10);
    expect(r.oos).not.toBeNull(); // run 10 carried a 0.2 holdout
    expect(r.oos!.fraction).toBe(0.2);
  });

  it("hides another wallet's strategy as not_found", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getTopResults", { strategyId: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("reads: getInsightsReport", () => {
  it("returns the latest report mapped to the DTO", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getInsightsReport", { strategyId: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.summary).toBe("Solid trend strategy.");
  });

  it("returns not_found when no report exists", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getInsightsReport", { strategyId: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("hides another wallet's strategy as not_found", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getInsightsReport", { strategyId: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("reads: getRunStatus", () => {
  it("maps a queued run with jobsAhead", async () => {
    const { fake, toolkit } = makeToolkit();
    fake.jobsAhead = 3;
    const res = await toolkit.call(ctx, "getRunStatus", { runId: 11 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("queued");
    expect(res.data.jobsAhead).toBe(3);
    expect(res.data.progressPct).toBeNull(); // no live job in main process
  });

  it("maps a completed run", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getRunStatus", { runId: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("completed");
    expect(res.data.jobsAhead).toBeNull();
    expect(res.data.completedAt).not.toBeNull();
  });

  it("hides another wallet's run as not_found", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getRunStatus", { runId: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("returns not_found for a missing run", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getRunStatus", { runId: 999 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("reads: getQueuePosition", () => {
  it("reports jobsAhead and the wallet's active-run flag", async () => {
    const { fake, toolkit } = makeToolkit();
    fake.jobsAhead = 2;
    fake.activeRun = true;
    const res = await toolkit.call(ctx, "getQueuePosition", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.jobsAhead).toBe(2);
    expect(res.data.hasActiveRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deferred methods → typed not_implemented (after passing input validation)
// ---------------------------------------------------------------------------

describe("deferred methods return not_implemented", () => {
  // Still genuinely deferred (no implementation yet). createStrategyFromText and
  // improve moved OUT of this batch — they are wired now and gate on a BYO key
  // (covered in "BYO-key LLM tools" below), not a blanket not_implemented.
  const cases: Array<[string, unknown]> = [
    ["listTemplates", {}],
    ["createStrategyFromTemplate", { templateId: "t1", idempotencyKey: "k" }],
  ];

  for (const [method, input] of cases) {
    it(`${method} → not_implemented`, async () => {
      const { toolkit } = makeToolkit();
      const res = await toolkit.call(ctx, method as any, input);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("not_implemented");
    });
  }
});

// ---------------------------------------------------------------------------
// T5: idempotent control tools — runOptimization / refineFrom / cancelRun
// ---------------------------------------------------------------------------

describe("control: runOptimization", () => {
  it("queues a new agent run with a correlationId (idempotent:false)", async () => {
    const { fake, toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "runOptimization", {
      strategyId: 4, symbols: ["SOL", "ETH"], timeframes: ["2h"], idempotencyKey: "opt-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("queued");
    expect(res.data.idempotent).toBe(false);
    expect(res.data.correlationId.length).toBeGreaterThan(0);
    expect(res.data.runId).toBeGreaterThan(0);
    // Persisted as an agent-owned queued run carrying the (task, key) tuple + OOS default.
    expect(fake.lastCreated.agentOwned).toBe(true);
    expect(fake.lastCreated.status).toBe("queued");
    expect(fake.lastCreated.queueOrder).not.toBeNull();
    expect(fake.lastCreated.agentTaskId).toBe(1);
    expect(fake.lastCreated.agentIdempotencyKey).toBe("opt-1");
    expect(fake.lastCreated.oosFraction).toBe(0.2);
    expect(fake.lastCreated.configSnapshot.config.outOfSampleFraction).toBe(0.2);
    expect(fake.lastCreated.configSnapshot.config.slippage).toBe(DEFAULT_LAB_SLIPPAGE);
  });

  it("is idempotent on a reused key (same run, idempotent:true)", async () => {
    const { toolkit } = makeControlToolkit();
    const input = { strategyId: 4, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "opt-2" };
    const first = await toolkit.call(wctx, "runOptimization", input);
    const second = await toolkit.call(wctx, "runOptimization", input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.idempotent).toBe(false);
    expect(second.data.idempotent).toBe(true);
    expect(second.data.runId).toBe(first.data.runId);
  });

  it("requires an owning task (forbidden without taskId)", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "runOptimization", {
      strategyId: 4, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "opt-3",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("rejects a stage list that omits 'random'", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "runOptimization", {
      strategyId: 4, symbols: ["SOL"], timeframes: ["2h"], stages: ["refine"], idempotencyKey: "opt-4",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("rejects a sub-hour timeframe", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "runOptimization", {
      strategyId: 4, symbols: ["SOL"], timeframes: ["15m"], idempotencyKey: "opt-5",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("hides another wallet's strategy as not_found", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "runOptimization", {
      strategyId: 3, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "opt-6",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("rejects a strategy that has no parameters to optimize", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "runOptimization", {
      strategyId: 5, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "opt-7",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("survives a UNIQUE-violation race (returns the committed winner, idempotent:true)", async () => {
    const { fake, toolkit } = makeControlToolkit();
    fake.nextCreateError = { code: "23505" };
    const res = await toolkit.call(wctx, "runOptimization", {
      strategyId: 4, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "race-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.idempotent).toBe(true);
    const winner = fake.runs.find((r) => r.agentIdempotencyKey === "race-1");
    expect(winner).toBeDefined();
    expect(res.data.runId).toBe(winner!.id);
  });
});

describe("control: refineFrom", () => {
  it("inherits OOS + slippage from the source run's config snapshot", async () => {
    const { fake, toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "refineFrom", { runId: 30, idempotencyKey: "ref-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("queued");
    // Config snapshot WINS over the run columns (0.33/0.0007, not 0.15/0.0006).
    expect(fake.lastCreated.oosFraction).toBe(0.33);
    expect(fake.lastCreated.slippage).toBe(0.0007);
    expect(fake.lastCreated.configSnapshot.sourceRunId).toBe(30);
    expect(fake.lastCreated.configSnapshot.config.deepSearch).toBe(true);
    expect(fake.lastCreated.configSnapshot.config.coordinateTune).toBe(true);
    expect(fake.lastCreated.configSnapshot.config.useInsights).toBe(true);
  });

  it("requires an owning task (forbidden without taskId)", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "refineFrom", { runId: 30, idempotencyKey: "ref-2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("hides another wallet's run as not_found", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "refineFrom", { runId: 12, idempotencyKey: "ref-3" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("is idempotent on a reused key (same run, idempotent:true)", async () => {
    const { toolkit } = makeControlToolkit();
    const input = { runId: 30, idempotencyKey: "ref-4" };
    const first = await toolkit.call(wctx, "refineFrom", input);
    const second = await toolkit.call(wctx, "refineFrom", input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.idempotent).toBe(true);
    expect(second.data.runId).toBe(first.data.runId);
  });
});

describe("control: cancelRun", () => {
  it("cancels a queued agent run", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "cancelRun", { runId: 40 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.status).toBe("cancelled");
  });

  it("is an idempotent no-op on an already-terminal run", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "cancelRun", { runId: 41 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.status).toBe("completed");
  });

  it("returns conflict for a still-running run", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "cancelRun", { runId: 42 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });

  it("refuses a non-agent-owned run with forbidden", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "cancelRun", { runId: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("hides another wallet's run as not_found", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "cancelRun", { runId: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// T003 NEW COVERAGE — heatmap, robustness rerank, sync insights, holdout
// rejection, and the BYO-key LLM tools (create / improve) gating.
// ---------------------------------------------------------------------------

describe("reads: getHeatmap (strategy-level ticker×timeframe grid)", () => {
  it("maps cells to {x:ticker, y:timeframe, metric:avgSharpe} with named axes", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getHeatmap", { strategyId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.strategyId).toBe(1);
    expect(res.data.xParam).toBe("ticker");
    expect(res.data.yParam).toBe("timeframe");
    expect(res.data.metricName).toBe("avgSharpe");
    expect(res.data.cells).toHaveLength(2);
    expect(res.data.cells[0]).toEqual({ x: "SOL", y: "2h", metric: 1.2 });
    expect(res.data.cells[1]).toEqual({ x: "ETH", y: "4h", metric: 0.8 });
  });

  it("hides another wallet's strategy as not_found", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getHeatmap", { strategyId: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("reads: getTopResults re-ranks by ROBUSTNESS, not the headline number", () => {
  // Same structural map the adapter applies before robustnessRank.
  const rrank = (row: any) =>
    robustnessRank({
      netProfitPercent: row.netProfitPercent,
      winRatePercent: row.winRatePercent,
      maxDrawdownPercent: row.maxDrawdownPercent,
      profitFactor: row.profitFactor,
      totalTrades: row.totalTrades,
      sharpeRatio: row.sharpeRatio ?? undefined,
      is: row.isMetrics ?? undefined,
      oos: row.oosMetrics ?? undefined,
    });

  it("demotes a high-net but high-risk config below a risk-adjusted one", async () => {
    const { fake, toolkit } = makeToolkit();
    const now = new Date("2026-01-01T00:00:00.000Z");
    fake.strategies.push({ id: 6, userId: WALLET, name: "RERANK", description: null, createdAt: now });
    // DB order (by the lab's profit rank): SOL, ETH, BTC. SOL has the biggest
    // headline net (80%) but the worst risk; ETH the best risk-adjusted profile.
    const rows = [
      { id: 601, runId: 60, rank: 1, ticker: "SOL", timeframe: "2h", netProfitPercent: 80, winRatePercent: 50, maxDrawdownPercent: 40, profitFactor: 1.2, totalTrades: 60, sharpeRatio: 0.5, params: {}, isMetrics: null, oosMetrics: null },
      { id: 602, runId: 60, rank: 2, ticker: "ETH", timeframe: "2h", netProfitPercent: 30, winRatePercent: 65, maxDrawdownPercent: 8, profitFactor: 2.5, totalTrades: 45, sharpeRatio: 1.8, params: {}, isMetrics: null, oosMetrics: null },
      { id: 603, runId: 60, rank: 3, ticker: "BTC", timeframe: "2h", netProfitPercent: 55, winRatePercent: 58, maxDrawdownPercent: 20, profitFactor: 1.8, totalTrades: 50, sharpeRatio: 1.1, params: {}, isMetrics: null, oosMetrics: null },
    ];
    fake.topResults[6] = rows;
    const expectedOrder = [...rows].sort((a, b) => rrank(b) - rrank(a)).map((r) => r.ticker);

    const res = await toolkit.call(ctx, "getTopResults", { strategyId: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rankedBy).toBe("robustness");
    expect(res.data.runId).toBeNull();
    expect(res.data.results.map((r) => r.ticker)).toEqual(expectedOrder);
    // Renumbered to the robustness order (1 = most robust), not the DB rank.
    expect(res.data.results.map((r) => r.rank)).toEqual([1, 2, 3]);
    // The headline net-profit winner (SOL) is NOT first — it's demoted to last.
    expect(res.data.results[0].ticker).not.toBe("SOL");
    expect(res.data.results[res.data.results.length - 1].ticker).toBe("SOL");
  });
});

describe("generateInsights (deterministic, no LLM, no persist)", () => {
  it("summarizes the most robust config from existing results", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "generateInsights", { strategyId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.strategyId).toBe(1);
    expect(typeof res.data.summary).toBe("string");
    expect(res.data.summary.length).toBeGreaterThan(0);
    expect(res.data.directionalBias).toBeNull();
    expect(typeof res.data.generatedAt).toBe("string");
  });

  it("returns conflict when the strategy has no results yet", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "generateInsights", { strategyId: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });

  it("hides another wallet's strategy as not_found", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "generateInsights", { strategyId: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("control: refineFrom enforces the holdout forward", () => {
  it("rejects a source run that carries NO out-of-sample holdout (conflict)", async () => {
    const { toolkit } = makeControlToolkit();
    // Run 31: oosFraction null AND its config snapshot carries no fraction →
    // refining it would silently drop the holdout, so the tool must refuse.
    const res = await toolkit.call(wctx, "refineFrom", { runId: 31, idempotencyKey: "ref-noos" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });
});

describe("BYO-key LLM tools: createStrategyFromText", () => {
  it("is dormant without a key resolver (not_implemented)", async () => {
    const { toolkit } = makeToolkit(); // no resolver wired
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "make a thing", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_implemented");
  });

  it("does NOT require a model-supplied idempotencyKey (the real orchestrator sync path omits it)", async () => {
    // The brain is told never to author an idempotencyKey, and executeSyncTool does
    // NOT inject one (only the async run-queuing path does). So the contract must
    // accept create args WITHOUT a key — it should reach the key gate, not bounce
    // with invalid_input at validation.
    const { toolkit } = makeToolkit(); // no resolver → key gate yields not_implemented
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "make a thing" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_implemented"); // NOT "invalid_input"
  });

  it("asks for a key when the resolver yields none (conflict)", async () => {
    const { toolkit } = makeToolkitWithResolver(async () => null);
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "make a thing", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });
});

describe("BYO-key LLM tools: improve (gating before any LLM call)", () => {
  it("requires an owning task (forbidden without taskId)", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(ctx, "improve", { strategyId: 4, insightsOrWeaknesses: "few trades", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("hides another wallet's strategy as not_found", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "improve", { strategyId: 3, insightsOrWeaknesses: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("refuses to improve a strategy with no results (conflict)", async () => {
    const { toolkit } = makeControlToolkit();
    // Strategy 5 has no top results → nothing to diagnose or mirror against.
    const res = await toolkit.call(wctx, "improve", { strategyId: 5, insightsOrWeaknesses: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });

  it("reaches the key gate once results exist — dormant without a resolver (not_implemented)", async () => {
    const { toolkit } = makeControlToolkit(); // has results for strategy 4, no resolver
    const res = await toolkit.call(wctx, "improve", { strategyId: 4, insightsOrWeaknesses: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_implemented");
  });

  it("asks for a key when the resolver yields none (conflict)", async () => {
    // Strategy 1 (from the read fixtures) has a top result sourced from run 10.
    const { toolkit } = makeToolkitWithResolver(async () => null);
    const res = await toolkit.call(wctx, "improve", { strategyId: 1, insightsOrWeaknesses: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });

  it("replays a prior agent-owned run on a reused key (idempotent, no LLM call)", async () => {
    const { toolkit } = makeControlToolkit();
    const res = await toolkit.call(wctx, "improve", { strategyId: 4, insightsOrWeaknesses: "x", idempotencyKey: "imp-replay" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.idempotent).toBe(true);
    expect(res.data.runId).toBe(50);
    expect(res.data.status).toBe("queued");
  });
});
