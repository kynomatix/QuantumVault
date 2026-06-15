// BYO-key LLM tool tests for the current-lab adapter (T003): createStrategyFromText
// + improve. These mock the AI creator (no real network/model) and the Pine parser
// so we exercise the adapter's OWN logic — key resolution + zeroize, compile-fail
// gating, LlmGatewayError → ToolkitError mapping, and the improve enqueue — without
// touching the LLM or the Pine engine. The complementary file (toolkit.test.ts)
// covers the no-key dormancy + pre-LLM gating.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the creator (draftStrategy / improveStrategy). Hoisted so the vi.mock factory
// can reference the spies (vi.mock is lifted above imports).
const { draftStrategy, improveStrategy } = vi.hoisted(() => ({
  draftStrategy: vi.fn(),
  improveStrategy: vi.fn(),
}));
vi.mock("../../server/ai-assistant/creator", () => ({ draftStrategy, improveStrategy }));

// Mock the Pine parser — return a stable, valid parse (one input) so the adapter
// proceeds past its "no parameters" guard. The real parser is exercised elsewhere.
vi.mock("../../server/lab/pine-parser", () => ({
  parsePineScript: () => ({
    strategyName: "Parsed Name",
    inputs: [{ name: "length", type: "int", defaultValue: 14 }],
    groups: null,
    strategySettings: null,
  }),
}));

import { LabAgentToolkit } from "../../server/lab-agent/toolkit";
import { createCurrentLabAdapter, type AdapterStorage } from "../../server/lab-agent/current-lab-adapter";
import { LlmGatewayError } from "../../server/ai-assistant/router";

const WALLET = "wallet-AAA";
const ctx = { walletAddress: WALLET };
const wctx = { walletAddress: WALLET, taskId: 1 };

// A minimal storage covering only what the two LLM tools touch. Strategy 7 has a
// top result sourced from run 70 (a complete run with a market scope to mirror).
function makeFake() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  let nextId = 1000;
  return {
    created: [] as any[],
    lastCreatedRun: undefined as any,
    strategies: [
      { id: 7, userId: WALLET, name: "BASE", description: null, pineScript: "//strat", parsedInputs: [{ name: "length" }], groups: null, strategySettings: {}, createdAt: now },
    ] as any[],
    runs: [
      {
        id: 70, userId: WALLET, strategyId: 7, status: "complete", queueOrder: null,
        oosFraction: 0.2, slippage: 0.0006, tickers: ["SOL"], timeframes: ["2h"],
        startDate: "2025-01-01", endDate: "2025-12-31",
        randomSamples: 800, topK: 15, refinementsPerSeed: 40, minTrades: 8, maxDrawdownCap: 80,
        configSnapshot: null, checkpoint: null, createdAt: now, completedAt: now,
      },
    ] as any[],
    topResults: {
      7: [{ id: 700, runId: 70, rank: 1, ticker: "SOL", timeframe: "2h", netProfitPercent: 40, winRatePercent: 55, maxDrawdownPercent: 12, profitFactor: 1.6, totalTrades: 30, sharpeRatio: 1.0, params: {}, isMetrics: null, oosMetrics: null }],
    } as Record<number, any[]>,
    async getStrategy(id: number) {
      return this.strategies.find((s) => s.id === id);
    },
    async getTopResultsForStrategy(id: number, limit = 10) {
      return (this.topResults[id] ?? []).slice(0, limit);
    },
    async getRun(id: number) {
      return this.runs.find((r) => r.id === id);
    },
    async getAgentRun() {
      return undefined; // no prior run → never a replay in these tests
    },
    async getAgentRunsForTask() {
      return []; // no in-flight runs → the max-queued guard never trips here
    },
    async getNextQueueOrder() {
      return 1;
    },
    async getJobsAheadCount() {
      return 0;
    },
    async createStrategy(data: any) {
      const row = { id: ++nextId, createdAt: now, ...data };
      this.created.push(row);
      return row;
    },
    async createRun(data: any) {
      const row = { id: ++nextId, createdAt: now, completedAt: null, ...data };
      this.lastCreatedRun = row;
      this.runs.push(row);
      return row;
    },
  };
}

function makeToolkit(resolveLlmKey: (wallet: string) => Promise<Buffer | null>) {
  const fake = makeFake();
  const toolkit = new LabAgentToolkit(
    createCurrentLabAdapter(fake as unknown as AdapterStorage, undefined, resolveLlmKey),
  );
  return { fake, toolkit };
}

const keyResolver = async () => Buffer.from("sk-or-test-key");

beforeEach(() => {
  draftStrategy.mockReset();
  improveStrategy.mockReset();
});

describe("createStrategyFromText (BYO key)", () => {
  it("drafts → parses → persists, returning the new strategy id + name", async () => {
    draftStrategy.mockResolvedValue({ pineScript: "//x", compileOk: true });
    const { fake, toolkit } = makeToolkit(keyResolver);
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "an EMA crossover", idempotencyKey: "k" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.strategyId).toBeGreaterThan(0);
    expect(res.data.name).toBe("Parsed Name");
    // The decrypted key is passed through as a utf8 string, scoped to the wallet.
    expect(draftStrategy).toHaveBeenCalledWith(expect.objectContaining({ idea: "an EMA crossover", apiKey: "sk-or-test-key", walletAddress: WALLET }));
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].userId).toBe(WALLET);
  });

  it("fails loud (internal, retryable) when the draft doesn't compile", async () => {
    draftStrategy.mockResolvedValue({ pineScript: "//broken", compileOk: false });
    const { fake, toolkit } = makeToolkit(keyResolver);
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("internal");
    expect(res.error.retryable).toBe(true);
    expect(fake.created).toHaveLength(0); // never persists an un-runnable strategy
  });

  // LlmGatewayError.status → ToolkitError.code mapping (the gateway's only contract
  // with the agent). retryable only on rate limits.
  const mappings: Array<[number, string, boolean]> = [
    [429, "rate_limited", true],
    [400, "invalid_input", false],
    [401, "conflict", false],
    [403, "conflict", false],
    [500, "internal", false],
  ];
  for (const [status, code, retryable] of mappings) {
    it(`maps a gateway ${status} to ${code}`, async () => {
      draftStrategy.mockRejectedValue(new LlmGatewayError(`boom ${status}`, status));
      const { toolkit } = makeToolkit(keyResolver);
      const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "x", idempotencyKey: "k" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(code);
      expect(res.error.retryable).toBe(retryable);
    });
  }

  it("maps a non-gateway error to internal", async () => {
    draftStrategy.mockRejectedValue(new Error("socket hang up"));
    const { toolkit } = makeToolkit(keyResolver);
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("internal");
  });
});

describe("improve (BYO key)", () => {
  it("rewrites → persists a '(improved)' strategy → enqueues a fresh optimization", async () => {
    improveStrategy.mockResolvedValue({ pineScript: "//y", compileOk: true });
    const { fake, toolkit } = makeToolkit(keyResolver);
    const res = await toolkit.call(wctx, "improve", { strategyId: 7, insightsOrWeaknesses: "too few trades", idempotencyKey: "k" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("queued");
    expect(res.data.idempotent).toBe(false);
    expect(res.data.runId).toBeGreaterThan(0);
    // The improved strategy is a NEW row named off the base, owned by the wallet.
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].name).toBe("BASE (improved)");
    expect(fake.created[0].userId).toBe(WALLET);
    // The enqueued run mirrors the base run's market scope + holdout.
    expect(fake.lastCreatedRun.tickers).toEqual(["SOL"]);
    expect(fake.lastCreatedRun.timeframes).toEqual(["2h"]);
    expect(improveStrategy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-or-test-key", walletAddress: WALLET }));
  });

  it("fails loud (internal) when the improved draft doesn't compile", async () => {
    improveStrategy.mockResolvedValue({ pineScript: "//broken", compileOk: false });
    const { fake, toolkit } = makeToolkit(keyResolver);
    const res = await toolkit.call(wctx, "improve", { strategyId: 7, insightsOrWeaknesses: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("internal");
    expect(fake.created).toHaveLength(0); // no strategy + no run persisted
    expect(fake.lastCreatedRun).toBeUndefined();
  });

  it("gives the fresh run a default holdout when the base run had none (oos 0)", async () => {
    improveStrategy.mockResolvedValue({ pineScript: "//y", compileOk: true });
    const { fake, toolkit } = makeToolkit(keyResolver);
    fake.runs[0].oosFraction = 0; // base run was NOT validated out-of-sample
    const res = await toolkit.call(wctx, "improve", { strategyId: 7, insightsOrWeaknesses: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The improved run must NOT inherit the missing holdout — `??` would have kept 0.
    expect(fake.lastCreatedRun.oosFraction).toBeGreaterThan(0);
  });
});

describe("BYO key: the decrypted key buffer is zeroized after use", () => {
  it("wipes the resolver-supplied buffer once createStrategyFromText returns", async () => {
    draftStrategy.mockResolvedValue({ pineScript: "//x", compileOk: true });
    const keyBuf = Buffer.from("sk-or-secret-xyz");
    const fake = makeFake();
    const toolkit = new LabAgentToolkit(
      createCurrentLabAdapter(fake as unknown as AdapterStorage, undefined, async () => keyBuf),
    );
    const res = await toolkit.call(ctx, "createStrategyFromText", { prompt: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(true);
    // withLlmKey wipes the plaintext key in a `finally` so it can't linger in memory.
    expect(keyBuf.every((b) => b === 0)).toBe(true);
  });
});
