import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import * as durableClose from '../../server/trading/signal-bot-close-intent';
import { CLOSE_IN_PROGRESS } from '../../server/trading/signal-bot-close-intent-types';
import * as vaultService from '../../server/vault/vault-service';
import { PositionService } from '../../server/position-service';
const hasEntryAdmission = existsSync('server/trading/signal-bot-entry-admission.ts');
let entryAdmission: typeof import('../../server/trading/signal-bot-entry-admission') | null = null;

beforeEach(() => entryAdmission?.resetSignalBotAcceptedEntriesForTests?.());

const routeMocks = vi.hoisted(() => ({
  reconcileCycleDone: vi.fn(),
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
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  },
  notify: vi.fn(async () => {}),
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(),
}));
vi.mock('../../server/job-timing', () => ({
  startJobTiming: (name: string) => name === 'reconcile.tick' ? routeMocks.reconcileCycleDone : () => {},
}));

vi.mock('../../server/notification-service', async importOriginal => ({ ...await importOriginal<any>(), sendTradeNotification: routeMocks.notify }));

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
  return { closeIntentStore: { ...makeCloseRouteStore(storage),
    hasUnresolvedPosition: vi.fn(async () => false), hasUnresolvedTrade: vi.fn(async () => false),
    withEffects: async (_id: string, work: () => Promise<void>) => work() } };
});
import { closeIntentStore } from '../../server/trading/close-intent-store';
import { bridgePreparedClose } from '../helpers/close-route-intent-store';
import { dispatchConfirmedCloseEffects, dispatchPartialCloseEffects, registerPartialCloseFanout, waitForCloseEffects } from '../../server/trading/signal-bot-close-intent-effects';

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
import { startPeriodicReconciliation, stopPeriodicReconciliation, registerRecoveredCloseRoutingCallback } from '../../server/reconciliation-service';

function snapshot(account: string, sequence: number, size: number): CloseSnapshot {
  const now = Date.now();
  return { positions: size === 0 ? [] : [{ internalSymbol: 'BTC-PERP', baseSize: size, sizeBaseExact: String(size), entryPrice: 64000,
    markPrice: null, unrealizedPnl: null, leverage: 2, liquidationPrice: null, marginMode: 'cross' }],
    evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${sequence}`, startedAt: now,
      dispatchedAt: now, receivedAt: now, lastOrderId: sequence, complete: true, fresh: true, noDedup: true } };
}
function fill(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return { tradeId: 'EXAMPLE_FILL', orderId: 'EXAMPLE_ORDER', internalSymbol: 'BTC-PERP',
    side: 'short', price: 65000, size: 0.25, fee: 1, timestamp: Date.now(), ...overrides };
}
function prime(side: 'long' | 'short' = 'long', rows: () => TradeRecord[] = () => [fill()]) {
  vi.clearAllMocks();
  vi.mocked(storage.pauseActiveSignalBot).mockImplementation(async (id, reason) => {
    await storage.updateTradingBot(id, { isActive: false, pauseReason: reason });
    return { ...routeBot, isActive: false, pauseReason: reason } as never;
  });
  routeMocks.notify.mockReset().mockResolvedValue(undefined);
  routeMocks.adapter.getStrictPositionForMarket.mockReset();
  routeMocks.adapter.getMarkets.mockReset();
  routeMocks.adapter.getMarkPrice.mockReset();
  routeMocks.adapter.getAccountInfo.mockReset();
  // Base may refuse before consuming a queued stale-position response.
  vi.mocked(storage.getBotPosition).mockReset();
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
  routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: true, status: 'filled', orderId: 'EXAMPLE_ORDER', landingDisposition: 'terminal' });
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
  // Base predates this module. Only helper-specific controls are unavailable there.
  entryAdmission = hasEntryAdmission ? await import('../../server/trading/signal-bot-entry-admission') : null;
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

type Webhook = 'tv' | 'user';
const subscriberKeypair = Keypair.generate();
const subscriberKey = subscriberKeypair.publicKey.toBase58();
function setup(options: { active?: boolean; subscriber?: boolean; subscriberSize?: number; size?: number; remaining?: number; pending?: boolean } = {}) {
  prime();
  const source = { ...routeBot, isActive: options.active ?? false, policyHmac: null as string | null, vaultAllOut: false, autoTopUp: false };
  const subscriber = { ...routeBot, id: 'EXAMPLE_SUBSCRIBER', walletAddress: 'EXAMPLE_SUB_WALLET', protocolSubaccountId: null, subaccountAuthMode: null, subaccountStatus: null };
  const initial = options.size ?? 0.25;
  const remaining = options.remaining ?? 0;
  const orders = new Map<string, { orderId: string; size: number }>();
  routeMocks.decryptBotSubaccountKey.mockImplementation(async (bot: any) => ({ secretKey: bot.id === subscriber.id ? subscriberKeypair.secretKey : routeKeypair.secretKey, cleanup: vi.fn() }));
  vi.mocked(storage.getTradingBotById).mockImplementation(async id => (id === subscriber.id ? subscriber : source) as never);
  vi.mocked(storage.getWallet).mockImplementation(async address => ({ ...routeWallet, agentPublicKey: address === subscriber.walletAddress ? subscriberKey : routeWallet.agentPublicKey }) as never);
  routeMocks.decryptAgentKeyStrict.mockImplementation(async address => ({ secretKey: address === subscriber.walletAddress ? subscriberKeypair.secretKey : routeKeypair.secretKey, cleanup: vi.fn() }));
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue(options.subscriber ? [subscriber] as never : []);
  vi.mocked(storage.createWebhookLog).mockResolvedValue({ id: 'EXAMPLE_WEBHOOK' } as never);
  vi.mocked(storage.updatePendingBotTrade).mockImplementation(async (_id, fields) => ({ id: 'EXAMPLE_PENDING', ...fields }) as never);
  vi.mocked(storage.getBotPosition).mockImplementation(async id => ({
    baseSize: String(id === subscriber.id ? options.subscriberSize ?? 0.25 : initial),
    avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY',
  }) as never);
  let sequence = 0;
  const position = (account: string) => orders.has(account) && !(account === source.protocolSubaccountId && options.pending) ? remaining : account === subscriberKey ? options.subscriberSize ?? 0.25 : initial;
  routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async (account: string) => {
    const size = position(account); return size ? { internalSymbol: 'BTC-PERP', baseSize: size, entryPrice: 64000 } : null;
  });
  routeMocks.adapter.getPositions.mockImplementation(async (account: string) => position(account) ? [{ internalSymbol: 'BTC-PERP', baseSize: position(account), entryPrice: 64000 }] : []);
  routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => snapshot(account, ++sequence, position(account)));
  routeMocks.adapter.placeMarketOrder.mockImplementation(async (order: any) => {
    const orderId = `EXAMPLE_ORDER_${routeMocks.adapter.placeMarketOrder.mock.calls.length}`;
    orders.set(order.agentPublicKey, { orderId, size: order.sizeBase });
    return options.pending && order.agentPublicKey === source.protocolSubaccountId
      ? { success: false, landingDisposition: 'unconfirmed', error: 'EXAMPLE_PENDING' }
      : { success: true, status: 'filled', orderId, landingDisposition: 'terminal' };
  });
  routeMocks.adapter.getTradeHistory.mockImplementation(async (account: string) => {
    const order = orders.get(account);
    return order && !(account === source.protocolSubaccountId && options.pending)
      ? [fill({ orderId: order.orderId, tradeId: `EXAMPLE_FILL_${order.orderId}`, size: order.size })] : [];
  });
  return { source, subscriber, orders };
}
async function webhook(path: Webhook, payload: Record<string, unknown>) {
  const response = await fetch(baseUrl + (path === 'tv' ? `/api/webhook/tradingview/${ROUTE_BOT_ID}` : `/api/webhook/user/${ROUTE_WALLET}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: ROUTE_BOT_ID, secret: path === 'tv' ? ROUTE_TV_SECRET : ROUTE_USER_SECRET, ...payload }),
  });
  return { status: response.status, body: await response.json() };
}
const closePayload = { action: 'sell', contracts: '0.25', position_size: '0', price: '1000' };
const partialPayload = { ...closePayload, contracts: '0.125', position_size: '0.125' };
async function settledRouting(work: () => Promise<unknown>) {
  const logs = vi.spyOn(console, 'log');
  try {
    const result = await work();
    await waitForCloseEffects();
    await vi.waitFor(() => expect(logs.mock.calls.some(([line]) => String(line).includes('[Subscriber Routing] AUDIT:'))).toBe(true), { timeout: 5000 });
    await waitForCloseEffects();
    return result as Awaited<ReturnType<typeof webhook>>;
  } finally { logs.mockRestore(); }
}
function sourceOrders() { return routeMocks.adapter.placeMarketOrder.mock.calls.map(([order]) => order).filter(order => order.agentPublicKey === routeBot.protocolSubaccountId); }
function subscriberOrders() { return routeMocks.adapter.placeMarketOrder.mock.calls.map(([order]) => order).filter(order => order.agentPublicKey === subscriberKey); }
function expectPaused() { expect(storage.updateTradingBot).toHaveBeenCalledWith(ROUTE_BOT_ID, expect.objectContaining({ isActive: false, pauseReason: expect.stringContaining('Bot underfunded') })); }
function expectNotPaused() { expect(storage.updateTradingBot).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isActive: false })); }

describe('SB07 recovered-close wallet parity', () => {
  async function run(mixed: boolean, state: 'closed' | 'healthy' | 'failed' = 'closed', subaccountStatus = 'active') {
    stopPeriodicReconciliation();
    // Only the periodic timer and clock are fake: subscriber close-effect I/O can finish normally.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    try {
      const { source, subscriber, orders } = setup({ subscriber: true });
      source.subaccountStatus = subaccountStatus;
      const flat = { ...subscriber, id: 'EXAMPLE_FLAT_SUBSCRIBER', walletAddress: 'EXAMPLE_FLAT_WALLET' };
      const active = { ...source, id: 'EXAMPLE_ACTIVE_COMPANION', isActive: true,
        protocolSubaccountId: 'EXAMPLE_COMPANION_ACCOUNT', subaccountStatus: 'active' };
      const walletBots = mixed ? [source, active] : [source];
      const marker = { id: 'EXAMPLE_RECOVERED_PARTIAL', status: 'pending', side: 'short', market: source.market,
        size: '0.125', executedAt: new Date(Date.now() - 30_000), txSignature: 'EXAMPLE_RECOVERED_ORDER',
        protocolFillId: 'tx-partial-EXAMPLE_RECOVERED_FILL', protocol: 'pacifica',
        webhookPayload: { partialClose: true, partialCloseAccounting: {
          expectedBaseSize: '0.25', expectedLastTradeId: 'EXAMPLE_ENTRY', requestedClosedSize: 0.125,
        } } };
      vi.mocked(storage.getWalletsWithActiveBots).mockResolvedValue(mixed ? [ROUTE_WALLET] : []);
      vi.mocked(storage.getWalletsForReconciliation).mockResolvedValue([ROUTE_WALLET]);
      vi.mocked(storage.getTradingBots).mockResolvedValue(walletBots as never);
      vi.mocked(storage.getTradingBotById).mockImplementation(async id =>
        ([source, subscriber, flat, active].find(row => row.id === id) ?? source) as never);
      vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([subscriber, flat] as never);
      vi.mocked(storage.getBotPosition).mockImplementation(async id => ({ baseSize: id === flat.id || id === active.id ? '0' : '0.25',
        avgEntryPrice: '64000', realizedPnl: '0', totalFees: '0', lastTradeId: 'EXAMPLE_ENTRY',
        lastTradeAt: new Date(Date.now() - 600_000) }) as never);
      vi.mocked(storage.getBotTrades).mockImplementation(async id => id === source.id ? [marker] as never : []);
      vi.mocked(storage.getRecentCanonicalCloseForBot).mockResolvedValue(undefined);
      const flatAccount = 'EXAMPLE_FLAT_ACCOUNT';
      const mainAccount = 'EXAMPLE_SOURCE_MAIN_ACCOUNT';
      vi.mocked(storage.getWallet).mockImplementation(async address => ({ ...routeWallet,
        agentPublicKey: address === flat.walletAddress ? flatAccount : address === subscriber.walletAddress ? subscriberKey : mainAccount,
      }) as never);
      const size = (account: string) => account === flatAccount || account === active.protocolSubaccountId ? 0
        : account === source.protocolSubaccountId ? (state === 'healthy' ? 0.25 : 0)
        : orders.has(account) ? 0 : 0.25;
      routeMocks.adapter.getPositions.mockImplementation(async account => size(account)
        ? [{ internalSymbol: source.market, baseSize: size(account), entryPrice: 64000 }] : []);
      routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async account => size(account)
        ? { internalSymbol: source.market, baseSize: size(account), entryPrice: 64000 } : null);
      let sequence = 0;
      routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => {
        if (state === 'failed' && account === source.protocolSubaccountId) throw new Error('EXAMPLE_UNAVAILABLE');
        return snapshot(account, ++sequence, size(account));
      });
      const subscriberHistory = routeMocks.adapter.getTradeHistory.getMockImplementation()!;
      routeMocks.adapter.getTradeHistory.mockImplementation(async (account, options) => account === source.protocolSubaccountId
        ? [fill({ orderId: 'EXAMPLE_RECOVERED_ORDER', tradeId: 'EXAMPLE_RECOVERED_FILL', venueEventKind: 'close_long' })]
        : subscriberHistory(account, options));
      routeMocks.adapter.getAccountInfo.mockResolvedValue({ exists: true, balance: 100, equity: 100 });
      const callback = vi.fn(async (sourceBotId: string, signal: Signal) => {
        await routeSignalToSubscribers(sourceBotId, signal);
      });
      registerRecoveredCloseRoutingCallback(callback);
      startPeriodicReconciliation();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(routeMocks.reconcileCycleDone).toHaveBeenCalledTimes(1), { timeout: 10000 });
      expect(routeMocks.adapter.getCloseConfirmationSnapshot, 'not reconciled').toHaveBeenCalled();
      expect(routeMocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledWith(source.protocolSubaccountId, undefined);
      expect(routeMocks.adapter.getCloseConfirmationSnapshot.mock.calls.some(([account]) => account === mainAccount)).toBe(false);
      // Fanout's existing stagger runs asynchronously. Drain its close effects before inspecting orders.
      if (state === 'closed') {
        expect(callback).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(subscriberOrders()).toHaveLength(1), { timeout: 5000 });
      }
      await waitForCloseEffects();
      expect(sourceOrders()).toHaveLength(0);
      expect(routeMocks.adapter.cancelOrder).not.toHaveBeenCalled();
      expect(routeMocks.adapter.cancelAllOrders).not.toHaveBeenCalled();
      expect(storage.updateTradingBot).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ executionActive: true }));
      if (state === 'closed') {
        expectOnlyReducingOrders(1);
        expect(subscriberOrders()[0]).toMatchObject({ side: 'short', reduceOnly: true, sizeBase: 0.25 });
      } else {
        expect(callback).not.toHaveBeenCalled();
        expectOnlyReducingOrders(0);
      }
      const events = vi.mocked(storage.recordCloseEventAtomic).mock.calls
        .filter(([event]) => event.botId === source.id);
      if (state === 'closed') expect(events).toHaveLength(1);
      else expect(events).toHaveLength(0);
      // Capture at completion: production mutates routing metadata after the atomic write.
      return structuredClone({ callbacks: callback.mock.calls, events,
        orders: subscriberOrders().map(order => ({ side: order.side, size: order.sizeBase, reduceOnly: order.reduceOnly })) });
    } finally {
      stopPeriodicReconciliation();
      registerRecoveredCloseRoutingCallback(async (sourceBotId, signal) => { await routeSignalToSubscribers(sourceBotId, signal); });
      vi.useRealTimers();
    }
  }
  it('paused-only and mixed wallets produce identical recovered-close callbacks and atomic arguments', async () => {
    expect(await run(false)).toEqual(await run(true));
  }, 20000);
  it.each(['healthy', 'failed'] as const)('%s paused-only source dispatches nothing', async state => {
    await run(false, state);
  }, 10000);
  it.each(['pending', 'error'])('R2 published paused source %s recovers only reducing subscriber closes', async status => {
    expect(await run(false, 'closed', status)).toEqual(await run(true, 'closed', status));
  }, 20000);
});

describe.each(['tv', 'user'] as const)('SB04 %s', path => {
  it('discriminating full close uses exactly the own position reduce-only', async () => {
    setup(); const result = await webhook(path, closePayload);
    expect(result.status, JSON.stringify(result.body)).toBe(200); expectOnlyReducingOrders(); expect(sourceOrders()[0].sizeBase).toBe(0.25);
    await waitForCloseEffects();
  });
  it.each(['nonzero', 'missing'] as const)('discriminating classifier FULL_CLOSE %s target never opens', async target => {
    setup(); const payload: Record<string, unknown> = { ...closePayload, position_size: '0.001' };
    if (target === 'missing') delete payload.position_size;
    const result = await webhook(path, payload);
    expect(result.status, JSON.stringify(result.body)).toBe(200); expectOnlyReducingOrders(); expect(sourceOrders()[0].sizeBase).toBe(0.25);
    await waitForCloseEffects();
  });
  it('discriminating partial close uses exactly half the own position reduce-only', async () => {
    setup({ remaining: 0.125 }); const result = await webhook(path, partialPayload);
    expect(result.status, JSON.stringify(result.body)).toBe(200); await waitForCloseEffects(); expectOnlyReducingOrders(); expect(sourceOrders()[0].sizeBase).toBe(0.125);
  });
  it('discriminating flip closes and refuses reopen without oracle or sizing', async () => {
    setup(); const result = await webhook(path, { ...closePayload, contracts: '0.5', position_size: '-0.25' });
    expect(result.status, JSON.stringify(result.body)).toBe(400); expect(JSON.stringify(result.body)).toContain('Bot is paused');
    expect(JSON.stringify(result.body)).toContain('admission'); expectOnlyReducingOrders();
    expect(routeMocks.adapter.getMarkPrice).not.toHaveBeenCalled(); expect(routeMocks.adapter.getAccountInfo).not.toHaveBeenCalled();
    await waitForCloseEffects();
  });
  it('discriminating second pause guard catches classification disagreement', async () => {
    setup();
    vi.mocked(storage.getBotPosition).mockResolvedValueOnce({ baseSize: '0.25', avgEntryPrice: '64000' } as never)
      .mockResolvedValue({ baseSize: '-0.25', avgEntryPrice: '64000' } as never);
    const result = await webhook(path, partialPayload);
    expect(result).toEqual({ status: 400, body: { error: 'Bot is paused' } });
    expect(vi.mocked(storage.getBotPosition).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
    expect(routeMocks.adapter.getMarkPrice).not.toHaveBeenCalled();
  });
  it('discriminating legacy flip closes the whole source and refuses reopen', async () => {
    setup(); const result = await webhook(path, { message: 'order sell @ 0.125 filled on BTC. New strategy position is -0.25' });
    expect(result.status, JSON.stringify(result.body)).toBe(400); expect(JSON.stringify(result.body)).toContain('Bot is paused');
    expectOnlyReducingOrders(); expect(sourceOrders()[0].sizeBase).toBe(0.25);
    expect(routeMocks.adapter.getMarkPrice).not.toHaveBeenCalled(); await waitForCloseEffects();
  });
  it.each(['entry', 'pyramid'] as const)('preservation paused %s response and log', async type => {
    setup({ size: type === 'entry' ? 0 : 0.25 });
    const result = await webhook(path, { action: 'buy', contracts: '0.25', position_size: '0.5' });
    expect(result).toEqual({ status: 400, body: { error: 'Bot is paused' } });
    expect(storage.updateWebhookLog).toHaveBeenCalledWith('EXAMPLE_WEBHOOK', path === 'tv'
      ? { errorMessage: 'Bot is paused (subscriber routing requested)' }
      : { errorMessage: 'Bot is paused (subscriber routing requested)', processed: true });
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('discriminating already-flat close matches active response', async () => {
    setup({ active: true, size: 0 }); const active = await webhook(path, closePayload);
    setup({ size: 0 }); const paused = await webhook(path, closePayload);
    expect(paused).toEqual(active); expect(paused.status).toBe(409); expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
  it('discriminating published paused flip closes subscriber exactly once and never reopens', async () => {
    setup({ subscriber: true }); const result = await settledRouting(() => webhook(path, { ...closePayload, contracts: '0.5', position_size: '-0.25' }));
    expect(result.status, JSON.stringify(result.body)).toBe(400); expect(sourceOrders()).toHaveLength(1); expect(subscriberOrders()).toHaveLength(1);
    expectOnlyReducingOrders(2); expect(subscriberOrders()[0].sizeBase).toBe(0.25);
    expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('discriminating full subscriber close once source pending=%s', async pending => {
    const created: any[] = [];
    setup({ subscriber: true, pending });
    const store = closeIntentStore as any, originalCreate = store.create;
    const create = vi.spyOn(store, 'create').mockImplementation(async (...args: any[]) => { const value = await originalCreate(...args); created.push(value.intent); return value; });
    try {
    const result = await settledRouting(() => webhook(path, closePayload));
    expect(result.status, JSON.stringify(result.body)).toBe(pending ? 202 : 200); expect(sourceOrders()).toHaveLength(1); expect(subscriberOrders()).toHaveLength(1);
    expectOnlyReducingOrders(2); expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
    if (pending) {
      const sourceIntent = created.find(intent => intent.bot_id === ROUTE_BOT_ID);
      expect(sourceIntent).toBeDefined();
      const confirmed = await store.withScope(sourceIntent.environment, sourceIntent.original_account, sourceIntent.market, async (scope: any) => {
        const current = await store.byId(scope, sourceIntent.id);
        return store.settle(scope, current, { status: 'confirmed', last_evidence: { ...current.last_evidence,
          effectsPending: true, notificationPending: true, fill: { filledSize: 0.25, fillPrice: 65000, fee: 1, realizedPnl: 250 } } });
      });
      await dispatchConfirmedCloseEffects(confirmed);
      expect(routeMocks.notify).toHaveBeenCalledWith(ROUTE_WALLET, expect.objectContaining({ type: 'position_closed' }));
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expect(subscriberOrders()).toHaveLength(1);
    }
    } finally { create.mockRestore(); }
  });
  it('discriminating paused partial subscriber fanout is durable and single', async () => {
    setup({ subscriber: true, remaining: 0.125 }); const result = await settledRouting(() => webhook(path, partialPayload));
    expect(result.status, JSON.stringify(result.body)).toBe(200); expect(sourceOrders()).toHaveLength(1); expect(subscriberOrders()).toHaveLength(1);
    expectOnlyReducingOrders(2); expect(subscriberOrders()[0].sizeBase).toBe(0.125);
    expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
  });
  describe.each(['full', 'partial'] as const)('new behavior paused authorization %s', kind => {
  it.each(['emergency', 'disabled', 'invalid-authorization'] as const)('%s refuses paused source before close admission with 403', async failure => {
    setup({ active: false });
    if (failure === 'invalid-authorization') routeMocks.getUmkForWebhook.mockResolvedValue(null);
    else vi.mocked(storage.getWallet).mockResolvedValue({ ...routeWallet, emergencyStopTriggered: failure === 'emergency', executionEnabled: failure !== 'disabled' } as never);
    const result = await webhook(path, kind === 'full' ? closePayload : partialPayload);
    expect(result.status, JSON.stringify(result.body)).toBe(403); expect(sourceOrders()).toHaveLength(0);
  });
  });
});
it('SB04 discriminating active user Pacifica partial has one durable subscriber dispatch', async () => {
  setup({ active: true, subscriber: true, remaining: 0.125 });
  const result = await settledRouting(() => webhook('user', partialPayload));
  expect(result.status, JSON.stringify(result.body)).toBe(200); expectOnlyReducingOrders(2); expect(subscriberOrders()).toHaveLength(1);
  expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
});

describe('SB04 paused TradingView post-gate refusals', () => {
  it.each(['emergency', 'disabled', 'expired', 'umk', 'policy', 'decrypt', 'zero-key', 'agent-wallet'] as const)('discriminating %s preserves status and one subscriber close', async failure => {
    const { source } = setup({ subscriber: true, remaining: 0.125 });
    let walletReads = 0;
    vi.mocked(storage.getWallet).mockImplementation(async address => {
      if (address !== ROUTE_WALLET) return { ...routeWallet, agentPublicKey: subscriberKey } as never;
      walletReads++;
      return { ...routeWallet, emergencyStopTriggered: failure === 'emergency', executionEnabled: failure !== 'disabled',
        executionExpiresAt: failure === 'expired' ? new Date(0) : null,
        agentPublicKey: failure === 'agent-wallet' && walletReads > 1 ? null : routeWallet.agentPublicKey } as never;
    });
    routeMocks.getUmkForWebhook.mockImplementation(async address => address === ROUTE_WALLET && failure === 'umk' ? null : { umk: Buffer.alloc(32), cleanup: vi.fn() });
    routeMocks.decryptAgentKeyStrict.mockImplementation(async address => address === ROUTE_WALLET && failure === 'decrypt' ? null : {
      secretKey: address === ROUTE_WALLET && failure === 'zero-key' ? new Uint8Array(64) : address === ROUTE_WALLET ? routeKeypair.secretKey : subscriberKeypair.secretKey, cleanup: vi.fn(),
    });
    if (failure === 'policy') source.policyHmac = 'EXAMPLE';
    const result = await settledRouting(() => webhook('tv', partialPayload));
    expect(result.status, JSON.stringify(result.body)).toBe(failure === 'zero-key' ? 500 : failure === 'agent-wallet' ? 400 : 403);
    if (failure === 'agent-wallet') expect(storage.updateWebhookLog).toHaveBeenCalledWith('EXAMPLE_WEBHOOK', { errorMessage: 'No agent wallet for partial close', processed: true });
    expect(sourceOrders()).toHaveLength(0); expect(subscriberOrders()).toHaveLength(1);
    expectOnlyReducingOrders(); expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
  });
});

async function sizingRequest(path: Webhook | 'manual' | 'subscriber') {
  if (path === 'subscriber') { await routeSignalToSubscribers('EXAMPLE_SOURCE', entry); return { status: 400, body: {} }; }
  if (path === 'manual') {
    const response = await fetch(`${baseUrl}/api/trading-bots/${ROUTE_BOT_ID}/manual-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side: 'long' }) });
    return { status: response.status, body: await response.json() };
  }
  return webhook(path, { action: 'buy', contracts: '0.25', position_size: '0.5', price: '1000' });
}
describe.each(['tv', 'user', 'manual', 'subscriber'] as const)('SB04 sizing %s', path => {
  it.each(['db-position', 'venue-position', 'unknown-venue', 'flat'] as const)('discriminating %s protects open positions or notifies real pause', async state => {
    setup({ active: true, size: state === 'db-position' ? 0.25 : 0 });
    if (path === 'subscriber') vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([routeBot] as never);
    if (state === 'venue-position') routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue({ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 });
    if (state === 'unknown-venue') routeMocks.adapter.getStrictPositionForMarket.mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    const leverage = primeRiskSizing();
    routeMocks.adapter.getAccountInfo.mockResolvedValue({ balance: 0, equity: 0, availableMargin: 0, maintenanceMargin: 0, unrealizedPnl: 0 });
    routeMocks.notify.mockRejectedValue(new Error('EXAMPLE_NOTIFICATION_FAILED'));
    try {
      const result = await sizingRequest(path);
      expect(result.status, JSON.stringify(result.body)).toBe(400); expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
      if (state === 'flat') {
        expectPaused(); expect(routeMocks.notify).toHaveBeenCalledWith(ROUTE_WALLET, expect.objectContaining({ type: 'trade_failed', botName: routeBot.name, error: expect.stringMatching(/^Bot paused: Bot underfunded/) }));
        expect(routeMocks.notify).toHaveBeenCalledTimes(1);
      } else expectNotPaused();
      if (path === 'subscriber') expect(storage.createBotTrade).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('Bot underfunded') }));
      if (path === 'tv' || path === 'user') expect(storage.updateBotTrade).toHaveBeenCalledWith('EXAMPLE_PENDING', expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('Bot underfunded') }));
      // DB non-zero needs no strict read on the shouldPauseBot branch.
      if (state === 'db-position' && path === 'manual') expect(routeMocks.adapter.getStrictPositionForMarket).not.toHaveBeenCalled();
    } finally { leverage.mockRestore(); }
  });
});
it.each(['tv', 'user'] as const)('SB04 discriminating %s flip sizing failure uses current flat state and pauses', async path => {
  const fixture = setup({ active: true }); const leverage = primeRiskSizing();
  routeMocks.adapter.getAccountInfo.mockImplementation(async () => {
    if (fixture.orders.size) vi.mocked(storage.getBotPosition).mockResolvedValue({ baseSize: '0', avgEntryPrice: '0' } as never);
    return { balance: 0, equity: 0, availableMargin: 0, maintenanceMargin: 0, unrealizedPnl: 0 };
  });
  try {
    const result = await webhook(path, { ...closePayload, contracts: '0.5', position_size: '-0.25' });
    expect(result.status, JSON.stringify(result.body)).toBe(400); expectOnlyReducingOrders(); expectPaused();
    expect(routeMocks.notify).toHaveBeenCalledWith(ROUTE_WALLET, expect.objectContaining({ error: expect.stringMatching(/^Bot paused:/) }));
    await waitForCloseEffects();
  } finally { leverage.mockRestore(); }
});

// Execute the actual production helpers, with isolated ports and deterministic barriers.
function entryPauseHarness() {
  const helperPath = 'server/trading/signal-bot-entry-admission.ts';
  const source = readFileSync(existsSync(helperPath) ? helperPath : 'server/routes.ts', 'utf8');
  const parsed = ts.createSourceFile('admission.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['acquireSignalBotEntryLock', 'executeSignalBotEntry', 'pauseSignalBotIfFlat'];
  const declarations = names.map(name => {
    const node = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production helper: ${name}`);
    return node.getText(parsed);
  }).join('\n');
  const port = { active: true, size: 0 };
  const storagePort = { getTradingBotById: vi.fn(async () => ({ ...routeBot, isActive: port.active, walletAddress: ROUTE_WALLET })),
    getWallet: vi.fn(async () => ({ ...routeWallet })),
    getBotPosition: vi.fn(async () => ({ baseSize: String(port.size) })),
    updateTradingBot: vi.fn(async () => { port.active = false; }),
    pauseActiveSignalBot: vi.fn(async () => { await storagePort.updateTradingBot(); return { ...routeBot, isActive: false }; }) };
  const venue = { getPositionForCloseAuthority: vi.fn(async () => ({ side: port.size ? 'LONG' : 'FLAT', size: port.size })) };
  const maps = parsed.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ['signalBotEntryLocks', 'signalBotAcceptedEntries'].includes(declaration.name.getText(parsed)))).map(node => node.getText(parsed)).join('\n');
  const code = ts.transpileModule((maps + '\n' + declarations).replace(/export /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const helpers = new Function('storage', 'PositionService', 'sendTradeNotification', code + '\nreturn {executeSignalBotEntry,pauseSignalBotIfFlat};')(storagePort, venue, vi.fn(async () => {}));
  return { ...helpers, port, storagePort, venue };
}
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe.skipIf(!hasEntryAdmission)('round2 mutex overlap', () => {
  it('entry in flight blocks flat proof then refuses pause after position appears', async () => {
    const h = entryPauseHarness(), entered = barrier(), release = barrier();
    const entry = h.executeSignalBotEntry(routeBot, async () => { entered.resolve(); await release.promise; h.port.size = 0.25; return { success: true }; });
    await entered.promise;
    const pause = h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false);
    await Promise.resolve(); await Promise.resolve();
    expect(h.storagePort.getBotPosition).not.toHaveBeenCalled();
    release.resolve(); expect(await entry).toEqual({ success: true }); expect(await pause).toBe('not_flat');
    expect(h.storagePort.getBotPosition).toHaveBeenCalledTimes(1); expect(h.port.active).toBe(true);
  });
  it('pause in flight blocks entry then refuses submission after pause lands', async () => {
    const h = entryPauseHarness(), proving = barrier(), release = barrier();
    h.venue.getPositionForCloseAuthority.mockImplementation(async () => { proving.resolve(); await release.promise; return { side: 'FLAT', size: 0 }; });
    const pause = h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false);
    await proving.promise;
    const submit = vi.fn(async () => ({ success: true })), entry = h.executeSignalBotEntry(routeBot, submit);
    await Promise.resolve(); await Promise.resolve(); expect(h.storagePort.getTradingBotById).toHaveBeenCalledTimes(1);
    release.resolve(); expect(await pause).toBe('paused'); expect(await entry).toEqual({ success: false, error: 'Bot is paused' });
    expect(submit).not.toHaveBeenCalled();
  });
  it('different bots proceed independently and failed submissions release the queue', async () => {
    const h = entryPauseHarness(), entered = barrier(), release = barrier();
    const first = h.executeSignalBotEntry(routeBot, async () => { entered.resolve(); await release.promise; throw new Error('EXAMPLE'); });
    const failed = expect(first).rejects.toThrow('EXAMPLE'); await entered.promise;
    expect(await h.executeSignalBotEntry({ ...routeBot, id: 'EXAMPLE_OTHER' }, async () => ({ success: true }))).toEqual({ success: true });
    release.resolve(); await failed;
    expect(await h.executeSignalBotEntry(routeBot, async () => ({ success: true }))).toEqual({ success: true });
  });
});
it.each(['tv', 'user', 'manual', 'subscriber'] as const)('round2 entry %s rechecks active state immediately before submit', async path => {
  const { source } = setup({ active: true, size: 0 }); const leverage = primeRiskSizing();
  if (path === 'subscriber') vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([source] as never);
  let paused = false, rechecks = 0;
  vi.mocked(storage.getTradingBotById).mockImplementation(async () => { if (paused) rechecks++; return { ...source, isActive: !paused } as never; });
  routeMocks.adapter.getAccountInfo.mockImplementation(async () => { paused = true; return { balance: 1000, equity: 1000, availableMargin: 1000, maintenanceMargin: 0, unrealizedPnl: 0 }; });
  try { await sizingRequest(path); expect(rechecks).toBeGreaterThan(0); expect(sourceOrders()).toHaveLength(0); }
  finally { leverage.mockRestore(); }
});
describe.each(['tv', 'user'] as const)('round2 stale %s', path => {
  it.each(['full-missing', 'full-nonzero', 'flip'] as const)('%s refresh prevents an order in the wrong direction', async kind => {
    setup();
    vi.mocked(storage.getBotPosition).mockResolvedValueOnce({ baseSize: '0.25', avgEntryPrice: '64000' } as never)
      .mockResolvedValue({ baseSize: '-0.25', avgEntryPrice: '64000' } as never);
    const payload: Record<string, unknown> = { ...closePayload, position_size: '0.001' };
    if (kind === 'full-missing') delete payload.position_size;
    if (kind === 'flip') Object.assign(payload, { contracts: '0.5', position_size: '-0.25' });
    const result = await webhook(path, payload);
    expect(result).toEqual({ status: 400, body: { error: 'Bot is paused' } });
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
    expect(vi.mocked(storage.getBotPosition).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
describe.each(['tv', 'user'] as const)('round2 partial exits %s', path => {
  it.each(['missing-wallet', 'subaccount', 'unavailable', 'flat', 'pre-order', 'terminal'] as const)('%s routes subscribers once', async failure => {
    const { source } = setup({ subscriber: true, remaining: 0.125 });
    const restores: (() => void)[] = [];
    if (failure === 'missing-wallet') {
      let reads = 0;
      vi.mocked(storage.getWallet).mockImplementation(async address => ({ ...routeWallet,
        agentPublicKey: address !== ROUTE_WALLET ? subscriberKey : ++reads > 1 ? null : routeWallet.agentPublicKey }) as never);
    }
    if (failure === 'subaccount') routeMocks.decryptBotSubaccountKey.mockImplementation(async (bot: any) => {
      if (bot.id === source.id) throw new Error('EXAMPLE_UNAVAILABLE');
      return { secretKey: subscriberKeypair.secretKey, cleanup: vi.fn() };
    });
    if (failure === 'unavailable' || failure === 'flat') {
      const previous = routeMocks.adapter.getCloseConfirmationSnapshot.getMockImplementation()!;
      routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string, ...args: any[]) => {
        if (account === source.protocolSubaccountId) { if (failure === 'unavailable') throw new Error('EXAMPLE_UNAVAILABLE'); return snapshot(account, 1, 0); }
        return (previous as any)(account, ...args);
      });
    }
    if (failure === 'pre-order') {
      const adapter = routeMocks.adapter as any, previous = adapter.prepareReduceOnlyMarketOrder;
      const spy = vi.spyOn(adapter, 'prepareReduceOnlyMarketOrder').mockImplementation(async (params: any) => {
        if (params.agentPublicKey === source.protocolSubaccountId) throw new Error('EXAMPLE_PRE_ORDER');
        return previous(params);
      }); restores.push(() => spy.mockRestore());
    }
    if (failure === 'terminal') {
      const previous = durableClose.submitDurableClose;
      const spy = vi.spyOn(durableClose, 'submitDurableClose').mockImplementation(async input => input.identity.bot_id === source.id
        ? { intent: { original_trade_id: 'EXAMPLE_RELEASED', status: 'released', release_mode: 'not_sent', attempt_log: [] }, created: false } as never : previous(input));
      restores.push(() => spy.mockRestore());
    }
    try {
      await settledRouting(() => webhook(path, partialPayload));
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expect(sourceOrders()).toHaveLength(0); expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ reduceOnly: true, sizeBase: 0.125 });
    } finally { restores.forEach(restore => restore()); }
  });
  it('nonpacifica paused partial has one subscriber dispatch', async () => {
    const { source, subscriber } = setup({ subscriber: true, remaining: 0.125 });
    source.activeProtocol = 'drift'; subscriber.activeProtocol = 'drift';
    const previous = routeMocks.adapter.protocolName; routeMocks.adapter.protocolName = 'drift';
    routeMocks.adapter.getFeeRateQuote.mockImplementation(async (request: any) => ({
      availability: 'available', protocol: 'drift', account: request.account, subaccountId: request.subaccountId,
      liquidityRole: 'taker', baseRate: 0.001, effectiveRate: 0.001, provenance: 'EXAMPLE_FEE_QUOTE',
      observedAt: Date.now(), builder: { status: 'absent' },
    }));
    const place = routeMocks.adapter.placeMarketOrder.getMockImplementation()!;
    routeMocks.adapter.placeMarketOrder.mockImplementation(async (order: any) => ({ ...await (place as any)(order), fillPrice: 65000, fee: 1 }));
    try {
      const result = await settledRouting(() => webhook(path, partialPayload));
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.status, JSON.stringify(result.body)).not.toBe('accounting_incomplete');
      expect(storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({ botId: source.id, confirmedPositionReduction: expect.any(Object) }));
      expect(result.body.status).not.toBe('accounting_incomplete');
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1); expect(subscriberOrders()).toHaveLength(1);
    } finally { routeMocks.adapter.protocolName = previous; }
  });
});


describe.each(['tv', 'user'] as const)('round3 reduction %s', path => {
  it.each([
    ['FLIP', 0], ['FLIP', -0.25], ['partial', 0], ['partial', -0.25],
  ] as const)('%s skips active subscriber size=%s before sizing or funding', async (kind, subscriberSize) => {
    const { subscriber } = setup({ subscriber: true, subscriberSize, remaining: kind === 'partial' ? 0.125 : 0 });
    const leverage = primeRiskSizing();
    try {
      const payload = kind === 'partial' ? partialPayload : { ...closePayload, contracts: '0.5', position_size: '-0.25' };
      await settledRouting(() => webhook(path, payload));
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expect(subscriberOrders()).toHaveLength(0);
      expect(routeMocks.decryptAgentKeyStrict).not.toHaveBeenCalledWith(subscriber.walletAddress, expect.anything(), expect.anything(), expect.anything());
      expect(leverage).not.toHaveBeenCalled();
      expect(routeMocks.adapter.deposit).not.toHaveBeenCalled();
      expect(routeMocks.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
      await waitForCloseEffects();
    } finally { leverage.mockRestore(); }
  });
});

describe.each(['tv', 'user'] as const)('round5 %s', path => {
  const cases = [
    ['discriminating', 'missing', 'opposing', 0.25],
    ['discriminating', 'zero', 'opposing', 0.25],
    ['discriminating', 'same-side', 'opposing', 0.25],
    ['control', 'opposing', 'flat', 0],
    ['control', 'opposing', 'same-side', 0],
    ['discriminating', 'opposing', 'failed', 0.4],
    ['control', 'zero', 'failed', 0],
    ['control', 'missing', 'failed', 0],
    ['control', 'same-side', 'failed', 0],
  ] as const;
  describe.each(['FLIP', 'partial'] as const)('%s', kind => {
    it.each(cases)('%s DB=%s venue=%s reduces=%s from one venue read without entry work', async (_label, db, venue, expectedSize) => {
      const { subscriber } = setup({ subscriber: true, subscriberSize: venue === 'failed' ? 0.4 : undefined, remaining: kind === 'partial' ? 0.125 : 0 });
      const getDb = vi.mocked(storage.getBotPosition).getMockImplementation()!;
      vi.mocked(storage.getBotPosition).mockImplementation(async (...args) => args[0] === subscriber.id
        ? db === 'missing' ? undefined : { market: 'BTC-PERP', baseSize: db === 'zero' ? '0' : db === 'opposing' ? '0.4' : '-0.4', avgEntryPrice: '64000' } as never
        : getDb(...args));
      const read = routeMocks.adapter.getStrictPositionForMarket.getMockImplementation()!;
      routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async (account: string) => {
        if (account !== subscriberKey) return read(account);
        if (venue === 'failed') throw new Error('EXAMPLE venue unavailable');
        const size = venue === 'opposing' ? 0.25 : venue === 'same-side' ? -0.25 : 0;
        return size ? { internalSymbol: 'BTC-PERP', baseSize: size, entryPrice: 64000 } : null;
      });
      const executionRead = vi.spyOn(PositionService, 'getPositionForCloseAuthority');
      const leverage = primeRiskSizing();
      try {
        await settledRouting(() => webhook(path, kind === 'partial' ? partialPayload : { ...closePayload, contracts: '0.5', position_size: '-0.25' }));
        expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
        // Residual accounting reads pass an explicit adapter (sixth argument).
        // Only the decision/quantity authority snapshot is shared here.
        expect(executionRead.mock.calls.filter(args => args[0] === subscriber.id && args.length === 5)).toHaveLength(1);
        expect(subscriberOrders()).toHaveLength(expectedSize ? 1 : 0);
        if (expectedSize) expect(subscriberOrders()[0]).toMatchObject({ side: 'short', reduceOnly: true, sizeBase: expectedSize * (kind === 'partial' ? 0.5 : 1) });
        expectOnlyReducingOrders(expectedSize ? 2 : 1);
        expect(leverage).not.toHaveBeenCalled();
        expect(routeMocks.adapter.getAccountInfo).not.toHaveBeenCalled();
        expect(routeMocks.adapter.deposit).not.toHaveBeenCalled();
        expect(routeMocks.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
      } finally { executionRead.mockRestore(); leverage.mockRestore(); }
    });
  });
});

describe('round6 discriminating strict subscriber authority', () => {
  it.each(['full', 'FLIP', 'partial'] as const)('%s ignores stale flat and smaller cache and reuses one strict snapshot', async kind => {
    for (const cachedSize of [0, 0.1]) {
      const { subscriber } = setup({ subscriber: true, subscriberSize: 0.4, remaining: kind === 'partial' ? 0.2 : 0 });
      const cached = routeMocks.adapter.getPositions.getMockImplementation()!;
      routeMocks.adapter.getPositions.mockImplementation(async (account: string) => account === subscriberKey
        ? cachedSize ? [{ internalSymbol: 'BTC-PERP', baseSize: cachedSize, entryPrice: 64000 }] : [] : cached(account));
      // A second authority read would contradict the first snapshot.
      routeMocks.adapter.getStrictPositionForMarket.mockResolvedValueOnce({ internalSymbol: 'BTC-PERP', baseSize: 0.4, entryPrice: 64000 })
        .mockResolvedValue(null);
      const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority');
      const execution = vi.spyOn(PositionService, 'getPositionForExecution');
      try {
        await route({ ...(kind === 'full' ? full : kind === 'FLIP' ? flip : partial), sourceNotTrading: true });
        expect(strict.mock.calls.filter(args => args[0] === subscriber.id && args.length === 5)).toHaveLength(1);
        expect(execution.mock.calls.filter(([id]) => id === subscriber.id)).toHaveLength(0);
        expect(subscriberOrders()).toHaveLength(1);
        expect(subscriberOrders()[0]).toMatchObject({ side: 'short', reduceOnly: true, sizeBase: kind === 'partial' ? 0.2 : 0.4 });
        expectOnlyReducingOrders();
      } finally { strict.mockRestore(); execution.mockRestore(); }
    }
  });
  it.each(['full', 'FLIP', 'partial'] as const)('%s strict failure uses opposing SHORT DB fallback for exactly one buy', async kind => {
    const { subscriber } = setup({ subscriber: true, subscriberSize: -0.4, remaining: kind === 'partial' ? -0.2 : 0 });
    // A stale cache must not mask strict failure or replace durable authority.
    routeMocks.adapter.getPositions.mockResolvedValue([]);
    routeMocks.adapter.getStrictPositionForMarket.mockRejectedValue(new Error('EXAMPLE_429_OR_QUOTA_UNAVAILABLE'));
    const history = routeMocks.adapter.getTradeHistory.getMockImplementation()!;
    routeMocks.adapter.getTradeHistory.mockImplementation(async (...args: any[]) =>
      (await history(...args)).map((row: TradeRecord) => ({ ...row, side: 'long' })));
    const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority');
    try {
      await route({ ...(kind === 'full' ? full : kind === 'FLIP' ? flip : partial), action: 'buy',
        strategyPositionSize: kind === 'partial' ? '-0.2' : kind === 'FLIP' ? '0.4' : '0', sourceNotTrading: true });
      expect(strict.mock.calls.filter(args => args[0] === subscriber.id && args.length === 5)).toHaveLength(1);
      expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ side: 'long', reduceOnly: true, sizeBase: kind === 'partial' ? 0.2 : 0.4 });
      expectOnlyReducingOrders();
    } finally { strict.mockRestore(); }
  });
  it.each(['zero', 'missing', 'same-side'] as const)('full strict failure refuses unproven DB %s', async state => {
    const { subscriber } = setup({ subscriber: true });
    vi.mocked(storage.getBotPosition).mockResolvedValue(state === 'missing' ? undefined as never
      : { baseSize: state === 'zero' ? '0' : '-0.4', avgEntryPrice: '64000' } as never);
    routeMocks.adapter.getStrictPositionForMarket.mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    await route({ ...full, sourceNotTrading: true });
    expect(subscriberOrders()).toHaveLength(0);
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
    expect(storage.getBotPosition).toHaveBeenCalledWith(subscriber.id, subscriber.market);
  });
});
describe('round7 discriminating reopen intent', () => {
  it('hintless not-trading Pacifica entry closes and reopens an opposing subscriber as on live main', async () => {
    setup({ subscriber: true });
    const leverage = primeRiskSizing();
    try {
      await route({ ...entry, action: 'sell', contracts: '0.5', strategyPositionSize: '-0.25', sourceNotTrading: true });
      expect(subscriberOrders()).toHaveLength(2);
      expect(subscriberOrders()[0]).toMatchObject({ side: 'short', reduceOnly: true, sizeBase: 0.25 });
      expect(subscriberOrders()[1]).toMatchObject({ side: 'short', reduceOnly: false });
      expect(storage.createBotTrade).not.toHaveBeenCalledWith(expect.objectContaining({ errorMessage: 'Bot is paused' }));
    } finally { leverage.mockRestore(); }
  });

  it('hinted not-trading non-Pacifica flip completes its close and refuses all reopen work', async () => {
    const { subscriber } = setup({ subscriber: true });
    subscriber.activeProtocol = 'drift';
    const protocol = routeMocks.adapter.protocolName;
    routeMocks.adapter.protocolName = 'drift';
    const submit = routeMocks.adapter.placeMarketOrder.getMockImplementation()!;
    routeMocks.adapter.placeMarketOrder.mockImplementation(async (order: any) => ({ ...await submit(order), fillPrice: 65000, fee: 1 }));
    const leverage = primeRiskSizing();
    routeMocks.adapter.getFeeRateQuote.mockImplementation(async (request: any) => ({
      availability: 'available', protocol: 'drift', account: request.account, subaccountId: request.subaccountId,
      liquidityRole: 'taker', baseRate: 0.001, effectiveRate: 0.001, provenance: 'EXAMPLE_FEE_QUOTE',
      observedAt: Date.now(), builder: { status: 'absent' },
    }));
    try {
      await route({ ...flip, contracts: '0.5', sourceNotTrading: true, reduceOnlyIfRefused: 'full' });
      expect(storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({ botId: subscriber.id }));
      expect(subscriberOrders()).toHaveLength(1);
      expectOnlyReducingOrders();
      expect(storage.createBotTrade).toHaveBeenCalledWith(expect.objectContaining({
        tradingBotId: subscriber.id, status: 'failed', errorMessage: 'Bot is paused',
        webhookPayload: expect.objectContaining({ reversal: expect.objectContaining({
          close: expect.objectContaining({ kind: 'executed' }), open: expect.objectContaining({ kind: 'rejected' }),
        }) }),
      }));
      expect(leverage).not.toHaveBeenCalled();
      expect(routeMocks.adapter.getAccountInfo).not.toHaveBeenCalled();
      expect(routeMocks.adapter.deposit).not.toHaveBeenCalled();
      expect(routeMocks.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    } finally { routeMocks.adapter.protocolName = protocol; leverage.mockRestore(); }
  });
});

describe.each(['tv', 'user'] as const)('round7 discriminating durable paused admission %s', path => {
  it('resuming the source before pending partial effects still closes once from strict subscriber authority', async () => {
    const { source, subscriber } = setup({ subscriber: true, subscriberSize: 0.4, remaining: 0.2, pending: true });
    const created: any[] = [], store = closeIntentStore as any, originalCreate = store.create;
    const create = vi.spyOn(store, 'create').mockImplementation(async (...args: any[]) => {
      const value = await originalCreate(...args); created.push(value.intent); return value;
    });
    const cached = routeMocks.adapter.getPositions.getMockImplementation()!;
    routeMocks.adapter.getPositions.mockImplementation(async (account: string) => account === subscriberKey ? [] : cached(account));
    const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority');
    const execution = vi.spyOn(PositionService, 'getPositionForExecution');
    try {
      const result = await webhook(path, partialPayload);
      await waitForCloseEffects();
      expect(result.status, JSON.stringify(result.body)).toBe(202);
      expect(sourceOrders()).toHaveLength(1);
      expect(subscriberOrders()).toHaveLength(0);
      expect(storage.getSubscriberBotsBySourceId).not.toHaveBeenCalled();
      const sourceIntent = created.find(intent => intent.bot_id === source.id);
      expect(sourceIntent).toBeDefined();
      source.isActive = true;
      const confirmed = await store.withScope(sourceIntent.environment, sourceIntent.original_account, sourceIntent.market, async (scope: any) => {
        const current = await store.byId(scope, sourceIntent.id);
        return store.settle(scope, current, { status: 'confirmed', last_evidence: { ...current.last_evidence,
          effectsPending: true, notificationPending: true,
          fill: { filledSize: 0.125, fillPrice: 65000, fee: 1, realizedPnl: 125 } } });
      });
      await dispatchConfirmedCloseEffects(confirmed);
      await dispatchConfirmedCloseEffects(confirmed);
      await waitForCloseEffects();
      expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ side: 'short', reduceOnly: true, sizeBase: 0.2 });
      expectOnlyReducingOrders(2);
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expect(strict.mock.calls.filter(args => args[0] === subscriber.id && args.length === 5)).toHaveLength(1);
      expect(execution.mock.calls.filter(([id]) => id === subscriber.id)).toHaveLength(0);
      expect(sourceIntent.authority_ref.pausedAtAdmission).toBe(true);
    } finally { create.mockRestore(); strict.mockRestore(); execution.mockRestore(); }
  });
});

describe('round7 controls subscriber signal isolation', () => {
  it.each(['paused', 'refused-listing'] as const)('%s fanout matches each of three subscribers routed alone', async mode => {
    const identities = [0, 1, 2].map(index => ({ id: `EXAMPLE_FANOUT_${index}`, key: Keypair.generate() }));
    const original: Signal = mode === 'paused'
      ? { ...flip, contracts: '0.5', sourceNotTrading: true, reduceOnlyIfRefused: 'full' }
      : { ...entry, action: 'sell', contracts: '0.4', strategyPositionSize: '0', reduceOnlyIfRefused: 'full' };
    const before = { ...original };
    const run = async (indices: number[]) => {
      const { source, orders } = setup();
      listing(mode !== 'refused-listing');
      const bots = identities.map(({ id, key }) => ({ ...routeBot, id, walletAddress: id,
        protocolSubaccountId: key.publicKey.toBase58() }));
      const byAccount = new Map(bots.map((bot, index) => [bot.protocolSubaccountId, index]));
      vi.mocked(storage.getTradingBotById).mockImplementation(async id => (bots.find(bot => bot.id === id) ?? source) as never);
      vi.mocked(storage.getWallet).mockImplementation(async walletAddress => ({ ...routeWallet, walletAddress,
        agentPublicKey: bots.find(bot => bot.walletAddress === walletAddress)?.protocolSubaccountId ?? routeWallet.agentPublicKey }) as never);
      routeMocks.decryptBotSubaccountKey.mockImplementation(async (bot: any) => ({
        secretKey: identities.find(item => item.id === bot.id)?.key.secretKey ?? routeKeypair.secretKey, cleanup: vi.fn(),
      }));
      vi.mocked(storage.getBotPosition).mockImplementation(async id => {
        const index = bots.findIndex(bot => bot.id === id);
        const size = index === 0 ? (mode === 'paused' ? 0 : 0.4) : index === 1 ? -0.4 : 0;
        return { baseSize: String(size), avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY' } as never;
      });
      const size = (account: string) => orders.has(account) ? 0 : byAccount.get(account) === 0 ? 0.4 : byAccount.get(account) === 1 ? -0.4 : 0;
      routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async (account: string) => size(account)
        ? { internalSymbol: 'BTC-PERP', baseSize: size(account), entryPrice: 64000 } : null);
      routeMocks.adapter.getPositions.mockImplementation(async (account: string) => size(account)
        ? [{ internalSymbol: 'BTC-PERP', baseSize: size(account), entryPrice: 64000 }] : []);
      let sequence = 0;
      routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => snapshot(account, ++sequence, size(account)));
      await routeSignalToSubscribers(source.id, original, indices.map(index => bots[index]) as never);
      expect(original).toEqual(before);
      expectOnlyReducingOrders(indices.includes(0) ? 1 : 0);
      return routeMocks.adapter.placeMarketOrder.mock.calls.map(([order]) => ({
        subscriber: byAccount.get(order.agentPublicKey), side: order.side, size: order.sizeBase, reduceOnly: order.reduceOnly,
      }));
    };
    const alone = await run([0]);
    alone.push(...await run([1]), ...await run([2]));
    expect(await run([0, 1, 2])).toEqual(alone);
    expect(alone).toEqual([{ subscriber: 0, side: 'short', size: 0.4, reduceOnly: true }]);
  }, 20_000);
});

describe('round6 controls', () => {
  it('active-source explicit close keeps the execution read', async () => {
    const { subscriber } = setup({ active: true, subscriber: true, subscriberSize: 0.4 });
    const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority');
    const execution = vi.spyOn(PositionService, 'getPositionForExecution');
    routeMocks.adapter.getStrictPositionForMarket.mockResolvedValue(null);
    try {
      await route(full);
      expect(execution.mock.calls.filter(([id]) => id === subscriber.id)).toHaveLength(1);
      expect(strict.mock.calls.filter(([id]) => id === subscriber.id)).toHaveLength(0);
      expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ reduceOnly: true, sizeBase: 0.4 });
    } finally { strict.mockRestore(); execution.mockRestore(); }
  });
  it.skipIf(!hasEntryAdmission)('reset clears accepted-entry test state while production guard still protects an invisible fill', async () => {
    setup({ active: true, size: 0 });
    expect(await entryAdmission!.executeSignalBotEntry(routeBot as never, async () => ({ success: true }))).toEqual({ success: true });
    expect(await entryAdmission!.pauseSignalBotIfFlat(routeBot as never, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('recently_accepted');
    entryAdmission!.resetSignalBotAcceptedEntriesForTests();
    expect(await entryAdmission!.pauseSignalBotIfFlat(routeBot as never, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('paused');
  });
});

describe.each(['tv', 'user'] as const)('round3 ownership %s', path => {
  it.each(['FULL-to-PARTIAL', 'PARTIAL-to-FULL', 'PARTIAL-to-FULL-pending'] as const)('%s uses one fresh owner through drained effects', async transition => {
    const partial = transition === 'FULL-to-PARTIAL', pending = transition.endsWith('-pending');
    const before = partial ? 0.125 : 0.5, fresh = partial ? 0.25 : 0.125;
    setup({ subscriber: true, size: fresh, remaining: partial ? 0.125 : 0, pending });
    const submit = routeMocks.adapter.placeMarketOrder.getMockImplementation()!;
    let fanoutAtSourceSubmission = -1;
    routeMocks.adapter.placeMarketOrder.mockImplementation(async (order: any) => {
      if (order.agentPublicKey === routeBot.protocolSubaccountId) fanoutAtSourceSubmission = vi.mocked(storage.getSubscriberBotsBySourceId).mock.calls.length;
      return submit(order);
    });
    const position = vi.mocked(storage.getBotPosition).getMockImplementation()!;
    let sourceReads = 0;
    vi.mocked(storage.getBotPosition).mockImplementation(async (id, market) => id === ROUTE_BOT_ID && ++sourceReads === 1
      ? { baseSize: String(before), avgEntryPrice: '64000' } as never : position(id, market));
    const created: any[] = [], store = closeIntentStore as any, originalCreate = store.create;
    const create = vi.spyOn(store, 'create').mockImplementation(async (...args: any[]) => {
      const value = await originalCreate(...args); created.push(value.intent); return value;
    });
    try {
      const result = await settledRouting(async () => {
        const response = await webhook(path, partialPayload);
        await waitForCloseEffects();
        expect(fanoutAtSourceSubmission).toBe(partial ? 0 : 1);
        return response;
      });
      expect(result.status, JSON.stringify(result.body)).toBe(pending ? 202 : 200);
      expect(sourceOrders()).toHaveLength(1); expect(sourceOrders()[0].sizeBase).toBe(0.125);
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ reduceOnly: true, sizeBase: partial ? 0.125 : 0.25 });
      const sourceIntent = created.find(intent => intent.bot_id === ROUTE_BOT_ID);
      expect(sourceIntent).toBeDefined();
      expect(sourceIntent.close_kind).toBe(partial ? 'partial' : 'full');
      if (pending) {
        const confirmed = await store.withScope(sourceIntent.environment, sourceIntent.original_account, sourceIntent.market, async (scope: any) => {
          const current = await store.byId(scope, sourceIntent.id);
          return store.settle(scope, current, { status: 'confirmed', last_evidence: { ...current.last_evidence,
            effectsPending: true, notificationPending: true, fill: { filledSize: 0.125, fillPrice: 65000, fee: 1, realizedPnl: 125 } } });
        });
        await dispatchConfirmedCloseEffects(confirmed);
      }
      await waitForCloseEffects();
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expect(subscriberOrders()).toHaveLength(1); expectOnlyReducingOrders(2);
    } finally { create.mockRestore(); }
  });
});

describe('round3 catch TradingView paused partial', () => {
  it.each(['wallet-missing', 'wallet-rejects', 'umk-rejects'] as const)('%s still reduces subscriber exactly once', async failure => {
    setup({ subscriber: true, remaining: 0.125 });
    const wallet = vi.mocked(storage.getWallet).getMockImplementation()!;
    vi.mocked(storage.getWallet).mockImplementation(async address => {
      if (address === ROUTE_WALLET && failure.startsWith('wallet')) {
        if (failure === 'wallet-rejects') throw new Error('EXAMPLE_WALLET_UNAVAILABLE');
        return undefined as never;
      }
      return wallet(address);
    });
    const umk = routeMocks.getUmkForWebhook.getMockImplementation()!;
    routeMocks.getUmkForWebhook.mockImplementation(async (...args: any[]) => {
      if (args[0] === ROUTE_WALLET && failure === 'umk-rejects') throw new Error('EXAMPLE_UMK_UNAVAILABLE');
      return umk(...args);
    });
    const result = await settledRouting(() => webhook('tv', partialPayload));
    expect(result.status).toBe(failure === 'wallet-missing' ? 404 : 500);
    expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
    expect(sourceOrders()).toHaveLength(0); expect(subscriberOrders()).toHaveLength(1);
    expect(subscriberOrders()[0]).toMatchObject({ reduceOnly: true, sizeBase: 0.125 });
  });
});

describe.skipIf(!hasEntryAdmission)('round3 pause accepted entry visibility', () => {
  it.each(['accepted', 'unconfirmed'] as const)('%s protects against racing sizing failure while both position reads stay flat', async outcome => {
    const h = entryPauseHarness(), entered = barrier(), release = barrier();
    const entry = h.executeSignalBotEntry(routeBot, async () => {
      entered.resolve(); await release.promise;
      return outcome === 'accepted' ? { success: true } : { success: false, submissionUnconfirmed: true };
    });
    await entered.promise;
    // The venue would still report flat even after the successful submission.
    expect(await h.venue.getPositionForCloseAuthority()).toEqual({ side: 'FLAT', size: 0 });
    const pause = h.pauseSignalBotIfFlat(routeBot, 'Bot underfunded: EXAMPLE', routeWallet.agentPublicKey, null, false);
    release.resolve(); await entry;
    expect(await pause).toBe('recently_accepted'); expect(h.port.active).toBe(true);
    expect(h.storagePort.getBotPosition).toHaveBeenCalledTimes(1);
    expect(h.storagePort.updateTradingBot).not.toHaveBeenCalled();
  });
  it('protects until 120 seconds then permits pause only with confirmed-flat venue truth', async () => {
    const h = entryPauseHarness(), start = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await h.executeSignalBotEntry(routeBot, async () => ({ success: true }));
      now.mockReturnValue(start + 119_999);
      expect(await h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('recently_accepted');
      now.mockReturnValue(start + 120_000);
      h.venue.getPositionForCloseAuthority.mockResolvedValueOnce({ side: 'LONG', size: 0.25 });
      expect(await h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('not_flat');
      expect(await h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('paused');
      expect(h.storagePort.updateTradingBot).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });
  it('a terminal rejection does not reserve the visibility window', async () => {
    const h = entryPauseHarness();
    await h.executeSignalBotEntry(routeBot, async () => ({ success: false, error: 'EXAMPLE_REJECTED' }));
    expect(await h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('paused');
  });
});


describe.each(['tv', 'user'] as const)('round3 pause route %s', path => {
  it.each(['accepted', 'unconfirmed'] as const)('%s entry remains protected when DB and immediate venue are flat', async outcome => {
    setup({ active: true, size: 0, remaining: 0 });
    const leverage = primeRiskSizing(), startedAt = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    if (outcome === 'unconfirmed') routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: false, landingDisposition: 'unconfirmed', error: 'EXAMPLE_PENDING' });
    try {
      const submitted = await sizingRequest(path);
      expect(sourceOrders()).toHaveLength(1);
      expect(submitted.status).toBe(outcome === 'accepted' ? 200 : 500);
      expect(await storage.getBotPosition(ROUTE_BOT_ID, routeBot.market)).toMatchObject({ baseSize: '0' });
      expect(await routeMocks.adapter.getStrictPositionForMarket(routeBot.protocolSubaccountId)).toBeNull();
      routeMocks.adapter.getAccountInfo.mockResolvedValue({ balance: 0, equity: 0, availableMargin: 0, maintenanceMargin: 0, unrealizedPnl: 0 });
      const refused = await sizingRequest(path);
      expect(refused.status).toBe(400); expect(sourceOrders()).toHaveLength(1); expectNotPaused();
      now.mockReturnValue(startedAt + 120_000);
      expect((await sizingRequest(path)).status).toBe(400); expectPaused();
      expect(sourceOrders()).toHaveLength(1);
    } finally { now.mockRestore(); leverage.mockRestore(); }
  });
});


describe.each(['tv', 'user'] as const)('round4 explicit close %s', path => {
  it.each(['paused', 'disabled', 'expired'] as const)('%s reads venue despite flat missing or same-side subscriber DB', async gate => {
    for (const dbSize of ['0', null, '-0.25']) {
      const { source, subscriber } = setup({ active: gate !== 'paused', subscriber: true });
      vi.mocked(storage.getBotPosition).mockImplementation(async id => id === subscriber.id
        ? (dbSize === null ? null : { baseSize: dbSize, avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY' }) as never
        : { baseSize: '0.25', avgEntryPrice: '64000', lastTradeId: 'EXAMPLE_ENTRY' } as never);
      if (gate !== 'paused') vi.mocked(storage.getWallet).mockImplementation(async address => ({ ...routeWallet,
        agentPublicKey: address === subscriber.walletAddress ? subscriberKey : routeWallet.agentPublicKey,
        executionEnabled: address === source.walletAddress ? gate !== 'disabled' : true,
        executionExpiresAt: address === source.walletAddress && gate === 'expired' ? new Date(Date.now() - 1000) : null,
      }) as never);
      if (path === 'user' && gate !== 'paused') {
        const result = await webhook(path, closePayload);
        expect(result.status).toBe(403); expect(subscriberOrders()).toHaveLength(0); continue;
      }
      await settledRouting(() => webhook(path, { ...closePayload, data: { secret: 'EXAMPLE_NESTED' } }));
      expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ side: 'short', sizeBase: 0.25, reduceOnly: true });
      if (gate === 'paused') {
        const logged = vi.mocked(storage.createWebhookLog).mock.calls[0][0];
        expect(logged.payload).not.toHaveProperty('secret');
        expect((logged.payload as any).data).toEqual({ secret: 'EXAMPLE_NESTED' });
      }
    }
  });
});

// Execute the production submission statements, retaining their actual admission wiring.
// Imports/identity/preflight/accounting stay covered by the route and retry owning suites.
function retrySubmission(path: 'manual' | 'background', h: ReturnType<typeof entryPauseHarness>, submit: () => Promise<any>, reduceOnly = false) {
  const source = readFileSync(path === 'manual' ? 'server/routes.ts' : 'server/trade-retry-service.ts', 'utf8');
  let body: string;
  if (path === 'manual') {
    const start = source.indexOf('const result = await ', source.indexOf('app.post("/api/trades/:tradeId/retry"'));
    const parsed = ts.createSourceFile('retry.ts', source.slice(start), ts.ScriptTarget.Latest, true);
    body = parsed.statements[0].getText(parsed);
  } else {
    const start = source.indexOf('const submitRetryEntry = () => driftExecutePerpOrder(');
    if (start >= 0) {
      const end = source.indexOf('await executeSignalBotEntry({ id: job.botId }, submitRetryEntry);', start)
        + 'await executeSignalBotEntry({ id: job.botId }, submitRetryEntry);'.length;
      body = 'let result; ' + source.slice(source.lastIndexOf('const retrySide = job.side;', start), end);
    } else {
      const start = source.indexOf('result = await driftExecutePerpOrder(', source.indexOf('async function processRetryJob('));
      const parsed = ts.createSourceFile('retry.ts', source.slice(start), ts.ScriptTarget.Latest, true);
      body = 'let result; ' + parsed.statements[0].getText(parsed);
    }
  }
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('ports', `return async () => {
    const {executeSignalBotEntry,executePerpOrder,driftExecutePerpOrder,bot,job,wallet,getAdapterForBot} = ports;
    const retryAgentSecret = null, agentSecretKey = null, market = bot.market, isLong = true, size = 0.25;
    const retryBotCtx = null, privateKeyBase58 = 'EXAMPLE', walletAddress = bot.walletAddress, jobAdapter = null;
    ${code}
    return result;
  };`)({ executeSignalBotEntry: h.executeSignalBotEntry, executePerpOrder: submit, driftExecutePerpOrder: submit,
    bot: routeBot, job: { botId: routeBot.id, market: routeBot.market, side: 'long', size: 0.25, reduceOnly },
    wallet: routeWallet, getAdapterForBot: () => null });
}

describe.skipIf(!hasEntryAdmission).each(['manual', 'background'] as const)('round4 retry %s', path => {
  it('entry first excludes auto-pause while submission is pending and then invisible', async () => {
    const h = entryPauseHarness(), entered = barrier(), release = barrier();
    const submit = vi.fn(async () => { entered.resolve(); await release.promise; return { success: true }; });
    const entry = retrySubmission(path, h, submit)(); await entered.promise;
    const pause = h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false);
    await Promise.resolve(); await Promise.resolve();
    try { expect(h.storagePort.getBotPosition).not.toHaveBeenCalled(); }
    finally { release.resolve(); await entry; await pause; }
    expect(await pause).toBe('recently_accepted'); expect(h.port.active).toBe(true);
    expect(await h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('recently_accepted');
    expect(h.storagePort.updateTradingBot).not.toHaveBeenCalled();
  });
  it('pause first blocks retry and rejects it after the active check', async () => {
    const h = entryPauseHarness(), proving = barrier(), release = barrier();
    h.venue.getPositionForCloseAuthority.mockImplementation(async () => { proving.resolve(); await release.promise; return { side: 'FLAT', size: 0 }; });
    const pause = h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false); await proving.promise;
    const submit = vi.fn(async () => ({ success: true })); const entry = retrySubmission(path, h, submit)();
    await Promise.resolve(); await Promise.resolve();
    try { expect(submit).not.toHaveBeenCalled(); }
    finally { release.resolve(); await pause; await entry; }
    expect(await pause).toBe('paused'); expect(await entry).toEqual({ success: false, error: 'Bot is paused' });
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([false, true])('accepted or unconfirmed retry keeps the invisible-fill marker (%s)', async unconfirmed => {
    const h = entryPauseHarness();
    await retrySubmission(path, h, async () => ({ success: !unconfirmed, submissionUnconfirmed: unconfirmed }))();
    expect(await h.pauseSignalBotIfFlat(routeBot, 'EXAMPLE', routeWallet.agentPublicKey, null, false)).toBe('recently_accepted');
    expect(h.storagePort.updateTradingBot).not.toHaveBeenCalled();
  });
});
it.skipIf(!hasEntryAdmission)('round4 retry background reduce-only bypasses an entry lock', async () => {
  const h = entryPauseHarness(), entered = barrier(), release = barrier();
  const entry = h.executeSignalBotEntry(routeBot, async () => { entered.resolve(); await release.promise; return { success: true }; });
  await entered.promise;
  const submit = vi.fn(async () => ({ success: true }));
  try { expect(await retrySubmission('background', h, submit, true)()).toEqual({ success: true }); }
  finally { release.resolve(); await entry; }
  expect(submit).toHaveBeenCalledTimes(1);
});
it('round4 retry propagates typed and legacy unconfirmed landing evidence', () => {
  const source = readFileSync('server/trade-retry-service.ts', 'utf8');
  expect(source).toContain('submissionUnconfirmed: isUnconfirmedLandingResult(orderResult)');
});

describe.skipIf(!hasEntryAdmission)('round9 helper account authority', () => {
  it.each([0.25, 0])('reads the error-state subaccount with null context and size %s before pausing', async size => {
    const { source } = setup({ active: true, size: 0 });
    const mainAccount = Keypair.generate().publicKey.toBase58();
    source.subaccountStatus = 'error';
    routeMocks.adapter.getStrictPositionForMarket.mockImplementation(async (account: string) =>
      account === source.protocolSubaccountId && size !== 0
        ? { internalSymbol: source.market, baseSize: size, entryPrice: 64000 }
        : null);
    expect(mainAccount).not.toBe(source.protocolSubaccountId);
    expect(await storage.getBotPosition(source.id, source.market)).toMatchObject({ baseSize: '0' });
    expect(await routeMocks.adapter.getStrictPositionForMarket(mainAccount)).toBeNull();
    routeMocks.adapter.getStrictPositionForMarket.mockClear();

    expect(await entryAdmission!.pauseSignalBotIfFlat(source as never, 'EXAMPLE', mainAccount, null, false)).toBe(size === 0 ? 'paused' : 'not_flat');
    expect(routeMocks.adapter.getStrictPositionForMarket).toHaveBeenCalledTimes(1);
    expect(routeMocks.adapter.getStrictPositionForMarket).toHaveBeenCalledWith(source.protocolSubaccountId, source.market, undefined);
    if (size === 0) {
      expect(storage.updateTradingBot).toHaveBeenCalledTimes(1);
      expect(storage.updateTradingBot).toHaveBeenCalledWith(source.id, { isActive: false, pauseReason: 'EXAMPLE' });
    } else {
      expect(storage.updateTradingBot).not.toHaveBeenCalled();
    }
    expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasEntryAdmission)('round8 discriminating queued entry authority', () => {
  it.each(['emergency-stop', 'disabled', 'expired'] as const)('%s during lock wait produces zero adapter orders', async gate => {
    const { source } = setup({ active: true, size: 0 });
    const start = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const wallet = { ...routeWallet, emergencyStopTriggered: false, executionEnabled: true, executionExpiresAt: new Date(start + 60_000) };
    vi.mocked(storage.getWallet).mockResolvedValue(wallet as never);
    const entered = barrier(), release = barrier();
    const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority').mockImplementation(async () => {
      entered.resolve(); await release.promise; return { side: 'LONG', size: 0.25 } as never;
    });
    const pause = entryAdmission!.pauseSignalBotIfFlat(source as never, 'EXAMPLE', routeWallet.agentPublicKey, null, false);
    await entered.promise;
    const submit = vi.fn(async () => routeMocks.adapter.placeMarketOrder({ agentPublicKey: source.protocolSubaccountId, sizeBase: 0.25, reduceOnly: false }));
    const queued = entryAdmission!.executeSignalBotEntry(source as never, submit);
    try {
      expect(storage.getWallet).not.toHaveBeenCalled();
      if (gate === 'emergency-stop') wallet.emergencyStopTriggered = true;
      if (gate === 'disabled') wallet.executionEnabled = false;
      if (gate === 'expired') now.mockReturnValue(start + 60_001);
      release.resolve();
      expect(await pause).toBe('not_flat');
      expect(await queued).toMatchObject({ success: false, error: expect.stringMatching(gate === 'emergency-stop' ? /Emergency stop/ : gate === 'disabled' ? /disabled/ : /expired/) });
      expect(storage.getWallet).toHaveBeenCalledWith(source.walletAddress);
      expect(submit).not.toHaveBeenCalled();
      expect(routeMocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
    } finally { release.resolve(); await Promise.allSettled([pause, queued]); strict.mockRestore(); now.mockRestore(); }
  });
});

describe.each(['tv', 'user'] as const)('round8 discriminating pending partial ownership %s', path => {
  it('409 CLOSE_IN_PROGRESS defers fanout to the first pending intent and closes the subscriber once', async () => {
    const { source } = setup({ subscriber: true, subscriberSize: 0.4, remaining: 0.2, pending: true });
    let logNumber = 0;
    vi.mocked(storage.createWebhookLog).mockImplementation(async () => ({ id: `EXAMPLE_WEBHOOK_${++logNumber}` }) as never);
    const created: any[] = [], store = closeIntentStore as any, originalCreate = store.create;
    const create = vi.spyOn(store, 'create').mockImplementation(async (...args: any[]) => {
      const value = await originalCreate(...args); created.push(value.intent); return value;
    });
    try {
      const first = await webhook(path, partialPayload);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      await waitForCloseEffects();
      expect(sourceOrders()).toHaveLength(1); expect(subscriberOrders()).toHaveLength(0);
      const second = await webhook(path, { ...partialPayload, timestamp: 'EXAMPLE_SECOND_ALERT' });
      expect(second.status, JSON.stringify(second.body)).toBe(409);
      expect(second.body.error).toBe(CLOSE_IN_PROGRESS);
      await waitForCloseEffects();
      expect(storage.getSubscriberBotsBySourceId).not.toHaveBeenCalled();
      const sourceIntent = created.find(intent => intent.bot_id === source.id);
      expect(sourceIntent).toBeDefined();
      const confirmed = await store.withScope(sourceIntent.environment, sourceIntent.original_account, sourceIntent.market, async (scope: any) => {
        const current = await store.byId(scope, sourceIntent.id);
        return store.settle(scope, current, { status: 'confirmed', last_evidence: { ...current.last_evidence,
          effectsPending: true, notificationPending: true,
          fill: { filledSize: 0.125, fillPrice: 65000, fee: 1, realizedPnl: 125 } } });
      });
      await dispatchConfirmedCloseEffects(confirmed);
      await dispatchConfirmedCloseEffects(confirmed);
      await waitForCloseEffects();
      expect(sourceOrders()).toHaveLength(1); expect(subscriberOrders()).toHaveLength(1);
      expect(subscriberOrders()[0]).toMatchObject({ side: 'short', reduceOnly: true, sizeBase: 0.2 });
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledTimes(1);
      expectOnlyReducingOrders(2);
    } finally { create.mockRestore(); }
  });
});
