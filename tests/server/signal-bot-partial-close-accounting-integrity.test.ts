import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildConfirmedPartialPosition,
  classifyPartialClosePositionAuthority,
  resolvePartialClosePositionAuthority,
} from "../../server/trading/signal-bot-close-integrity";

describe("partial-close residual-position authority", () => {
  it("accepts only a fresh same-side reduction or authoritative flat", () => {
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      authority: { size: 2, side: "LONG", entryPrice: 100 },
    })).toEqual({
      kind: "confirmed",
      residualBaseSize: 2,
      residualEntryPrice: 100,
      becameFlat: false,
    });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: -3,
      authority: { size: 0, side: "FLAT", entryPrice: 0 },
    })).toMatchObject({ kind: "confirmed", residualBaseSize: 0, becameFlat: true });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      authority: { size: 3, side: "LONG", entryPrice: 100 },
    })).toEqual({ kind: "unavailable", reason: "post_close_position_not_reduced" });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      authority: { size: -2, side: "SHORT", entryPrice: 100 },
    })).toEqual({ kind: "unavailable", reason: "post_close_position_side_mismatch" });
  });

  it("retains the existing three-retry stale-read guard before declaring incomplete", async () => {
    const readAuthority = vi.fn()
      .mockResolvedValueOnce({ size: 3, side: "LONG", entryPrice: 100 })
      .mockResolvedValueOnce({ size: 3, side: "LONG", entryPrice: 100 })
      .mockResolvedValueOnce({ size: 3, side: "LONG", entryPrice: 100 })
      .mockResolvedValueOnce({ size: 2, side: "LONG", entryPrice: 101 });
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(resolvePartialClosePositionAuthority({
      preCloseBaseSize: 3,
      readAuthority,
      wait,
    })).resolves.toMatchObject({ kind: "confirmed", residualBaseSize: 2 });
    expect(readAuthority).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("accumulates money exactly while copying venue residual state", () => {
    const closedAt = new Date("2026-08-29T10:00:00.000Z");
    expect(buildConfirmedPartialPosition({
      avgEntryPrice: "99.500000",
      realizedPnl: "10.100001",
      totalFees: "0.200002",
    }, {
      residualBaseSize: -1.25,
      residualEntryPrice: 101.1234567,
      realizedPnlDelta: -1.234567,
      feeDelta: 0.012345,
      tradeId: "partial-close-trade",
      closedAt,
    })).toEqual({
      baseSize: "-1.25000000",
      avgEntryPrice: "101.123457",
      costBasis: "126.404321",
      realizedPnl: "8.865434",
      totalFees: "0.212347",
      lastTradeId: "partial-close-trade",
      lastTradeAt: closedAt,
    });
  });
});

describe("partial-close integration guards", () => {
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const storage = readFileSync(new URL("../../server/storage.ts", import.meta.url), "utf8");
  const reconciler = readFileSync(new URL("../../server/reconciliation-service.ts", import.meta.url), "utf8");

  it("routes both webhook consumers through one durable marker and no detached sync", () => {
    expect(routes.match(/const pcAccounting = await finalizeSignedPartialCloseAccounting\(/g)).toHaveLength(2);
    expect(routes.match(/status: "accounting_incomplete"/g)).toHaveLength(2);
    const tradingView = routes.slice(routes.indexOf("if (isPartialClose)"), routes.indexOf("DEFENSE-IN-DEPTH", routes.indexOf("if (isPartialClose)")));
    const userStart = routes.indexOf("if (isPartialClose) {", routes.indexOf("if (isPartialClose)") + 1);
    const user = routes.slice(userStart, routes.indexOf("DEFENSE-IN-DEPTH", userStart));
    expect(tradingView).not.toContain("syncPositionFromOnChain(");
    expect(user).not.toContain("syncPositionFromOnChain(");
    expect(routes).toContain("if (pcPnl !== null && pcAccounting.isNew)");
  });

  it("locks the durable position epoch inside the same canonical transaction", () => {
    expect(storage).toContain("confirmedPositionReduction?:");
    expect(storage).toContain("partial_close_position_epoch_conflict");
    expect(storage).toContain("await persistConfirmedPositionReduction()");
  });

  it("lets restart reconciliation promote the pending marker using fresh venue residual truth", () => {
    expect(reconciler).toContain("const pendingPartial = (await storage.getBotTrades(botId, 200)).find");
    expect(reconciler).toContain("recoveredBy: 'periodic_reconciler'");
    expect(reconciler).toContain("confirmedPositionReduction:");
  });
});
