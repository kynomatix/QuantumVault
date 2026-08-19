import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiTraderBot } from "@shared/schema";

const getBotMock = vi.fn();
const updateBotMock = vi.fn();
const getWalletLlmCiphertextMock = vi.fn();
const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const getOpenDecisionsMock = vi.fn();
const getUnresolvedDecisionsMock = vi.fn();
const claimAnalysisMock = vi.fn();
const transitionStateMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getAiTraderBot: (...a: unknown[]) => getBotMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    getWalletLlmApiKeyCiphertext: (...a: unknown[]) => getWalletLlmCiphertextMock(...a),
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    getOpenAiTraderDecisions: (...a: unknown[]) => getOpenDecisionsMock(...a),
    getUnresolvedAiTraderDecisions: (...a: unknown[]) => getUnresolvedDecisionsMock(...a),
    claimAiTraderAnalysis: (...a: unknown[]) => claimAnalysisMock(...a),
    transitionAiTraderState: (...a: unknown[]) => transitionStateMock(...a),
  },
}));

const readJournalMock = vi.fn();
vi.mock("../../server/ai-trader/execution-journal", () => ({
  readExecutionJournalPage: (...a: unknown[]) => readJournalMock(...a),
}));

const getSessionMock = vi.fn();
const restoreSecurityMock = vi.fn();
const decryptLlmApiKeyMock = vi.fn();
vi.mock("../../server/session-v3", () => ({
  getSessionByWalletAddress: (...a: unknown[]) => getSessionMock(...a),
  restoreWalletSecurityFromStorage: (...a: unknown[]) => restoreSecurityMock(...a),
  decryptLlmApiKeyV3: (...a: unknown[]) => decryptLlmApiKeyMock(...a),
  computeBotPolicyHmac: vi.fn(),
  getUmkForWebhook: vi.fn(),
  healExecutionUmkFromStorage: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptMnemonic: vi.fn(),
  encryptBotSubaccountKeyV3: vi.fn(),
}));

vi.mock("../../server/agent-wallet", () => ({ resolveAgentKeypair: vi.fn() }));
const getAdapterMock = vi.fn();
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...a),
  getDefaultAdapter: vi.fn(),
}));
vi.mock("../../server/db", () => ({ db: {} }));
vi.mock("../../server/market-registry", () => ({ getMarketInfo: vi.fn() }));
vi.mock("../../server/ai-assistant/models-catalog", () => ({ isSelectableModel: vi.fn(() => true) }));

const buildContextMock = vi.fn();
vi.mock("../../server/ai-trader/context-builder", () => ({
  buildMarketContext: (...a: unknown[]) => buildContextMock(...a),
  marketToDatafeedTicker: vi.fn(),
}));
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: vi.fn(),
  CHART_CANDLE_POLICY: {
    consumer: "chart",
    acceptedBasis: ["perp"],
    acceptedFinality: ["finalized", "forming"],
    acceptedProxy: ["direct"],
  },
  isCandleBasisUnavailableError: (err: unknown) =>
    (err as { name?: string } | null)?.name === "CandleBasisUnavailableError",
}));

const runDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/decide", () => ({
  runDecision: (...a: unknown[]) => runDecisionMock(...a),
}));

const executeDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/executor", () => ({
  executeDecision: (...a: unknown[]) => executeDecisionMock(...a),
  aiTraderPolicyObject: vi.fn(),
}));
vi.mock("../../server/ai-trader/monitor", () => ({
  userInitiatedClose: vi.fn(),
  parseOpenDecision: vi.fn(),
  computeUnrealizedPnl: vi.fn(),
  scheduleAutoNext: vi.fn(),
  nextCycleTimeframe: vi.fn(),
  SCANNER_CANDIDATE_MAX_AGE_MS: 20 * 60_000,
}));
vi.mock("../../server/ai-trader/graduation", () => ({
  sanitizeGraduationCriteria: vi.fn(),
  canGoLive: vi.fn(),
}));

const getScannerShortlistMock = vi.fn();
const getScannerShortlistResultMock = vi.fn();
const getScannerStatusMock = vi.fn();
vi.mock("../../server/ai-trader/scanner", () => ({
  getScannerStatus: (...a: unknown[]) => getScannerStatusMock(...a),
  getScannerShortlist: (...a: unknown[]) => getScannerShortlistMock(...a),
  getScannerShortlistResult: (...a: unknown[]) => getScannerShortlistResultMock(...a),
}));
const scannerCapabilitiesMock = vi.hoisted(() => ({
  producerEnabled: true,
  consumersEnabled: false,
  liveExecutionEnabled: false,
}));
vi.mock("../../server/ai-trader/scanner-capabilities", () => ({
  SCANNER_CAPABILITIES: scannerCapabilitiesMock,
}));
vi.mock("../../server/ai-trader/calibration", () => ({ computeConfidenceCalibration: vi.fn() }));

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

import { registerAiTraderRoutes, summarizeCandleProvenance } from "../../server/ai-trader/routes";

describe("AI Trader chart provenance summary", () => {
  const row = (finality: "finalized" | "forming") => ({
    provenance: {
      source: "okx" as const,
      venue: "okx" as const,
      basis: "perp" as const,
      proxy: "direct" as const,
      finality,
      timeSemantic: "open_time" as const,
    },
  });

  it("preserves complete identity and sorted distinct finality", () => {
    expect(summarizeCandleProvenance([row("forming"), row("finalized"), row("forming")])).toEqual({
      source: "okx",
      venue: "okx",
      basis: "perp",
      proxy: "direct",
      timeSemantic: "open_time",
      finality: ["finalized", "forming"],
    });
  });

  it("rejects missing, unknown, and mixed identity", () => {
    expect(() => summarizeCandleProvenance([])).toThrow("missing provenance");
    expect(() => summarizeCandleProvenance([{
      provenance: { ...row("finalized").provenance, source: "unknown" },
    }])).toThrow("malformed provenance");
    expect(() => summarizeCandleProvenance([
      row("finalized"),
      { provenance: { ...row("forming").provenance, venue: "gate" } },
    ])).toThrow("mixed provenance identity");
  });
});

type Handler = (req: any, res: any, next?: any) => unknown;

function buildApp(): { routes: Map<string, Handler[]>; app: any } {
  const routes = new Map<string, Handler[]>();
  const record = (method: string) => (path: string, ...handlers: Handler[]) => {
    routes.set(method + " " + path, handlers);
  };
  return {
    routes,
    app: {
      get: record("GET"),
      post: record("POST"),
      delete: record("DELETE"),
      put: record("PUT"),
      patch: record("PATCH"),
    },
  };
}

async function invoke(routes: Map<string, Handler[]>, key: string, req: any) {
  const chain = routes.get(key);
  if (!chain) throw new Error("Route not registered: " + key);
  let finish!: (value: { statusCode: number; body: any }) => void;
  const finished = new Promise<{ statusCode: number; body: any }>((resolve) => { finish = resolve; });
  const res: any = {
    statusCode: 200,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { finish({ statusCode: res.statusCode, body }); },
  };
  let index = 0;
  const next = () => { index += 1; };
  for (; index < chain.length;) {
    const before = index;
    await chain[index](req, res, next);
    if (before === index) break;
  }
  return Promise.race([
    finished,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("route never responded")), 2_000)),
  ]);
}

function scannerBot(): AiTraderBot {
  return {
    id: "scanner-bot-route",
    walletAddress: "WALLET_ROUTE",
    protocol: "pacifica",
    market: "SOL-PERP",
    timeframe: "15m",
    marketSource: "scanner",
    mode: "auto",
    autoNext: true,
    status: "idle",
    pauseReason: null,
  } as unknown as AiTraderBot;
}

describe("AI Trader scanner route market admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBotMock.mockResolvedValue(scannerBot());
    getScannerShortlistMock.mockReturnValue([{
      protocol: "pacifica",
      market: "UNKNOWN-PERP",
      timeframe: "15m",
      evaluatedAt: Date.now(),
    }]);
    getScannerShortlistResultMock.mockImplementation(() => ({
      authority: "tradable",
      candidates: getScannerShortlistMock(),
    }));
    isMarketAdmittedMock.mockReturnValue(false);
    isMultiplierQuarantinedMock.mockReturnValue(false);
  });

  it("manual scanner consumer rejects a stale absent or diagnostic-only generation before LLM or mutation", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    for (const authority of ["stale", "absent", "diagnostic_only"] as const) {
      vi.clearAllMocks();
      getBotMock.mockResolvedValue(scannerBot());
      getScannerShortlistResultMock.mockReturnValue({ authority, candidates: [] });
      const built = buildApp();
      registerAiTraderRoutes(built.app);
      const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
        params: { id: "scanner-bot-route" }, session: { walletAddress: "WALLET_ROUTE" },
        body: {}, query: {}, headers: {},
      });
      expect(result.statusCode).toBe(409);
      expect(updateBotMock).not.toHaveBeenCalled();
      expect(buildContextMock).not.toHaveBeenCalled();
      expect(runDecisionMock).not.toHaveBeenCalled();
      expect(executeDecisionMock).not.toHaveBeenCalled();
    }
  });

  it("refuses an unadmitted fresh manual pick before UMK, bot write, context, LLM, or execution", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    const result = await invoke(
      built.routes,
      "POST /api/ai-trader/:id/analyze",
      {
        params: { id: "scanner-bot-route" },
        session: { walletAddress: "WALLET_ROUTE" },
        body: {},
        query: {},
        headers: {},
      },
    );

    expect(result).toMatchObject({
      statusCode: 409,
      body: { error: "scanner_no_candidates" },
    });
    expect(isMarketAdmittedMock).toHaveBeenCalledWith("UNKNOWN-PERP");
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(restoreSecurityMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
  });

  it("refuses a multiplier candidate before registry admission, UMK, bot write, LLM, or execution", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    isMultiplierQuarantinedMock.mockReturnValue(true);
    isMarketAdmittedMock.mockReturnValue(true);
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    const result = await invoke(
      built.routes,
      "POST /api/ai-trader/:id/analyze",
      {
        params: { id: "scanner-bot-route" },
        session: { walletAddress: "WALLET_ROUTE" },
        body: {},
        query: {},
        headers: {},
      },
    );

    expect(result).toMatchObject({
      statusCode: 409,
      body: { error: "multiplier_unqualified" },
    });
    expect(isMultiplierQuarantinedMock).toHaveBeenCalledWith("UNKNOWN-PERP");
    expect(isMarketAdmittedMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
    expect(executeDecisionMock).not.toHaveBeenCalled();
  });
});

function fixedBot(paperMode: boolean): AiTraderBot {
  return {
    id: paperMode ? "paper-route" : "live-route",
    walletAddress: "WALLET_ROUTE",
    protocol: "pacifica",
    market: "SOL-PERP",
    timeframe: "15m",
    marketSource: "fixed",
    model: "anthropic/claude-opus-4.8",
    mode: "suggest",
    autoNext: false,
    status: "idle",
    pauseReason: null,
    paperMode,
  } as unknown as AiTraderBot;
}

describe("AI Trader manual analyze position-authority inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWalletLlmCiphertextMock.mockResolvedValue("ciphertext");
    getSessionMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    decryptLlmApiKeyMock.mockReturnValue(Buffer.from("test-key"));
    getWalletMock.mockResolvedValue({ agentPublicKey: "agent-public-key" });
    getAdapterMock.mockReturnValue({});
    getRecentClosedMock.mockResolvedValue([]);
    getOpenDecisionsMock.mockResolvedValue([]);
    getUnresolvedDecisionsMock.mockResolvedValue([]);
    claimAnalysisMock.mockImplementation(async ({ updates }: { updates?: Record<string, unknown> }) => {
      const bot = await getBotMock.mock.results[0]?.value;
      return { ...bot, ...(updates ?? {}), status: "analyzing", pauseReason: null };
    });
    transitionStateMock.mockResolvedValue({});
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock.mockResolvedValue({
      ok: true,
      decisionId: "decision-route",
      decision: { action: "flat" },
      clamped: { action: "flat" },
      rejected: false,
      violations: [],
      latencyMs: 1,
    });
  });

  it("paper manual analyze rejects an unresolved open row before context or LLM work", async () => {
    const bot = fixedBot(true);
    const closedRows = [{ id: "closed-row", closedAt: new Date() }];
    const openRows = [{ id: "open-row", outcome: "executed", closedAt: null }];
    getBotMock.mockResolvedValue(bot);
    getRecentClosedMock.mockResolvedValue(closedRows);
    getOpenDecisionsMock.mockResolvedValue(openRows);
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id },
      session: { walletAddress: bot.walletAddress },
      body: {},
      query: {},
      headers: {},
    });

    expect(result.statusCode).toBe(409);
    expect(getRecentClosedMock).toHaveBeenCalledWith(bot.id, 20);
    expect(getOpenDecisionsMock).toHaveBeenCalledWith(bot.id, 2);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
  });

  it("live manual analyze does not read or supply paper-position rows", async () => {
    const bot = fixedBot(false);
    const closedRows = [{ id: "closed-row", closedAt: new Date() }];
    getBotMock.mockResolvedValue(bot);
    claimAnalysisMock.mockResolvedValue({ ...bot, status: "analyzing", pauseReason: null });
    getRecentClosedMock.mockResolvedValue(closedRows);
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id },
      session: { walletAddress: bot.walletAddress },
      body: {},
      query: {},
      headers: {},
    });

    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(getOpenDecisionsMock).toHaveBeenCalledWith(bot.id, 2);
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      recentClosedDecisions: closedRows,
      paperPositionRows: [],
    });
  });
  it("terminalizes a manual close-with-no-position in the same analyzing-to-idle release", async () => {
    const bot = fixedBot(true);
    getBotMock.mockResolvedValue(bot);
    runDecisionMock.mockResolvedValue({
      ok: true,
      decisionId: "decision-close-route",
      decision: { action: "close" },
      clamped: { action: "close" },
      rejected: false,
      violations: [],
      latencyMs: 1,
    });
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id },
      session: { walletAddress: bot.walletAddress },
      body: {},
      query: {},
      headers: {},
    });

    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: bot.id,
      expectedStatus: "analyzing",
      nextStatus: "idle",
      decisionId: "decision-close-route",
      expectedDecisionOutcome: null,
      decisionOutcome: "flat",
    }));
  });
});

function failedTrialBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    ...fixedBot(true),
    id: "failed-trial-route",
    graduationState: "failed",
    status: "idle",
    pauseReason: null,
    ...overrides,
  } as AiTraderBot;
}

describe("AI Trader restart-trial stale decision recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOpenDecisionsMock.mockResolvedValue([]);
    getUnresolvedDecisionsMock.mockResolvedValue([]);
    transitionStateMock.mockImplementation(async ({ botUpdates }: { botUpdates?: Record<string, unknown> }) => ({
      ...failedTrialBot(),
      ...(botUpdates ?? {}),
      status: "idle",
      pauseReason: null,
    }));
  });

  function restartRequest() {
    return {
      params: { id: "failed-trial-route" },
      session: { walletAddress: "WALLET_ROUTE" },
      body: {}, query: {}, headers: {},
    };
  }

  it("atomically terminalizes the exact expired orphan while resetting the failed trial", async () => {
    const bot = failedTrialBot();
    const decidedAt = new Date(Date.now() - 11 * 60_000);
    getBotMock.mockResolvedValue(bot);
    getUnresolvedDecisionsMock.mockResolvedValue([{
      id: "expired-orphan",
      botId: bot.id,
      outcome: null,
      decidedAt,
      closedAt: null,
    }]);
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/restart-trial", restartRequest());

    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(transitionStateMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: bot.id,
      expectedStatus: "idle",
      expectedPauseReason: null,
      nextStatus: "idle",
      nextPauseReason: null,
      decisionId: "expired-orphan",
      expectedDecisionOutcome: null,
      decisionOutcome: "aborted_trial_restart",
      botUpdates: expect.objectContaining({
        graduationState: "in_trial",
        dailyRealizedPnl: "0",
        consecutiveLosses: 0,
        trialStartedAt: expect.any(Date),
      }),
    }));
  });

  it("preserves the zero-unresolved restart without inventing a decision mutation", async () => {
    getBotMock.mockResolvedValue(failedTrialBot());
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/restart-trial", restartRequest());

    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    const transition = transitionStateMock.mock.calls[0][0];
    expect(transition).not.toHaveProperty("decisionId");
    expect(transition).not.toHaveProperty("decisionOutcome");
  });

  it("denies fresh duplicate open non-failed and live cases without a transition", async () => {
    const freshDecision = {
      id: "fresh-orphan",
      botId: "failed-trial-route",
      outcome: null,
      decidedAt: new Date(),
      closedAt: null,
    };
    const cases = [
      { bot: failedTrialBot(), open: [], unresolved: [freshDecision] },
      { bot: failedTrialBot(), open: [], unresolved: [freshDecision, { ...freshDecision, id: "duplicate" }] },
      { bot: failedTrialBot(), open: [{ id: "open-position" }], unresolved: [] },
      { bot: failedTrialBot({ graduationState: "in_trial" }), open: [], unresolved: [] },
      { bot: failedTrialBot({ paperMode: false }), open: [], unresolved: [] },
    ];
    for (const candidate of cases) {
      vi.clearAllMocks();
      getBotMock.mockResolvedValue(candidate.bot);
      getOpenDecisionsMock.mockResolvedValue(candidate.open);
      getUnresolvedDecisionsMock.mockResolvedValue(candidate.unresolved);
      const built = buildApp();
      registerAiTraderRoutes(built.app);
      const result = await invoke(built.routes, "POST /api/ai-trader/:id/restart-trial", restartRequest());
      expect(result.statusCode).toBe(409);
      expect(transitionStateMock).not.toHaveBeenCalled();
    }
  });

  it("returns 409 when the atomic decision-and-bot transition loses its predicate", async () => {
    const bot = failedTrialBot();
    getBotMock.mockResolvedValue(bot);
    getUnresolvedDecisionsMock.mockResolvedValue([{
      id: "expired-orphan",
      botId: bot.id,
      outcome: null,
      decidedAt: new Date(Date.now() - 11 * 60_000),
      closedAt: null,
    }]);
    transitionStateMock.mockResolvedValue(undefined);
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/restart-trial", restartRequest());

    expect(result).toMatchObject({ statusCode: 409, body: { error: "state_denied" } });
  });
});

describe("AI Trader scanner status reporting", () => {
  it("status distinguishes healthy zero setups from diagnostic-only coverage", async () => {
    const healthy = {
      shortlist: { flash: [], pacifica: [] }, currentGeneration: {
        generation: 7, verdict: "tradable", candidateCounts: { flash: 0, pacifica: 0 },
      }, lastTradableGeneration: { generation: 7 }, recentHistory: [], lastBoundaryStats: null,
      excludedMarkets: [], multiplierQuarantinedMarkets: [], scannerRunning: true,
    };
    const diagnostic = {
      ...healthy,
      currentGeneration: { generation: 8, verdict: "diagnostic_only", candidateCounts: { flash: 0, pacifica: 0 } },
      lastTradableGeneration: { generation: 7 },
    };
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    getScannerStatusMock.mockReturnValueOnce(healthy);
    expect((await invoke(built.routes, "GET /api/ai-trader/scanner/status", {
      query: {}, body: {}, headers: {}, session: { walletAddress: "WALLET_ROUTE" },
    })).body.currentGeneration.verdict).toBe("tradable");
    getScannerStatusMock.mockReturnValueOnce(diagnostic);
    const degraded = await invoke(built.routes, "GET /api/ai-trader/scanner/status", {
      query: {}, body: {}, headers: {}, session: { walletAddress: "WALLET_ROUTE" },
    });
    expect(degraded.body.currentGeneration.verdict).toBe("diagnostic_only");
    expect(degraded.body.lastTradableGeneration.generation).toBe(7);
  });
});

function journalBot(walletAddress: string): AiTraderBot {
  return {
    id: "bot-route-journal",
    walletAddress,
    protocol: "pacifica",
    protocolSubaccountId: "public-subaccount",
    market: "SOL-PERP",
    status: "idle",
  } as unknown as AiTraderBot;
}

describe("AI Trader execution journal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("execution journal route is wallet scoped and omits accountRef", async () => {
    const built = buildApp();
    registerAiTraderRoutes(built.app as any);
    const key = "GET /api/ai-trader/:id/execution-journal";

    getBotMock.mockResolvedValueOnce(journalBot("another-wallet"));
    const denied = await invoke(built.routes, key, {
      params: { id: "bot-route-journal" }, query: {}, body: {}, headers: {}, session: { walletAddress: "owner-wallet" },
    });
    expect(denied.statusCode).toBe(404);
    expect(readJournalMock).not.toHaveBeenCalled();

    getBotMock.mockResolvedValueOnce(journalBot("owner-wallet"));
    readJournalMock.mockResolvedValueOnce({
      events: [{ id: "event-1", botId: "bot-route-journal", market: "SOL-PERP", eventType: "attempt_claimed",
        accountRef: "public-subaccount-that-must-not-cross-the-route-boundary" }],
      nextCursor: null,
    });
    const allowed = await invoke(built.routes, key, {
      params: { id: "bot-route-journal" }, query: { limit: "20" }, body: {}, headers: {}, session: { walletAddress: "owner-wallet" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.events[0]).not.toHaveProperty("accountRef");
    expect(readJournalMock).toHaveBeenCalledWith({ botId: "bot-route-journal", limit: 20 });
  });
});
