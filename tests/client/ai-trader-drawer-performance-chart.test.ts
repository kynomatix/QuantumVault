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
const trackRecordCalculations = source.slice(
  source.indexOf("const trackRecordClosedPnl"),
  source.indexOf("const degenDaysAlive"),
);
const trackRecordPanel = source.slice(
  source.indexOf('<TabsContent value="track-record"'),
  source.indexOf('<TabsContent value="settings"'),
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

  it("uses exact qualification-era progress rather than the loaded timeline", () => {
    expect(source).toContain('data-testid="trial-strip-summary"');
    expect(source).toContain("Qualification era · Day {daysElapsed}/{periodDays} · {tradeCount} closed trades ·");
    const trialStrip = source.slice(source.indexOf("function TrialStrip"), source.indexOf("export function AiTraderDrawer"));
    expect(trialStrip).toContain("qualificationProgress.status === 'unavailable'");
    expect(trialStrip).toContain('data-testid="trial-strip-unavailable"');
    expect(trialStrip).toContain("const { tradeCount, netPnl } = qualificationProgress");
    expect(trialStrip).toContain("qualificationProgress.trialStartedAt");
    expect(trialStrip).toContain("Reset reason: {resetReasonLabel}");
    expect(trialStrip).toContain("const resetReasonLabel = qualificationProgress.resetReason");
    expect(source).toContain("scanner_market_selection_changed: 'Scanner market selection changed'");
    expect(source).toContain("material_bot_settings_changed: 'Material bot settings changed'");
    expect(source).toContain("trial_restarted: 'Trial restarted'");
    expect(source).toContain("qualification_era_changed: 'Qualification evidence changed'");
    const resetReasonFormatter = source.slice(
      source.indexOf("function formatQualificationResetReason"),
      source.indexOf("function TrialStrip"),
    );
    expect(resetReasonFormatter).toContain("const suppressedReasons = new Set([");
    expect(resetReasonFormatter).toContain("'qualification_era_initialized'");
    expect(resetReasonFormatter).toContain("if (suppressedReasons.has(reason)) return null");
    expect(resetReasonFormatter.indexOf("if (suppressedReasons.has(reason)) return null"))
      .toBeLessThan(resetReasonFormatter.indexOf("return labels[reason] ??"));
    expect(resetReasonFormatter).not.toContain("labels[reason] ?? null");
    expect(trialStrip).toContain("const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`");
    expect(trialStrip).not.toContain("Loaded timeline");
    expect(trialStrip).not.toContain("· DD {maxDdPct.toFixed(1)}%");
    const trialStripStart = source.indexOf("<TrialStrip");
    const trialStripCall = source.slice(trialStripStart, source.indexOf("/>", trialStripStart) + 2);
    expect(trialStripCall).toContain("qualificationProgress={detail?.qualificationProgress");
    expect(trialStripCall).not.toContain("tradesCount={tradesCount}");
    expect(trialStripCall).not.toContain("netPnl={netPnl}");
  });

  it("uses the terminally attributed current-mode projection for the Track Record P&L", () => {
    expect(trackRecordCalculations).toContain("performance.status === 'available' ? performance.netPnl : null");
    expect(trackRecordCalculations).toContain("const trackRecordHasProvenNoOpenExposure = openDecision === null");
    expect(trackRecordCalculations).toContain("bot?.status === 'idle'");
    expect(trackRecordCalculations).toContain("bot?.status === 'stopped'");
    expect(trackRecordCalculations).toContain("bot?.pauseReason === 'user_requested'");
    expect(trackRecordCalculations).toContain("bot?.pauseReason === 'position_unconfirmed_expired'");
    expect(trackRecordCalculations).toContain("bot?.pauseReason === 'consecutive_losses'");
    expect(trackRecordCalculations).toContain("const trackRecordHasOpenExposure = !trackRecordHasProvenNoOpenExposure");
    expect(trackRecordCalculations).not.toContain("reconcile_orphan_position");
    const exposurePredicateStart = trackRecordCalculations.indexOf("const trackRecordHasProvenNoOpenExposure");
    const exposurePredicateEnd = trackRecordCalculations.indexOf(";", exposurePredicateStart) + 1;
    expect(trackRecordCalculations.slice(exposurePredicateStart, exposurePredicateEnd).replace(/\s+/g, " ").trim()).toBe(
      "const trackRecordHasProvenNoOpenExposure = openDecision === null && ( bot?.status === 'idle' || bot?.status === 'stopped' || (bot?.status === 'paused' && ( bot?.pauseReason === 'user_requested' || bot?.pauseReason === 'position_unconfirmed_expired' || bot?.pauseReason === 'consecutive_losses' )) );",
    );
    expect(trackRecordCalculations).toContain("!trackRecordHasOpenExposure");
    expect(trackRecordCalculations).toContain("Number.isFinite(openUnrealizedPnl)");
    expect(trackRecordCalculations).toContain("trackRecordClosedPnl + trackRecordOpenPnl");
    expect(trackRecordPanel).toContain('data-testid="track-record-net-pnl"');
    expect(trackRecordPanel).toContain("`Overall ${trackRecordMode} P&L (closed + open)`");
    expect(trackRecordPanel).toContain("formatPerformancePnl(trackRecordNetPnl)");
    expect(trackRecordPanel).toContain("Attributed {trackRecordMode} closed P&L (fees in)");
    expect(trackRecordPanel).toContain("formatPerformancePnl(performance.netPnl)");
    expect(trackRecordPanel).toContain("formatPerformancePnl(trackRecordOpenPnl ?? 0)");
    expect(trackRecordPanel).not.toContain("lifetimeStats");
    expect(trackRecordPanel).not.toContain("AI spend");
    expect(trackRecordPanel).not.toContain("Net P&L (closed + live − AI cost)");
    expect(performancePanel).not.toContain("closed + live − AI cost");
  });

  it("fails the Track Record enrichment open without presenting partial data as complete", () => {
    expect(trackRecordPanel).toContain("performance.status === 'available' && openDecision !== null");
    expect(trackRecordPanel).toContain("performance.status === 'available' && trackRecordHasOpenExposure");
    expect(trackRecordPanel).toContain("Open-position unrealized P&L is unavailable, so the overall figure is withheld.");
    expect(trackRecordPanel).toContain("The bot state cannot be proven flat, so the overall figure is withheld.");
    expect(trackRecordPanel).toContain("Current-mode performance is temporarily unavailable.");
    expect(trackRecordPanel).toContain("omittedUnattributedTrades");
    expect(trackRecordPanel).toContain("excludedOtherModeTrades");
    expect(trackRecordPanel).toContain("omittedInvalidPnlTrades");
    expect(trackRecordPanel).toContain("paper/live attribution unavailable");
    expect(trackRecordPanel).not.toContain("netPnlAllIn");
  });
});
