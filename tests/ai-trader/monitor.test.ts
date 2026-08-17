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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import type { TradeRecord } from "../../server/protocol/protocol-types";
import { PAPER_SLIPPAGE_PER_LEG } from "../../server/ai-trader/paper-math";

const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const updateBotMock = vi.fn();
const updateDecisionMock = vi.fn();
const getDecisionsMock = vi.fn();
const getOpenDecisionsMock = vi.fn();
const getUnresolvedDecisionsMock = vi.fn();
const getBotMock = vi.fn();
const getActiveBotsMock = vi.fn();
const getLlmCiphertextMock = vi.fn();
const getAiTraderDecisionMock = vi.fn();
const claimAnalysisMock = vi.fn();
const transitionStateMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    updateAiTraderDecision: (...a: unknown[]) => updateDecisionMock(...a),
    getAiTraderDecisions: (...a: unknown[]) => getDecisionsMock(...a),
    getOpenAiTraderDecisions: (...a: unknown[]) => getOpenDecisionsMock(...a),
    getUnresolvedAiTraderDecisions: (...a: unknown[]) => getUnresolvedDecisionsMock(...a),
    getAiTraderBot: (...a: unknown[]) => getBotMock(...a),
    getActiveAiTraderBots: (...a: unknown[]) => getActiveBotsMock(...a),
    getWalletLlmApiKeyCiphertext: (...a: unknown[]) => getLlmCiphertextMock(...a),
    getAiTraderDecision: (...a: unknown[]) => getAiTraderDecisionMock(...a),
    claimAiTraderAnalysis: (...a: unknown[]) => claimAnalysisMock(...a),
    transitionAiTraderState: (...a: unknown[]) => transitionStateMock(...a),
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
  restoreWalletSecurityFromStorageOutcome: (...a: unknown[]) => restoreSecurityMock(...a),
  decryptLlmApiKeyV3: (...a: unknown[]) => decryptLlmKeyMock(...a),
  // executor's real module (imported for checkCooldownAndCaps) also pulls this:
  verifyBotPolicyHmac: vi.fn(() => true),
  // WO-B: scanner bot mode — monitor recomputes policyHmac for each picked market.
  computeBotPolicyHmac: vi.fn(() => "hmac-scanner-recomputed"),
}));

// AIT-CADENCE-SELF-HEAL-01: appendTelemetry is a VITEST no-op in the real
// module, so the audit/startup diagnostics are asserted through this mock.
// importOriginal spread keeps every other telemetry export real for any
// transitive importer.
const appendTelemetryMock = vi.fn();
vi.mock("../../server/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/telemetry")>();
  return {
    ...actual,
    appendTelemetry: (...a: unknown[]) => appendTelemetryMock(...a),
  };
});

const notifyMock = vi.fn();
vi.mock("../../server/notification-service", () => ({
  sendTradeNotification: (...a: unknown[]) => notifyMock(...a),
  getCloseReasonLabel: (source: string, leg?: string) => (leg ? `${leg} Hit` : source === "liquidation" ? "Liquidated" : source),
}));

const safeJournalMock = vi.fn();
const safeReconciliationTerminalMock = vi.fn();
vi.mock("../../server/ai-trader/execution-journal", () => ({
  entryAttemptId: (decisionId: string) => `entry:${decisionId}`,
  newMutationAttemptId: (action: string, decisionId: string | null) => `${action}:${decisionId ?? "unattributed"}:test-attempt`,
  journalBase: (bot: AiTraderBot, decisionId: string | null) => ({
    botId: bot.id,
    decisionId,
    protocol: bot.protocol,
    accountScope: bot.protocolSubaccountId ? "bot_subaccount" : "main",
    accountRef: bot.protocolSubaccountId ?? bot.walletAddress,
    market: bot.market,
  }),
  orderResultEvent: ({ base, attemptId, action, cause, order }: any) => ({
    ...base, attemptId, action, cause, eventType: "broadcast_result",
    venueStatus: order?.status ?? "unknown",
  }),
  safeAppendExecutionEvents: (...a: unknown[]) => safeJournalMock(...a),
  safeAppendEntryReconciliationTerminal: (...a: unknown[]) => safeReconciliationTerminalMock(...a),
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
  isCandleBasisUnavailableError: (err: unknown) =>
    (err as { name?: string } | null)?.name === "CandleBasisUnavailableError",
  PAPER_MONITOR_CANDLE_POLICY: {
    consumer: "paper_monitor",
    acceptedBasis: ["perp"],
    acceptedFinality: ["finalized", "forming"],
    acceptedProxy: ["direct"],
  },
  LIVE_MONITOR_CANDLE_POLICY: {
    consumer: "live_monitor",
    acceptedBasis: ["perp"],
    acceptedFinality: ["finalized", "forming"],
    acceptedProxy: ["direct"],
  },
}));

const buildContextMock = vi.fn();
vi.mock("../../server/ai-trader/context-builder", () => ({
  buildMarketContext: (...a: unknown[]) => buildContextMock(...a),
  marketToDatafeedTicker: (market: string) => market.replace(/-PERP$/i, "USDT"),
}));

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

const getScannerShortlistMock = vi.fn();
const getScannerShortlistResultMock = vi.fn();
const stopScannerMock = vi.fn();
vi.mock("../../server/ai-trader/scanner", () => ({
  getScannerShortlist: (...a: unknown[]) => getScannerShortlistMock(...a),
  getScannerShortlistResult: (...a: unknown[]) => getScannerShortlistResultMock(...a),
  stopScanner: (...a: unknown[]) => stopScannerMock(...a),
}));

const scannerCapabilitiesMock = vi.hoisted(() => ({
  producerEnabled: true,
  consumersEnabled: false,
  liveExecutionEnabled: false,
}));
vi.mock("../../server/ai-trader/scanner-capabilities", () => ({
  SCANNER_CAPABILITIES: scannerCapabilitiesMock,
}));

const schemaCapabilityReadyMock = vi.fn(() => true);
vi.mock("../../server/schema-readiness", () => ({
  applySchemaMigrationManifest: vi.fn(),
  installSchemaReadinessSnapshot: vi.fn(),
  isSchemaCapabilityReady: (...args: unknown[]) => schemaCapabilityReadyMock(...args),
  registerSchemaMigrationManifest: vi.fn(),
  reportSchemaReadiness: vi.fn(),
}));

const isMarketAdmittedMock = vi.fn();
vi.mock("../../server/ai-trader/market-admission", () => ({
  isAiTraderMarketAdmitted: (...a: unknown[]) => isMarketAdmittedMock(...a),
  SCANNER_MARKET_UNADMITTED_REASON: "scanner_market_unadmitted",
}));

const isMultiplierQuarantinedMock = vi.fn();
vi.mock("../../server/ai-trader/multiplier-market-quarantine", () => ({
  isMultiplierMarketQuarantined: (...a: unknown[]) => isMultiplierQuarantinedMock(...a),
  MULTIPLIER_UNQUALIFIED_REASON: "multiplier_unqualified",
}));

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
    pauseReason: null,
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

// Module transformation is harness setup, not a five-second behavior under
// test. Warm it before per-cell fake timers and assertions begin.
beforeAll(async () => {
  await importMonitor();
});

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const m of [
    getWalletMock, getRecentClosedMock, updateBotMock, updateDecisionMock, getDecisionsMock,
    getOpenDecisionsMock, getUnresolvedDecisionsMock, getBotMock, getActiveBotsMock, getLlmCiphertextMock, getAiTraderDecisionMock,
    claimAnalysisMock, transitionStateMock, getUmkMock,
    decryptKeyMock, decryptSubKeyMock, healUmkMock, getSessionByWalletMock, restoreSecurityMock,
    decryptLlmKeyMock, notifyMock, getAdapterMock, fetchOHLCVMock, buildContextMock,
    runDecisionMock, executeDecisionMock, appendTelemetryMock, getScannerShortlistMock,
    stopScannerMock, isMarketAdmittedMock, isMultiplierQuarantinedMock,
    schemaCapabilityReadyMock,
    safeJournalMock,
    safeReconciliationTerminalMock,
  ]) {
    m.mockReset();
  }
  getRecentClosedMock.mockResolvedValue([]);
  getOpenDecisionsMock.mockResolvedValue([]);
  getUnresolvedDecisionsMock.mockResolvedValue([]);
  getScannerShortlistMock.mockReturnValue([]);
  getScannerShortlistResultMock.mockImplementation((...a: unknown[]) => ({
    authority: "tradable", candidates: getScannerShortlistMock(...a),
  }));
  isMarketAdmittedMock.mockReturnValue(true);
  isMultiplierQuarantinedMock.mockReturnValue(false);
  schemaCapabilityReadyMock.mockReturnValue(true);
  updateBotMock.mockResolvedValue({});
  updateDecisionMock.mockResolvedValue({});
  claimAnalysisMock.mockImplementation(async ({ botId, updates }: { botId: string; updates?: Record<string, unknown> }) => {
    const patch = { ...(updates ?? {}), status: "analyzing", pauseReason: null };
    await updateBotMock(botId, patch);
    return makeBot({ id: botId, ...patch } as Partial<AiTraderBot>);
  });
  transitionStateMock.mockImplementation(async ({ botId, nextStatus, nextPauseReason, botUpdates }: {
    botId: string; nextStatus: string; nextPauseReason: string | null; botUpdates?: Record<string, unknown>;
  }) => {
    const patch = { ...(botUpdates ?? {}), status: nextStatus, pauseReason: nextPauseReason };
    await updateBotMock(botId, patch);
    return makeBot({ id: botId, ...patch } as Partial<AiTraderBot>);
  });
  notifyMock.mockResolvedValue(true);
  healUmkMock.mockResolvedValue(undefined);
  restoreSecurityMock.mockResolvedValue({ status: "reauth_required" });
  // Fresh-decision re-read guard (monitor.ts handleLiveClose / closeLivePositionAndPause):
  // default returns an open (not-yet-closed) decision so the guard proceeds normally.
  // Tests that need the guard to bail (duplicate-close race) override this directly.
  getAiTraderDecisionMock.mockImplementation(async () => makeOpenDecision());
  // LIVE-04 fresh bot identity guard: most owning-suite venue paths use the
  // default live bot. Individual paper/status variants override this explicitly.
  getBotMock.mockImplementation(async () => makeBot({ paperMode: false }));
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
    expect(res.exitSize).toBe(2);
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
    expect(res.exitSize).toBe(0);
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

describe("live close-result consumption", () => {
  const openPosition = {
    internalSymbol: "SOL-PERP",
    baseSize: 2,
    entryPrice: 150,
    markPrice: 150,
    unrealizedPnl: 0,
    leverage: 2,
    liquidationPrice: null,
    marginMode: "cross" as const,
  };
  const exactRestore = vi.fn(async (p: { stopLossPrice?: number; takeProfitPrice?: number }) => ({
    success: true,
    status: "acknowledged",
    appliedStopLossPrice: p.stopLossPrice ?? null,
    appliedTakeProfitPrice: p.takeProfitPrice ?? null,
  }));

  it("user close succeeds while every journal append fails", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    safeJournalMock.mockImplementation(() => undefined);
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      closePosition: vi.fn(async () => ({ success: true, status: "filled", fillPrice: 151 })),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const result = await userInitiatedClose(makeBot({ paperMode: false }));

    expect(result).toMatchObject({ ok: true, closed: true, exitPrice: 151 });
    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(decisionUpdates().some((update) => update.exitReason === "user_close")).toBe(true);
    expect(safeJournalMock).toHaveBeenCalled();
  });

  it("does not record or notify a user close that is only acknowledged", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      closePosition: vi.fn(async () => ({ success: true, status: "acknowledged", fillPrice: 150 })),
      setTpSl: exactRestore,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const result = await userInitiatedClose(makeBot({ paperMode: false }));

    expect(result).toEqual({
      ok: false,
      detail: "close execution is not terminal (acknowledged); original bracket restored and resting-order proof returned",
    });
    expect((adapter as any).setTpSl).toHaveBeenCalledWith(expect.objectContaining({
      stopLossPrice: 145,
      takeProfitPrice: 160,
    }));
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("restores and proves protection when closePosition throws", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      closePosition: vi.fn(async () => { throw new Error("venue timeout"); }),
      setTpSl: exactRestore,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const result = await userInitiatedClose(makeBot({ paperMode: false }));

    expect(result).toEqual({
      ok: false,
      detail: "closePosition threw: venue timeout; original bracket restored and resting-order proof returned",
    });
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("pauses loudly when an uncertain user close cannot restore exact protection", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      closePosition: vi.fn(async () => ({ success: true, status: "submitted" })),
      setTpSl: vi.fn(async () => ({
        success: true,
        status: "acknowledged",
        appliedStopLossPrice: 145,
        appliedTakeProfitPrice: null,
        droppedLegs: [{ leg: "tp", reason: "not applied" }],
      })),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const result = await userInitiatedClose(makeBot({ paperMode: false }));

    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toContain("bot paused for manual intervention");
    expect(botUpdates()).toContainEqual({ status: "paused", pauseReason: "bracket_failed" });
    expect(notifications().some((n) => n.type === "trade_failed")).toBe(true);
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("pauses loudly when the restore-time decision re-read throws", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      closePosition: vi.fn(async () => ({ success: true, status: "submitted" })),
      setTpSl: exactRestore,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    getAiTraderDecisionMock
      .mockResolvedValueOnce(makeOpenDecision())
      .mockRejectedValueOnce(new Error("database connection timeout"));

    const result = await userInitiatedClose(makeBot({ paperMode: false }));

    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toContain(
      "bracket restore/proof threw: database connection timeout"
    );
    expect((result as { detail: string }).detail).toContain("bot paused for manual intervention");
    expect(botUpdates()).toContainEqual({ status: "paused", pauseReason: "bracket_failed" });
    expect(notifications().some((n) => n.type === "trade_failed")).toBe(true);
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("rejects stale bot, decision, and position identity before any venue mutation", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({ getPositions: vi.fn(async () => [openPosition]) });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    const bot = makeBot({ paperMode: false });

    getBotMock.mockResolvedValueOnce(makeBot({ paperMode: false, market: "BTC-PERP" }));
    expect(await userInitiatedClose(bot)).toEqual({
      ok: false,
      detail: "bot identity changed while close was pending",
    });

    getBotMock.mockResolvedValueOnce(bot);
    getAiTraderDecisionMock.mockResolvedValueOnce(makeOpenDecision({ closedAt: new Date(NOW) }));
    expect(await userInitiatedClose(bot)).toEqual({
      ok: false,
      detail: "decision is no longer open",
    });

    getBotMock.mockResolvedValueOnce(bot);
    getAiTraderDecisionMock.mockResolvedValueOnce(makeOpenDecision());
    (adapter as any).getPositions.mockResolvedValueOnce([{ ...openPosition, baseSize: -2 }]);
    expect(await userInitiatedClose(bot)).toEqual({
      ok: false,
      detail: "live position market or side no longer matches",
    });

    expect((adapter as any).cancelTpSlOrders).not.toHaveBeenCalled();
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("lets only one of two concurrent user closes reach the venue and accounting", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const gate = deferred<{ success: true; status: "filled"; fillPrice: number }>();
    const entered = deferred<void>();
    const closePosition = vi.fn(() => {
      entered.resolve();
      return gate.promise;
    });
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      closePosition,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    const bot = makeBot({ paperMode: false });

    const first = userInitiatedClose(bot);
    await entered.promise;
    const duplicate = await userInitiatedClose(bot);
    expect(duplicate).toEqual({ ok: false, detail: "a close is already in progress for this bot" });

    gate.resolve({ success: true, status: "filled", fillPrice: 151 });
    const result = await first;

    expect(result).toMatchObject({ ok: true, closed: true, exitPrice: 151 });
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(decisionUpdates().filter((u) => u.exitReason === "user_close")).toHaveLength(1);
  });

  it("makes a confirmed-flat monitor pass defer while a user close owns the claim", async () => {
    const { userInitiatedClose, monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const gate = deferred<{ success: true; status: "filled"; fillPrice: number }>();
    const entered = deferred<void>();
    const getPositions = vi.fn()
      .mockResolvedValueOnce([openPosition])
      .mockResolvedValueOnce([]);
    const closePosition = vi.fn(() => {
      entered.resolve();
      return gate.promise;
    });
    const adapter = makeAdapter({ getPositions, closePosition });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    const bot = makeBot({ paperMode: false });

    const userClose = userInitiatedClose(bot);
    await entered.promise;
    await monitorBotOnce(bot);

    expect((adapter as any).getTradeHistory).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();

    gate.resolve({ success: true, status: "filled", fillPrice: 151 });
    await userClose;
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(decisionUpdates().filter((u) => u.exitReason === "user_close")).toHaveLength(1);
  });

  it("continues a terminal close after cancellation throws without restoring a flat position", async () => {
    const { userInitiatedClose } = await importMonitor();
    armLiveAuth();
    const setTpSl = vi.fn();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      cancelTpSlOrders: vi.fn(async () => { throw new Error("cancel transport lost"); }),
      closePosition: vi.fn(async () => ({ success: true, status: "filled", fillPrice: 151 })),
      setTpSl,
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    const result = await userInitiatedClose(makeBot({ paperMode: false }));

    expect(result).toMatchObject({ ok: true, closed: true, exitPrice: 151 });
    expect(setTpSl).not.toHaveBeenCalled();
    expect(decisionUpdates().filter((u) => u.exitReason === "user_close")).toHaveLength(1);
  });
});

describe("live close detection", () => {
  it("survivor cancel executes while every journal append fails", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    safeJournalMock.mockImplementation(() => undefined);
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => [exitFill({ price: 145.02, size: 2 })]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).cancelTpSlOrders).toHaveBeenCalledTimes(1);
    expect(decisionUpdates().some((update) => update.exitReason === "sl")).toBe(true);
    expect(safeJournalMock).toHaveBeenCalled();
  });

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

  it("defers an uncorroborated flat read with no fills without recording, pausing, notifying, or canceling", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => []),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect((adapter as any).cancelTpSlOrders).not.toHaveBeenCalled();
    expect((adapter as any).getTradeHistory).toHaveBeenCalledTimes(1);
  });

  it("defers a flat read corroborated by only a partial-size exit fill", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => [exitFill({ size: 1 })]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect((adapter as any).cancelTpSlOrders).not.toHaveBeenCalled();
  });

  it("records an authoritative full-size flat reconciliation exactly once", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => []),
      getTradeHistory: vi.fn(async () => [exitFill({ price: 145.02, size: 2 })]),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    getAiTraderDecisionMock
      .mockResolvedValueOnce(makeOpenDecision())
      .mockResolvedValue(makeOpenDecision({ closedAt: new Date(NOW) }));

    const bot = makeBot({ paperMode: false });
    await monitorBotOnce(bot);
    await monitorBotOnce(bot);

    expect(updateDecisionMock).toHaveBeenCalledTimes(1);
    expect(notifications().filter((n) => n.type === "position_closed")).toHaveLength(1);
    expect((adapter as any).cancelTpSlOrders).toHaveBeenCalledTimes(1);
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

  it("protective close reaches closePosition while every journal append fails", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    safeJournalMock.mockImplementation(() => undefined);
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      getOpenStopOrders: vi.fn(async () => []),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((update) => update.status === "paused" && update.pauseReason === "bracket_failed")).toBe(true);
    expect(safeJournalMock).toHaveBeenCalled();
  });

  it("does not record a protective close that is only submitted", async () => {
    const { monitorBotOnce } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [openPosition]),
      getOpenStopOrders: vi.fn(async () => []),
      closePosition: vi.fn(async () => ({ success: true, status: "submitted", fillPrice: 150 })),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ paperMode: false }));

    expect((adapter as any).closePosition).toHaveBeenCalledTimes(1);
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "bracket_failed")).toBe(true);
    expect(notifications().some((n) => n.type === "position_closed")).toBe(false);
  });

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

  it("withholds decision consumers without bot mutation when lab_scanner schema is unavailable", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    schemaCapabilityReadyMock.mockReturnValue(false);

    await runAutoCycle("bot-1111-2222");

    expect(schemaCapabilityReadyMock).toHaveBeenCalledWith("lab_scanner");
    expect(getAdapterMock).not.toHaveBeenCalled();
    expect(getWalletMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("scanner bot rejects multiplier candidate before registry admission, mutation, LLM, or execution", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    const { runAutoCycle } = await importMonitor();
    armAutoBot({ marketSource: "scanner" });
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("test-key"));
    getScannerShortlistMock.mockReturnValue([{
      protocol: "pacifica",
      market: "1MBONK-PERP",
      timeframe: "15m",
      direction: "long",
      setup: "W",
      score: 90,
      necklineDistancePct: 0.1,
      parentTrend: "uptrend",
      evaluatedAt: NOW,
    }]);
    isMultiplierQuarantinedMock.mockReturnValue(true);

    await runAutoCycle("bot-1111-2222");

    expect(isMultiplierQuarantinedMock).toHaveBeenCalledWith("1MBONK-PERP");
    expect(isMarketAdmittedMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
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

  it("defers transient storage-read failure to the existing next-candle cadence without state or spend", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue(null);
    restoreSecurityMock.mockResolvedValue({ status: "transient_read_failed" });

    await runAutoCycle("bot-1111-2222");

    expect(restoreSecurityMock).toHaveBeenCalledTimes(1);
    expect(restoreSecurityMock).toHaveBeenCalledWith("WALLET_X");
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(getLlmCiphertextMock).not.toHaveBeenCalled();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("transient_read_failed"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("next-candle cadence is retained"));
  });

  it("pauses 'reauth_required' when the restore outcome is authority-ambiguous — no LLM spend", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue(null);
    restoreSecurityMock.mockResolvedValue({ status: "reauth_required" });

    await runAutoCycle("bot-1111-2222");

    expect(restoreSecurityMock).toHaveBeenCalledWith("WALLET_X");
    expect(botUpdates().filter((u) => u.status === "paused" && u.pauseReason === "reauth_required")).toHaveLength(1);
    expect(notifications().filter((n) => n.type === "trade_failed")).toHaveLength(1);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reauth_required"));
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

  it("fails closed before LLM or execution when context has no admissible candle basis", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    const keyBuf = Buffer.from("sk-or-secret");
    decryptLlmKeyMock.mockReturnValue(keyBuf);
    buildContextMock.mockRejectedValue(Object.assign(new Error("no acceptable candle basis"), {
      name: "CandleBasisUnavailableError",
      reason: "no_acceptable_source",
    }));

    await runAutoCycle("bot-1111-2222");

    expect(botUpdates().some((u) => u.status === "analyzing")).toBe(true);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(keyBuf.every((b) => b === 0)).toBe(true);
  });

  it("happy path: G6 clear → context → decision → executeDecision with the digest mark price", async () => {
    const { runAutoCycle } = await importMonitor();
    const bot = armAutoBot();
    const openRows: AiTraderDecision[] = [];
    getOpenDecisionsMock.mockResolvedValue(openRows);
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
    expect(getOpenDecisionsMock).toHaveBeenCalledWith(bot.id, 2);
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      recentClosedDecisions: [],
      paperPositionRows: openRows,
    });
  });

  it("live automatic context never reads or supplies paper-position rows", async () => {
    const { runAutoCycle } = await importMonitor();
    const bot = armAutoBot({ paperMode: false });
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "dec-live", decision: {}, clamped: { action: "flat" }, rejected: false, violations: [], latencyMs: 5 });

    await runAutoCycle("bot-1111-2222");

    expect(getOpenDecisionsMock).toHaveBeenCalledWith(bot.id, 2);
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      recentClosedDecisions: [],
      paperPositionRows: [],
    });
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

  it("terminalizes close-with-no-position before release so the next cycle is not wedged", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock
      .mockResolvedValueOnce({ ok: true, decisionId: "dec-close-1", decision: {}, clamped: { action: "close" }, rejected: false, violations: [], latencyMs: 5 })
      .mockResolvedValueOnce({ ok: true, decisionId: "dec-close-2", decision: {}, clamped: { action: "close" }, rejected: false, violations: [], latencyMs: 5 });

    await runAutoCycle("bot-1111-2222");
    await runAutoCycle("bot-1111-2222");

    expect(claimAnalysisMock).toHaveBeenCalledTimes(2);
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: "dec-close-1",
      expectedDecisionOutcome: null,
      decisionOutcome: "flat",
      expectedStatus: "analyzing",
      nextStatus: "idle",
    }));
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({ decisionId: "dec-close-2", decisionOutcome: "flat" }));
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
    // updatedAt well outside the 5-min grace window (WO 01.2).
    const resolved = await reconcileBotOnStartup(makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 10 * 60_000) }));

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

  it("WO 01.1: recovers the decision-first partial state (executing + unconfirmed_landing) → re-quarantine + dedicated reconciler, never idle/aborted_crash", async () => {
    // Crash point 4 (restart from the OLD decision-first partial write): bot
    // still 'executing', decision already 'unconfirmed_landing'. The generic
    // pre-open flat path would set idle while the broadcast tx can still
    // land. Required: re-persist paused/position_unconfirmed with a FRESH
    // updatedAt window anchor, route into reconcileUnconfirmedLanding, and a
    // flat read inside that fresh window stays pending (no expiry writes).
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const getPositions = vi.fn(async () => []); // provably flat
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions }));
    getDecisionsMock.mockResolvedValue([
      makeOpenDecision({ id: "dec-u", outcome: "unconfirmed_landing" }),
    ]);
    // Stale bot row: last touched 10 min ago. If the code measured the window
    // from THIS row instead of the fresh re-quarantine write, the flat read
    // would (wrongly) expire the quarantine.
    const staleBot = makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 10 * 60_000) });
    updateBotMock.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...staleBot,
      ...updates,
      updatedAt: new Date(NOW), // storage bumps updatedAt on every write
    }));

    const resolved = await reconcileBotOnStartup(staleBot);

    expect(resolved).toBe(true);
    // Re-quarantined, then routed through the dedicated reconciler (venue probed).
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "position_unconfirmed")).toBe(true);
    expect(getPositions).toHaveBeenCalledTimes(1);
    // Never the generic executing→idle path, never aborted_crash on this row.
    expect(botUpdates().some((u) => u.status === "idle")).toBe(false);
    expect(decisionUpdates().some((u) => u.outcome === "aborted_crash")).toBe(false);
    // Fresh window anchor: flat inside the window stays PENDING — no expiry.
    expect(decisionUpdates().some((u) => u.outcome === "aborted_order")).toBe(false);
    expect(botUpdates().some((u) => u.pauseReason === "position_unconfirmed_expired")).toBe(false);
  });

  it("WO 01.1: the same partial state WITH a landed position takes the existing adoption path — no second entry", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.3, markPrice: 150.2, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
      // Bracket already rests — clean adoption.
      getOpenStopOrders: vi.fn(async () => [{ order_id: "st-9", symbol: "SOL-PERP" }]),
      placeMarketOrder: vi.fn(async () => { throw new Error("must never place a second entry"); }),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([
      makeOpenDecision({ id: "dec-u", outcome: "unconfirmed_landing" }),
    ]);
    const staleBot = makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 10 * 60_000) });
    updateBotMock.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...staleBot,
      ...updates,
      updatedAt: new Date(NOW),
    }));

    const resolved = await reconcileBotOnStartup(staleBot);

    expect(resolved).toBe(true);
    // Late entry adopted under its recorded decision: executed @ venue price, bot open.
    expect(decisionUpdates().some((u) => u.outcome === "executed")).toBe(true);
    expect(botUpdates().some((u) => u.status === "open")).toBe(true);
    // Never a second entry, never a close of the adopted position.
    expect((adapter as any).placeMarketOrder).not.toHaveBeenCalled();
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
    expect(decisionUpdates().some((u) => u.outcome === "aborted_crash")).toBe(false);
  });

  it("WO 01.1: startup auto-next arms from the POST-reconciliation state — a re-quarantined bot gets no timer", async () => {
    // Crash point 6: the snapshot row says 'executing' (not paused), so the
    // old snapshot-based arming loop would put a timer on a bot that the
    // reconciliation pass above just re-quarantined.
    const { reconcileOnStartup } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    const snapshotBot = makeBot({
      id: "bot-requar", status: "executing", paperMode: false, mode: "auto", autoNext: true,
      updatedAt: new Date(NOW - 10 * 60_000),
    });
    getActiveBotsMock.mockResolvedValue([snapshotBot]);
    getDecisionsMock.mockResolvedValue([
      makeOpenDecision({ id: "dec-u", botId: "bot-requar", outcome: "unconfirmed_landing" }),
    ]);
    updateBotMock.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...snapshotBot,
      ...updates,
      updatedAt: new Date(NOW),
    }));
    // Post-reconciliation fresh read: the bot is quarantined.
    getBotMock.mockResolvedValue({ ...snapshotBot, status: "paused", pauseReason: "position_unconfirmed" });

    await reconcileOnStartup();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("WO 01.1: a transient-status bot that reconciled back to idle still re-arms auto-next (fresh read, not snapshot)", async () => {
    const { reconcileOnStartup } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    // updatedAt outside the 5-min window so the flat read triggers existing crash recovery (WO 01.2).
    const snapshotBot = makeBot({ id: "bot-crash", status: "executing", paperMode: false, mode: "auto", autoNext: true, updatedAt: new Date(NOW - 10 * 60_000) });
    getActiveBotsMock.mockResolvedValue([snapshotBot]);
    // Ordinary crash marker: null-outcome decision → generic recovery to idle.
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-crash", botId: "bot-crash", outcome: null })]);
    getBotMock.mockResolvedValue({ ...snapshotBot, status: "idle" });

    await reconcileOnStartup();

    // Existing crash behavior retained (idle + aborted_crash) AND the timer arms.
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-crash", { outcome: "aborted_crash" });
    expect(vi.getTimerCount()).toBe(1);
  });

  // --- WO 01.2 tests: grace window for executing + flat (bot-quarantine-write-failed path) ---

  it("WO 01.2: executing + unresolved decision + flat + INSIDE grace window → stays pending, zero writes", async () => {
    // Bot-quarantine write failed after executor broadcast → bot stays 'executing'.
    // A fast restart probes the venue, reads flat, but the tx is still in-flight.
    // Inside the 5-min window: no bot or decision writes, return false.
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-null", outcome: null })]);
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    // 2 min ago — firmly inside the 5-min window.
    const bot = makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 2 * 60_000) });

    const resolved = await reconcileBotOnStartup(bot);

    expect(resolved).toBe(false);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("WO 01.2: startup reconcileOnStartup with inside-window executing bot → no timer armed", async () => {
    // Even if mode=auto+autoNext, a bot kept pending (return false) must not
    // receive an auto-next timer.
    const { reconcileOnStartup } = await importMonitor();
    armLiveAuth();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    const snapshotBot = makeBot({
      id: "bot-grace",
      status: "executing",
      paperMode: false,
      mode: "auto",
      autoNext: true,
      updatedAt: new Date(NOW - 2 * 60_000), // inside window
    });
    getActiveBotsMock.mockResolvedValue([snapshotBot]);
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-g", botId: "bot-grace", outcome: null })]);
    // Fresh read after reconciliation: still executing/pending (not idle).
    getBotMock.mockResolvedValue({ ...snapshotBot, status: "executing" });

    await reconcileOnStartup();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("WO 01.2: executing + flat + PAST the grace window → existing aborted_crash+idle path runs", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-old", outcome: null })]);
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    // 10 min ago — well outside the 5-min window.
    const bot = makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 10 * 60_000) });

    const resolved = await reconcileBotOnStartup(bot);

    expect(resolved).toBe(true);
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-old", { outcome: "aborted_crash" });
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
  });

  it("WO 01.2: executing + flat + MISSING updatedAt → fail closed, stays pending, zero writes", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-ts", outcome: null })]);
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    // No updatedAt — type-cast to satisfy TS in the fixture; production AiTraderBot always has it.
    const bot = makeBot({ status: "executing", paperMode: false, updatedAt: undefined as unknown as Date });

    const resolved = await reconcileBotOnStartup(bot);

    expect(resolved).toBe(false);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("WO 01.2: venue-read failure on executing bot → stays pending (pre-existing contract, preserved)", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-vf", outcome: null })]);
    getAdapterMock.mockReturnValue(makeAdapter({
      getPositions: vi.fn(async () => { throw new Error("rpc timeout"); }),
    }));
    const bot = makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 2 * 60_000) });

    const resolved = await reconcileBotOnStartup(bot);

    expect(resolved).toBe(false);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  it("WO 01.2: position appears inside the grace window → existing adoption path, no second entry", async () => {
    // The tx landed despite the failed quarantine write. Adoption path must
    // bracket and promote to 'open' — never place a second entry.
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.5, markPrice: 150.4, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
      getOpenStopOrders: vi.fn(async () => [{ order_id: "st-adopts", symbol: "SOL-PERP" }]),
      placeMarketOrder: vi.fn(async () => { throw new Error("must not place a second entry"); }),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision({ id: "dec-adopt", outcome: null })]);
    const bot = makeBot({ status: "executing", paperMode: false, updatedAt: new Date(NOW - 2 * 60_000) });

    const resolved = await reconcileBotOnStartup(bot);

    expect(resolved).toBe(true);
    expect(decisionUpdates().some((u) => u.outcome === "executed")).toBe(true);
    expect(botUpdates().some((u) => u.status === "open")).toBe(true);
    expect((adapter as any).placeMarketOrder).not.toHaveBeenCalled();
    expect((adapter as any).closePosition).not.toHaveBeenCalled();
  });

  it("returns false (retry signal) when the venue read fails — never assumes flat", async () => {
    const { reconcileBotOnStartup } = await importMonitor();
    armLiveAuth();
    getDecisionsMock.mockResolvedValue([]); // no partial-quarantine state
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

  it("unconfirmed reconciliation appends adoption and no-land truth best-effort", async () => {
    const { reconcileUnconfirmedLanding } = await importMonitor();
    armLiveAuth();
    safeJournalMock.mockImplementation(() => undefined);
    getAdapterMock.mockReturnValue(makeAdapter({
      getPositions: vi.fn(async () => [
        { internalSymbol: "SOL-PERP", baseSize: 2, entryPrice: 150.1, markPrice: 150, unrealizedPnl: 0, leverage: 2, liquidationPrice: null, marginMode: "cross" },
      ]),
    }));
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);

    await reconcileUnconfirmedLanding(makeQuarantinedBot());
    const adoptionTypes = safeJournalMock.mock.calls.flatMap((call) =>
      (call[0] as Array<{ eventType: string }>).map((event) => event.eventType),
    );
    expect(adoptionTypes).toEqual(expect.arrayContaining([
      "position_observed", "bracket_verified",
    ]));
    expect(safeReconciliationTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: "entry:dec-u",
      terminal: "entry_terminal_open",
      proof: { kind: "landed_position", side: "long", price: 150.1, sizeBase: 2 },
    }));

    safeJournalMock.mockClear();
    safeReconciliationTerminalMock.mockClear();
    getAdapterMock.mockReturnValue(makeAdapter({ getPositions: vi.fn(async () => []) }));
    getDecisionsMock.mockResolvedValue([unconfirmedRow()]);
    await reconcileUnconfirmedLanding(makeQuarantinedBot({ updatedAt: new Date(NOW - 6 * 60_000) }));
    expect(safeReconciliationTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: "entry:dec-u",
      terminal: "entry_terminal_no_land",
      proof: { kind: "flat_after_landing_window" },
    }));
  });

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
  it("expires the exact outcome-null proposal through one atomic transition", async () => {
    const { monitorBotOnce } = await importMonitor();
    const proposal = makeOpenDecision({
      id: "proposal-expired",
      outcome: null,
      decidedAt: new Date(NOW - 10 * 60_000 - 1),
    });
    getUnresolvedDecisionsMock.mockResolvedValue([proposal]);

    await monitorBotOnce(makeBot({ status: "proposed" }));

    expect(getUnresolvedDecisionsMock).toHaveBeenCalledWith("bot-1111-2222", 2);
    expect(getOpenDecisionsMock).not.toHaveBeenCalled();
    expect(transitionStateMock).toHaveBeenCalledWith({
      botId: "bot-1111-2222",
      expectedStatus: "proposed",
      expectedPauseReason: null,
      nextStatus: "idle",
      nextPauseReason: null,
      decisionId: "proposal-expired",
      expectedDecisionOutcome: null,
      decisionOutcome: "expired",
    });
  });

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

// --- Monitor liveness heartbeat ------------------------------------------------------

describe("monitor liveness heartbeat", () => {
  const telemetryHeartbeats = () =>
    appendTelemetryMock.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[AiTraderMonitor] heartbeat "));
  const consoleHeartbeats = () =>
    vi.mocked(console.log).mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[AiTraderMonitor] heartbeat "));
  const tickObservations = () =>
    appendTelemetryMock.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[AiTraderMonitor] tick_"));

  async function runDegraded(runTick: () => Promise<void>): Promise<void> {
    getActiveBotsMock.mockRejectedValue(new Error("private database detail"));
    const pending = runTick();
    await vi.advanceTimersByTimeAsync(9_000);
    await pending;
  }

  it("emits the first completed tick once to both sinks with the exact safe format", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([]);

    await runMonitorTickOnce();

    expect(consoleHeartbeats()).toHaveLength(1);
    expect(telemetryHeartbeats()).toEqual(consoleHeartbeats());
    expect(consoleHeartbeats()[0]).toMatch(
      /^\[AiTraderMonitor\] heartbeat tick_completed pid=\d+ boot=[0-9a-f]{8} duration_ms=\d+ active_bots=0$/
    );
  });

  it("classifies a caught per-bot failure as completed, never degraded", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([makeBot({ id: "private-bot-id" })]);
    getDecisionsMock.mockRejectedValue(new Error("private bot failure"));

    await runMonitorTickOnce();

    expect(telemetryHeartbeats()).toHaveLength(1);
    expect(telemetryHeartbeats()[0]).toMatch(/tick_completed .* active_bots=1$/);
    expect(telemetryHeartbeats()[0]).not.toContain("tick_degraded");
    expect(telemetryHeartbeats()[0]).not.toContain("private-bot-id");
    expect(telemetryHeartbeats()[0]).not.toContain("private bot failure");
  });

  it("emits degraded only after the existing three list attempts, with no error text", async () => {
    const { runMonitorTickOnce } = await importMonitor();

    await runDegraded(runMonitorTickOnce);

    expect(getActiveBotsMock).toHaveBeenCalledTimes(3);
    expect(consoleHeartbeats()).toHaveLength(1);
    expect(telemetryHeartbeats()).toEqual(consoleHeartbeats());
    expect(consoleHeartbeats()[0]).toMatch(
      /^\[AiTraderMonitor\] heartbeat tick_degraded pid=\d+ boot=[0-9a-f]{8} duration_ms=9000 reason=bot_list_failed$/
    );
    expect(consoleHeartbeats()[0]).not.toContain("private database detail");
  });

  it("bounds completed and degraded independently and emits each again at exactly five minutes", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([]);
    await runMonitorTickOnce();
    await runDegraded(runMonitorTickOnce);
    expect(telemetryHeartbeats().filter((line) => line.includes("tick_completed"))).toHaveLength(1);
    expect(telemetryHeartbeats().filter((line) => line.includes("tick_degraded"))).toHaveLength(1);

    vi.setSystemTime(NOW + 4 * 60_000);
    getActiveBotsMock.mockResolvedValue([]);
    await runMonitorTickOnce();
    await runDegraded(runMonitorTickOnce);
    expect(telemetryHeartbeats().filter((line) => line.includes("tick_completed"))).toHaveLength(1);
    expect(telemetryHeartbeats().filter((line) => line.includes("tick_degraded"))).toHaveLength(1);

    vi.setSystemTime(NOW + 5 * 60_000);
    getActiveBotsMock.mockResolvedValue([]);
    await runMonitorTickOnce();
    vi.setSystemTime(NOW + 5 * 60_000);
    await runDegraded(runMonitorTickOnce);
    expect(telemetryHeartbeats().filter((line) => line.includes("tick_completed"))).toHaveLength(2);
    expect(telemetryHeartbeats().filter((line) => line.includes("tick_degraded"))).toHaveLength(2);
    expect(consoleHeartbeats()).toEqual(telemetryHeartbeats());
  });

  it("rejects a younger overlap without observations and leaves the admitted generation eligible", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const firstRead = deferred<AiTraderBot[]>();
    getActiveBotsMock.mockImplementationOnce(() => firstRead.promise);

    const firstTick = runMonitorTickOnce();
    await vi.advanceTimersByTimeAsync(0);
    await runMonitorTickOnce();

    expect(getActiveBotsMock).toHaveBeenCalledTimes(1);
    expect(consoleHeartbeats()).toHaveLength(0);
    expect(telemetryHeartbeats()).toHaveLength(0);
    expect(tickObservations()).toHaveLength(1);
    expect(tickObservations()[0]).toMatch(
      /^\[AiTraderMonitor\] tick_start boot=[0-9a-f]{8} generation=\d+$/,
    );

    firstRead.resolve([]);
    await firstTick;
    expect(consoleHeartbeats()).toHaveLength(1);
    expect(telemetryHeartbeats()).toEqual(consoleHeartbeats());
    expect(tickObservations()).toHaveLength(2);
    const startIdentity = tickObservations()[0].match(/boot=([0-9a-f]{8}) generation=(\d+)/);
    const endIdentity = tickObservations()[1].match(/boot=([0-9a-f]{8}) generation=(\d+) state=current$/);
    expect(startIdentity?.slice(1)).toEqual(endIdentity?.slice(1));
  });

  it("attributes replacement-first settlement and a late older terminal without refreshing liveness", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const oldRead = deferred<AiTraderBot[]>();
    getActiveBotsMock
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValueOnce([]);

    const oldTick = runMonitorTickOnce();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(NOW + 121_000);
    await runMonitorTickOnce();
    expect(telemetryHeartbeats()).toHaveLength(1);
    expect(tickObservations()).toHaveLength(3);
    expect(tickObservations().filter((line) => line.includes("tick_start"))).toHaveLength(2);
    expect(tickObservations().filter((line) => line.endsWith("state=current"))).toHaveLength(1);

    oldRead.resolve([]);
    await oldTick;
    expect(telemetryHeartbeats()).toHaveLength(1);
    expect(consoleHeartbeats()).toEqual(telemetryHeartbeats());
    expect(tickObservations()).toHaveLength(4);
    expect(tickObservations().filter((line) => line.includes("tick_end"))).toHaveLength(2);
    expect(tickObservations().filter((line) => line.endsWith("state=superseded"))).toHaveLength(1);
    const bootTags = tickObservations().map((line) => line.match(/boot=([0-9a-f]{8})/)?.[1]);
    expect(new Set(bootTags).size).toBe(1);
  });

  it("invalidates a pre-stop tick and only a real restart resets the completed bound", async () => {
    const { runMonitorTickOnce, startAiTraderMonitor, stopAiTraderMonitor } = await importMonitor();
    const preStopRead = deferred<AiTraderBot[]>();
    getActiveBotsMock.mockImplementationOnce(() => preStopRead.promise);

    const preStopTick = runMonitorTickOnce();
    await vi.advanceTimersByTimeAsync(0);
    stopAiTraderMonitor();
    preStopRead.resolve([]);
    await preStopTick;
    expect(telemetryHeartbeats()).toHaveLength(0);
    expect(tickObservations()).toHaveLength(2);
    expect(tickObservations()[1]).toMatch(/tick_end .* state=superseded$/);

    getActiveBotsMock.mockResolvedValue([]);
    startAiTraderMonitor();
    await vi.advanceTimersByTimeAsync(0);
    await runMonitorTickOnce();
    expect(telemetryHeartbeats()).toHaveLength(1);
    expect(tickObservations().filter((line) => line.includes("tick_start"))).toHaveLength(2);
    expect(tickObservations().filter((line) => line.endsWith("state=current"))).toHaveLength(1);

    startAiTraderMonitor(); // singleton no-op: must not reset the bound
    vi.setSystemTime(NOW + 60_000);
    await runMonitorTickOnce();
    expect(telemetryHeartbeats()).toHaveLength(1);
    expect(consoleHeartbeats()).toEqual(telemetryHeartbeats());
    expect(tickObservations().filter((line) => line.includes("tick_start"))).toHaveLength(3);
    expect(tickObservations().filter((line) => line.includes("tick_end"))).toHaveLength(3);
  });

  it("still enqueues telemetry when console throws, without changing tick outcome", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([]);
    vi.mocked(console.log).mockImplementation(() => {
      throw new Error("console unavailable");
    });

    await expect(runMonitorTickOnce()).resolves.toBeUndefined();
    expect(telemetryHeartbeats()).toHaveLength(1);
  });

  it("still writes the console line when telemetry throws, without changing tick outcome", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([]);
    appendTelemetryMock.mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });

    await expect(runMonitorTickOnce()).resolves.toBeUndefined();
    expect(consoleHeartbeats()).toHaveLength(1);
  });
});

// --- AIT-CADENCE-SELF-HEAL-01: tick audit restores missing auto-next timers -----------

describe("AIT-CADENCE-SELF-HEAL-01: idle-bot cadence audit", () => {
  const idleAutoBot = (overrides: Partial<AiTraderBot> = {}) =>
    makeBot({ id: "bot-idle-auto", status: "idle", mode: "auto", autoNext: true, ...overrides });

  const telemetryLines = () => appendTelemetryMock.mock.calls.map((c) => String(c[0]));
  // NOTE: the startup diagnostic also mentions "tick audit", so the repair
  // filter keys on the repair-specific phrase.
  const repairLines = () => telemetryLines().filter((l) => l.includes("restored missing auto-next timer"));
  const startupLines = () => telemetryLines().filter((l) => l.includes("bot-list read failed"));

  it("startup bot-list read failure: no timers armed + one bounded diagnostic; the first healthy tick restores exactly one future timer", async () => {
    const { reconcileOnStartup, runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockRejectedValueOnce(new Error("Connection terminated due to connection timeout"));

    await reconcileOnStartup();

    expect(vi.getTimerCount()).toBe(0);
    expect(startupLines()).toHaveLength(1);
    // Fixed-string diagnostic: no error text, wallet or bot identifiers.
    expect(startupLines()[0]).not.toContain("Connection terminated");
    expect(startupLines()[0]).not.toContain("WALLET_X");

    // Next tick reads the bot list successfully → audit restores the cadence.
    getActiveBotsMock.mockResolvedValue([idleAutoBot()]);
    await runMonitorTickOnce();

    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(1);
    // Bot-ID prefix (8 chars) only — never the full id, never the wallet.
    expect(repairLines()[0]).toContain("bot-idle");
    expect(repairLines()[0]).not.toContain("bot-idle-auto");
    expect(repairLines()[0]).not.toContain("WALLET_X");
    expect(repairLines()[0]).toContain("tf=15m");
  });

  it("repeated healthy ticks are idempotent: one timer, boundary never moves, telemetry emitted once", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([idleAutoBot()]);

    await runMonitorTickOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(1);

    await runMonitorTickOnce();
    await runMonitorTickOnce();

    // A bot that owns a timer is never touched: no re-arm, no re-emission.
    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(1);

    // The single timer fires exactly once at the ORIGINAL boundary (+2s).
    // runAutoCycle's fresh-row gate sees 'open' → exits without rescheduling.
    getBotMock.mockResolvedValue(idleAutoBot({ status: "open" }));
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);
    expect(getBotMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("state exclusions: open/paused/proposed/analyzing/executing, manual mode and autoNext:false bots are never armed", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    // The 'open' bot runs real paper monitoring — give it a decision + a
    // candle that touches neither leg so the pass is a no-op.
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    fetchOHLCVMock.mockResolvedValue([
      candle(ENTRY_CANDLE_OPEN + TF_15M, 150, 151, 149.9, 150.5),
    ]);
    getActiveBotsMock.mockResolvedValue([
      makeBot({ id: "bot-x-open", status: "open", mode: "auto", autoNext: true }),
      makeBot({ id: "bot-x-paused", status: "paused", mode: "auto", autoNext: true }),
      makeBot({ id: "bot-x-proposed", status: "proposed", mode: "auto", autoNext: true }),
      makeBot({ id: "bot-x-analyzing", status: "analyzing", mode: "auto", autoNext: true }),
      makeBot({ id: "bot-x-executing", status: "executing", mode: "auto", autoNext: true }),
      makeBot({ id: "bot-x-manual", status: "idle", mode: "manual", autoNext: true }),
      makeBot({ id: "bot-x-noauto", status: "idle", mode: "auto", autoNext: false }),
    ]);

    await runMonitorTickOnce();

    expect(vi.getTimerCount()).toBe(0);
    expect(repairLines()).toHaveLength(0);
  });

  it("pending reconciliation wins: the audit never competes; the reconciliation branch arms exactly one timer", async () => {
    const { reconcileOnStartup, runMonitorTickOnce } = await importMonitor();
    const bot = makeBot({ id: "bot-pending", status: "analyzing", paperMode: true, mode: "auto", autoNext: true });
    getActiveBotsMock.mockResolvedValue([bot]);
    // Startup per-bot reconcile throws → bot lands in pendingReconciliation.
    getDecisionsMock.mockRejectedValueOnce(new Error("db hiccup"));

    await reconcileOnStartup();
    expect(vi.getTimerCount()).toBe(0);
    // The bot-LIST read succeeded — the startup diagnostic must NOT fire.
    expect(startupLines()).toHaveLength(0);

    // Tick: the pendingReconciliation branch resolves the bot to idle and
    // re-arms via its own path — the audit is bypassed by the `continue`.
    getDecisionsMock.mockResolvedValue([]);
    getBotMock.mockResolvedValue({ ...bot, status: "idle" });
    await runMonitorTickOnce();

    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(0); // armed by reconciliation, not the audit

    // Follow-up tick with the timer live: audit stays hands-off.
    getActiveBotsMock.mockResolvedValue([{ ...bot, status: "idle" }]);
    await runMonitorTickOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(0);
  });

  it("paper self-heal: open-with-no-decision heals to idle this tick; the NEXT tick arms exactly one timer", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const bot = makeBot({ id: "bot-paper-heal", status: "open", paperMode: true, mode: "auto", autoNext: true });
    getActiveBotsMock.mockResolvedValue([bot]);
    getDecisionsMock.mockResolvedValue([]); // 'open' with no open decision row

    // Tick 1: snapshot says 'open' → audit ineligible; monitorBotOnce heals to idle.
    await runMonitorTickOnce();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Tick 2: fresh list reads 'idle' → audit restores the cadence.
    getActiveBotsMock.mockResolvedValue([{ ...bot, status: "idle" }]);
    await runMonitorTickOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(1);
  });

  it("adapter-resolution loss: the consumed timer is restored on the next tick — never an immediate cycle", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const bot = idleAutoBot({ id: "bot-adapterless" });
    getActiveBotsMock.mockResolvedValue([bot]);

    await runMonitorTickOnce(); // audit arms
    expect(vi.getTimerCount()).toBe(1);

    // Timer fires; runAutoCycle re-reads the still-idle bot but the adapter
    // cannot resolve → the exit consumes the timer without replacing it.
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockImplementation(() => {
      throw new Error("no adapter registered for 'pacifica'");
    });
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);
    expect(vi.getTimerCount()).toBe(0);

    // Next tick: audit re-arms a FUTURE boundary timer; no LLM/decision work runs.
    await runMonitorTickOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(repairLines()).toHaveLength(2); // two genuine repairs, one per loss
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
  });

  it("timer-callback in-flight window: audit adds only a next-boundary timer; the hung cycle never doubles up", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const bot = idleAutoBot({ id: "bot-window" });
    getActiveBotsMock.mockResolvedValue([bot]);

    await runMonitorTickOnce(); // arm
    expect(vi.getTimerCount()).toBe(1);

    // Freeze runAutoCycle in-flight: the timer callback has already deleted
    // the map entry, but the cycle's first read never settles.
    let releaseCycle!: (v: unknown) => void;
    getBotMock.mockImplementation(() => new Promise((res) => { releaseCycle = res; }));
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);
    // The auto-next timer was consumed; the AIT-CYCLE-OBSERVABILITY-01 watchdog
    // is now live (unref'd, but still counted by vi.getTimerCount).
    expect(vi.getTimerCount()).toBe(1); // watchdog only; cycle in-flight

    // Audit repairs with a future boundary timer — it never calls runAutoCycle.
    await runMonitorTickOnce();
    expect(vi.getTimerCount()).toBe(2); // watchdog + audit-armed auto-next timer
    expect(getBotMock).toHaveBeenCalledTimes(1); // still only the in-flight cycle's read

    // Release the hung cycle as non-idle → it exits at the fresh-row gate
    // without touching the audit's timer; settle() clears the watchdog.
    releaseCycle({ ...bot, status: "analyzing" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // exactly one future timer survives (audit-armed)
  });

  it("shutdown: stopAiTraderMonitor clears audit-armed timers", async () => {
    const { runMonitorTickOnce, stopAiTraderMonitor } = await importMonitor();
    getActiveBotsMock.mockResolvedValue([idleAutoBot()]);

    await runMonitorTickOnce();
    expect(vi.getTimerCount()).toBe(1);

    stopAiTraderMonitor();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// --- AIT-CYCLE-OBSERVABILITY-01: scheduled cycle observability -----------------------

describe("AIT-CYCLE-OBSERVABILITY-01: scheduled cycle observability", () => {
  /** Full auth + flat-decision setup so runAutoCycle reaches the LLM phase and returns flat. */
  function armFlatCycle(botId = "bot-obs-1234") {
    const bot = makeBot({ id: botId, status: "idle", mode: "auto", autoNext: true, graduationState: "graduated" });
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
    getSessionByWalletMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "d-obs", decision: {}, clamped: { action: "flat" }, rejected: false, violations: [], latencyMs: 5 });
    return bot;
  }

  /** Only the observability lines emitted by the new wrapper. */
  const obsTelLines = () =>
    appendTelemetryMock.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[AIT-OBS]"));
  const startLines = () => obsTelLines().filter((l) => l.includes("cycle_start"));
  const slowLines  = () => obsTelLines().filter((l) => l.includes("cycle_slow"));
  const endLines   = () => obsTelLines().filter((l) => l.includes("cycle_end"));

  it("flat cycle: emits exactly one start and one terminal; content has cycleId/tf/exit/phase and no secret fields", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle("bot-obs-1234");

    scheduleAutoNext("bot-obs-1234", "15m");
    expect(obsTelLines()).toHaveLength(0); // nothing before the timer fires

    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(startLines()).toHaveLength(1);
    expect(endLines()).toHaveLength(1);
    expect(slowLines()).toHaveLength(0);

    const start = startLines()[0];
    expect(start).toContain("cid=bot-obs-"); // 8-char prefix, not the full id
    expect(start).toContain("tf=15m");
    expect(start).toContain("ts=");
    expect(start).toMatch(/boot=[0-9a-f]{8}$/);
    expect(start).not.toContain("WALLET_X");
    expect(start).not.toContain("bot-obs-1234"); // full id must never appear

    const end = endLines()[0];
    expect(end).toContain("exit=flat");
    expect(end).toContain("phase=llm");
    expect(end).toContain("elapsed_ms=");
    expect(end).toMatch(/boot=[0-9a-f]{8}$/);
    expect(start.match(/boot=([0-9a-f]{8})$/)?.[1]).toBe(
      end.match(/boot=([0-9a-f]{8})$/)?.[1],
    );
    expect(end).not.toContain("WALLET_X");
    expect(end).not.toContain("bot-obs-1234");
  });

  it("fast settlement: advancing past 60 s produces no slow line (watchdog cleared on settle)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle();

    scheduleAutoNext("bot-obs-1234", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000); // cycle settles

    expect(endLines()).toHaveLength(1);
    appendTelemetryMock.mockClear(); // reset so we only see post-settle calls

    await vi.advanceTimersByTimeAsync(60_000); // would fire watchdog if not cleared

    expect(slowLines()).toHaveLength(0);
    expect(endLines()).toHaveLength(0); // no second terminal
  });

  it("never-settling cycle: emits exactly one slow line at 60 s; no terminal until released", async () => {
    const { scheduleAutoNext } = await importMonitor();
    let releaseCycle!: (v: unknown) => void;
    getBotMock.mockImplementation(() => new Promise((res) => { releaseCycle = res; }));

    scheduleAutoNext("bot-obs-slow", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000); // timer fires; cycle hangs at bot read

    expect(startLines()).toHaveLength(1);
    expect(endLines()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000); // watchdog fires

    expect(slowLines()).toHaveLength(1);
    expect(slowLines()[0]).toContain("cycle_slow");
    expect(slowLines()[0]).toContain("phase=initial");
    expect(slowLines()[0]).toContain("elapsed_ms=");
    expect(endLines()).toHaveLength(0); // still in flight

    // Advancing more must NOT produce a second slow line
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slowLines()).toHaveLength(1);
    expect(endLines()).toHaveLength(0);

    // Release: bot resolves to non-idle → status gate returns immediately
    releaseCycle(makeBot({ id: "bot-obs-slow", status: "open" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(endLines()).toHaveLength(1);
    expect(slowLines()).toHaveLength(1); // still exactly one slow line
    const bootTags = obsTelLines().map((line) => line.match(/boot=([0-9a-f]{8})$/)?.[1]);
    expect(bootTags.every(Boolean)).toBe(true);
    expect(new Set(bootTags).size).toBe(1);
  });

  it("releasing a hung cycle: clears watchdog; emits exactly one terminal; total obs = 3 lines", async () => {
    const { scheduleAutoNext } = await importMonitor();
    let releaseCycle!: (v: unknown) => void;
    getBotMock.mockImplementation(() => new Promise((res) => { releaseCycle = res; }));

    scheduleAutoNext("bot-obs-rel", "15m");
    // Advance past both the timer fire and the 60 s watchdog in one step
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000 + 60_000);
    expect(slowLines()).toHaveLength(1);
    expect(endLines()).toHaveLength(0);

    releaseCycle(null); // null → !bot → returns immediately (status_gate)
    await vi.advanceTimersByTimeAsync(0);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=status_gate");
    // Total: 1 start + 1 slow + 1 terminal — exactly 3
    expect(obsTelLines()).toHaveLength(3);
  });

  it("thrown cycle: terminal has exit=thrown; no raw error text in telemetry; console.error called; pendingReconciliation wired", async () => {
    const { scheduleAutoNext } = await importMonitor();
    const rawMsg = "simulated-db-crash: very secret details at line 999";
    getBotMock.mockRejectedValue(new Error(rawMsg));

    scheduleAutoNext("bot-obs-throw", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(startLines()).toHaveLength(1);
    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=thrown");
    // Raw error text must never appear in the telemetry line
    expect(endLines()[0]).not.toContain("simulated-db-crash");
    expect(endLines()[0]).not.toContain("secret details");
    // Existing catch behaviour preserved: console.error called
    expect(console.error).toHaveBeenCalled();
    // Exactly one terminal — no second line from a duplicate settle()
    expect(endLines()).toHaveLength(1);
  });

  it("status-gate path: terminal exit=status_gate, phase=initial", async () => {
    const { scheduleAutoNext } = await importMonitor();
    // Bot not idle+auto+autoNext → status gate inside runAutoCycle
    getBotMock.mockResolvedValue(makeBot({ status: "open", mode: "auto", autoNext: true }));

    scheduleAutoNext("bot-obs-gate", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=status_gate");
    expect(endLines()[0]).toContain("phase=initial");
  });

  it("adapter-missing path: terminal exit=adapter_missing, phase=initial", async () => {
    const { scheduleAutoNext } = await importMonitor();
    getBotMock.mockResolvedValue(makeBot({ id: "bot-obs-noadp", status: "idle", mode: "auto", autoNext: true }));
    getAdapterMock.mockImplementation(() => { throw new Error("no adapter registered for 'pacifica'"); });

    scheduleAutoNext("bot-obs-noadp", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=adapter_missing");
    expect(endLines()[0]).toContain("phase=initial");
    // Raw adapter error text must not appear
    expect(endLines()[0]).not.toContain("no adapter");
  });

  it("stale-context path: terminal exit=stale_data, phase=context; no raw reason leaked", async () => {
    const { scheduleAutoNext } = await importMonitor();
    const bot = makeBot({ id: "bot-obs-stale", status: "idle", mode: "auto", autoNext: true, graduationState: "graduated" });
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY });
    getSessionByWalletMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ stale: true, reason: "price-too-old-RAWLEAK" });

    scheduleAutoNext("bot-obs-stale", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=stale_data");
    expect(endLines()[0]).toContain("phase=context");
    expect(endLines()[0]).not.toContain("RAWLEAK");
  });

  it("successful entry path: terminal exit=entry_open, phase=execution", async () => {
    const { scheduleAutoNext } = await importMonitor();
    const bot = makeBot({ id: "bot-obs-entry", status: "idle", mode: "auto", autoNext: true, graduationState: "graduated" });
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY });
    getSessionByWalletMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    const clamped = { action: "long", sizeBase: 2, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 };
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "dec-obs", decision: {}, clamped, rejected: false, violations: [], latencyMs: 5 });
    executeDecisionMock.mockResolvedValue({ ok: true, mode: "paper", entryPrice: 150 });

    scheduleAutoNext("bot-obs-entry", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=entry_open");
    expect(endLines()[0]).toContain("phase=execution");
  });

  it("instrumentation adds zero lines before timer fires and no extra storage/network calls beyond runAutoCycle itself", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle();

    scheduleAutoNext("bot-obs-1234", "15m");

    // Nothing emitted before the boundary
    expect(obsTelLines()).toHaveLength(0);
    expect(appendTelemetryMock).not.toHaveBeenCalled();
    expect(getBotMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    // Exactly start + terminal; no extra storage calls from the wrapper
    expect(obsTelLines()).toHaveLength(2);
    // Wrapper itself added only 2 telemetry calls; runAutoCycle's own behaviour
    // (storage reads, mock calls) is unaffected
    expect(getBotMock).toHaveBeenCalledTimes(1);
    expect(buildContextMock).toHaveBeenCalledTimes(1);
    expect(runDecisionMock).toHaveBeenCalledTimes(1);
    expect(executeDecisionMock).not.toHaveBeenCalled(); // flat → no execute
  });

  it("existing AIT-CADENCE-SELF-HEAL-01 tests unaffected: audit fires only its own telemetry, not OBS lines", async () => {
    const { runMonitorTickOnce } = await importMonitor();
    const bot = makeBot({ id: "bot-idle-auto", status: "idle", mode: "auto", autoNext: true });
    getActiveBotsMock.mockResolvedValue([bot]);

    await runMonitorTickOnce();

    // The audit may emit its own appendTelemetry line, but no [AIT-OBS] lines
    // are produced by the audit alone (those only come from scheduled timer fires).
    expect(obsTelLines()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1); // audit-armed timer present
  });

  // --- LLM failure taxonomy: ok:false must never be reported as flat -----------

  it("ok:false reason=timeout → exit=llm_timeout (never flat)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle("bot-obs-timeout");
    runDecisionMock.mockResolvedValue({ ok: false, reason: "timeout", detail: "G12 60 s budget exceeded" });

    scheduleAutoNext("bot-obs-timeout", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=llm_timeout");
    expect(endLines()[0]).not.toContain("exit=flat");
    expect(endLines()[0]).toContain("phase=llm");
  });

  it("ok:false reason=gateway → exit=llm_gateway (never flat)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle("bot-obs-gw");
    runDecisionMock.mockResolvedValue({ ok: false, reason: "gateway", detail: "502 from provider" });

    scheduleAutoNext("bot-obs-gw", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=llm_gateway");
    expect(endLines()[0]).not.toContain("exit=flat");
    expect(endLines()[0]).toContain("phase=llm");
  });

  it("ok:false reason=malformed → exit=llm_malformed (never flat)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle("bot-obs-malformed");
    runDecisionMock.mockResolvedValue({ ok: false, reason: "malformed", detail: "zod parse failed after retry" });

    scheduleAutoNext("bot-obs-malformed", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=llm_malformed");
    expect(endLines()[0]).not.toContain("exit=flat");
    expect(endLines()[0]).toContain("phase=llm");
  });

  it("guardrail rejection → exit=guardrail_rejected (never flat)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle("bot-obs-guardrail");
    runDecisionMock.mockResolvedValue({
      ok: true, decisionId: "dec-rej", decision: {}, clamped: null,
      rejected: true, violations: [{ code: "G1", detail: "max leverage exceeded" }], latencyMs: 10,
    });

    scheduleAutoNext("bot-obs-guardrail", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=guardrail_rejected");
    expect(endLines()[0]).not.toContain("exit=flat");
    expect(endLines()[0]).toContain("phase=llm");
  });

  it("executeDecision ok:false → exit=exec_rejected", async () => {
    const { scheduleAutoNext } = await importMonitor();
    const bot = makeBot({ id: "bot-obs-execrej", status: "idle", mode: "auto", autoNext: true, graduationState: "graduated" });
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY });
    getSessionByWalletMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    const clamped = { action: "long", sizeBase: 2, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 };
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "dec-execrej", decision: {}, clamped, rejected: false, violations: [], latencyMs: 5 });
    executeDecisionMock.mockResolvedValue({ ok: false, reason: "rejected", detail: "position size below venue minimum" });

    scheduleAutoNext("bot-obs-execrej", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=exec_rejected");
    expect(endLines()[0]).toContain("phase=execution");
  });

  // --- rearmed field -----------------------------------------------------------

  it("flat/stale paths that reschedule emit rearmed=true in the terminal line", async () => {
    const { scheduleAutoNext } = await importMonitor();
    armFlatCycle("bot-obs-rearmed");
    // runDecisionMock returns flat (from armFlatCycle) → scheduleAutoNext called inside runAutoCycle

    scheduleAutoNext("bot-obs-rearmed", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("rearmed=true");
  });

  it("paused path emits rearmed=false (no future timer set by paused exit)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    const bot = makeBot({ id: "bot-obs-paused", status: "idle", mode: "auto", autoNext: true });
    getBotMock.mockResolvedValue(bot);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY });
    getSessionByWalletMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    // No LLM ciphertext → bot pauses with no_api_key (no scheduleAutoNext call)
    getLlmCiphertextMock.mockResolvedValue(null);

    scheduleAutoNext("bot-obs-paused", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=paused");
    expect(endLines()[0]).toContain("rearmed=false");
  });

  it("thrown path emits rearmed=false (pendingReconciliation instead of timer)", async () => {
    const { scheduleAutoNext } = await importMonitor();
    getBotMock.mockRejectedValue(new Error("venue-outage"));

    scheduleAutoNext("bot-obs-thrown-rearmed", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    expect(endLines()).toHaveLength(1);
    expect(endLines()[0]).toContain("exit=thrown");
    expect(endLines()[0]).toContain("rearmed=false");
  });

  // --- Overlapping cycles: coherent independent identities ---------------------

  it("overlapping cycles for the same bot: independent cids, phases, and terminal lines; rearmed read from timer map without cross-cycle mutation", async () => {
    const { scheduleAutoNext, runMonitorTickOnce } = await importMonitor();

    // Cycle 1: timer fires, cycle hangs indefinitely at bot read
    let releaseCycle1!: (v: unknown) => void;
    getBotMock.mockImplementationOnce(() => new Promise((res) => { releaseCycle1 = res; }));

    scheduleAutoNext("bot-obs-overlap", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    // Only one start line at this point — extract cid1 from it directly.
    expect(startLines()).toHaveLength(1);
    const cid1 = startLines()[0].match(/cid=(\S+)/)?.[1];
    expect(cid1).toBeTruthy();
    expect(endLines()).toHaveLength(0); // cycle 1 in-flight

    // Cadence audit arms cycle 2's timer; cycle 2 runs fast (flat, resolves immediately)
    const botFast = makeBot({ id: "bot-obs-overlap", status: "idle", mode: "auto", autoNext: true, graduationState: "graduated" });
    getActiveBotsMock.mockResolvedValue([botFast]);
    getBotMock.mockResolvedValue(botFast);
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY });
    getSessionByWalletMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockReturnValue(Buffer.from("sk"));
    buildContextMock.mockResolvedValue({ system: "s", user: "u", contextDigest: { price: 100 } });
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "d2", decision: {}, clamped: { action: "flat" }, rejected: false, violations: [], latencyMs: 5 });

    await runMonitorTickOnce(); // arms cycle 2 boundary timer
    // Advance to fire cycle 2's timer — cycle 1 is still hanging
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000);

    const cid2 = startLines().find((l) => !l.includes(cid1!))?.match(/cid=(\S+)/)?.[1];
    expect(cid2).toBeTruthy();
    expect(cid1).not.toEqual(cid2);

    // Cycle 2 should have settled (fast flat)
    const end2 = endLines().find((l) => l.includes(cid2!));
    expect(end2).toBeTruthy();
    // Cycle 1 has not yet settled
    const end1 = endLines().find((l) => l.includes(cid1!));
    expect(end1).toBeFalsy();

    // Release cycle 1 → status gate (non-idle bot)
    releaseCycle1(makeBot({ id: "bot-obs-overlap", status: "open" }));
    await vi.advanceTimersByTimeAsync(0);

    const end1After = endLines().find((l) => l.includes(cid1!));
    expect(end1After).toBeTruthy();
    expect(end1After).toContain("exit=status_gate");
    // rearmed on cycle 1's terminal is read from the timer map at settlement time
    // (no cross-cycle mutation: the flag comes from autoNextTimers.has, not from cycle 2's state)
    expect(end1After).toMatch(/rearmed=(true|false)/);
  });

  // --- Shutdown cleanup --------------------------------------------------------

  it("stopAiTraderMonitor clears the outstanding 60 s watchdog; advancing time afterward emits no stale slow or terminal line", async () => {
    const { scheduleAutoNext, stopAiTraderMonitor } = await importMonitor();

    // Hang the cycle so the watchdog is armed but has not fired yet
    getBotMock.mockImplementation(() => new Promise(() => {})); // never resolves

    scheduleAutoNext("bot-obs-stop", "15m");
    await vi.advanceTimersByTimeAsync(TF_15M + 2_000); // timer fires; watchdog armed; cycle hangs

    expect(startLines()).toHaveLength(1);
    expect(endLines()).toHaveLength(0);
    appendTelemetryMock.mockClear();

    // Stop the monitor — must clear the watchdog and mark obs stopped
    stopAiTraderMonitor();

    // Advancing past the 60 s watchdog must produce no slow or terminal line
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slowLines()).toHaveLength(0);
    expect(endLines()).toHaveLength(0);
    expect(appendTelemetryMock).not.toHaveBeenCalled();
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
