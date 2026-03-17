import { generateInsightsReport, type StrategyInsightsReport } from "@/lib/strategy-insights";
import { safeResponseJson } from "@/lib/safe-fetch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { LabPineInput, LabOptResult } from "@shared/schema";

export const INSIGHTS_REPORTS_QUERY_KEY = "insights-reports";

export function insightsReportsQueryKey(strategyId: number | null) {
  return ["/api/lab/strategies", strategyId, INSIGHTS_REPORTS_QUERY_KEY];
}

export type GenerateReportErrorCode = "NO_RESULTS" | "NO_MATCHING_RESULTS" | "FETCH_FAILED";

export interface GenerateReportResult {
  report: StrategyInsightsReport;
  totalRuns: number;
  totalResults: number;
  matchCount: number;
  saveFailed: boolean;
}

export interface GenerateReportError {
  code: GenerateReportErrorCode;
  message: string;
}

export async function generateAndSaveInsightsReport(
  strategyId: number,
  strategyName: string,
  parsedInputs: LabPineInput[],
  filter?: { ticker?: string; timeframe?: string } | null,
): Promise<GenerateReportResult> {
  const res = await fetch(`/api/lab/strategies/${strategyId}/all-results?lite=1`);
  if (!res.ok) {
    const err: GenerateReportError = { code: "FETCH_FAILED", message: "Failed to fetch results" };
    throw err;
  }
  const data = await safeResponseJson(res);
  if (!data.results || data.results.length === 0) {
    const err: GenerateReportError = { code: "NO_RESULTS", message: "Run some optimizations first to generate insights" };
    throw err;
  }

  let matchCount = data.results.length;
  if (filter) {
    matchCount = data.results.filter((r: any) =>
      (!filter.ticker || r.ticker === filter.ticker) &&
      (!filter.timeframe || r.timeframe === filter.timeframe)
    ).length;
    if (matchCount === 0) {
      const label = [filter.ticker, filter.timeframe].filter(Boolean).join(" ");
      const err: GenerateReportError = { code: "NO_MATCHING_RESULTS", message: `No results found for ${label}. Run optimizations with this ticker/timeframe first.` };
      throw err;
    }
  }

  const resultData = data.results.map((r: LabOptResult) => ({
    ticker: r.ticker,
    timeframe: r.timeframe,
    netProfitPercent: r.netProfitPercent,
    winRatePercent: r.winRatePercent,
    maxDrawdownPercent: r.maxDrawdownPercent,
    profitFactor: r.profitFactor,
    totalTrades: r.totalTrades,
    params: r.params as Record<string, any>,
    trades: (r.trades || []) as any[],
  }));

  const report = generateInsightsReport(resultData, parsedInputs, strategyName, data.totalRuns, filter);

  let saveFailed = false;
  try {
    await apiRequest("POST", `/api/lab/strategies/${strategyId}/insights-report`, {
      reportData: report,
      totalResults: report.totalResults,
      totalRuns: report.totalRuns,
    });
  } catch (saveErr: any) {
    console.log("[Insights] Failed to auto-save report:", saveErr.message);
    saveFailed = true;
  }

  invalidateInsightsCache(strategyId);

  return {
    report,
    totalRuns: data.totalRuns,
    totalResults: report.totalResults,
    matchCount,
    saveFailed,
  };
}

export function invalidateInsightsCache(strategyId: number) {
  queryClient.invalidateQueries({ queryKey: ["/api/lab/strategies", strategyId, INSIGHTS_REPORTS_QUERY_KEY] });
}
