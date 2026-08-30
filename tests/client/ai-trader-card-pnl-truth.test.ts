import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function cardPerformanceSource(): string {
  const source = readFileSync(resolve(process.cwd(), "client/src/pages/App.tsx"), "utf8");
  const start = source.indexOf("const projection = (aiBot as any).modePerformance");
  const end = source.indexOf("const aiBots: any[]", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("AI Trader card mode-scoped P&L truth", () => {
  it("uses the terminally attributed current-mode projection and never the mixed lifetime fallback", () => {
    const card = cardPerformanceSource();
    expect(card).toContain("projection?.status === 'available'");
    expect(card).toContain("projection.netPnl");
    expect(card).toContain("projection.mode === 'paper_trial'");
    expect(card).toContain("Omitted unattributed trades");
    expect(card).not.toContain("lifetimeStats");
    expect(card).not.toContain("netPnlAllIn");
    expect(card).not.toContain("totalLlmCost");
    expect(card).not.toContain("AI spend");
  });

  it("adds a valid open mark, treats no open position as zero, and fails closed on a missing open mark", () => {
    const card = cardPerformanceSource();
    expect(card).toContain("aiBot.status === 'open'");
    expect(card).toContain("typeof rawOpen === 'number' && Number.isFinite(rawOpen)");
    expect(card).toContain("const openAvailable = !hasOpenPosition || validOpen");
    expect(card).toContain("const openPnl = hasOpenPosition && validOpen ? rawOpen : 0");
    expect(card).toContain("const overallAvailable = projectionAvailable && openAvailable");
    expect(card).toContain("The open position mark price is temporarily unavailable.");
    expect(card).toContain("Current-mode closed P&L is temporarily unavailable.");
  });

  it("labels the headline and available components truthfully", () => {
    const card = cardPerformanceSource();
    expect(card).toContain("Paper P&L");
    expect(card).toContain("Live P&L");
    expect(card).toContain("const pnlModeLabel = projection?.mode === 'paper_trial'");
    expect(card).toContain("const pnlScopeLabel = !overallAvailable");
    const qualifierStart = card.indexOf("const pnlScopeLabel =");
    expect(qualifierStart).toBeGreaterThan(-1);
    const qualifierEnd = card.indexOf(";", qualifierStart) + 1;
    expect(
      card.slice(qualifierStart, qualifierEnd)
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe(
      "const pnlScopeLabel = !overallAvailable ? 'scope unavailable' : hasOpenPosition ? 'closed + open' : 'closed';",
    );
    expect(card).toContain("'scope unavailable'");
    expect(card).toContain("{pnlScopeLabel}");
    expect(card).toContain("{!!aiBot.paperMode && (");
    expect(card).not.toContain("Overall P&L");
    expect(card).toContain("closed P&L");
    expect(card).toContain("Current open unrealized");
    expect(card).toContain(": '--'");
  });
});
