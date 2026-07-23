// WO-6 acceptance: unit tests for server/ai-trader/monitor.ts — the position
// monitor + lifecycle loop. Storage, session-v3 crypto, notifications, the
// adapter registry, datafeed, context-builder, decide and executeDecision are
// mocked (executor.test.ts conventions); paper-math and graduation run for
// real (pure). Covers: open-decision parsing, live exit classification and
// fill extraction (pure), paper close detection (entry-candle exclusion,
// forming candle inclusion, fee math), the G7 mark-to-market breaker on both
// paths, live close classification (SL / unattributable ⇒ liquidation pause),
// read-failure fail-closed behaviour (getPositions/getTradeHistory throw ⇒ no
// close recorded), G10 bracket re-verification (re-place once, close+pause on
// the second miss or unverified re-place), G8 consecutive-SL and the always-on
// malfunction ceiling, graduation on paper close + the periodic sweep, the
// auto-next cycle gates (G6 before LLM spend, reauth_required / no_api_key
// pauses, stale-context reschedule, happy-path execution), and startup
// reconciliation (paper reset, live flat reset, bracket completion, orphan
// position fail-closed flatten, venue-read-failure retry signal).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import type { TradeRecord } from "../../server/protocol/protocol-types";
import { PAPER_SLIPPAGE_PER_LEG } from "../../server/ai-trader/paper-math";

const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const updateBotMock = vi.fn();
const updateDecisionMock = vi.fn();
const getDecisionsMock = vi.fn();
const getBotMock = vi.fn();
const getActiveBotsMock = vi.fn();
const getLlmCiphertextMock = vi.fn();
const getAiTraderDecisionMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    updateAiTraderDecision: (...a: unknown[]) => updateDecisionMock(...a),
    getAiTraderDecisions: (...a: unknown[]) => getDecisionsMock(...a),
    getAiTraderBot: (...a: unknown[]) => getBotMock(...a),
    getActiveAiTraderBots: (...a: unknown[]) => getActiveBotsMock(...a),
    getWalletLlmApiKeyCiphertext: (...a: unknown[]) => getLlmCiphertextMock(...a),
    getAiTraderDecision: (...a: unknown[]) => getAiTraderDecisionMock(...a),
  },
}));

const getUmkMock = vi.fn();
const decryptKeyMock = vi.fn();
const decryptSubKeyMock = vi.fn();
const healUmkMock = vi.fn();
const getSessionByWalletMock = vi.fn();
const restoreSecurityMock = vi.fn();
const decryptLlmKeyMock = vi.fn();
vi.mock("../../server/session-v3", () => ({
  getUmkForWebhook: (...a: unknown[]) => getUmkMock(...a),
  decryptAgentKeyStrict: (...a: unknown[]) => decryptKeyMock(...a),
  // WO-7.1: signing.ts resolves the bot's OWN subaccount key through this.
  decryptBotSubaccountKey: (...a: unknown[]) => decryptSubKeyMock(...a),
  healExecutionUmkFromStorage: (...a: unknown[]) => healUmkMock(...a),
  getSessionByWalletAddress: (...a: unknown[]) => getSessionByWalletMock(...a),
  restoreWalletSecurityFromStorage: (...a: unknown[]) => restoreSecurityMock(...a),
  decryptLlmApiKeyV3: (...a: unknown[]) => decryptLlmKeyMock(...a),
  // executor's real module (imported for checkCooldownAndCaps) also pulls this:
  verifyBotPolicyHmac: vi.fn(() => true),
  // WO-B: scanner bot mode — monitor recomputes policyHmac for each picked market.
  computeBotPolicyHmac: vi.fn(() => "hmac-scanner-recomputed"),
}));

const notifyMock = vi.fn();
vi.mock("../../server/notification-service", () => ({
  sendTradeNotification: (...a: unknown[]) => notifyMock(...a),
  getCloseReasonLabel: (source: string, leg?: string) => (leg ? `${leg} Hit` : source === "liquidation" ? "Liquidated" : source),
}));

const getAdapterMock = vi.fn();
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...a),
}));

const fetchOHLCVMock = vi.fn();
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: (...a: unknown[]) => fetchOHLCVMock(...a),
  // Mirror the real duck-typed guard so production code paths that classify
  // candle-fetch errors keep working under this mock.
  isCacheDegradedError: (err: unknown) =>
    (err as { name?: string } | null)?.name === "CacheDegradedError",
}));

const buildContextMock = vi.fn();
vi.mock("../../server/ai-trader/context-builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-trader/context-builder")>();
  return {
    ...actual,
    buildMarketContext: (...a: unknown[]) => buildContextMock(...a),
  };
});

const runDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/decide", () => ({
  runDecision: (...a: unknown[]) => runDecisionMock(...a),
}));

const executeDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-trader/executor")>();
  return {
    ...actual,
    executeDecision: (...a: unknown[]) => executeDecisionMock(...a),
  };
});

// --- Fixtures -----------------------------------------------------------------

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z — 15m boundary
const TF_15M = 900_000;
const DAY = 86_400_000;
const ENTRY_CANDLE_OPEN = NOW - 2 * TF_15M; // decidedAt 11:30 → entry candle 11:30

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "bot-1111-2222",
    walletAddress: "WALLET_X",
    protocol: "pacifica",
    // WO-7.1 live-funded bot: own venue subaccount + V3 sub-key material.
    protocolSubaccountId: "sub-1",
    botSubaccountKeyEncryptedV3: "v3-sub-ciphertext",
    derivationIndex: null,
    derivationPathVersion: null,
    market: "SOL-PERP",
    timeframe: "15m",
    model: "anthropic/claude-opus-4.8",
    mode: "manual",
    paperMode: true,
    riskProfile: "guarded",
    autoNext: false,
    allocatedUsdc: "1000",
    maxLeverage: 5,
    policyHmac: "hmac-abc",
    status: "open",
    graduationState: "in_trial",
    graduationCriteria: { periodDays: 7, minTrades: 3, minNetPnl: 0, maxDrawdownPct: 30, minProfitFactor: 1.1 },
    trialStartedAt: new Date(NOW - 10 * DAY),
    dailyRealizedPnl: "0",
    consecutiveLosses: 0,
    ...overrides,
  } as unknown as AiTraderBot;
}

function makeOpenDecision(overrides: Partial<Record<string, unknown>> = {}): AiTraderDecision {
  return {
    id: "dec-1",
    botId: "bot-1111-2222",
    outcome: "executed",
    closedAt: null,
    decidedAt: new Date(ENTRY_CANDLE_OPEN),
    entryPrice: "150",
    clampedDecision: {
      action: "long",
      sizeBase: 2,
      marginUsdc: 100,
      stopLossPrice: 145,
      takeProfitPrice: 160,
    },
    ...overrides,
  } as unknown as AiTraderDecision;
}

function candle(time: number, open: number, high: number, low: number, close: number) {
  return { time, open, high, low, close, volume: 100 };
}

function makeAdapter(overrides: Record<string, unknown> = {}): ProtocolAdapter {
  return {
    getPositions: vi.fn(async () => []),
    getTradeHistory: vi.fn(async () => []),
    getOpenStopOrders: vi.fn(async () => [{ order_id: "st-1", symbol: "SOL-PERP" }]),
    setTpSl: vi.fn(async () => ({ success: true, status: "acknowledged" })),
    cancelTpSlOrders: vi.fn(async () => ({ success: true })),
    closePosition: vi.fn(async () => ({ success: true, status: "filled", fillPrice: 150.0 })),
    getPrice: vi.fn(async () => 150),
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
  // Sub-key bot (default fixture) signs with its own subaccount key; legacy
  // bots (protocolSubaccountId=null) use the main agent key.
  decryptSubKeyMock.mockResolvedValue({ secretKey: new Uint8Array([4, 5, 6]), cleanup: cleanupKey });
  decryptKeyMock.mockResolvedValue({ secretKey: new Uint8Array([1, 2, 3]), cleanup: cleanupKey });
}

/** Fresh module each test — the monitor keeps module-level state (G10 attempt set, timers). */
async function importMonitor() {
  return await import("../../server/ai-trader/monitor");
}

function exitFill(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    tradeId: "t-1",
    orderId: "o-1",
    internalSymbol: "SOL-PERP",
    side: "short", // exit of a long
    price: 145.05,
    size: 2,
    fee: 0.12,
    timestamp: NOW - 60_000,
    subaccountId: "sub-1",
    ...overrides,
  };
}

const botUpdates = () => updateBotMock.mock.calls.map((c) => c[1]);
const decisionUpdates = () => updateDecisionMock.mock.calls.map((c) => c[1]);
const notifications = () => notifyMock.mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const m of [
    getWalletMock, getRecentClosedMock, updateBotMock, updateDecisionMock, getDecisionsMock,
    getBotMock, getActiveBotsMock, getLlmCiphertextMock, getAiTraderDecisionMock, getUmkMock,
    decryptKeyMock, decryptSubKeyMock, healUmkMock, getSessionByWalletMock, restoreSecurityMock,
    decryptLlmKeyMock, notifyMock, getAdapterMock, fetchOHLCVMock, buildContextMock,
    runDecisionMock, executeDecisionMock,
  ]) {
    m.mockReset();
  }
  getRecentClosedMock.mockResolvedValue([]);
  updateBotMock.mockResolvedValue({});
  updateDecisionMock.mockResolvedValue({});
  notifyMock.mockResolvedValue(true);
  healUmkMock.mockResolvedValue(undefined);
  restoreSecurityMock.mockResolvedValue(undefined);
  // Fresh-decision re-read guard (monitor.ts handleLiveClose / closeLivePositionAndPause):
  // default returns an open (not-yet-closed) decision so the guard proceeds normally.
  // Tests that need the guard to bail (duplicate-close race) override this directly.
  getAiTraderDecisionMock.mockImplementation(async () => makeOpenDecision());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { stopAiTraderMonitor } = await importMonitor();
  stopAiTraderMonitor();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- parseOpenDecision (pure) ----------------------------------------------------

describe("parseOpenDecision", () => {
  it("returns null when there is no executed-and-open row", async () => {
    const { parseOpenDecision } = await importMonitor();
    expect(parseOpenDecision([])).toBeNull();
    expect(parseOpenDecision([makeOpenDecision({ closedAt: new Date(NOW) })])).toBeNull();
    expect(parseOpenDecision([makeOpenDecision({ outcome: "rejected_guardrails" })])).toBeNull();
  });

  it("parses a valid open decision into numbers", async () => {
    const { parseOpenDecision } = await importMonitor();
    const view = parseOpenDecision([makeOpenDecision()]);
    expect(view).not.toBeNull();
    expect(view!.side).toBe("long");
    expect(view!.sizeBase).toBe(2);
    expect(view!.stopLossPrice).toBe(145);
    expect(view!.takeProfitPrice).toBe(160);
    expect(view!.entryPrice).toBe(150);
    expect(view!.decidedAtMs).toBe(ENTRY_CANDLE_OPEN);
  });

  it("returns null for unusable clamped payloads (flat action, missing bracket)", async () => {
    const { parseOpenDecision } = await importMonitor();
    expect(
      parseOpenDecision([makeOpenDecision({ clampedDecision: { action: "flat" } })])
    ).toBeNull();
    expect(
      parseOpenDecision([
        makeOpenDecision({ clampedDecision: { action: "long", sizeBase: 2, takeProfitPrice: 160 } }),
      ])
    ).toBeNull();
  });
});

// --- classifyLiveExit (pure) ------------------------------------------------------

describe("classifyLiveExit", () => {
  it("classifies a fill near the SL as 'sl'", async () => {
    const { classifyLiveExit } = await importMonitor();
    expect(
      classifyLiveExit({ side: "long", avgExitPrice: 145.05, stopLossPrice: 145, takeProfitPrice: 160 })
    ).toBe("sl");
  });

  it("classifies at-or-beyond-TP fills as 'tp' in the favorable direction", async () => {
    const { classifyLiveExit } = await importMonitor();
    // Long: TP fills at or above the level.
    expect(classifyLiveExit({ side: "long", avgExitPrice: 160.5, stopLossPrice: 145, takeProfitPrice: 160 })).toBe("tp");
    expect(classifyLiveExit({ side: "long", avgExitPrice: 159.4, stopLossPrice: 145, takeProfitPrice: 160 })).toBe("tp"); // within 0.5%
    // Short: TP fills at or below the level.
    expect(classifyLiveExit({ side: "short", avgExitPrice: 139.5, stopLossPrice: 155, takeProfitPrice: 140 })).toBe("tp");
  });

  it("returns 'liquidation' when the exit matches neither leg or has no fills", async () => {
    const { classifyLiveExit } = await importMonitor();
    expect(classifyLiveExit({ side: "long", avgExitPrice: 152, stopLossPrice: 145, takeProfitPrice: 160 })).toBe("liquidation");
    expect(classifyLiveExit({ side: "long", avgExitPrice: null, stopLossPrice: 145, takeProfitPrice: 160 })).toBe("liquidation");
    expect(classifyLiveExit({ side: "long", avgExitPrice: NaN, stopLossPrice: 145, takeProfitPrice: 160 })).toBe("liquidation");
  });
});

// --- extractExitFills (pure) -------------------------------------------------------

describe("extractExitFills", () => {
  it("aggregates exit-side fills and separates entry fees by clientOrderId", async () => {
    const { extractExitFills } = await importMonitor();
    const trades: TradeRecord[] = [
      exitFill({ tradeId: "e-1", side: "long", price: 150, size: 2, fee: 0.1, clientOrderId: "aitrader-dec-1" }), // entry
      exitFill({ tradeId: "x-1", price: 145.0, size: 1, fee: 0.05 }),
      exitFill({ tradeId: "x-2", price: 145.1, size: 1, fee: 0.05 }),
      exitFill({ tradeId: "other-mkt", internalSymbol: "BTC-PERP", price: 999, size: 5, fee: 1 }),
      exitFill({ tradeId: "too-old", timestamp: ENTRY_CANDLE_OPEN - 60_000, price: 100, size: 9, fee: 1 }),
      exitFill({ tradeId: "other-sub", subaccountId: "sub-9", price: 100, size: 9, fee: 1 }),
      exitFill({ tradeId: "same-side", side: "long", price: 100, size: 9, fee: 1 }), // not an exit of a long
    ];
    const res = extractExitFills(trades, {
      market: "SOL-PERP",
      entrySide: "long",
      decisionId: "dec-1",
      sinceMs: ENTRY_CANDLE_OPEN,
      subaccountId: "sub-1",
    });
    expect(res.avgExitPrice).toBeCloseTo(145.05, 8);
    expect(res.exitFees).toBeCloseTo(0.1, 8);
    expect(res.entryFees).toBeCloseTo(0.1, 8);
  });

  it("returns null avgExitPrice when no exit fills are found", async () => {
    const { extractExitFills } = await importMonitor();
    const res = extractExitFills([], {
      market: "SOL-PERP",
      entrySide: "long",
      decisionId: "dec-1",
      sinceMs: 0,
    });
    expect(res.avgExitPrice).toBeNull();
  });
});

// --- Paper monitoring ---------------------------------------------------------------

describe("paper close detection", () => {
  it("closes on a TP hit in a later candle with the paper fill convention", async () => {
    const { monitorBotOnce } = await importMonitor();
    const bot = makeBot();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN, 150, 165, 149, 151), // entry candle: extremes IGNORED
      candle(ENTRY_CANDLE_OPEN + TF_15M, 151, 161, 150, 160.5), // TP 160 touched
    ]);

    await monitorBotOnce(bot);

    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    expect(du[0].exitReason).toBe("tp");
    const expectedExit = 160 * (1 - PAPER_SLIPPAGE_PER_LEG);
    expect(Number(du[0].exitPrice)).toBeCloseTo(expectedExit, 6);
    expect(du[0].closedAt).toEqual(new Date(ENTRY_CANDLE_OPEN + TF_15M));
    // netPnl = (exit-entry)*size − fee*(entry+exit)*size
    const expectedNet = (expectedExit - 150) * 2 - 0.0004 * (150 + expectedExit) * 2;
    expect(Number(du[0].realizedPnl)).toBeCloseTo(expectedNet, 2);
    // afterClose: back to idle.
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(notifications().some((n) => n.type === "position_closed")).toBe(true);
  });

  it("excludes the entry candle: a bracket touch there does NOT close", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN, 150, 165, 140, 150), // both legs "touched" — pre-fill extremes
    ]);

    await monitorBotOnce(makeBot());

    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("records nothing when the candle fetch fails (retry next tick)", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockRejectedValue(new Error("datafeed down"));

    await monitorBotOnce(makeBot());

    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("G7: force-flattens a guarded paper bot when realized + open MTM breaches −15%", async () => {
    const { monitorBotOnce } = await importMonitor();
    // sizeBase 40 @ entry 150; close 145.6 → MTM −176 ≤ −150 (15% of 1000).
    getDecisionsMock.mockResolvedValue([
      makeOpenDecision({ clampedDecision: { action: "long", sizeBase: 40, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 } }),
    ]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN, 150, 150.5, 149, 150),
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 150.5, 145.5, 145.6), // no bracket hit (low > SL 145)
    ]);

    await monitorBotOnce(makeBot());

    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    expect(du[0].exitReason).toBe("circuit_breaker");
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "daily_loss_breaker")).toBe(true);
  });

  it("G7 MTM breaker does not apply to 'degen' bots", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([
      makeOpenDecision({ clampedDecision: { action: "long", sizeBase: 40, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 } }),
    ]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 150.5, 145.5, 145.6),
    ]);

    await monitorBotOnce(makeBot({ riskProfile: "degen" }));

    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("pauses 'inconsistent_state' when the open paper decision has no entry price", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ entryPrice: null })]);

    await monitorBotOnce(makeBot());

    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "inconsistent_state")).toBe(true);
    expect(fetchOHLCVMock).not.toHaveBeenCalled();
  });
});

// --- Live monitoring ------------------------------------------------------------------

describe("live close detection", () => {
  it("classifies a vanished position with an SL-priced fill as 'sl' and cancels the survivor leg", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => [exitFill({ price: 145.02 })]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    expect(du[0].exitReason).toBe("sl");
    expect(Number(du[0].exitPrice)).toBeCloseTo(145.02, 6);
    // realized = (145.02−150)*2 − exitFees(0.12) = −10.08
    expect(Number(du[0].realizedPnl)).toBeCloseTo((145.02 - 150) * 2 - 0.12, 2);
    expect((adapter as any).cancelTpSlOrders).toHaveBeenCalled();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("treats an unattributable exit (no fills) as liquidation: pause + alert, never fabricated PnL", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => []),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    expect(du[0].exitReason).toBe("liquidation");
    expect(du[0].exitPrice).toBeNull();
    expect(du[0].realizedPnl).toBeNull();
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "liquidation")).toBe(true);
  });

  it("NEVER treats a getPositions read failure as a close", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => { throw new Error("venue 500"); }),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("defers close handling when getTradeHistory fails (no misclassification)", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => { throw new Error("history 500"); }),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(updateDecisionMock).not.toHaveBeenCalled();
  });
});

describe("G10 bracket re-verification", () => {
  const openPosition = { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" as const };

  it("re-places a missing bracket ONCE and verifies it rests", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const stopOrdersSeq = vi.fn()
      .mockResolvedValueOnce([]) // check: missing
      .mockResolvedValueOnce([{ order_id: "st-2", symbol: "SOL-PERP" }]); // verify after re-place
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      getOpenStopOrders: stopOrdersSeq,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).setTpSl).toHaveBeenCalledTimes(1);
    const args = (adapter as any).setTpSl.mock.calls[0][0];
    expect(args.stopLossPrice).toBe(145);
    expect(args.takeProfitPrice).toBe(160);
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled(); // still open, no pause
  });

  it("closes and pauses on the SECOND miss for the same decision", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const stopOrders = vi.fn()
      .mockResolvedValueOnce([]) // tick 1: missing
      .mockResolvedValueOnce([{ order_id: "st-2", symbol: "SOL-PERP" }]) // tick 1: verified
      .mockResolvedValueOnce([]); // tick 2: missing AGAIN
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      getOpenStopOrders: stopOrders,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    const bot = makeBot({ paperMode: false });

    await monitorBotOnce(bot); // re-place + verify
    await monitorBotOnce(bot); // second miss → close + pause

    expect((adapter as any).setTpSl).toHaveBeenCalledTimes(1); // NOT re-placed twice
    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "bracket_failed")).toBe(true);
    expect(decisionUpdates().some((u) => u.exitReason === "circuit_breaker")).toBe(true);
  });

  it("closes and pauses when the re-place cannot be verified", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      getOpenStopOrders: vi.fn(async () => []), // missing before AND after re-place
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).setTpSl).toHaveBeenCalledTimes(1);
    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.pauseReason === "bracket_failed")).toBe(true);
  });

  it("G7 live: force-flattens when realized + venue unrealized breaches −15%", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [{ ...openPosition, unrealizedPnl: -200 }]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "daily_loss_breaker")).toBe(true);
  });
});

// --- Circuit breakers via afterClose ------------------------------------------------------

describe("post-close circuit breakers", () => {
  it("G8: pauses a guarded bot on the 3rd consecutive stop-loss", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 151, 144.5, 145.2), // SL 145 hit
    ]);

    await monitorBotOnce(makeBot({ consecutiveLosses: 2 }));

    expect(decisionUpdates()[0].exitReason).toBe("sl");
    expect(botUpdates().some((u) => u.consecutiveLosses === 3)).toBe(true);
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "consecutive_losses")).toBe(true);
  });

  it("G8 does not pause a 'degen' bot", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 151, 144.5, 145.2),
    ]);

    await monitorBotOnce(makeBot({ consecutiveLosses: 2, riskProfile: "degen" }));

    expect(botUpdates().some((u) => u.pauseReason === "consecutive_losses")).toBe(false);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("malfunction ceiling pauses ANY profile (degen included) at 20 closed trades/day", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 161, 150, 160.5), // TP
    ]);
    const today = Array.from({ length: 20 }, (_, i) => ({
      closedAt: new Date(NOW - (i + 1) * 60_000),
      realizedPnl: "1",
    }));
    getRecentClosedMock.mockResolvedValue(today);

    await monitorBotOnce(makeBot({ riskProfile: "degen", graduationState: "graduated" }));

    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "malfunction_ceiling")).toBe(true);
  });
});

// --- Graduation ----------------------------------------------------------------------

describe("graduation", () => {
  it("graduates a paper bot after a close completes the §2e record and notifies", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 161, 150, 160.5), // TP close
    ]);
    // Record inside the 10-day trial: 4 profitable trades (PF ∞, DD 0).
    getRecentClosedMock.mockResolvedValue([
      { closedAt: new Date(NOW - 2 * DAY), realizedPnl: "10" },
      { closedAt: new Date(NOW - 3 * DAY), realizedPnl: "12" },
      { closedAt: new Date(NOW - 4 * DAY), realizedPnl: "8" },
      { closedAt: new Date(NOW - 5 * DAY), realizedPnl: "15" },
    ]);

    await monitorBotOnce(makeBot());

    expect(botUpdates().some((u) => u.graduationState === "graduated" && u.graduatedAt instanceof Date)).toBe(true);
    expect(notifications().some((n) => n.type === "ai_trader_graduation")).toBe(true);
  });

  it("sweep marks 'failed' when the period elapsed without enough trades", async () => {
    const { runGraduationSweep } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([makeBot({ status: "idle" })]);
    getRecentClosedMock.mockResolvedValue([
      { closedAt: new Date(NOW - 2 * DAY), realizedPnl: "10" },
    ]);

    await runGraduationSweep();

    expect(botUpdates().some((u) => u.graduationState === "failed")).toBe(true);
    expect(notifications().some((n) => n.type === "ai_trader_graduation")).toBe(false);
  });

  it("sweep ignores live bots and already-decided trials", async () => {
    const { runGraduationSweep } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([
      makeBot({ paperMode: false, status: "idle" }),
      makeBot({ id: "bot-2", status: "idle", graduationState: "graduated" }),
    ]);

    await runGraduationSweep();

    expect(updateBotMock).not.toHaveBeenCalled();
  });
});

// --- Auto-next cycle -----------------------------------------------------------------

describe("runAutoCycle", () => {
  function armAutoBot(overrides: Partial<AiTraderBot> = {}) {
    const bot = makeBot({ status: "idle", mode: "auto", autoNext: true, graduationState: "graduated", ...overrides });
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
    return bot;
  }

  it("does nothing for bots that are not idle+auto+autoNext", async () => {
    const { runAutoCycle } = await importMonitor();
    getBotMock.mockResolvedValue(makeBot({ status: "open", mode: "auto", autoNext: true }));
    await runAutoCycle("bot-1111-2222");
    getBotMock.mockResolvedValue(makeBot({ status: "idle", mode: "manual" }));
    await runAutoCycle("bot-1111-2222");
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("G6 cooldown blocks BEFORE any LLM spend and reschedules without pausing", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getRecentClosedMock.mockResolvedValue([{ closedAt: new Date(NOW - 60_000) }]); // closed 1min ago → 15m cooldown

    await runAutoCycle("bot-1111-2222");

    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled(); // no pause, no status churn
    expect(vi.getTimerCount()).toBeGreaterThan(0); // rescheduled
  });

  it("pauses 'reauth_required' when the session UMK cannot be restored — no LLM spend", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue(null);

    await runAutoCycle("bot-1111-2222");

    expect(restoreSecurityMock).toHaveBeenCalledWith("WALLET_X");
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "reauth_required")).toBe(true);
    expect(notifications().some((n) => n.type === "trade_failed")).toBe(true);
    expect(runDecisionMock).not.toHaveBeenCalled();
  });

  it("pauses 'no_api_key' when there is no stored LLM key ciphertext", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue(null);

    await runAutoCycle("bot-1111-2222");

    expect(botUpdates().some((u) => u.pauseReason === "no_api_key")).toBe(true);
    expect(runDecisionMock).not.toHaveBeenCalled();
  });

  it("returns to idle and reschedules on stale context (G9) — key zeroized", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    const keyBuf = Buffer.from("sk-or-secret");
    decryptLlmKeyMock.mockReturnValue(keyBuf);
    buildContextMock.mockResolvedValue({ stale: true, reason: "price too old" });

    await runAutoCycle("bot-1111-2222");

    expect(botUpdates().some((u) => u.status === "analyzing")).toBe(true);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(keyBuf.every((b) => b === 0)).toBe(true); // zeroized in finally
  });

  it("happy path: G6 clear → context → decision → executeDecision with the digest mark price", async () => {
    const { runAutoCycle } = await importMonitor();
    const bot = armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk-or-secret"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150.25 } });
    const clamped = { action: "long", sizeBase: 2, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 };
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "dec-9", decision: {}, clamped, rejected: false, violations: [], latencyMs: 5 });
    executeDecisionMock.mockResolvedValue({ ok: true, mode: "paper", entryPrice: 150.25 });

    await runAutoCycle("bot-1111-2222");

    expect(runDecisionMock).toHaveBeenCalledTimes(1);
    expect(runDecisionMock.mock.calls[0][0].apiKey).toBe("sk-or-secret");
    expect(executeDecisionMock).toHaveBeenCalledTimes(1);
    const execArgs = executeDecisionMock.mock.calls[0][0];
    expect(execArgs.decisionId).toBe("dec-9");
    expect(execArgs.markPrice).toBe(150.25);
    expect(execArgs.bot.id).toBe(bot.id);
  });

  it("a flat/rejected decision is a clean no-trade cycle: idle + reschedule", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "dec-9", decision: {}, clamped: { action: "flat" }, rejected: false, violations: [], latencyMs: 5 });

    await runAutoCycle("bot-1111-2222");

    expect(executeDecisionMock).not.toHaveBeenCalled();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

// --- Startup reconciliation ---------------------------------------------------------------

describe("startup reconciliation", () => {
  it("resets a crashed pre-open PAPER bot to idle and marks unfinished decisions aborted_crash", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    getDecisionsMock.mockResolvedValue([
      makeOpenDecision({ id: "dec-crash", outcome: null }),
    ]);

    const resolved = await reconcileBotOnStartup(makeBot({ status: "analyzing" }));

    expect(resolved).toBe(true);
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-crash", { outcome: "aborted_crash" });
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("resets a crashed pre-open LIVE bot to idle when the venue is provably flat", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-crash", outcome: null })]);

    const resolved = await reconcileBotOnStartup(makeBot({ status: "executing", paperMode: false }));

    expect(resolved).toBe(true);
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-crash", { outcome: "aborted_crash" });
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("promotes to 'open' when a live position + resting bracket + decision row all line up", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.1, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const resolved = await reconcileBotOnStartup(makeBot({ status: "executing", paperMode: false }));

    expect(resolved).toBe(true);
    expect((adapter as any).setTpSl).not.toHaveBeenCalled(); // bracket already rests
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-1", expect.objectContaining({ outcome: "executed" }));
    expect(botUpdates().some((u) => u.status === "open")).toBe(true);
  });

  it("completes a missing bracket during reconciliation (crash between order and setTpSl)", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const stopOrders = vi.fn()
      .mockResolvedValueOnce([]) // missing on check
      .mockResolvedValueOnce([{ order_id: "st-9", symbol: "SOL-PERP" }]); // rests after set
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.1, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
      getOpenStopOrders: stopOrders,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ outcome: null })]); // crash-pending row

    const resolved = await reconcileBotOnStartup(makeBot({ status: "executing", paperMode: false }));

    expect(resolved).toBe(true);
    expect((adapter as any).setTpSl).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.status === "open")).toBe(true);
  });

  it("fails closed on an orphan position (no usable decision): close + pause + alert", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: -3, entryPrice: 150, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([]); // nothing to attribute the position to

    const resolved = await reconcileBotOnStartup(makeBot({ status: "open", paperMode: false }));

    expect(resolved).toBe(true);
    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "reconcile_orphan_position")).toBe(true);
    expect(notifications().some((n) => n.type === "trade_failed")).toBe(true);
  });

  it("re-arms auto-next for hands-off bots after a restart (deploy must not halt them)", async () => {
    const { reconcileOnStartup } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([
      makeBot({ id: "bot-auto", status: "idle", mode: "auto", autoNext: true }),
      makeBot({ id: "bot-manual", status: "idle", mode: "manual" }),
      makeBot({ id: "bot-paused", status: "paused", mode: "auto", autoNext: true }),
    ]);
    getDecisionsMock.mockResolvedValue([]);

    await reconcileOnStartup();

    // Exactly one timer: the idle auto+autoNext bot. Manual and paused bots
    // are not scheduled (paused bots need explicit user resume).
    expect(vi.getTimerCount()).toBe(1);
  });

  it("returns false (retry signal) when the venue read fails — never assumes flat", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({
      getPositions: vi.fn(async () => { throw new Error("venue down"); }),
    }));

    const resolved = await reconcileBotOnStartup(makeBot({ status: "executing", paperMode: false }));

    expect(resolved).toBe(false);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("handles an offline close: 'open' bot, flat venue → classify from history", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => [exitFill({ price: 160.1 })]), // TP fill
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const resolved = await reconcileBotOnStartup(makeBot({ status: "open", paperMode: false }));

    expect(resolved).toBe(true);
    expect(decisionUpdates().some((u) => u.exitReason === "tp")).toBe(true);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });
});

// --- Unconfirmed-landing reconciliation (FLASH-LATE-LANDING-01) ------------------------

describe("unconfirmed-landing reconciliation", () => {
  /** Quarantined bot as the executor leaves it (bot row written LAST → updatedAt = window start). */
  function makeQuarantinedBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
    return makeBot({
      status: "paused",
      pauseReason: "position_unconfirmed",
      paperMode: false,
      updatedAt: new Date(NOW - 60_000), // quarantined 1 min ago — inside the 5-min window
      ...overrides,
    });
  }
  const unconfirmedRow = (overrides: Partial<Record<string, unknown>> = {}) =>
    makeOpenDecision({ id: "dec-u", outcome: "unconfirmed_landing", ...overrides });

  it("monitorBotOnce routes a quarantined bot to the reconciler (tick pickup) and never treats the pause as inert", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const getPositions = vi.fn(async () => []);
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions }));
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    await monitorBotOnce(makeQuarantinedBot());

    expect(getPositions).toHaveBeenCalledTimes(1); // venue actually consulted every tick
  });

  it("reconcileBotOnStartup routes the quarantined state to the reconciler (survives restarts)", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const getPositions = vi.fn(async () => []);
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions }));
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    const resolved = await reconcileBotOnStartup(makeQuarantinedBot());

    expect(resolved).toBe(true); // clean pending inside the window
    expect(getPositions).toHaveBeenCalledTimes(1);
  });

  it("flat INSIDE the window → pending: touches NOTHING (a bot-row write would restart the window)", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    const resolved = await reconcileUnconfirmedLanding(makeQuarantinedBot());

    expect(resolved).toBe(true);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("venue read FAILURE → still pending (false): a failed read is never proof of flatness, no writes, no expiry", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({
      getPositions: vi.fn(async () => { throw new Error("venue down"); }),
    }));
    // Even PAST the window a failed read must not expire the quarantine.
    const resolved = await reconcileUnconfirmedLanding(
      makeQuarantinedBot({ updatedAt: new Date(NOW - 10 * 60_000) })
    );

    expect(resolved).toBe(false);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("position LANDED + bracket rests → adopt: decision → executed with VENUE entry price, bot → open", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.1, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    const resolved = await reconcileUnconfirmedLanding(makeQuarantinedBot());

    expect(resolved).toBe(true);
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-u", { outcome: "executed", entryPrice: "150.10000000" });
    expect(botUpdates().some((u) => u.status === "open" && u.pauseReason === null)).toBe(true);
  });

  it("position LANDED + bracket missing → completes it (setTpSl + re-verify) before promoting to open", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    const stopOrders = vi.fn()
      .mockResolvedValueOnce([]) // missing on check
      .mockResolvedValueOnce([{ order_id: "st-9", symbol: "SOL-PERP" }]); // rests after set
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.1, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
      getOpenStopOrders: stopOrders,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    const resolved = await reconcileUnconfirmedLanding(makeQuarantinedBot());

    expect(resolved).toBe(true);
    expect((adapter as any).setTpSl).toHaveBeenCalledTimes(1);
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
    expect(botUpdates().some((u) => u.status === "open")).toBe(true);
  });

  it("position LANDED but bracket UNRESTORABLE → protective close + pause bracket_failed (never idle, never naked)", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.1, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
      getOpenStopOrders: vi.fn(async () => []), // never rests
      setTpSl: vi.fn(async () => ({ success: false, status: "rejected", error: "nope" })),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);
    // closeLivePositionAndPause re-reads the decision for its stale-pass guard.
    getAiTraderDecisionMock.mockResolvedValue(unconfirmedRow({ outcome: "executed" }));

    const resolved = await reconcileUnconfirmedLanding(makeQuarantinedBot());

    expect(resolved).toBe(true);
    // Entry recorded HONESTLY (it filled) before the protective close.
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-u", { outcome: "executed", entryPrice: "150.10000000" });
    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "bracket_failed")).toBe(true);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(false);
  });

  it("flat PAST the window on a successful read → terminal clean abort: aborted_order + expired pause + ONE notify", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    const resolved = await reconcileUnconfirmedLanding(
      makeQuarantinedBot({ updatedAt: new Date(NOW - 6 * 60_000) }) // 6 min > 5-min window
    );

    expect(resolved).toBe(true);
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-u", { outcome: "aborted_order" });
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "position_unconfirmed_expired")).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifications()[0]).toMatchObject({ type: "trade_failed" });
  });

  it("expired pause is NOT re-recognized (anti-repeat): monitorBotOnce leaves it alone, no venue read, no 2nd notify", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const getPositions = vi.fn(async () => []);
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions }));

    await monitorBotOnce(makeQuarantinedBot({ pauseReason: "position_unconfirmed_expired" }));

    expect(getPositions).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// --- Tick loop plumbing ---------------------------------------------------------------

describe("tick loop", () => {
  it("self-heals an 'open' paper bot with no open decision row to idle", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([]);

    await monitorBotOnce(makeBot());

    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("runMonitorTickOnce processes every active bot and isolates per-bot failures", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const botA = makeBot({ id: "bot-a" });
    const botB = makeBot({ id: "bot-b" });
    getActiveBotsMock.mockResolvedValue([botA, botB]);
    // bot-a throws on decisions read; bot-b closes cleanly on TP.
    getDecisionsMock.mockImplementation(async (botId: string) => {
      if (botId === "bot-a") throw new Error("db hiccup");
      return [makeOpenDecision({ botId: "bot-b" })];
    });
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 161, 150, 160.5),
    ]);

    await runMonitorTickOnce();

    // bot-b still closed despite bot-a's failure.
    expect(decisionUpdates().some((u) => u.exitReason === "tp")).toBe(true);
  });

  it("watchdog: reconciles a paper bot stranded in 'analyzing' past the stale window", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const stuck = makeBot({ id: "bot-stuck", status: "analyzing", paperMode: true });
    getActiveBotsMock.mockResolvedValue([stuck]);
    getDecisionsMock.mockResolvedValue([]);
    getBotMock.mockResolvedValue({ ...stuck, status: "idle" });

    // First observation: records first-seen, does NOT reconcile.
    await runMonitorTickOnce();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(false);

    // Still 'analyzing' 11 minutes later: watchdog queues + resolves it.
    vi.setSystemTime(NOW + 11 * 60_000);
    await runMonitorTickOnce();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("watchdog: leaves a healthy in-window cycle alone and resets on status change", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const bot = makeBot({ id: "bot-cycling", status: "analyzing", paperMode: true });
    getActiveBotsMock.mockResolvedValue([bot]);
    getDecisionsMock.mockResolvedValue([]);

    await runMonitorTickOnce();
    // 5 minutes in — inside the window, untouched.
    vi.setSystemTime(NOW + 5 * 60_000);
    await runMonitorTickOnce();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(false);

    // Status advanced to 'executing' — first-seen resets, so even past the
    // original deadline the bot is NOT reconciled.
    getActiveBotsMock.mockResolvedValue([{ ...bot, status: "executing" }]);
    vi.setSystemTime(NOW + 12 * 60_000);
    await runMonitorTickOnce();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(false);
  });

  it("watchdog: an auto bot healed at runtime gets its hands-off cadence re-armed", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const stuck = makeBot({ id: "bot-auto-stuck", status: "analyzing", paperMode: true, mode: "auto", autoNext: true });
    getActiveBotsMock.mockResolvedValue([stuck]);
    getDecisionsMock.mockResolvedValue([]);
    getBotMock.mockResolvedValue({ ...stuck, status: "idle" });

    await runMonitorTickOnce();
    vi.setSystemTime(NOW + 11 * 60_000);
    await runMonitorTickOnce();

    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    // scheduleAutoNext armed a timer for the healed bot (auto+autoNext+idle).
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

// --- Breakeven protect ---------------------------------------------------------------

describe("breakeven protect", () => {
  const NEW_SL = 150 * 1.0015; // entry 150, long → 150.225
  const MOVED_AT = new Date(NOW - TF_15M).toISOString(); // 11:45 candle

  /** Open decision whose ratchet has ALREADY fired (stop moved to breakeven). */
  function makeMovedDecision() {
    return makeOpenDecision({
      clampedDecision: {
        action: "long",
        sizeBase: 2,
        marginUsdc: 100,
        stopLossPrice: NEW_SL,
        takeProfitPrice: 160,
        breakevenProtect: {
          originalStopLossPrice: 145,
          movedStopLossPrice: NEW_SL,
          movedAt: MOVED_AT,
          progressAtFire: 0.8,
        },
      },
    });
  }

  /** setTpSl mock that echoes the request back as applied (verified success). */
  const echoSetTpSl = () =>
    vi.fn(async (p: { stopLossPrice?: number; takeProfitPrice?: number }) => ({
      success: true,
      status: "acknowledged",
      appliedStopLossPrice: p.stopLossPrice ?? null,
      appliedTakeProfitPrice: p.takeProfitPrice ?? null,
    }));

  const openPosition = { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150, markPrice: 157, unrealizedPnl: 14, leverage: 2, liquidationPrice: null, marginMode: "cross" as const };

  /** Candles reaching 80% of entry→TP (high 158 of 150→160) without touching a leg. */
  const progressCandles = () => [
    candle(ENTRY_CANDLE_OPEN, 150, 151, 149.5, 150.5), // entry candle: ignored
    candle(ENTRY_CANDLE_OPEN + TF_15M, 150.5, 158, 150.4, 157.5),
  ];

  it("paper: fires at ≥75% progress and persists the moved stop + audit state", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot());

    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    expect(du[0].exitReason).toBeUndefined(); // a move, not a close
    const clamped = du[0].clampedDecision as Record<string, any>;
    expect(clamped.stopLossPrice).toBeCloseTo(NEW_SL, 8);
    expect(clamped.takeProfitPrice).toBe(160); // TP untouched
    expect(clamped.breakevenProtect.originalStopLossPrice).toBe(145);
    expect(clamped.breakevenProtect.movedStopLossPrice).toBeCloseTo(NEW_SL, 8);
    expect(clamped.breakevenProtect.progressAtFire).toBeCloseTo(0.8, 6);
    expect(updateBotMock).not.toHaveBeenCalled(); // still open
  });

  it("paper: does NOT fire when price already retraced through breakeven", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150.5, 158, 150.4, 150.1), // close back below 150.225
    ]);

    await monitorBotOnce(makeBot());

    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("paper (segmented): a pre-move dip below the MOVED stop does not false-trigger", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeMovedDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      // Move candle (11:45): low 148 is below the moved stop 150.225 but above
      // the original 145 — its extremes predate the move, must not trigger.
      candle(NOW - TF_15M, 150.5, 158, 148, 157.5),
      candle(NOW, 157.5, 158, 151, 152), // post-move: above moved stop
    ]);

    await monitorBotOnce(makeBot());

    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("paper: a post-move breakeven stop-out closes with POSITIVE PnL and resets the G8 streak", async () => {
    const { monitorBotOnce } = await importMonitor();
    getDecisionsMock.mockResolvedValue([makeMovedDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(NOW - TF_15M, 150.5, 158, 150.4, 157.5), // move candle: no original-SL touch
      candle(NOW, 157.5, 157.6, 150.0, 150.3), // post-move: moved stop 150.225 touched
    ]);

    await monitorBotOnce(makeBot({ consecutiveLosses: 2 }));

    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    expect(du[0].exitReason).toBe("sl");
    const expectedExit = NEW_SL * (1 - PAPER_SLIPPAGE_PER_LEG);
    expect(Number(du[0].exitPrice)).toBeCloseTo(expectedExit, 6);
    expect(Number(du[0].realizedPnl)).toBeGreaterThan(0); // the whole point of the buffer
    // G8: an 'sl' exit that MADE money must reset the streak, not extend it.
    const update = botUpdates().find((u) => u.consecutiveLosses !== undefined);
    expect(update?.consecutiveLosses).toBe(0);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("live (pacifica): fires venue-first — setTpSl SL+TP together, persists on verified apply", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = echoSetTpSl();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(setTpSl).toHaveBeenCalledTimes(1);
    expect(setTpSl.mock.calls[0][0]).toMatchObject({
      internalSymbol: "SOL-PERP",
      stopLossPrice: expect.closeTo(NEW_SL, 8),
      takeProfitPrice: 160, // Pacifica REPLACES the bracket — TP must ride along
    });
    const du = decisionUpdates();
    expect(du).toHaveLength(1);
    const clamped = du[0].clampedDecision as Record<string, any>;
    expect(clamped.stopLossPrice).toBeCloseTo(NEW_SL, 8);
    expect(clamped.breakevenProtect.originalStopLossPrice).toBe(145);
    expect((adapter as any).cancelTpSlOrders).not.toHaveBeenCalled();
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
  });

  it("live (flash): sends the tighter SL ONLY (triggers stack) and never cancels", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = echoSetTpSl();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot({ paperMode: false, protocol: "flash" }));

    expect(setTpSl).toHaveBeenCalledTimes(1);
    expect(setTpSl.mock.calls[0][0].stopLossPrice).toBeCloseTo(NEW_SL, 8);
    expect(setTpSl.mock.calls[0][0].takeProfitPrice).toBeUndefined(); // SL-only on Flash
    expect((adapter as any).cancelTpSlOrders).not.toHaveBeenCalled();
    expect(decisionUpdates()).toHaveLength(1); // persisted
  });

  it("live: a venue rejection keeps the OLD stop — nothing persisted, position untouched", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = vi.fn(async () => ({ success: false, status: "rejected", error: "venue said no" }));
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(setTpSl).toHaveBeenCalledTimes(1);
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("live (pacifica): a dropped SL leg restores the ORIGINAL bracket and does not persist", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        status: "acknowledged",
        appliedStopLossPrice: null,
        appliedTakeProfitPrice: 160,
        droppedLegs: [{ leg: "sl", reason: "would trigger immediately" }],
      })
      .mockImplementation(async (p: { stopLossPrice?: number; takeProfitPrice?: number }) => ({
        success: true,
        status: "acknowledged",
        appliedStopLossPrice: p.stopLossPrice ?? null,
        appliedTakeProfitPrice: p.takeProfitPrice ?? null,
      }));
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(setTpSl).toHaveBeenCalledTimes(2);
    // Restore call carries the ORIGINAL bracket.
    expect(setTpSl.mock.calls[1][0]).toMatchObject({ stopLossPrice: 145, takeProfitPrice: 160 });
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
  });

  it("live (pacifica): dropped leg + failed restore closes the position (fail closed)", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        status: "acknowledged",
        appliedStopLossPrice: null,
        appliedTakeProfitPrice: 160,
        droppedLegs: [{ leg: "sl", reason: "would trigger immediately" }],
      })
      .mockResolvedValueOnce({ success: false, status: "rejected", error: "restore failed" });
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).closePosition).toHaveBeenCalled();
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "bracket_failed")).toBe(true);
  });

  it("live: venue-move retries are bounded per decision", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = vi.fn(async () => ({ success: false, status: "rejected", error: "always no" }));
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());
    const bot = makeBot({ paperMode: false });

    for (let i = 0; i < 8; i++) await monitorBotOnce(bot);

    expect(setTpSl).toHaveBeenCalledTimes(5); // BREAKEVEN_MAX_MOVE_ATTEMPTS
  });

  it("live: an unknown venue never moves the stop blind", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const setTpSl = echoSetTpSl();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue(progressCandles());

    await monitorBotOnce(makeBot({ paperMode: false, protocol: "drift" }));

    expect(setTpSl).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("classifyLiveExit: a fill at the ORIGINAL stop after a move still classifies as 'sl' (Flash stacking)", async () => {
    const { classifyLiveExit } = await importMonitor();
    expect(
      classifyLiveExit({ side: "long", avgExitPrice: 145.03, stopLossPrice: NEW_SL, takeProfitPrice: 160, originalStopLossPrice: 145 })
    ).toBe("sl");
    // And a fill at the MOVED stop is 'sl' too.
    expect(
      classifyLiveExit({ side: "long", avgExitPrice: 150.2, stopLossPrice: NEW_SL, takeProfitPrice: 160, originalStopLossPrice: 145 })
    ).toBe("sl");
  });
});
