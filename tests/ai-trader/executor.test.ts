// WO-5 acceptance: unit tests for server/ai-trader/executor.ts — the execution
// layer. Storage, session-v3 crypto and notifications are mocked (decide.test.ts
// pattern); paper-math runs for real (pure). Covers: entry-shape refusals, G6
// cooldown/daily-cap enforcement on both paths, the paper fill (adverse
// slippage, no adapter/key access), the live happy path with binding step
// ordering (executing-status BEFORE order, bracket AFTER confirm, G10 verify),
// capability pre-flight, G15 pause, G11 funding abort, clean order rejection,
// unconfirmed-position emergency close, bracket-failure emergency close with
// honest executed+exit recording, and key/UMK cleanup on every exit path.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import type { ClampedDecision } from "../../server/ai-trader/guardrails";
import { PAPER_SLIPPAGE_PER_LEG } from "../../server/ai-trader/paper-math";

const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const updateBotMock = vi.fn();
const updateDecisionMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    updateAiTraderDecision: (...a: unknown[]) => updateDecisionMock(...a),
  },
}));

const getUmkMock = vi.fn();
const decryptKeyMock = vi.fn();
const decryptSubKeyMock = vi.fn();
const verifyHmacMock = vi.fn();
const healUmkMock = vi.fn();
vi.mock("../../server/session-v3", () => ({
  getUmkForWebhook: (...a: unknown[]) => getUmkMock(...a),
  decryptAgentKeyStrict: (...a: unknown[]) => decryptKeyMock(...a),
  // WO-7.1: signing.ts resolves the bot's OWN subaccount key through this.
  decryptBotSubaccountKey: (...a: unknown[]) => decryptSubKeyMock(...a),
  verifyBotPolicyHmac: (...a: unknown[]) => verifyHmacMock(...a),
  healExecutionUmkFromStorage: (...a: unknown[]) => healUmkMock(...a),
}));

const notifyMock = vi.fn();
vi.mock("../../server/notification-service", () => ({
  sendTradeNotification: (...a: unknown[]) => notifyMock(...a),
}));

// --- Fixtures -----------------------------------------------------------------

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z — mid-day UTC

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "bot-1111-2222",
    walletAddress: "WALLET_X",
    protocol: "pacifica",
    // WO-7.1 live-funded bot: has its own venue subaccount + V3 sub-key material.
    // Live orders are signed AS this subaccount (adapter subaccountId stays undefined).
    protocolSubaccountId: "sub-1",
    botSubaccountKeyEncryptedV3: "v3-sub-ciphertext",
    derivationIndex: null,
    derivationPathVersion: null,
    market: "SOL-PERP",
    timeframe: "15m",
    mode: "auto",
    paperMode: true,
    stopPolicy: "static",
    allocatedUsdc: "1000",
    maxLeverage: 5,
    policyHmac: "hmac-abc",
    status: "analyzing",
    ...overrides,
  } as unknown as AiTraderBot;
}

function makeClamped(overrides: Partial<ClampedDecision> = {}): ClampedDecision {
  return {
    action: "long",
    entryType: "market",
    leverage: 2,
    sizePct: 50,
    marginUsdc: 500,
    notionalUsdc: 1000,
    sizeBase: 6.66,
    stopLossPrice: 145,
    takeProfitPrice: 160,
    confidence: 7,
    invalidation: "loses 145 support",
    rationale: "uptrend continuation",
    ...overrides,
  };
}

/** Call-order recorder shared by the storage + adapter mocks in live tests. */
let callOrder: string[];

function makeAdapter(overrides: Record<string, unknown> = {}): ProtocolAdapter {
  return {
    getBalances: vi.fn(async () => {
      callOrder.push("getBalances");
      return { totalEquity: 1000, freeCollateral: 900, totalMarginUsed: 0, unrealizedPnl: 0 };
    }),
    setLeverage: vi.fn(async () => {
      callOrder.push("setLeverage");
    }),
    placeMarketOrder: vi.fn(async () => {
      callOrder.push("placeMarketOrder");
      return { success: true, status: "filled", fillPrice: 150.2, orderId: "o-1" };
    }),
    getPositions: vi.fn(async () => {
      callOrder.push("getPositions");
      return [
        { internalSymbol: "SOL-PERP", baseSize: 6.66, entryPrice: 150.21, markPrice: 150.2, unrealizedPnl: 0, leverage: 2 },
      ];
    }),
    setTpSl: vi.fn(async () => {
      callOrder.push("setTpSl");
      return { success: true, status: "acknowledged", appliedStopLossPrice: 145, appliedTakeProfitPrice: 160 };
    }),
    getOpenStopOrders: vi.fn(async () => {
      callOrder.push("getOpenStopOrders");
      return [{ order_id: "st-1", symbol: "SOL-PERP" }];
    }),
    closePosition: vi.fn(async () => {
      callOrder.push("closePosition");
      return { success: true, status: "filled", fillPrice: 150.0 };
    }),
    ...overrides,
  } as unknown as ProtocolAdapter;
}

const AGENT_PUBKEY = "AgEntPubKey1111111111111111111111111111111";
let cleanupUmk: ReturnType<typeof vi.fn>;
let cleanupKey: ReturnType<typeof vi.fn>;

function armLiveAuth() {
  getWalletMock.mockResolvedValue({
    address: "WALLET_X",
    agentPublicKey: AGENT_PUBKEY,
    agentPrivateKeyEncryptedV3: "v3-envelope",
    emergencyStopTriggered: false,
  });
  cleanupUmk = vi.fn();
  cleanupKey = vi.fn();
  getUmkMock.mockResolvedValue({ umk: Buffer.from("umk"), cleanup: cleanupUmk });
  verifyHmacMock.mockReturnValue(true);
  // Sub-key bot (default fixture) resolves its own subaccount signer; the legacy
  // main-agent-key path (protocolSubaccountId=null) resolves via decryptAgentKeyStrict.
  decryptSubKeyMock.mockResolvedValue({ secretKey: new Uint8Array([4, 5, 6]), cleanup: cleanupKey });
  decryptKeyMock.mockResolvedValue({ secretKey: new Uint8Array([1, 2, 3]), cleanup: cleanupKey });
}

async function importExecutor() {
  return await import("../../server/ai-trader/executor");
}

const closedAt = (msAgo: number): Pick<AiTraderDecision, "closedAt"> =>
  ({ closedAt: new Date(NOW - msAgo) }) as Pick<AiTraderDecision, "closedAt">;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  callOrder = [];
  for (const m of [getWalletMock, getRecentClosedMock, updateBotMock, updateDecisionMock, getUmkMock, decryptKeyMock, decryptSubKeyMock, verifyHmacMock, healUmkMock, notifyMock]) {
    m.mockReset();
  }
  getRecentClosedMock.mockResolvedValue([]);
  updateBotMock.mockResolvedValue({});
  updateDecisionMock.mockResolvedValue({});
  notifyMock.mockResolvedValue(true);
  healUmkMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Entry-shape refusals -------------------------------------------------------

describe("executeDecision — entry-shape refusals", () => {
  it("refuses non-entry actions (close/flat) without touching storage writes", async () => {
    const { executeDecision } = await importExecutor();
    for (const action of ["close", "flat"] as const) {
      const r = await executeDecision({
        bot: makeBot(),
        decisionId: "d-1",
        clamped: makeClamped({ action }),
        adapter: makeAdapter(),
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "not_entry" });
    }
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("refuses to stack an entry on a bot that holds (or may hold) a position", async () => {
    const { executeDecision } = await importExecutor();
    for (const status of ["open", "executing", "proposed"] as const) {
      const adapter = makeAdapter();
      const r = await executeDecision({
        bot: makeBot({ status, paperMode: false }),
        decisionId: "d-1",
        clamped: makeClamped(),
        adapter,
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "bot_busy" });
      expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    }
    // idle/analyzing bots proceed past the guard (paper bot hits G6 next, which passes).
    const ok = await executeDecision({
      bot: makeBot({ status: "idle", paperMode: true }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(ok).toMatchObject({ ok: true, mode: "paper" });
  });

  it("refuses a ClampedDecision with missing/invalid numeric fields", async () => {
    const { executeDecision } = await importExecutor();
    const bad: Partial<ClampedDecision>[] = [
      { sizeBase: undefined },
      { sizeBase: 0 },
      { marginUsdc: NaN },
      { leverage: 0 },
      { stopLossPrice: undefined },
      { takeProfitPrice: -1 },
    ];
    for (const overrides of bad) {
      const r = await executeDecision({
        bot: makeBot(),
        decisionId: "d-1",
        clamped: makeClamped(overrides),
        adapter: makeAdapter(),
        markPrice: 150,
      });
      expect(r).toMatchObject({ ok: false, reason: "invalid_clamp" });
    }
  });
});

// --- G6 -------------------------------------------------------------------------

describe("G6 — cooldown and daily caps (checkCooldownAndCaps + executeDecision wiring)", () => {
  it("pure: cooldown fires when the last close is younger than one candle", async () => {
    const { checkCooldownAndCaps } = await importExecutor();
    // 15m candle = 900s. Closed 5 min ago → cooldown.
    expect(checkCooldownAndCaps("15m", [closedAt(5 * 60_000)], NOW)).toMatchObject({
      ok: false,
      reason: "cooldown_active",
    });
    // Closed exactly one candle ago → clear.
    expect(checkCooldownAndCaps("15m", [closedAt(900_000)], NOW)).toEqual({ ok: true });
  });

  it("pure: LTF cap 6/day, HTF cap 2/day, counted from UTC midnight", async () => {
    const { checkCooldownAndCaps } = await importExecutor();
    // 6 closes earlier today (oldest far enough back to clear cooldown).
    const sixToday = [3, 4, 5, 6, 7, 8].map((h) => closedAt(h * 3_600_000));
    expect(checkCooldownAndCaps("15m", sixToday, NOW)).toMatchObject({ ok: false, reason: "daily_cap_reached" });
    // 5 today → allowed.
    expect(checkCooldownAndCaps("15m", sixToday.slice(1), NOW)).toEqual({ ok: true });
    // HTF: 2 closes today trips the cap even on 4h…
    const twoToday = [5, 9].map((h) => closedAt(h * 3_600_000));
    expect(checkCooldownAndCaps("4h", twoToday, NOW)).toMatchObject({ ok: false, reason: "daily_cap_reached" });
    // …but the same 2 closes YESTERDAY don't count (NOW is 12:00 UTC; 13h+ ago is pre-midnight).
    const twoYesterday = [13, 20].map((h) => closedAt(h * 3_600_000));
    expect(checkCooldownAndCaps("4h", twoYesterday, NOW)).toEqual({ ok: true });
  });

  it("pure: unknown timeframe fails CLOSED", async () => {
    const { checkCooldownAndCaps } = await importExecutor();
    expect(checkCooldownAndCaps("3m", [], NOW)).toMatchObject({ ok: false, reason: "cooldown_active" });
  });

  it("G6 is enforced on the PAPER path too (paper feeds graduation stats)", async () => {
    getRecentClosedMock.mockResolvedValue([closedAt(60_000)]);
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: true }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "cooldown_active" });
    expect(getRecentClosedMock).toHaveBeenCalledWith("bot-1111-2222", 30);
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });
});

// --- Paper path -------------------------------------------------------------------

describe("paper execution", () => {
  it("long paper entry fills at mark + adverse slippage; decision + bot updated; NO adapter or key access", async () => {
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: true }),
      decisionId: "d-paper",
      clamped: makeClamped({ action: "long" }),
      adapter,
      markPrice: 150,
    });
    const expectedEntry = 150 * (1 + PAPER_SLIPPAGE_PER_LEG);
    expect(r).toEqual({ ok: true, mode: "paper", entryPrice: expectedEntry });
    expect(updateDecisionMock).toHaveBeenCalledWith("d-paper", {
      outcome: "executed",
      entryPrice: expectedEntry.toFixed(8),
    });
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "open", pauseReason: null });
    // Paper must never touch the venue or the key material.
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect((adapter.setTpSl as any)).not.toHaveBeenCalled();
    expect(getWalletMock).not.toHaveBeenCalled();
    expect(getUmkMock).not.toHaveBeenCalled();
    expect(verifyHmacMock).not.toHaveBeenCalled();
  });

  it("short paper entry slips DOWN (adverse for a seller)", async () => {
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: true }),
      decisionId: "d-paper-s",
      clamped: makeClamped({ action: "short", stopLossPrice: 155, takeProfitPrice: 140 }),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toEqual({ ok: true, mode: "paper", entryPrice: 150 * (1 - PAPER_SLIPPAGE_PER_LEG) });
  });

  it("refuses a paper entry without a usable mark price", async () => {
    const { executeDecision } = await importExecutor();
    for (const mark of [0, NaN, -1]) {
      const r = await executeDecision({
        bot: makeBot({ paperMode: true }),
        decisionId: "d-paper",
        clamped: makeClamped(),
        adapter: makeAdapter(),
        markPrice: mark,
      });
      expect(r).toMatchObject({ ok: false, reason: "invalid_mark" });
    }
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });
});

// --- Live path: pre-flight refusals ------------------------------------------------

describe("live execution — pre-flight", () => {
  it("capability pre-flight: adapter without setTpSl/getOpenStopOrders refuses BEFORE any order or key access", async () => {
    const adapter = makeAdapter({ setTpSl: undefined });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false, protocol: "flash" }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "capability_missing" });
    expect(getWalletMock).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
  });

  it("auth_unavailable when the wallet has no V3 envelope", async () => {
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: null, agentPrivateKeyEncryptedV3: null });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
  });

  it("auth_unavailable when execution authorization (UMK) is off", async () => {
    getWalletMock.mockResolvedValue({
      address: "WALLET_X",
      agentPublicKey: AGENT_PUBKEY,
      agentPrivateKeyEncryptedV3: "v3-envelope",
      emergencyStopTriggered: false,
    });
    getUmkMock.mockResolvedValue(null);
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
  });

  it("G15: policy HMAC mismatch pauses the bot, records aborted_policy, notifies, sends NOTHING", async () => {
    armLiveAuth();
    verifyHmacMock.mockReturnValue(false);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "policy_hmac_mismatch" });
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "paused", pauseReason: "policy_hmac_mismatch" });
    expect(updateDecisionMock).toHaveBeenCalledWith("d-1", { outcome: "aborted_policy" });
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
    expect((adapter.setLeverage as any)).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    // Policy object single-sources from the bot row.
    expect(verifyHmacMock).toHaveBeenCalledWith(
      expect.anything(),
      { market: "SOL-PERP", leverage: 5, maxPositionSize: "1000" },
      "hmac-abc"
    );
    expect(cleanupUmk).toHaveBeenCalled();
  });

  it("G11: insufficient free collateral records aborted_funding and returns the bot to idle", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      getBalances: vi.fn(async () => ({ totalEquity: 100, freeCollateral: 499.99, totalMarginUsed: 0, unrealizedPnl: 0 })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped({ marginUsdc: 500 }),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "insufficient_funding" });
    expect(updateDecisionMock).toHaveBeenCalledWith("d-1", { outcome: "aborted_funding" });
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "idle" });
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect(cleanupUmk).toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });
});

// --- Live path: happy path ---------------------------------------------------------

describe("live execution — happy path", () => {
  it("full flow in binding order; decision executed with venue fill price; bot open; keys cleaned up", async () => {
    armLiveAuth();
    updateBotMock.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
      callOrder.push(`updateBot:${updates.status}`);
      return {};
    });
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-live",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toEqual({ ok: true, mode: "live", entryPrice: 150.2 });

    // Binding WO-5 ordering: crash marker BEFORE leverage/order; bracket AFTER
    // position confirm; G10 verification last.
    expect(callOrder).toEqual([
      "getBalances",
      "updateBot:executing",
      "setLeverage",
      "placeMarketOrder",
      "getPositions",
      "setTpSl",
      "getOpenStopOrders",
      "updateBot:open",
    ]);

    // WO-7.1 signing model: the signed account IS the bot's own subaccount pubkey
    // (Phase 4b), and the unsigned adapter `subaccountId` param stays undefined.
    expect((adapter.placeMarketOrder as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPublicKey: "sub-1",
        mainWalletAddress: "WALLET_X",
        internalSymbol: "SOL-PERP",
        side: "long",
        sizeBase: 6.66,
        clientOrderId: "aitrader-d-live",
        subaccountId: undefined,
        maxSlippagePct: 0.5,
        leverage: 2,
      })
    );
    expect((adapter.setTpSl as any)).toHaveBeenCalledWith(
      expect.objectContaining({ stopLossPrice: 145, takeProfitPrice: 160, subaccountId: undefined })
    );
    // The sub key signed — the main agent key was never decrypted.
    expect(decryptSubKeyMock).toHaveBeenCalled();
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).toHaveBeenCalledWith("d-live", {
      outcome: "executed",
      entryPrice: "150.20000000",
    });
    expect(updateBotMock).toHaveBeenLastCalledWith("bot-1111-2222", { status: "open", pauseReason: null });
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_executed", side: "LONG" }));
    expect(cleanupUmk).toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("falls back to the confirmed position's entryPrice when the order result has no fill price", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: true, status: "acknowledged" as const })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-live",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toEqual({ ok: true, mode: "live", entryPrice: 150.21 });
  });
});

// --- Live path: failure handling ----------------------------------------------------

describe("live execution — failure handling (fail closed)", () => {
  it("clean order rejection (confirmed flat) → aborted_order, bot idle, NO pause, NO close", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "px band" })),
      getPositions: vi.fn(async () => []),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "order_failed" });
    expect(updateDecisionMock).toHaveBeenCalledWith("d-1", { outcome: "aborted_order" });
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "idle" });
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("setLeverage throw → STRUCTURED clean abort (aborted_order, idle), never a raw throw stranding 'executing'", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setLeverage: vi.fn(async () => {
        throw new Error("venue 500");
      }),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "order_failed" });
    expect((r as any).detail).toContain("setLeverage failed before any order was sent");
    expect(updateDecisionMock).toHaveBeenCalledWith("d-1", { outcome: "aborted_order" });
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "idle" });
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    expect((adapter.closePosition as any)).not.toHaveBeenCalled();
    expect(cleanupUmk).toHaveBeenCalled();
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("order rejection with UNPROVABLE flat state → emergency close + pause (fail closed)", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      placeMarketOrder: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "timeout" })),
      getPositions: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "paused", pauseReason: "position_unconfirmed" });
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
  });

  it("position never appears after a successful order → retries 3×/2s, then emergency close + pause", async () => {
    armLiveAuth();
    const getPositionsMock = vi.fn(async () => []);
    const adapter = makeAdapter({ getPositions: getPositionsMock });
    const { executeDecision } = await importExecutor();
    const promise = executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await promise;
    expect(r).toMatchObject({ ok: false, reason: "position_unconfirmed" });
    expect(getPositionsMock).toHaveBeenCalledTimes(3);
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "paused", pauseReason: "position_unconfirmed" });
    // Entry MAY have filled (order said success): recorded honestly as executed
    // with the failure exit, using the close fill.
    expect(updateDecisionMock).toHaveBeenCalledWith(
      "d-1",
      expect.objectContaining({ outcome: "executed", entryPrice: "150.20000000", exitReason: "position_unconfirmed" })
    );
  });

  it("setTpSl failure → position closed at market, bot paused bracket_failed, decision executed with exit", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "wrong side" })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "paused", pauseReason: "bracket_failed" });
    expect(updateDecisionMock).toHaveBeenCalledWith(
      "d-1",
      expect.objectContaining({
        outcome: "executed",
        entryPrice: "150.20000000",
        exitPrice: "150.00000000",
        exitReason: "bracket_failed",
        closedAt: expect.any(Date),
      })
    );
    expect(notifyMock).toHaveBeenCalledWith("WALLET_X", expect.objectContaining({ type: "trade_failed" }));
  });

  it("setTpSl 'success' that DROPPED the SL leg is a bracket failure (naked-position guard)", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({
        success: true,
        status: "acknowledged" as const,
        droppedLegs: [{ leg: "sl" as const, reason: "wrong side of mark" }],
      })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((adapter.closePosition as any)).toHaveBeenCalled();
  });

  it("a dropped TP leg alone is survivable (position stays stop-protected)", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({
        success: true,
        status: "acknowledged" as const,
        droppedLegs: [{ leg: "tp" as const, reason: "wrong side of mark" }],
      })),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: true, mode: "live" });
  });

  it("G10: bracket acknowledged but never visible on the venue → retries, then close + pause", async () => {
    armLiveAuth();
    const stopsMock = vi.fn(async () => []);
    const adapter = makeAdapter({ getOpenStopOrders: stopsMock });
    const { executeDecision } = await importExecutor();
    const promise = executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await promise;
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect(stopsMock).toHaveBeenCalledTimes(3);
    expect((adapter.closePosition as any)).toHaveBeenCalled();
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "paused", pauseReason: "bracket_failed" });
  });

  it("emergency close FAILURE never masks the original failure and screams in the notification", async () => {
    armLiveAuth();
    const adapter = makeAdapter({
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected" as const, error: "boom" })),
      closePosition: vi.fn(async () => {
        throw new Error("close also failed");
      }),
    });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "bracket_failed" });
    expect((r as any).detail).toContain("EMERGENCY CLOSE FAILED");
    expect(updateBotMock).toHaveBeenCalledWith("bot-1111-2222", { status: "paused", pauseReason: "bracket_failed" });
    expect(notifyMock).toHaveBeenCalledWith(
      "WALLET_X",
      expect.objectContaining({ error: expect.stringContaining("AUTOMATIC CLOSE FAILED") })
    );
    // Entry recorded without a fabricated exit (close never filled).
    expect(updateDecisionMock).toHaveBeenCalledWith(
      "d-1",
      expect.objectContaining({ outcome: "executed", exitReason: "bracket_failed" })
    );
    const args = updateDecisionMock.mock.calls.find((c) => c[0] === "d-1")![1];
    expect(args.exitPrice).toBeUndefined();
  });

  it("sub-key decrypt failure heals the execution UMK once and retries; both cleanups still run", async () => {
    armLiveAuth();
    decryptSubKeyMock
      .mockResolvedValueOnce(null) // first attempt fails
      .mockResolvedValueOnce({ secretKey: new Uint8Array([9]), cleanup: cleanupKey });
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter: makeAdapter(),
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: true, mode: "live" });
    expect(healUmkMock).toHaveBeenCalledWith("WALLET_X");
    expect(getUmkMock).toHaveBeenCalledTimes(2);
    expect(cleanupUmk).toHaveBeenCalled(); // first UMK cleaned before re-fetch
    expect(cleanupKey).toHaveBeenCalled();
  });

  it("sub-key heal + retry both failing → auth_unavailable, NEVER downgrades to the main agent key", async () => {
    armLiveAuth();
    decryptSubKeyMock.mockResolvedValue(null);
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
    // Money-safety invariant: a subaccount bot must NEVER fall back to signing
    // with the main agent key (that would trade the user's main account).
    expect(decryptKeyMock).not.toHaveBeenCalled();
  });

  it("bot with a subaccount but NO key material refuses to sign (fail closed)", async () => {
    armLiveAuth();
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false, botSubaccountKeyEncryptedV3: null, derivationIndex: null, derivationPathVersion: null }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: false, reason: "auth_unavailable" });
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect((adapter.placeMarketOrder as any)).not.toHaveBeenCalled();
  });

  it("legacy founder-canary bot (no subaccount) still signs with the main agent key", async () => {
    armLiveAuth();
    const adapter = makeAdapter();
    const { executeDecision } = await importExecutor();
    const r = await executeDecision({
      bot: makeBot({ paperMode: false, protocolSubaccountId: null, botSubaccountKeyEncryptedV3: null }),
      decisionId: "d-1",
      clamped: makeClamped(),
      adapter,
      markPrice: 150,
    });
    expect(r).toMatchObject({ ok: true, mode: "live" });
    expect(decryptKeyMock).toHaveBeenCalled();
    expect(decryptSubKeyMock).not.toHaveBeenCalled();
    // Legacy path signs for and reads the MAIN agent account.
    expect((adapter.placeMarketOrder as any)).toHaveBeenCalledWith(
      expect.objectContaining({ agentPublicKey: AGENT_PUBKEY, subaccountId: undefined })
    );
  });
});

// --- Policy-object helper ------------------------------------------------------------

describe("aiTraderPolicyObject (G15 single source for WO-7 creation + executor verify)", () => {
  it("maps market / maxLeverage / allocatedUsdc exactly", async () => {
    const { aiTraderPolicyObject } = await importExecutor();
    expect(aiTraderPolicyObject(makeBot())).toEqual({
      market: "SOL-PERP",
      leverage: 5,
      maxPositionSize: "1000",
    });
  });
});
