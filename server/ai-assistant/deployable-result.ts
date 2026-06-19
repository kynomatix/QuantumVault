import type { BacktestResultDto } from "@shared/lab-agent-contract";
import { pickDegenResult, pickRobustResult } from "../lab-agent/auto-planner";

// The best result the agent has produced for the current strategy, enough for the
// dock to render a real result card + a Deploy button (which only OPENS the deploy
// modal; it never auto-deploys, this is a money path). Headline numbers ONLY (no
// trades / equityCurve); the dock fetches the full result row on demand for the
// leverage math. `status`: "ready" (a finished result exists), "pending" (a run is
// in flight, none yet), "unavailable" (nothing to deploy).
export type AutoDeployableResultView = {
  status: "ready" | "pending" | "unavailable";
  strategyId: number;
  bestResultId: number | null;
  runId: number | null;
  ticker: string | null;
  timeframe: string | null;
  netProfitPercent: number | null;
  maxDrawdownPercent: number | null;
  winRatePercent: number | null;
  oosSharpe: number | null;
};

function emptyView(
  strategyId: number,
  status: "pending" | "unavailable",
): AutoDeployableResultView {
  return {
    status,
    strategyId,
    bestResultId: null,
    runId: null,
    ticker: null,
    timeframe: null,
    netProfitPercent: null,
    maxDrawdownPercent: null,
    winRatePercent: null,
    oosSharpe: null,
  };
}

/**
 * Pick the result the dock should offer to deploy and shape it into the DTO view.
 *
 * Preference order mirrors the SAME success lens the auto-planner used for this run
 * (safe = out-of-sample robust; degen = biggest after-leverage profit). Only when NO
 * result clears that bar do we fall back to the lab's top-ranked result (results[0]) so
 * the card is never empty when a run produced something; the dock still shows that
 * result honestly at post-leverage numbers.
 *
 * When there's no result at all: "pending" if a run is in flight (one is coming),
 * else "unavailable".
 */
export function selectDeployableResult(
  results: readonly BacktestResultDto[],
  opts: { strategyId: number; runActive: boolean; profile?: "safe" | "degen" | null },
): AutoDeployableResultView {
  // Match the success lens the auto-planner used for THIS run so the dock card agrees
  // with what the agent called a win. Degen prefers the biggest after-leverage result
  // (falling back to a robust one); safe prefers the out-of-sample-robust result. Both
  // fall back to the lab's top-ranked result so the card is never empty.
  const best =
    (opts.profile === "degen"
      ? pickDegenResult(results) ?? pickRobustResult(results)
      : pickRobustResult(results)) ?? (results.length > 0 ? results[0] : null);
  if (!best) {
    return emptyView(opts.strategyId, opts.runActive ? "pending" : "unavailable");
  }
  return {
    status: "ready",
    strategyId: opts.strategyId,
    bestResultId: best.resultId,
    runId: best.runId,
    ticker: best.ticker,
    timeframe: best.timeframe,
    netProfitPercent: best.netProfitPercent,
    maxDrawdownPercent: best.maxDrawdownPercent,
    winRatePercent: best.winRatePercent,
    oosSharpe: best.oos?.sharpeRatio ?? null,
  };
}
