import express from 'express';
import { createServer, type Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => {
  const defaultAdapter = {
    protocolName: 'pacifica',
    minTransferAmount: 1,
    getMarkets: vi.fn(),
    getAccountInfo: vi.fn(),
    transferBetweenSubaccounts: vi.fn(),
    getFeeRateQuote: vi.fn(),
    placeMarketOrder: vi.fn(),
  };
  return {
    defaultAdapter,
    selectedAdapter: defaultAdapter as any,
    getUmkForWebhook: vi.fn(),
    decryptAgentKeyStrict: vi.fn(),
  };
});

const TEST_WALLET = 'wallet-leverage-source-test';

vi.mock('../../server/storage', () => {
  const target: Record<string, any> = {};
  const storage = new Proxy(target, {
    get: (object, property: string | symbol) => {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (object[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId() { return 'test-close-fill'; }
  }
  return { storage, DatabaseStorage };
});

vi.mock('../../server/session', () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = { walletAddress: TEST_WALLET };
    next();
  },
}));

vi.mock('../../server/db', () => ({
  db: {},
  isConnectionClassError: vi.fn(() => false),
}));

vi.mock('../../server/analytics-indexer', () => ({
  startAnalyticsIndexer: vi.fn(),
  getMetrics: vi.fn(),
  calculateAndStoreMetrics: vi.fn(),
}));

vi.mock('../../server/session-v3', () => ({
  createSigningNonce: vi.fn(),
  verifySignatureAndConsumeNonce: vi.fn(),
  initializeWalletSecurity: vi.fn(),
  getSession: vi.fn(),
  getSessionByWalletAddress: vi.fn(),
  invalidateSession: vi.fn(),
  cleanupExpiredNonces: vi.fn(),
  revealMnemonic: vi.fn(),
  enableExecution: vi.fn(),
  revokeExecution: vi.fn(),
  emergencyStopWallet: vi.fn(),
  getUmkForWebhook: routeMocks.getUmkForWebhook,
  healExecutionUmkFromStorage: vi.fn(),
  restoreWalletSecurityFromStorage: vi.fn(),
  computeBotPolicyHmac: vi.fn(),
  verifyBotPolicyHmac: vi.fn(),
  decryptAgentKeyStrict: routeMocks.decryptAgentKeyStrict,
  decryptBotSubaccountKey: vi.fn(),
  repairStaleV3AgentKeyFromLegacy: vi.fn(),
  generateAgentWalletWithMnemonic: vi.fn(),
  encryptAndStoreMnemonic: vi.fn(),
  encryptMnemonicForStorage: vi.fn(),
  encryptAgentKeyV3: vi.fn(),
  encryptBotSubaccountKeyV3: vi.fn(),
  encryptPooledSubaccountKeyV3: vi.fn(),
  rebindRetainedKeyToBotUuidV3: vi.fn(),
  rebindSubaccountKeyToPooledV3: vi.fn(),
  decryptMnemonic: vi.fn(),
  deriveBotKeypairFromAgentSeed: vi.fn(),
  BOT_DERIVATION_PATH_VERSION: 1,
}));

vi.mock('../../server/protocol/adapter-registry', () => ({
  getAdapter: vi.fn(() => routeMocks.selectedAdapter),
  getDefaultAdapter: vi.fn(() => routeMocks.defaultAdapter),
  getAdapterForBot: vi.fn(() => routeMocks.selectedAdapter),
}));

import { storage } from '../../server/storage';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import { updateMarketCache, getMarketInfo } from '../../server/market-registry';
import {
  getAllCachedLeverageLimits,
  getAllCachedLeverageSources,
  getCachedMaxLeverageWithSource,
  refreshLeverageCache,
} from '../../server/leverage-cache-service';
import {
  getAllPerpMarkets,
  getMarketMaxLeverageWithSource,
} from '../../server/market-liquidity-service';
import {
  computeRetryEffectiveLeverage,
  computeTradeSizingAndTopUp,
  registerRoutes,
} from '../../server/routes';

function market(source: 'venue' | 'fallback' | undefined, maxLeverage = 5): ProtocolMarket {
  return {
    internalSymbol: 'BTC-PERP',
    protocolSymbol: 'BTC',
    maxLeverage,
    ...(source === undefined ? {} : { maxLeverageSource: source }),
    minOrderSizeUsd: 10,
    minOrderSizeBase: 0.001,
    tickSize: 0.1,
    lotSize: 0.001,
    isActive: true,
    category: ['crypto'],
    fullName: 'Bitcoin',
    maintenanceMarginWeight: 0.2,
    riskTier: 'recommended',
    estimatedSlippagePct: 0.1,
  };
}

const keypair = Keypair.generate();
const bot = {
  id: 'bot-leverage-source-test',
  walletAddress: TEST_WALLET,
  name: 'Leverage source test bot',
  market: 'BTC-PERP',
  activeProtocol: 'pacifica',
  isActive: true,
  leverage: 10,
  maxPositionSize: '100',
  autoTopUp: true,
  driftSubaccountId: 0,
  subaccountAuthMode: null,
  subaccountStatus: null,
  protocolSubaccountId: null,
};
const wallet = {
  walletAddress: TEST_WALLET,
  address: TEST_WALLET,
  agentPublicKey: keypair.publicKey.toBase58(),
  agentPrivateKeyEncryptedV3: 'test-ciphertext',
  executionEnabled: true,
  emergencyStopTriggered: false,
  slippageBps: 50,
};

let server: Server;
let baseUrl: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/prices')) {
      return new Response(JSON.stringify({ 'BTC-PERP': 60_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  server = await registerRoutes(createServer(app), app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no ephemeral test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (!server) return;
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

beforeEach(() => {
  routeMocks.selectedAdapter = routeMocks.defaultAdapter;
  for (const value of Object.values(routeMocks.defaultAdapter)) {
    if (typeof value === 'function' && 'mockClear' in value) (value as any).mockClear();
  }
});

describe('market leverage source propagation', () => {
  it('propagates venue and fallback source through registry, cache, and liquidity views', async () => {
    updateMarketCache([market('venue', 7)]);
    expect(getMarketInfo('BTC-PERP')).toMatchObject({ maxLeverage: 7, maxLeverageSource: 'venue' });
    // Cold leverage cache + registry hit preserves authoritative provenance.
    expect(getCachedMaxLeverageWithSource('BTC-PERP')).toEqual({ maxLeverage: 7, maxLeverageSource: 'venue' });

    await refreshLeverageCache();
    expect(getAllCachedLeverageLimits()).toMatchObject({ 'BTC-PERP': 7 });
    expect(getAllCachedLeverageSources()).toMatchObject({ 'BTC-PERP': 'venue' });
    expect(getMarketMaxLeverageWithSource('BTC-PERP')).toEqual({ maxLeverage: 7, maxLeverageSource: 'venue' });
    // Warm leverage cache + symbol miss retains the numeric compatibility value,
    // explicitly marked as fallback rather than venue authority.
    expect(getCachedMaxLeverageWithSource('UNKNOWN-PERP')).toEqual({ maxLeverage: 5, maxLeverageSource: 'fallback' });

    const [listed] = await getAllPerpMarkets(true);
    expect(listed).toMatchObject({ symbol: 'BTC-PERP', maxLeverage: 7, maxLeverageSource: 'venue' });
  });

  it('normalizes missing provenance to fallback', async () => {
    updateMarketCache([market(undefined, 9)]);
    expect(getMarketInfo('BTC-PERP')).toMatchObject({ maxLeverage: 9, maxLeverageSource: 'fallback' });
    await refreshLeverageCache();
    expect(getCachedMaxLeverageWithSource('BTC-PERP')).toEqual({ maxLeverage: 9, maxLeverageSource: 'fallback' });
  });

  it('preserves fallback registry provenance and the compatibility value on cold-cache reads', async () => {
    // Reset the module graph only for these dynamic imports so this test owns a
    // genuinely cold leverage cache without adding a production reset hook.
    vi.resetModules();
    const coldRegistry = await import('../../server/market-registry');
    const coldCache = await import('../../server/leverage-cache-service');
    coldRegistry.updateMarketCache([market('fallback', 9)]);

    expect(coldCache.getCachedMaxLeverageWithSource('BTC-PERP')).toEqual({
      maxLeverage: 9,
      maxLeverageSource: 'fallback',
    });
    expect(coldCache.getCachedMaxLeverageWithSource('UNKNOWN-PERP')).toEqual({
      maxLeverage: 5,
      maxLeverageSource: 'fallback',
    });
  });

  it('keeps numeric leverage limits stable and adds API-only source labels', async () => {
    updateMarketCache([market('fallback', 1)]);
    await refreshLeverageCache();
    const response = await originalFetch(`${baseUrl}/api/exchange/leverage-limits`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      leverageLimits: { 'BTC-PERP': 1 },
      leverageLimitSources: { 'BTC-PERP': 'fallback' },
      source: 'adapter',
      marketCount: 1,
    });
  });

  it('keeps warm-cache venue provenance faithful', async () => {
    updateMarketCache([market('venue', 6)]);
    await refreshLeverageCache();
    expect(getCachedMaxLeverageWithSource('BTC-PERP')).toEqual({ maxLeverage: 6, maxLeverageSource: 'venue' });
  });
});

describe('market leverage source money-consumer authority', () => {
  const sizingInput = () => ({
    agentPublicKey: wallet.agentPublicKey,
    agentPrivateKeyEncrypted: keypair.secretKey,
    subAccountId: 0,
    botId: bot.id,
    walletAddress: TEST_WALLET,
    market: 'BTC-PERP',
    baseCapital: 0,
    leverage: 10,
    autoTopUp: false,
    profitReinvestEnabled: false,
    signalPercent: 100,
    oraclePrice: 60_000,
    logPrefix: '[LeverageSourceTest]',
    adapter: routeMocks.selectedAdapter,
  });

  it('refuses sizing before collateral movement when leverage provenance is unavailable', async () => {
    updateMarketCache([market('fallback', 1)]);
    await refreshLeverageCache();
    const result = await computeTradeSizingAndTopUp(sizingInput() as any);
    expect(result).toEqual({
      success: false,
      tradeAmountUsd: 0,
      finalContractSize: 0,
      freeCollateral: 0,
      maxTradeableValue: 0,
      effectiveLeverage: 0,
      error: 'signal_bot_market_leverage_cap_unavailable: venue-published leverage cap is unavailable or invalid for BTC-PERP',
      shouldPauseBot: false,
    });
    expect(routeMocks.defaultAdapter.getAccountInfo).not.toHaveBeenCalled();
    expect(routeMocks.defaultAdapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(routeMocks.defaultAdapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('does not pause the bot for recoverable leverage-metadata unavailability', async () => {
    updateMarketCache([market(undefined, 1)]);
    await refreshLeverageCache();
    const result = await computeTradeSizingAndTopUp(sizingInput() as any);
    expect(result.shouldPauseBot).toBe(false);
    expect(result.pauseReason).toBeUndefined();
  });

  it('refuses failed-entry retry before top-up or order placement when leverage provenance is unavailable', async () => {
    updateMarketCache([market('fallback', 1)]);
    await refreshLeverageCache();
    vi.mocked(storage.getBotTrade as any).mockResolvedValue({
      id: 'failed-trade',
      tradingBotId: bot.id,
      walletAddress: TEST_WALLET,
      status: 'failed',
      side: 'LONG',
      market: 'BTC-PERP',
      size: '0.01',
      executedAt: new Date(),
    });
    vi.mocked(storage.getTradingBots as any).mockResolvedValue([bot]);
    vi.mocked(storage.getWallet as any).mockResolvedValue(wallet);
    routeMocks.getUmkForWebhook.mockResolvedValue({ umk: new Uint8Array(32), cleanup: vi.fn() });
    routeMocks.decryptAgentKeyStrict.mockResolvedValue({ secretKey: keypair.secretKey, cleanup: vi.fn() });

    const response = await originalFetch(`${baseUrl}/api/trades/failed-trade/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wallet-address': TEST_WALLET },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'signal_bot_market_leverage_cap_unavailable: venue-published leverage cap is unavailable or invalid for BTC-PERP',
    });
    expect(routeMocks.defaultAdapter.getAccountInfo).not.toHaveBeenCalled();
    expect(routeMocks.defaultAdapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(routeMocks.defaultAdapter.placeMarketOrder).not.toHaveBeenCalled();
    expect(storage.createEquityEvent).not.toHaveBeenCalled();
  });

  it('refuses a non-default adapter from consuming the default-adapter venue cap', async () => {
    updateMarketCache([market('venue', 5)]);
    await refreshLeverageCache();
    routeMocks.selectedAdapter = { ...routeMocks.defaultAdapter, protocolName: 'flash' };
    const result = await computeTradeSizingAndTopUp(sizingInput() as any);
    expect(result.error).toBe('signal_bot_market_leverage_cap_unavailable: venue-published leverage cap is unavailable or invalid for BTC-PERP');
    expect(result.effectiveLeverage).toBe(0);
  });

  it('preserves the valid default-adapter venue clamp at sizing and retry', async () => {
    updateMarketCache([market('venue', 5)]);
    await refreshLeverageCache();
    const result = await computeTradeSizingAndTopUp(sizingInput() as any);
    expect(result.success).toBe(false);
    expect(result.effectiveLeverage).toBe(5);
    expect(result.error).toBe('Bot has no capital configured. Set Max Position Size on the bot.');
    expect(computeRetryEffectiveLeverage(10, 5)).toBe(5);
    expect(computeRetryEffectiveLeverage(2, 5)).toBe(2);
  });
});
