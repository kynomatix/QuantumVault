import { readFileSync } from 'node:fs';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  adapter: {
    getStrictPositionForMarket: vi.fn(),
    getPositions: vi.fn(),
    placeMarketOrder: vi.fn(),
    closePosition: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  },
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
}));

vi.mock('../../server/storage', () => {
  const target: Record<string, any> = {};
  const storage = new Proxy(target, {
    get: (object, property: string | symbol) => {
      if (typeof property !== 'string') return undefined;
      if (property === 'then') return undefined;
      return (object[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId() { return 'test-close-fill'; }
  }
  return { storage, DatabaseStorage };
});

vi.mock('../../server/session', () => ({
  sessionMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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
  getAdapter: vi.fn(() => routeMocks.adapter),
  getDefaultAdapter: vi.fn(() => routeMocks.adapter),
  getAdapterForBot: vi.fn(() => routeMocks.adapter),
}));
import {
  BIND_RETRY_LIMIT,
  BIND_RETRY_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  STORAGE_CLOSE_TIMEOUT_MS,
  createGracefulHttpShutdown,
} from '../../server/graceful-http-shutdown';
import { registerRoutes } from '../../server/routes';
import { storage } from '../../server/storage';
import { decryptAgentKeyStrict, getUmkForWebhook } from '../../server/session-v3';

const ROUTE_BOT_ID = 'bot-close-authority-test';
const ROUTE_WALLET = 'wallet-close-authority-test';
const ROUTE_TV_SECRET = 'tradingview-test-secret';
const ROUTE_USER_SECRET = 'user-webhook-test-secret';
const routeKeypair = Keypair.generate();
const routeWallet = {
  walletAddress: ROUTE_WALLET,
  agentPublicKey: routeKeypair.publicKey.toBase58(),
  agentPrivateKeyEncryptedV3: 'test-v3-ciphertext',
  executionEnabled: true,
  executionExpiresAt: null,
  emergencyStopTriggered: false,
  userWebhookSecret: ROUTE_USER_SECRET,
  slippageBps: 50,
};
const routeBot = {
  id: ROUTE_BOT_ID,
  walletAddress: ROUTE_WALLET,
  name: 'Close authority test bot',
  market: 'BTC-PERP',
  activeProtocol: 'pacifica',
  isActive: true,
  webhookSecret: ROUTE_TV_SECRET,
  side: 'both',
  leverage: 2,
  maxPositionSize: '100',
  driftSubaccountId: 0,
  policyHmac: null,
  protocolSubaccountId: null,
};

let routeServer: Server;
let routeBaseUrl: string;

async function postFullClose(endpoint: 'tradingview' | 'user') {
  const payload: Record<string, unknown> = {
    action: 'buy',
    contracts: '0.25',
    position_size: '0',
    price: '65000',
    symbol: 'BTCUSD',
    time: '2026-08-06T00:00:00.000Z',
  };
  let url = `${routeBaseUrl}/api/webhook/tradingview/${ROUTE_BOT_ID}?secret=${ROUTE_TV_SECRET}`;
  if (endpoint === 'user') {
    payload.botId = ROUTE_BOT_ID;
    url = `${routeBaseUrl}/api/webhook/user/${ROUTE_WALLET}?secret=${ROUTE_USER_SECRET}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function primeCloseRoute(cachedPosition: unknown) {
  vi.mocked(storage.createWebhookLog as any).mockResolvedValue({ id: 'webhook-log-1' });
  vi.mocked(storage.getTradingBotById as any).mockResolvedValue(routeBot);
  vi.mocked(storage.getPublishedBotByTradingBotId as any).mockResolvedValue(null);
  vi.mocked(storage.getWallet as any).mockResolvedValue(routeWallet);
  vi.mocked(storage.getBotPosition as any).mockResolvedValue(cachedPosition);
  vi.mocked(storage.createBotTrade as any).mockResolvedValue({ id: 'close-trade-1' });
  vi.mocked(storage.updateWebhookLog as any).mockResolvedValue(undefined);
  vi.mocked(storage.updateBotTrade as any).mockResolvedValue(undefined);
  vi.mocked(storage.createCloseRetry as any).mockResolvedValue(undefined);
  vi.mocked(getUmkForWebhook as any).mockResolvedValue({
    umk: Buffer.alloc(32, 7),
    cleanup: vi.fn(),
  });
  vi.mocked(decryptAgentKeyStrict as any).mockResolvedValue({
    secretKey: routeKeypair.secretKey,
    cleanup: vi.fn(),
  });
  routeMocks.adapter.getStrictPositionForMarket.mockRejectedValue(new Error('venue unavailable'));
  routeMocks.adapter.placeMarketOrder.mockResolvedValue({
    success: false,
    error: 'expected test stop after order submission',
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  routeServer = await registerRoutes(createServer(app), app);
  await new Promise<void>((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
  const address = routeServer.address();
  if (!address || typeof address === 'string') throw new Error('no ephemeral test port');
  routeBaseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!routeServer) return;
  (routeServer as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => routeServer.close(() => resolve()));
}, 30_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('graceful HTTP shutdown', () => {
  it('stops HTTP admission first, waits for drain and cleanup, then closes storage once', async () => {
    const events: string[] = [];
    const drained = deferred();
    const cleanup = deferred();
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        events.push('close-http');
        drained.promise.then(() => callback());
      }),
      closeIdleConnections: vi.fn(() => events.push('close-idle')),
      closeAllConnections: vi.fn(() => events.push('close-active')),
    };
    const shutdown = createGracefulHttpShutdown({
      server,
      beforeStorageClose: async () => {
        events.push('cleanup-start');
        await cleanup.promise;
        events.push('cleanup-end');
      },
      closeStorage: async () => {
        events.push('close-storage');
      },
      onTimeout: vi.fn(),
      onStorageTimeout: vi.fn(),
      timeoutMs: 1_000,
    });

    const first = shutdown();
    const second = shutdown();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(events.slice(0, 2)).toEqual(['close-http', 'close-idle']);
    expect(events).not.toContain('close-storage');

    drained.resolve();
    await Promise.resolve();
    expect(events).not.toContain('close-storage');
    cleanup.resolve();

    await expect(first).resolves.toBe('drained');
    expect(events).toEqual([
      'close-http',
      'close-idle',
      'cleanup-start',
      'cleanup-end',
      'close-storage',
    ]);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('forces active connections and reports an environment halt at the deadline', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const server = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(() => events.push('forced-close')),
    };
    const closeStorage = vi.fn().mockResolvedValue(undefined);
    const onTimeout = vi.fn(() => events.push('environment-halt-evidence'));
    const shutdown = createGracefulHttpShutdown({
      server,
      beforeStorageClose: () => new Promise<void>(() => {}),
      closeStorage,
      onTimeout,
      onStorageTimeout: vi.fn(),
      timeoutMs: 120,
      storageTimeoutMs: 60,
    });

    const result = shutdown();
    await vi.advanceTimersByTimeAsync(120);

    await expect(result).resolves.toBe('timed_out');
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(120);
    expect(events).toEqual(['environment-halt-evidence', 'forced-close']);
    expect(closeStorage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('waits for a deferred storage close after forcing active connections', async () => {
    vi.useFakeTimers();
    const storage = deferred();
    const events: string[] = [];
    const shutdown = createGracefulHttpShutdown({
      server: {
        close: vi.fn(),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(() => events.push('forced-close')),
      },
      beforeStorageClose: () => new Promise<void>(() => {}),
      closeStorage: async () => {
        events.push('storage-start');
        await storage.promise;
        events.push('storage-end');
      },
      onTimeout: () => events.push('http-environment-halt'),
      onStorageTimeout: () => events.push('storage-environment-halt'),
      timeoutMs: 120,
      storageTimeoutMs: 60,
    });

    let settled = false;
    const result = shutdown().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(120);
    expect(settled).toBe(false);
    expect(events).toEqual(['http-environment-halt', 'forced-close', 'storage-start']);
    storage.resolve();
    await expect(result).resolves.toBe('timed_out');
    expect(events).toEqual([
      'http-environment-halt',
      'forced-close',
      'storage-start',
      'storage-end',
    ]);
    vi.useRealTimers();
  });

  it('bounds a stuck storage close and reports a distinct environment halt', async () => {
    vi.useFakeTimers();
    const onStorageTimeout = vi.fn();
    const shutdown = createGracefulHttpShutdown({
      server: {
        close: vi.fn(),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(),
      },
      beforeStorageClose: () => new Promise<void>(() => {}),
      closeStorage: () => new Promise<void>(() => {}),
      onTimeout: vi.fn(),
      onStorageTimeout,
      timeoutMs: 120,
      storageTimeoutMs: 60,
    });

    let settled = false;
    const result = shutdown().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(120);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(59);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('timed_out');
    expect(onStorageTimeout).toHaveBeenCalledWith(60);
    vi.useRealTimers();
  });

  it('reports a close error without duplicating the shutdown sequence', async () => {
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback(new Error('not listening'))),
      closeIdleConnections: vi.fn(),
    };
    const shutdown = createGracefulHttpShutdown({
      server,
      beforeStorageClose: async () => {},
      closeStorage: async () => {},
      onTimeout: vi.fn(),
      onStorageTimeout: vi.fn(),
      timeoutMs: 1_000,
    });

    await expect(shutdown()).resolves.toBe('close_error');
    await expect(shutdown()).resolves.toBe('close_error');
    expect(server.close).toHaveBeenCalledTimes(1);
  });
});

describe('close-path and restart contract wiring', () => {
  describe('real Signal Bot webhook handlers', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it.each(['tradingview', 'user'] as const)(
      '%s submits exactly one reduce-only close from a valid cached SHORT after the strict read fails',
      async (endpoint) => {
        primeCloseRoute({
          market: 'BTC-PERP',
          baseSize: '-0.25',
          avgEntryPrice: '64000',
        });

        const response = await postFullClose(endpoint);

        expect(response.body.closeOutcome).not.toBe('already_flat');
        expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledTimes(1);
        expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
          internalSymbol: 'BTC-PERP',
          side: 'long',
          sizeBase: 0.25,
          reduceOnly: true,
        }));
        expect(routeMocks.adapter.closePosition).not.toHaveBeenCalled();
        expect(storage.createBotTrade).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['tradingview', 'absent', null],
      ['tradingview', 'zero', { market: 'BTC-PERP', baseSize: '0', avgEntryPrice: '64000' }],
      ['tradingview', 'malformed', { market: 'BTC-PERP', baseSize: 'not-a-number', avgEntryPrice: '64000' }],
      ['user', 'absent', null],
      ['user', 'zero', { market: 'BTC-PERP', baseSize: '0', avgEntryPrice: '64000' }],
      ['user', 'malformed', { market: 'BTC-PERP', baseSize: 'not-a-number', avgEntryPrice: '64000' }],
    ] as const)(
      '%s returns position_unavailable and submits no order for a %s cached source',
      async (endpoint, _cacheCase, cachedPosition) => {
        primeCloseRoute(cachedPosition);

        const response = await postFullClose(endpoint);

        expect(response.status).toBe(503);
        expect(response.body.closeOutcome).toBe('position_unavailable');
        expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
        expect(routeMocks.adapter.closePosition).not.toHaveBeenCalled();
        expect(storage.createBotTrade).not.toHaveBeenCalled();
      },
    );

    it.each(['tradingview', 'user'] as const)(
      '%s treats a fresh venue FLAT as terminal and never falls through to cached nonzero state',
      async (endpoint) => {
        primeCloseRoute({
          market: 'BTC-PERP',
          baseSize: '-0.25',
          avgEntryPrice: '64000',
        });
        routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue(null);

        const response = await postFullClose(endpoint);

        expect(response.status).toBe(409);
        expect(response.body.closeOutcome).toBe('already_flat');
        expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
        expect(routeMocks.adapter.closePosition).not.toHaveBeenCalled();
        expect(storage.createBotTrade).not.toHaveBeenCalled();
        expect(storage.getBotPosition).toHaveBeenCalledTimes(endpoint === 'tradingview' ? 1 : 0);
      },
    );
  });
  it('keeps the bind retry window above both sequential shutdown deadlines', () => {
    expect(BIND_RETRY_MS * BIND_RETRY_LIMIT).toBeGreaterThan(
      SHUTDOWN_DRAIN_TIMEOUT_MS + STORAGE_CLOSE_TIMEOUT_MS,
    );
  });

  it('keeps two full-close authority pairs plus one centralized FLIP adapter and three delegations', () => {
    const routes = readFileSync('server/routes.ts', 'utf8');
    const strictReads = routes.match(/getPositionForCloseAuthority\(/g) ?? [];
    const cacheFallbacks = routes.match(/getRiskReducingCachedCloseFallback\(/g) ?? [];
    const flipDelegations = routes.match(/await executeSignalBotFlipClose\(/g) ?? [];
    expect(strictReads).toHaveLength(3);
    expect(cacheFallbacks).toHaveLength(3);
    expect(flipDelegations).toHaveLength(3);
    expect(routes).toContain('executionLabel: "per_bot"');
    expect(routes).toContain('executionLabel: "user_webhook"');
    expect(routes).toContain('executionLabel: "subscriber"');
    expect(routes).toContain('getPositionForExecution(');
    expect(routes).toContain('only for a reduce-only close');
    expect(routes).toContain('All declared close-position authority sources failed');
  });

  it('removes the legacy ten-second shutdown backstop and uses the shared drain helper', () => {
    const index = readFileSync('server/index.ts', 'utf8');
    expect(index).toContain('createGracefulHttpShutdown({');
    expect(index).not.toContain('Shutdown grace period (10s)');
    expect(index).not.toContain('}, 10_000);');
  });
});
