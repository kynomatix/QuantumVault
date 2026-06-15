// QuantumLab Lab Assistant — Task #200 deterministic auto-pipeline planner.
//
// This is a PURE, LLM-free BrainFn (Architect Option B): it plugs into the SAME
// orchestrator seam the chat brain uses, but instead of asking a model it walks a
// fixed pipeline —
//
//   create → backtest (random+refine+deep across SOL/ETH/ARB) → evaluate →
//   insights → gated improve (≤3) → done
//
// Every tick returns ONE decision plus the NEXT persisted `auto` state. `usage` is
// ALWAYS undefined, so the orchestrator does NOT count a tick as a brain call or
// charge LLM spend — only the actual PAID tools (createStrategyFromText / improve)
// cost money, and those STOP with action:"await_confirm" so the user approves first.
//
// FREE steps (runOptimization, getTopResults, generateInsights) flow automatically.
// The planner is a deterministic reducer over (auto memory + observed results), so it
// is fully unit-testable with no DB and no network.

import {
  defaultAutoMemory,
  type AutoMemory,
  type AutoTurnContext,
  type BrainDecision,
  type BrainFn,
  type BrainTurnContext,
  type BrainTurnResult,
  type PaidTool,
  type WorkingTool,
} from "./chat-brain";
import type { BacktestResultDto, TopResultsDto } from "@shared/lab-agent-contract";

export const AUTO_PLANNER_MODEL = "auto-planner";

const DEFAULT_AUTO_TIMEFRAMES = ["1h", "4h"];
const DEFAULT_OOS_FRACTION = 0.2;
const TOP_RESULTS_LIMIT = 10;
/** OOS Sharpe must hold at least this fraction of in-sample Sharpe (curve-fit guard). */
const OOS_SHARPE_RETENTION = 0.5;

export interface AutoPlannerLimits {
  /** Hard cap on planner ticks for a single task (belt-and-suspenders with the orchestrator). */
  maxAutoSteps: number;
  /** Paid `improve` rewrites allowed per task. */
  maxImproveLoops: number;
  /** Refuse a paid step when spendSoFar + est would exceed this fraction of the hard cap. */
  spendCapFraction: number;
}

export const DEFAULT_AUTO_PLANNER_LIMITS: AutoPlannerLimits = {
  maxAutoSteps: 12,
  maxImproveLoops: 3,
  spendCapFraction: 0.9,
};

export interface AutoPlannerDeps {
  /** Conservative pre-call USD estimate for a paid tool (fixed token assumption × catalog price). */
  estimatePaidCostUsd: (tool: PaidTool) => number;
  limits?: Partial<AutoPlannerLimits>;
}

export interface AutoPlanResult {
  decision: BrainDecision;
  nextAuto: AutoMemory;
}

// --- pure decision helpers -------------------------------------------------------

function tool(t: WorkingTool, args: Record<string, unknown>, nextAuto: AutoMemory): AutoPlanResult {
  return { decision: { action: "tool", tool: t, args }, nextAuto };
}

function final(message: string, nextAuto: AutoMemory): AutoPlanResult {
  return { decision: { action: "final", message }, nextAuto };
}

/** The one multi-symbol, multi-stage cheap optimization the pipeline runs. */
function backtestArgs(strategyId: number, symbols: string[]): Record<string, unknown> {
  return {
    strategyId,
    symbols: symbols.length ? symbols : [...defaultAutoMemory().symbols],
    timeframes: DEFAULT_AUTO_TIMEFRAMES,
    stages: ["random", "refine", "deep"],
    outOfSampleFraction: DEFAULT_OOS_FRACTION,
  };
}

/**
 * The best OUT-OF-SAMPLE-robust result, or null if none holds up. A result counts as
 * robust only when it carried a holdout (oos != null), its OOS Sharpe is positive, and
 * that OOS Sharpe doesn't collapse versus in-sample (overfitting guard). `rankedBy` may
 * be the lab's profit-weighted objective (NOT robustness), so we scan ALL results.
 */
export function pickRobustResult(results: readonly BacktestResultDto[]): BacktestResultDto | null {
  let best: BacktestResultDto | null = null;
  for (const r of results) {
    const oos = r.oos;
    if (!oos || oos.sharpeRatio == null || oos.sharpeRatio <= 0) continue;
    if (r.sharpeRatio != null && oos.sharpeRatio < OOS_SHARPE_RETENTION * r.sharpeRatio) continue;
    const bestOos = best?.oos?.sharpeRatio ?? -Infinity;
    if (oos.sharpeRatio > bestOos) best = r;
  }
  return best;
}

function requestPaid(
  toolName: PaidTool,
  args: Record<string, unknown>,
  reason: string,
  stepped: AutoMemory,
  ctx: AutoTurnContext,
  deps: AutoPlannerDeps,
  limits: AutoPlannerLimits,
): AutoPlanResult {
  const estCostUsd = deps.estimatePaidCostUsd(toolName);
  // Pre-spend 90% guard: never even ASK to spend if approving would blow the cap.
  if (ctx.spendSoFarUsd + estCostUsd > limits.spendCapFraction * ctx.hardSpendCapUsd) {
    return final(
      `I've reached about ${Math.round(limits.spendCapFraction * 100)}% of this task's spend cap ` +
        `($${ctx.hardSpendCapUsd.toFixed(2)}), so I've stopped before the next paid step ` +
        `(est. $${estCostUsd.toFixed(2)}). Raise the cap or start a fresh task to keep going.`,
      { ...stepped, phase: "done" },
    );
  }
  return {
    decision: { action: "await_confirm", tool: toolName, args, estCostUsd, reason },
    nextAuto: stepped,
  };
}

// --- the planner -----------------------------------------------------------------

/**
 * One deterministic tick. Returns the decision to act on plus the next AutoMemory to
 * persist. Pure: no I/O, no clock — every branch is a function of (ctx, deps).
 */
export function planAutoTurn(ctx: AutoTurnContext, deps: AutoPlannerDeps): AutoPlanResult {
  const limits = { ...DEFAULT_AUTO_PLANNER_LIMITS, ...(deps.limits ?? {}) };
  const a = ctx.memory;
  const stepped: AutoMemory = { ...a, autoStepCount: a.autoStepCount + 1 };

  // Hard pipeline cap (the orchestrator also guards a little higher as a safety net).
  if (a.autoStepCount >= limits.maxAutoSteps) {
    return final(
      "I've reached the auto-run step limit for this task, so I've paused here. Review the results, " +
        "and tell me if you'd like me to keep going.",
      { ...stepped, phase: "done" },
    );
  }

  // A paid step the user already approved: run it now, clear the gate, advance phase.
  const pc = a.pendingConfirm;
  if (pc && a.confirmedToken && a.confirmedToken === pc.token) {
    const cleared: AutoMemory = { ...stepped, pendingConfirm: null, confirmedToken: null };
    if (pc.tool === "createStrategyFromText") {
      // Crash-replay guard: if a strategy already exists, the create RAN before a
      // crash cleared the confirm gate (the strategyId was stashed but the cleared
      // memory wasn't persisted). Don't pay to draft a second one — skip straight to
      // backtesting the strategy we already have. Mirrors the case "create" guard.
      if (ctx.currentStrategyId != null) {
        return tool("runOptimization", backtestArgs(ctx.currentStrategyId, a.symbols), {
          ...cleared,
          phase: "evaluate",
        });
      }
      return tool("createStrategyFromText", pc.args, { ...cleared, phase: "backtest" });
    }
    // improve: queues a fresh backtest of the rewritten strategy; count it, re-evaluate.
    return tool("improve", pc.args, {
      ...cleared,
      phase: "evaluate",
      improveCount: cleared.improveCount + 1,
    });
  }

  switch (a.phase) {
    case "create": {
      if (ctx.currentStrategyId != null) {
        // A strategy already exists — skip the paid create and go straight to backtesting.
        return tool("runOptimization", backtestArgs(ctx.currentStrategyId, a.symbols), {
          ...stepped,
          phase: "evaluate",
        });
      }
      const goal = (ctx.goal ?? "").trim();
      if (!goal) {
        return final(
          "Tell me what kind of strategy you'd like me to build (for example: a momentum strategy on SOL), " +
            "and I'll create, backtest, and refine it for you.",
          { ...stepped, phase: "done" },
        );
      }
      return requestPaid(
        "createStrategyFromText",
        { prompt: goal },
        "I'll draft a strategy from your idea using AI.",
        stepped,
        ctx,
        deps,
        limits,
      );
    }

    case "backtest": {
      if (ctx.currentStrategyId == null) {
        return final("I couldn't find a strategy to backtest, so I've stopped.", { ...stepped, phase: "done" });
      }
      return tool("runOptimization", backtestArgs(ctx.currentStrategyId, a.symbols), {
        ...stepped,
        phase: "evaluate",
      });
    }

    case "evaluate": {
      const sid = ctx.currentStrategyId;
      if (sid == null) {
        return final("No strategy to evaluate, so I've stopped.", { ...stepped, phase: "done" });
      }
      // First time through evaluate: read the ranked results. We only branch on
      // robustness once we actually hold a fresh getTopResults payload.
      if (ctx.lastToolResult?.tool !== "getTopResults") {
        return tool("getTopResults", { strategyId: sid, limit: TOP_RESULTS_LIMIT }, { ...stepped });
      }
      const top = ctx.lastToolResult.data as TopResultsDto | undefined;
      const robust = top && Array.isArray(top.results) ? pickRobustResult(top.results) : null;
      if (robust) {
        return final(
          `Found a robust configuration: ${robust.ticker} ${robust.timeframe} held up out-of-sample ` +
            `(OOS Sharpe ${robust.oos?.sharpeRatio?.toFixed(2) ?? "n/a"}). I've stopped here — it's good enough.`,
          { ...stepped, phase: "done" },
        );
      }
      // Not robust yet — surface insights (free), then consider a paid improve.
      return tool("generateInsights", { strategyId: sid }, { ...stepped, phase: "improve" });
    }

    case "insights": {
      const sid = ctx.currentStrategyId;
      if (sid == null) {
        return final("No strategy for insights, so I've stopped.", { ...stepped, phase: "done" });
      }
      return tool("generateInsights", { strategyId: sid }, { ...stepped, phase: "improve" });
    }

    case "improve": {
      const sid = ctx.currentStrategyId;
      if (sid == null) {
        return final("No strategy to improve, so I've stopped.", { ...stepped, phase: "done" });
      }
      if (a.improveCount >= limits.maxImproveLoops) {
        return final(
          `I've used all ${limits.maxImproveLoops} improvement rounds for this task without a result that ` +
            "holds up out-of-sample. I've stopped so it doesn't keep spending — tell me if you'd like a new angle.",
          { ...stepped, phase: "done" },
        );
      }
      return requestPaid(
        "improve",
        {
          strategyId: sid,
          guidance:
            "Improve out-of-sample robustness: reduce overfitting and steady the Sharpe and drawdown " +
            "based on the latest insights.",
        },
        "I'll rewrite the strategy with AI to chase better out-of-sample robustness.",
        stepped,
        ctx,
        deps,
        limits,
      );
    }

    case "done":
    default:
      return final("This auto run is finished.", { ...stepped, phase: "done" });
  }
}

/**
 * Wrap the pure planner as a BrainFn for the orchestrator. `usage` is undefined so the
 * orchestrator treats the tick as free (no loop_count bump, no LLM spend).
 */
export function createAutoPlanner(deps: AutoPlannerDeps): BrainFn {
  return async (ctx: BrainTurnContext): Promise<BrainTurnResult> => {
    if (!ctx.auto) {
      // Defensive: the route only wires this planner for auto-mode tasks.
      return { decision: { action: "final", message: "Auto mode isn't set up for this task." }, model: AUTO_PLANNER_MODEL };
    }
    const { decision, nextAuto } = planAutoTurn(ctx.auto, deps);
    return { decision, auto: nextAuto, usage: undefined, model: AUTO_PLANNER_MODEL };
  };
}
