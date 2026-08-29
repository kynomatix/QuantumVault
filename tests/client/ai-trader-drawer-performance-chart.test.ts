import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderDrawer.tsx"),
  "utf8",
);

const performanceFetch = source.slice(
  source.indexOf("const fetchPerformance = useCallback"),
  source.indexOf("const loadOlderHistory = useCallback"),
);
const performancePanel = source.slice(
  source.indexOf("function PerformancePanel"),
  source.indexOf("function TrialStrip"),
);

describe("AI Trader drawer overall mode-scoped performance", () => {
  it("fetches independently and reuses the existing polling and close-refresh lifecycle", () => {
    expect(performanceFetch).toContain("`/api/ai-trader/${botId}/performance`");
    expect(performanceFetch).toContain("credentials: 'include'");
    expect(performanceFetch).toContain("headers: walletAuthHeaders()");
    expect(performanceFetch).toContain("setPerformance({ status: 'error' })");
    expect(performanceFetch).toContain("}, [botId, walletAddress]);");
    expect(performanceFetch).not.toContain("filterMode");
    expect(source).toContain("Promise.all([fetchDetail(), fetchHistory(), fetchCalibration(), fetchPerformance()])");
    expect(source).toContain("Promise.allSettled([fetchDetail(), fetchHistory()])");
    expect(source).toContain("Promise.allSettled([fetchPerformance()])");
    expect(source.match(/setInterval\(/g)).toHaveLength(1);
  });

  it("places the panel above the activity empty state and timeline controls", () => {
    const panel = source.indexOf("<PerformancePanel");
    const empty = source.indexOf("data-testid=\"activity-empty\"");
    const filter = source.indexOf("data-testid=\"history-filter-pill\"");
    const timeline = source.indexOf("data-testid=\"activity-timeline\"");
    expect(panel).toBeGreaterThan(source.indexOf("data-testid=\"open-position-details-unavailable\""));
    expect(panel).toBeLessThan(empty);
    expect(empty).toBeLessThan(filter);
    expect(filter).toBeLessThan(timeline);
  });

  it("pins the chart, zero domain, non-empty-series baseline, labels, and stable ids", () => {
    for (const id of [
      "ai-trader-performance",
      "ai-trader-performance-chart",
      "ai-trader-performance-net-pnl",
      "ai-trader-performance-empty",
      "ai-trader-performance-error",
    ]) expect(performancePanel).toContain(id);
    for (const component of [
      "ChartContainer", "LineChart", "Line", "YAxis", "ReferenceLine", "ChartTooltip", "ChartTooltipContent",
    ]) expect(performancePanel).toContain(`<${component}`);
    expect(performancePanel).toContain("domain={([dataMin, dataMax]: [number, number]) => [Math.min(0, dataMin), Math.max(0, dataMax)]}");
    expect(performancePanel).toContain("performance.tradeCount > 0");
    expect(performancePanel).toContain("const chartPoints = [{ t: 'Baseline', v: 0 }, ...performance.points]");
    expect(performancePanel).not.toContain("const chartPoints = performance.tradeCount === 1");
    expect(performancePanel).not.toContain("t: 'Current'");
    expect(performancePanel).toContain("Overall paper performance");
    expect(performancePanel).toContain("Overall live performance");
  });

  it("uses the shared themed tooltip with an explicit signed-currency P&L label", () => {
    expect(source).toContain("type ChartConfig");
    expect(source).toContain("const PERFORMANCE_CHART_CONFIG = {");
    expect(source).toContain("v: { label: 'Cumulative P&L' }");
    expect(source).toContain("function formatPerformancePnl(value: number): string");
    expect(source).toContain("? '$0.00'");
    expect(source).toContain("Math.abs(value).toFixed(2)");
    expect(performancePanel).toContain("config={PERFORMANCE_CHART_CONFIG}");
    expect(performancePanel).toContain("className=\"h-full w-full aspect-auto\"");
    expect(performancePanel).toContain("formatPerformancePnl(performance.netPnl)");
    expect(performancePanel).toContain("formatPerformancePnl(Number(value))");
    expect(performancePanel).toContain('name="Cumulative P&L"');
    expect(performancePanel).not.toContain("<RechartsTooltip />");
    expect(performancePanel).not.toContain("contentStyle=");
  });

  it("distinguishes available-empty, error, and omission truth without era semantics", () => {
    expect(source).toContain("value === 0");
    expect(source).toContain("'$0.00'");
    expect(performancePanel).toContain("No closed paper trades yet.");
    expect(performancePanel).toContain("No closed live trades yet.");
    expect(performancePanel).not.toContain("qualification era");
    expect(performancePanel).not.toContain("scannerBot");
    expect(performancePanel).not.toContain("pending");
    expect(performancePanel).toContain("Performance temporarily unavailable.");
    expect(performancePanel).toContain("omitted because terminal paper/live attribution is unavailable.");
    expect(performancePanel).toContain("excluded from this {paper ? 'paper' : 'live'} chart.");
    expect(performancePanel).toContain("omitted because realized P&amp;L is invalid.");
  });

  it("uses the exact loaded-timeline TrialStrip summary and deliberately removes its DD suffix", () => {
    expect(source).toContain('data-testid="trial-strip-summary"');
    expect(source).toContain("Loaded timeline · Day {daysElapsed}/{periodDays} · {tradesCount} closed trades ·");
    const trialStrip = source.slice(source.indexOf("function TrialStrip"), source.indexOf("export function AiTraderDrawer"));
    expect(trialStrip).not.toContain("· DD {maxDdPct.toFixed(1)}%");
  });

  it("keeps the Record metric explicitly all-in rather than reusing the current-era label", () => {
    expect(source).toContain("Net P&L (closed + live − AI cost)");
    expect(source).toContain('data-testid="track-record-net-pnl"');
    expect(performancePanel).not.toContain("closed + live − AI cost");
  });
});
