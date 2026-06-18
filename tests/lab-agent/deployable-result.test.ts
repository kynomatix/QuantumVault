import { describe, it, expect } from "vitest";
import type { BacktestResultDto, OosSummaryDto } from "@shared/lab-agent-contract";
import { selectDeployableResult } from "../../server/ai-assistant/deployable-result";

function oos(over: Partial<OosSummaryDto> = {}): OosSummaryDto {
  return {
    fraction: 0.3,
    netProfitPercent: 20,
    winRatePercent: 55,
    maxDrawdownPercent: 10,
    sharpeRatio: 1.5,
    totalTrades: 30,
    ...over,
  };
}

function result(over: Partial<BacktestResultDto> = {}): BacktestResultDto {
  return {
    resultId: 1,
    runId: 100,
    ticker: "SOL-PERP",
    timeframe: "1h",
    rank: 1,
    netProfitPercent: 40,
    winRatePercent: 60,
    maxDrawdownPercent: 12,
    profitFactor: 1.8,
    sharpeRatio: 2,
    totalTrades: 50,
    params: {},
    oos: null,
    ...over,
  };
}

describe("selectDeployableResult", () => {
  it("returns status=ready for a robust (OOS-held-up) result", () => {
    const robust = result({ resultId: 7, runId: 101, sharpeRatio: 2, oos: oos({ sharpeRatio: 1.5 }) });
    const view = selectDeployableResult([robust], { strategyId: 9, runActive: false });
    expect(view.status).toBe("ready");
    expect(view.strategyId).toBe(9);
    expect(view.bestResultId).toBe(7);
    expect(view.runId).toBe(101);
    expect(view.ticker).toBe("SOL-PERP");
    expect(view.netProfitPercent).toBe(40);
    expect(view.maxDrawdownPercent).toBe(12);
    expect(view.winRatePercent).toBe(60);
    expect(view.oosSharpe).toBe(1.5);
  });

  it("prefers the OOS-robust result over a higher-profit unvalidated one", () => {
    const flashy = result({ resultId: 1, netProfitPercent: 999, oos: null }); // no holdout = unvalidated
    const robust = result({ resultId: 2, netProfitPercent: 40, sharpeRatio: 2, oos: oos({ sharpeRatio: 1.2 }) });
    const view = selectDeployableResult([flashy, robust], { strategyId: 3, runActive: false });
    expect(view.status).toBe("ready");
    expect(view.bestResultId).toBe(2);
    expect(view.oosSharpe).toBe(1.2);
  });

  it("falls back to the top-ranked result when NONE held up out-of-sample", () => {
    const top = result({ resultId: 5, rank: 1, oos: null });
    const other = result({ resultId: 6, rank: 2, oos: null });
    const view = selectDeployableResult([top, other], { strategyId: 4, runActive: false });
    expect(view.status).toBe("ready");
    expect(view.bestResultId).toBe(5);
    expect(view.oosSharpe).toBeNull();
  });

  it("returns status=pending when there are no results but a run is active", () => {
    const view = selectDeployableResult([], { strategyId: 2, runActive: true });
    expect(view.status).toBe("pending");
    expect(view.strategyId).toBe(2);
    expect(view.bestResultId).toBeNull();
    expect(view.oosSharpe).toBeNull();
  });

  it("returns status=unavailable when there are no results and no active run", () => {
    const view = selectDeployableResult([], { strategyId: 2, runActive: false });
    expect(view.status).toBe("unavailable");
    expect(view.bestResultId).toBeNull();
  });
});
