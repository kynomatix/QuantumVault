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
  pickDegenResult,
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
    resultId: 100,
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
    suggestedLeverage: 5,
    leveragedNetProfitPercent: 50,
    robustnessScore: 0.5,
    robustnessRank: 1,
    params: {},
    oos: null,
    ...over,
  };
}

function topResults(results: BacktestResultDto[]): TopResultsDto {
  return { strategyId: 7, runId: 1, rankedBy: "lab_objective", results };
}

describe("auto-planner: pipeline order", () => {
  it("create phase with NO style FIRST asks which KIND of strategy (style gate), never a paid step", () => {
    const { decision, nextAuto } = planAutoTurn(ctx(), deps());
    expect(decision.action).toBe("await_style");
    if (decision.action !== "await_style") throw new Error("unreachable");
    // The goal mentions momentum, so the trend style is pre-detected for a one-tap confirm.
    expect(decision.detectedStyleId).toBe("trend");
    expect(decision.message.length).toBeGreaterThan(0);
    // Parked awaiting the pick: no phase advance, no paid step queued yet.
    expect(nextAuto.phase).toBe("create");
    expect(nextAuto.awaitingStyle).toBe(true);
    expect(nextAuto.autoStepCount).toBe(1);
  });

  it("style gate with a generic goal detects no style (open question, no pre-pick)", () => {
    const { decision } = planAutoTurn(ctx({ goal: "make me money on SOL" }), deps());
    expect(decision.action).toBe("await_style");
    if (decision.action !== "await_style") throw new Error("unreachable");
    expect(decision.detectedStyleId ?? null).toBeNull();
  });

  it("create phase with a CHOSEN style asks to confirm the PAID create, folding the style into the prompt", () => {
    const { decision, nextAuto } = planAutoTurn(ctx({ memory: mem({ style: "breakout" }) }), deps());
    expect(decision.action).toBe("await_confirm");
    if (decision.action !== "await_confirm") throw new Error("unreachable");
    expect(decision.tool).toBe("createStrategyFromText");
    const prompt = String((decision.args as { prompt: string }).prompt);
    expect(prompt).toContain("a momentum strategy on SOL"); // original goal preserved
    expect(prompt.toLowerCase()).toContain("breakout"); // chosen style folded in
    expect(decision.estCostUsd).toBe(PAID_EST);
    // Phase does NOT advance yet — it advances only once the user confirms.
    expect(nextAuto.phase).toBe("create");
    expect(nextAuto.awaitingStyle).toBe(false);
    expect(nextAuto.autoStepCount).toBe(1);
    // The planner never mints the token — the orchestrator does.
    expect(nextAuto.pendingConfirm ?? null).toBeNull();
  });

  it("a confirmed PAID create with NO style re-asks the style gate (fail closed, never drafts blindly)", () => {
    // Legacy/in-flight memory: an approved create confirm but no style was ever chosen
    // (e.g. memory written before the style gate existed). The replay path must NOT draft.
    const auto = mem({
      phase: "create",
      style: null,
      pendingConfirm: { tool: "createStrategyFromText", token: "tok-1", estCostUsd: PAID_EST, args: { prompt: "x" } },
      confirmedToken: "tok-1",
    });
    const { decision, nextAuto } = planAutoTurn(ctx({ memory: auto, currentStrategyId: null }), deps());
    expect(decision.action).toBe("await_style");
    // The stale confirm is dropped so it can never run on a later tick.
    expect(nextAuto.pendingConfirm ?? null).toBeNull();
    expect(nextAuto.confirmedToken ?? null).toBeNull();
    expect(nextAuto.awaitingStyle).toBe(true);
  });

  it("create phase asks for a description when there is no goal and no strategy", () => {
    const { decision, nextAuto } = planAutoTurn(ctx({ goal: null }), deps());
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
  });

  it("create phase with an EXISTING strategy skips create and PROVES on SOL first", () => {
    const { decision, nextAuto } = planAutoTurn(ctx({ currentStrategyId: 42 }), deps());
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("runOptimization");
    expect(decision.args).toMatchObject({
      strategyId: 42,
      symbols: ["SOL"],
      timeframes: ["1h", "2h", "4h"],
      stages: ["random", "refine", "deep"],
      outOfSampleFraction: 0.2,
    });
    expect(nextAuto.phase).toBe("evaluate");
    expect(nextAuto.graduated).toBe(false);
  });

  it("backtest phase PROVES on SOL only (1h/2h/4h) then evaluates", () => {
    const { decision, nextAuto } = planAutoTurn(
      ctx({ memory: mem({ phase: "backtest" }), currentStrategyId: 9 }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("runOptimization");
    expect(decision.args).toMatchObject({
      strategyId: 9,
      symbols: ["SOL"],
      timeframes: ["1h", "2h", "4h"],
      stages: ["random", "refine", "deep"],
    });
    expect(nextAuto.phase).toBe("evaluate");
    expect(nextAuto.graduated).toBe(false);
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
  it("a ROBUST result on SOL GRADUATES to the rest of the basket (ETH/ARB)", () => {
    const robust = result({ ticker: "SOL", sharpeRatio: 1.2, oos: oos(1.0) });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        // Pin the basket so the graduation set is exactly ETH/ARB (the default basket is wider).
        memory: mem({ phase: "evaluate", graduated: false, symbols: ["SOL", "ETH", "ARB"] }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([robust]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("runOptimization");
    expect(decision.args).toMatchObject({ strategyId: 9, symbols: ["ETH", "ARB"] });
    expect(nextAuto.phase).toBe("evaluate");
    expect(nextAuto.graduated).toBe(true);
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

describe("auto-planner: SOL-first graduation", () => {
  it("PROVING: a robust SOL result with a single-symbol basket finals (nothing to graduate to)", () => {
    const robust = result({ ticker: "SOL", sharpeRatio: 1.2, oos: oos(1.0) });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: false, symbols: ["SOL"] }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([robust]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
  });

  it("PROVING is scoped to SOL: a robust ETH row does NOT count while proving", () => {
    const weakSol = result({ ticker: "SOL", sharpeRatio: 1.2, oos: null });
    const robustEth = result({ ticker: "ETH", sharpeRatio: 1.2, oos: oos(1.0) });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: false }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([weakSol, robustEth]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("generateInsights");
    expect(nextAuto.phase).toBe("improve");
  });

  it("GRADUATED: a robust graduation result finals as 'generalized'", () => {
    const robustSol = result({ ticker: "SOL", sharpeRatio: 1.0, oos: oos(0.8) });
    const robustEth = result({ ticker: "ETH", timeframe: "2h", sharpeRatio: 1.0, oos: oos(0.9) });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: true }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([robustSol, robustEth]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("final");
    if (decision.action !== "final") throw new Error("unreachable");
    expect(decision.message).toMatch(/generalized/i);
    expect(nextAuto.phase).toBe("done");
  });

  it("GRADUATED: SOL robust but ETH/ARB not robust → finals as SOL-specific (no improve)", () => {
    const robustSol = result({ ticker: "SOL", sharpeRatio: 1.0, oos: oos(0.8) });
    const weakEth = result({ ticker: "ETH", sharpeRatio: 1.0, oos: null });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: true }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([robustSol, weakEth]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("final");
    if (decision.action !== "final") throw new Error("unreachable");
    expect(decision.message).toMatch(/SOL-specific/i);
    expect(nextAuto.phase).toBe("done");
  });

  it("an empty/malformed basket falls back to proving on SOL (never widens to all symbols)", () => {
    const { decision } = planAutoTurn(
      ctx({ memory: mem({ phase: "backtest", symbols: [] }), currentStrategyId: 9 }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.args).toMatchObject({ symbols: ["SOL"] });
  });

  it("a basket with non-string junk is sanitized — proves on the clean symbol, never throws", () => {
    const { decision } = planAutoTurn(
      ctx({
        memory: mem({ phase: "backtest", symbols: [null as unknown as string, 123 as unknown as string, "SOL"] }),
        currentStrategyId: 9,
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.args).toMatchObject({ symbols: ["SOL"] });
  });

  it("GRADUATED graduation leg re-fetches, then yields the nuanced verdict AT the cap boundary", () => {
    // Regression (off-by-one). The longest graceful path proves on SOL only after the LAST
    // improve, then graduates: runOptimization(ETH/ARB) → getTopResults → evaluate. Because
    // the async runOptimization CLEARS autoLastTool, the graduated stage must FIRST re-fetch
    // (tick A) and the nuanced verdict only lands on the NEXT tick (tick B), at the boundary
    // autoStepCount the real pipeline reaches (18). The cap must leave room for that final
    // evaluate or it degrades to a generic "step limit" message.

    // Tick A — graduated but no fresh results yet (autoLastTool was cleared by the async run):
    // must RE-FETCH getTopResults, never hand down a verdict on stale pre-run data.
    const fetchAgain = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: true, autoStepCount: 17 }),
        currentStrategyId: 9,
        lastToolResult: null,
      }),
      deps(),
    ).decision;
    expect(fetchAgain.action).toBe("tool");
    if (fetchAgain.action !== "tool") throw new Error("unreachable");
    expect(fetchAgain.tool).toBe("getTopResults");

    // Tick B — at the boundary count (18) with the fresh graduated results in hand: the
    // nuanced "generalized" verdict must fire, NOT the step-limit fallback.
    const robustSol = result({ ticker: "SOL", sharpeRatio: 1.0, oos: oos(0.8) });
    const robustEth = result({ ticker: "ETH", timeframe: "2h", sharpeRatio: 1.0, oos: oos(0.9) });
    const verdict = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: true, autoStepCount: 18 }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([robustSol, robustEth]) },
      }),
      deps(),
    ).decision;
    expect(verdict.action).toBe("final");
    if (verdict.action !== "final") throw new Error("unreachable");
    expect(verdict.message).toMatch(/generalized/i);
    expect(verdict.message).not.toMatch(/step limit/i);
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
      // style chosen earlier: a confirmed create only ever exists after the style gate.
      ctx({ memory: mem({ phase: "create", style: "trend", pendingConfirm, confirmedToken: "tok-1" }) }),
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
    const { decision, nextAuto } = planAutoTurn(ctx({ spendSoFarUsd: 1.79, memory: mem({ style: "trend" }) }), deps());
    expect(decision.action).toBe("final");
    expect(nextAuto.phase).toBe("done");
    expect((decision as { message: string }).message).toMatch(/spend cap/i);
  });

  it("just under the 90% guard still asks to confirm", () => {
    // 1.70 + 0.05 = 1.75 < 1.8 → allowed.
    const { decision } = planAutoTurn(ctx({ spendSoFarUsd: 1.7, memory: mem({ style: "trend" }) }), deps());
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

describe("auto-planner: degen success profile", () => {
  it("a robust but SUB-target result (800% after leverage) is NOT good enough (keeps improving)", () => {
    const subTarget = result({
      ticker: "SOL",
      sharpeRatio: 1.2,
      oos: oos(1.0),
      leveragedNetProfitPercent: 800,
      totalTrades: 60,
    });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: false, successProfile: "degen", symbols: ["SOL", "ETH"] }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([subTarget]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("generateInsights");
    expect(nextAuto.phase).toBe("improve");
  });

  it("a STRONG result (1200% after leverage, enough trades) GRADUATES to more coins (no OOS needed)", () => {
    const strong = result({
      ticker: "SOL",
      leveragedNetProfitPercent: 1200,
      totalTrades: 80,
      oos: null, // degen does NOT require out-of-sample
    });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: false, successProfile: "degen", symbols: ["SOL", "ETH", "AVAX"] }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([strong]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("runOptimization");
    expect(decision.args).toMatchObject({ symbols: ["ETH", "AVAX"] });
    expect(nextAuto.graduated).toBe(true);
  });

  it("a huge return with too FEW trades (3000% over 10 trades) is NOT good enough (keeps improving)", () => {
    const fewTrades = result({
      ticker: "SOL",
      leveragedNetProfitPercent: 3000,
      totalTrades: 10,
      oos: null,
    });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: false, successProfile: "degen", symbols: ["SOL", "ETH"] }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([fewTrades]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("tool");
    if (decision.action !== "tool") throw new Error("unreachable");
    expect(decision.tool).toBe("generateInsights");
    expect(nextAuto.phase).toBe("improve");
  });

  it("degen STOPS on a strong single-symbol basket with the after-leverage verdict (not OOS)", () => {
    const strong = result({
      ticker: "SOL",
      leveragedNetProfitPercent: 1500,
      totalTrades: 50,
      oos: null,
    });
    const { decision, nextAuto } = planAutoTurn(
      ctx({
        memory: mem({ phase: "evaluate", graduated: false, successProfile: "degen", symbols: ["SOL"] }),
        currentStrategyId: 9,
        lastToolResult: { tool: "getTopResults", data: topResults([strong]) },
      }),
      deps(),
    );
    expect(decision.action).toBe("final");
    if (decision.action !== "final") throw new Error("unreachable");
    expect(decision.message).toMatch(/after leverage/i);
    expect(nextAuto.phase).toBe("done");
  });
});

describe("auto-planner: pickDegenResult", () => {
  it("requires BOTH the after-leverage return floor AND enough trades", () => {
    expect(pickDegenResult([result({ leveragedNetProfitPercent: 800, totalTrades: 100 })])).toBeNull();
    expect(pickDegenResult([result({ leveragedNetProfitPercent: 5000, totalTrades: 5 })])).toBeNull();
    expect(pickDegenResult([result({ leveragedNetProfitPercent: 1000, totalTrades: 30 })])).not.toBeNull();
  });

  it("picks the highest after-leverage return among qualifiers", () => {
    const a = result({ runId: 1, leveragedNetProfitPercent: 1200, totalTrades: 40 });
    const b = result({ runId: 2, leveragedNetProfitPercent: 2500, totalTrades: 40 });
    expect(pickDegenResult([a, b])?.runId).toBe(2);
  });

  it("breaks a tie toward the LOWER drawdown", () => {
    const a = result({ runId: 1, leveragedNetProfitPercent: 1500, totalTrades: 40, maxDrawdownPercent: 20 });
    const b = result({ runId: 2, leveragedNetProfitPercent: 1500, totalTrades: 40, maxDrawdownPercent: 9 });
    expect(pickDegenResult([a, b])?.runId).toBe(2);
  });

  it("does NOT require out-of-sample data (unlike the safe path)", () => {
    expect(
      pickDegenResult([result({ leveragedNetProfitPercent: 1500, totalTrades: 50, oos: null })]),
    ).not.toBeNull();
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
