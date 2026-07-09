// WO-7.1 acceptance: route-level tests for POST /api/ai-trader/:id/go-live (the
// live funding accept path that replaced the 501) and POST /api/admin/ai-trader/waive.
//
// Pattern: registerAiTraderRoutes() is called against a FAKE express app that just
// records (path → [middlewares..., handler]); tests invoke the chain with stub
// req/res. Storage, session-v3 crypto, the adapter registry, db, and the two
// money-moving helpers from server/routes (provision + sweep) are all mocked —
// no network, no DB, no real keys.
//
// Money-safety invariants locked here:
//   - the bot NEVER flips live unless funding is VERIFIED (provisionMeta.funded /
//     venue equity read),
//   - the V3 key is persisted (paperMode still true) BEFORE any flip,
//   - a key-persist failure sweeps the funded subaccount back with the in-memory
//     key and never deletes/flips the bot,
//   - the in-memory sub key is zeroized on every path,
//   - the retry path (subId + key already persisted) never re-provisions and
//     never double-funds a funded subaccount,
//   - UMK/agent-key handles are cleaned up on every exit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiTraderBot } from "@shared/schema";

// --- Mocks (must be declared before importing the module under test) -------------------

const getAiTraderBotMock = vi.fn();
const getWalletMock = vi.fn();
const updateBotMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    getAiTraderBot: (...a: unknown[]) => getAiTraderBotMock(...a),
    getWallet: (...a: unknown[]) => getWalletMock(...a),
    updateAiTraderBot: (...a: unknown[]) => updateBotMock(...a),
  },
}));

const getUmkMock = vi.fn();
const healUmkMock = vi.fn();
const decryptKeyMock = vi.fn();
const decryptMnemonicMock = vi.fn();
const encryptSubKeyMock = vi.fn();
const getSessionByWalletMock = vi.fn();
vi.mock("../../server/session-v3", () => ({
  getSessionByWalletAddress: (...a: unknown[]) => getSessionByWalletMock(...a),
  restoreWalletSecurityFromStorage: vi.fn(),
  decryptLlmApiKeyV3: vi.fn(),
  computeBotPolicyHmac: vi.fn(() => "hmac"),
  getUmkForWebhook: (...a: unknown[]) => getUmkMock(...a),
  healExecutionUmkFromStorage: (...a: unknown[]) => healUmkMock(...a),
  decryptAgentKeyStrict: (...a: unknown[]) => decryptKeyMock(...a),
  decryptMnemonic: (...a: unknown[]) => decryptMnemonicMock(...a),
  encryptBotSubaccountKeyV3: (...a: unknown[]) => encryptSubKeyMock(...a),
}));

vi.mock("../../server/agent-wallet", () => ({
  resolveAgentKeypair: vi.fn((secret: Uint8Array) => ({
    publicKey: { toString: () => "AGENT_PUB" },
    secretKey: secret.length === 64 ? secret : new Uint8Array(64).fill(9),
  })),
}));

const getAdapterMock = vi.fn();
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...a),
  getDefaultAdapter: vi.fn(() => ({ protocolName: "pacifica" })),
}));

const dbExecuteMock = vi.fn();
vi.mock("../../server/db", () => ({
  db: { execute: (...a: unknown[]) => dbExecuteMock(...a) },
}));

const provisionMock = vi.fn();
const sweepMock = vi.fn();
// The handler does `await import("../routes")` — vitest routes that here too.
vi.mock("../../server/routes", () => ({
  provisionExternalKeyBotSubaccount: (...a: unknown[]) => provisionMock(...a),
  sweepProvisionedExternalKeyFunds: (...a: unknown[]) => sweepMock(...a),
}));

// Lightweight stubs for the heavy transitive imports of routes.ts we never exercise.
vi.mock("../../server/market-registry", () => ({ getMarketInfo: vi.fn() }));
vi.mock("../../server/ai-assistant/models-catalog", () => ({ isSelectableModel: vi.fn(() => true) }));
vi.mock("../../server/ai-trader/context-builder", () => ({ buildMarketContext: vi.fn() }));
vi.mock("../../server/ai-trader/decide", () => ({ runDecision: vi.fn() }));
vi.mock("../../server/ai-trader/executor", () => ({
  executeDecision: vi.fn(),
  aiTraderPolicyObject: vi.fn((b: AiTraderBot) => ({ market: b.market, leverage: b.maxLeverage, maxPositionSize: b.allocatedUsdc })),
}));
vi.mock("../../server/ai-trader/monitor", () => ({
  userInitiatedClose: vi.fn(),
  parseOpenDecision: vi.fn(),
}));

import { registerAiTraderRoutes } from "../../server/ai-trader/routes";

// --- Fake express harness ---------------------------------------------------------------

type Handler = (req: any, res: any, next?: any) => unknown;

function buildApp(): { routes: Map<string, Handler[]>; app: any } {
  const routes = new Map<string, Handler[]>();
  const record = (method: string) => (path: string, ...handlers: Handler[]) => {
    routes.set(`${method} ${path}`, handlers);
  };
  const app = { get: record("GET"), post: record("POST"), delete: record("DELETE"), put: record("PUT"), patch: record("PATCH") };
  return { routes, app };
}

interface FakeRes {
  statusCode: number;
  body: any;
  finished: Promise<{ statusCode: number; body: any }>;
}

function makeRes(): FakeRes & { status: (c: number) => any; json: (b: any) => void } {
  let resolve!: (v: { statusCode: number; body: any }) => void;
  const finished = new Promise<{ statusCode: number; body: any }>((r) => { resolve = r; });
  const res: any = {
    statusCode: 200,
    body: undefined,
    finished,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; resolve({ statusCode: res.statusCode, body }); },
  };
  return res;
}

async function invoke(routes: Map<string, Handler[]>, key: string, req: any): Promise<{ statusCode: number; body: any }> {
  const chain = routes.get(key);
  if (!chain) throw new Error(`Route not registered: ${key}`);
  const res = makeRes();
  let i = 0;
  const next = () => { i++; };
  for (; i < chain.length; ) {
    const idx = i;
    await chain[idx](req, res, next);
    if (i === idx) break; // middleware did not call next() → response sent (or handler done)
  }
  return Promise.race([
    res.finished,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("route never responded")), 2000)),
  ]);
}

// --- Fixtures -----------------------------------------------------------------------------

const WALLET = "WALLET_OWNER_XYZ";

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "ai-bot-1",
    walletAddress: WALLET,
    protocol: "pacifica",
    protocolSubaccountId: null,
    botSubaccountKeyEncryptedV3: null,
    derivationIndex: null,
    derivationPathVersion: null,
    market: "SOL-PERP",
    timeframe: "1h",
    mode: "suggest",
    paperMode: true,
    allocatedUsdc: "100",
    maxLeverage: 3,
    graduationState: "graduated",
    status: "idle",
    policyHmac: "hmac",
    ...overrides,
  } as unknown as AiTraderBot;
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    protocolName: "pacifica",
    minTransferAmount: 10,
    subaccountCaps: { maxPerAgent: 10 },
    getCapabilities: () => ({ requiresExternalSubaccountKey: true, walletDerivation: "agent_hd" }),
    getAccountInfo: vi.fn(),
    transferBetweenSubaccounts: vi.fn(),
    ...overrides,
  };
}

function goLiveReq(botId = "ai-bot-1") {
  return { params: { id: botId }, session: { walletAddress: WALLET }, body: {}, query: {}, headers: {} };
}

const GO_LIVE = "POST /api/ai-trader/:id/go-live";
const WAIVE = "POST /api/admin/ai-trader/waive";

let routes: Map<string, Handler[]>;

function freshApp() {
  const built = buildApp();
  registerAiTraderRoutes(built.app);
  routes = built.routes;
}

function armHappyCrypto() {
  const umkCleanup = vi.fn();
  const keyCleanup = vi.fn();
  healUmkMock.mockResolvedValue(undefined);
  getUmkMock.mockResolvedValue({ umk: Buffer.from("umk-bytes"), cleanup: umkCleanup });
  decryptKeyMock.mockResolvedValue({ secretKey: new Uint8Array(64).fill(1), cleanup: keyCleanup });
  decryptMnemonicMock.mockResolvedValue(Buffer.from("test mnemonic words"));
  encryptSubKeyMock.mockReturnValue("V3_CIPHERTEXT");
  getWalletMock.mockResolvedValue({ address: WALLET, agentPublicKey: "AGENT_PUB", agentPrivateKeyEncryptedV3: "enc" });
  dbExecuteMock.mockResolvedValue({ rows: [{ used: 3 }] });
  return { umkCleanup, keyCleanup };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_PASSWORD = "test-admin-pw";
  freshApp();
});

// === Gates (reject path) ====================================================================

describe("go-live gates", () => {
  it("409 when the bot is already live", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ paperMode: false }));
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(409);
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("403 while still in trial (canGoLive gate)", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ graduationState: "in_trial" }));
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toMatch(/still in progress/i);
  });

  it("403 when the trial failed", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ graduationState: "failed" }));
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toMatch(/failed/i);
  });

  it("404 for a bot owned by someone else", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ walletAddress: "OTHER" }));
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(404);
  });

  it("409 while a paper position is open or a cycle is in flight", async () => {
    for (const status of ["open", "executing", "analyzing", "proposed"]) {
      getAiTraderBotMock.mockResolvedValue(makeBot({ status }));
      const r = await invoke(routes, GO_LIVE, goLiveReq());
      expect(r.statusCode).toBe(409);
    }
  });

  it("501 for a non-Pacifica bot", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ protocol: "flash" }));
    getAdapterMock.mockReturnValue(makeAdapter({ protocolName: "flash" }));
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(501);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("400 when allocatedUsdc is below the venue min transfer", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ allocatedUsdc: "5" }));
    getAdapterMock.mockReturnValue(makeAdapter());
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/minimum/i);
  });

  it("400 when no UMK is available (stays paper, agent key never decrypted)", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    getWalletMock.mockResolvedValue({ address: WALLET, agentPublicKey: "AGENT_PUB", agentPrivateKeyEncryptedV3: "enc" });
    healUmkMock.mockResolvedValue(undefined);
    getUmkMock.mockResolvedValue(null);
    getSessionByWalletMock.mockReturnValue(null);
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(400);
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("409 when the venue subaccount cap is reached — provisioning never starts", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    dbExecuteMock.mockResolvedValue({ rows: [{ used: 10 }] });
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatch(/limit/i);
    expect(provisionMock).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("500 (fail closed) when the cap count is unreadable", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    dbExecuteMock.mockResolvedValue({ rows: [] });
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(500);
    expect(provisionMock).not.toHaveBeenCalled();
  });
});

// === Fresh accept path ======================================================================

describe("go-live fresh accept path", () => {
  function armProvisionSuccess() {
    const pendingKey = new Uint8Array(64).fill(7);
    provisionMock.mockResolvedValue({
      botSubaccountPublicKey: "SUB_PUB",
      pendingBotSecretKeyForV3: pendingKey,
      subaccountAuthMode: "external_key",
      subaccountStatus: "pending",
      derivationIndex: 4,
      derivationPathVersion: 1,
      ambiguous: false,
      provisionMeta: { funded: true, fundedAmount: 100, wasNewAccount: false, depositTxSignature: "tx1" },
    });
    return pendingKey;
  }

  it("provisions, persists the key (paper still true), THEN flips live — in that order", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    const { umkCleanup, keyCleanup } = armHappyCrypto();
    const pendingKey = armProvisionSuccess();
    updateBotMock.mockImplementation(async (_id: string, updates: any) => ({ ...makeBot(), ...updates }));

    const r = await invoke(routes, GO_LIVE, goLiveReq());

    expect(r.statusCode).toBe(200);
    expect(r.body.live).toBe(true);
    expect(r.body.bot.paperMode).toBe(false);
    expect(r.body.bot.policyHmac).toBeUndefined(); // DTO strips it

    // Provision received the wallet's mnemonic + right funding amount.
    expect(provisionMock).toHaveBeenCalledOnce();
    expect(provisionMock.mock.calls[0][0]).toMatchObject({ walletAddress: WALLET, fundingAmount: 100 });

    // Key encrypted under the UMK, AAD-bound to wallet + bot id.
    expect(encryptSubKeyMock).toHaveBeenCalledOnce();
    const [umkArg, keyBufArg, walletArg, botIdArg] = encryptSubKeyMock.mock.calls[0];
    expect(Buffer.isBuffer(umkArg)).toBe(true);
    expect(Buffer.isBuffer(keyBufArg)).toBe(true);
    expect(walletArg).toBe(WALLET);
    expect(botIdArg).toBe("ai-bot-1");

    // Two writes, in order: (1) key persist with paperMode untouched, (2) the flip.
    expect(updateBotMock).toHaveBeenCalledTimes(2);
    const [persistCall, flipCall] = updateBotMock.mock.calls;
    expect(persistCall[1]).toMatchObject({
      protocolSubaccountId: "SUB_PUB",
      botSubaccountKeyEncryptedV3: "V3_CIPHERTEXT",
      derivationIndex: 4,
      derivationPathVersion: 1,
    });
    expect(persistCall[1].paperMode).toBeUndefined();
    expect(flipCall[1]).toMatchObject({ paperMode: false, status: "idle", pauseReason: null });

    // In-memory sub key zeroized; crypto handles cleaned up; no sweep needed.
    expect(Array.from(pendingKey).every((b) => b === 0)).toBe(true);
    expect(umkCleanup).toHaveBeenCalled();
    expect(keyCleanup).toHaveBeenCalled();
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("stays paper (502) when provisioning succeeded but funding did NOT — key still persisted for retry", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    const pendingKey = new Uint8Array(64).fill(7);
    provisionMock.mockResolvedValue({
      botSubaccountPublicKey: "SUB_PUB",
      pendingBotSecretKeyForV3: pendingKey,
      subaccountAuthMode: "external_key",
      subaccountStatus: "pending",
      derivationIndex: 4,
      derivationPathVersion: 1,
      ambiguous: false,
      provisionMeta: { funded: false, fundedAmount: 0, warning: "transfer failed" },
    });
    updateBotMock.mockImplementation(async (_id: string, updates: any) => ({ ...makeBot(), ...updates }));

    const r = await invoke(routes, GO_LIVE, goLiveReq());

    expect(r.statusCode).toBe(502);
    // Key persisted (retry path can pick it up) but NO flip write.
    expect(updateBotMock).toHaveBeenCalledTimes(1);
    expect(updateBotMock.mock.calls[0][1].paperMode).toBeUndefined();
    expect(updateBotMock.mock.calls[0][1].botSubaccountKeyEncryptedV3).toBe("V3_CIPHERTEXT");
    expect(Array.from(pendingKey).every((b) => b === 0)).toBe(true);
  });

  it("500 + fail-closed sweep when the key persist fails — never flips, never deletes", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    const pendingKey = armProvisionSuccess();
    updateBotMock.mockRejectedValueOnce(new Error("db write lost"));
    let sweptKeyCopy: Uint8Array | null = null;
    sweepMock.mockImplementation(async (params: any) => {
      sweptKeyCopy = Uint8Array.from(params.subSecretKey); // capture BEFORE zeroize
      return { swept: true, detail: "drained" };
    });

    const r = await invoke(routes, GO_LIVE, goLiveReq());

    expect(r.statusCode).toBe(500);
    expect(r.body.error).toMatch(/returned to your trading account/i);
    // Sweep got the LIVE in-memory key (not yet zeroized) + right subaccount.
    expect(sweepMock).toHaveBeenCalledOnce();
    expect(sweepMock.mock.calls[0][0]).toMatchObject({ subaccountPublicKey: "SUB_PUB", agentPublicKey: "AGENT_PUB" });
    expect(sweptKeyCopy && Array.from(sweptKeyCopy).every((b) => b === 7)).toBe(true);
    // Zeroized afterwards; only the failed persist write — never a flip.
    expect(Array.from(pendingKey).every((b) => b === 0)).toBe(true);
    expect(updateBotMock).toHaveBeenCalledTimes(1);
  });

  it("500 + honest warning when the rollback sweep cannot verify empty", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    armProvisionSuccess();
    updateBotMock.mockRejectedValueOnce(new Error("db write lost"));
    sweepMock.mockResolvedValue({ swept: false, detail: "residual unverified" });

    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(500);
    expect(r.body.error).toMatch(/recoverable/i);
    expect(updateBotMock).toHaveBeenCalledTimes(1);
  });

  it("500 stays paper when provisioning throws atomically (nothing stranded, no writes)", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    provisionMock.mockRejectedValue(new Error("Pacifica provision failed"));

    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(500);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("400 when the wallet has no recovery phrase (agent_hd requires it)", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot());
    getAdapterMock.mockReturnValue(makeAdapter());
    armHappyCrypto();
    decryptMnemonicMock.mockResolvedValue(null);
    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/recovery phrase/i);
    expect(provisionMock).not.toHaveBeenCalled();
  });
});

// === Idempotent retry path ==================================================================

describe("go-live idempotent retry (subaccount + key already persisted)", () => {
  const provisionedBot = () =>
    makeBot({ protocolSubaccountId: "SUB_PUB", botSubaccountKeyEncryptedV3: "V3_CIPHERTEXT" });

  it("already funded → flips live without provisioning or transferring", async () => {
    getAiTraderBotMock.mockResolvedValue(provisionedBot());
    const adapter = makeAdapter();
    (adapter.getAccountInfo as any).mockResolvedValue({ equity: 100, balance: 100 });
    getAdapterMock.mockReturnValue(adapter);
    armHappyCrypto();
    updateBotMock.mockImplementation(async (_id: string, updates: any) => ({ ...provisionedBot(), ...updates }));

    const r = await invoke(routes, GO_LIVE, goLiveReq());

    expect(r.statusCode).toBe(200);
    expect(r.body.live).toBe(true);
    expect(provisionMock).not.toHaveBeenCalled();
    expect(decryptMnemonicMock).not.toHaveBeenCalled();
    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(updateBotMock).toHaveBeenCalledTimes(1); // just the flip
    expect(updateBotMock.mock.calls[0][1]).toMatchObject({ paperMode: false, status: "idle" });
  });

  it("unfunded → completes the funding transfer, verifies it landed, then flips", async () => {
    getAiTraderBotMock.mockResolvedValue(provisionedBot());
    const adapter = makeAdapter();
    (adapter.getAccountInfo as any)
      .mockResolvedValueOnce({ equity: 0, balance: 0 })   // pre-check
      .mockResolvedValueOnce({ equity: 100, balance: 100 }); // post-transfer verify
    (adapter.transferBetweenSubaccounts as any).mockResolvedValue({ success: true });
    getAdapterMock.mockReturnValue(adapter);
    armHappyCrypto();
    updateBotMock.mockImplementation(async (_id: string, updates: any) => ({ ...provisionedBot(), ...updates }));

    const r = await invoke(routes, GO_LIVE, goLiveReq());

    expect(r.statusCode).toBe(200);
    expect(adapter.transferBetweenSubaccounts).toHaveBeenCalledOnce();
    expect((adapter.transferBetweenSubaccounts as any).mock.calls[0][0]).toMatchObject({
      fromSubaccountId: "AGENT_PUB",
      toSubaccountId: "SUB_PUB",
      amount: 100,
    });
    expect(updateBotMock.mock.calls.at(-1)![1]).toMatchObject({ paperMode: false });
  });

  it("stays paper (502) when the retry transfer fails", async () => {
    getAiTraderBotMock.mockResolvedValue(provisionedBot());
    const adapter = makeAdapter();
    (adapter.getAccountInfo as any).mockResolvedValue({ equity: 0, balance: 0 });
    (adapter.transferBetweenSubaccounts as any).mockResolvedValue({ success: false, error: "rate limited" });
    getAdapterMock.mockReturnValue(adapter);
    armHappyCrypto();

    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(502);
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("stays paper (502) when the post-transfer verify cannot confirm the balance", async () => {
    getAiTraderBotMock.mockResolvedValue(provisionedBot());
    const adapter = makeAdapter();
    (adapter.getAccountInfo as any)
      .mockResolvedValueOnce({ equity: 0, balance: 0 })
      .mockResolvedValueOnce({ equity: 0, balance: 0 }); // transfer "succeeded" but nothing landed
    (adapter.transferBetweenSubaccounts as any).mockResolvedValue({ success: true });
    getAdapterMock.mockReturnValue(adapter);
    armHappyCrypto();

    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(502);
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("500 stays paper (fail closed) when the venue balance read throws — no double funding", async () => {
    getAiTraderBotMock.mockResolvedValue(provisionedBot());
    const adapter = makeAdapter();
    (adapter.getAccountInfo as any).mockRejectedValue(new Error("venue 500"));
    getAdapterMock.mockReturnValue(adapter);
    armHappyCrypto();

    const r = await invoke(routes, GO_LIVE, goLiveReq());
    expect(r.statusCode).toBe(500);
    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(updateBotMock).not.toHaveBeenCalled();
  });
});

// === Admin waive ============================================================================

describe("POST /api/admin/ai-trader/waive", () => {
  const auth = (token: string) => ({ params: {}, body: { botId: "ai-bot-1" }, query: {}, headers: { authorization: `Bearer ${token}` } });

  it("503 when ADMIN_PASSWORD is not configured (never falls open)", async () => {
    delete process.env.ADMIN_PASSWORD;
    freshApp(); // re-register so the closure captures the unset env
    const r = await invoke(routes, WAIVE, auth("anything"));
    expect(r.statusCode).toBe(503);
  });

  it("401 on a wrong token", async () => {
    const r = await invoke(routes, WAIVE, auth("wrong-pw"));
    expect(r.statusCode).toBe(401);
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("400 without a botId", async () => {
    const req = auth("test-admin-pw");
    req.body = {};
    const r = await invoke(routes, WAIVE, req);
    expect(r.statusCode).toBe(400);
  });

  it("404 for an unknown bot", async () => {
    getAiTraderBotMock.mockResolvedValue(undefined);
    const r = await invoke(routes, WAIVE, auth("test-admin-pw"));
    expect(r.statusCode).toBe(404);
  });

  it("409 when the bot is already graduated or waived", async () => {
    for (const graduationState of ["graduated", "waived"]) {
      getAiTraderBotMock.mockResolvedValue(makeBot({ graduationState }));
      const r = await invoke(routes, WAIVE, auth("test-admin-pw"));
      expect(r.statusCode).toBe(409);
    }
    expect(updateBotMock).not.toHaveBeenCalled();
  });

  it("waives an in_trial bot — eligibility only, paperMode untouched", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ graduationState: "in_trial" }));
    updateBotMock.mockImplementation(async (_id: string, updates: any) => ({ ...makeBot(), ...updates }));
    const r = await invoke(routes, WAIVE, auth("test-admin-pw"));
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.bot.graduationState).toBe("waived");
    expect(r.body.bot.paperMode).toBe(true);
    expect(updateBotMock).toHaveBeenCalledWith("ai-bot-1", { graduationState: "waived" });
  });

  it("waives a failed bot too (founder override)", async () => {
    getAiTraderBotMock.mockResolvedValue(makeBot({ graduationState: "failed" }));
    updateBotMock.mockImplementation(async (_id: string, updates: any) => ({ ...makeBot(), ...updates }));
    const r = await invoke(routes, WAIVE, auth("test-admin-pw"));
    expect(r.statusCode).toBe(200);
    expect(r.body.bot.graduationState).toBe("waived");
  });
});
