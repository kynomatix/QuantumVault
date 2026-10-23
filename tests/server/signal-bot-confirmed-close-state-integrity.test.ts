import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbHarness = vi.hoisted(() => ({
  transaction: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("../../server/db", () => ({
  db: dbHarness,
}));
import {
  buildConfirmedFlatPosition,
  buildConfirmedPartialPosition,
  buildSignalBotCloseResponse,
  confirmedPartialPositionEpochMatches,
  summarizeSignalBotCloseFills,
} from "../../server/trading/signal-bot-close-integrity";
import { DatabaseStorage } from "../../server/storage";

function recordingUpdateChain(writes: unknown[]) {
  const promise = Promise.resolve([]);
  let chain: any;
  chain = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (property === "then") return promise.then.bind(promise);
      if (property === "catch") return promise.catch.bind(promise);
      if (property === "finally") return promise.finally.bind(promise);
      if (property === "set") return (value: unknown) => {
        writes.push(value);
        return chain;
      };
      return () => chain;
    },
  });
  return chain;
}

function resolvedChain(result: unknown) {
  const promise = Promise.resolve(result);
  const chain: any = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (property === "then") return promise.then.bind(promise);
      if (property === "catch") return promise.catch.bind(promise);
      if (property === "finally") return promise.finally.bind(promise);
      return () => chain;
    },
  });
  return chain;
}

beforeEach(() => {
  dbHarness.transaction.mockReset();
  dbHarness.select.mockReset();
  dbHarness.update.mockReset();
  dbHarness.insert.mockReset();
});

describe("Signal Bot close response authority", () => {
  it.each([
    ["position_unavailable", 503],
    ["already_flat", 409],
    ["executed", 200],
    ["accounting_incomplete", 200],
    ["confirmation_pending", 202],
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

describe("Signal Bot venue-fill close confirmation", () => {
  it("aggregates the incident split fill with venue price, fee, PnL, and identities", () => {
    const confirmation = summarizeSignalBotCloseFills({
      market: "ZEC-PERP",
      openSide: "long",
      expectedSize: 1.57,
      notBeforeMs: 100,
      trades: [
        { tradeId: "101", orderId: "201", internalSymbol: "ZEC-PERP", side: "short", venueEventKind: "close_long", price: 506.72, size: 0.94, fee: 0.666844, realizedPnl: -0.731805, timestamp: 101 },
        { tradeId: "102", orderId: "202", internalSymbol: "ZEC-PERP", side: "short", venueEventKind: "close_long", price: 506.73, size: 0.14, fee: 0.099319, realizedPnl: -0.107594, timestamp: 102 },
        { tradeId: "103", orderId: "203", internalSymbol: "ZEC-PERP", side: "short", venueEventKind: "close_long", price: 506.73, size: 0.49, fee: 0.347617, realizedPnl: -0.37658, timestamp: 103 },
      ],
    });

    expect(confirmation).not.toBeNull();
    expect(confirmation?.filledSize).toBeCloseTo(1.57, 12);
    expect(confirmation?.fee).toBeCloseTo(1.11378, 12);
    expect(confirmation?.realizedPnl).toBeCloseTo(-1.215979, 12);
    expect(confirmation?.fillIds).toEqual(["101", "102", "103"]);
  });

  it("does not confuse a newer flip open with the preceding semantic close", () => {
    const confirmation = summarizeSignalBotCloseFills({
      market: "BTC-PERP",
      openSide: "long",
      expectedSize: 1,
      notBeforeMs: 100,
      trades: [
        { tradeId: "new-open", orderId: "2", internalSymbol: "BTC-PERP", side: "short", venueEventKind: "open_short", price: 99, size: 1, fee: 1, timestamp: 102 },
        { tradeId: "close", orderId: "1", internalSymbol: "BTC-PERP", side: "short", venueEventKind: "close_long", price: 100, size: 1, fee: 1, timestamp: 101 },
      ],
    });
    expect(confirmation?.fillIds).toEqual(["close"]);
    expect(confirmation?.fillPrice).toBe(100);
  });
});

describe("confirmed full-close position accounting", () => {
  it("rejects a stale partial-close epoch from inside the transaction so no commit occurs", async () => {
    const lockedMarker = {
      id: "pending-partial-row",
      tradingBotId: "bot-one",
      market: "BTC-PERP",
      side: "short",
      size: "0.25",
      price: "101",
      pnl: null,
      status: "pending",
      executedAt: new Date("2026-08-30T00:00:00.000Z"),
      webhookPayload: { partialClose: true },
    };
    const promotedMarker = { ...lockedMarker, status: "executed", pnl: "1" };
    const stalePosition = {
      id: "position-one",
      baseSize: "0.50",
      avgEntryPrice: "100",
      realizedPnl: "0",
      totalFees: "0",
      lastTradeId: "newer-entry",
    };
    const txSelect = vi.fn()
      .mockReturnValueOnce(resolvedChain([lockedMarker]))
      .mockReturnValueOnce(resolvedChain([promotedMarker]))
      .mockReturnValueOnce(resolvedChain([stalePosition]));
    const txUpdate = vi.fn(() => resolvedChain([]));
    let committed = false;
    dbHarness.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const result = await callback({ select: txSelect, update: txUpdate, insert: vi.fn() });
      committed = true;
      return result;
    });
    const storage = new DatabaseStorage();
    vi.spyOn(storage, "getRecentCanonicalCloseForBot").mockResolvedValue(undefined);
    vi.spyOn(storage, "recomputeAndMergeBotStats").mockResolvedValue(undefined);

    await expect(storage.recordCloseEventAtomic({
      botId: "bot-one",
      update: {
        tradeId: "pending-partial-row",
        fields: { status: "executed", protocolFillId: "partial-fill-one", pnl: "1" },
      },
      deltas: { totalPnlDelta: 1 },
      confirmedPositionReduction: {
        market: "BTC-PERP",
        expectedBaseSize: "1",
        expectedLastTradeId: "entry-one",
        residualBaseSize: 0.75,
        residualEntryPrice: 100,
        realizedPnlDelta: 1,
        feeDelta: 0.1,
      },
    })).rejects.toThrow("partial_close_position_epoch_conflict");

    expect(dbHarness.transaction).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });

  it("binds a partial promotion to the exact base-size and last-trade epoch", () => {
    expect(confirmedPartialPositionEpochMatches({
      actualBaseSize: "1.000000000",
      actualLastTradeId: "entry-one",
      expectedBaseSize: "1",
      expectedLastTradeId: "entry-one",
    })).toBe(true);
    expect(confirmedPartialPositionEpochMatches({
      actualBaseSize: "0.99",
      actualLastTradeId: "entry-one",
      expectedBaseSize: "1",
      expectedLastTradeId: "entry-one",
    })).toBe(false);
    expect(confirmedPartialPositionEpochMatches({
      actualBaseSize: "1",
      actualLastTradeId: "entry-two",
      expectedBaseSize: "1",
      expectedLastTradeId: "entry-one",
    })).toBe(false);
  });

  it("preserves cumulative money while replacing only the venue-authoritative residual exposure", () => {
    expect(buildConfirmedPartialPosition({
      avgEntryPrice: "100",
      realizedPnl: "4.5",
      totalFees: "0.2",
    }, {
      residualBaseSize: 0.98,
      residualEntryPrice: 101,
      realizedPnlDelta: 0.5,
      feeDelta: 0.01,
      tradeId: "partial-row",
      closedAt: new Date("2026-08-30T00:00:00.000Z"),
    })).toMatchObject({
      baseSize: "0.98000000",
      avgEntryPrice: "101.000000",
      realizedPnl: "5.000000",
      totalFees: "0.210000",
      lastTradeId: "partial-row",
    });
  });

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

describe("reconciler close accounting remediation transaction", () => {
  const evidence = {
    kind: "venue_exact" as const,
    protocolFillId: "venue-fill-1",
    fillPrice: 101,
    pnl: 7,
    fee: 0.25,
    observedAt: 1_700_000_000_000,
  };
  const incompleteTrade = {
    id: "close-row",
    tradingBotId: "bot-one",
    market: "BTC-PERP",
    size: "2",
    price: "100",
    fee: null,
    pnl: null,
    status: "executed",
    webhookPayload: {
      closeAccounting: { kind: "unavailable", reason: "venue_fill_unattributed" },
      priceRole: "observation_context_only",
    },
  };
  const position = {
    id: "position-one",
    tradingBotId: "bot-one",
    market: "BTC-PERP",
    baseSize: "3",
    avgEntryPrice: "99",
    costBasis: "297",
    realizedPnl: "4",
    totalFees: "1",
    lastTradeId: "new-entry-epoch",
    lastTradeAt: new Date("2026-08-30T00:00:00.000Z"),
  };

  function arrange(selectResults: unknown[][]) {
    const writes: unknown[] = [];
    const txSelect = vi.fn();
    for (const result of selectResults) txSelect.mockReturnValueOnce(resolvedChain(result));
    const txUpdate = vi.fn(() => recordingUpdateChain(writes));
    dbHarness.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => (
      callback({ select: txSelect, update: txUpdate, insert: vi.fn() })
    ));
    return { writes, txSelect, txUpdate };
  }

  it("treats an identical exact-evidence replay as a no-op", async () => {
    const exactTrade = { ...incompleteTrade, webhookPayload: { closeAccounting: evidence } };
    const harness = arrange([[exactTrade]]);
    const storage = new DatabaseStorage();
    const stats = vi.spyOn(storage, "recomputeAndMergeBotStats").mockResolvedValue(undefined);
    await expect(storage.remediateReconcilerCloseAccountingAtomic({
      botId: "bot-one", tradeId: "close-row", evidence,
    })).resolves.toEqual({ trade: exactTrade, remediated: false });
    expect(harness.txUpdate).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
  });

  it("rejects conflicting exact evidence", async () => {
    arrange([[{ ...incompleteTrade, webhookPayload: { closeAccounting: { ...evidence, fee: 0.5 } } }]]);
    const storage = new DatabaseStorage();
    vi.spyOn(storage, "recomputeAndMergeBotStats").mockResolvedValue(undefined);
    await expect(storage.remediateReconcilerCloseAccountingAtomic({
      botId: "bot-one", tradeId: "close-row", evidence,
    })).rejects.toThrow("conflicting exact venue evidence");
  });

  it("rejects a row that is not accounting-incomplete", async () => {
    arrange([[{ ...incompleteTrade, webhookPayload: {} }]]);
    const storage = new DatabaseStorage();
    vi.spyOn(storage, "recomputeAndMergeBotStats").mockResolvedValue(undefined);
    await expect(storage.remediateReconcilerCloseAccountingAtomic({
      botId: "bot-one", tradeId: "close-row", evidence,
    })).rejects.toThrow("trade is not accounting-incomplete");
  });

  it("rejects remediation when the owning position is missing", async () => {
    arrange([[incompleteTrade], []]);
    const storage = new DatabaseStorage();
    vi.spyOn(storage, "recomputeAndMergeBotStats").mockResolvedValue(undefined);
    await expect(storage.remediateReconcilerCloseAccountingAtomic({
      botId: "bot-one", tradeId: "close-row", evidence,
    })).rejects.toThrow("owning position is missing");
  });

  it("applies money deltas once while preserving exposure, basis, and epoch identity", async () => {
    const updatedTrade = {
      ...incompleteTrade,
      price: "101",
      fee: "0.25",
      pnl: "6.75",
      webhookPayload: { closeAccounting: evidence, priceRole: "venue_fill" },
    };
    const harness = arrange([[incompleteTrade], [position], [updatedTrade]]);
    const storage = new DatabaseStorage();
    const stats = vi.spyOn(storage, "recomputeAndMergeBotStats").mockResolvedValue(undefined);
    await expect(storage.remediateReconcilerCloseAccountingAtomic({
      botId: "bot-one", tradeId: "close-row", evidence,
    })).resolves.toEqual({ trade: updatedTrade, remediated: true });
    expect(stats).toHaveBeenCalledTimes(1);
    expect(stats).toHaveBeenCalledWith("bot-one", {
      totalPnlDelta: 6.75,
      totalVolumeDelta: 202,
    }, expect.anything());
    expect(harness.writes).toHaveLength(2);
    expect(harness.writes[0]).toMatchObject({ price: "101", fee: "0.25", pnl: "6.75" });
    expect(harness.writes[1]).toMatchObject({ realizedPnl: "10.750000", totalFees: "1.250000" });
    expect(harness.writes[1]).not.toHaveProperty("baseSize");
    expect(harness.writes[1]).not.toHaveProperty("avgEntryPrice");
    expect(harness.writes[1]).not.toHaveProperty("costBasis");
    expect(harness.writes[1]).not.toHaveProperty("lastTradeId");
    expect(harness.writes[1]).not.toHaveProperty("lastTradeAt");
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

  it("remediates incomplete accounting under the trade lock without rewriting exposure", () => {
    const remediationStart = storageSource.indexOf("async remediateReconcilerCloseAccountingAtomic(opts:");
    const remediationEnd = storageSource.indexOf("async getBotTrades(", remediationStart);
    const remediationSource = storageSource.slice(remediationStart, remediationEnd);

    expect(remediationStart).toBeGreaterThan(0);
    expect(remediationSource).toContain('.for("update")');
    expect(remediationSource).toContain("conflicting exact venue evidence");
    expect(remediationSource).toContain("buildRemediatedPositionAccounting(position");
    expect(remediationSource.indexOf("await this.recomputeAndMergeBotStats")).toBeLessThan(
      remediationSource.indexOf("const positionRows = await tx"),
    );
    expect(remediationSource).not.toContain("buildConfirmedFlatPosition(position");
    expect(remediationSource).not.toContain("baseSize:");
    expect(remediationSource).not.toContain("costBasis:");
  });

  it("locks every stats merge while preserving the trade-table-first lock order", () => {
    const updateStart = storageSource.indexOf("async updateTradingBotStats(");
    const updateEnd = storageSource.indexOf("async getCanonicalBotTradeStats(", updateStart);
    const updateSource = storageSource.slice(updateStart, updateEnd);
    expect(updateSource).toContain('.for("update")');

    const recomputeStart = storageSource.indexOf("async recomputeAndMergeBotStats(");
    const recomputeEnd = storageSource.indexOf("static canonicalCloseFillId(", recomputeStart);
    const recomputeSource = storageSource.slice(recomputeStart, recomputeEnd);
    const ownerLock = recomputeSource.indexOf('.for("update")');
    const countRead = recomputeSource.indexOf("const countsRows = await tx");
    expect(ownerLock).toBeGreaterThan(0);
    expect(countRead).toBeLessThan(ownerLock);
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

  it("reads Pacifica fill history once in each full-close path before uncertainty handling", () => {
    const tradingViewStart = routesSource.indexOf("// === BEGIN CLOSE SIGNAL HANDLING");
    const tradingViewEnd = routesSource.indexOf("// === END OUTER TRY/CATCH FOR CLOSE SIGNAL HANDLING", tradingViewStart);
    const tradingViewSource = routesSource.slice(tradingViewStart, tradingViewEnd);
    const userStart = routesSource.indexOf("// CLOSE SIGNAL HANDLING - mirrors logic");
    const userEnd = routesSource.indexOf("PARTIAL CLOSE HANDLER (user-webhook path)", userStart);
    const userSource = routesSource.slice(userStart, userEnd);

    expect(tradingViewSource.match(/const fillConfirmation =/g)).toHaveLength(1);
    expect(userSource.match(/const fillConfirmation =/g)).toHaveLength(1);
    expect(tradingViewSource.indexOf("const fillConfirmation =")).toBeLessThan(
      tradingViewSource.indexOf("if (finalVerificationUnavailable)"),
    );
    expect(userSource.indexOf("const fillConfirmation =")).toBeLessThan(
      userSource.indexOf("if ((postCloseReadError || observedResidual) && !fillConfirmation)"),
    );
    expect(routesSource.match(/readSignalBotCloseFillConfirmation\(\{/g)).toHaveLength(2);
  });

  it("keeps gross fallback separate from persisted pnl with exact provenance", () => {
    const payloadStart = routesSource.indexOf("function closeFeeEventPayload(");
    const payloadEnd = routesSource.indexOf("async function finalizePerBotConfirmedClose", payloadStart);
    const payloadSource = routesSource.slice(payloadStart, payloadEnd);

    expect(payloadSource).toContain("input.pnl === null");
    expect(payloadSource).toContain("input.feeEvidence.kind === 'unavailable'");
    expect(payloadSource).toContain("pnlConvention: 'gross_before_close_fee'");
    expect(payloadSource).toContain("feeStatus: 'close_fee_unknown'");
    expect(payloadSource).toContain("feeReason: input.feeEvidence.reason");
  });
});
