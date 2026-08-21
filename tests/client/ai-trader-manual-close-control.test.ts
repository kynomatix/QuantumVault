import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderDrawer.tsx"),
  "utf8",
);

const handler = source.slice(
  source.indexOf("const handleClosePosition = async () =>"),
  source.indexOf("const canAnalyze ="),
);

describe("AI Trader manual close control contract", () => {
  it("uses a dedicated single-flight state and the authenticated existing close route", () => {
    expect(source).toContain("const [closePositionLoading, setClosePositionLoading] = useState(false)");
    expect(handler).toContain("if (!bot || closePositionLoading) return");
    expect(handler).toContain("setClosePositionLoading(true)");
    expect(handler).toContain("`/api/ai-trader/${bot.id}/close`");
    expect(handler).toContain("method: 'POST'");
    expect(handler).toContain("credentials: 'include'");
    expect(handler).toContain("headers: walletAuthHeaders()");
    expect(handler).toContain("setClosePositionLoading(false)");
    expect(handler).toContain("Promise.allSettled([fetchDetail(), fetchHistory()])");
    expect(handler).toContain("onBotUpdated()");
  });

  it("confirmation-gates both paper and live closes with stable control ids", () => {
    expect(source).toContain("<AlertDialogTrigger asChild>");
    expect(source).toContain("<AlertDialogAction");
    expect(source).toContain("data-testid={degraded ? 'button-close-ai-position-degraded' : 'button-close-ai-position'}");
    expect(source).toContain('data-testid="button-confirm-close-ai-position"');
    expect(source).toContain("paperMode ? 'Close paper position' : 'Close LIVE position'");
    expect(source).toContain("This closes only the simulated position");
    expect(source).toContain("This submits a real reduce-only market close");
    expect(source).toContain("loading ? 'Closing…' : label");
    expect(source).toContain("disabled={loading}");
  });

  it("presents public failures and both truthful success variants", () => {
    expect(handler).toContain("data?.detail ?? data?.error ?? 'Close failed'");
    expect(handler).toContain("if (!data?.closed)");
    expect(handler).toContain("No recorded position was closed. If the venue still shows exposure, close it there and contact support.");
    expect(handler).toContain("data?.exitPrice != null && Number.isFinite(rawExitPrice)");
    expect(handler).toContain("data?.realizedPnl != null && Number.isFinite(rawRealizedPnl)");
    expect(handler.match(/'Unavailable'/g)).toHaveLength(2);
    expect(handler).toContain("`Exit ${exitPrice} · Realized P&L ${realizedPnl}`");
    expect(handler).toContain("bot.paperMode ? 'Paper position closed' : 'LIVE position closed'");
  });

  it("keeps a close request available from valid row truth regardless of bot status", () => {
    expect(source).toContain("{openDecision && (");
    expect(source).not.toContain("{bot.status === 'open' && openDecision && (");
    expect(source).toContain("data-testid=\"button-view-chart-open-position\"");
    expect(source).toContain("<ManualClosePositionControl");
    expect(source).toContain("onConfirm={handleClosePosition}");
  });

  it("adds an open-status degraded surface without inventing position details", () => {
    expect(source).toContain("{bot.status === 'open' && !openDecision && (");
    expect(source).toContain('data-testid="open-position-details-unavailable"');
    expect(source).toContain("Position details unavailable");
    expect(source).toContain("You can still request a risk-reducing close.");
    expect(source).toContain("degraded");
  });

  it("does not gate the close handler on optional position pricing or accounting", () => {
    expect(handler).not.toContain("markPrice");
    expect(handler).not.toContain("openUnrealizedPnl");
    expect(handler).not.toContain("openPnlPct");
    expect(handler).not.toContain("entryPrice");
    expect(handler).not.toContain("stopLossPrice");
    expect(handler).not.toContain("takeProfitPrice");
  });
});
