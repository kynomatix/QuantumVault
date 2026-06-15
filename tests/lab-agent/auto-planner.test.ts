// Phase 2 (Task #200) — deterministic auto-pipeline planner.
//
// The planner is a PURE reducer over (auto memory + observed results): no DB, no
// network, no clock. These lock the pipeline ORDER, the robustness short-circuit and
// continuation, the improve cap, the autoStep cap, and the pre-spend 90% guard — plus
// that PAID steps only ever go through await_confirm (never a bare tool call).

import { describe, it, expect } from "vitest";
import {
  planAutoTurn,
  pickRobustResult,
  DEFAULT_AUTO_PLANNER_LIMITS,
  type AutoPlannerDeps,
} from "../../server/lab-agent/auto-planner";
import { defaultAutoMemory, type AutoMemory, type AutoTurnContext } from "../../server/lab-agent/chat-brain";
import type { BacktestResultDto, TopResultsDto } from "@shared/lab-agent-contract";

const PAID_EST = 0.05;

// A deps with a cheap, fixed paid estimate. Override per-test as needed.
function deps(over: Partial<AutoPlannerDeps> = {}): AutoPlannerDeps {
  return { estimatePaidCostUsd: () => PAID_EST, ...over };
}

function ctx(over: Partial<AutoTurnContext> = {}): AutoTurnContext {
  return {
    memory: defaultAutoMemory(),
    goal: "a momentum strategy on SOL",
    currentStrategyId: null,
    lastFinishedRunId: null,
    lastToolResult: null,
    spendSoFarUsd: 0,
    hardSpendCapUsd: 2.0,
    ...over,
  };
}

function mem(over: Partial<AutoMemory> = {}): AutoMemory {
  return { ...defaultAutoMemory(), ...over };
}

function result(over: Partial<BacktestResultDto> = {}): BacktestResultDto {
  return {
    runId: 1,
    ticker: "SOL",
    timeframe: "1h",
    rank: 1,
    netProfitPercent: 10,
    winRatePercent: 55,
    maxDrawdownPercent: 8,
    profitFactor: 1.4,
    sharpeRatio: 1.0,
    totalTrades: 40,
    params: {},
    oos: null,
    ...over,
  };
}

function topResults(results: BacktestResultDto[]): TopResultsDto {
  return { strategyId: 7, runId: 1, rankedBy: "lab_objective", results };
}

describe("auto-planner: pipeline order", () => {
  it("create phase with NO strategy asks to confirm the PAID create (never a bare tool call)", () => {
    const { decision, nextAuto } = planAutoTurn(ctx(), deps());
    expect(decision.action).toBe("await_confirm");
    if (decision.action !== "await_confirm") throw new Error("unreachable");
    expect(decision.tool).toBe("createStrategyFromText");
    expect(decision.args).toEqual({ prompt: "a momentum strategy on SOL" });
    expect(decision.estCostUsd).toBe(PAID_EST);
    // Phase does NOT advance yet — it advances only once the user confirms.
    expect(nextAuto.phase).toBe("create");
    expect(nextAuto.autoStepCount).toBe(1);
    // The planner never mints the token — the orchestrator does.
    expect(nextAuto.pendingConfirm ?? null).toBeNull();
  });

  it("create phase asks for a description when there is no goal and no strategy", () => {
    const { decision, nextAuto } = planAutoTurn(ctx({ goal: null }), deps());
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
  });

  it("create phase with an EXISTING strategy skips create and backtests directly", () => {
    const { decision, nextAuto } = planAutoTurn(ctx({ currentStrategyId: 42 }), deps());
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("runOptimization");
    expect(decision.args).toMatchObject({
      strategyId: 42,
      symbols: ["SOL", "ETH", "ARB"],
      stages: ["random", "refine", "deep"],
      outOfSampleFraction: 0.2,
    });
    expect(nextAuto.phase).toBe("evaluate");
  });

  it("backtest phase runs the multi-symbol, multi-stage optimization then evaluates", () => {
    const { decision, nextAuto } = planAutoTurn(
      ctx({ memory: mem({ phase: "backtest" }), currentStrategyId: 9 }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("runOptimization");
    expect(decision.args).toMatchObject({ strategyId: 9, stages: ["random", "refine", "deep"] });
    expect(nextAuto.phase).toBe("evaluate");
  });

  it("evaluate phase first READS the ranked results (getTopResults), staying in evaluate", () => {
    const { decision, nextAuto } = planAutoTurn(
      ctx({ memory: mem({ phase: "evaluate" }), currentStrategyId: 9, lastToolResult: null }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("getTopResults");
    expect(decision.args).toMatchObject({ strategyId: 9 });
    expect(nextAuto.phase).toBe("evaluate");
  });
});

describe("auto-planner: robustness branch", () => {
  it("a ROBUST result short-circuits to a successful final", () => {
    const robust = result({ sharpeRatio: 1.2, oos: oos(1.0) });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate" }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([robust]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
  });

  it("NO robust result continues to insights (free), advancing toward improve", () => {
    const weak = result({ sharpeRatio: 1.2, oos: null }); // unvalidated → not robust
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate" }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([weak]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("generateInsights");
    expect(nextAuto.phase).toBe("improve");
  });
});

describe("auto-planner: confirmed paid steps", () => {
  it("a confirmed create runs createStrategyFromText and advances to backtest", () => {
    const pendingConfirm = {
      tool: "createStrategyFromText" as const,
      token: "tok-1",
      estCostUsd: PAID_EST,
      args: { prompt: "x" },
    };
    const { decision, nextAuto } = planAutoTurn(
      ctx({ memory: mem({ phase: "create", pendingConfirm, confirmedToken: "tok-1" }) }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("createStrategyFromText");
    expect(nextAuto.phase).toBe("backtest");
    expect(nextAuto.pendingConfirm ?? null).toBeNull();
    expect(nextAuto.confirmedToken ?? null).toBeNull();
  });

  it("a confirmed improve runs improve, counts it, and re-evaluates", () => {
    const pendingConfirm = {
      tool: "improve" as const,
      token: "tok-2",
      estCostUsd: PAID_EST,
      args: { strategyId: 9 },
    };
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "improve", improveCount: 1, pendingConfirm, confirmedToken: "tok-2" }),
        currentStrategyId: 9,
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("improve");
    expect(nextAuto.improveCount).toBe(2);
    expect(nextAuto.phase).toBe("evaluate");
    expect(nextAuto.pendingConfirm ?? null).toBeNull();
  });

  it("a pendingConfirm whose token does NOT match is not run (waits)", () => {
    const pendingConfirm = {
      tool: "improve" as const,
      token: "tok-3",
      estCostUsd: PAID_EST,
      args: { strategyId: 9 },
    };
    const { decision } = planAutoTurn(
      ctx({
        memory: mem({ phase: "improve", improveCount: 0, pendingConfirm, confirmedToken: null }),
        currentStrategyId: 9,
      }),
      deps(),
    );
    // Falls through to the improve gate → asks to confirm again (does not run improve).
    expect(decision.action).toBe("await_confirm");
  });
});

describe("auto-planner: caps and guards", () => {
  it("improve phase asks to confirm improve while under the loop cap", () => {
    const { decision } = planAutoTurn(
      ctx({ memory: mem({ phase: "improve", improveCount: 1 }), currentStrategyId: 9 }),
      deps(),
    );
    expect(decision.action).toBe("await_confirm");
    if (decision.action !== "await_confirm") throw new Error("unreachable");
    expect(decision.tool).toBe("improve");
  });

  it("improve phase stops with a final once the improve cap is reached", () => {
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "improve", improveCount: DEFAULT_AUTO_PLANNER_LIMITS.maxImproveLoops }),
        currentStrategyId: 9,
      }),
      deps(),
    );
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
  });

  it("the autoStep cap stops the pipeline with a final", () => {
    const { decision, nextAuto } = planAutoTurn(
      ctx({ memory: mem({ phase: "backtest", autoStepCount: DEFAULT_AUTO_PLANNER_LIMITS.maxAutoSteps }), currentStrategyId: 9 }),
      deps(),
    );
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
  });

  it("the pre-spend 90% guard refuses to ask for a paid step and finals instead", () => {
    // cap=2.0, 90% = 1.8; spendSoFar 1.79 + est 0.05 = 1.84 > 1.8 → halt.
    const { decision, nextAuto } = planAutoTurn(ctx({ spendSoFarUsd: 1.79 }), deps());
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
    expect((decision as { message: string }).message).toMatch(/spend cap/i);
  });

  it("just under the 90% guard still asks to confirm", () => {
    // 1.70 + 0.05 = 1.75 < 1.8 → allowed.
    const { decision } = planAutoTurn(ctx({ spendSoFarUsd: 1.7 }), deps());
    expect(decision.action).toBe("await_confirm");
  });
});

describe("auto-planner: pickRobustResult", () => {
  it("rejects unvalidated (oos null), non-positive OOS, and collapsed OOS Sharpe", () => {
    expect(pickRobustResult([result({ oos: null })])).toBeNull();
    expect(pickRobustResult([result({ sharpeRatio: 1.0, oos: oos(0) })])).toBeNull();
    expect(pickRobustResult([result({ sharpeRatio: 2.0, oos: oos(0.5) })])).toBeNull(); // 0.5 < 0.5*2.0
  });

  it("picks the highest OOS Sharpe among robust results", () => {
    const a = result({ runId: 1, sharpeRatio: 1.0, oos: oos(0.8) });
    const b = result({ runId: 2, sharpeRatio: 1.0, oos: oos(1.3) });
    expect(pickRobustResult([a, b])?.runId).toBe(2);
  });
});

// --- helpers ---------------------------------------------------------------------

function oos(sharpe: number) {
  return {
    fraction: 0.2,
    netProfitPercent: 5,
    winRatePercent: 52,
    maxDrawdownPercent: 6,
    sharpeRatio: sharpe,
    totalTrades: 12,
  };
}
