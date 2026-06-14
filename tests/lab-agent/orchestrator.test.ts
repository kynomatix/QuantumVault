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
import { MalformedDecisionError, type BrainDecision, type BrainFn } from "../../server/lab-agent/chat-brain";
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

  it("does not call the brain when a cancel was requested", async () => {
    const store = makeStore({ cancelRequestedAt: new Date() });
    const toolkit = makeToolkit({});
    const brain = makeBrain([{ action: "final", message: "nope" }]);
    const orch = makeOrch(store, toolkit);

    const r = await orch.advance(1, { brain: brain.fn, hasKey: true });
    expect(r.outcome).toBe("stopped");
    expect(brain.rec.calls).toBe(0);
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
