// Breakeven Protect — pure module tests (server/ai-trader/breakeven.ts).
// No mocks needed: the module is pure by contract (paper-math conventions).

import { describe, it, expect } from "vitest";
import {
  BREAKEVEN_TRIGGER_PROGRESS,
  BREAKEVEN_BUFFER_RATE,
  parseBreakevenProtect,
  favorableExtreme,
  progressTowardTp,
  breakevenStopPrice,
  paperBreakevenStopPrice,
  MAX_PAPER_BREAKEVEN_ULP_CORRECTION_STEPS,
  isFavorableSideOf,
  isTighterStop,
  evaluatePaperBracketWithMove,
  countsAsSlLoss,
  qualifyLiveBreakevenAuthority,
} from "../../server/ai-trader/breakeven";
import { PAPER_SLIPPAGE_PER_LEG, paperExitPrice, paperRealizedPnl } from "../../server/ai-trader/paper-math";
import {
  liveBreakevenFingerprint,
  type LiveBreakevenNativeSnapshot,
} from "../../server/protocol/protocol-types";

function candle(time: number, open: number, high: number, low: number, close: number) {
  return { time, open, high, low, close, volume: 100 };
}

const T0 = Date.UTC(2026, 6, 8, 11, 0, 0);
const TF = 900_000;

describe("parseBreakevenProtect", () => {
  it("returns null when the blob is absent", () => {
    expect(parseBreakevenProtect(undefined, 145, T0)).toBeNull();
    expect(parseBreakevenProtect(null, 145, T0)).toBeNull();
  });

  it("passes a well-formed blob through", () => {
    const raw = {
      originalStopLossPrice: 145,
      movedStopLossPrice: 150.225,
      movedAt: "2026-07-08T11:45:00.000Z",
      progressAtFire: 0.8,
    };
    expect(parseBreakevenProtect(raw, 150.225, T0)).toEqual(raw);
  });

  it("coerces a PRESENT-but-malformed blob to fired-at-current-stop (never re-fires)", () => {
    const parsed = parseBreakevenProtect({ garbage: true }, 150.225, T0);
    expect(parsed).not.toBeNull();
    expect(parsed!.originalStopLossPrice).toBe(150.225);
    expect(parsed!.movedStopLossPrice).toBe(150.225);
    expect(new Date(parsed!.movedAt).getTime()).toBe(T0);
    expect(parsed!.progressAtFire).toBe(BREAKEVEN_TRIGGER_PROGRESS);
  });

  it("coerces non-finite/negative numbers field-by-field", () => {
    const parsed = parseBreakevenProtect(
      { originalStopLossPrice: -1, movedStopLossPrice: NaN, movedAt: "not-a-date", progressAtFire: 0.9 },
      150,
      T0
    );
    expect(parsed!.originalStopLossPrice).toBe(150);
    expect(parsed!.movedStopLossPrice).toBe(150);
    expect(new Date(parsed!.movedAt).getTime()).toBe(T0);
    expect(parsed!.progressAtFire).toBe(0.9);
  });

  it("preserves valid live authority audit metadata and drops malformed optional metadata", () => {
    const fingerprint = "A".repeat(64);
    const valid = parseBreakevenProtect({
      originalStopLossPrice: 95,
      movedStopLossPrice: 100.15,
      movedAt: "2026-07-08T11:45:00.000Z",
      progressAtFire: 0.75,
      analyticalProgressAtFire: 0.8,
      liveAuthority: {
        protocol: "pacifica",
        basis: "last_trade_price",
        sourceFingerprint: fingerprint,
        positionEpochFingerprint: fingerprint,
        positionStateFingerprint: fingerprint,
        bracketFingerprint: fingerprint,
        sourceTimeMs: T0,
        readCompletedAtMs: T0 + 1,
        attemptId: "protective:decision-1:3",
        attemptOrdinal: 3,
        requestedTakeProfitPrice: 110,
        requestedStopLossPrice: 100.15,
        appliedTakeProfitPrice: 110,
        appliedStopLossPrice: 100.15,
        postCallVerified: true,
        postVerificationSourceFingerprint: fingerprint,
        postVerificationBracketFingerprint: fingerprint,
        postVerificationReadCompletedAtMs: T0 + 2,
        restorationOutcome: "not_needed",
      },
    }, 100.15, T0);
    expect(valid?.analyticalProgressAtFire).toBe(0.8);
    expect(valid?.liveAuthority?.attemptOrdinal).toBe(3);

    const malformed = parseBreakevenProtect({
      originalStopLossPrice: 95,
      movedStopLossPrice: 100.15,
      movedAt: "2026-07-08T11:45:00.000Z",
      progressAtFire: 0.75,
      analyticalProgressAtFire: Number.NaN,
      liveAuthority: { protocol: "pacifica", attemptOrdinal: 99 },
    }, 100.15, T0);
    expect(malformed).not.toHaveProperty("analyticalProgressAtFire");
    expect(malformed).not.toHaveProperty("liveAuthority");
  });
});

function sealLiveSnapshot(snapshot: LiveBreakevenNativeSnapshot): LiveBreakevenNativeSnapshot {
  const positionBody = {
    protocol: snapshot.protocol,
    account: snapshot.account,
    subaccountId: snapshot.subaccountId,
    internalSymbol: snapshot.internalSymbol,
    protocolSymbol: snapshot.protocolSymbol,
    position: snapshot.position,
  };
  const bracketBody = {
    protocol: snapshot.protocol,
    account: snapshot.account,
    subaccountId: snapshot.subaccountId,
    internalSymbol: snapshot.internalSymbol,
    protocolSymbol: snapshot.protocolSymbol,
    triggerBasisStatus: snapshot.triggerBasisStatus,
    protectiveOrders: snapshot.protectiveOrders,
  };
  const stateBody = {
    ...positionBody,
    positionLastOrderId: snapshot.positionLastOrderId,
    ordersLastOrderId: snapshot.ordersLastOrderId,
    triggerBasisStatus: snapshot.triggerBasisStatus,
    protectiveOrders: snapshot.protectiveOrders,
  };
  const sourceBody = {
    ...stateBody,
    readStartedAtMs: snapshot.readStartedAtMs,
    readCompletedAtMs: snapshot.readCompletedAtMs,
    recentTrades: snapshot.recentTrades,
  };
  snapshot.positionFingerprint = liveBreakevenFingerprint(positionBody);
  snapshot.bracketFingerprint = liveBreakevenFingerprint(bracketBody);
  snapshot.stateFingerprint = liveBreakevenFingerprint(stateBody);
  snapshot.sourceFingerprint = liveBreakevenFingerprint(sourceBody);
  return snapshot;
}

function validLiveSnapshot(nowMs = T0): LiveBreakevenNativeSnapshot {
  return sealLiveSnapshot({
    schemaVersion: 1,
    protocol: "pacifica",
    account: "pacifica-agent-1",
    subaccountId: null,
    internalSymbol: "SOL-PERP",
    protocolSymbol: "SOL",
    readStartedAtMs: nowMs - 100,
    readCompletedAtMs: nowMs,
    position: {
      sourceRecordId: "C".repeat(64),
      side: "long",
      baseSize: "2.00000000",
      entryPrice: "100.00000000",
    },
    positionLastOrderId: "41",
    ordersLastOrderId: "42",
    triggerBasisStatus: "last_trade_price",
    protectiveOrders: [
      {
        orderId: "41",
        orderAccount: "pacifica-agent-1",
        orderType: "stop_loss",
        side: "sell",
        triggerBasis: "last_trade_price",
        triggerPrice: "95.00000000",
        initialSize: "2.00000000",
        remainingSize: "2.00000000",
        reduceOnly: true,
      },
      {
        orderId: "42",
        orderAccount: "pacifica-agent-1",
        orderType: "take_profit",
        side: "sell",
        triggerBasis: "last_trade_price",
        triggerPrice: "110.00000000",
        initialSize: "2.00000000",
        remainingSize: "2.00000000",
        reduceOnly: true,
      },
    ],
    recentTrades: {
      lastOrderId: "4001",
      rows: [{
        symbol: "SOL",
        price: "107.50000000",
        createdAtMs: nowMs,
        sourceRecordFingerprint: "D".repeat(64),
      }],
    },
    positionFingerprint: "",
    bracketFingerprint: "",
    stateFingerprint: "",
    sourceFingerprint: "",
  });
}

function qualifySnapshot(
  snapshot: LiveBreakevenNativeSnapshot,
  nowMs = T0,
  candidateStopPrice = "100.15000000",
) {
  return qualifyLiveBreakevenAuthority({
    decisionId: "decision-1",
    botId: "bot-1",
    side: "long",
    candidateStopPrice,
    expectedEntryPrice: "100",
    expectedTakeProfitPrice: "110",
    expectedCurrentStopPrice: "95",
    analyticalProgress: 0.75,
    analyticalWindowFingerprint: "B".repeat(64),
    expectedAccount: "pacifica-agent-1",
    expectedInternalSymbol: "SOL-PERP",
    snapshot,
    nowMs,
  });
}

describe("qualifyLiveBreakevenAuthority", () => {
  it("authorizes an exact Pacifica LTP snapshot at both inclusive 75% thresholds", () => {
    const result = qualifySnapshot(validLiveSnapshot());
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.nativeProgress).toBe(0.75);
    expect(result.permit.binding.triggerBasis).toBe("last_trade_price");
    expect(result.permit.binding.positionEpochFingerprint).toBe("C".repeat(64));
    expect(result.permit.binding.expiresAtMs).toBe(T0 + 5_000);
    expect(result.permit.fingerprint).toBe(liveBreakevenFingerprint(result.permit.binding));
  });

  it("accepts an exactly five-second-old snapshot and rejects older or future snapshots", () => {
    expect(qualifySnapshot(validLiveSnapshot(T0 - 5_000), T0).authorized).toBe(true);
    expect(qualifySnapshot(validLiveSnapshot(T0 - 5_001), T0)).toEqual({ authorized: false, reason: "stale_snapshot" });
    expect(qualifySnapshot(validLiveSnapshot(T0 + 1), T0)).toEqual({ authorized: false, reason: "future_snapshot" });
    const futureAtReceipt = validLiveSnapshot();
    futureAtReceipt.recentTrades.rows[0].createdAtMs = T0 + 1;
    sealLiveSnapshot(futureAtReceipt);
    expect(qualifySnapshot(futureAtReceipt, T0 + 100)).toEqual({ authorized: false, reason: "future_snapshot" });
  });

  it("rejects equal-time conflicting trade prices", () => {
    const snapshot = validLiveSnapshot();
    snapshot.recentTrades.rows.push({
      symbol: "SOL",
      price: "107.50000001",
      createdAtMs: T0,
      sourceRecordFingerprint: "E".repeat(64),
    });
    sealLiveSnapshot(snapshot);
    expect(qualifySnapshot(snapshot)).toEqual({ authorized: false, reason: "ambiguous_trade" });
  });

  it("rejects unknown snapshot fields even when the known-field fingerprints are valid", () => {
    const snapshot = validLiveSnapshot() as LiveBreakevenNativeSnapshot & { unreviewed?: boolean };
    snapshot.unreviewed = true;
    expect(qualifySnapshot(snapshot)).toEqual({ authorized: false, reason: "malformed_snapshot" });
  });

  it("rejects number-coerced venue identities even when their fingerprints are recomputed", () => {
    const snapshot = validLiveSnapshot();
    (snapshot as unknown as { ordersLastOrderId: number }).ordersLastOrderId = 42;
    sealLiveSnapshot(snapshot);
    expect(qualifySnapshot(snapshot)).toEqual({ authorized: false, reason: "malformed_snapshot" });
  });

  it("keeps the bracket fingerprint stable across unrelated exchange nonce changes", () => {
    const snapshot = validLiveSnapshot();
    const bracket = snapshot.bracketFingerprint;
    const state = snapshot.stateFingerprint;
    snapshot.positionLastOrderId = "99";
    snapshot.ordersLastOrderId = "100";
    sealLiveSnapshot(snapshot);
    expect(snapshot.bracketFingerprint).toBe(bracket);
    expect(snapshot.stateFingerprint).not.toBe(state);
    expect(qualifySnapshot(snapshot).authorized).toBe(true);
  });

  it("rejects mixed trigger bases and a protective leg smaller than the position", () => {
    const mixedBasis = validLiveSnapshot();
    mixedBasis.protectiveOrders[0].triggerBasis = "target_internal_oracle";
    sealLiveSnapshot(mixedBasis);
    expect(qualifySnapshot(mixedBasis)).toEqual({ authorized: false, reason: "trigger_basis_mismatch" });

    const insufficient = validLiveSnapshot();
    insufficient.protectiveOrders[1].remainingSize = "1.99999999";
    sealLiveSnapshot(insufficient);
    expect(qualifySnapshot(insufficient)).toEqual({ authorized: false, reason: "protective_pair_not_proven" });
  });

  it("rejects native threshold misses, price retrace, and a forged state fingerprint", () => {
    const belowThreshold = validLiveSnapshot();
    belowThreshold.recentTrades.rows[0].price = "107.49999999";
    sealLiveSnapshot(belowThreshold);
    expect(qualifySnapshot(belowThreshold)).toEqual({ authorized: false, reason: "native_threshold_not_met" });

    const retraced = validLiveSnapshot();
    expect(qualifySnapshot(retraced, T0, "107.50000001")).toEqual({ authorized: false, reason: "price_retraced" });

    const forged = validLiveSnapshot();
    forged.stateFingerprint = "C".repeat(64);
    expect(qualifySnapshot(forged)).toEqual({ authorized: false, reason: "malformed_snapshot" });

    const malformedEpoch = validLiveSnapshot();
    malformedEpoch.position.sourceRecordId = "position-row-1";
    sealLiveSnapshot(malformedEpoch);
    expect(qualifySnapshot(malformedEpoch)).toEqual({ authorized: false, reason: "malformed_snapshot" });
  });

  it("rejects a candidate beyond the take-profit boundary", () => {
    const snapshot = validLiveSnapshot();
    snapshot.recentTrades.rows[0].price = "112.00000000";
    sealLiveSnapshot(snapshot);
    expect(qualifySnapshot(snapshot, T0, "111.00000000")).toEqual({
      authorized: false,
      reason: "candidate_outside_trade_range",
    });
  });

  it("rejects local decision prices that differ from the native position or bracket", () => {
    const snapshot = validLiveSnapshot();
    expect(qualifyLiveBreakevenAuthority({
      decisionId: "decision-1",
      botId: "bot-1",
      side: "long",
      candidateStopPrice: "100.15000000",
      expectedEntryPrice: "100",
      expectedTakeProfitPrice: "111",
      expectedCurrentStopPrice: "95",
      analyticalProgress: 0.75,
      analyticalWindowFingerprint: "B".repeat(64),
      expectedAccount: "pacifica-agent-1",
      expectedInternalSymbol: "SOL-PERP",
      snapshot,
      nowMs: T0,
    })).toEqual({ authorized: false, reason: "position_or_bracket_mismatch" });
  });
});

describe("favorableExtreme", () => {
  const candles = [candle(T0, 150, 155, 148, 152), candle(T0 + TF, 152, 158, 151, 157)];

  it("highest high for a long, lowest low for a short", () => {
    expect(favorableExtreme(candles, "long")).toBe(158);
    expect(favorableExtreme(candles, "short")).toBe(148);
  });

  it("null on empty input", () => {
    expect(favorableExtreme([], "long")).toBeNull();
  });
});

describe("progressTowardTp", () => {
  it("long: fraction of entry→TP covered by the high", () => {
    expect(progressTowardTp("long", 150, 160, 157.5)).toBeCloseTo(0.75, 10);
    expect(progressTowardTp("long", 150, 160, 161)).toBeCloseTo(1.1, 10);
  });

  it("short: fraction of entry→TP covered by the low", () => {
    expect(progressTowardTp("short", 150, 140, 142.5)).toBeCloseTo(0.75, 10);
  });

  it("0 on adverse-only travel and on degenerate brackets", () => {
    expect(progressTowardTp("long", 150, 160, 149)).toBe(0);
    expect(progressTowardTp("long", 150, 150, 155)).toBe(0); // zero distance
    expect(progressTowardTp("long", 150, 145, 155)).toBe(0); // TP below entry (long)
    expect(progressTowardTp("long", NaN, 160, 155)).toBe(0);
  });
});

describe("breakevenStopPrice / isFavorableSideOf / isTighterStop", () => {
  it("nudges the stop in the favorable direction by the buffer", () => {
    expect(breakevenStopPrice("long", 150)).toBeCloseTo(150 * (1 + BREAKEVEN_BUFFER_RATE), 10);
    expect(breakevenStopPrice("short", 150)).toBeCloseTo(150 * (1 - BREAKEVEN_BUFFER_RATE), 10);
  });

  it("buffer covers 2 taker legs + paper slippage (BE stop-out nets ≥ 0 on paper)", () => {
    // exit = newSl*(1-slip); net = (exit-entry)*size − fee*(entry+exit)*size must be ≥ 0
    const entry = 150;
    const exit = breakevenStopPrice("long", entry) * (1 - PAPER_SLIPPAGE_PER_LEG);
    const net = (exit - entry) - 0.0004 * (entry + exit);
    expect(net).toBeGreaterThan(0);
  });

  it("favorable side: strictly above for long, strictly below for short", () => {
    expect(isFavorableSideOf("long", 151, 150.5)).toBe(true);
    expect(isFavorableSideOf("long", 150.5, 150.5)).toBe(false);
    expect(isFavorableSideOf("short", 149, 149.5)).toBe(true);
  });

  it("one-way ratchet: candidate must be strictly tighter", () => {
    expect(isTighterStop("long", 150.225, 145)).toBe(true);
    expect(isTighterStop("long", 150.225, 152)).toBe(false); // AI already set tighter — never loosen
    expect(isTighterStop("long", 150.225, 150.225)).toBe(false);
    expect(isTighterStop("short", 149.775, 155)).toBe(true);
    expect(isTighterStop("short", 149.775, 148)).toBe(false);
  });
});

describe("paperBreakevenStopPrice", () => {
  it("proves non-negative net PnL through the real paper functions for long and short rates", () => {
    for (const side of ["long", "short"] as const) {
      for (const takerFeeRate of [0, 0.0004, 0.0014, 0.01]) {
        const result = paperBreakevenStopPrice(side, 150, takerFeeRate);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const exitPrice = paperExitPrice(result.stopPrice, side);
        expect(paperRealizedPnl({ side, entryPrice: 150, exitPrice, sizeBase: 1, takerFeeRate }).netPnl).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reproduces the exact AVAX fixed-buffer loss and proves the dynamic short floor", () => {
    const entryPrice = 7.32083775;
    const sizeBase = 817.95;
    const takerFeeRate = 0.0014;
    const fixedExit = paperExitPrice(breakevenStopPrice("short", entryPrice), "short");
    const fixed = paperRealizedPnl({ side: "short", entryPrice, exitPrice: fixedExit, sizeBase, takerFeeRate });
    expect(fixedExit).toBeCloseTo(7.313511421622, 12);
    expect(fixed.fees).toBeCloseTo(16.758232266899, 10);
    expect(fixed.netPnl).toBeCloseTo(-10.765661969858, 10);

    const dynamic = paperBreakevenStopPrice("short", entryPrice, takerFeeRate);
    expect(dynamic.ok).toBe(true);
    if (!dynamic.ok) return;
    const dynamicExit = paperExitPrice(dynamic.stopPrice, "short");
    expect(paperRealizedPnl({ side: "short", entryPrice, exitPrice: dynamicExit, sizeBase, takerFeeRate }).netPnl).toBeGreaterThanOrEqual(0);
  });

  it("rejects malformed fee inputs and keeps the correction seam bounded", () => {
    expect(paperBreakevenStopPrice("long", 150, Number.NaN)).toEqual({ ok: false, reason: "malformed_quote" });
    expect(paperBreakevenStopPrice("long", 150, -0.1)).toEqual({ ok: false, reason: "malformed_quote" });
    expect(paperBreakevenStopPrice("short", 150, 1)).toEqual({ ok: false, reason: "malformed_quote" });
    expect(paperBreakevenStopPrice("long", 150, 0.0014, MAX_PAPER_BREAKEVEN_ULP_CORRECTION_STEPS + 1)).toEqual({ ok: false, reason: "malformed_quote" });
  });

  it("fails shut when a zero-step proof cannot satisfy the exact postcondition", () => {
    // This ordinary-scale pair produces a tiny negative net result from the
    // closed-form candidate because of binary64 rounding. With correction
    // disabled, the helper must expose that it cannot prove the postcondition.
    const result = paperBreakevenStopPrice("long", 260999.1888202015, 0.000001, 0);
    expect(result).toEqual({ ok: false, reason: "numerical_postcondition_unproven" });
  });
});

describe("evaluatePaperBracketWithMove", () => {
  // long, entry 150, original SL 145, moved SL 150.225, TP 160
  const ORIG = 145;
  const MOVED = 150.225;
  const TP = 160;
  const MOVE_OPEN = T0 + 2 * TF; // candle DURING which the move happened

  it("a pre-move dip below the MOVED stop (but above the original) does NOT trigger", () => {
    const candles = [
      candle(T0 + TF, 150, 151, 148, 150.5), // below moved SL, above original — pre-move
      candle(MOVE_OPEN, 150.5, 152, 150.4, 151), // move candle: still original SL
      candle(MOVE_OPEN + TF, 151, 152, 150.5, 151.5), // post-move: above moved SL
    ];
    expect(evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN)).toBeNull();
  });

  it("the move candle itself (time === boundary) still tests the ORIGINAL stop", () => {
    const candles = [candle(MOVE_OPEN, 151, 152, 150.0, 151)]; // low < moved SL but > original
    expect(evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN)).toBeNull();
  });

  it("a strictly-later candle triggers on the MOVED stop", () => {
    const candles = [candle(MOVE_OPEN + TF, 151, 152, 150.0, 151.8)];
    const hit = evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN);
    expect(hit).not.toBeNull();
    expect(hit!.leg).toBe("sl");
    expect(hit!.exitPrice).toBeCloseTo(MOVED * (1 - PAPER_SLIPPAGE_PER_LEG), 10);
  });

  it("chronology: a pre-move ORIGINAL-stop hit wins over a later moved-stop hit", () => {
    const candles = [
      candle(T0 + TF, 150, 151, 144, 146), // original SL 145 touched pre-move
      candle(MOVE_OPEN + TF, 146, 152, 150.0, 151), // would also touch moved SL
    ];
    const hit = evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN);
    expect(hit!.candleTime).toBe(T0 + TF);
    expect(hit!.exitPrice).toBeCloseTo(ORIG * (1 - PAPER_SLIPPAGE_PER_LEG), 10);
  });

  it("TP still triggers normally after the move", () => {
    const candles = [candle(MOVE_OPEN + TF, 151, 160.5, 150.5, 160.2)];
    const hit = evaluatePaperBracketWithMove(candles, "long", ORIG, MOVED, TP, MOVE_OPEN);
    expect(hit!.leg).toBe("tp");
  });
});

describe("countsAsSlLoss (G8 predicate)", () => {
  it("SL exit with negative PnL counts", () => {
    expect(countsAsSlLoss("sl", -12.5)).toBe(true);
  });

  it("SL exit with POSITIVE PnL (breakeven-protect stop-out) does NOT count", () => {
    expect(countsAsSlLoss("sl", 0.06)).toBe(false);
    expect(countsAsSlLoss("sl", 0)).toBe(false);
  });

  it("unknown PnL on an SL exit still counts (fail closed)", () => {
    expect(countsAsSlLoss("sl", null)).toBe(true);
    expect(countsAsSlLoss("sl", undefined)).toBe(true);
    expect(countsAsSlLoss("sl", NaN)).toBe(true);
  });

  it("non-SL exits never count", () => {
    expect(countsAsSlLoss("tp", -5)).toBe(false);
    expect(countsAsSlLoss("circuit_breaker", -50)).toBe(false);
    expect(countsAsSlLoss(null, -5)).toBe(false);
  });
});
