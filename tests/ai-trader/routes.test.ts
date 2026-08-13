import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiTraderBot } from "@shared/schema";

const getBotMock = vi.fn();
const updateBotMock = vi.fn();
const getWalletLlmCiphertextMock = vi.fn();
const getWalletMock = vi.fn();
const getRecentClosedMock = vi.fn();
const getOpenDecisionsMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getAiTraderBot: (...a: unknown[]) => getBotMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
    getWalletLlmApiKeyCiphertext: (...a: unknown[]) => getWalletLlmCiphertextMock(...a),
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    getRecentClosedDecisions: (...a: unknown[]) => getRecentClosedMock(...a),
    getOpenAiTraderDecisions: (...a: unknown[]) => getOpenDecisionsMock(...a),
  },
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
vi.mock("../../server/ai-trader/scanner", () => ({
  getScannerStatus: vi.fn(),
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

  it("paper manual analyze supplies open rows separately from closed history", async () => {
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

    expect(result.statusCode).toBe(200);
    expect(getRecentClosedMock).toHaveBeenCalledWith(bot.id, 20);
    expect(getOpenDecisionsMock).toHaveBeenCalledWith(bot.id, 2);
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      recentClosedDecisions: closedRows,
      paperPositionRows: openRows,
    });
  });

  it("live manual analyze does not read or supply paper-position rows", async () => {
    const bot = fixedBot(false);
    const closedRows = [{ id: "closed-row", closedAt: new Date() }];
    getBotMock.mockResolvedValue(bot);
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

    expect(result.statusCode).toBe(200);
    expect(getOpenDecisionsMock).not.toHaveBeenCalled();
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      recentClosedDecisions: closedRows,
      paperPositionRows: [],
    });
  });
});
