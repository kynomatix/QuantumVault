// Boundary tests for the Phase A toolkit harness + current-lab adapter (T4).
//
// These verify the SEAM, not the lab: capability-bounding, wallet-scope
// enforcement, input/output contract validation, typed errors (never throws),
// the wired read methods over a fake storage, and that deferred methods return
// a typed `not_implemented`.

import { describe, it, expect } from "vitest";
import { LabAgentToolkit, type LabAgentAdapter } from "../../server/lab-agent/toolkit";
import { createCurrentLabAdapter, type AdapterStorage } from "../../server/lab-agent/current-lab-adapter";

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
  };
  return fake;
}

function makeToolkit() {
  const fake = makeFakeStorage();
  const toolkit = new LabAgentToolkit(createCurrentLabAdapter(fake as unknown as AdapterStorage));
  return { fake, toolkit };
}

const ctx = { walletAddress: WALLET };

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
  it("returns honest lab_objective ranking with per-run OOS resolved", async () => {
    const { toolkit } = makeToolkit();
    const res = await toolkit.call(ctx, "getTopResults", { strategyId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rankedBy).toBe("lab_objective");
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
  const cases: Array<[string, unknown]> = [
    ["listTemplates", {}],
    ["getHeatmap", { runId: 10 }],
    ["runOptimization", { strategyId: 1, symbols: ["SOL"], timeframes: ["2h"], idempotencyKey: "k" }],
    ["refineFrom", { runId: 10, idempotencyKey: "k" }],
    ["generateInsights", { strategyId: 1, idempotencyKey: "k" }],
    ["createStrategyFromText", { prompt: "make a thing", idempotencyKey: "k" }],
    ["createStrategyFromTemplate", { templateId: "t1", idempotencyKey: "k" }],
    ["improve", { strategyId: 1, insightsOrWeaknesses: "too few trades", idempotencyKey: "k" }],
    ["cancelRun", { runId: 10 }],
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
