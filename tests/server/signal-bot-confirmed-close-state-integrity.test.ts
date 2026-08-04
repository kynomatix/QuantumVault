import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildConfirmedFlatPosition,
  buildSignalBotCloseResponse,
} from "../../server/trading/signal-bot-close-integrity";

describe("Signal Bot close response authority", () => {
  it.each([
    ["position_unavailable", 503],
    ["already_flat", 409],
    ["executed", 200],
    ["executed_state_unavailable", 500],
  ] as const)("maps %s to HTTP %i and names the outcome", (outcome, statusCode) => {
    expect(buildSignalBotCloseResponse(outcome, { status: "test" })).toEqual({
      statusCode,
      body: { status: "test", closeOutcome: outcome },
    });
  });

  it("keeps a user-webhook residual close at HTTP 200 while refusing to call it executed", () => {
    const response = buildSignalBotCloseResponse("partial", {
      status: "partial",
      remainingPosition: { side: "SHORT", size: -0.25 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.closeOutcome).toBe("partial");
    expect(response.body.closeOutcome).not.toBe("executed");
  });
});

describe("confirmed full-close position accounting", () => {
  it("zeros exposure and basis while accumulating PnL and fees exactly", () => {
    const closedAt = new Date("2026-08-04T06:00:00.000Z");
    expect(buildConfirmedFlatPosition(
      {
        avgEntryPrice: "123.456789",
        realizedPnl: "10.100001",
        totalFees: "0.200002",
      },
      {
        realizedPnlDelta: -1.234567,
        feeDelta: 0.012345,
        tradeId: "canonical-close-trade",
        closedAt,
      },
    )).toEqual({
      baseSize: "0",
      avgEntryPrice: "123.456789",
      costBasis: "0",
      realizedPnl: "8.865434",
      totalFees: "0.212347",
      lastTradeId: "canonical-close-trade",
      lastTradeAt: closedAt,
    });
  });

  it("initializes a missing position as flat without inventing accounting history", () => {
    const closedAt = new Date("2026-08-04T06:00:00.000Z");
    expect(buildConfirmedFlatPosition(undefined, {
      realizedPnlDelta: 2,
      feeDelta: 0.5,
      tradeId: "first-close",
      closedAt,
    })).toMatchObject({
      baseSize: "0",
      avgEntryPrice: "0",
      costBasis: "0",
      realizedPnl: "2.000000",
      totalFees: "0.500000",
    });
  });
});

describe("close-path integration guards", () => {
  const routesSource = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const storageSource = readFileSync(new URL("../../server/storage.ts", import.meta.url), "utf8");

  it("uses confirmed atomic position finalization from both full-close webhooks", () => {
    expect(routesSource.match(/confirmedPositionClose:\s*\{/g)).toHaveLength(2);
    expect(routesSource).toContain('buildSignalBotCloseResponse("position_unavailable"');
    expect(routesSource).toContain('buildSignalBotCloseResponse("already_flat"');
    expect(routesSource).toContain('buildSignalBotCloseResponse("executed_state_unavailable"');
  });

  it("does not let replay, reconciler-winner, or fill-collision branches flatten state", () => {
    const atomicStart = storageSource.indexOf("async recordCloseEventAtomic(opts:");
    const atomicEnd = storageSource.indexOf("async getBotTrades(", atomicStart);
    const atomicSource = storageSource.slice(atomicStart, atomicEnd);
    const firstPersist = atomicSource.indexOf("await persistConfirmedPositionClose()");

    expect(firstPersist).toBeGreaterThan(0);
    expect(atomicSource.indexOf("CANONICAL_STATUSES.has(locked.status)")).toBeLessThan(firstPersist);
    expect(atomicSource.indexOf("if (reconcilerWinner)")).toBeLessThan(firstPersist);
    expect(atomicSource.indexOf("if (updateFailedDueToConflict && wantedFillId)")).toBeLessThan(firstPersist);
    expect(atomicSource.match(/await persistConfirmedPositionClose\(\)/g)).toHaveLength(2);
  });

  it("removes the fallback-capable sync from both full-close handler regions", () => {
    const tradingViewStart = routesSource.indexOf("// === BEGIN CLOSE SIGNAL HANDLING");
    const tradingViewEnd = routesSource.indexOf("// === END OUTER TRY/CATCH FOR CLOSE SIGNAL HANDLING", tradingViewStart);
    const userStart = routesSource.indexOf("// CLOSE SIGNAL HANDLING - mirrors logic");
    const userEnd = routesSource.indexOf("PARTIAL CLOSE HANDLER (user-webhook path)", userStart);

    expect(userEnd).toBeGreaterThan(userStart);
    expect(routesSource.slice(tradingViewStart, tradingViewEnd)).not.toContain("syncPositionFromOnChain(");
    expect(routesSource.slice(userStart, userEnd)).not.toContain("syncPositionFromOnChain(");
  });
});
