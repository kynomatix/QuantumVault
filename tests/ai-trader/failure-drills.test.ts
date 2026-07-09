// WO-9 failure drills — four explicit, individually reportable failure
// simulations from docs/AGENTIC_TRADER_PLAN.md (Part B, WO-9):
//
//   Drill 1 — OpenRouter 500 / timeout mid-analyze  → bot stays flat, no order,
//             clean idle + reschedule (no pause, no LLM re-spend loop).
//   Drill 2 — LLM key removed mid-lifecycle         → the OPEN position is
//             unaffected (monitor loop never touches the LLM key); the NEXT
//             analyze cycle pauses 'no_api_key' BEFORE any gateway call.
//   Drill 3 — UMK expiry during auto-next           → paused 'reauth_required'
//             at a flat point: no LLM spend, no context build, no order.
//   Drill 4 — Pacifica 429 storm                    → venue read failures are
//             NEVER treated as a close (no fabricated exit, no protective
//             close, no pause); exactly ONE venue read per tick (the adapter
//             owns backoff — this layer must not retry-storm); a rate-limited
//             entry abort returns the bot to idle, never stranded 'analyzing'.
//
// Same mock harness as monitor.test.ts (storage, session-v3, notifications,
// adapter registry, datafeed, context-builder, decide, executor all mocked).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";

const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const updateBotMock = vi.fn();
const updateDecisionMock = vi.fn();
const getDecisionsMock = vi.fn();
const getBotMock = vi.fn();
const getActiveBotsMock = vi.fn();
const getLlmCiphertextMock = vi.fn();
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
  decryptBotSubaccountKey: (...a: unknown[]) => decryptSubKeyMock(...a),
  healExecutionUmkFromStorage: (...a: unknown[]) => healUmkMock(...a),
  getSessionByWalletAddress: (...a: unknown[]) => getSessionByWalletMock(...a),
  restoreWalletSecurityFromStorage: (...a: unknown[]) => restoreSecurityMock(...a),
  decryptLlmApiKeyV3: (...a: unknown[]) => decryptLlmKeyMock(...a),
  verifyBotPolicyHmac: vi.fn(() => true),
}));

const notifyMock = vi.fn();
vi.mock("../../server/notification-service", () => ({
  sendTradeNotification: (...a: unknown[]) => notifyMock(...a),
  getCloseReasonLabel: (source: string, leg?: string) => (leg ? `${leg} Hit` : source),
}));

const getAdapterMock = vi.fn();
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...a),
}));

const fetchOHLCVMock = vi.fn();
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: (...a: unknown[]) => fetchOHLCVMock(...a),
}));

const buildContextMock = vi.fn();
vi.mock("../../server/ai-trader/context-builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-trader/context-builder")>();
  return { ...actual, buildMarketContext: (...a: unknown[]) => buildContextMock(...a) };
});

const runDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/decide", () => ({
  runDecision: (...a: unknown[]) => runDecisionMock(...a),
}));

const executeDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-trader/executor")>();
  return { ...actual, executeDecision: (...a: unknown[]) => executeDecisionMock(...a) };
});

// --- Fixtures -----------------------------------------------------------------

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 15m boundary
const TF_15M = 900_000;
const AGENT_PUBKEY = "AgEntPubKey1111111111111111111111111111111";

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "bot-1111-2222",
    walletAddress: "WALLET_X",
    protocol: "pacifica",
    protocolSubaccountId: "sub-1",
    botSubaccountKeyEncryptedV3: "v3-sub-ciphertext",
    derivationIndex: null,
    derivationPathVersion: null,
    market: "SOL-PERP",
    timeframe: "15m",
    mode: "auto",
    paperMode: false,
    riskProfile: "guarded",
    autoNext: true,
    allocatedUsdc: "1000",
    maxLeverage: 5,
    policyHmac: "hmac-abc",
    status: "idle",
    graduationState: "graduated",
    graduationCriteria: null,
    trialStartedAt: null,
    dailyRealizedPnl: "0",
    consecutiveLosses: 0,
  ...overrides,
  } as unknown as AiTraderBot;
}

function makeOpenDecision(): AiTraderDecision {
  return {
    id: "dec-1",
    botId: "bot-1111-2222",
    outcome: "executed",
    closedAt: null,
    decidedAt: new Date(NOW - 2 * TF_15M),
    entryPrice: "150",
    clampedDecision: { action: "long", sizeBase: 2, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 },
  } as unknown as AiTraderDecision;
}

const OPEN_POSITION = {
  internalSymbol: "SOL-PERP",
  baseSize: 2,
  entryPrice: 150,
  markPrice: 150,
  unrealizedPnl: 0,
  leverage: 2,
  liquidationPrice: null,
  marginMode: "cross" as const,
};

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

async function importMonitor() {
  return await import("../../server/ai-trader/monitor");
}

/** Arm an idle auto bot ready for runAutoCycle (wallet + adapter + fresh session). */
function armAutoBot(overrides: Partial<AiTraderBot> = {}) {
  const bot = makeBot(overrides);
  getBotMock.mockResolvedValue(bot);
  getAdapterMock.mockReturnValue(makeAdapter());
  getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
  return bot;
}

function armLlmKey() {
  getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
  getLlmCiphertextMock.mockResolvedValue("ct");
  decryptLlmKeyMock.mockReturnValue(Buffer.from("sk-or-secret"));
  buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150.25 } });
}

const botUpdates = () => updateBotMock.mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const m of [
    getWalletMock, getRecentClosedMock, updateBotMock, updateDecisionMock, getDecisionsMock,
    getBotMock, getActiveBotsMock, getLlmCiphertextMock, getUmkMock, decryptKeyMock, decryptSubKeyMock,
    healUmkMock, getSessionByWalletMock, restoreSecurityMock, decryptLlmKeyMock, notifyMock,
    getAdapterMock, fetchOHLCVMock, buildContextMock, runDecisionMock, executeDecisionMock,
  ]) {
    m.mockReset();
  }
  getRecentClosedMock.mockResolvedValue([]);
  updateBotMock.mockResolvedValue({});
  updateDecisionMock.mockResolvedValue({});
  notifyMock.mockResolvedValue(true);
  healUmkMock.mockResolvedValue(undefined);
  restoreSecurityMock.mockResolvedValue(undefined);
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

// --- Drill 1: OpenRouter 500 / timeout mid-analyze ------------------------------

describe("DRILL 1 — OpenRouter 500 / timeout mid-analyze: bot stays flat", () => {
  it("gateway 500: no order, no pause — analyzing → idle + reschedule", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    armLlmKey();
    runDecisionMock.mockResolvedValue({ ok: false, reason: "gateway", detail: "OpenRouter 500 Internal Server Error" });

    await runAutoCycle("bot-1111-2222");

    expect(runDecisionMock).toHaveBeenCalledTimes(1); // one spend attempt, no re-spend loop
    expect(executeDecisionMock).not.toHaveBeenCalled(); // bot stays FLAT
    expect(botUpdates().some((u) => u.status === "analyzing")).toBe(true);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(botUpdates().some((u) => u.status === "paused")).toBe(false); // transient ≠ pause
    expect(vi.getTimerCount()).toBeGreaterThan(0); // retries at the next candle boundary
  });

  it("gateway timeout: identical clean no-trade outcome", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    armLlmKey();
    runDecisionMock.mockResolvedValue({ ok: false, reason: "timeout", detail: "request timed out after 120s" });

    await runAutoCycle("bot-1111-2222");

    expect(executeDecisionMock).not.toHaveBeenCalled();
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true);
    expect(botUpdates().some((u) => u.status === "paused")).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

// --- Drill 2: LLM key removed mid-lifecycle --------------------------------------

describe("DRILL 2 — LLM key removed mid-lifecycle", () => {
  it("the OPEN position is unaffected: the monitor tick never touches the LLM key", async () => {
    const { monitorBotOnce } = await importMonitor();
    getLlmCiphertextMock.mockResolvedValue(null); // key deleted
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
    const adapter = makeAdapter({ getPositions: vi.fn(async () => [OPEN_POSITION]) });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ status: "open" }));

    expect(getLlmCiphertextMock).not.toHaveBeenCalled(); // monitoring is LLM-free
    expect(decryptLlmKeyMock).not.toHaveBeenCalled();
    expect(updateDecisionMock).not.toHaveBeenCalled(); // no close recorded
    expect((adapter as any).closePosition).not.toHaveBeenCalled(); // position untouched
    expect(botUpdates().some((u) => u.status === "paused")).toBe(false);
  });

  it("the NEXT analyze cycle pauses 'no_api_key' BEFORE any gateway call or context build", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("umk") } });
    getLlmCiphertextMock.mockResolvedValue(null); // key deleted

    await runAutoCycle("bot-1111-2222");

    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "no_api_key")).toBe(true);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled(); // zero LLM spend
    expect(executeDecisionMock).not.toHaveBeenCalled();
  });
});

// --- Drill 3: UMK expiry during auto-next ----------------------------------------

describe("DRILL 3 — UMK expiry during auto-next: paused at a flat point", () => {
  it("session gone + restore fails → paused 'reauth_required'; no LLM spend, no order", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue(null); // UMK expired / wiped by deploy
    restoreSecurityMock.mockRejectedValue(new Error("no stored security material"));

    await runAutoCycle("bot-1111-2222");

    expect(restoreSecurityMock).toHaveBeenCalledWith("WALLET_X"); // it TRIED to self-heal first
    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "reauth_required")).toBe(true);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled(); // zero LLM spend
    expect(executeDecisionMock).not.toHaveBeenCalled(); // paused FLAT — no order in flight
    expect(notifyMock).toHaveBeenCalled(); // owner is told why the bot stopped
  });

  it("stored key present but UNDECRYPTABLE with the restored UMK → same flat pause", async () => {
    const { runAutoCycle } = await importMonitor();
    armAutoBot();
    getSessionByWalletMock.mockReturnValue({ sessionId: "s", session: { umk: Buffer.from("stale-umk") } });
    getLlmCiphertextMock.mockResolvedValue("ct");
    decryptLlmKeyMock.mockImplementation(() => { throw new Error("v3 auth tag mismatch"); });

    await runAutoCycle("bot-1111-2222");

    expect(botUpdates().some((u) => u.status === "paused" && u.pauseReason === "reauth_required")).toBe(true);
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
  });
});

// --- Drill 4: Pacifica 429 storm --------------------------------------------------

describe("DRILL 4 — Pacifica 429 storm: backoff honored, no naked positions", () => {
  it("getPositions 429s across 3 ticks: ONE read per tick, never treated as a close, no pause", async () => {
    const { monitorBotOnce } = await importMonitor();
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
    const getPositions = vi.fn(async () => { throw new Error("429 too many requests"); });
    const adapter = makeAdapter({ getPositions });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);
    const bot = makeBot({ status: "open" });

    await monitorBotOnce(bot);
    await monitorBotOnce(bot);
    await monitorBotOnce(bot);

    expect(getPositions).toHaveBeenCalledTimes(3); // exactly one read per tick — no retry storm on top of the venue backoff
    expect(updateDecisionMock).not.toHaveBeenCalled(); // read failure NEVER fabricates an exit
    expect(updateBotMock).not.toHaveBeenCalled(); // no pause, no status churn
    expect((adapter as any).closePosition).not.toHaveBeenCalled(); // no panic protective close
  });

  it("bracket check 429s with the position still up: read failure ≠ missing bracket (no G10 close)", async () => {
    const { monitorBotOnce } = await importMonitor();
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
    const adapter = makeAdapter({
      getPositions: vi.fn(async () => [OPEN_POSITION]),
      getOpenStopOrders: vi.fn(async () => { throw new Error("429 too many requests"); }),
    });
    getAdapterMock.mockReturnValue(adapter);
    getDecisionsMock.mockResolvedValue([makeOpenDecision()]);

    await monitorBotOnce(makeBot({ status: "open" }));

    expect((adapter as any).setTpSl).not.toHaveBeenCalled(); // no blind re-place
    expect((adapter as any).closePosition).not.toHaveBeenCalled(); // no G10 close on a read failure
    expect(botUpdates().some((u) => u.status === "paused")).toBe(false);
  });

  it("entry attempt aborts on a rate-limited order (confirmed flat): bot returns to idle, never stranded", async () => {
    const { runAutoCycle } = await importMonitor();
    const idleBot = makeBot();
    // First read (cycle entry gate) sees idle; the post-abort re-read sees the
    // stranded 'analyzing' status that the un-strand branch must repair.
    getBotMock
      .mockResolvedValueOnce(idleBot)
      .mockResolvedValue({ ...idleBot, status: "analyzing" });
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: "WALLET_X", agentPublicKey: AGENT_PUBKEY, agentPrivateKeyEncryptedV3: "v3" });
    armLlmKey();
    const clamped = { action: "long", sizeBase: 2, marginUsdc: 100, stopLossPrice: 145, takeProfitPrice: 160 };
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "dec-9", decision: {}, clamped, rejected: false, violations: [], latencyMs: 5 });
    // Executor abort contract for a clean venue rejection (429) with PROVEN-flat
    // state: aborted_order, structured failure — never a naked position.
    executeDecisionMock.mockResolvedValue({ ok: false, reason: "order_rejected", detail: "429 too many requests (confirmed flat)" });

    await runAutoCycle("bot-1111-2222");

    expect(executeDecisionMock).toHaveBeenCalledTimes(1);
    expect(botUpdates().some((u) => u.status === "idle")).toBe(true); // un-stranded from 'analyzing'
    expect(botUpdates().some((u) => u.status === "paused")).toBe(false); // transient venue pressure ≠ pause
  });
});
