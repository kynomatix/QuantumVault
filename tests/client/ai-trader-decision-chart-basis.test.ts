import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transpileModule } from 'typescript';
import { describe, expect, it, vi } from "vitest";

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
    expect(source).toContain("source: ['okx', 'gate', 'pyth', 'hyperliquid', 'pacifica']");
    expect(source).toContain("venue: ['okx', 'gate', 'hyperliquid', 'none', 'pacifica']");
    expect(source).toContain("timeSemantic: ['open_time']");
    expect(source).toContain("x !== 'finalized' && x !== 'forming'");
    expect(source).toContain("candleBasisLabel && (");
  });

  it("formats the current direct-perpetual identity as source, basis, proxy and finalities", () => {
    expect(source).toContain("[label.source, label.basis, label.proxy, label.finality.join('/')]");
    expect(source).toContain(".join(' \\u00B7 ')");
  });
  it('replaces the full window before admitting a different source tail', async () => {
    const live = source.slice(source.indexOf('// Live candle refresh:'));
    const tickSource = live.slice(live.indexOf('const tick = async () => {'), live.indexOf('const id = setInterval'));
    const label = (source: string) => ({ source, venue: source, basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: ['forming'] });
    const tail = { time: 3, open: 100, high: 110, low: 90, close: 101 };
    const full = { candles: [{ ...tail, time: 1 }, { ...tail, time: 2 }, tail], candleBasisLabel: label('pacifica') };
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, data: { candles: [tail], candleBasisLabel: label('gate') } }).mockResolvedValueOnce({ ok: true, data: full });
    const update = vi.fn(), setCandles = vi.fn(), setCandleBasisLabel = vi.fn(), setError = vi.fn();
    const liveBars = new Map([[2, tail]]);
    const deps = { document: { hidden: false }, seriesRef: { current: { update } }, fetch,
      botId: 'EXAMPLE', decisionId: 'EXAMPLE', tf: '1h', walletAuthHeaders: () => ({}),
      safeResponseJson: async (response: any) => response.data, parseCandleBasisLabel: (value: any) => value,
      candleBasisLabel: label('okx'), liveBarsRef: { current: liveBars }, candles: [{ ...tail, time: 2 }], setCandles, setCandleBasisLabel, setError };
    const js = transpileModule(`let cancelled = false, inFlight = false; ${tickSource} return tick;`, {}).outputText;
    const tick = new Function(...Object.keys(deps), js)(...Object.values(deps));
    await tick();
    expect(fetch.mock.calls[1][0]).toContain('span=deep');
    expect(update).not.toHaveBeenCalled(); expect(liveBars.size).toBe(0);
    expect(setCandles).toHaveBeenCalledWith(full.candles); expect(setCandleBasisLabel).toHaveBeenCalledWith(full.candleBasisLabel);
    expect(setError).not.toHaveBeenCalled();
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

  it("keeps an unresolved proposal chart open across drawer polling", () => {
    expect(drawerSource).toContain(
      "openDecision?.decision.id ?? latestProposal?.id ?? null",
    );
    expect(drawerSource).toContain(
      "[detail?.recentDecisions, history, latestProposal?.id, openDecision?.decision.id]",
    );
  });
});
