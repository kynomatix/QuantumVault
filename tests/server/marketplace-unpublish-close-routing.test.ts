import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import * as vaultService from '../../server/vault/vault-service';

const routeMocks = vi.hoisted(() => ({
  adapter: {
    protocolName: 'pacifica',
    getMarkets: vi.fn(),
    getMarkPrice: vi.fn(),
    getPrice: vi.fn(),
    getAccountInfo: vi.fn(),
    getStrictPositionForMarket: vi.fn(),
    getCloseConfirmationSnapshot: vi.fn(),
    getPositions: vi.fn(),
    getTradeHistory: vi.fn(),
    getFeeRateQuote: vi.fn(),
    placeMarketOrder: vi.fn(),
    deposit: vi.fn(),
    transferBetweenSubaccounts: vi.fn(),
    closePosition: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  },
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(),
}));

vi.mock('../../server/storage', () => {
  const target: Record<string, ReturnType<typeof vi.fn>> = {};
  const storage = new Proxy(target, {
    get: (object, property: string | symbol) => {
      if (typeof property !== 'string') return undefined;
      if (property === 'then') return undefined;
      return (object[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId(input: { signature?: string }) { return `tx-${input.signature}`; }
  }
  return { storage, DatabaseStorage };
});

vi.mock('../../server/session', () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => { req.session = { walletAddress: 'wallet-close-authority-test' }; next(); },
}));

vi.mock('../../server/trading/close-intent-store', async () => {
  const { makeCloseRouteStore } = await import('../helpers/close-route-intent-store');
  const { storage } = await import('../../server/storage');
  return { closeIntentStore: { ...makeCloseRouteStore(storage), withEffects: async (_id: string, work: () => Promise<void>) => work() } };
});
import { closeIntentStore } from '../../server/trading/close-intent-store';
import { bridgePreparedClose } from '../helpers/close-route-intent-store';
import { dispatchConfirmedCloseEffects, dispatchPartialCloseEffects, registerPartialCloseFanout } from '../../server/trading/signal-bot-close-intent-effects';

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
  agentPrivateKeyEncryptedV3: 'EXAMPLE',
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


import type { CloseSnapshot } from '../../server/protocol/close-outcome';
import type { TradeRecord } from '../../server/protocol/protocol-types';
import * as marketLiquidity from '../../server/market-liquidity-service';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import { classifySignal } from '../../server/trading/signal-classifier';

function snapshot(account: string, sequence: number, size: number): CloseSnapshot {
  const now = Date.now();
  return { positions: size === 0 ? [] : [{ internalSymbol: 'BTC-PERP', baseSize: size, sizeBaseExact: String(size), entryPrice: 64000,
    markPrice: null, unrealizedPnl: null, leverage: 2, liquidationPrice: null, marginMode: 'cross' }],
    evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${sequence}`, startedAt: now,
      dispatchedAt: now, receivedAt: now, lastOrderId: sequence, complete: true, fresh: true, noDedup: true } };
}
function fill(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return { tradeId: 'EXAMPLE_FILL', orderId: '17', internalSymbol: 'BTC-PERP',
    side: 'short', price: 65000, size: 0.25, fee: 1, timestamp: Date.now(), ...overrides };
}
function prime(side: 'long' | 'short' = 'long', rows: () => TradeRecord[] = () => [fill()]) {
  vi.clearAllMocks();
  routeMocks.adapter.getStrictPositionForMarket.mockReset();
  routeMocks.adapter.getMarkets.mockReset();
  routeMocks.adapter.getMarkPrice.mockReset();
  routeMocks.adapter.getAccountInfo.mockReset();
  vi.mocked(storage.getPublishedBotByTradingBotId).mockReset();
  routeMocks.adapter.placeMarketOrder.mockReset();
  (closeIntentStore as any).reset(); bridgePreparedClose(routeMocks.adapter);
  routeMocks.adapter.getCapabilities.mockReturnValue({});
  const sign = side === 'long' ? 1 : -1;
  vi.mocked(storage.getTradingBotById).mockResolvedValue(routeBot as never);
  vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue({ id: 'EXAMPLE_LISTING', isActive: true } as never);
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([routeBot] as never);
  vi.mocked(storage.getTradingBotById).mockResolvedValue(routeBot as never);
  vi.mocked(storage.getWallet).mockResolvedValue(routeWallet as never);
  vi.mocked(storage.getBotPosition).mockResolvedValue({ baseSize: String(sign * 0.25), avgEntryPrice: '64000',
    market: 'BTC-PERP', lastTradeId: 'EXAMPLE_ENTRY' } as never);
  vi.mocked(storage.getBotTrades).mockResolvedValue([]);
  vi.mocked(storage.createBotTradeIdempotent).mockResolvedValue({ isNew: true, trade: { id: 'EXAMPLE_PENDING' } } as never);
  vi.mocked(storage.createBotTrade).mockResolvedValue({ id: 'EXAMPLE_PENDING', webhookPayload: {} } as never);
  vi.mocked(storage.recordCloseEventAtomic).mockResolvedValue({ isNew: true, trade: { id: 'EXAMPLE_PENDING' } } as never);
  vi.mocked(storage.getBotSubscriptionBySubscriberBotId).mockResolvedValue(undefined);
  vi.mocked(storage.remediateSubscriberCloseAccountingAtomic).mockResolvedValue({ remediated: false, trade: { id: 'EXAMPLE_RECONCILED' } } as never);
  routeMocks.getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: vi.fn() });
  routeMocks.decryptAgentKeyStrict.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
  routeMocks.decryptBotSubaccountKey.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
  routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue({ internalSymbol: 'BTC-PERP', baseSize: sign * 0.25, entryPrice: 64000 });
  routeMocks.adapter.getPositions.mockResolvedValue([{ internalSymbol: 'BTC-PERP', baseSize: sign * 0.25, entryPrice: 64000 }]);
  routeMocks.adapter.getTradeHistory.mockImplementation(async () => rows());
  routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: true, status: 'filled', orderId: '17', landingDisposition: 'terminal' });
  let seq = 0;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => snapshot(account, ++seq, !routeMocks.adapter.placeMarketOrder.mock.calls.length ? sign * 0.25 : 0));
}
type Signal = Parameters<typeof routeSignalToSubscribers>[1];
const entry: Signal = { originId: 'EXAMPLE_SIGNAL', action: 'buy', contracts: '0.25',
  positionSize: '0.25', price: '90000', isCloseSignal: false, strategyPositionSize: '0.25' };
const full: Signal = { ...entry, action: 'sell', contracts: '0', strategyPositionSize: '0', isCloseSignal: true };
const partial: Signal = { ...entry, action: 'sell', contracts: '0.125', strategyPositionSize: '0.125', partialCloseFraction: 0.5 };
const flip: Signal = { ...entry, action: 'sell', strategyPositionSize: '-0.25', isFlipSignal: true };
function listing(isActive: boolean) {
  vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue({ id: 'EXAMPLE_LISTING', isActive } as never);
}
async function route(signal: Signal) { await routeSignalToSubscribers('EXAMPLE_SOURCE', signal); }
function expectOnlyReducingOrders(count = 1) {
  expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledTimes(count);
  for (const [order] of routeMocks.adapter.placeMarketOrder.mock.calls) expect(order).toMatchObject({ reduceOnly: true });
}
function primeFlip() {
  prime();
  routeMocks.adapter.getStrictPositionForMarket
    .mockResolvedValueOnce({ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 })
    .mockResolvedValue(null);
}

let server: Server | undefined;
let baseUrl: string;
beforeAll(async () => {
  vi.stubEnv('ADMIN_PASSWORD', ROUTE_ADMIN_PASSWORD);
  const app = express(); app.use(express.json());
  server = await registerRoutes(createServer(app), app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server!.close(() => resolve()));
});
it('describes inactive listing close routing in the admin dry run without blocking diagnostics', async () => {
  prime(); listing(false);
  const response = await fetch(`${baseUrl}/api/admin/test-routing/EXAMPLE_SOURCE`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ROUTE_ADMIN_PASSWORD}` },
    body: JSON.stringify({ dryRun: true }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, step: 'complete', publishedBotActive: false,
    listingStatus: 'new entries blocked; closes still route', totalSubscribers: 1 });
  expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
});
it('does not claim subscribers were routed when a paused webhook has no subscribers', async () => {
  prime();
  vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, isActive: false } as never);
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([]);
  vi.mocked(storage.createWebhookLog).mockResolvedValue({ id: 'EXAMPLE_WEBHOOK' } as never);
  const response = await fetch(`${baseUrl}/api/webhook/tradingview/${ROUTE_BOT_ID}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: ROUTE_TV_SECRET, action: 'buy', contracts: '0.25', position_size: '0.5' }),
  });
  expect(response.status).toBe(400);
  expect(storage.updateWebhookLog).toHaveBeenCalledWith('EXAMPLE_WEBHOOK',
    { errorMessage: 'Bot is paused (subscriber routing requested)' });
  expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
});
it('refuses subscribing to an unpublished listing before creating a bot or subscription', async () => {
  prime();
  vi.mocked(storage.getPublishedBotById).mockResolvedValue({ id: 'EXAMPLE_LISTING', isActive: false } as never);
  const response = await fetch(`${baseUrl}/api/marketplace/EXAMPLE_LISTING/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capitalInvested: 100, leverage: 2 }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'This bot is no longer available' });
  expect(storage.createTradingBot).not.toHaveBeenCalled();
  expect(storage.createBotSubscription).not.toHaveBeenCalled();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function primeRiskSizing() {
  routeMocks.adapter.getPrice.mockResolvedValue(1000);
  routeMocks.adapter.getAccountInfo.mockResolvedValue({ balance: 1000, equity: 1000, availableMargin: 1000, maintenanceMargin: 0, unrealizedPnl: 0 });
  routeMocks.adapter.getMarkets.mockImplementation(async () => [{ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC',
    maxLeverage: 10, maxLeverageSource: 'venue',
    tickSize: 1, lotSize: 0.001, minOrderSizeBase: 0.001, minOrderSizeUsd: 10,
    constraintObservation: observePacificaConstraints({ tick_size: '1', lot_size: '0.001', min_order_size: '10' }, 'BTC-PERP', Date.now()) }]);
  routeMocks.adapter.getMarkPrice.mockImplementation(async () => { const now = Date.now(); return {
    kind: 'available', venue: 'pacifica', internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', source: '/info/prices', field: 'mark',
    exact: '1000', observedAt: now, receivedAt: now, expiresAt: now + 5000 }; });
  routeMocks.adapter.getFeeRateQuote.mockImplementation(async (request: { account: string; subaccountId: string | null }) => ({
    availability: 'available', protocol: 'pacifica', account: request.account, subaccountId: request.subaccountId,
    liquidityRole: 'taker', baseRate: 0.001, effectiveRate: 0.001, provenance: 'pacifica:/account:taker_fee',
    observedAt: Date.now(), builder: { status: 'absent' },
  }));
  return vi.spyOn(marketLiquidity, 'getMarketMaxLeverageWithSource').mockReturnValue({ maxLeverage: 10, maxLeverageSource: 'venue' } as never);
}
async function barrier(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('EXAMPLE_BARRIER_NOT_REACHED')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
it('round9 real registered durable router leaves delivery pending on subscription lookup failure and retries', async () => {
  prime('long', () => [fill({ size: 0.125 })]);
  let sequence = 0;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) =>
    snapshot(account, ++sequence, routeMocks.adapter.placeMarketOrder.mock.calls.length ? 0.125 : 0.25));
  const store = closeIntentStore as any;
  const scope = { environment: 'EXAMPLE', account: 'EXAMPLE_SOURCE_ACCOUNT', market: routeBot.market };
  const { intent } = await store.create(scope, { bot_id: 'EXAMPLE_SOURCE', environment: scope.environment,
    original_account: scope.account, market: scope.market, close_kind: 'partial', position_side: 'long',
    requested_size_base: '2', original_position_size_base: '4', authority_ref: {} }, {});
  const confirmed = await store.settle(scope, intent, { status: 'confirmed',
    last_evidence: { effectsPending: true, parkingDelivered: true } });
  vi.mocked(storage.getSubscriberBotsBySourceId).mockRejectedValueOnce(new Error('EXAMPLE_SUBSCRIPTION_LOOKUP_FAILED'));
  await expect(dispatchPartialCloseEffects(confirmed)).rejects.toThrow('EXAMPLE_SUBSCRIPTION_LOOKUP_FAILED');
  expect((await store.byId(scope, confirmed.id)).last_evidence).toMatchObject({ effectsPending: true });
  expect((await store.byId(scope, confirmed.id)).last_evidence).not.toHaveProperty('fanoutDelivered');
  expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  await dispatchPartialCloseEffects(confirmed);
  expectOnlyReducingOrders();
  expect((await store.byId(scope, confirmed.id)).last_evidence).toMatchObject({ fanoutDelivered: true, effectsPending: false });
  expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled();
});

describe('round9 active parity and refused admission', () => {
  it.each([1, 1.1, 0, -0.5, NaN, Infinity])('refuses base invalid partial fraction %s without the close bit', async fraction => {
    prime(); await route({ ...partial, partialCloseFraction: fraction });
    expect(storage.getSubscriberBotsBySourceId).not.toHaveBeenCalled();
    expect(storage.getWallet).not.toHaveBeenCalled();
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('retains the base full-close bit precedence over an invalid fraction', async () => {
    prime(); await route({ ...full, partialCloseFraction: 0 }); expectOnlyReducingOrders();
    expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled();
  });
  it.each([true, false])('safety paused explicit partial reduces with listing active=%s', async active => {
    prime(); primePartial(); listing(active);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
    await route(partial); expectOnlyReducingOrders();
    expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.125);
    expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled();
    expectNoOpeningWork();
  });
  it('retains paused subscriber full-close authority', async () => {
    prime(); vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
    await route(full); expectOnlyReducingOrders();
  });
  it.each(['active', 'unpublished', 'unreadable'] as const)('explicit full and partial never read a %s listing', async state => {
    for (const signal of [full, partial]) {
      prime(); primePartial(signal === full ? 1 : 0.5);
      listing(state === 'active');
      if (state === 'unreadable') vi.mocked(storage.getPublishedBotByTradingBotId).mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
      await route(signal); expectOnlyReducingOrders();
      expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(signal === full ? 0.25 : 0.125);
    }
  });
  it.each(['entry', 'pyramid'] as const)('refused %s performs no wallet, sizing or funding work', async kind => {
    prime(); listing(false);
    if (kind === 'entry') vi.mocked(storage.getBotPosition).mockResolvedValue(undefined);
    const unpark = vi.spyOn(vaultService, 'unparkToUsdc');
    try {
      await route(entry);
      expect(storage.getWallet).not.toHaveBeenCalled();
      expect(routeMocks.adapter.getAccountInfo).not.toHaveBeenCalled();
      expect(routeMocks.adapter.getMarkPrice).not.toHaveBeenCalled();
      expect(unpark).not.toHaveBeenCalled();
      expect(routeMocks.adapter.deposit).not.toHaveBeenCalled();
      expect(routeMocks.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
    } finally { unpark.mockRestore(); }
  });
  it('logs the unavailable reason for an entry before wallet or sizing', async () => {
    prime(); vi.mocked(storage.getPublishedBotByTradingBotId).mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    const log = vi.spyOn(console, 'log');
    try {
      await route(entry);
      expect(log.mock.calls.flat().join(' ')).toContain('New exposure refused: Source listing state unavailable');
      expect(storage.getWallet).not.toHaveBeenCalled(); expect(routeMocks.adapter.getAccountInfo).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it.each(['unpublished', 'unreadable'] as const)('flip without hint closes fully and records %s reopen refusal', async state => {
    primeFlip(); listing(false);
    if (state === 'unreadable') vi.mocked(storage.getPublishedBotByTradingBotId).mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    await route(flip); expectOnlyReducingOrders();
    expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.25);
    expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
    expect(storage.createBotTrade).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: state === 'unpublished' ? 'Source bot is unpublished' : 'Source listing state unavailable',
      webhookPayload: expect.objectContaining({ reversal: expect.objectContaining({ close: expect.objectContaining({ kind: 'executed' }), open: expect.objectContaining({ kind: 'rejected' }) }) }) }));
  });
  it('active flip reads once before its close and reopens even if unpublish commits during close', async () => {
    primeFlip(); const leverage = primeRiskSizing();
    routeMocks.adapter.placeMarketOrder.mockImplementation(async order => {
      if (order.reduceOnly) {
        expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce(); listing(false);
      }
      return { success: true, status: 'filled', orderId: '17', landingDisposition: 'terminal' };
    });
    try {
      await route({ ...flip, reduceOnlyIfRefused: { fraction: 0.5 } });
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledTimes(2);
      expect(routeMocks.adapter.placeMarketOrder.mock.calls.map(([o]) => o.reduceOnly)).toEqual([true, false]);
      expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.25);
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
    } finally { leverage.mockRestore(); }
  });
  it.each([1, 1.1, 0, -1, NaN, Infinity])('normalizes refused hint fraction %s independently of the base fraction guard', async fraction => {
    primeFlip(); listing(false);
    await route({ ...flip, reduceOnlyIfRefused: { fraction } }); expectOnlyReducingOrders();
    expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.25);
  });
  it('does not use subscriber classifier fraction to size a source flip close', async () => {
    prime('long', () => [fill({ size: 4 })]); listing(false);
    vi.mocked(storage.getBotPosition).mockResolvedValue({ baseSize: '4', avgEntryPrice: '64000' } as never);
    routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue({ internalSymbol: 'BTC-PERP', baseSize: 4, entryPrice: 64000 });
    routeMocks.adapter.getPositions.mockResolvedValue([{ internalSymbol: 'BTC-PERP', baseSize: 4, entryPrice: 64000 }]);
    let sequence = 0; routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => snapshot(account, ++sequence, routeMocks.adapter.placeMarketOrder.mock.calls.length ? 0 : 4));
    await route({ ...flip, contracts: '2', strategyPositionSize: null }); expectOnlyReducingOrders();
    expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(4);
  });
  it('same-side subscriber is untouched by a full reducing hint', async () => {
    prime('short'); listing(false); await route({ ...flip, reduceOnlyIfRefused: 'full' });
    expect(storage.getWallet).not.toHaveBeenCalled(); expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('Phoenix is skipped before position, listing or wallet reads', async () => {
    prime(); vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, activeProtocol: 'phoenix' } as never);
    await route(entry); expect(storage.getBotPosition).not.toHaveBeenCalled();
    expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled(); expect(storage.getWallet).not.toHaveBeenCalled();
  });
  it('no subscribers returns without listing or order work', async () => {
    prime(); vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([]); await route(full);
    expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled(); expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('logs executed closes with bot ids only', async () => {
    prime(); const log = vi.spyOn(console, 'log');
    try { await route(full); expect(log.mock.calls.filter(([line]) => String(line).includes('Close routed:'))).toEqual([[`[Subscriber Routing] Close routed: sourceBotId=EXAMPLE_SOURCE subscriberBotId=${routeBot.id}`]]); }
    finally { log.mockRestore(); }
  });
});

const earlySourceKey = Keypair.generate().publicKey.toBase58();
function primePartial(fraction = 0.5) {
  routeMocks.adapter.getTradeHistory.mockResolvedValue([fill({ size: 0.25 * fraction })]);
  vi.mocked(storage.updatePendingBotTrade).mockImplementation(async (_id, fields) => ({ id: 'EXAMPLE_PENDING', ...fields }) as never);
  let sequence = 0;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => snapshot(account, ++sequence, account === earlySourceKey ? 0 : routeMocks.adapter.placeMarketOrder.mock.calls.length ? 0.25 * (1 - fraction) : 0.25));
  routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async account => account === earlySourceKey ? null : ({ internalSymbol: 'BTC-PERP', baseSize: routeMocks.adapter.placeMarketOrder.mock.calls.length ? 0.25 * (1 - fraction) : 0.25, entryPrice: 64000 }));
}
type Early = 'paused-tv' | 'disabled-tv' | 'expired-tv' | 'paused-user';
function primeEarly(path: Early, active: boolean, sourceReadFails = false) {
  const source = { ...routeBot, id: 'EXAMPLE_SOURCE', protocolSubaccountId: earlySourceKey, isActive: path !== 'paused-tv' && path !== 'paused-user' };
  const wallet = { ...routeWallet, executionEnabled: path !== 'disabled-tv', executionExpiresAt: path === 'expired-tv' ? new Date(0) : null };
  vi.mocked(storage.getWallet).mockResolvedValue(wallet as never);
  vi.mocked(storage.getTradingBotById).mockImplementation(async id => {
    if (id === source.id) return source as never;
    vi.mocked(storage.getWallet).mockResolvedValue(routeWallet as never); return routeBot as never;
  });
  vi.mocked(storage.getBotPosition).mockImplementation(async id => {
    // These cases isolate subscriber routing when the source has no position authority.
    if (id === source.id && (sourceReadFails || path === 'paused-tv' || path === 'paused-user')) throw new Error('EXAMPLE_SOURCE_READ_FAILED');
    return { baseSize: '0.25', avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY' } as never;
  });
  vi.mocked(storage.createWebhookLog).mockResolvedValue({ id: 'EXAMPLE_WEBHOOK' } as never); listing(active);
  return source;
}
async function earlyWebhook(path: Early, payload: Record<string, unknown>) {
  const user = path === 'paused-user';
  return fetch(baseUrl + (user ? '/api/webhook/user/' + ROUTE_WALLET : '/api/webhook/tradingview/EXAMPLE_SOURCE'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: 'EXAMPLE_SOURCE', secret: user ? ROUTE_USER_SECRET : ROUTE_TV_SECRET, ...payload }),
  });
}
async function audited(work: () => Promise<unknown>) {
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const result = await work();
    await vi.waitFor(() => {
      if (!log.mock.calls.some(([line]) => String(line).includes('[Subscriber Routing] AUDIT:'))) {
        throw new Error('Routing incomplete: ' + JSON.stringify({ status: (result as Response)?.status,
          logs: log.mock.calls.slice(-8), errors: error.mock.calls.slice(-3) }));
      }
    }, { timeout: 5000 });
    return result;
  } finally { log.mockRestore(); error.mockRestore(); }
}
describe('subscriber close safety early paths', () => {
  it.each(['paused-tv', 'disabled-tv', 'expired-tv', 'paused-user'] as const)('safety %s active legacy reductions use source fraction and full size', async path => {
    for (const fraction of [0.5, 1]) {
      prime(); primeEarly(path, true); primePartial(fraction);
      // A different source size proves sizing uses the subscriber position, not source contracts.
      vi.mocked(storage.getBotPosition).mockImplementation(async id => {
        if (id === 'EXAMPLE_SOURCE' && (path === 'paused-tv' || path === 'paused-user')) throw new Error('EXAMPLE_SOURCE_READ_FAILED');
        return { baseSize: id === 'EXAMPLE_SOURCE' ? '0.5' : '0.25', avgEntryPrice: '60000' } as never;
      });
      const unpark = vi.spyOn(vaultService, 'unparkToUsdc');
      try {
        const response = await audited(() => earlyWebhook(path, { message: `order sell @ ${0.5 * fraction} filled on BTC. New strategy position is ${0.5 * (1 - fraction)}` })) as Response;
        if (fraction === 1 && (path === 'paused-tv' || path === 'paused-user')) expect(response.status).toBe(500);
        expectOnlyReducingOrders();
        expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.25 * fraction);
        expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
        expectNoOpeningWork(); expect(unpark).not.toHaveBeenCalled();
        expect(storage.createBotTrade).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
      } finally { unpark.mockRestore(); }
    }
  });
  it.each(['paused-tv', 'disabled-tv', 'expired-tv', 'paused-user'] as const)('%s active entry retains the live opening order', async path => {
    prime(); primeEarly(path, true); const leverage = primeRiskSizing();
    try {
      await audited(() => earlyWebhook(path, { action: 'buy', contracts: '0.25', position_size: '0.5', price: '1000' }));
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
      expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0]).toMatchObject({ reduceOnly: false, side: 'long' });
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
    } finally { leverage.mockRestore(); }
  });
  it.each(['paused-tv', 'disabled-tv', 'expired-tv', 'paused-user'] as const)('%s inferred legacy partial takes precedence over subscriber FLIP when refused', async path => {
    prime(); primeEarly(path, false); primePartial();
    await audited(() => earlyWebhook(path, { message: 'order sell @ 0.125 filled on BTC. New strategy position is 0.125' }));
    expectOnlyReducingOrders(); expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.125);
    expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
    expect(storage.createBotTrade).not.toHaveBeenCalledWith(expect.objectContaining({ errorMessage: 'Source bot is unpublished' }));
  });
  it.each(['full', 'flip', 'missing-source-partial'] as const)('inferred %s executes the source proportion on a failed listing read', async kind => {
    primeFlip(); primeEarly('paused-tv', false, true);
    if (kind === 'missing-source-partial') primePartial();
    vi.mocked(storage.getPublishedBotByTradingBotId).mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    const target = kind === 'full' ? '0' : kind === 'flip' ? '-0.25' : '0.125';
    const contracts = kind === 'flip' ? '0.5' : kind === 'full' ? '0.25' : '0.125';
    const response = await audited(() => earlyWebhook('paused-tv', { message: `order sell @ ${contracts} filled on BTC. New strategy position is ${target}` })) as Response;
    if (kind === 'full') expect(response.status).toBe(500);
    expectOnlyReducingOrders(); expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(kind === 'missing-source-partial' ? 0.125 : 0.25);
  });
});

describe('round9 sequential point-in-time window', () => {
  it.each([false, true])('second subscriber waits for first completion; unpublish during first entry=%s', async unpublish => {
    prime(); vi.mocked(storage.getBotPosition).mockResolvedValue(undefined);
    const leverage = primeRiskSizing(), entered = deferred(), release = deferred();
    const second = { ...routeBot, id: 'EXAMPLE_SECOND' };
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([routeBot, second] as never);
    routeMocks.adapter.placeMarketOrder.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { success: true, status: 'filled', orderId: 'EXAMPLE_FIRST', landingDisposition: 'terminal' }; });
    let advance: (() => void) | undefined;
    const stagger = deferred(); const nativeTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 2000) { advance = callback; stagger.resolve(); return 0 as never; }
      return nativeTimeout(callback, ms, ...args);
    }) as typeof setTimeout);
    const routing = route(entry);
    try {
      await barrier(entered.promise);
      expect(storage.getTradingBotById).not.toHaveBeenCalledWith(second.id);
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
      if (unpublish) listing(false);
      release.resolve(); await barrier(stagger.promise); advance!(); await routing;
      expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledTimes(unpublish ? 1 : 2);
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledTimes(2);
      // Each admitted entry reloads wallet authority after acquiring its bot lock.
      expect(storage.getWallet).toHaveBeenCalledTimes(unpublish ? 2 : 4);
      expect(routeMocks.adapter.getAccountInfo).toHaveBeenCalledTimes(unpublish ? 1 : 2);
    } finally { release.resolve(); advance?.(); await routing; timer.mockRestore(); leverage.mockRestore(); }
  });
});

describe('round9 durable lookup boundary', () => {
  it('post-lookup subscriber failure resolves and marks fanout delivered', async () => {
    prime(); const intent = await partialIntent();
    vi.mocked(storage.getTradingBotById).mockImplementation(async id => {
      if (id === ROUTE_BOT_ID) throw new Error('EXAMPLE_SUBSCRIBER_FAILED'); return routeBot as never;
    });
    await expect(dispatchPartialCloseEffects(intent)).resolves.toBeUndefined();
    expect((await (closeIntentStore as any).byId(intent, intent.id)).last_evidence).toMatchObject({ fanoutDelivered: true, effectsPending: false });
  });
  it('webhook lookup failure resolves under the base outer catch', async () => {
    prime(); primeEarly('paused-tv', true);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockRejectedValueOnce(new Error('EXAMPLE_LOOKUP_FAILED'));
    const error = vi.spyOn(console, 'error');
    try {
      const response = await earlyWebhook('paused-tv', { action: 'buy', position_size: '0.5', contracts: '0.25' });
      expect(response.status).toBe(400);
      await vi.waitFor(() => expect(error.mock.calls.some(([line]) => line === '[Subscriber Routing] Error:')).toBe(true));
      await expect(route(full)).resolves.toBeUndefined();
    } finally { error.mockRestore(); }
  });
});
describe('SEC02-DISCRIMINATING-SERVER user webhook authentication', () => {
  it.each(['unknown-wallet', 'known-bot', 'unknown-bot', 'foreign-bot', 'retired-bot', 'null-secret'] as const)(
    'returns identical 401 without a bot lookup for %s', async scenario => {
      prime();
      if (scenario === 'unknown-wallet') vi.mocked(storage.getWallet).mockResolvedValue(undefined);
      if (scenario === 'null-secret') vi.mocked(storage.getWallet).mockResolvedValue({ ...routeWallet, userWebhookSecret: null } as never);
      if (scenario === 'unknown-bot') vi.mocked(storage.getTradingBotById).mockResolvedValue(undefined);
      if (scenario === 'foreign-bot') vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, walletAddress: 'EXAMPLE_OTHER' } as never);
      if (scenario === 'retired-bot') vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, activeProtocol: 'flash' } as never);
      // The wallet read itself observes the boundary, not merely the response.
      vi.mocked(storage.getWallet).mockImplementationOnce(async () => {
        expect(storage.getTradingBotById).not.toHaveBeenCalled();
        return (scenario === 'unknown-wallet' ? undefined : { ...routeWallet,
          userWebhookSecret: scenario === 'null-secret' ? null : ROUTE_USER_SECRET }) as never;
      });
      const response = await fetch(`${baseUrl}/api/webhook/user/${ROUTE_WALLET}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: ROUTE_BOT_ID, secret: 'EXAMPLE_WRONG' }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid secret' });
      expect(storage.getTradingBotById).not.toHaveBeenCalled();
      expect(storage.createWebhookLog).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
    });
});
describe('SEC02-PRESERVATION authenticated webhook errors', () => {
  it.each(['missing', 'foreign'] as const)('retains the valid-secret %s bot response', async scenario => {
    prime();
    vi.mocked(storage.getTradingBotById).mockResolvedValue(scenario === 'missing' ? undefined : { ...routeBot, walletAddress: 'EXAMPLE_OTHER' } as never);
    const response = await fetch(`${baseUrl}/api/webhook/user/${ROUTE_WALLET}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: ROUTE_BOT_ID, secret: ROUTE_USER_SECRET }),
    });
    expect(response.status).toBe(scenario === 'missing' ? 404 : 403);
    expect(await response.json()).toEqual({ error: scenario === 'missing' ? 'Bot not found' : 'Bot does not belong to this wallet' });
    expect(storage.createWebhookLog).not.toHaveBeenCalled();
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('keeps Missing botId first', async () => {
    prime();
    const response = await fetch(`${baseUrl}/api/webhook/user/${ROUTE_WALLET}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'EXAMPLE_WRONG' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing botId in payload' });
    expect(storage.getWallet).not.toHaveBeenCalled();
    expect(storage.getTradingBotById).not.toHaveBeenCalled();
  });
});
it('SEC02-PRESERVATION valid-secret user close retains response fields and closes source and subscriber', async () => {
  prime();
  const source = { ...routeBot, id: 'EXAMPLE_SOURCE', protocolSubaccountId: Keypair.generate().publicKey.toBase58() };
  vi.mocked(storage.getTradingBotById).mockImplementation(async id => (id === source.id ? source : routeBot) as never);
  // Source and subscriber have independent close truth, even after the first order fills.
  let sequence = 0;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => snapshot(account, ++sequence,
    routeMocks.adapter.placeMarketOrder.mock.calls.some(([order]) => order.agentPublicKey === account) ? 0 : 0.25));
  vi.mocked(storage.createWebhookLog).mockResolvedValue({ id: 'EXAMPLE_WEBHOOK' } as never);
  const response = await earlyWebhook('paused-user', { message: 'order sell @ 0.25 filled on BTC. New strategy position is 0' });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ status: 'success', type: 'close', closedSize: 0.25 });
  await vi.waitFor(() => expect(storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({ botId: routeBot.id })));
  expectOnlyReducingOrders(2);
  expect(routeMocks.adapter.placeMarketOrder.mock.calls.map(([order]) => order.sizeBase)).toEqual([0.25, 0.25]);
  expect(storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({ botId: source.id }));
  expectNoOpeningWork();
  expect(storage.getPublishedBotByTradingBotId).not.toHaveBeenCalled();
});
it('user legacy nonzero entry retains the live source order', async () => {
  prime(); const leverage = primeRiskSizing();
  vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, id: 'EXAMPLE_SOURCE' } as never);
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([]);
  vi.mocked(storage.createWebhookLog).mockResolvedValue({ id: 'EXAMPLE_WEBHOOK' } as never);
  try {
    const response = await earlyWebhook('paused-user', { message: 'order buy @ 0.25 filled on BTC. New strategy position is 0.5' });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
    expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
    expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0]).toMatchObject({ reduceOnly: false, side: 'long' });
  } finally { leverage.mockRestore(); }
});
it('user legacy nonzero crossing target preserves the live partial instead of enabling a flip', async () => {
  prime(); primePartial();
  vi.mocked(storage.getTradingBotById).mockResolvedValue({ ...routeBot, id: 'EXAMPLE_SOURCE' } as never);
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([]);
  vi.mocked(storage.createWebhookLog).mockResolvedValue({ id: 'EXAMPLE_WEBHOOK' } as never);
  const response = await earlyWebhook('paused-user', { message: 'order sell @ 0.125 filled on BTC. New strategy position is -0.125' });
  const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
  expectOnlyReducingOrders(); expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.125);
  expectNoOpeningWork();
});
async function partialIntent() {
  const store = closeIntentStore as any;
  const scope = { environment: 'EXAMPLE', account: 'EXAMPLE_SOURCE_ACCOUNT', market: routeBot.market };
  const { intent } = await store.create(scope, { bot_id: 'EXAMPLE_SOURCE', environment: scope.environment, original_account: scope.account,
    market: scope.market, close_kind: 'partial', position_side: 'long', requested_size_base: '2', original_position_size_base: '4', authority_ref: {} }, {});
  return store.settle(scope, intent, { status: 'confirmed', last_evidence: { effectsPending: true, parkingDelivered: true } });
}

it('round9 restores exact base DELETE, sequential loop, guards and shallow early fields without deleted APIs or caller gates', () => {
  const text = readFileSync('server/routes.ts', 'utf8');
  // Exact base spans verified first-hand at baseCommitHash: eae0635bae38d24bbcf6a5de26333ac362481c3e.
  // Sealed prefreeze trees intentionally do not expose Git object history.
  const baseSha256 = {
    "deleteSha256": "ab5f18e447fc1e3d8096d7c8af82dc88a2ce776f257d42505e497df0188701bb",
    "loopSha256": "2fd85f12e0fbebe1238c65efc44b59a8e7531fd23fcdb4315685984fef92d18d",
    "guardSha256": "6db61326ce0a6c61979be8e2e298d46595b5f41a973500a28465ceb48d7d8418",
    "parserSha256": "278149399c8d012698a9295508184b8e8747d05e932a584d8ef529d5fbc208d6"
  };
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const span = (s: string, a: string, b: string) => { const start = s.indexOf(a); return s.slice(start, s.indexOf(b, start + a.length)); };
  const deletion = '  app.delete("/api/marketplace/:id",';
  expect(sha256(span(text, deletion, '\n  app.'))).toBe(baseSha256.deleteSha256);
  expect(sha256(span(text, '    const SUBSCRIBER_STAGGER_MS', '\n    const elapsed'))).toBe(baseSha256.loopSha256);
  expect(sha256(span(text, '  if (!signal.isCloseSignal && signal.partialCloseFraction', '\n  try {'))).toBe(baseSha256.guardSha256);
  for (const symbol of ['marketplaceAdmissionFences', 'marketplaceAdmissionFence', 'retireMarketplaceFence', 'beginMarketplaceEntry', 'waitForMarketplaceEntries', 'entryReserved', 'routeSignalToSubscribersBestEffort', 'subscriberFullClose', 'sourceFlipReduction', 'requestedPartialCloseFraction', 'subscriberPartialCloseFraction']) expect(text).not.toContain(symbol);
  const source = ts.createSourceFile('routes.ts', text, ts.ScriptTarget.Latest, true);
  const bare: string[] = []; const early: string[][] = [];
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && /(?:botPublishedInfo|botPubInfo|publishedFlipSource|pcPublished)\??\.isActive/.test(node.expression.getText(source))) bare.push(node.expression.getText(source));
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'routeSignalToSubscribers' && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
      const fields = node.arguments[1].properties.map(p => p.getText(source));
      if (fields.some(f => f.includes('routingSignal.action'))) early.push(fields);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); expect(bare).toEqual([]); expect(early).toHaveLength(4);
  for (const [index, fields] of early.entries()) {
    expect(fields).toEqual(['originId: log.id', "action: routingSignal.action as 'buy' | 'sell'", 'contracts: routingSignal.contracts', index === 3 ? 'positionSize' : 'positionSize: routingSignal.contracts', 'price: routingSignal.price', 'isCloseSignal: routingSignal.isCloseSignal', 'strategyPositionSize: routingSignal.strategyPositionSize', 'reduceOnlyIfRefused: routingSignal.reduceOnlyIfRefused', 'sourceNotTrading: true']);
  }
  const parse = span(text, 'function parseSignalForRouting(', '\ninterface SignalBotFlipAuthorityContext');
  expect(sha256(span(parse, '  let action', '  // Classification'))).toBe(baseSha256.parserSha256);
  const fanout = span(text, 'export async function routeSignalToSubscribers(', 'export async function registerRoutes(');
  expect((fanout.match(/readMarketplaceOpenAdmission\(sourceBotId\)/g) || [])).toHaveLength(1);
  expect(fanout.indexOf('readMarketplaceOpenAdmission(sourceBotId)')).toBeLessThan(fanout.indexOf('const subWallet'));
  expect(fanout.slice(fanout.indexOf('computeTradeSizingAndTopUp('))).not.toMatch(/readMarketplaceOpenAdmission|getPublishedBotByTradingBotId/);
  expect(fanout).not.toContain('subscriberClassified.closedFraction');
  const user = span(text, '  app.post("/api/webhook/user/:walletAddress"', '\n  app.');
  expect(user).toContain('if (parseFloat(match[4]) === 0) strategyPositionSize = match[4]');
  expect(user).toContain("reduceOnlyIfRefused: uwClassified.type === 'FULL_CLOSE' ? 'full' : undefined");
});

function expectNoOpeningWork() {
  expect(routeMocks.adapter.getAccountInfo).not.toHaveBeenCalled();
  expect(routeMocks.adapter.getMarkPrice).not.toHaveBeenCalled();
  expect(routeMocks.adapter.getMarkets).not.toHaveBeenCalled();
  expect(routeMocks.adapter.deposit).not.toHaveBeenCalled();
  expect(routeMocks.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
}
describe('subscriber close safety paused and hint boundaries', () => {
  it.each(['active', 'unpublished', 'unreadable'] as const)('safety paused hint reductions on %s listing never open or record a phantom flip', async state => {
    for (const fraction of [0.5, 1]) {
      prime(); primePartial(fraction); listing(state === 'active');
      if (state === 'unreadable') vi.mocked(storage.getPublishedBotByTradingBotId).mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
      vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
      await route({ ...entry, action: 'sell', contracts: '0', strategyPositionSize: null, sourceNotTrading: true,
        reduceOnlyIfRefused: fraction === 1 ? 'full' : { fraction } });
      expectOnlyReducingOrders(); expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.25 * fraction);
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce(); expectNoOpeningWork();
      expect(storage.createBotTrade).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    }
  });
  it.each(['entry', 'pyramid'] as const)('paused %s with an unusable hint never reaches wallet or opening work', async kind => {
    prime();
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
    if (kind === 'entry') vi.mocked(storage.getBotPosition).mockResolvedValue(undefined);
    await route({ ...entry, sourceNotTrading: true, reduceOnlyIfRefused: { fraction: 0.5 } });
    expect(storage.getWallet).not.toHaveBeenCalled(); expectNoOpeningWork();
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('safety marked refused full hint suppresses phantom reopen but a genuine flip keeps refusal', async () => {
    prime(); listing(false);
    await route({ ...entry, action: 'sell', contracts: '0', strategyPositionSize: null, sourceNotTrading: true, reduceOnlyIfRefused: 'full' });
    expectOnlyReducingOrders();
    expect(storage.createBotTrade).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    primeFlip(); listing(false);
    await route({ ...flip, sourceNotTrading: true, reduceOnlyIfRefused: 'full' });
    expectOnlyReducingOrders(); expectNoOpeningWork();
    expect(storage.createBotTrade).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorMessage: 'Source bot is unpublished' }));
  });
  it('paused genuine flip closes and refuses the reopen on an active listing', async () => {
    primeFlip(); vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
    await route(flip); expectOnlyReducingOrders(); expectNoOpeningWork();
    expect(storage.createBotTrade).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorMessage: 'Bot is paused' }));
  });
  it('paused refused unmarked partial hint converts without reaching the open path', async () => {
    prime(); primePartial(); listing(false);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
    await route({ ...partial, partialCloseFraction: undefined, reduceOnlyIfRefused: { fraction: 0.5 } });
    expectOnlyReducingOrders(); expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.125); expectNoOpeningWork();
  });
  it('unmarked active and marked hintless signals retain live behavior', async () => {
    for (const change of [{ reduceOnlyIfRefused: { fraction: 0.5 } }, { sourceNotTrading: true }]) {
      prime(); const leverage = primeRiskSizing();
      try {
        await route({ ...partial, partialCloseFraction: undefined, ...change });
        expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
        expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].reduceOnly).toBe(false);
        expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
      } finally { leverage.mockRestore(); }
    }
  });
  it('round3 reduction same-side full hint skips sizing and funding', async () => {
    prime(); const leverage = primeRiskSizing();
    try {
      await route({ ...partial, partialCloseFraction: undefined, sourceNotTrading: true, reduceOnlyIfRefused: 'full', action: 'buy' });
      expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
      expect(storage.getWallet).not.toHaveBeenCalled();
      expect(leverage).not.toHaveBeenCalled();
      expect(routeMocks.adapter.deposit).not.toHaveBeenCalled();
      expect(routeMocks.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    } finally { leverage.mockRestore(); }
  });
  it('round3 reduction invalid fraction never falls through to entry sizing', async () => {
    prime(); const leverage = primeRiskSizing();
    try {
      await route({ ...partial, partialCloseFraction: undefined, sourceNotTrading: true, reduceOnlyIfRefused: { fraction: NaN } });
      expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
      expect(storage.getWallet).not.toHaveBeenCalled();
      expect(leverage).not.toHaveBeenCalled();
    } finally { leverage.mockRestore(); }
  });
});


describe('subscriber close safety round2', () => {
  it.each([false, true])('round2 paused source flip hint with subscriber partial classification and listing active=%s', async active => {
    prime('long', () => [fill({ size: 1 })]); listing(active);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([{ ...routeBot, isActive: false }] as never);
    vi.mocked(storage.getBotPosition).mockResolvedValue({ baseSize: '1', avgEntryPrice: '64000' } as never);
    routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue({ internalSymbol: 'BTC-PERP', baseSize: 1, entryPrice: 64000 });
    routeMocks.adapter.getPositions.mockResolvedValue([{ internalSymbol: 'BTC-PERP', baseSize: 1, entryPrice: 64000 }]);
    let sequence = 0;
    routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => snapshot(account, ++sequence,
      routeMocks.adapter.placeMarketOrder.mock.calls.length ? 0 : 1));
    const signal = { ...flip, strategyPositionSize: null, contracts: '0.125' };
    expect(classifySignal({ side: 'LONG', size: 1, entryPrice: 64000 },
      { action: signal.action, contracts: 0.125, strategyPositionSize: null }).type).toBe('PARTIAL_CLOSE');
    const unpark = vi.spyOn(vaultService, 'unparkToUsdc');
    try {
      await route(signal);
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
      if (active) {
        expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
        expect(storage.getWallet).not.toHaveBeenCalled();
      } else {
        expectOnlyReducingOrders();
        expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(1);
      }
      expectNoOpeningWork(); expect(unpark).not.toHaveBeenCalled();
    } finally { unpark.mockRestore(); }
  });
  it('round2 marked early flip on active listing logs the skipped subscriber reopen without an extra trade row', async () => {
    prime(); primeEarly('paused-tv', true);
    const log = vi.spyOn(console, 'log');
    const unpark = vi.spyOn(vaultService, 'unparkToUsdc');
    try {
      await earlyWebhook('paused-tv', { message: 'order sell @ 0.5 filled on BTC. New strategy position is -0.25' });
      await vi.waitFor(() => expect(log.mock.calls.some(([line]) => String(line).includes('[Subscriber Routing] AUDIT:'))).toBe(true));
      expectOnlyReducingOrders();
      expect(routeMocks.adapter.placeMarketOrder.mock.calls[0][0].sizeBase).toBe(0.25);
      expect(log.mock.calls.filter(([line]) => String(line).includes('Reopen skipped:'))).toEqual([
        [`[Subscriber Routing] Reopen skipped: source not trading: sourceBotId=EXAMPLE_SOURCE subscriberBotId=${routeBot.id}`],
      ]);
      expect(storage.createBotTrade).toHaveBeenCalledOnce();
      expect(storage.createBotTrade).toHaveBeenCalledWith(expect.objectContaining({
        tradingBotId: routeBot.id, side: 'CLOSE', status: 'pending',
      }));
      expect(storage.getPublishedBotByTradingBotId).toHaveBeenCalledOnce();
      expectNoOpeningWork(); expect(unpark).not.toHaveBeenCalled();
    } finally { log.mockRestore(); unpark.mockRestore(); }
  });
});
