import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildConfirmedPartialPosition,
  classifyPartialClosePositionAuthority,
  normalizePartialCloseIdentity,
  partialCloseIdentityMatches,
  resolvePartialClosePositionAuthority,
  resolvePartialCloseExecutionPrice,
} from "../../server/trading/signal-bot-close-integrity";

describe("partial-close residual-position authority", () => {
  it("accepts only the exact requested same-side reduction", () => {
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      requestedClosedSize: 1,
      authority: { size: 2, side: "LONG", entryPrice: 100 },
    })).toEqual({
      kind: "confirmed",
      residualBaseSize: 2,
      residualEntryPrice: 100,
      becameFlat: false,
    });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: -3,
      requestedClosedSize: 1,
      authority: { size: 0, side: "FLAT", entryPrice: 0 },
    })).toEqual({
      kind: "unavailable",
      reason: "post_close_position_unexpected_flat",
      retryable: false,
    });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      requestedClosedSize: 1,
      authority: { size: 3, side: "LONG", entryPrice: 100 },
    })).toEqual({
      kind: "unavailable",
      reason: "post_close_position_not_reduced",
      retryable: true,
    });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      requestedClosedSize: 1,
      authority: { size: -2, side: "SHORT", entryPrice: 100 },
    })).toEqual({
      kind: "unavailable",
      reason: "post_close_position_side_mismatch",
      retryable: false,
    });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      requestedClosedSize: 1,
      authority: { size: 2.25, side: "LONG", entryPrice: 100 },
    })).toMatchObject({
      kind: "unavailable",
      reason: "post_close_position_under_delivered",
      retryable: true,
    });
    expect(classifyPartialClosePositionAuthority({
      preCloseBaseSize: 3,
      requestedClosedSize: 1,
      authority: { size: 1.5, side: "LONG", entryPrice: 100 },
    })).toEqual({
      kind: "unavailable",
      reason: "post_close_position_reduction_exceeds_request",
      retryable: false,
    });
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
      requestedClosedSize: 1,
      readAuthority,
      wait,
    })).resolves.toMatchObject({ kind: "confirmed", residualBaseSize: 2 });
    expect(readAuthority).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("does not spend retry budget on a terminal authority contradiction", async () => {
    const readAuthority = vi.fn().mockResolvedValue({ size: 0, side: "FLAT", entryPrice: 0 });
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(resolvePartialClosePositionAuthority({
      preCloseBaseSize: 3,
      requestedClosedSize: 1,
      readAuthority,
      wait,
    })).resolves.toMatchObject({
      kind: "unavailable",
      reason: "post_close_position_unexpected_flat",
      retryable: false,
      attempts: 1,
    });
    expect(readAuthority).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("uses only a positive adapter-returned execution price and keeps signal price as context", () => {
    expect(resolvePartialCloseExecutionPrice({
      protocol: "pacifica",
      adapterFillPrice: 101.25,
      signalPrice: 99.5,
    })).toEqual({
      price: 101.25,
      authority: "venue_execution",
      signalPriceContext: 99.5,
      reason: null,
    });
    expect(resolvePartialCloseExecutionPrice({
      protocol: "flash",
      adapterFillPrice: 101.25,
      signalPrice: 99.5,
    })).toMatchObject({ price: 101.25, authority: "adapter_submit_oracle_estimate" });
    expect(resolvePartialCloseExecutionPrice({
      protocol: "pacifica",
      adapterFillPrice: 0,
      signalPrice: 99.5,
    })).toEqual({
      price: null,
      authority: null,
      signalPriceContext: 99.5,
      reason: "partial_close_execution_price_unavailable",
    });
  });

  it("normalizes transaction wrappers once and matches only exact venue identities", () => {
    expect(normalizePartialCloseIdentity("tx-partial-fill-7")).toBe("fill-7");
    expect(normalizePartialCloseIdentity("tx-tx-partial-fill-7")).toBe("fill-7");
    expect(partialCloseIdentityMatches({
      transactionSignature: "order-7",
      protocolFillId: "tx-partial-order-7",
      orderId: "order-7",
    })).toBe(true);
    expect(partialCloseIdentityMatches({
      transactionSignature: "order-7",
      protocolFillId: "tx-partial-fill-7",
      orderId: "other-order",
      tradeId: "other-fill",
    })).toBe(false);
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
    expect(routes.match(/buildSignalBotCloseResponse\("accounting_incomplete"/g)).toHaveLength(2);
    expect(routes).toContain("await storage.updatePendingBotTrade(marker.trade.id");
    expect(routes).not.toContain("input.executionPrice ?? input.signalPriceContext ?? 0");
  });

  it("locks the durable position epoch inside the same canonical transaction", () => {
    expect(storage).toContain("confirmedPositionReduction?:");
    expect(storage).toContain("partial_close_position_epoch_conflict");
    expect(storage).toContain("await persistConfirmedPositionReduction()");
  });

  it("lets restart reconciliation promote only one identity- and epoch-bound marker", () => {
    expect(reconciler).toContain("selectPendingPartialCloseMarker({");
    expect(reconciler).toContain("pending_partial_marker_identity_or_money_unavailable");
    expect(reconciler).toContain("confirmedPositionReduction:");
  });
});
