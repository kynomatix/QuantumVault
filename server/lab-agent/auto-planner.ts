// QuantumLab Lab Assistant — Task #200 deterministic auto-pipeline planner.
//
// This is a PURE, LLM-free BrainFn (Architect Option B): it plugs into the SAME
// orchestrator seam the chat brain uses, but instead of asking a model it walks a
// fixed pipeline —
//
//   create → prove on SOL (random+refine+deep) → evaluate → graduate to ETH/ARB →
//   evaluate → insights → gated improve (≤3) → done
//
// SOL-first: rather than averaging a strategy across SOL/ETH/ARB in one run (which can
// bury a SOL-specific edge), the pipeline PROVES it on the primary symbol first and only
// GRADUATES to the wider basket once it holds up out-of-sample on SOL.
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
import { buildStyledPrompt, matchStyleInText, styleById } from "./strategy-styles";
import type { BacktestResultDto, TopResultsDto } from "@shared/lab-agent-contract";

export const AUTO_PLANNER_MODEL = "auto-planner";

const DEFAULT_AUTO_TIMEFRAMES = ["1h", "2h", "4h"];
const DEFAULT_OOS_FRACTION = 0.2;
const TOP_RESULTS_LIMIT = 10;
/** OOS Sharpe must hold at least this fraction of in-sample Sharpe (curve-fit guard). */
const OOS_SHARPE_RETENTION = 0.5;
/** Degen success floor: a result must clear this after-leverage return to count as a win. */
const MIN_DEGEN_LEVERAGED_RETURN_PCT = 1000;
/** Degen success floor: enough trades that the bot fills often, not a handful over years. */
const MIN_DEGEN_TRADES = 30;

export interface AutoPlannerLimits {
  /** Hard cap on planner ticks for a single task (belt-and-suspenders with the orchestrator). */
  maxAutoSteps: number;
  /** Paid `improve` rewrites allowed per task. */
  maxImproveLoops: number;
  /** Refuse a paid step when spendSoFar + est would exceed this fraction of the hard cap. */
  spendCapFraction: number;
}

export const DEFAULT_AUTO_PLANNER_LIMITS: AutoPlannerLimits = {
  // Bumped to absorb the SOL-first graduation leg. The longest graceful path is "not robust
  // until the 3rd improve, then it graduates": 3 improve loops + a graduation leg
  // (runOptimization → getTopResults → evaluate). The async runOptimization CLEARS
  // autoLastTool, so the graduated stage must re-fetch fresh results before its verdict —
  // that final evaluate lands at entry autoStepCount 18, so this must sit at/above 19 or the
  // nuanced "generalized / SOL-specific" verdict degrades to a generic "step limit". Stays
  // below the orchestrator's net (20) so the planner's own graceful final still fires first.
  maxAutoSteps: 19,
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

/** Park on the create-phase style gate: ask the user which KIND of strategy to build and
 *  wait for a pick. Pre-detects a style from the goal text for a one-tap confirm. Used by
 *  the create phase AND the confirm-replay path so a paid draft can NEVER run before a
 *  style is chosen (fail closed). */
function styleGate(goal: string, nextAuto: AutoMemory): AutoPlanResult {
  const detectedStyleId = matchStyleInText(goal);
  const detected = styleById(detectedStyleId);
  const message = detected
    ? `It sounds like you want a ${detected.label.toLowerCase()} strategy. ` +
      "Pick it below to confirm, or choose a different style first."
    : "Before I build it, what kind of strategy should I create? Pick one below to get started.";
  return {
    decision: { action: "await_style", message, detectedStyleId },
    nextAuto: { ...nextAuto, awaitingStyle: true },
  };
}

/** The full target basket, normalized so a malformed/empty memory still yields a usable
 *  SOL-first flow. An empty/corrupt list falls back to the DEFAULT basket — which is itself
 *  SOL-first (proving still scopes to SOL, then graduates to the rest), so this is the
 *  intended default, not a silent "widen to everything". Non-string entries from a corrupted
 *  persisted blob are dropped so downstream `.toUpperCase()` can never throw. */
function basketOf(a: AutoMemory): string[] {
  const clean = Array.isArray(a.symbols)
    ? a.symbols.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  return clean.length ? clean : [...defaultAutoMemory().symbols];
}

/** The single symbol the pipeline PROVES on first — prefer SOL, else the basket's first. */
function provingSymbol(a: AutoMemory): string {
  const basket = basketOf(a);
  return basket.includes("SOL") ? "SOL" : basket[0];
}

/** SOL-first stage 1: backtest only the proving symbol. */
function provingSymbols(a: AutoMemory): string[] {
  return [provingSymbol(a)];
}

/** SOL-first stage 2: the remaining symbols we graduate to once the proving symbol holds up. */
function graduationSymbols(a: AutoMemory): string[] {
  const primary = provingSymbol(a);
  return basketOf(a).filter((s) => s !== primary);
}

/** Results restricted to a symbol set (ticker match, case-insensitive). getTopResults spans
 *  ALL runs of the strategy, so we scope each stage's robustness check to its own symbols. */
function resultsForSymbols(
  results: readonly BacktestResultDto[],
  symbols: string[],
): BacktestResultDto[] {
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  return results.filter((r) => want.has((r.ticker ?? "").toUpperCase()));
}

function oosSharpeText(r: BacktestResultDto): string {
  return r.oos?.sharpeRatio?.toFixed(2) ?? "n/a";
}

/** One stage's cheap multi-stage optimization over an explicit symbol set. `excludeTested`
 *  is set on the graduation/widen step so the adapter drops any market already covered for
 *  this strategy (no-overlap), never re-running ground the proving stage already walked. */
function backtestArgs(strategyId: number, symbols: string[], excludeTested = false): Record<string, unknown> {
  return {
    strategyId,
    symbols: symbols.length ? symbols : [...defaultAutoMemory().symbols],
    timeframes: DEFAULT_AUTO_TIMEFRAMES,
    stages: ["random", "refine", "deep"],
    outOfSampleFraction: DEFAULT_OOS_FRACTION,
    ...(excludeTested ? { excludeTestedTickers: true } : {}),
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

/**
 * The best DEGEN result, or null if none clears the bar. The degen path is the user's
 * deliberate choice to chase raw upside, so it does NOT gate on out-of-sample Sharpe (that
 * is the SAFE path). It requires a big after-leverage return AND enough trades, then ranks
 * by after-leverage profit, which already rewards low drawdown because suggestedLeverage is
 * sized from drawdown. Ties break toward the lower drawdown.
 */
export function pickDegenResult(
  results: readonly BacktestResultDto[],
  opts: { minLeveragedReturnPct?: number; minTrades?: number } = {},
): BacktestResultDto | null {
  const minReturn = opts.minLeveragedReturnPct ?? MIN_DEGEN_LEVERAGED_RETURN_PCT;
  const minTrades = opts.minTrades ?? MIN_DEGEN_TRADES;
  let best: BacktestResultDto | null = null;
  for (const r of results) {
    // Negated form so a missing / NaN field is skipped, never treated as a qualifier.
    if (!(r.leveragedNetProfitPercent >= minReturn)) continue;
    if (!(r.totalTrades >= minTrades)) continue;
    if (best == null) {
      best = r;
    } else if (r.leveragedNetProfitPercent > best.leveragedNetProfitPercent) {
      best = r;
    } else if (
      r.leveragedNetProfitPercent === best.leveragedNetProfitPercent &&
      r.maxDrawdownPercent < best.maxDrawdownPercent
    ) {
      best = r;
    }
  }
  return best;
}

/** The success pick for a run's chosen path: degen chases after-leverage upside, safe
 *  chases out-of-sample robustness. Unset memory defaults to safe (back-compat). */
function pickForProfile(
  results: readonly BacktestResultDto[],
  profile: AutoMemory["successProfile"],
): BacktestResultDto | null {
  return profile === "degen" ? pickDegenResult(results) : pickRobustResult(results);
}

/** One-line description of WHY a result won, in the language of the chosen path. */
function successText(r: BacktestResultDto, profile: AutoMemory["successProfile"]): string {
  if (profile === "degen") {
    return (
      `${Math.round(r.leveragedNetProfitPercent)}% after leverage over ${r.totalTrades} trades ` +
      `(max drawdown ${r.maxDrawdownPercent.toFixed(1)}%)`
    );
  }
  return `OOS Sharpe ${oosSharpeText(r)}`;
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
        return tool("runOptimization", backtestArgs(ctx.currentStrategyId, provingSymbols(cleared)), {
          ...cleared,
          phase: "evaluate",
          graduated: false,
        });
      }
      // Fail closed: a confirmed create with no chosen style can only come from
      // legacy/in-flight memory written before the style gate existed. Never draft
      // blindly. Drop the stale confirm and ask which KIND to build first.
      if (!a.style) {
        return styleGate((ctx.goal ?? "").trim(), cleared);
      }
      return tool("createStrategyFromText", pc.args, { ...cleared, phase: "backtest", graduated: false });
    }
    // improve: queues a fresh backtest of the rewritten strategy; count it, re-evaluate.
    // The improved strategy is a fresh contender → re-prove on the primary symbol first
    // (improve mirrors the base run's SOL-only scope), so reset the graduation gate.
    return tool("improve", pc.args, {
      ...cleared,
      phase: "evaluate",
      improveCount: cleared.improveCount + 1,
      graduated: false,
    });
  }

  switch (a.phase) {
    case "create": {
      if (ctx.currentStrategyId != null) {
        // A strategy already exists — skip the paid create and go straight to PROVING it
        // on the primary symbol (SOL-first).
        return tool("runOptimization", backtestArgs(ctx.currentStrategyId, provingSymbols(stepped)), {
          ...stepped,
          phase: "evaluate",
          graduated: false,
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
      // Style gate: before drafting a NEW strategy, ask the user which KIND to build and
      // wait for them to pick. This fires in BOTH watched and hands-off mode (choosing a
      // direction is not a spend, so there's deliberately no hands-off bypass). Once
      // `style` is set (by the style chip route), fold it into the create prompt and
      // proceed to the paid draft.
      if (!a.style) {
        return styleGate(goal, stepped);
      }
      const styleLabel = (styleById(a.style)?.label ?? "custom").toLowerCase();
      return requestPaid(
        "createStrategyFromText",
        { prompt: buildStyledPrompt(goal, a.style) },
        `I'll draft a ${styleLabel} strategy from your idea using AI.`,
        { ...stepped, awaitingStyle: false },
        ctx,
        deps,
        limits,
      );
    }

    case "backtest": {
      if (ctx.currentStrategyId == null) {
        return final("I couldn't find a strategy to backtest, so I've stopped.", { ...stepped, phase: "done" });
      }
      // SOL-first: prove the strategy on the primary symbol before widening the basket.
      return tool("runOptimization", backtestArgs(ctx.currentStrategyId, provingSymbols(stepped)), {
        ...stepped,
        phase: "evaluate",
        graduated: false,
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
      const allResults = top && Array.isArray(top.results) ? top.results : [];
      const proving = provingSymbols(a);
      const graduation = graduationSymbols(a);
      const profile = a.successProfile;

      if (!a.graduated) {
        // STAGE 1 PROVING: does it clear the chosen bar on the primary symbol?
        const winProving = pickForProfile(resultsForSymbols(allResults, proving), profile);
        if (winProving) {
          // Widen to the rest of the basket to see if the edge generalizes, but only if
          // there's somewhere new to widen to. If every graduation market is already
          // backtested for this strategy (widenExhausted, set by the orchestrator when the
          // widen run came back "every market already tested"), re-issuing the same widen
          // just fails forever, so evaluate the coverage we already have instead.
          if (graduation.length > 0 && !a.widenExhausted) {
            return tool("runOptimization", backtestArgs(sid, graduation, true), {
              ...stepped,
              phase: "evaluate",
              graduated: true,
            });
          }
          if (a.widenExhausted) {
            const winGrad = pickForProfile(resultsForSymbols(allResults, graduation), profile);
            if (winGrad) {
              return final(
                `Proved out on ${winProving.ticker} ${winProving.timeframe}. The other markets are ` +
                  `already backtested for this strategy, and ${winGrad.ticker} ${winGrad.timeframe} ` +
                  `clears the bar too (${successText(winGrad, profile)}). I've stopped here.`,
                { ...stepped, phase: "done" },
              );
            }
            return final(
              `Proved out on ${winProving.ticker} ${winProving.timeframe}: ${successText(winProving, profile)}. ` +
                "Every other market I'd widen to is already backtested for this strategy, so this is the one " +
                "to use. I've stopped here.",
              { ...stepped, phase: "done" },
            );
          }
          // Nothing to widen to: the proving result IS the deliverable.
          return final(
            `Proved out on ${winProving.ticker} ${winProving.timeframe}: ${successText(winProving, profile)}. ` +
              "I've stopped here, it's good enough.",
            { ...stepped, phase: "done" },
          );
        }
        // Not good enough on the proving symbol yet: surface insights (free), then improve.
        return tool("generateInsights", { strategyId: sid }, { ...stepped, phase: "improve" });
      }

      // STAGE 2 GRADUATED: did it hold up on the wider basket too?
      const winGrad = pickForProfile(resultsForSymbols(allResults, graduation), profile);
      if (winGrad) {
        return final(
          `Proved out on ${proving[0]} first, then it generalized: ${winGrad.ticker} ` +
            `${winGrad.timeframe} also cleared the bar (${successText(winGrad, profile)}). I've stopped here.`,
          { ...stepped, phase: "done" },
        );
      }
      const winProving = pickForProfile(resultsForSymbols(allResults, proving), profile);
      if (winProving) {
        return final(
          `It cleared the bar on ${winProving.ticker} ${winProving.timeframe} ` +
            `(${successText(winProving, profile)}) but not on the other markets (${graduation.join("/")}), ` +
            `so treat it as ${winProving.ticker}-specific. I've stopped here.`,
          { ...stepped, phase: "done" },
        );
      }
      // Defensive: we only widen after a strong proving result, so reaching here means the
      // proving evidence vanished (e.g. dedup across runs). Stop honestly.
      return final(
        profile === "degen"
          ? "I ran the backtests but couldn't find a result that clears your after-leverage target, so I've stopped."
          : "I ran the backtests but couldn't confirm a result that holds up out-of-sample, so I've stopped.",
        { ...stepped, phase: "done" },
      );
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
          a.successProfile === "degen"
            ? `I've used all ${limits.maxImproveLoops} improvement rounds for this task without clearing your ` +
                "after-leverage target. I've stopped so it doesn't keep spending, tell me if you'd like a new angle."
            : `I've used all ${limits.maxImproveLoops} improvement rounds for this task without a result that ` +
                "holds up out-of-sample. I've stopped so it doesn't keep spending, tell me if you'd like a new angle.",
          { ...stepped, phase: "done" },
        );
      }
      return requestPaid(
        "improve",
        {
          strategyId: sid,
          guidance:
            a.successProfile === "degen"
              ? "Push for the biggest after-leverage profit with the lowest drawdown and enough trades to fill " +
                "often, based on the latest insights."
              : "Improve out-of-sample robustness: reduce overfitting and steady the Sharpe and drawdown " +
                "based on the latest insights.",
        },
        a.successProfile === "degen"
          ? "I'll rewrite the strategy with AI to chase a bigger after-leverage return."
          : "I'll rewrite the strategy with AI to chase better out-of-sample robustness.",
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
