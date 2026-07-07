// Phase C turn orchestrator acceptance tests (T3).
//
// These exercise the turn engine over in-memory fakes (no DB, no network): a
// faithful CAS-lease store, a scriptable toolkit, and a scripted brain. They lock
// in the architect-confirmed invariants — single-flight, two-phase crash-safe
// async steps, idempotency-key stability across resume (no re-exec/double-enqueue),
// global iteration + spend halts, malformed/tool-error repair budgets, and the
// reconcile-then-stop-on-terminal gate.

import { describe, it, expect } from "vitest";
import {
  LabTurnOrchestrator,
  type OrchestratorDeps,
  type OrchestratorStorage,
} from "../../server/lab-agent/orchestrator";
import {
  MalformedDecisionError,
  defaultAutoMemory,
  type BrainDecision,
  type BrainFn,
  type AutoMemory,
  type PaidTool,
} from "../../server/lab-agent/chat-brain";
import { createAutoPlanner } from "../../server/lab-agent/auto-planner";
import type { LabAgentTask, LabAgentMessage } from "@shared/schema";
import type { LabAgentToolkit } from "../../server/lab-agent/toolkit";

const WALLET = "wallet-orch";

// --- fakes -----------------------------------------------------------------------

function baseTask(over: Partial<LabAgentTask> = {}): LabAgentTask {
  return {
    id: 1,
    walletAddress: WALLET,
    status: "active",
    mode: "chat",
    goal: null,
    plan: null,
    memory: null,
    activeRunId: null,
    ownedRunIds: [],
    loopCount: 0,
    spendEstimateUsd: 0,
    stopReason: null,
    lastReconciledAt: null,
    awaitingSince: null,
    cancelRequestedAt: null,
    toolkitVersion: 1,
    turnState: "ready",
    turnLease: null,
    turnLeaseExpiresAt: null,
    turnStateChangedAt: null,
    stepIndex: 0,
    currentStep: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  } as LabAgentTask;
}

function makeStore(seed: Partial<LabAgentTask> = {}) {
  const tasks = new Map<number, LabAgentTask>();
  tasks.set(1, baseTask(seed));
  const messages: LabAgentMessage[] = [];
  let msgSeq = 0;

  const store = {
    tasks,
    messages,
    async claimTurnLease(taskId: number, token: string, leaseMs: number, now: Date = new Date()) {
      const t = tasks.get(taskId);
      if (!t) return undefined;
      const free =
        !t.turnLease ||
        !t.turnLeaseExpiresAt ||
        (t.turnLeaseExpiresAt as Date).getTime() < now.getTime();
      if (!free) return undefined;
      t.turnLease = token;
      t.turnLeaseExpiresAt = new Date(now.getTime() + leaseMs);
      return { ...t };
    },
    async releaseTurnLease(taskId: number, token: string) {
      const t = tasks.get(taskId);
      if (t && t.turnLease === token) {
        t.turnLease = null;
        t.turnLeaseExpiresAt = null;
      }
    },
    async getAgentTask(id: number) {
      const t = tasks.get(id);
      return t ? { ...t } : undefined;
    },
    async updateAgentTask(id: number, patch: Partial<LabAgentTask>) {
      const t = tasks.get(id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return { ...t };
    },
    async incrementAgentTaskSpend(_wallet: string, taskId: number, delta: number) {
      const t = tasks.get(taskId);
      if (t && Number.isFinite(delta) && delta > 0) t.spendEstimateUsd = (t.spendEstimateUsd ?? 0) + delta;
    },
    async createAgentMessageForWallet(
      _wallet: string,
      taskId: number,
      data: { role: "user" | "agent" | "tool"; content: string; suggestedActions?: any[] },
    ) {
      const m = {
        id: ++msgSeq,
        taskId,
        role: data.role,
        content: data.content,
        suggestedActions: data.suggestedActions ?? [],
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, msgSeq)),
      } as unknown as LabAgentMessage;
      messages.push(m);
      return m;
    },
    async listRecentAgentMessagesForWallet(_wallet: string, taskId: number, limit = 20) {
      return messages.filter((m) => m.taskId === taskId).slice(-limit).map((m) => ({ ...m }));
    },
    // test helpers
    agentMessages() {
      return messages.filter((m) => m.role === "agent");
    },
  };
  return store;
}

type ToolHandler = (args: any, callIndex: number) => { ok: true; data: any } | { ok: false; error: any };

function makeToolkit(handlers: Record<string, ToolHandler> = {}) {
  const calls: { method: string; args: any }[] = [];
  const toolkit = {
    calls,
    async call(_ctx: any, method: string, args: any) {
      const idx = calls.filter((c) => c.method === method).length;
      calls.push({ method, args });
      const h = handlers[method];
      if (h) return h(args, idx);
      return { ok: true, data: {} };
    },
    countOf(method: string) {
      return calls.filter((c) => c.method === method).length;
    },
  };
  return toolkit;
}

type BrainStep = BrainDecision | { throw: Error };

function makeBrain(steps: BrainStep[]) {
  const rec = { calls: 0 };
  const fn: BrainFn = async () => {
    const step = steps[Math.min(rec.calls, steps.length - 1)];
    rec.calls++;
    if ("throw" in step) throw step.throw;
    return { decision: step, usage: { promptTokens: 10, completionTokens: 5 }, model: "test-model" };
  };
  return { fn, rec };
}

function makeOrch(store: any, toolkit: any, over: Partial<OrchestratorDeps> = {}) {
  const deps: OrchestratorDeps = {
    storage: store as unknown as OrchestratorStorage,
    toolkit: toolkit as unknown as Pick<LabAgentToolkit, "call">,
    reconcile: over.reconcile ?? (async () => {}),
    composeReply:
      over.composeReply ??
      ((_user: string, hasKey: boolean) => ({
        content: `shell:${hasKey ? "key" : "nokey"}`,
        suggestedActions: [{ id: "a", label: "L", kind: "send", message: "m" }],
      })),
    estimateCost: over.estimateCost,
    limits: over.limits,
    now: over.now,
    genToken: over.genToken,
    isHandsOffApproved: over.isHandsOffApproved,
  };
  return new LabTurnOrchestrator(deps);
}

async function seedUser(store: any, content: string) {
  await store.createAgentMessageForWallet(WALLET, 1, { role: "user", content });
}

// --- tests -----------------------------------------------------------------------

describe("LabTurnOrchestrator — multi-tool turn", () => {
  it("runs a >=3-tool turn, updates memory, finishes with prose + deterministic chips", async () => {
    const store = makeStore();
    await seedUser(store, "optimize my strat");
    const toolkit = makeToolkit({
      listStrategies: () => ({ ok: true, data: { strategies: [{ id: 1, name: "FLUX" }] } }),
      getTopResults: () => ({ ok: true, data: { results: [{ rank: 1, netProfitPercent: 50 }] } }),
      findStrategy: () => ({ ok: true, data: { strategyId: 1, name: "FLUX" } }),
    });
    const brain = makeBrain([
      { action: "tool", tool: "listStrategies", args: {} },
      { action: "tool", tool: "getTopResults", args: { strategyId: 1 } },
      { action: "tool", tool: "findStrategy", args: { query: "flux" } },
      { action: "final", message: "Here is the summary." },
    ]);
    const orch = makeOrch(store, toolkit);

    const res = await orch.advance(1, { brain: brain.fn, hasKey: true });

    expect(res.outcome).toBe("final");
    expect(brain.rec.calls).toBe(4);
    expect(toolkit.countOf("listStrategies")).toBe(1);
    expect(toolkit.countOf("getTopResults")).toBe(1);
    expect(toolkit.countOf("findStrategy")).toBe(1);

    const task = store.tasks.get(1)!;
    expect(task.turnState).toBe("ready");
    expect(task.loopCount).toBe(0); // reset on finish
    expect(task.stepIndex).toBe(3); // three sync tool steps consumed
    expect((task.memory as any).currentStrategyId).toBe(1);
    expect((task.memory as any).ledger.length).toBeGreaterThanOrEqual(3);

    const lastAgent = store.agentMessages().at(-1)!;
    expect(lastAgent.content).toBe("Here is the summary.");
    expect(lastAgent.suggestedActions.length).toBeGreaterThan(0);
  });
});

describe("LabTurnOrchestrator — deterministic createStrategyFromText reply", () => {
  // Prod incident: the draft tool SUCCEEDED (strategy created) but the brain's post-tool
  // summary turn hallucinated "articleCactus is not a valid model for this request.",
  // telling the user a real success had failed. A successful chat-mode draft must report
  // its own KNOWN outcome deterministically and never run a brain summary turn.
  it("reports a successful draft deterministically, never the brain's post-tool summary", async () => {
    const store = makeStore(); // chat mode (default)
    await seedUser(store, "make me a trend strategy with partial TPs and a breakeven move");
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({
        ok: true,
        data: { strategyId: 28, name: "Trend Catcher Partial TP BE" },
      }),
    });
    // The brain picks the tool, then (would) hallucinate a false failure on the summary turn.
    const brain = makeBrain([
      { action: "tool", tool: "createStrategyFromText", args: { prompt: "trend with partial TPs" } },
      { action: "final", message: "articleCactus is not a valid model for this request." },
    ]);
    const orch = makeOrch(store, toolkit);

    const res = await orch.advance(1, { brain: brain.fn, hasKey: true });

    expect(res.outcome).toBe("final");
    expect(toolkit.countOf("createStrategyFromText")).toBe(1);
    // The summary turn is never asked of the brain — only the tool decision was made.
    expect(brain.rec.calls).toBe(1);

    const task = store.tasks.get(1)!;
    expect((task.memory as any).currentStrategyId).toBe(28);

    const lastAgent = store.agentMessages().at(-1)!;
    expect(lastAgent.content).toContain("Trend Catcher Partial TP BE");
    expect(lastAgent.content).toContain("#28");
    expect(lastAgent.content).not.toContain("articleCactus");
    expect(lastAgent.suggestedActions.length).toBeGreaterThan(0);
  });

  it("does NOT emit a success reply when the draft tool fails", async () => {
    const store = makeStore();
    await seedUser(store, "make me a strategy");
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({
        ok: false,
        error: { message: "draft failed to compile", retryable: true },
      }),
    });
    const brain = makeBrain([
      { action: "tool", tool: "createStrategyFromText", args: { prompt: "x" } },
      { action: "final", message: "I couldn't draft that — try rephrasing your idea." },
    ]);
    const orch = makeOrch(store, toolkit);

    const res = await orch.advance(1, { brain: brain.fn, hasKey: true });

    expect(res.outcome).toBe("final");
    const task = store.tasks.get(1)!;
    // The failed draft lifts no strategyId — it stays at the readMemory default (null),
    // and we never claim a real strategy was created.
    expect((task.memory as any).currentStrategyId).toBeNull();
    const lastAgent = store.agentMessages().at(-1)!;
    expect(lastAgent.content).toBe("I couldn't draft that — try rephrasing your idea.");
    expect(lastAgent.content).not.toContain("#");
  });
});

describe("LabTurnOrchestrator — async run wait then resume", () => {
  it("parks on a queued run, then resume folds it with NO re-exec / no double-enqueue", async () => {
    const store = makeStore();
    await seedUser(store, "run it");
    const toolkit = makeToolkit({
      runOptimization: () => ({
        ok: true,
        data: { runId: 500, correlationId: "corr", status: "queued", idempotent: false, jobsAhead: 2 },
      }),
      getRunStatus: () => ({
        ok: true,
        data: {
          runId: 500,
          status: "completed",
          stage: null,
          progressPct: 100,
          jobsAhead: null,
          totalConfigsTested: 300,
          oosFraction: 0.2,
          startedAt: null,
          completedAt: null,
          errorReason: null,
          correlationId: "corr",
        },
      }),
    });
    const orch = makeOrch(store, toolkit);

    // Phase 1: queue.
    const brain1 = makeBrain([
      { action: "tool", tool: "runOptimization", args: { strategyId: 1, symbols: ["SOL", "ETH"], timeframes: ["1h"] } },
    ]);
    const r1 = await orch.advance(1, { brain: brain1.fn, hasKey: true });
    expect(r1.outcome).toBe("waiting");
    expect(r1.runId).toBe(500);

    let task = store.tasks.get(1)!;
    expect(task.turnState).toBe("waiting_for_tool");
    expect(task.activeRunId).toBe(500);
    expect((task.currentStep as any).phase).toBe("waiting");
    expect((task.currentStep as any).runId).toBe(500);
    expect(task.turnLease).toBeNull(); // lease released on park

    const runCalls = toolkit.calls.filter((c) => c.method === "runOptimization");
    expect(runCalls.length).toBe(1);
    expect(typeof runCalls[0].args.idempotencyKey).toBe("string");

    // Phase 2: resume — brain decides final after seeing the finished run.
    const brain2 = makeBrain([{ action: "final", message: "Run done — results are unvalidated (no OOS check)." }]);
    const r2 = await orch.advance(1, { brain: brain2.fn, hasKey: true });
    expect(r2.outcome).toBe("final");

    expect(toolkit.countOf("runOptimization")).toBe(1); // NOT re-enqueued
    expect(toolkit.countOf("getRunStatus")).toBe(1);

    task = store.tasks.get(1)!;
    expect(task.currentStep).toBeNull();
    expect(task.activeRunId).toBeNull();
    expect(task.stepIndex).toBe(1); // the async step is consumed exactly once
    expect(task.turnState).toBe("ready");
  });

  it("stays parked while the run is still running (client will /step again)", async () => {
    const store = makeStore();
    await seedUser(store, "run");
    const toolkit = makeToolkit({
      runOptimization: () => ({
        ok: true,
        data: { runId: 9, correlationId: "c", status: "queued", idempotent: false, jobsAhead: 0 },
      }),
      getRunStatus: () => ({
        ok: true,
        data: {
          runId: 9, status: "running", stage: "random", progressPct: 40, jobsAhead: null,
          totalConfigsTested: 10, oosFraction: null, startedAt: null, completedAt: null,
          errorReason: null, correlationId: "c",
        },
      }),
    });
    const orch = makeOrch(store, toolkit);

    await orch.advance(1, {
      brain: makeBrain([{ action: "tool", tool: "runOptimization", args: { strategyId: 1, symbols: ["SOL"], timeframes: ["1h"] } }]).fn,
      hasKey: true,
    });
    // Resume while still running: should NOT call the brain, should re-park.
    const noBrain = makeBrain([{ action: "final", message: "should not be reached" }]);
    const r = await orch.advance(1, { brain: noBrain.fn, hasKey: true });
    expect(r.outcome).toBe("waiting");
    expect(noBrain.rec.calls).toBe(0);
    expect(store.tasks.get(1)!.stepIndex).toBe(0); // not consumed yet
  });
});

describe("LabTurnOrchestrator — auto mode invalidates a stale read on async queue", () => {
  it("clears autoLastTool when graduating so the next evaluate re-fetches fresh results", async () => {
    // A robust SOL result is already stashed (getTopResults). The deterministic planner
    // graduates → queues runOptimization on the REST of the basket. executeAsyncTool MUST
    // clear autoLastTool so the next evaluate tick is forced to re-fetch getTopResults for
    // the graduation run; otherwise it re-reads the stale SOL stash and finals "SOL-specific"
    // on the wrong data (never reading the ETH/ARB results).
    const robustSol = {
      runId: 1, ticker: "SOL", timeframe: "1h", rank: 1, netProfitPercent: 10,
      winRatePercent: 55, maxDrawdownPercent: 8, profitFactor: 1.4, sharpeRatio: 1.0,
      totalTrades: 40, params: {}, oos: { sharpeRatio: 0.8 },
    };
    const store = makeStore({
      mode: "auto",
      goal: "momentum on SOL",
      memory: {
        currentStrategyId: 9,
        ledger: [],
        autoLastTool: {
          tool: "getTopResults",
          data: { strategyId: 9, runId: 1, rankedBy: "lab_objective", results: [robustSol] },
        },
        auto: { ...defaultAutoMemory(), phase: "evaluate", graduated: false, symbols: ["SOL", "ETH", "ARB"], autoStepCount: 3 },
      } as any,
    });
    await seedUser(store, "go");
    const toolkit = makeToolkit({
      runOptimization: () => ({
        ok: true,
        data: { runId: 7, correlationId: "c7", status: "queued", idempotent: false, jobsAhead: 0 },
      }),
    });
    const planner = createAutoPlanner({ estimatePaidCostUsd: () => 0.01 });
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: planner, hasKey: true });

    expect(r.outcome).toBe("waiting");
    const task = store.tasks.get(1)!;
    const call = toolkit.calls.find((c) => c.method === "runOptimization");
    expect(call).toBeTruthy();
    expect(call!.args.symbols).toEqual(["ETH", "ARB"]); // graduated to the rest of the basket
    expect((task.memory as any).auto.graduated).toBe(true);
    expect((task.memory as any).autoLastTool).toBeNull(); // stale SOL read invalidated
  });

  it("flags widenExhausted (surviving the rollback) when the widen run says every ticker is already tested", async () => {
    // A robust SOL result is stashed and the basket has graduation symbols, so the planner
    // launches the widen runOptimization. The adapter rejects it terminally (all tickers
    // already backtested). executeAsyncTool rolls auto memory back BUT must overlay
    // widenExhausted:true so the next planner tick finalizes instead of re-issuing the same
    // doomed widen forever (the interleaved getTopResults success resets toolErrorStreak, so
    // that guard never trips).
    const robustSol = {
      runId: 1, ticker: "SOL", timeframe: "1h", rank: 1, netProfitPercent: 10,
      winRatePercent: 55, maxDrawdownPercent: 8, profitFactor: 1.4, sharpeRatio: 1.0,
      totalTrades: 40, params: {}, oos: { sharpeRatio: 0.8 },
    };
    const store = makeStore({
      mode: "auto",
      goal: "momentum on SOL",
      memory: {
        currentStrategyId: 9,
        ledger: [],
        autoLastTool: {
          tool: "getTopResults",
          data: { strategyId: 9, runId: 1, rankedBy: "lab_objective", results: [robustSol] },
        },
        auto: { ...defaultAutoMemory(), phase: "evaluate", graduated: false, symbols: ["SOL", "ETH", "ARB"], autoStepCount: 3 },
      } as any,
    });
    await seedUser(store, "go");
    const toolkit = makeToolkit({
      runOptimization: () => ({
        ok: false,
        error: { code: "all_tickers_tested", message: "Every requested ticker was already backtested for this strategy.", retryable: false },
      }),
      getTopResults: () => ({
        ok: true,
        data: { strategyId: 9, runId: 1, rankedBy: "lab_objective", results: [robustSol] },
      }),
    });
    const planner = createAutoPlanner({ estimatePaidCostUsd: () => 0.01 });
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: planner, hasKey: true });

    // The whole loop breaks within ONE advance: widen fails → widenExhausted flagged
    // (survives the rollback) → re-fetch → finalize. It does NOT re-issue the widen.
    expect(r.outcome).toBe("final");
    const task = store.tasks.get(1)!;
    expect((task.memory as any).auto.widenExhausted).toBe(true); // survives the rollback
    expect((task.memory as any).auto.graduated).toBe(false); // phase advance rolled back
    expect(toolkit.countOf("runOptimization")).toBe(1); // the doomed widen ran exactly once
  });
});

describe("LabTurnOrchestrator — crash replay of an executing step", () => {
  it("replays the STORED async tool (not the brain) and reuses the stored idempotency key", async () => {
    const FIXED_KEY = "fixed-key-123";
    const store = makeStore({
      currentStep: {
        phase: "executing",
        stepIndex: 0,
        tool: "runOptimization",
        args: { strategyId: 1, symbols: ["SOL"], timeframes: ["1h"], idempotencyKey: FIXED_KEY },
      } as any,
    });
    await seedUser(store, "run");
    const toolkit = makeToolkit({
      runOptimization: () => ({
        ok: true,
        data: { runId: 777, correlationId: "c", status: "queued", idempotent: true, jobsAhead: 0 },
      }),
    });
    const brain = makeBrain([{ action: "final", message: "unused" }]);
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });

    expect(r.outcome).toBe("waiting");
    expect(r.runId).toBe(777);
    expect(brain.rec.calls).toBe(0); // brain never consulted on replay
    const runCalls = toolkit.calls.filter((c) => c.method === "runOptimization");
    expect(runCalls.length).toBe(1);
    expect(runCalls[0].args.idempotencyKey).toBe(FIXED_KEY); // reused, not re-derived
  });
});

describe("LabTurnOrchestrator — single-flight", () => {
  it("two concurrent advance() calls run exactly one turn; the loser no-ops", async () => {
    const store = makeStore();
    await seedUser(store, "hi");
    const toolkit = makeToolkit({});
    const brainA = makeBrain([{ action: "final", message: "A done" }]);
    const brainB = makeBrain([{ action: "final", message: "B done" }]);
    const orch = makeOrch(store, toolkit);

    const [rA, rB] = await Promise.all([
      orch.advance(1, { brain: brainA.fn, hasKey: true }),
      orch.advance(1, { brain: brainB.fn, hasKey: true }),
    ]);

    const outcomes = [rA.outcome, rB.outcome];
    expect(outcomes.filter((o) => o === "busy").length).toBe(1);
    expect(brainA.rec.calls + brainB.rec.calls).toBe(1); // only the winner thought
  });
});

describe("LabTurnOrchestrator — leash halts", () => {
  it("halts at the global brain-call cap and degrades to the shell reply", async () => {
    const store = makeStore();
    await seedUser(store, "loop");
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "update_plan", plan: ["step a", "step b"] }]);
    const orch = makeOrch(store, toolkit, { limits: { maxBrainCalls: 3, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: false });

    expect(r.outcome).toBe("halted_iterations");
    expect(brain.rec.calls).toBe(3);
    const task = store.tasks.get(1)!;
    expect(task.turnState).toBe("ready");
    expect(task.loopCount).toBe(0);
    expect(store.agentMessages().at(-1)!.content).toBe("shell:nokey");
  });

  it("halts at the hard spend cap", async () => {
    const store = makeStore();
    await seedUser(store, "spend");
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "update_plan", plan: ["a"] }]);
    const orch = makeOrch(store, toolkit, {
      limits: { maxBrainCalls: 50, maxSegmentIterations: 50, hardSpendCapUsd: 0.5 },
      estimateCost: async () => 0.3,
    });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });

    expect(r.outcome).toBe("halted_spend");
    expect(brain.rec.calls).toBe(2); // 0 -> 0.3 -> 0.6 (>=0.5 trips on the 3rd check)
    expect(store.tasks.get(1)!.spendEstimateUsd).toBeCloseTo(0.6, 5);
  });

  it("yields when a single segment runs too long without pausing", async () => {
    const store = makeStore();
    await seedUser(store, "go");
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "update_plan", plan: ["a"] }]);
    const orch = makeOrch(store, toolkit, { limits: { maxBrainCalls: 50, maxSegmentIterations: 2 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("yield");
    expect(brain.rec.calls).toBe(2);
  });
});

describe("LabTurnOrchestrator — repair budgets", () => {
  it("retries malformed decisions within budget then succeeds", async () => {
    const store = makeStore();
    await seedUser(store, "x");
    const toolkit = makeToolkit({});
    const brain = makeBrain([
      { throw: new MalformedDecisionError("bad1") },
      { throw: new MalformedDecisionError("bad2") },
      { action: "final", message: "recovered" },
    ]);
    const orch = makeOrch(store, toolkit, { limits: { maxMalformedRetries: 2, maxBrainCalls: 50, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("final");
    expect(brain.rec.calls).toBe(3);
    expect(store.agentMessages().at(-1)!.content).toBe("recovered");
  });

  it("degrades when malformed decisions exhaust the budget", async () => {
    const store = makeStore();
    await seedUser(store, "x");
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ throw: new MalformedDecisionError("always bad") }]);
    const orch = makeOrch(store, toolkit, { limits: { maxMalformedRetries: 2, maxBrainCalls: 50, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("halted_malformed");
    expect(brain.rec.calls).toBe(3);
  });

  it("salvages a chat-mode conversational answer from prose once retries are exhausted", async () => {
    const store = makeStore();
    await seedUser(store, "how does the creator work?");
    const toolkit = makeToolkit({});
    const prose =
      "Under the hood I send your plain-English idea to an AI that writes a Pine strategy, then I can backtest it for you.";
    const brain = makeBrain([{ throw: new MalformedDecisionError("not json", prose) }]);
    const orch = makeOrch(store, toolkit, { limits: { maxMalformedRetries: 2, maxBrainCalls: 50, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("final");
    expect(brain.rec.calls).toBe(3); // exhausted the repair budget first
    expect(store.agentMessages().at(-1)!.content).toBe(prose);
  });

  it("does NOT salvage prose in auto mode (planner output must not become a final)", async () => {
    const store = makeStore({ mode: "auto" });
    await seedUser(store, "how does the creator work?");
    const toolkit = makeToolkit({});
    const prose = "Some plausible prose answer that should not end an auto pipeline turn.";
    const brain = makeBrain([{ throw: new MalformedDecisionError("not json", prose) }]);
    const orch = makeOrch(store, toolkit, { limits: { maxMalformedRetries: 2, maxBrainCalls: 50, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("halted_malformed");
  });

  it("does NOT salvage prose for an in-scope DATA question (no fabricated numbers)", async () => {
    const store = makeStore();
    await seedUser(store, "what's my best result?");
    const toolkit = makeToolkit({});
    const prose = "Your best result is Stop-Run Reversal v2, up 418% net on SOL.";
    const brain = makeBrain([{ throw: new MalformedDecisionError("not json", prose) }]);
    const orch = makeOrch(store, toolkit, { limits: { maxMalformedRetries: 2, maxBrainCalls: 50, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("halted_malformed");
    // degraded to the deterministic shell, NOT the model's fabricated prose
    expect(store.agentMessages().at(-1)!.content).not.toBe(prose);
  });

  it("degrades on a non-malformed brain transport error", async () => {
    const store = makeStore();
    await seedUser(store, "x");
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ throw: new Error("gateway down") }]);
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("error");
    expect(brain.rec.calls).toBe(1);
    expect(store.agentMessages().at(-1)!.content).toBe("shell:key");
  });

  it("degrades when tool errors exhaust the budget", async () => {
    const store = makeStore();
    await seedUser(store, "x");
    const toolkit = makeToolkit({
      listStrategies: () => ({ ok: false, error: { code: "internal", message: "boom", retryable: true } }),
    });
    const brain = makeBrain([{ action: "tool", tool: "listStrategies", args: {} }]);
    const orch = makeOrch(store, toolkit, { limits: { maxToolErrorRetries: 3, maxBrainCalls: 50, maxSegmentIterations: 50 } });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("halted_tool_errors");
    expect(brain.rec.calls).toBe(4); // 1 initial + 3 retries, then degrade
  });
});

describe("LabTurnOrchestrator — reconcile / stop gates", () => {
  it("does not call the brain when the task is already terminal", async () => {
    const store = makeStore({ status: "completed" });
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "final", message: "nope" }]);
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("stopped");
    expect(brain.rec.calls).toBe(0);
  });

  it("winds an AUTO run down (no brain call) when a cancel was requested", async () => {
    const store = makeStore({ mode: "auto", cancelRequestedAt: new Date() });
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "final", message: "nope" }]);
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("stopped");
    expect(brain.rec.calls).toBe(0);
    // The stop is CONSUMED: flag cleared + dropped back to chat so it can't re-fire.
    expect(store.tasks.get(1)!.cancelRequestedAt).toBeNull();
    expect(store.tasks.get(1)!.mode).toBe("chat");
  });

  it("clears a STALE cancel flag on a chat task WITHOUT swallowing the turn", async () => {
    // A stop landing in the tiny window AFTER an auto turn finished + flipped to chat
    // leaves a stale cancelRequestedAt on a chat-mode task. The gate must clear it and
    // STILL answer the turn — winding down here would poison the user's next message.
    const store = makeStore({ mode: "chat", cancelRequestedAt: new Date() });
    await seedUser(store, "hello again");
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "final", message: "answered" }]);
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("final");
    expect(brain.rec.calls).toBe(1);
    expect(store.tasks.get(1)!.cancelRequestedAt).toBeNull();
    expect(store.agentMessages().at(-1)!.content).toBe("answered");
  });

  it("reconcile at entry can stop the turn before any brain call", async () => {
    const store = makeStore();
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "final", message: "nope" }]);
    const orch = makeOrch(store, toolkit, {
      reconcile: async (id: number) => {
        store.tasks.get(id)!.status = "stopped";
      },
    });

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("stopped");
    expect(brain.rec.calls).toBe(0);
  });
});

// The deterministic planner is unit-tested in auto-planner.test.ts. These lock the
// ORCHESTRATOR integration of the paid-step path: paid steps are now always
// auto-approved (no confirm park), and a stop drops a live auto run back to chat.
describe("LabTurnOrchestrator — auto mode confirm gate", () => {
  const estimatePaidCostUsd = (t: PaidTool) => (t === "createStrategyFromText" ? 0.06 : 0.12);

  it("auto-approves the PAID create without parking — tool runs in the same advance", async () => {
    const store = makeStore({
      mode: "auto",
      goal: "a momentum strategy on SOL",
      // A style is already chosen, so the run is at the PAID-create step.
      memory: { auto: { ...defaultAutoMemory(), style: "trend" } } as unknown as Record<string, unknown>,
    });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit);
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    // No park — the paid tool runs immediately and the advance proceeds to the async backtest.
    expect(toolkit.countOf("createStrategyFromText")).toBe(1);
    expect(r.outcome).toBe("waiting");
    const task = store.tasks.get(1)!;
    expect((task.memory as any).auto.pendingConfirm ?? null).toBeNull(); // gate cleared
    expect(task.spendEstimateUsd).toBeCloseTo(0.06, 5); // approved estimate billed
    // No watched confirm/decline chips posted (seamless flow)
    const chips = store.messages.flatMap((m) => (m.suggestedActions as any[]) ?? []);
    expect(chips.some((c) => String(c.id).startsWith("auto-confirm-"))).toBe(false);
    expect(chips.some((c) => String(c.id).startsWith("auto-decline-"))).toBe(false);
  });

  it("runs the PAID create EXACTLY once after a matching confirmedToken, bills it, then parks on the backtest", async () => {
    const auto: AutoMemory = {
      ...defaultAutoMemory(),
      phase: "create",
      pendingConfirm: {
        tool: "createStrategyFromText",
        token: "tok-9",
        estCostUsd: 0.06,
        args: { prompt: "momentum on SOL" },
      },
      confirmedToken: "tok-9",
      style: "trend", // style chosen earlier; a confirmed create only exists past the style gate
    };
    const store = makeStore({
      mode: "auto",
      goal: "momentum on SOL",
      memory: { auto } as unknown as Record<string, unknown>,
    });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit);
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(toolkit.countOf("createStrategyFromText")).toBe(1); // ran exactly once
    expect(r.outcome).toBe("waiting"); // advanced create→backtest→async run, parked
    const task = store.tasks.get(1)!;
    expect((task.memory as any).currentStrategyId).toBe(7);
    expect((task.memory as any).auto.pendingConfirm ?? null).toBeNull(); // gate cleared
    expect(task.spendEstimateUsd).toBeCloseTo(0.06, 5); // billed the approved estimate
  });

  it("a stale confirmedToken still auto-approves — orchestrator replaces the token and runs the tool", async () => {
    const auto: AutoMemory = {
      ...defaultAutoMemory(),
      phase: "create",
      pendingConfirm: {
        tool: "createStrategyFromText",
        token: "tok-A",
        estCostUsd: 0.06,
        args: { prompt: "momentum on SOL" },
      },
      confirmedToken: "tok-STALE",
      style: "trend",
    };
    const store = makeStore({
      mode: "auto",
      goal: "momentum on SOL",
      memory: { auto } as unknown as Record<string, unknown>,
    });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit);
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    // Auto-approve replaces the stale token, tool runs in the same advance.
    expect(toolkit.countOf("createStrategyFromText")).toBe(1);
    expect(r.outcome).toBe("waiting");
    expect(store.tasks.get(1)!.spendEstimateUsd).toBeCloseTo(0.06, 5);
  });

  it("a stop on a LIVE auto run winds down, flips mode→chat, and clears the cancel flag", async () => {
    const store = makeStore({
      mode: "auto",
      cancelRequestedAt: new Date(),
      memory: { auto: defaultAutoMemory() } as unknown as Record<string, unknown>,
    });
    const toolkit = makeToolkit({});
    const orch = makeOrch(store, toolkit);
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("stopped");
    const task = store.tasks.get(1)!;
    expect(task.mode).toBe("chat"); // dropped back so a later /step can't re-drive the planner
    expect(task.cancelRequestedAt ?? null).toBeNull(); // signal consumed
    expect(toolkit.calls.length).toBe(0); // no tool ran
  });

  it("a stop landing mid-iteration (after the gate, before the await_confirm park) winds down instead of stranding", async () => {
    // The loop's top gate only sees a stop set BEFORE the iteration begins. A Stop can still
    // land AFTER the gate but before the paid-step park — and await_confirm is the ONE park
    // that stays in auto + ready (final/degrade flip to chat), where the client then stops
    // polling so nothing else would consume the flag. The pre-park re-check must convert it
    // to a clean stop rather than leave the task at auto + ready + cancelRequestedAt.
    const store = makeStore({
      mode: "auto",
      goal: "momentum on SOL",
      memory: { auto: defaultAutoMemory() } as unknown as Record<string, unknown>,
    });
    const toolkit = makeToolkit({});
    const orch = makeOrch(store, toolkit);
    // Custom brain: simulate a Stop click DURING this iteration (set the flag as a side
    // effect), then return the paid-step gate the deterministic planner would emit. usage is
    // undefined to mirror the LLM-free planner (no cost bump).
    let calls = 0;
    const brain: BrainFn = async () => {
      calls++;
      store.tasks.get(1)!.cancelRequestedAt = new Date();
      return {
        decision: {
          action: "await_confirm",
          tool: "createStrategyFromText",
          args: { prompt: "momentum on SOL" },
          estCostUsd: 0.06,
          reason: "Create the first strategy draft.",
        },
        usage: undefined,
      };
    };

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("stopped");
    expect(calls).toBe(1);
    const task = store.tasks.get(1)!;
    expect(task.mode).toBe("chat"); // dropped back so a later /step can't re-drive the planner
    expect(task.cancelRequestedAt ?? null).toBeNull(); // signal consumed
    expect(task.turnState).toBe("ready");
    expect(task.status).toBe("active"); // NOT stranded at awaiting_input
    // The confirm prompt was never posted — we re-checked BEFORE requestConfirmation.
    const chips = store.agentMessages().flatMap((m) => (m.suggestedActions as any[]) ?? []);
    expect(chips.some((c) => String(c.id).startsWith("auto-confirm-"))).toBe(false);
  });
});

// Task 201 — hands-off (autonomous) mode. A whitelisted wallet's runs auto-approve the PAID
// steps instead of parking on a confirm chip, but EVERY Task #200 cap stays in force. These
// lock the orchestrator integration: the live whitelist re-check is fail-closed (intent alone
// is never enough), an instant Stop still wins, the auto-approval is idempotent across a
// re-drive, and the planner's 90% spend guard halts BEFORE any approval.
describe("LabTurnOrchestrator — hands-off (autonomous) mode", () => {
  const estimatePaidCostUsd = (t: PaidTool) => (t === "createStrategyFromText" ? 0.06 : 0.12);

  // Hands-off auto memory. A style is chosen by default so these tests land at the PAID-create
  // step they exercise; the style gate firing in hands-off mode is covered by its own test
  // (pass { style: null } to reach the gate).
  function handsOffMemory(over: Partial<AutoMemory> = {}): Record<string, unknown> {
    return { auto: { ...defaultAutoMemory(), handsOff: true, style: "trend", ...over } } as unknown as Record<string, unknown>;
  }

  it("the style gate STILL fires in hands-off mode (a direction choice is not a spend)", async () => {
    const store = makeStore({
      mode: "auto",
      goal: "build me a strategy on SOL",
      memory: handsOffMemory({ style: null }),
    });
    const toolkit = makeToolkit({ createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }) });
    const orch = makeOrch(store, toolkit, { isHandsOffApproved: async () => true });
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("awaiting_style"); // parks for the KIND even though hands-off is on
    expect(toolkit.countOf("createStrategyFromText")).toBe(0); // no draft until a style is picked
    const task = store.tasks.get(1)!;
    expect(task.status).toBe("awaiting_input");
    expect(task.turnState).toBe("ready"); // stays in auto + ready, like the confirm park
    expect((task.memory as any).auto.awaitingStyle).toBe(true);
    // style chips are posted, and NO auto-approval happened
    const chips = store.agentMessages().at(-1)!.suggestedActions as any[];
    expect(chips.some((c) => String(c.id).startsWith("auto-style-"))).toBe(true);
    expect(store.messages.some((m) => m.role === "tool" && String(m.content).includes("auto-approved"))).toBe(false);
  });

  it("auto-runs the PAID create with NO confirm park — bills it once and posts a single note", async () => {
    const store = makeStore({ mode: "auto", goal: "a momentum strategy on SOL", memory: handsOffMemory() });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit, { isHandsOffApproved: async () => true });
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("waiting"); // approved create → ran → parked on the async backtest
    expect(toolkit.countOf("createStrategyFromText")).toBe(1); // ran without a human confirm
    const task = store.tasks.get(1)!;
    expect((task.memory as any).currentStrategyId).toBe(7);
    expect((task.memory as any).auto.pendingConfirm ?? null).toBeNull(); // gate cleared
    expect(task.spendEstimateUsd).toBeCloseTo(0.06, 5); // approved estimate billed once
    // exactly one auto-approval note, and NO watched confirm chips were ever posted
    const notes = store.messages.filter(
      (m) => m.role === "tool" && String(m.content).includes("auto-approved createStrategyFromText"),
    );
    expect(notes.length).toBe(1);
    const chips = store.messages.flatMap((m) => (m.suggestedActions as any[]) ?? []);
    expect(chips.some((c) => String(c.id).startsWith("auto-confirm-"))).toBe(false);
  });

  it("paid steps auto-run even when the wallet is NOT on the whitelist (gate removed)", async () => {
    const store = makeStore({ mode: "auto", goal: "momentum on SOL", memory: handsOffMemory() });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit, { isHandsOffApproved: async () => false });
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    // No park — whitelist state is irrelevant now that the gate is gone.
    expect(toolkit.countOf("createStrategyFromText")).toBe(1);
    expect(r.outcome).toBe("waiting");
    const chips = store.messages.flatMap((m) => (m.suggestedActions as any[]) ?? []);
    expect(chips.some((c) => String(c.id).startsWith("auto-confirm-"))).toBe(false);
  });

  it("paid steps auto-run even with no whitelist dep configured (seamless for all users)", async () => {
    const store = makeStore({ mode: "auto", goal: "momentum on SOL", memory: handsOffMemory() });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit); // no isHandsOffApproved override
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(toolkit.countOf("createStrategyFromText")).toBe(1);
    expect(r.outcome).toBe("waiting");
  });

  it("paid steps auto-run even when the whitelist check throws (confirm gate is gone)", async () => {
    const store = makeStore({ mode: "auto", goal: "momentum on SOL", memory: handsOffMemory() });
    const toolkit = makeToolkit({
      createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }),
      runOptimization: () => ({ ok: true, data: { runId: 101, correlationId: "c-101" } }),
    });
    const orch = makeOrch(store, toolkit, {
      isHandsOffApproved: async () => {
        throw new Error("whitelist backend down");
      },
    });
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(toolkit.countOf("createStrategyFromText")).toBe(1);
    expect(r.outcome).toBe("waiting");
  });

  it("an instant Stop that lands during the iteration wins BEFORE auto-approval — no spend, no note", async () => {
    const store = makeStore({ mode: "auto", goal: "momentum on SOL", memory: handsOffMemory() });
    const toolkit = makeToolkit({ createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }) });
    const orch = makeOrch(store, toolkit, { isHandsOffApproved: async () => true });
    // Simulate a Stop click DURING this iteration, then return the paid-step gate the planner
    // would emit. The pre-approve Stop re-check must convert it to a clean stop.
    let calls = 0;
    const brain: BrainFn = async () => {
      calls++;
      store.tasks.get(1)!.cancelRequestedAt = new Date();
      return {
        decision: {
          action: "await_confirm",
          tool: "createStrategyFromText",
          args: { prompt: "momentum on SOL" },
          estCostUsd: 0.06,
          reason: "Create the first draft.",
        },
        usage: undefined,
      };
    };

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("stopped");
    expect(calls).toBe(1);
    const task = store.tasks.get(1)!;
    expect(task.mode).toBe("chat"); // dropped back so a later /step can't re-drive the planner
    expect(task.cancelRequestedAt ?? null).toBeNull(); // signal consumed
    expect(toolkit.countOf("createStrategyFromText")).toBe(0);
    expect((task.memory as any).auto?.confirmedToken ?? null).toBeNull(); // never approved
    expect(store.messages.some((m) => m.role === "tool" && String(m.content).includes("auto-approved"))).toBe(false);
  });

  it("is idempotent across a re-drive: re-entering await_confirm for an approved step never doubles a token or note", async () => {
    const store = makeStore({ mode: "auto", goal: "momentum on SOL", memory: handsOffMemory() });
    const toolkit = makeToolkit({}); // the scripted brain never emits the tool action, so it can't run
    const orch = makeOrch(store, toolkit, { isHandsOffApproved: async () => true });
    // Pathological brain: ALWAYS asks to confirm the SAME paid step. The first tick auto-approves
    // (mints a token + posts a note); every later tick must be an idempotent no-op until the
    // segment-iteration cap yields the lease. (usage undefined ⇒ no loopCount/spend bump.)
    const brain: BrainFn = async () => ({
      decision: {
        action: "await_confirm",
        tool: "createStrategyFromText",
        args: { prompt: "momentum on SOL" },
        estCostUsd: 0.06,
        reason: "Draft it.",
      },
      usage: undefined,
    });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("yield"); // long non-pausing segment trips the iteration cap
    const notes = store.messages.filter(
      (m) => m.role === "tool" && String(m.content).includes("auto-approved"),
    );
    expect(notes.length).toBe(1); // posted exactly once despite many re-entries
    expect(toolkit.countOf("createStrategyFromText")).toBe(0);
    const auto = (store.tasks.get(1)!.memory as any).auto;
    expect(auto.confirmedToken).toBe(auto.pendingConfirm.token); // a single, stable approved token
  });

  it("does NOT bypass the spend cap — the planner's 90% guard halts before any hands-off approval", async () => {
    // 1.79 + 0.06 (= 1.85) exceeds 0.9 × $2.00 (= $1.80) but stays under the $2.00 hard gate, so
    // the planner's pre-spend guard fires and returns a graceful final — never an auto-approval.
    const store = makeStore({
      mode: "auto",
      goal: "momentum on SOL",
      spendEstimateUsd: 1.79,
      memory: handsOffMemory(),
    });
    const toolkit = makeToolkit({ createStrategyFromText: () => ({ ok: true, data: { strategyId: 7 } }) });
    const orch = makeOrch(store, toolkit, { isHandsOffApproved: async () => true });
    const brain = createAutoPlanner({ estimatePaidCostUsd });

    const r = await orch.advance(1, { brain, hasKey: true });

    expect(r.outcome).toBe("final"); // graceful spend-cap stop, not an auto-approval
    expect(toolkit.countOf("createStrategyFromText")).toBe(0);
    expect(store.messages.some((m) => m.role === "tool" && String(m.content).includes("auto-approved"))).toBe(false);
    expect(String(store.agentMessages().at(-1)!.content)).toMatch(/spend cap/i);
  });
});

// ---------------------------------------------------------------------------
// WO-4: corrective note — transient context injected after MalformedDecisionError
// ---------------------------------------------------------------------------

describe("LabTurnOrchestrator — WO-4 corrective note", () => {
  it("injects a corrective note into brain context after a MalformedDecisionError", async () => {
    const store = makeStore();
    await seedUser(store, "what is the win rate?");
    const toolkit = makeToolkit();

    const capturedCtxs: import("../../server/lab-agent/chat-brain").BrainTurnContext[] = [];
    let callIdx = 0;
    const brain: BrainFn = async (ctx) => {
      capturedCtxs.push(ctx);
      callIdx++;
      if (callIdx === 1) throw new MalformedDecisionError("No JSON object found", "just prose text");
      return { decision: { action: "final", message: "The win rate is 68%." }, usage: { promptTokens: 5, completionTokens: 5 }, model: "test-model" };
    };

    const orch = makeOrch(store, toolkit, {
      limits: { maxMalformedRetries: 1, maxBrainCalls: 10, hardSpendCapUsd: 9999, maxToolErrorRetries: 3, maxAutoSteps: 50, maxSegmentIterations: 30 },
    });
    const res = await orch.advance(1, { brain, hasKey: true });

    expect(res.outcome).toBe("final");
    expect(capturedCtxs).toHaveLength(2);
    // First call: NO corrective note
    const firstNote = capturedCtxs[0]!.recentMessages.find(
      (m) => m.role === "agent" && m.content.includes("rejected"),
    );
    expect(firstNote).toBeUndefined();
    // Second call: corrective note present as last message in recentMessages
    const secondNote = capturedCtxs[1]!.recentMessages.find(
      (m) => m.role === "agent" && m.content.includes("rejected"),
    );
    expect(secondNote).toBeDefined();
    expect(secondNote!.content).toMatch(/JSON envelope/i);
  });

  it("clears the corrective note after a successful parse (does not bleed into next turn)", async () => {
    const store = makeStore();
    await seedUser(store, "first question");
    const toolkit = makeToolkit();

    const capturedCtxs: import("../../server/lab-agent/chat-brain").BrainTurnContext[] = [];
    let callIdx = 0;
    const brain: BrainFn = async (ctx) => {
      capturedCtxs.push(ctx);
      callIdx++;
      if (callIdx === 1) throw new MalformedDecisionError("bad", "bad output");
      // Second call succeeds — corrective note should be in ctx
      if (callIdx === 2) return { decision: { action: "final", message: "done" }, usage: { promptTokens: 5, completionTokens: 5 }, model: "m" };
      // Third call (new turn after user sends another message)
      return { decision: { action: "final", message: "second done" }, usage: { promptTokens: 5, completionTokens: 5 }, model: "m" };
    };

    const orch = makeOrch(store, toolkit, {
      limits: { maxMalformedRetries: 1, maxBrainCalls: 10, hardSpendCapUsd: 9999, maxToolErrorRetries: 3, maxAutoSteps: 50, maxSegmentIterations: 30 },
    });
    // First segment: malformed on call 1, succeeds on call 2
    await orch.advance(1, { brain, hasKey: true });
    // Second segment: simulate a new user message
    await seedUser(store, "second question");
    await orch.advance(1, { brain, hasKey: true });

    // Third call: no corrective note (cleared after call 2)
    if (capturedCtxs[2]) {
      const bleedNote = capturedCtxs[2].recentMessages.find(
        (m) => m.role === "agent" && m.content.includes("rejected") && m.content.includes("JSON envelope"),
      );
      expect(bleedNote).toBeUndefined();
    }
  });

  it("does not write the corrective note to storage", async () => {
    const store = makeStore();
    await seedUser(store, "why did my strategy fail?");
    const toolkit = makeToolkit();

    let callIdx = 0;
    const brain: BrainFn = async () => {
      callIdx++;
      if (callIdx === 1) throw new MalformedDecisionError("bad json", "bad output");
      return { decision: { action: "final", message: "Here is why." }, usage: { promptTokens: 5, completionTokens: 5 }, model: "m" };
    };

    const orch = makeOrch(store, toolkit, {
      limits: { maxMalformedRetries: 1, maxBrainCalls: 10, hardSpendCapUsd: 9999, maxToolErrorRetries: 3, maxAutoSteps: 50, maxSegmentIterations: 30 },
    });
    await orch.advance(1, { brain, hasKey: true });

    // Corrective note must NOT be persisted to the message store
    const allMessages = store.messages as import("../../shared/schema").LabAgentMessage[];
    const hasNote = allMessages.some(
      (m) => m.role === "agent" && m.content.includes("rejected") && m.content.includes("JSON envelope"),
    );
    expect(hasNote).toBe(false);
  });

  it("halts with halted_malformed when malformed streak exceeds maxMalformedRetries", async () => {
    const store = makeStore();
    await seedUser(store, "when will SOL moon?");
    const toolkit = makeToolkit();

    const brain: BrainFn = async () => {
      throw new MalformedDecisionError("bad", "bad prose");
    };

    const orch = makeOrch(store, toolkit, {
      limits: { maxMalformedRetries: 0, maxBrainCalls: 10, hardSpendCapUsd: 9999, maxToolErrorRetries: 3, maxAutoSteps: 50, maxSegmentIterations: 30 },
    });
    const res = await orch.advance(1, { brain, hasKey: true });
    expect(res.outcome).toBe("halted_malformed");
  });
});
