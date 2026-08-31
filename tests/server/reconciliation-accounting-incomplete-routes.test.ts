import express from "express";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WALLET = "wallet-accounting-incomplete";
const TEST_BOT = "bot-accounting-incomplete";
const storageTarget = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));
const routeMocks = vi.hoisted(() => ({
  getAgentUsdcBalance: vi.fn(async () => 100),
  getAccountInfo: vi.fn(async () => ({
    balance: 125,
    equity: 125,
    availableMargin: 100,
    maintenanceMargin: 0,
    unrealizedPnl: 0,
  })),
  getPosition: vi.fn(async () => ({
    position: null,
    source: "database",
    driftDetected: false,
    staleWarning: false,
    driftDetails: null,
    healthMetrics: null,
  })),
}));

vi.mock("../../server/storage", () => {
  const storage = new Proxy(storageTarget, {
    get: (target, property: string | symbol) => {
      if (typeof property !== "string" || property === "then") return undefined;
      return (target[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId() { return "test-close-fill"; }
  }
  return { storage, DatabaseStorage };
});

vi.mock("../../server/session", () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = { walletAddress: TEST_WALLET };
    next();
  },
}));
vi.mock("../../server/db", () => ({ db: {}, isConnectionClassError: vi.fn(() => false) }));
vi.mock("../../server/analytics-indexer", () => ({
  startAnalyticsIndexer: vi.fn(), getMetrics: vi.fn(), calculateAndStoreMetrics: vi.fn(),
}));
vi.mock("../../server/session-v3", () => ({
  createSigningNonce: vi.fn(), verifySignatureAndConsumeNonce: vi.fn(), initializeWalletSecurity: vi.fn(),
  getSession: vi.fn(), getSessionByWalletAddress: vi.fn(), invalidateSession: vi.fn(), cleanupExpiredNonces: vi.fn(),
  revealMnemonic: vi.fn(), enableExecution: vi.fn(), revokeExecution: vi.fn(), emergencyStopWallet: vi.fn(),
  getUmkForWebhook: vi.fn(), healExecutionUmkFromStorage: vi.fn(), restoreWalletSecurityFromStorage: vi.fn(),
  computeBotPolicyHmac: vi.fn(), verifyBotPolicyHmac: vi.fn(), decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(), repairStaleV3AgentKeyFromLegacy: vi.fn(), generateAgentWalletWithMnemonic: vi.fn(),
  encryptAndStoreMnemonic: vi.fn(), encryptMnemonicForStorage: vi.fn(), encryptAgentKeyV3: vi.fn(),
  encryptBotSubaccountKeyV3: vi.fn(), encryptPooledSubaccountKeyV3: vi.fn(), rebindRetainedKeyToBotUuidV3: vi.fn(),
  rebindSubaccountKeyToPooledV3: vi.fn(), decryptMnemonic: vi.fn(), deriveBotKeypairFromAgentSeed: vi.fn(),
  BOT_DERIVATION_PATH_VERSION: 1,
}));
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: vi.fn(() => ({})),
  getDefaultAdapter: vi.fn(() => ({})),
  getAdapterForBot: vi.fn(() => ({ getAccountInfo: routeMocks.getAccountInfo })),
}));
vi.mock("../../server/agent-wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/agent-wallet")>();
  return { ...actual, getAgentUsdcBalance: routeMocks.getAgentUsdcBalance };
});
vi.mock("../../server/position-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/position-service")>();
  return { ...actual, PositionService: { ...actual.PositionService, getPosition: routeMocks.getPosition } };
});

import { storage } from "../../server/storage";
import { registerRoutes } from "../../server/routes";

const bot = {
  id: TEST_BOT,
  walletAddress: TEST_WALLET,
  name: "Accounting incomplete bot",
  market: "BTC-PERP",
  activeProtocol: "drift",
  isActive: true,
  driftSubaccountId: 0,
  subaccountAuthMode: null,
  subaccountStatus: null,
  protocolSubaccountId: null,
};
const wallet = {
  address: TEST_WALLET,
  walletAddress: TEST_WALLET,
  agentPublicKey: "agent-account",
  agentPrivateKeyEncryptedV3: "ciphertext",
  userWebhookSecret: null,
};
const position = {
  tradingBotId: TEST_BOT,
  walletAddress: TEST_WALLET,
  market: "BTC-PERP",
  baseSize: "0",
  avgEntryPrice: "100",
  realizedPnl: "25",
  totalFees: "1",
};
const canonicalStats = {
  totalTrades: 3,
  winningTrades: 2,
  losingTrades: 1,
  accountingIncompleteTrades: 2,
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = await registerRoutes(createServer(app), app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral test port");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(storage as any, {
    getTradingBots: vi.fn(async () => [bot]),
    getTradingBotById: vi.fn(async () => bot),
    getWallet: vi.fn(async () => wallet),
    getTradingBotListEnrichment: vi.fn(async () => ({
      tradeCounts: new Map([[TEST_BOT, 3]]),
      accountingIncompleteCounts: new Map([[TEST_BOT, 2]]),
      positions: new Map(), publishedBotMap: new Map(), equityAgg: new Map(), borrowDebts: new Map(),
    })),
    getCanonicalBotTradeStats: vi.fn(async () => canonicalStats),
    getBotEquityEvents: vi.fn(async () => []),
    getBotPosition: vi.fn(async () => position),
    getBotNetDeposited: vi.fn(async () => 0),
    getVaultPositions: vi.fn(async () => []),
    sumOpenBorrowDebtUsdcForBot: vi.fn(async () => 0),
  });
});

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("accounting-incomplete read routes", () => {
  it("returns wallet capital as labelled null with one batch enrichment read and no per-bot stats read", async () => {
    (storage.getWallet as any).mockResolvedValueOnce({ ...wallet, agentPublicKey: null });
    const response = await get("/api/wallet/capital");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      mainAccountBalance: null,
      allocatedToBot: null,
      accountingIncompleteCloseCount: 2,
      realizedAccountingStatus: "incomplete",
      capitalBalanceStatus: "unavailable",
    });
    expect(response.body).not.toHaveProperty("realizedPnl");
    expect(response.body.botAllocations[0]).toMatchObject({
      botId: TEST_BOT,
      balance: null,
      realizedPnl: null,
      accountingIncompleteCloseCount: 2,
      realizedAccountingStatus: "incomplete",
    });
    expect(storage.getTradingBotListEnrichment).toHaveBeenCalledTimes(1);
    expect(storage.getCanonicalBotTradeStats).not.toHaveBeenCalled();
  });

  it("propagates a per-bot capital read failure to the aggregate status", async () => {
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce({
      tradeCounts: new Map([[TEST_BOT, 3]]),
      accountingIncompleteCounts: new Map([[TEST_BOT, 0]]),
      positions: new Map(), publishedBotMap: new Map(), equityAgg: new Map(), borrowDebts: new Map(),
    });
    (storage.getBotEquityEvents as any).mockRejectedValueOnce(new Error("capital read unavailable"));
    const response = await get("/api/wallet/capital");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allocatedToBot: null,
      realizedAccountingStatus: "incomplete",
      capitalBalanceStatus: "unavailable",
    });
    expect(response.body).not.toHaveProperty("realizedPnl");
    expect(response.body.botAllocations[0]).toMatchObject({
      balance: null,
      realizedPnl: null,
      realizedAccountingStatus: "incomplete",
    });
  });

  it("labels live collateral realized PnL unavailable instead of fabricating a complete zero", async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce([{
      ...bot,
      subaccountAuthMode: "external_key",
      subaccountStatus: "active",
      protocolSubaccountId: "bot-subaccount",
      botSubaccountKeyEncryptedV3: "ciphertext",
    }]);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce({
      tradeCounts: new Map([[TEST_BOT, 3]]),
      accountingIncompleteCounts: new Map([[TEST_BOT, 0]]),
      positions: new Map(), publishedBotMap: new Map(), equityAgg: new Map(), borrowDebts: new Map(),
    });

    const response = await get("/api/wallet/capital");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allocatedToBot: 125,
      realizedAccountingStatus: "incomplete",
      capitalBalanceStatus: "available",
    });
    expect(response.body.botAllocations[0]).toMatchObject({
      botId: TEST_BOT,
      balance: 125,
      realizedPnl: null,
      accountingIncompleteCloseCount: 0,
      realizedAccountingStatus: "incomplete",
    });
  });

  it("returns /api/bots/:botId/balance as labelled null instead of 409", async () => {
    const response = await get(`/api/bots/${TEST_BOT}/balance`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      balance: null, usdcBalance: null, totalCollateral: null, freeCollateral: null,
      realizedPnl: null, accountingIncompleteCloseCount: 2, realizedAccountingStatus: "incomplete",
    });
  });

  it("returns /api/bots/:botId/overview as labelled null instead of 409", async () => {
    const response = await get(`/api/bots/${TEST_BOT}/overview`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      usdcBalance: null, totalCollateral: null, freeCollateral: null,
      realizedPnl: null, accountingIncompleteCloseCount: 2, realizedAccountingStatus: "incomplete",
    });
  });

  it("returns legacy /api/bot/:botId/balance as labelled null instead of 409", async () => {
    const response = await get(`/api/bot/${TEST_BOT}/balance`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      usdcBalance: null, realizedPnl: null,
      accountingIncompleteCloseCount: 2, realizedAccountingStatus: "incomplete",
    });
  });
});
