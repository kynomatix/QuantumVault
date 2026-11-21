import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SignalBotCloseIntentStorage } from '../../server/trading/signal-bot-close-intent-storage';
import { waitForCloseEffects } from '../../server/trading/signal-bot-close-intent-effects';
import { installCloseAccountingTables, seedCloseBot } from '../helpers/close-accounting-postgres';
import { readDbSchemaMigrationManifest } from '../helpers/schema-migration-manifest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const parity = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  store: undefined as SignalBotCloseIntentStorage | undefined,
  realStorageClass: undefined as typeof import('../../server/storage').DatabaseStorage | undefined,
}));
vi.mock('../../server/notification-service', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/notification-service')>(),
  sendTradeNotification: vi.fn(async () => true),
}));
vi.mock('../../server/vault/auto-repark', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/vault/auto-repark')>(),
  maybeScheduleAutoRepark: vi.fn(async () => {}),
}));

const routeMocks = vi.hoisted(() => ({
  adapter: {
    protocolName: 'pacifica',
    getStrictPositionForMarket: vi.fn(),
    getCloseConfirmationSnapshot: vi.fn(),
    getPositions: vi.fn(),
    getTradeHistory: vi.fn(),
    getFeeRateQuote: vi.fn(),
    placeMarketOrder: vi.fn(),
    closePosition: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  },
  createCloseRetry: vi.fn(async () => undefined),
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(),
}));

vi.mock('../../server/storage', () => {
  const target: Record<string, any> = { createCloseRetry: routeMocks.createCloseRetry };
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
  return { storage, get DatabaseStorage() { return parity.realStorageClass ?? DatabaseStorage; } };
});

vi.mock('../../server/trading/close-intent-store', async () => {
  const { makeCloseRouteStore } = await import('../helpers/close-route-intent-store');
  const { storage } = await import('../../server/storage');
  const memoryStore = makeCloseRouteStore(storage);
  return { get closeIntentStore() { return parity.store ?? memoryStore; } };
});
import { sendTradeNotification } from '../../server/notification-service';
import { closeIntentStore } from '../../server/trading/close-intent-store';
import { bridgePreparedClose } from '../helpers/close-route-intent-store';

vi.mock('../../server/session', () => ({
  sessionMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../server/db', () => ({
  get db() { return parity.pool ? drizzle(parity.pool) : {}; },
  get pool() { return parity.pool ?? {}; },
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
  decryptBotSubaccountKey: routeMocks.decryptBotSubaccountKey,
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
import * as classifier from '../../server/trading/signal-classifier';
import { registerRoutes, routeSignalToSubscribers } from '../../server/routes';
import { storage } from '../../server/storage';
import { decryptAgentKeyStrict, getUmkForWebhook } from '../../server/session-v3';

const ROUTE_BOT_ID = 'bot-close-authority-test';
const ROUTE_WALLET = 'wallet-close-authority-test';
const ROUTE_TV_SECRET = 'EXAMPLE_TV';
const ROUTE_USER_SECRET = 'EXAMPLE_USER';
const ROUTE_ADMIN_PASSWORD = 'EXAMPLE_ADMIN';

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
  protocolSubaccountId: routeKeypair.publicKey.toBase58(),
  subaccountAuthMode: 'external_key', subaccountStatus: 'active', botSubaccountKeyEncryptedV3: 'EXAMPLE',
};

let routeServer: Server;
let routeBaseUrl: string;

async function postFullClose(endpoint: 'tradingview' | 'user', overrides: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = {
    action: 'buy',
    contracts: '0.25',
    position_size: '0',
    price: '65000',
    symbol: 'BTCUSD',
    time: '2026-08-06T00:00:00.000Z',
    ...overrides,
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
  if (!parity.store) (closeIntentStore as any).reset();
  bridgePreparedClose(routeMocks.adapter);
  vi.mocked(storage.createWebhookLog as any).mockReset().mockResolvedValue({ id: 'webhook-log-1' });
  vi.mocked(storage.getTradingBotById as any).mockReset().mockResolvedValue(routeBot);
  vi.mocked(storage.getPublishedBotByTradingBotId as any).mockReset().mockResolvedValue(null);
  vi.mocked(storage.getWallet as any).mockReset().mockResolvedValue(routeWallet);
  vi.mocked(storage.getBotPosition as any).mockReset().mockResolvedValue(cachedPosition);
  vi.mocked(storage.createBotTrade as any).mockReset().mockResolvedValue({ id: 'close-trade-1' });
  vi.mocked(storage.recordCloseEventAtomic as any).mockReset().mockResolvedValue(undefined);
  vi.mocked(storage.updateWebhookLog as any).mockReset().mockResolvedValue(undefined);
  vi.mocked(storage.updateBotTrade as any).mockReset().mockResolvedValue(undefined);
  vi.mocked(storage.updatePendingBotTrade as any).mockReset().mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
    id: 'pending-partial-row',
    status: 'pending',
    ...updates,
  }));
  vi.mocked(storage.getBotTrade as any).mockReset().mockResolvedValue(undefined);
  routeMocks.createCloseRetry.mockReset().mockResolvedValue(undefined);
  vi.mocked(getUmkForWebhook as any).mockReset().mockResolvedValue({
    umk: Buffer.alloc(32, 7),
    cleanup: vi.fn(),
  });
  vi.mocked(decryptAgentKeyStrict as any).mockReset().mockResolvedValue({
    secretKey: routeKeypair.secretKey,
    cleanup: vi.fn(),
  });
  routeMocks.adapter.getStrictPositionForMarket.mockReset().mockRejectedValue(new Error('venue unavailable'));
  routeMocks.adapter.getTradeHistory.mockReset().mockResolvedValue([]);
  routeMocks.adapter.getFeeRateQuote.mockReset().mockResolvedValue({ availability: 'unavailable', reason: 'builder_rate_unknown' });
  routeMocks.adapter.placeMarketOrder.mockReset().mockResolvedValue({
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
  if (routeServer) {
    (routeServer as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => routeServer.close(() => resolve()));
  }

}, 30_000);


function snapshot(account: string, sequence: number, size: number) {
  const now = Date.now();
  return { positions: size === 0 ? [] : [{ internalSymbol: 'BTC-PERP', baseSize: size, sizeBaseExact: String(size), entryPrice: 64000 }],
    evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${account}-${sequence}`, startedAt: now, dispatchedAt: now,
      receivedAt: now, lastOrderId: (routeMocks.adapter.placeMarketOrder.mock.calls.length === 0 ? 1 : 2) as number | null, complete: true, fresh: true, noDedup: true } };
}
function primeConfirmation(defect: string) {
  vi.clearAllMocks();
  primeCloseRoute({ market: 'BTC-PERP', baseSize: '0.25', avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY' });
  vi.mocked(storage.getBotTrades).mockResolvedValue([]);
  vi.mocked(storage.recordCloseEventAtomic).mockResolvedValue({ isNew: true, trade: { id: 'EXAMPLE_TRADE' } } as never);
  routeMocks.decryptBotSubaccountKey.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
  routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue({ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 });
  routeMocks.adapter.getPositions.mockResolvedValue([{ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 }]);
  routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: true, orderId: defect === 'no-signature' ? undefined : '17',
    landingDisposition: defect === 'ambiguous-dispatch' ? 'unconfirmed' : 'terminal', status: 'filled', fillPrice: 65000, fee: 0 });
  if (defect === 'missing-epoch') vi.mocked(storage.getBotPosition).mockResolvedValue(undefined);
  if (defect === 'account-rotated' || defect === 'epoch-changed') {
    routeMocks.adapter.placeMarketOrder.mockImplementation(async () => {
      if (defect === 'account-rotated') {
        vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, protocolSubaccountId: 'EXAMPLE_OTHER' } as never);
      } else {
        vi.mocked(storage.getBotPosition).mockResolvedValue({ market: 'BTC-PERP', baseSize: '0.25', lastTradeId: 'EXAMPLE_NEW_ENTRY' } as never);
      }
      return { success: true, orderId: '17', status: 'filled' };
    });
  }
  let sequence = 0;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockReset().mockImplementation(async (account: string) => {
    sequence++;
    if (routeMocks.adapter.placeMarketOrder.mock.calls.length === 0 && defect === 'baseline-failed') throw new Error('EXAMPLE baseline unavailable');
    if (routeMocks.adapter.placeMarketOrder.mock.calls.length > 0 && defect === 'read-failed') throw new Error('EXAMPLE unavailable');
    const result = snapshot(account, sequence, routeMocks.adapter.placeMarketOrder.mock.calls.length === 0 ? 0.25 : defect === 'residual' ? 0.000001 : 0);
    if (routeMocks.adapter.placeMarketOrder.mock.calls.length > 0 && defect === 'wrong-account') result.evidence.account = 'EXAMPLE_WRONG';
    if (routeMocks.adapter.placeMarketOrder.mock.calls.length > 0 && defect === 'no-history') result.evidence.lastOrderId = null;
    if (routeMocks.adapter.placeMarketOrder.mock.calls.length > 0 && defect === 'unchanged-watermark') result.evidence.lastOrderId = 1;
    return result;
  });
}
describe('registered close routes enforce strict completion', () => {
  for (const endpoint of ['tradingview', 'user'] as const) {
    it.each(['no-history', 'read-failed', 'residual', 'wrong-account', 'no-signature', 'ambiguous-dispatch', 'account-rotated', 'epoch-changed'])(`${endpoint} keeps %s pending without money effects`, async defect => {
      primeConfirmation(defect);
      const result = await postFullClose(endpoint);
      expect(result.status).toBe(202);
      expect(result.body.status).toBe('pending');
      expect(storage.recordCloseEventAtomic).not.toHaveBeenCalled();
      expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
      expect(routeMocks.adapter.getTradeHistory).not.toHaveBeenCalled();
    });
    it.each(['baseline-failed', 'unchanged-watermark', 'missing-epoch'])(`${endpoint} confirms S5 strict flat exposure after %s`, async scenario => {
      primeConfirmation(scenario);
      const result = await postFullClose(endpoint);
      expect(result.status).toBe(200);
      expect(storage.recordCloseEventAtomic).toHaveBeenCalledOnce();
      expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
    });
    it.each([0.25, 0.24])(`${endpoint} books only exact attributable fills: %s`, async size => {
      primeConfirmation('fills');
      routeMocks.adapter.getTradeHistory.mockImplementation(async () => [{
        tradeId: 'EXAMPLE_FILL', orderId: '17', internalSymbol: 'BTC-PERP',
        side: 'short', size, price: 65000, fee: 1, timestamp: Date.now(),
      }]);
      const result = await postFullClose(endpoint);
      expect(result.status).toBe(200);
      const event = vi.mocked(storage.recordCloseEventAtomic).mock.calls[0][0];
      if (size === 0.25) {
        expect(event).toHaveProperty('confirmedPositionClose');
        expect(event.update?.fields).toMatchObject({ fee: '1', pnl: '249' });
      } else {
        expect(event).toHaveProperty('confirmedPositionCloseIncomplete');
        expect(event.update?.fields).toMatchObject({ fee: null, pnl: null });
        expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
      }
    });
    it(`ACCT-01 ${endpoint} confirms a malformed truthy acknowledgment without reading history`, async () => {
      primeConfirmation('fills');
      routeMocks.adapter.placeMarketOrder.mockResolvedValue({
        success: true, orderId: ' 17 ', status: 'filled', landingDisposition: 'terminal',
      });
      const result = await postFullClose(endpoint);
      expect(result.status).toBe(200);
      expect(routeMocks.adapter.getTradeHistory).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
      expect(vi.mocked(storage.recordCloseEventAtomic).mock.calls[0][0]).toHaveProperty('confirmedPositionCloseIncomplete');
    });
    it(`${endpoint} completes qualified flat exposure with unavailable accounting`, async () => {
      primeConfirmation('no-fills');
      const result = await postFullClose(endpoint);
      expect(result.status).toBe(200);
      expect(storage.recordCloseEventAtomic).toHaveBeenCalledOnce();
      const event = vi.mocked(storage.recordCloseEventAtomic).mock.calls[0][0];
      expect(event).toHaveProperty('confirmedPositionCloseIncomplete');
      expect(event).not.toHaveProperty('confirmedPositionClose');
      expect(event.update?.fields).toMatchObject({ status: 'executed', fee: null, pnl: null });
      expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
    });
  }
  it('ACCT-01 user full close reports matched fill PnL and keeps the numeric acknowledgment', async () => {
    primeConfirmation('fills');
    routeMocks.adapter.placeMarketOrder.mockResolvedValue({
      success: true, orderId: 17, status: 'filled', landingDisposition: 'terminal',
    });
    routeMocks.adapter.getTradeHistory.mockImplementation(async () => [{
      tradeId: 'EXAMPLE_FILL', orderId: '17', internalSymbol: 'BTC-PERP',
      side: 'short', venueEventKind: 'close_long', size: 0.25, price: 65000,
      fee: 1, realizedPnl: 250, timestamp: Date.now(),
    }]);
    const settle = vi.spyOn(closeIntentStore, 'settle');
    try {
      const result = await postFullClose('user');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ closeOutcome: 'executed', txSignature: 17, pnl: 250 });
      expect(settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
        status: 'confirmed', last_evidence: expect.objectContaining({
          accountingPending: false, fill: expect.objectContaining({ fillPrice: 65000, fee: 1, realizedPnl: 250 }),
        }),
      }), expect.any(Function));
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
    } finally {
      settle.mockRestore();
    }
  });
  it('contains each subscriber using its own account and never queues a resend', async () => {
    primeConfirmation('read-failed');
    const sub = { ...routeBot, id: 'EXAMPLE_SUB', walletAddress: 'EXAMPLE_SUB_OWNER' };
    vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue({ id: 'EXAMPLE_PUBLISHED', isActive: true } as never);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([sub] as never);
    vi.mocked(storage.getTradingBotById).mockResolvedValue(sub as never);
    await routeSignalToSubscribers('EXAMPLE_SOURCE', { action: 'sell', contracts: '0', positionSize: '0', price: '65000', isCloseSignal: true, strategyPositionSize: null });
    expect(routeMocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledWith(sub.protocolSubaccountId, undefined);
    expect(storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(storage.createTradeRetryJob).not.toHaveBeenCalled();
    expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
  });
});

// Preserve references across tables and responses while pairing independently minted UUIDs and clocks.
// Acknowledgment type is asserted at the wire and journal boundaries before comparing the variants.
function comparableCloseRun(run: unknown, acknowledgment: number | string) {
  const references = new Map<string, string>();
  return JSON.parse(JSON.stringify(run, (key, value) => {
    if (['orderId', 'txSignature', 'signature', 'transactionSignature'].includes(key)) {
      if (value === acknowledgment) return '17';
      if (value === (typeof acknowledgment === 'number' ? 23 : '23')) return '23';
    }
    if (typeof value === 'number' && /(?:At|Time|TimestampMs|timestamp|ClockMs)$/.test(key) && value > 1e12) return 'clock';
    if (typeof value !== 'string') return value;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return 'clock';
    return value.replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, id => {
      if (!references.has(id)) references.set(id, 'generated-' + references.size);
      return references.get(id)!;
    });
  }));
}

describe('ACCT-01 registered close parity on PostgreSQL', () => {
  const schema = 'acct_close_' + randomUUID().replaceAll('-', '');
  const followerKey = Keypair.generate();
  const follower = { ...routeBot, id: 'EXAMPLE_FOLLOWER', walletAddress: 'EXAMPLE_FOLLOWER_OWNER', sourcePublishedBotId: 'EXAMPLE_LISTING',
    protocolSubaccountId: followerKey.publicKey.toBase58() };
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const tables = ['signal_bot_close_intents', 'bot_trades', 'bot_positions', 'trading_bots', 'webhook_logs',
    'bot_subscriptions', 'published_bots', 'pending_profit_shares', 'platform_cumulative_stats'] as const;
  let pool: Pool;
  let real: import('../../server/storage').DatabaseStorage;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for close accounting tests');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 10 });
    await installCloseAccountingTables(pool);
    await pool.query(readDbSchemaMigrationManifest().manifest.find(m => m.id.startsWith('206-'))!.sql);
    parity.pool = pool;
    parity.store = new SignalBotCloseIntentStorage(pool);
    vi.spyOn(parity.store, 'ready').mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../../server/storage')>('../../server/storage');
    parity.realStorageClass = actual.DatabaseStorage;
    real = new actual.DatabaseStorage();
  });
  afterAll(async () => {
    await waitForCloseEffects();
    parity.store = undefined;
    parity.pool = undefined;
    parity.realStorageClass = undefined;
    await pool?.end();
    if (pool) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  async function scenario(endpoint: 'tradingview' | 'user', partial: boolean, ack: number | string) {
    await waitForCloseEffects();
    await pool.query('TRUNCATE ' + tables.join(', '));
    primeConfirmation('fills');
    for (const method of ['getBotPosition', 'getBotTrade', 'getBotTrades', 'createWebhookLog', 'updateWebhookLog',
      'checkDuplicateSignal', 'getPublishedBotByTradingBotId', 'recordCloseEventAtomic', 'updatePendingBotTrade', 'updateBotTrade'] as const) {
      const delegate: (...args: any[]) => any = real[method];
      vi.mocked(storage[method] as any).mockImplementation(delegate.bind(real));
    }
    vi.mocked(storage.getTradingBotById).mockImplementation(async id => (id === follower.id ? follower : routeBot) as never);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([follower] as never);
    routeMocks.decryptBotSubaccountKey.mockImplementation(async ({ id }) => ({
      secretKey: (id === follower.id ? followerKey : routeKeypair).secretKey, cleanup: vi.fn(),
    }));
    vi.mocked(storage.getWallet).mockImplementation(async address => (address === follower.walletAddress
      ? { ...routeWallet, walletAddress: address, agentPublicKey: follower.protocolSubaccountId, slippageBps: 83 }
      : routeWallet) as never);
    const followerAck = typeof ack === 'number' ? 23 : '23';
    const positions = new Map([[routeBot.protocolSubaccountId, 2], [follower.protocolSubaccountId, 4]]);
    for (const bot of [routeBot, follower]) {
      await seedCloseBot(pool, bot.id, bot.walletAddress, bot.protocolSubaccountId);
      await pool.query('INSERT INTO bot_positions(trading_bot_id,wallet_address,market,base_size,avg_entry_price,cost_basis,realized_pnl,total_fees,last_trade_id) VALUES($1,$2,$3,$4,64000,$5,0,0,$6)',
        [bot.id, bot.walletAddress, bot.market, positions.get(bot.protocolSubaccountId), positions.get(bot.protocolSubaccountId)! * 64000, 'EXAMPLE_ENTRY']);
    }
    await pool.query(`INSERT INTO published_bots(id,trading_bot_id,creator_wallet_address,name,market,profit_share_percent)
      VALUES('EXAMPLE_LISTING',$1,$2,'EXAMPLE','BTC-PERP',10)`, [routeBot.id, routeBot.walletAddress]);
    await pool.query("UPDATE trading_bots SET source_published_bot_id=$1 WHERE id=$2", [follower.sourcePublishedBotId, follower.id]);
    await pool.query(`INSERT INTO bot_subscriptions(id,published_bot_id,subscriber_bot_id,subscriber_wallet_address,capital_invested)
      VALUES('EXAMPLE_SUBSCRIPTION',$1,$2,$3,100)`, [follower.sourcePublishedBotId, follower.id, follower.walletAddress]);
    const sends: Record<string, unknown>[] = [];
    const filled = new Map<string, number>();
    const venuePosition = (account: string) => ({ internalSymbol: 'BTC-PERP', baseSize: positions.get(account)!, entryPrice: 64000 });
    routeMocks.adapter.getPositions.mockImplementation(async account => positions.get(account) ? [venuePosition(account)] : []);
    routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async account => positions.get(account) ? venuePosition(account) : null);
    let sequence = 0;
    routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => {
      const result = snapshot(account, ++sequence, positions.get(account)!);
      result.evidence.lastOrderId = filled.has(account) ? 2 : 1;
      return result;
    });
    routeMocks.adapter.placeMarketOrder.mockImplementation(async ({ agentSecretKey: _signer, ...params }) => {
      sends.push(params);
      filled.set(params.agentPublicKey, params.sizeBase);
      positions.set(params.agentPublicKey, positions.get(params.agentPublicKey)! - params.sizeBase);
      return { success: true, orderId: params.agentPublicKey === follower.protocolSubaccountId ? followerAck : ack,
        status: 'filled', landingDisposition: 'terminal' };
    });
    routeMocks.adapter.getTradeHistory.mockImplementation(async (account, window) => {
      const size = filled.get(account)!;
      return [0.25, 0.75].map((fraction, i) => ({
        tradeId: 'EXAMPLE_FILL_' + i, orderId: account === follower.protocolSubaccountId ? '23' : '17',
        internalSymbol: 'BTC-PERP', subaccountId: account, side: 'short', venueEventKind: 'close_long',
        size: size * fraction, price: 64000 + 1000 * i, fee: fraction, realizedPnl: size * fraction * 1000 * i,
        timestamp: window.startTime,
      }));
    });

    // Full-close fan-out continues after the HTTP reply. Its completion audit follows every follower write.
    let routed!: () => void;
    const routingDone = new Promise<void>(resolve => { routed = resolve; });
    const classifications = vi.spyOn(classifier, 'classifySignal');
    const originalLog = console.log;
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      if (String(args[0]).startsWith('[Subscriber Routing] AUDIT:')) routed();
      else originalLog(...args);
    });
    try {
      const request = { action: 'sell', contracts: partial ? '1' : '2',
        position_size: partial ? '1' : '0', price: undefined };
      const response = await postFullClose(endpoint, request);
      expect(response.status).toBe(200);
      expect(response.body[partial ? 'signature' : 'txSignature']).toBe(ack);
      if (partial) expect(response.body).toMatchObject({ type: 'partial_close', closedSize: 1, remainingSize: 1 });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([routingDone, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Expected subscriber routing to finish')), 5000);
        })]);
      } finally { clearTimeout(timeout); }
      await waitForCloseEffects();
      expect(sends).toHaveLength(2);
      for (const [index, bot] of [routeBot, follower].entries()) {
        expect(sends[index]).toMatchObject({ agentPublicKey: bot.protocolSubaccountId, internalSymbol: bot.market,
          side: 'short', sizeBase: (index + 1) * (partial ? 1 : 2), reduceOnly: true, maxSlippagePct: index === 0 ? 0.5 : 0.83 });
      }
      const followerLookups = vi.mocked(storage.getSubscriberBotsBySourceId);
      const lookupCount = followerLookups.mock.calls.length;
      const classificationCount = classifications.mock.calls.length;
      const duplicate = await postFullClose(endpoint, request);
      expect(duplicate).toEqual({ status: 200, body: { status: 'skipped', reason: 'duplicate signal' } });
      await waitForCloseEffects();
      expect(sends).toHaveLength(2);
      expect(followerLookups).toHaveBeenCalledTimes(lookupCount);
      expect(classifications).toHaveBeenCalledTimes(classificationCount);
      const rows: Record<string, any[]> = {};
      for (const table of tables) {
        const sort = table === 'signal_bot_close_intents' ? 'bot_id' : ['bot_trades', 'bot_positions'].includes(table) ? 'trading_bot_id' : 'id';
        rows[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${sort}`)).rows;
      }
      expect(rows.signal_bot_close_intents).toHaveLength(2);
      expect(rows.bot_trades).toHaveLength(2);
      for (const bot of [routeBot, follower]) {
        const intent = rows.signal_bot_close_intents.find(i => i.bot_id === bot.id)!;
        const expectedSize = (bot === follower ? 2 : 1) * (partial ? 1 : 2);
        const expectedPnl = 750 * expectedSize - 1;
        expect(intent).toMatchObject({ status: 'confirmed', attempt_count: 1, last_evidence: { accountingPending: false } });
        expect(intent.attempt_log[0].outcome.orderId).toBe(intent.bot_id === follower.id ? followerAck : ack);
        const trade = rows.bot_trades.find(t => t.id === intent.original_trade_id)!;
        expect(trade).toMatchObject({ trading_bot_id: bot.id, status: 'executed', pnl_convention: 'net_of_close_fee' });
        expect(Number(trade.size)).toBe(expectedSize);
        expect(Number(trade.price)).toBe(64750);
        expect(Number(trade.fee)).toBe(1);
        expect(Number(trade.pnl)).toBe(expectedPnl);
        const botRow = rows.trading_bots.find(row => row.id === bot.id)!;
        expect(botRow.stats).toMatchObject({ totalTrades: 1, winningTrades: 1, losingTrades: 0, totalPnl: expectedPnl });
        const position = rows.bot_positions.find(p => p.trading_bot_id === bot.id)!;
        expect(Number(position.realized_pnl)).toBe(expectedPnl);
        expect(Number(position.total_fees)).toBe(1);
        if (!partial) expect(position.last_trade_id).toBe(trade.id);
      }
      expect(rows.pending_profit_shares).toHaveLength(1);
      const share = rows.pending_profit_shares[0];
      expect(share).toMatchObject({ subscriber_bot_id: follower.id, published_bot_id: follower.sourcePublishedBotId,
        creator_wallet_address: routeBot.walletAddress, status: 'deferred' });
      expect(share.trade_id).toBe(rows.bot_trades.find(t => t.trading_bot_id === follower.id)!.protocol_fill_id);
      const followerPnl = partial ? 1499 : 2999;
      expect(Number(share.realized_pnl)).toBe(followerPnl);
      expect(Number(share.amount)).toBeCloseTo(followerPnl * 0.1);
      expect(rows.webhook_logs).toHaveLength(1);
      expect(rows.webhook_logs[0]).toMatchObject({ trade_executed: true, error_message: null });
      expect(await real.checkDuplicateSignal(rows.webhook_logs[0].signal_hash, routeBot.id)).toBe(true);
      expect(storage.createTradeRetryJob).not.toHaveBeenCalled();
      expect(routeMocks.createCloseRetry).not.toHaveBeenCalled();
      const followerRequests = classifications.mock.calls.filter(([position]) => position.size === 4);
      expect(followerRequests).toHaveLength(1);

      let nextPosition: Awaited<ReturnType<typeof real.getBotPosition>>;
      if (!partial) {
        const { executeSignalBotEntry } = await import('../../server/trading/signal-bot-entry-admission');
        const entry = await executeSignalBotEntry(routeBot, () => parity.store!.withOpenFence('EXAMPLE', routeBot.protocolSubaccountId, routeBot.market, async () => {
          const trade = await real.createBotTrade({ tradingBotId: routeBot.id, walletAddress: routeBot.walletAddress,
            market: routeBot.market, side: 'LONG', size: '1', price: '60000', fee: '1', status: 'executed' });
          const written = await real.updateBotPositionFromTrade(routeBot.id, routeBot.market, routeBot.walletAddress, 'LONG', 1, 60000, 1, trade.id);
          expect(written.lastTradeId).toBe(trade.id);
          return { success: true };
        }));
        expect(entry.success).toBe(true);
        nextPosition = await real.getBotPosition(routeBot.id, routeBot.market);
        expect(Number(nextPosition?.baseSize)).toBe(1);
        expect((await real.getBotTrade(nextPosition!.lastTradeId!))?.side).toBe('LONG');
      }
      const notifications = vi.mocked(sendTradeNotification).mock.calls;
      expect(notifications.length).toBeGreaterThan(0);
      return comparableCloseRun({ response, duplicate, rows, sends, followerRequests, followerLookups: followerLookups.mock.calls,
        notifications, pendingShareCalls: vi.mocked(storage.createPendingProfitShare).mock.calls, nextPosition }, ack);
    } finally { log.mockRestore(); classifications.mockRestore(); }
  }

  for (const endpoint of ['tradingview', 'user'] as const) {
    it.each([false, true])(`ACCT-01 ${endpoint} numeric and string acknowledgments settle identically (partial=%s)`, async partial => {
      const known = await scenario(endpoint, partial, '17');
      expect(await scenario(endpoint, partial, 17)).toEqual(known);
    }, 45_000);
  }
});
