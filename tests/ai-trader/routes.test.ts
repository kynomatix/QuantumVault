import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiTraderBot } from "@shared/schema";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const getBotMock = vi.fn();
const getAiTraderDecisionsMock = vi.fn();
const getAiTraderBotLifetimeStatsMock = vi.fn();
const updateBotMock = vi.fn();
const getWalletLlmCiphertextMock = vi.fn();
const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const getQualificationRecordMock = vi.fn();
const getOpenDecisionsMock = vi.fn();
const getUnresolvedDecisionsMock = vi.fn();
const claimAnalysisMock = vi.fn();
const claimScannerCandidateMock = vi.fn();
const incrementFreeCallsMock = vi.fn();
const decrementFreeCallsMock = vi.fn();
const transitionStateMock = vi.fn();
const qualificationEraMutationPatchMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getAiTraderBot: (...a: unknown[]) => getBotMock(...a),
    getAiTraderDecisions: (...a: unknown[]) => getAiTraderDecisionsMock(...a),
    getAiTraderBotLifetimeStats: (...a: unknown[]) => getAiTraderBotLifetimeStatsMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    getWalletLlmApiKeyCiphertext: (...a: unknown[]) => getWalletLlmCiphertextMock(...a),
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    getAiTraderQualificationRecord: (...a: unknown[]) => getQualificationRecordMock(...a),
    getOpenAiTraderDecisions: (...a: unknown[]) => getOpenDecisionsMock(...a),
    getUnresolvedAiTraderDecisions: (...a: unknown[]) => getUnresolvedDecisionsMock(...a),
    claimAiTraderAnalysis: (...a: unknown[]) => claimAnalysisMock(...a),
    claimAiTraderScannerCandidateAnalysis: (...a: unknown[]) => claimScannerCandidateMock(...a),
    incrementAiTraderFreeCalls: (...a: unknown[]) => incrementFreeCallsMock(...a),
    decrementAiTraderFreeCalls: (...a: unknown[]) => decrementFreeCallsMock(...a),
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
const dbSelectMock = vi.fn();
vi.mock("../../server/db", () => ({
  db: { select: (...a: unknown[]) => dbSelectMock(...a) },
}));
vi.mock("../../server/market-registry", () => ({ getMarketInfo: vi.fn() }));
vi.mock("../../server/ai-assistant/models-catalog", () => ({ isSelectableModel: vi.fn(() => true) }));

const buildContextMock = vi.fn();
vi.mock("../../server/ai-trader/context-builder", () => ({
  buildMarketContext: (...a: unknown[]) => buildContextMock(...a),
  marketToDatafeedTicker: vi.fn(),
}));
const fetchOHLCVMock = vi.hoisted(() => vi.fn());
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: (...args: unknown[]) => fetchOHLCVMock(...args),
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
const parseOpenDecisionMock = vi.fn();
vi.mock("../../server/ai-trader/paper-position-authority", () => ({
  parseOpenDecision: (...a: unknown[]) => parseOpenDecisionMock(...a),
  computeUnrealizedPnl: vi.fn(() => null),
}));
vi.mock("../../server/ai-trader/graduation", () => ({
  sanitizeGraduationCriteria: vi.fn(),
  canGoLive: vi.fn(),
  qualificationEraMutationPatch: (...a: unknown[]) => qualificationEraMutationPatchMock(...a),
}));

const getScannerShortlistMock = vi.fn();
const getScannerShortlistResultMock = vi.fn();
const getScannerStatusMock = vi.fn();
const getScannerConsumptionBoundaryMock = vi.fn(() => ({
  boundaryStart: new Date("2026-08-25T12:00:00.000Z"),
  expiresAt: new Date("2026-08-25T12:15:00.000Z"),
}));
vi.mock("../../server/ai-trader/scanner", () => ({
  getScannerStatus: (...a: unknown[]) => getScannerStatusMock(...a),
  getScannerShortlist: (...a: unknown[]) => getScannerShortlistMock(...a),
  getScannerShortlistResult: (...a: unknown[]) => getScannerShortlistResultMock(...a),
  getScannerConsumptionBoundary: (...a: unknown[]) => getScannerConsumptionBoundaryMock(...a),
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

import {
  projectAiTraderPerformance,
  registerAiTraderRoutes,
  summarizeCandleProvenance,
} from "../../server/ai-trader/routes";
import { __createRequestTraceCollectorForTests } from "../../server/request-trace";

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
    getAdapterMock.mockReturnValue({});
    getUnresolvedDecisionsMock.mockResolvedValue([]);
    transitionStateMock.mockResolvedValue({});
    claimAnalysisMock.mockImplementation(async ({ updates }: { updates?: Record<string, unknown> }) => ({
      ...scannerBot(),
      ...(updates ?? {}),
      status: "analyzing",
      pauseReason: null,
    }));
    claimScannerCandidateMock.mockImplementation(async ({ updates }: { updates?: Record<string, unknown> }) => ({
      outcome: "claimed",
      bot: {
        ...scannerBot(),
        ...(updates ?? {}),
        status: "analyzing",
        pauseReason: null,
      },
    }));
    incrementFreeCallsMock.mockResolvedValue(1);
    decrementFreeCallsMock.mockResolvedValue(undefined);
    qualificationEraMutationPatchMock.mockReturnValue({
      graduationState: "in_trial",
      currentQualificationEraDigest: null,
      graduatedQualificationEraDigest: null,
      qualificationEraInvalidationReason: "scanner_market_selection_changed",
    });
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

  it("persists a manual scanner pick with qualification-era invalidation before context", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    isMarketAdmittedMock.mockReturnValue(true);
    const bot = scannerBot();
    getBotMock.mockResolvedValue(bot);
    getScannerShortlistMock.mockReturnValue([{
      protocol: "pacifica",
      market: "BTC-PERP",
      timeframe: "1h",
      direction: "long",
      setup: "W",
      score: 90,
      necklineDistancePct: 0.1,
      parentTrend: "uptrend",
      evaluatedAt: Date.now(),
    }]);
    getSessionMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getWalletLlmCiphertextMock.mockResolvedValue("ciphertext");
    decryptLlmApiKeyMock.mockReturnValue(Buffer.from("test-key"));
    getWalletMock.mockResolvedValue({ agentPublicKey: "agent-public-key" });
    getRecentClosedMock.mockResolvedValue([]);
    getOpenDecisionsMock.mockResolvedValue([]);
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
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id },
      session: { walletAddress: bot.walletAddress },
      body: {},
      query: {},
      headers: {},
    });

    expect(result.statusCode).toBe(200);
    expect(qualificationEraMutationPatchMock).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({ market: "BTC-PERP", timeframe: "1h" }),
      "scanner_market_selection_changed",
    );
    expect(claimScannerCandidateMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: bot.id,
      expectedStatus: "idle",
      walletAddress: bot.walletAddress,
      boundaryStart: new Date("2026-08-25T12:00:00.000Z"),
      expiresAt: new Date("2026-08-25T12:15:00.000Z"),
      updates: expect.objectContaining({
        market: "BTC-PERP",
        timeframe: "1h",
        graduationState: "in_trial",
        currentQualificationEraDigest: null,
      }),
    }));
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(buildContextMock.mock.calls[0][0].bot).toMatchObject({
      market: "BTC-PERP",
      timeframe: "1h",
      graduationState: "in_trial",
    });
  });

  it("does not divert a manual Ask AI request when the same bot owns the top reservation", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    isMarketAdmittedMock.mockReturnValue(true);
    const bot = scannerBot();
    getBotMock.mockResolvedValue(bot);
    getScannerShortlistMock.mockReturnValue([
      { protocol: "pacifica", market: "BTC-PERP", timeframe: "1h", direction: "long", setup: "W", score: 95, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
      { protocol: "pacifica", market: "ETH-PERP", timeframe: "1h", direction: "long", setup: "W", score: 94, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
    ]);
    getSessionMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getWalletLlmCiphertextMock.mockResolvedValue("ciphertext");
    decryptLlmApiKeyMock.mockReturnValue(Buffer.from("test-key"));
    getWalletMock.mockResolvedValue({ agentPublicKey: "agent-public-key" });
    getRecentClosedMock.mockResolvedValue([]);
    getOpenDecisionsMock.mockResolvedValue([]);
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "same-bot", decision: { action: "flat" }, clamped: { action: "flat" }, rejected: false, violations: [], latencyMs: 1 });

    const built = buildApp();
    registerAiTraderRoutes(built.app);
    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id }, session: { walletAddress: bot.walletAddress }, body: {}, query: {}, headers: {},
    });

    expect(result.statusCode).toBe(200);
    expect(claimScannerCandidateMock).toHaveBeenCalledTimes(1);
    expect(claimScannerCandidateMock).toHaveBeenCalledWith(expect.objectContaining({ market: "BTC-PERP" }));
    expect(buildContextMock.mock.calls[0][0].market).toBe("BTC-PERP");
  });

  it("advances manual Ask AI to the next unclaimed score-90 candidate without an LLM call on the loss", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    isMarketAdmittedMock.mockReturnValue(true);
    const bot = scannerBot();
    getBotMock.mockResolvedValue(bot);
    getScannerShortlistMock.mockReturnValue([
      { protocol: "pacifica", market: "BTC-PERP", timeframe: "1h", direction: "long", setup: "W", score: 110, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
      { protocol: "pacifica", market: "ETH-PERP", timeframe: "1h", direction: "long", setup: "W", score: 90, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
    ]);
    getSessionMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getWalletLlmCiphertextMock.mockResolvedValue("ciphertext");
    decryptLlmApiKeyMock.mockReturnValue(Buffer.from("test-key"));
    getWalletMock.mockResolvedValue({ agentPublicKey: "agent-public-key" });
    getRecentClosedMock.mockResolvedValue([]);
    getOpenDecisionsMock.mockResolvedValue([]);
    buildContextMock.mockResolvedValue({ system: "sys", user: "usr", contextDigest: { price: 150 } });
    runDecisionMock.mockResolvedValue({ ok: true, decisionId: "alternative", decision: { action: "flat" }, clamped: { action: "flat" }, rejected: false, violations: [], latencyMs: 1 });
    claimScannerCandidateMock
      .mockResolvedValueOnce({ outcome: "candidate_claimed" })
      .mockResolvedValueOnce({
        outcome: "claimed",
        bot: { ...bot, market: "ETH-PERP", timeframe: "1h", status: "analyzing" },
      });

    const built = buildApp();
    registerAiTraderRoutes(built.app);
    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id }, session: { walletAddress: bot.walletAddress }, body: {}, query: {}, headers: {},
    });

    expect(result.statusCode).toBe(200);
    expect(claimScannerCandidateMock).toHaveBeenCalledTimes(2);
    expect(runDecisionMock).toHaveBeenCalledTimes(1);
    expect(buildContextMock.mock.calls[0][0].market).toBe("ETH-PERP");
  });

  it("returns the exact 409 without LLM spend when claims exhaust qualifying candidates", async () => {
    scannerCapabilitiesMock.consumersEnabled = true;
    isMarketAdmittedMock.mockReturnValue(true);
    const bot = scannerBot();
    getBotMock.mockResolvedValue(bot);
    getScannerShortlistMock.mockReturnValue([
      { protocol: "pacifica", market: "BTC-PERP", timeframe: "15m", direction: "long", setup: "W", score: 95, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
      { protocol: "pacifica", market: "ETH-PERP", timeframe: "15m", direction: "long", setup: "W", score: 89, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
    ]);
    getSessionMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    getWalletLlmCiphertextMock.mockResolvedValue("ciphertext");
    decryptLlmApiKeyMock.mockReturnValue(Buffer.from("test-key"));
    getWalletMock.mockResolvedValue({ agentPublicKey: "agent-public-key" });
    getRecentClosedMock.mockResolvedValue([]);
    getOpenDecisionsMock.mockResolvedValue([]);
    claimScannerCandidateMock.mockResolvedValue({ outcome: "candidate_claimed" });

    const built = buildApp();
    registerAiTraderRoutes(built.app);
    const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
      params: { id: bot.id }, session: { walletAddress: bot.walletAddress }, body: {}, query: {}, headers: {},
    });

    expect(result).toEqual({
      statusCode: 409,
      body: {
        error: "scanner_candidates_claimed",
        detail: "Every fresh scanner candidate is already reserved for this wallet in the current 15-minute boundary, or no remaining alternative meets the score floor.",
      },
    });
    expect(claimScannerCandidateMock).toHaveBeenCalledTimes(1);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(runDecisionMock).not.toHaveBeenCalled();
  });

  it.each(["schema_unavailable", "database_error"] as const)(
    "returns the exact 503 and refunds a free call on reservation %s",
    async (outcome) => {
    const priorKey = process.env.OPENROUTER_PLATFORM_KEY;
    process.env.OPENROUTER_PLATFORM_KEY = "platform-test-key";
    try {
      scannerCapabilitiesMock.consumersEnabled = true;
      isMarketAdmittedMock.mockReturnValue(true);
      const bot = { ...scannerBot(), paperMode: true } as AiTraderBot;
      getBotMock.mockResolvedValue(bot);
      getScannerShortlistMock.mockReturnValue([
        { protocol: "pacifica", market: "BTC-PERP", timeframe: "15m", direction: "long", setup: "W", score: 95, necklineDistancePct: 0.1, parentTrend: "uptrend", evaluatedAt: Date.now() },
      ]);
      getSessionMock.mockReturnValue({ session: { umk: Buffer.from("umk") } });
      getWalletLlmCiphertextMock.mockResolvedValue(null);
      getWalletMock.mockResolvedValue({ agentPublicKey: "agent-public-key" });
      getRecentClosedMock.mockResolvedValue([]);
      getOpenDecisionsMock.mockResolvedValue([]);
      claimScannerCandidateMock.mockResolvedValue({ outcome });

      const built = buildApp();
      registerAiTraderRoutes(built.app);
      const result = await invoke(built.routes, "POST /api/ai-trader/:id/analyze", {
        params: { id: bot.id }, session: { walletAddress: bot.walletAddress }, body: {}, query: {}, headers: {},
      });

      expect(result).toEqual({
        statusCode: 503,
        body: {
          error: "scanner_candidate_claim_unavailable",
          detail: "Scanner candidate reservation is temporarily unavailable. No analysis was started.",
        },
      });
      expect(incrementFreeCallsMock).toHaveBeenCalledTimes(1);
      expect(decrementFreeCallsMock).toHaveBeenCalledWith(bot.walletAddress);
      expect(runDecisionMock).not.toHaveBeenCalled();
    } finally {
      if (priorKey === undefined) delete process.env.OPENROUTER_PLATFORM_KEY;
      else process.env.OPENROUTER_PLATFORM_KEY = priorKey;
    }
  });
});

describe("AI Trader material mutation qualification-era invalidation", () => {
  it("applies the centralized invalidation patch in the bot PATCH seam", async () => {
    vi.clearAllMocks();
    const bot = fixedBot(true);
    getBotMock.mockResolvedValue(bot);
    qualificationEraMutationPatchMock.mockReturnValue({
      graduationState: "in_trial",
      currentQualificationEraDigest: null,
      graduatedQualificationEraDigest: null,
      qualificationEraInvalidationReason: "material_bot_settings_changed",
    });
    updateBotMock.mockResolvedValue({ ...bot, model: "different/model", graduationState: "in_trial" });
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "PATCH /api/ai-trader/:id", {
      params: { id: bot.id },
      session: { walletAddress: bot.walletAddress },
      body: { model: "different/model" },
      query: {},
      headers: {},
    });

    expect(result.statusCode).toBe(200);
    expect(qualificationEraMutationPatchMock).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({ model: "different/model" }),
      "material_bot_settings_changed",
    );
    expect(updateBotMock).toHaveBeenCalledWith(bot.id, expect.objectContaining({
      model: "different/model",
      graduationState: "in_trial",
      currentQualificationEraDigest: null,
    }));
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

describe("AI Trader chart unavailable response", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getBotMock.mockResolvedValue(fixedBot(true));
    getAiTraderDecisionsMock.mockResolvedValue([{
      id: "chart-decision",
      market: "SOL-PERP",
      timeframe: "15m",
      decidedAt: new Date("2026-08-23T00:00:00.000Z"),
      closedAt: new Date("2026-08-23T01:00:00.000Z"),
    }]);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each(["trade", "deep", "tail"] as const)(
    "returns a typed 503 when %s has no admissible candles",
    async (span) => {
      fetchOHLCVMock.mockResolvedValue([]);
      const built = buildApp();
      registerAiTraderRoutes(built.app);

      const result = await invoke(built.routes, "GET /api/ai-trader/:id/chart", {
        params: { id: "paper-route" },
        session: { walletAddress: "WALLET_ROUTE" },
        body: {},
        query: { span, decisionId: "chart-decision" },
        headers: {},
      });

      expect(result).toEqual({
        statusCode: 503,
        body: {
          error: "Chart data temporarily unavailable",
          code: "chart_candles_unavailable",
          reason: "no_admissible_candles",
        },
      });
      expect(warnSpy).toHaveBeenCalledWith("[AiTrader] chart candles unavailable", {
        span,
        market: "SOL-PERP",
        timeframe: "15m",
      });
    },
  );

  it("preserves a successful direct-perpetual chart response", async () => {
    fetchOHLCVMock.mockResolvedValue([{
      time: Date.parse("2026-08-23T00:00:00.000Z"),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      provenance: {
        source: "okx",
        venue: "okx",
        basis: "perp",
        proxy: "direct",
        finality: "finalized",
        timeSemantic: "open_time",
      },
    }]);
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "GET /api/ai-trader/:id/chart", {
      params: { id: "paper-route" },
      session: { walletAddress: "WALLET_ROUTE" },
      body: {},
      query: { span: "trade", decisionId: "chart-decision" },
      headers: {},
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        candles: [expect.objectContaining({ open: 100, close: 100.5 })],
        candleBasisLabel: {
          source: "okx",
          venue: "okx",
          basis: "perp",
          proxy: "direct",
          finality: ["finalized"],
          timeSemantic: "open_time",
        },
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps unexpected fetch failures on the generic 500 path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchOHLCVMock.mockRejectedValue(new Error("venue transport failed"));
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "GET /api/ai-trader/:id/chart", {
      params: { id: "paper-route" },
      session: { walletAddress: "WALLET_ROUTE" },
      body: {},
      query: { span: "trade", decisionId: "chart-decision" },
      headers: {},
    });

    expect(result).toEqual({ statusCode: 500, body: { error: "Internal server error" } });
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

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

  it("paper manual analyze passes idle pre-claim authority with the claimed analyzing bot", async () => {
    const bot = fixedBot(true);
    getBotMock.mockResolvedValue(bot);
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
    expect(claimAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      botId: bot.id,
      expectedStatus: "idle",
    }));
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      preClaimBotStatus: "idle",
      paperPositionRows: [],
      bot: expect.objectContaining({ status: "analyzing" }),
    });
    expect(runDecisionMock).toHaveBeenCalledTimes(1);
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
      preClaimBotStatus: "idle",
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

describe("AI Trader detail request subspan attribution", () => {
  const requestFor = (walletAddress?: string) => ({
    params: { id: "scanner-bot-route" },
    query: {}, body: {}, headers: {},
    session: walletAddress ? { walletAddress } : {},
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getAiTraderDecisionsMock.mockResolvedValue([]);
    getAiTraderBotLifetimeStatsMock.mockResolvedValue(new Map([
      ["scanner-bot-route", { totalRealized: 0, totalFees: 0, totalLlmCost: 0 }],
    ]));
    parseOpenDecisionMock.mockReturnValue(null);
  });

  it("auth rejection records no bot-detail fields", async () => {
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    const trace = __createRequestTraceCollectorForTests();
    const response = await trace.run(() => invoke(built.routes, "GET /api/ai-trader/:id", requestFor()));
    expect(response.statusCode).toBe(401);
    expect(trace.snapshot()).toEqual({});
  });

  it("ownership rejection records only the owned-bot load", async () => {
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    getBotMock.mockResolvedValue({ ...scannerBot(), walletAddress: "another-wallet" });
    const trace = __createRequestTraceCollectorForTests();
    const response = await trace.run(() => invoke(built.routes, "GET /api/ai-trader/:id", requestFor("WALLET_ROUTE")));
    expect(response.statusCode).toBe(404);
    expect(Object.keys(trace.snapshot())).toEqual(["botOwnedLoadMs"]);
  });

  it("success without an open position records three non-venue fields", async () => {
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    getBotMock.mockResolvedValue(scannerBot());
    const trace = __createRequestTraceCollectorForTests();
    const response = await trace.run(() => invoke(built.routes, "GET /api/ai-trader/:id", requestFor("WALLET_ROUTE")));
    expect(response.statusCode).toBe(200);
    expect(Object.keys(trace.snapshot())).toEqual([
      "botOwnedLoadMs", "botDecisionReadMs", "botLifetimeStatsMs",
    ]);
  });

  it("success with an open position records all four fields", async () => {
    const built = buildApp();
    registerAiTraderRoutes(built.app);
    getBotMock.mockResolvedValue(scannerBot());
    parseOpenDecisionMock.mockReturnValue({ side: "long", entryPrice: "100", sizeBase: "1" });
    getAdapterMock.mockReturnValue({ getPrice: vi.fn().mockResolvedValue(101) });
    const trace = __createRequestTraceCollectorForTests();
    const response = await trace.run(() => invoke(built.routes, "GET /api/ai-trader/:id", requestFor("WALLET_ROUTE")));
    expect(response.statusCode).toBe(200);
    expect(Object.keys(trace.snapshot())).toEqual([
      "botOwnedLoadMs", "botDecisionReadMs", "botVenueMarkMs", "botLifetimeStatsMs",
    ]);
  });
});

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

function performanceBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "performance-bot",
    walletAddress: "owner-wallet",
    protocol: "pacifica",
    market: "SOL-PERP",
    timeframe: "15m",
    marketSource: "fixed",
    status: "idle",
    paperMode: true,
    currentQualificationEraDigest: "E".repeat(64),
    trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as AiTraderBot;
}

function mockPerformanceQuery(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  dbSelectMock.mockReturnValue({ from });
  return { from, leftJoin, where, orderBy };
}

describe("AI Trader overall mode-scoped performance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates, orders, rounds after exact accumulation, and exposes every exclusion class", () => {
    const projected = projectAiTraderPerformance([
      { decisionId: "b", closedAt: "2026-08-03T00:00:00.000Z", realizedPnl: "-0.225", terminalCause: "paper" },
      { decisionId: "a", closedAt: "2026-08-02T00:00:00.000Z", realizedPnl: "1.235", terminalCause: "paper" },
      { decisionId: "a", closedAt: "2026-08-02T00:00:00.000Z", realizedPnl: "1.235", terminalCause: "paper" },
      { decisionId: "no-attribution", closedAt: "2026-08-04T00:00:00.000Z", realizedPnl: "9", terminalCause: null },
      { decisionId: "other-mode", closedAt: "2026-08-05T00:00:00.000Z", realizedPnl: "8", terminalCause: "venue_detected" },
      { decisionId: "invalid", closedAt: "2026-08-06T00:00:00.000Z", realizedPnl: "NaN", terminalCause: "paper" },
      { decisionId: "conflict", closedAt: "2026-08-07T00:00:00.000Z", realizedPnl: "7", terminalCause: "paper" },
      { decisionId: "conflict", closedAt: "2026-08-07T00:00:00.000Z", realizedPnl: "7", terminalCause: "protective" },
    ], "paper_trial");

    expect(projected).toEqual({
      status: "available",
      mode: "paper_trial",
      points: [
        { t: "2026-08-02T00:00:00.000Z", v: 1.24 },
        { t: "2026-08-03T00:00:00.000Z", v: 1.01 },
      ],
      tradeCount: 2,
      netPnl: 1.01,
      omittedUnattributedTrades: 2,
      excludedOtherModeTrades: 1,
      omittedInvalidPnlTrades: 1,
    });
  });

  it("enforces wallet ownership and reads overall history without qualification-era authority", async () => {
    const built = buildApp();
    registerAiTraderRoutes(built.app as any);
    const key = "GET /api/ai-trader/:id/performance";

    getBotMock.mockResolvedValueOnce(performanceBot({ walletAddress: "another-wallet" }));
    const denied = await invoke(built.routes, key, {
      params: { id: "performance-bot" }, query: {}, body: {}, headers: {}, session: { walletAddress: "owner-wallet" },
    });
    expect(denied).toMatchObject({ statusCode: 404 });
    expect(dbSelectMock).not.toHaveBeenCalled();

    mockPerformanceQuery([
      { decisionId: "paper-before-era", closedAt: new Date("2026-07-01T00:00:00.000Z"), realizedPnl: "2.50", terminalCause: "paper" },
    ]);
    getBotMock.mockResolvedValueOnce(performanceBot({ currentQualificationEraDigest: null, trialStartedAt: null }));
    const available = await invoke(built.routes, key, {
      params: { id: "performance-bot" }, query: {}, body: {}, headers: {}, session: { walletAddress: "owner-wallet" },
    });
    expect(available).toMatchObject({
      statusCode: 200,
      body: { status: "available", mode: "paper_trial", tradeCount: 1, netPnl: 2.5 },
    });
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it("binds the direct query and returns all closed paper history without exposing era data", async () => {
    const query = mockPerformanceQuery([
      { decisionId: "paper-1", closedAt: new Date("2026-08-02T00:00:00.000Z"), realizedPnl: "2.50", terminalCause: "paper" },
      { decisionId: "live-1", closedAt: new Date("2026-08-03T00:00:00.000Z"), realizedPnl: "4.00", terminalCause: "protective" },
      { decisionId: "unattributed", closedAt: new Date("2026-08-04T00:00:00.000Z"), realizedPnl: "6.00", terminalCause: null },
    ]);
    const bot = performanceBot();
    getBotMock.mockResolvedValue(bot);
    const built = buildApp();
    registerAiTraderRoutes(built.app as any);
    const result = await invoke(built.routes, "GET /api/ai-trader/:id/performance", {
      params: { id: bot.id }, query: {}, body: {}, headers: {}, session: { walletAddress: bot.walletAddress },
    });

    expect(result).toEqual({
      statusCode: 200,
      body: {
        status: "available",
        mode: "paper_trial",
        points: [{ t: "2026-08-02T00:00:00.000Z", v: 2.5 }],
        tradeCount: 1,
        netPnl: 2.5,
        omittedUnattributedTrades: 1,
        excludedOtherModeTrades: 1,
        omittedInvalidPnlTrades: 0,
      },
    });
    expect(dbSelectMock).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: expect.anything(), closedAt: expect.anything(),
      realizedPnl: expect.anything(), terminalCause: expect.anything(),
    }));
    expect(query.from).toHaveBeenCalledTimes(1);
    expect(query.leftJoin).toHaveBeenCalledTimes(1);
    expect(query.where).toHaveBeenCalledTimes(1);
    expect(query.orderBy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.body)).not.toContain(bot.currentQualificationEraDigest);
    const source = readFileSync(resolve(process.cwd(), "server/ai-trader/routes.ts"), "utf8");
    const endpoint = source.slice(
      source.indexOf('app.get("/api/ai-trader/:id/performance"'),
      source.indexOf('app.get("/api/ai-trader/:id/history"'),
    );
    expect(endpoint).not.toContain("currentQualificationEraDigest");
    expect(endpoint).not.toContain("trialStartedAt");
    expect(endpoint).not.toContain("qualificationEraDigest");
  });

  it("keeps a promoted bot's all-time history mode-separated with exact class counts", async () => {
    mockPerformanceQuery([
      { decisionId: "paper-before-promotion", closedAt: new Date("2026-08-02T00:00:00.000Z"), realizedPnl: "3", terminalCause: "paper" },
      { decisionId: "live-after-promotion", closedAt: new Date("2026-08-03T00:00:00.000Z"), realizedPnl: "5", terminalCause: "user_requested" },
      { decisionId: "unknown-after-promotion", closedAt: new Date("2026-08-04T00:00:00.000Z"), realizedPnl: "7", terminalCause: null },
      { decisionId: "bad-live-pnl", closedAt: new Date("2026-08-05T00:00:00.000Z"), realizedPnl: null, terminalCause: "protective" },
    ]);
    const bot = performanceBot({ paperMode: false, graduationState: "graduated" });
    getBotMock.mockResolvedValue(bot);
    const built = buildApp();
    registerAiTraderRoutes(built.app as any);
    const result = await invoke(built.routes, "GET /api/ai-trader/:id/performance", {
      params: { id: bot.id }, query: {}, body: {}, headers: {}, session: { walletAddress: bot.walletAddress },
    });

    expect(result.body).toEqual({
      status: "available",
      mode: "live",
      points: [{ t: "2026-08-03T00:00:00.000Z", v: 5 }],
      tradeCount: 1,
      netPnl: 5,
      omittedUnattributedTrades: 1,
      excludedOtherModeTrades: 1,
      omittedInvalidPnlTrades: 1,
    });
  });
});

describe("AI Trader immutable qualification review route", () => {
  function request(id = "paper-route", walletAddress = "WALLET_ROUTE") {
    return {
      params: { id }, query: {}, body: {}, headers: {}, session: { walletAddress },
    };
  }

  it("returns the exact immutable record only to the owning wallet", async () => {
    vi.clearAllMocks();
    const bot = {
      ...fixedBot(true),
      graduationState: "graduated",
      graduatedQualificationEraDigest: "ERA-REVIEW",
    } as AiTraderBot;
    getBotMock.mockResolvedValue(bot);
    getQualificationRecordMock.mockResolvedValue({
      id: "record-1",
      botId: bot.id,
      qualificationEraDigest: "ERA-REVIEW",
      trialStartedAt: new Date("2026-07-01T00:00:00.000Z"),
      evaluatedAt: new Date("2026-08-01T00:00:00.000Z"),
      criteria: { periodDays: 30 },
      allocationUsdc: "1000.00",
      decisionIds: ["d-1"],
      equitySeries: [{ kind: "start", at: "2026-07-01T00:00:00.000Z", equity: 1000 }],
      equitySeriesDigest: "EQUITY-DIGEST",
      tradeCount: 1,
      netPnl: "25.000000",
      fees: { status: "complete", total: 1.25 },
      profitFactor: { kind: "positive_infinity" },
      maxDrawdownPct: "0.000000",
      openPositionMtm: "0.000000",
      leverageObservation: null,
      evidenceSourceDigest: "SOURCE-DIGEST",
      createdAt: new Date("2026-08-01T00:00:01.000Z"),
    });
    const built = buildApp();
    registerAiTraderRoutes(built.app);

    const result = await invoke(built.routes, "GET /api/ai-trader/:id/qualification-review", request());
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: "available",
      record: {
        id: "record-1",
        qualificationEraDigest: "ERA-REVIEW",
        decisionIds: ["d-1"],
        equitySeriesDigest: "EQUITY-DIGEST",
        evidenceSourceDigest: "SOURCE-DIGEST",
      },
    });
    expect(result.body.record).not.toHaveProperty("botId");
    expect(getQualificationRecordMock).toHaveBeenCalledWith(bot.id, "ERA-REVIEW");

    const denied = await invoke(built.routes, "GET /api/ai-trader/:id/qualification-review", request(bot.id, "OTHER"));
    expect(denied.statusCode).toBe(404);
  });

  it("keeps waived, pending, and legacy graduated states explicit", async () => {
    for (const candidate of [
      { bot: { ...fixedBot(true), graduationState: "waived" }, expected: { status: "waived" } },
      { bot: { ...fixedBot(true), graduationState: "in_trial" }, expected: { status: "pending", graduationState: "in_trial" } },
      { bot: { ...fixedBot(true), graduationState: "graduated", graduatedQualificationEraDigest: null }, expected: { status: "unavailable", reason: "legacy_record_missing" } },
    ]) {
      vi.clearAllMocks();
      getBotMock.mockResolvedValue(candidate.bot);
      const built = buildApp();
      registerAiTraderRoutes(built.app);
      const result = await invoke(built.routes, "GET /api/ai-trader/:id/qualification-review", request());
      expect(result.body).toEqual(candidate.expected);
      expect(getQualificationRecordMock).not.toHaveBeenCalled();
    }
  });
});
