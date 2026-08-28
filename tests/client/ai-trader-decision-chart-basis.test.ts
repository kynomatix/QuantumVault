import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderDecisionChart.tsx"),
  "utf8",
);
const drawerSource = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderDrawer.tsx"),
  "utf8",
);

describe("AI Trader decision chart candle-basis label", () => {
  it("requires a server provenance summary and renders the dedicated badge", () => {
    expect(source).toContain("parseCandleBasisLabel(data?.candleBasisLabel)");
    expect(source).toContain("Chart candle provenance is missing or malformed");
    expect(source).toContain('data-testid="text-chart-candle-provenance"');
    expect(source).toContain("formatCandleBasisLabel(candleBasisLabel)");
  });

  it("does not render an optimistic label when provenance is unknown", () => {
    expect(source).toContain("source: ['okx', 'gate', 'pyth']");
    expect(source).toContain("timeSemantic: ['open_time']");
    expect(source).toContain("x !== 'finalized' && x !== 'forming'");
    expect(source).toContain("candleBasisLabel && (");
  });

  it("formats the current direct-perpetual identity as source, basis, proxy and finalities", () => {
    expect(source).toContain("[label.source, label.basis, label.proxy, label.finality.join('/')]");
    expect(source).toContain(".join(' \\u00B7 ')");
  });
});

describe("AI Trader pending proposal chart access", () => {
  const proposalSurface = drawerSource.slice(
    drawerSource.indexOf("{bot.status === 'proposed' && latestProposal && ("),
    drawerSource.indexOf("{openDecision && ("),
  );

  it("opens the existing chart modal from the exact unresolved proposal", () => {
    expect(proposalSurface).toContain('data-testid="button-view-chart-proposal"');
    expect(proposalSurface).toContain("<CandlestickChart");
    expect(proposalSurface).toContain("View Chart");
    expect(proposalSurface).toContain(
      "onClick={() => setChartTarget(decisionRowToChartTarget(latestProposal))}",
    );
    expect(drawerSource).toContain("<AiTraderDecisionChart");
    expect(drawerSource).toContain("decisionId={chartTarget?.decisionId ?? ''}");
  });

  it("keeps the proposal execution controls on the existing decision card", () => {
    expect(proposalSurface).toContain("<AiTraderDecisionCard");
    expect(proposalSurface).toContain("onExecute={() => { fetchDetail(); fetchHistory(); onBotUpdated(); }}");
    expect(proposalSurface).toContain("onSkip={() => { fetchDetail(); fetchHistory(); onBotUpdated(); }}");
    expect(proposalSurface).toContain("onAskAgain={handleAnalyze}");
  });
});
