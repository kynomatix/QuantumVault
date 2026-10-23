import express from 'express';
import { createServer, type Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(),
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
  pool: {}, // These routes do not use SQL; unexpected pool operations must fail.
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
  vi.mocked(storage.createCloseRetry as any).mockReset().mockResolvedValue(undefined);
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
  return { positions: size === 0 ? [] : [{ internalSymbol: 'BTC-PERP', baseSize: size, entryPrice: 64000 }],
    evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${account}-${sequence}`, startedAt: now, dispatchedAt: now,
      receivedAt: now, lastOrderId: sequence, complete: true, fresh: true, noDedup: true } };
}
function primeConfirmation(defect: string) {
  vi.clearAllMocks();
  primeCloseRoute({ market: 'BTC-PERP', baseSize: '0.25', avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY' });
  vi.mocked(storage.getBotTrades).mockResolvedValue([]);
  vi.mocked(storage.recordCloseEventAtomic).mockResolvedValue({ isNew: true, trade: { id: 'EXAMPLE_TRADE' } } as never);
  routeMocks.decryptBotSubaccountKey.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
  routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue({ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 });
  routeMocks.adapter.getPositions.mockResolvedValue([{ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 }]);
  routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: true, orderId: defect === 'no-signature' ? undefined : 'EXAMPLE_ORDER',
    landingDisposition: defect === 'ambiguous-dispatch' ? 'unconfirmed' : 'terminal', status: 'filled', fillPrice: 65000, fee: 0 });
  if (defect === 'missing-epoch') vi.mocked(storage.getBotPosition).mockResolvedValue(undefined);
  if (defect === 'account-rotated' || defect === 'epoch-changed') {
    routeMocks.adapter.placeMarketOrder.mockImplementation(async () => {
      if (defect === 'account-rotated') {
        vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, protocolSubaccountId: 'EXAMPLE_OTHER' } as never);
      } else {
        vi.mocked(storage.getBotPosition).mockResolvedValue({ market: 'BTC-PERP', baseSize: '0.25', lastTradeId: 'EXAMPLE_NEW_ENTRY' } as never);
      }
      return { success: true, orderId: 'EXAMPLE_ORDER', status: 'filled' };
    });
  }
  let sequence = 0;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockReset().mockImplementation(async (account: string) => {
    sequence++;
    if (sequence === 1 && defect === 'baseline-failed') throw new Error('EXAMPLE baseline unavailable');
    if (sequence > 1 && defect === 'read-failed') throw new Error('EXAMPLE unavailable');
    const result = snapshot(account, sequence, sequence === 1 ? 0.25 : defect === 'residual' ? 0.000001 : 0);
    if (sequence > 1 && defect === 'wrong-account') result.evidence.account = 'EXAMPLE_WRONG';
    if (sequence > 1 && defect === 'unchanged-watermark') result.evidence.lastOrderId = 1;
    return result;
  });
}
describe('registered close routes enforce strict completion', () => {
  for (const endpoint of ['tradingview', 'user'] as const) {
    it.each(['baseline-failed', 'read-failed', 'residual', 'wrong-account', 'unchanged-watermark', 'no-signature', 'ambiguous-dispatch', 'missing-epoch', 'account-rotated', 'epoch-changed'])(`${endpoint} keeps %s pending without money effects`, async defect => {
      primeConfirmation(defect);
      const result = await postFullClose(endpoint);
      expect(result.status).toBe(202);
      expect(result.body.status).toBe('pending');
      expect(storage.recordCloseEventAtomic).not.toHaveBeenCalled();
      expect(storage.createPendingProfitShare).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
      expect(routeMocks.adapter.getTradeHistory).not.toHaveBeenCalled();
    });
    it.each([0.25, 0.24])(`${endpoint} books only exact attributable fills: %s`, async size => {
      primeConfirmation('fills');
      routeMocks.adapter.getTradeHistory.mockImplementation(async () => [{
        tradeId: 'EXAMPLE_FILL', orderId: 'EXAMPLE_ORDER', internalSymbol: 'BTC-PERP',
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
