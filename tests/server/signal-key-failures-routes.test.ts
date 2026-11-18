import { Keypair } from '@solana/web3.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const keyWarningModule='../../shared/signal-key-failures';
const signalKeyFailureWarning=existsSync('shared/signal-key-failures.ts')?(await import(keyWarningModule)).signalKeyFailureWarning:()=>'';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import * as durableClose from '../../server/trading/signal-bot-close-intent';
import * as closeEffects from '../../server/trading/signal-bot-close-intent-effects';
import { observeCloseIntent } from '../../server/trading/signal-bot-close-intent-worker';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
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
    prepareReduceOnlyMarketOrder: vi.fn<(...args: any[]) => Promise<any>>(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  },
  notify: vi.fn(async (_owner: string, _message: any, _options?: { signal?: AbortSignal; throwOnDeliveryError?: boolean }) => true),
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
  routeMocks.notify.mockReset().mockResolvedValue(true);
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
// Stateful storage ports exercise the real routes and pause lock. SQL concurrency is tested separately.
function keySetup(size = 0, claimNow = Date.now) {
  const { source, subscriber, orders } = setup({ active: true, size });
  const bot = source as any; bot.stats = {};
  const wallet = { ...routeWallet, address: ROUTE_WALLET } as any;
  vi.mocked(storage.getPublishedBotByTradingBotId).mockResolvedValue(undefined);
  vi.mocked(storage.getWallet).mockResolvedValue(wallet);
  let generation = 0;
  // Preserve round-1's eager-alert storage contract in its negative control.
  const leaseBound = readFileSync('server/storage.ts','utf8').includes('claimedAt ?? null');
  const usesClaimLease = readFileSync('server/storage.ts','utf8').includes("jsonb_build_object('claimedAt'");
  vi.mocked(storage.incrementSignalKeyFailure).mockImplementation(async (_id, kind) => {
    if (!bot.isActive || ['phoenix','flash'].includes(bot.activeProtocol)) return undefined;
    const prev = bot.stats.signalKeyFailures;
    const streak = { ...prev, count: (prev?.count ?? 0) + 1, kind,
      firstAt: prev?.firstAt ?? new Date(++generation).toISOString(), lastAt: new Date().toISOString(), alertedAt: prev?.alertedAt ?? null };
    bot.stats.signalKeyFailures = streak; return { ...streak };
  });
  vi.mocked(storage.clearSignalKeyFailures).mockImplementation(async () => {
    const owed=bot.stats.signalKeyFailures?.outcome==='paused'&&!bot.stats.signalKeyFailures.alertedAt;
    if (!owed || !readFileSync('server/storage.ts','utf8').includes("COALESCE(stats->'signalKeyFailures'->>'outcome', '') = 'paused'")) delete bot.stats.signalKeyFailures;
  });
  vi.mocked(storage.claimSignalKeyFailureAlert).mockImplementation(async (_id, firstAt) => {
    const streak = bot.stats.signalKeyFailures;
    const now = claimNow();
    if (!bot.isActive || !streak || streak.firstAt !== firstAt || streak.count < 3
      || (streak.alertedAt && Date.parse(streak.alertedAt) >= now - 86_400_000)
      || (usesClaimLease && streak.claimedAt && !streak.outcome && Date.parse(streak.claimedAt) >= now - 120_000)) return false;
    if (!usesClaimLease) { streak.alertedAt = new Date(now).toISOString(); return true as never; }
    streak.outcome = null; streak.claimedAt = new Date(now).toISOString(); return streak.claimedAt;
  });
  let refreshClock = Date.now();
  vi.mocked(storage.refreshSignalKeyFailureAlert).mockImplementation(async (_id, firstAt, claimedAt, requireActive) => {
    const streak = bot.stats.signalKeyFailures;
    if ((requireActive && !bot.isActive) || !streak || streak.firstAt !== firstAt || streak.claimedAt !== claimedAt) return false;
    return streak.claimedAt = new Date(++refreshClock).toISOString();
  });
  vi.mocked(storage.setSignalKeyFailurePauseOutcome).mockImplementation(async (_id, firstAt, outcome, claimedAt) => {
    if (!usesClaimLease) {
      if (!bot.isActive || bot.stats.signalKeyFailures?.firstAt !== firstAt) return false;
      bot.stats.signalKeyFailures.pauseOutcome = outcome; return true;
    }
    if ((!bot.isActive && outcome !== 'paused' && outcome !== 'already_paused') || bot.stats.signalKeyFailures?.firstAt !== firstAt
      || bot.stats.signalKeyFailures.claimedAt !== claimedAt) return false;
    Object.assign(bot.stats.signalKeyFailures, { outcome, alertedAt: new Date().toISOString() }); return true;
  });
  vi.mocked(storage.pauseActiveSignalBot).mockImplementation(async (_id, reason, firstAt, claimedAt) => {
    if (!bot.isActive || (firstAt && (bot.stats.signalKeyFailures?.firstAt !== firstAt || (leaseBound && bot.stats.signalKeyFailures?.claimedAt !== claimedAt)))) return undefined;
    bot.isActive = false; bot.pauseReason = reason;
    if (leaseBound && firstAt) Object.assign(bot.stats.signalKeyFailures, { outcome:'paused', alertedAt:null });
    return { ...bot };
  });
  vi.mocked(storage.reclaimPausedSignalKeyFailureNotice).mockImplementation(async () => {
    const streak = bot.stats.signalKeyFailures;
    if (bot.isActive || streak?.outcome !== 'paused' || streak.alertedAt || Date.parse(streak.claimedAt) >= Date.now()-120_000) return undefined;
    streak.claimedAt = new Date().toISOString(); return { ...streak };
  });
  vi.mocked(storage.updateTradingBot).mockImplementation(async (_id, fields) => {
    Object.assign(bot, fields); if (fields.isActive === true) delete bot.stats.signalKeyFailures; return bot;
  });
  return { bot, wallet, subscriber, orders };
}
const entryPayload = { action: 'buy', contracts: '0.1', position_size: '0.1', price: '1000' };
const keyAlerts = () => routeMocks.notify.mock.calls.filter(([, message]) => message.type === 'bot_paused');
const failKey = () => routeMocks.decryptBotSubaccountKey.mockResolvedValue(null);
async function repeat(path: Webhook, n: number, payload = entryPayload) { for (let i=0;i<n;i++) await webhook(path,payload); }

// Exercise the real signed HTTP sender; admission/storage remain the existing route ports.
async function realCloseSender(status: number | 'transport' | 'ECONNREFUSED', unreadable = false) {
  pacificaQuota.resetCounters();
  const adapter = new PacificaAdapter({baseUrl:'http://pacifica.test'});
  const originalFetch = globalThis.fetch;
  const posts: Record<string,unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('http://pacifica.test/')) {
      posts.push(JSON.parse(String(init?.body)));
      if (typeof status === 'string') throw Object.assign(new Error('EXAMPLE_TRANSPORT'), {cause:{code:status==='ECONNREFUSED'?status:'ECONNRESET'}});
      const response = new Response('EXAMPLE_REJECTION', {status});
      if (unreadable) vi.spyOn(response,'text').mockRejectedValue(new Error('EXAMPLE_BODY_READ'));
      return response;
    }
    return originalFetch(input, init);
  }));
  const prepared = routeMocks.adapter.prepareReduceOnlyMarketOrder;
  const send = (routeMocks.adapter as any).sendPreparedReduceOnlyMarketOrder;
  (routeMocks.adapter as any).getCloseEnvironment = () => 'http://pacifica.test';
  const readSnapshot = routeMocks.adapter.getCloseConfirmationSnapshot.getMockImplementation()!;
  routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (...args: any[]) => {
    const result = await readSnapshot(...args);
    return {...result,evidence:{...result.evidence,environment:'http://pacifica.test'}};
  });
  routeMocks.adapter.prepareReduceOnlyMarketOrder = vi.fn(async (...args: any[]) => Object.assign(await prepared(...args), {environment:'http://pacifica.test'}));
  (routeMocks.adapter as any).sendPreparedReduceOnlyMarketOrder = async (order: any, attempt: any, key: Uint8Array) =>
    order.account === routeKeypair.publicKey.toBase58()
      ? adapter.sendPreparedReduceOnlyMarketOrder(order, attempt, key) : send(order, attempt, key);
  return {adapter,posts, close:async()=>{vi.unstubAllGlobals();await adapter.shutdown();}};
}
afterEach(()=>vi.unstubAllGlobals());

describe.each(['tv','user'] as const)('SB01 route %s', path => {
  describe.each(['subaccount_key', 'venue_auth_rejected'] as const)('r9.superseded.claim.%s', kind => {
    it.each(['reread', 'refresh'] as const)('%s.sends.no.fallback', async exit => {
      let clock = Date.now();
      const { bot } = keySetup(0, () => clock);
      const leverage = primeRiskSizing();
      if (kind === 'subaccount_key') failKey();
      else routeMocks.adapter.placeMarketOrder.mockResolvedValue({
        success: false, status: 'rejected', landingDisposition: 'terminal',
        venue: 'pacifica', httpStatus: 401, keyFailureKind: kind, error: 'EXAMPLE_AUTH',
      });

      const noticeTypes = () => routeMocks.notify.mock.calls.map(([, message]) => message.type);
      const claim = vi.mocked(storage.claimSignalKeyFailureAlert);
      const refresh = vi.mocked(storage.refreshSignalKeyFailureAlert);
      const read = vi.mocked(storage.getTradingBotById);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => enter = resolve);
      const held = new Promise<void>(resolve => release = resolve);
      const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority')
        .mockResolvedValue({ side: 'FLAT', size: 0, source: 'on-chain', entryPrice: 0 })
        .mockImplementationOnce(async () => {
          // A leaves the entry lock without pausing. B can then prove flat and pause.
          if (exit === 'reread') {
            const readBot = read.getMockImplementation()!;
            read.mockImplementationOnce(async (...args) => {
              enter();
              await held;
              return readBot(...args);
            });
          }
          return { side: 'LONG', size: 1, source: 'on-chain', entryPrice: 1000 };
        });
      if (exit === 'refresh') {
        const refreshLease = refresh.getMockImplementation()!;
        refresh.mockImplementationOnce(async (...args) => {
          enter();
          await held;
          return refreshLease(...args);
        });
      }

      let a: ReturnType<typeof webhook> | undefined;
      try {
        await repeat(path, 2);
        expect(noticeTypes()).toEqual(['trade_failed', 'trade_failed']);
        expect(claim).not.toHaveBeenCalled();
        routeMocks.notify.mockClear();
        a = webhook(path, entryPayload);
        await Promise.race([entered, a.then(() => expect.fail(`A did not reach the lease ${exit}`))]);
        expect(claim).toHaveBeenCalledTimes(1);
        const leaseA = await claim.mock.results[0].value;
        expect(leaseA).toBe(new Date(clock).toISOString());
        expect(bot.stats.signalKeyFailures).toMatchObject({ count: 3, kind, claimedAt: leaseA });

        clock += 120_001;
        expect((await webhook(path, entryPayload)).status).toBe(500);
        expect(claim).toHaveBeenCalledTimes(2);
        expect(await claim.mock.results[1].value).toBe(new Date(clock).toISOString());
        expect(bot.isActive).toBe(false);
        expect(bot.stats.signalKeyFailures).toMatchObject({ count: 4, outcome: 'paused', alertedAt: expect.any(String) });
        expect(noticeTypes()).toEqual(['bot_paused']);

        release();
        expect((await a).status).toBe(500);
        expect(refresh).toHaveBeenCalledTimes(exit === 'refresh' ? 2 : 1);
        if (exit === 'refresh') expect(await refresh.mock.results[0].value).toBe(false);
        expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledTimes(1);
        expect(noticeTypes()).toEqual(['bot_paused']);
      } finally {
        release();
        await a;
        strict.mockRestore();
        leverage.mockRestore();
      }
    });
  });

  it('r8.expiry.cleanup.precedes.held.tracker.and.preserves.fresh.authorization', async () => {
    const {wallet}=keySetup();
    vi.mocked(storage.updateWalletExecution).mockImplementation(async (_id, fields) => Object.assign(wallet, fields));
    const expire=()=>Object.assign(wallet,{executionEnabled:true,executionExpiresAt:new Date(0),umkEncryptedForExecution:'EXAMPLE_EXPIRED'});
    for(let i=0;i<2;i++){expire();await webhook(path,entryPayload);}
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
    const strict=vi.spyOn(PositionService,'getPositionForCloseAuthority').mockImplementation(async()=>{entered();await held;return {side:'FLAT',size:0,source:'on-chain',entryPrice:0};});
    expire();const request=webhook(path,entryPayload);
    const fresh={executionEnabled:true,executionExpiresAt:new Date(Date.now()+86_400_000),umkEncryptedForExecution:'EXAMPLE_FRESH'};
    try{
      await Promise.race([started,request.then(()=>expect.fail('third expiry must reach transition check'))]);
      Object.assign(wallet,fresh);release();
      expect(await request).toEqual({status:403,body:{error:'Trade execution authorization expired. Please re-enable automated trading.'}});
      expect(wallet).toMatchObject(fresh);expect(storage.updateWalletExecution).toHaveBeenCalledTimes(3);
      expect(sourceOrders()).toHaveLength(0);
    }finally{release();await request;strict.mockRestore();}
  });
  describe.each(['entry','full','partial'] as const)('r8.late.agent.missing.%s', kind => {
    it.each(kind==='partial'?['agentPublicKey'] as const:path==='user'&&kind==='entry'?['agentPrivateKeyEncryptedV3'] as const:['agentPublicKey','agentPrivateKeyEncryptedV3'] as const)('%s.counts.three.with.unchanged.refusal',async field=>{
      const {bot,wallet}=keySetup(kind==='entry'?0:.25);const leverage=primeRiskSizing();
      let decrypted=false;
      routeMocks.decryptAgentKeyStrict.mockImplementation(async()=>{decrypted=true;return {secretKey:routeKeypair.secretKey,cleanup:vi.fn()};});
      vi.mocked(storage.getWallet).mockImplementation(async()=>decrypted?{...wallet,[field]:null}:wallet);
      const payload=kind==='entry'?entryPayload:kind==='full'?closePayload:partialPayload;
      try{
        for(let i=0;i<3;i++){
          decrypted=false;
          const response=await webhook(path,payload);
          expect(response).toEqual({status:400,body:{error:'Agent wallet not configured'}});
          expect(decrypted).toBe(true);
          expect(bot.stats.signalKeyFailures).toMatchObject({count:i+1,kind:'agent_missing'});
        }
        expect(routeMocks.decryptAgentKeyStrict).toHaveBeenCalledTimes(3);expect(keyAlerts()).toHaveLength(1);
        expect(bot.isActive).toBe(true);expect(sourceOrders()).toHaveLength(0);
        const errorMessage=kind==='partial'?'No agent wallet for partial close':kind==='full'?'Agent wallet not configured for close':'Agent wallet not configured';
        expect(storage.updateWebhookLog).toHaveBeenCalledWith(expect.anything(),{errorMessage,processed:true});
      }finally{leverage.mockRestore();}
    });
  });
  it('r7.stale.A.leaves.B.lease.live.and.B.sends.once', async () => {
    const {bot,wallet}=keySetup();wallet.executionEnabled=false;await repeat(path,2);
    const claim=vi.mocked(storage.claimSignalKeyFailureAlert);const originalClaim=claim.getMockImplementation()!;
    let clock=Date.now();claim.mockImplementation(async (...args)=>{
      const result=await originalClaim(...args);
      if(!result)return result;
      return bot.stats.signalKeyFailures.claimedAt=new Date(++clock).toISOString();
    });
    let enterA!:()=>void,enterB!:()=>void,releaseA!:()=>void,releaseB!:()=>void;
    const enteredA=new Promise<void>(resolve=>enterA=resolve),enteredB=new Promise<void>(resolve=>enterB=resolve);
    const heldA=new Promise<void>(resolve=>releaseA=resolve),heldB=new Promise<void>(resolve=>releaseB=resolve);
    let checks=0;const strict=vi.spyOn(PositionService,'getPositionForCloseAuthority').mockImplementation(async()=>{
      if(++checks===1){enterA();await heldA;}else{enterB();await heldB;}
      return {side:'LONG',size:1} as never;
    });
    const a=webhook(path,entryPayload);let b:ReturnType<typeof webhook>|undefined;
    try {
      await Promise.race([enteredA,a.then(()=>expect.fail('missing A flat check'))]);
      bot.stats.signalKeyFailures.claimedAt=new Date(Date.now()-121_000).toISOString();
      b=webhook(path,entryPayload);
      await vi.waitFor(()=>expect(claim.mock.results.filter(r=>r.type==='return')).toHaveLength(2));
      const leaseB=bot.stats.signalKeyFailures.claimedAt;
      releaseA();await a;await enteredB;
      expect(bot.stats.signalKeyFailures.claimedAt).toBe(leaseB);
      expect(bot.stats.signalKeyFailures.outcome).toBeNull();expect(keyAlerts()).toHaveLength(0);
      expect(storage.setSignalKeyFailurePauseOutcome).not.toHaveBeenCalled();
      await webhook(path,entryPayload); // C cannot claim during B's live lease.
      expect(bot.stats.signalKeyFailures.claimedAt).toBe(leaseB);expect(checks).toBe(2);
      releaseB();await b;
      expect(keyAlerts()).toHaveLength(1);expect(bot.stats.signalKeyFailures).toMatchObject({outcome:'not_flat',alertedAt:expect.any(String)});
      expect(storage.refreshSignalKeyFailureAlert).toHaveBeenCalledWith(bot.id,bot.stats.signalKeyFailures.firstAt,leaseB,expect.any(Boolean));
      expect(bot.stats.signalKeyFailures.claimedAt).not.toBe(leaseB);
      expect(storage.setSignalKeyFailurePauseOutcome).toHaveBeenCalledWith(bot.id,bot.stats.signalKeyFailures.firstAt,'not_flat',bot.stats.signalKeyFailures.claimedAt);
    }finally{releaseA();releaseB();await a;if(b)await b;strict.mockRestore();}
  });
  it('r7.owner.pause.during.flat.check.completes.silently', async () => {
    const {bot,wallet}=keySetup();wallet.executionEnabled=false;await repeat(path,2);
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
    const strict=vi.spyOn(PositionService,'getPositionForCloseAuthority').mockImplementation(async()=>{enter();await held;return {side:'LONG',size:1} as never;});
    const request=webhook(path,entryPayload);
    try {await Promise.race([entered,request.then(()=>expect.fail('missing flat check'))]);bot.isActive=false;release();await request;
      expect(keyAlerts()).toHaveLength(0);expect(bot.stats.signalKeyFailures).toMatchObject({outcome:'already_paused',alertedAt:expect.any(String)});
      expect(storage.pauseActiveSignalBot).not.toHaveBeenCalled();
    }finally{release();await request;strict.mockRestore();}
  });
  it.each([401,403,422])('r7.unreadable.entry.%s.neither.counts.nor.clears',async status=>{
    const {bot}=keySetup(.25);const leverage=primeRiskSizing();failKey();await repeat(path,2);
    routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
    const sender=await realCloseSender(status,true);
    // Keep the existing route's preparation port and execute the actual HTTP sender.
    routeMocks.adapter.placeMarketOrder.mockImplementation(async order=>(sender.adapter as any).postRiskIncreasingMarketOrder('/orders/create_market',order,order.clientOrderId));
    try {await webhook(path,entryPayload);expect(sender.posts).toHaveLength(1);expect(bot.stats.signalKeyFailures.count).toBe(2);
      expect(keyAlerts()).toHaveLength(0);expect(storage.clearSignalKeyFailures).not.toHaveBeenCalled();
      failKey();await webhook(path,entryPayload);expect(bot.stats.signalKeyFailures.count).toBe(3);expect(keyAlerts()).toHaveLength(1);
    }finally{await sender.close();leverage.mockRestore();}
  });
  describe.each([401,403,422])('r7.unreadable.close.%s',status=>{
    it.each(['full','partial','flip'] as const)('%s.neither.counts.nor.clears',async kind=>{
      const {bot}=keySetup(.25);const leverage=primeRiskSizing();failKey();await repeat(path,2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
      const sender=await realCloseSender(status,true);
      try {await webhook(path,kind==='partial'?partialPayload:kind==='flip'?{...entryPayload,action:'sell',position_size:'-0.1'}:closePayload);
        expect(sender.posts).toHaveLength(1);expect(bot.stats.signalKeyFailures.count).toBe(2);expect(keyAlerts()).toHaveLength(0);
        failKey();await webhook(path,entryPayload);expect(bot.stats.signalKeyFailures.count).toBe(3);expect(keyAlerts()).toHaveLength(1);
      }finally{await sender.close();leverage.mockRestore();}
    });
  });
  it.each(['paused','not_flat'] as const)('r2.one.message.broken.subaccount.%s', async outcome => {
    const { bot } = keySetup(outcome === 'not_flat' ? .25 : 0); const leverage = primeRiskSizing();
    try {
      failKey(); await repeat(path, 2); routeMocks.notify.mockClear();
      await webhook(path, entryPayload);
      expect(bot.isActive).toBe(outcome !== 'paused');
      expect(routeMocks.notify).toHaveBeenCalledTimes(1);
      expect(routeMocks.notify).toHaveBeenCalledWith(ROUTE_WALLET, expect.objectContaining({ type: 'bot_paused' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(routeMocks.notify.mock.calls.some(([, message]) => message.type === 'trade_failed')).toBe(false);
    } finally { leverage.mockRestore(); }
  });
  it.each(['paused','not_flat'] as const)('r2.crash.after.claim.recovers.%s', async outcome => {
    const { bot, wallet } = keySetup(outcome === 'not_flat' ? .25 : 0); wallet.executionEnabled = false;
    for (let i=0;i<3;i++) await storage.incrementSignalKeyFailure(bot.id, 'execution_disabled');
    await storage.claimSignalKeyFailureAlert(bot.id, bot.stats.signalKeyFailures.firstAt);
    expect(bot.stats.signalKeyFailures.alertedAt).toBeNull();
    bot.stats.signalKeyFailures.claimedAt = new Date(Date.now() - 120_001).toISOString();
    await webhook(path, entryPayload);
    expect(bot.isActive).toBe(outcome !== 'paused'); expect(keyAlerts()).toHaveLength(1);
    expect(bot.stats.signalKeyFailures.outcome).toBe(outcome);
  });
  it('r2.young.claim.is.not.reclaimed', async () => {
    const { bot, wallet } = keySetup(); wallet.executionEnabled = false;
    for (let i=0;i<3;i++) await storage.incrementSignalKeyFailure(bot.id, 'execution_disabled');
    await storage.claimSignalKeyFailureAlert(bot.id, bot.stats.signalKeyFailures.firstAt);
    await webhook(path, entryPayload);
    expect(bot.isActive).toBe(true); expect(keyAlerts()).toHaveLength(0);
    expect(bot.stats.signalKeyFailures.alertedAt).toBeNull();
  });
  it.each([401,403])('r2.venue.auth.%s.counts.and.never.clears', async httpStatus => {
    const { bot } = keySetup(.25); const leverage = primeRiskSizing();
    try {
      failKey(); await repeat(path, 2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
      routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success:false, status:'rejected', landingDisposition:'terminal',
        venue:'pacifica', httpStatus, keyFailureKind:'venue_auth_rejected', error:'EXAMPLE_AUTH' });
      await webhook(path, entryPayload);
      expect(bot.stats.signalKeyFailures.count).toBe(3); expect(bot.stats.signalKeyFailures.kind).toBe('venue_auth_rejected');
      expect(keyAlerts()).toHaveLength(1); expect(storage.clearSignalKeyFailures).not.toHaveBeenCalled();
      routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success:false, status:'rejected', landingDisposition:'terminal',
        venue:'pacifica', httpStatus:422, error:'EXAMPLE_NON_AUTH_REJECTION' });
      await webhook(path, entryPayload); expect(bot.stats.signalKeyFailures).toBeUndefined();
    } finally { leverage.mockRestore(); }
  });
  it('r2.venue.auth.401.pauses.flat', async () => {
    const { bot } = keySetup(); const leverage = primeRiskSizing();
    try {
      failKey(); await repeat(path, 2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
      routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success:false, status:'rejected', landingDisposition:'terminal',
        venue:'pacifica', httpStatus:401, keyFailureKind:'venue_auth_rejected', error:'EXAMPLE_AUTH' });
      await webhook(path, entryPayload); expect(bot.isActive).toBe(false); expect(keyAlerts()).toHaveLength(1);
    } finally { leverage.mockRestore(); }
  });
  it.each([401,403])('r2.agent.key.venue.auth.%s.never.clears', async httpStatus => {
    const { bot } = keySetup(.25); const leverage = primeRiskSizing();
    bot.subaccountAuthMode = null; bot.protocolSubaccountId = null;
    try {
      routeMocks.decryptAgentKeyStrict.mockResolvedValue(null); await repeat(path,2);
      expect(bot.stats.signalKeyFailures.count).toBe(2);
      routeMocks.decryptAgentKeyStrict.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
      routeMocks.adapter.placeMarketOrder.mockResolvedValue({success:false,status:'rejected',landingDisposition:'terminal',venue:'pacifica',httpStatus,keyFailureKind:'venue_auth_rejected',error:'EXAMPLE_AUTH'});
      await webhook(path,entryPayload);
      expect(bot.stats.signalKeyFailures?.count).toBe(3);expect(bot.stats.signalKeyFailures?.kind).toBe('venue_auth_rejected');
      expect(storage.clearSignalKeyFailures).not.toHaveBeenCalled();expect(keyAlerts()).toHaveLength(1);
    } finally {leverage.mockRestore();}
  });
  it('threshold.two.then.three.pauses.flat.once', async () => {
    const { bot, wallet } = keySetup(); wallet.executionEnabled = false;
    await repeat(path,2); expect(bot.isActive).toBe(true); expect(keyAlerts()).toHaveLength(0);
    await webhook(path,entryPayload);
    expect(bot.isActive).toBe(false); expect(bot.stats.signalKeyFailures.count).toBe(3);
    expect(bot.pauseReason).toBe("Paused after 3 signals in a row failed: the bot's trading key could not be used (execution_disabled). Re-enable automated trading or reconnect the agent wallet, then resume.");
    expect(keyAlerts()).toHaveLength(1); expect(routeMocks.notify).toHaveBeenCalledTimes(1);
  });
  it.each(['execution_expired','umk_unwrap','policy_hmac','agent_decrypt','agent_invalid','agent_missing'] as const)('counted.%s', async kind => {
    const { bot, wallet } = keySetup();
    if (kind === 'execution_expired') wallet.executionExpiresAt = new Date(0);
    if (kind === 'umk_unwrap') routeMocks.getUmkForWebhook.mockResolvedValue(null);
    if (kind === 'policy_hmac') { bot.policyHmac = 'EXAMPLE'; const v3 = await import('../../server/session-v3'); vi.mocked(v3.verifyBotPolicyHmac).mockReturnValue(false); }
    if (kind === 'agent_decrypt') routeMocks.decryptAgentKeyStrict.mockResolvedValue(null);
    if (kind === 'agent_invalid') routeMocks.decryptAgentKeyStrict.mockResolvedValue({ secretKey: new Uint8Array(64),cleanup:vi.fn() });
    if (kind === 'agent_missing') { wallet.agentPublicKey = null; wallet.agentPrivateKeyEncryptedV3 = null; routeMocks.decryptAgentKeyStrict.mockResolvedValue(null); }
    await webhook(path,entryPayload);
    expect(bot.stats.signalKeyFailures?.count).toBe(1); expect(bot.stats.signalKeyFailures?.kind).toBe(kind);
  });
  it('external.key.fail.fail.venue.rejection.clears.then.fail.fail', async () => {
    const { bot } = keySetup(); const leverage=primeRiskSizing();
    try {
      failKey(); await repeat(path,2); expect(bot.stats.signalKeyFailures.count).toBe(2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
      routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success:false,status:'rejected',error:'EXAMPLE_VENUE_REJECTION',landingDisposition:'terminal' });
      await webhook(path,entryPayload); expect(bot.stats.signalKeyFailures).toBeUndefined();
      failKey(); await repeat(path,2); expect(bot.isActive).toBe(true); expect(bot.stats.signalKeyFailures.count).toBe(2);
    } finally { leverage.mockRestore(); }
  });
  it('external.key.empty.exit.does.not.clear', async () => {
    const { bot } = keySetup(); const leverage=primeRiskSizing();
    try { failKey(); await webhook(path,entryPayload); await webhook(path,closePayload);
      await webhook(path,entryPayload); await webhook(path,closePayload); await webhook(path,entryPayload);
      expect(bot.isActive).toBe(false); expect(bot.stats.signalKeyFailures.count).toBe(3); expect(keyAlerts()).toHaveLength(1);
    } finally { leverage.mockRestore(); }
  });
  it('pre.order.refusal.preserves.streak', async () => {
    const { bot } = keySetup(); const leverage=primeRiskSizing();
    try { failKey(); await repeat(path,2);
      routeMocks.adapter.getPrice.mockResolvedValue(0);
      routeMocks.adapter.getMarkPrice.mockResolvedValue({kind:'unavailable',reason:'EXAMPLE_PRICE'});
      await webhook(path,entryPayload); expect(bot.stats.signalKeyFailures.count).toBe(2);
      routeMocks.adapter.getPrice.mockResolvedValue(1000);
      routeMocks.adapter.getMarkPrice.mockImplementation(async()=>({kind:'available',venue:'pacifica',internalSymbol:'BTC-PERP',protocolSymbol:'BTC',source:'/info/prices',field:'mark',exact:'1000',observedAt:Date.now(),receivedAt:Date.now(),expiresAt:Date.now()+5000}));
      await repeat(path,2); expect(bot.isActive).toBe(false); expect(keyAlerts()).toHaveLength(1);
    } finally { leverage.mockRestore(); }
  });
  it.each(['fee','constraint'] as const)('external.key.%s.preflight.refusal.preserves.streak', async refusal => {
    const { bot } = keySetup(); const leverage = primeRiskSizing();
    try {
      failKey(); await repeat(path, 2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({ secretKey: routeKeypair.secretKey, cleanup: vi.fn() });
      if (refusal === 'fee') routeMocks.adapter.getFeeRateQuote.mockResolvedValue({ availability: 'unavailable', reason: 'EXAMPLE' });
      else routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: false, status: 'rejected', error: 'EXAMPLE_CONSTRAINT', constraintRejection: { ok: false, reason: 'EXAMPLE_CONSTRAINT' } });
      await webhook(path, entryPayload);
      expect(bot.stats.signalKeyFailures.count).toBe(2);
      expect(bot.isActive).toBe(true);
    } finally { leverage.mockRestore(); }
  });
  it.each(['not_flat','unavailable'] as const)('threshold.%s.one.message.no.fourth.alert', async outcome => {
    const { bot,wallet } = keySetup(outcome==='not_flat' ? .25 : 0); wallet.executionEnabled=false;
    if (outcome==='unavailable') routeMocks.adapter.getStrictPositionForMarket.mockRejectedValue(new Error('EXAMPLE_READ'));
    await repeat(path,4); expect(bot.isActive).toBe(true); expect(keyAlerts()).toHaveLength(1); expect(routeMocks.notify).toHaveBeenCalledTimes(1);
    expect(bot.stats.signalKeyFailures.outcome).toBe(outcome);
    expect(keyAlerts()[0][1].error).toContain(outcome==='not_flat'?'it holds a position':'its position could not be checked');
  });
  it('concurrent.threshold.exactly.one.pause.and.alert', async () => {
    const { bot,wallet } = keySetup(); wallet.executionEnabled=false;
    await Promise.all([1,2,3,4].map(()=>webhook(path,entryPayload)));
    expect(bot.isActive).toBe(false); expect(storage.pauseActiveSignalBot).toHaveBeenCalledTimes(1); expect(keyAlerts()).toHaveLength(1);
  });
  it('restart.after.increment.next.failure.claims.and.pauses', async () => {
    const { bot,wallet } = keySetup(); wallet.executionEnabled=false;
    for(let i=0;i<3;i++) await storage.incrementSignalKeyFailure(bot.id,'execution_disabled');
    await webhook(path,entryPayload); expect(bot.isActive).toBe(false); expect(keyAlerts()).toHaveLength(1);
  });
  it('concurrent.daily.boundary.exactly.one.alert', async () => {
    const { bot,wallet } = keySetup(.25); wallet.executionEnabled=false; await repeat(path,3);
    bot.stats.signalKeyFailures.alertedAt=new Date(Date.now()-86_400_001).toISOString();
    await Promise.all([1,2,3].map(()=>webhook(path,entryPayload))); expect(keyAlerts()).toHaveLength(2); expect(bot.isActive).toBe(true);
  });
  it('published.source.alert.only.no.subscriber.exposure', async () => {
    const { bot } = keySetup(); listing(true); const leverage=primeRiskSizing();
    try { failKey(); await repeat(path,3); expect(bot.isActive).toBe(true); expect(storage.pauseActiveSignalBot).not.toHaveBeenCalled();
      expect(subscriberOrders()).toHaveLength(0); expect(sourceOrders()).toHaveLength(0);
      expect(keyAlerts()).toHaveLength(1); expect(keyAlerts()[0][1].error).toContain('Its copy-traders may still receive some of its signals, but this bot is not trading.');
    } finally {leverage.mockRestore();}
  });
  it('r10.inactive.listing.alerts.and.never.pauses', async () => {
    const { bot, wallet } = keySetup();
    wallet.executionEnabled = false;
    listing(false);
    await repeat(path, 3);
    expect(bot.isActive).toBe(true);
    expect(storage.pauseActiveSignalBot).not.toHaveBeenCalled();
    expect(bot.stats.signalKeyFailures.outcome).toBe('published_source');
    expect(keyAlerts()).toHaveLength(1);
    expect(keyAlerts()[0][1].error).toContain('Not paused because it is a published source.');
    expect(sourceOrders()).toHaveLength(0);
    expect(subscriberOrders()).toHaveLength(0);
  });
  it('r10.late.agent.wallet.refusal.never.uses.the.captured.flat.account', async () => {
    const { bot, wallet } = keySetup();
    bot.protocolSubaccountId = null;
    bot.subaccountAuthMode = null;
    const leverage = primeRiskSizing();
    const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority')
      .mockResolvedValue({ side: 'FLAT', size: 0, source: 'on-chain', entryPrice: 0 });
    let decrypted = false;
    routeMocks.decryptAgentKeyStrict.mockImplementation(async () => {
      decrypted = true;
      return { secretKey: routeKeypair.secretKey, cleanup: vi.fn() };
    });
    const field = path === 'user' ? 'agentPrivateKeyEncryptedV3' : 'agentPublicKey';
    vi.mocked(storage.getWallet).mockImplementation(async () => decrypted ? { ...wallet, [field]: null } : wallet);
    try {
      for (let i = 0; i < 3; i++) {
        decrypted = false;
        expect(await webhook(path, entryPayload)).toEqual({ status: 400, body: { error: 'Agent wallet not configured' } });
      }
      expect(bot.stats.signalKeyFailures).toMatchObject({ kind: 'agent_missing', outcome: 'unavailable' });
      expect(bot.isActive).toBe(true);
      expect(strict).not.toHaveBeenCalled();
      expect(keyAlerts()).toHaveLength(1);
      expect(keyAlerts()[0][1].error).toContain('its position could not be checked');
    } finally {
      strict.mockRestore();
      leverage.mockRestore();
    }
  });
  it.each(['emergency','duplicate','malformed','wrong.secret','venue.rejection','price','sizing'] as const)('not.counted.%s.five.times', async kind => {
    const { bot,wallet }=keySetup(); const leverage=primeRiskSizing();
    try {
      if(kind==='emergency') wallet.emergencyStopTriggered=true;
      if(kind==='duplicate') vi.mocked(storage.createWebhookLog).mockRejectedValue(Object.assign(new Error('EXAMPLE_DUP'),{code:'23505'}));
      if(kind==='venue.rejection') routeMocks.adapter.placeMarketOrder.mockResolvedValue({success:false,status:'rejected',error:'EXAMPLE_REJECTION',landingDisposition:'terminal'});
      if(kind==='price') {routeMocks.adapter.getPrice.mockResolvedValue(0);routeMocks.adapter.getMarkPrice.mockResolvedValue({kind:'unavailable',reason:'EXAMPLE'});}
      if(kind==='sizing') bot.maxPositionSize='0';
      const payload=kind==='wrong.secret'?{...entryPayload,secret:'EXAMPLE_WRONG'}:kind==='malformed'?{...entryPayload,action:'EXAMPLE_BAD'}:entryPayload;
      await repeat(path,5,payload);expect(storage.incrementSignalKeyFailure).not.toHaveBeenCalled();expect(bot.isActive).toBe(true);expect(keyAlerts()).toHaveLength(0);
    } finally {leverage.mockRestore();}
  });
  it.each(['full','partial','flip'] as const)('close.%s.structured.key.failure.counts', async kind => {
    const {bot}=keySetup(.25);failKey();
    const payload=kind==='partial'?partialPayload:kind==='flip'?{...entryPayload,action:'sell',position_size:'-0.1'}:closePayload;
    await webhook(path,payload);expect(bot.stats.signalKeyFailures?.count).toBe(1);expect(bot.stats.signalKeyFailures.kind).toBe('subaccount_key');
  });
  it.each([true,false])('r6.pending.close.new.signing.proof.%s.only.clears.new.attempt',async created=>{
    const {bot}=keySetup(.25);await storage.incrementSignalKeyFailure(bot.id,'subaccount_key');
    const sender=await realCloseSender(422);const original=durableClose.submitDurableClose;
    const submit=vi.spyOn(durableClose,'submitDurableClose').mockImplementation(async input=>{
      if(!created)await original(input);return original(input);
    });
    try {await webhook(path,closePayload);expect(sender.posts).toHaveLength(1);expect(bot.stats.signalKeyFailures?.count).toBe(created?undefined:1);}
    finally {submit.mockRestore();await sender.close();}
  });
  it.each(['full','partial','flip'] as const)('r6.close.%s.real.422.clears.streak',async kind=>{
    const {bot}=keySetup(.25);const leverage=primeRiskSizing();failKey();await repeat(path,2);
    routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
    const sender=await realCloseSender(422);
    try {await webhook(path,kind==='partial'?partialPayload:kind==='flip'?{...entryPayload,action:'sell',position_size:'-0.1'}:closePayload);
      expect(sender.posts).toHaveLength(1);expect(bot.stats.signalKeyFailures).toBeUndefined();
      failKey();await webhook(path,entryPayload);expect(bot.stats.signalKeyFailures.count).toBe(1);expect(bot.isActive).toBe(true);expect(keyAlerts()).toHaveLength(0);
    }finally{await sender.close();leverage.mockRestore();}
  });
  describe.each([503,'transport'] as const)('r6.close.unconfirmed.%s', status=>{
    it.each(['full','partial','flip'] as const)('%s.neither.counts.nor.clears',async kind=>{
      const {bot}=keySetup(.25);const leverage=primeRiskSizing();failKey();await repeat(path,2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});const sender=await realCloseSender(status);
      try {await webhook(path,kind==='partial'?partialPayload:kind==='flip'?{...entryPayload,action:'sell',position_size:'-0.1'}:closePayload);
        expect(sender.posts).toHaveLength(1);expect(bot.stats.signalKeyFailures.count).toBe(2);expect(keyAlerts()).toHaveLength(0);
        failKey();await webhook(path,entryPayload);expect(bot.stats.signalKeyFailures.count).toBe(3);expect(keyAlerts()).toHaveLength(1);
      }finally{await sender.close();leverage.mockRestore();}
    });
  });
  it.each(['paused','not_flat'] as const)('r4.opted.out.%s.completes.once',async outcome=>{
    const {bot,wallet}=keySetup(outcome==='not_flat'?.25:0);wallet.executionEnabled=false;
    routeMocks.notify.mockResolvedValue(false);await repeat(path,3);
    expect(bot.stats.signalKeyFailures).toMatchObject({outcome,alertedAt:expect.any(String)});
    if(outcome==='not_flat'){expect(bot.stats.signalKeyFailures.count).toBeGreaterThanOrEqual(3);expect(signalKeyFailureWarning(bot.stats.signalKeyFailures)).toContain('Not paused because it holds a position');}
    const claims=vi.mocked(storage.claimSignalKeyFailureAlert).mock.calls.length;
    bot.stats.signalKeyFailures.claimedAt=new Date(Date.now()-121_000).toISOString();
    await webhook(path,entryPayload);expect(keyAlerts()).toHaveLength(1);
    expect(storage.claimSignalKeyFailureAlert).toHaveBeenCalledTimes(outcome==='paused'?claims:claims+1);
    expect(bot.stats.signalKeyFailures.alertedAt).toBeTruthy();
  });
  it.each(['delivered','crash'] as const)('r4.committed.pause.concurrent.close.%s',async mode=>{
    const {bot,wallet}=keySetup();wallet.executionEnabled=false;await repeat(path,2);
    const pause=vi.mocked(storage.pauseActiveSignalBot).getMockImplementation()!;
    vi.mocked(storage.pauseActiveSignalBot).mockImplementation(async(...args)=>{
      const result=await pause(...args);if(result)await storage.clearSignalKeyFailures(bot.id);return result;
    });
    if(mode==='crash')routeMocks.notify.mockRejectedValueOnce(new Error('EXAMPLE_CRASH'));
    await webhook(path,entryPayload);expect(bot.isActive).toBe(false);
    expect(bot.stats.signalKeyFailures).toMatchObject({outcome:'paused'});
    if(mode==='crash'){
      expect(bot.stats.signalKeyFailures.alertedAt).toBeNull();routeMocks.notify.mockClear();
      bot.stats.signalKeyFailures.claimedAt=new Date(Date.now()-121_000).toISOString();
      await webhook(path,entryPayload);await vi.waitFor(()=>expect(bot.stats.signalKeyFailures.alertedAt).toBeTruthy());
    }
    expect(keyAlerts()).toHaveLength(1);await webhook(path,entryPayload);expect(keyAlerts()).toHaveLength(1);
  });
  it('r4.notice.timeout.keeps.trade.failed.fallback',async()=>{
    keySetup();const leverage=primeRiskSizing();failKey();await repeat(path,2);routeMocks.notify.mockClear();
    routeMocks.notify.mockImplementation(async(_owner,message)=>message.type==='bot_paused'?await new Promise<boolean>(()=>{}):true);
    try {await webhook(path,entryPayload);
      expect(keyAlerts()).toHaveLength(1);expect(routeMocks.notify.mock.calls.filter(([,m])=>m.type==='trade_failed')).toHaveLength(1);
    } finally {leverage.mockRestore();}
  },20_000);
  it('r3.paused.notice.crash.recovers.once', async () => {
    const { bot, wallet } = keySetup(); wallet.executionEnabled=false;
    routeMocks.notify.mockRejectedValueOnce(new Error('EXAMPLE_NOTICE_CRASH'));
    await repeat(path,3); expect(bot.isActive).toBe(false);
    expect(bot.stats.signalKeyFailures.outcome).toBe('paused'); expect(bot.stats.signalKeyFailures.alertedAt).toBeNull();
    routeMocks.notify.mockClear(); bot.stats.signalKeyFailures.claimedAt=new Date(Date.now()-120_001).toISOString();
    await webhook(path,entryPayload);
    await vi.waitFor(()=>expect(bot.stats.signalKeyFailures.alertedAt).toBeTruthy());
    expect(keyAlerts()).toHaveLength(1); await webhook(path,entryPayload); expect(keyAlerts()).toHaveLength(1);
  });
  it('r3.already.paused.completes.without.notice', async () => {
    const { bot, wallet } = keySetup(); wallet.executionEnabled=false; await repeat(path,2);
    vi.mocked(storage.getPublishedBotByTradingBotId).mockImplementationOnce(async()=>{bot.isActive=false;return undefined;});
    await webhook(path,entryPayload);
    expect(bot.stats.signalKeyFailures.outcome).toBe('already_paused'); expect(bot.stats.signalKeyFailures.alertedAt).toBeTruthy(); expect(keyAlerts()).toHaveLength(0);
  });
  describe.each(['agent','external'] as const)('r3.signing.proof.%s', mode => {
    it.each(['close.empty','price','sizing'] as const)('early.%s.does.not.clear', async refusal => {
      const { bot }=keySetup(); const leverage=primeRiskSizing();const markPrice=routeMocks.adapter.getMarkPrice.getMockImplementation()!;
      if(mode==='agent'){bot.protocolSubaccountId=null;bot.subaccountAuthMode=null;}
      try {
        const decrypt=mode==='agent'?routeMocks.decryptAgentKeyStrict:routeMocks.decryptBotSubaccountKey;
        decrypt.mockResolvedValue(null); await repeat(path,2);
        decrypt.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
        if(refusal==='price'){routeMocks.adapter.getPrice.mockResolvedValue(0);routeMocks.adapter.getMarkPrice.mockResolvedValue({kind:'unavailable',reason:'EXAMPLE'});}
        if(refusal==='sizing') bot.maxPositionSize='0';
        await webhook(path,refusal==='close.empty'?closePayload:entryPayload);
        expect(bot.stats.signalKeyFailures?.count).toBe(2);
        routeMocks.adapter.getPrice.mockResolvedValue(1000);routeMocks.adapter.getMarkPrice.mockImplementation(markPrice);bot.maxPositionSize='1000';
        decrypt.mockResolvedValue(null);await webhook(path,entryPayload);
        expect(bot.stats.signalKeyFailures?.count).toBe(3);expect(keyAlerts()).toHaveLength(1);
      } finally {leverage.mockRestore();}
    });
    it('auth.auth.unconfirmed.auth.reaches.threshold', async()=>{
      const {bot}=keySetup(); const leverage=primeRiskSizing();if(mode==='agent'){bot.protocolSubaccountId=null;bot.subaccountAuthMode=null;}
      const auth={success:false,status:'rejected',landingDisposition:'terminal',venue:'pacifica',httpStatus:401,keyFailureKind:'venue_auth_rejected',error:'EXAMPLE_AUTH'};
      try{routeMocks.adapter.placeMarketOrder.mockResolvedValue(auth);await repeat(path,2);
        routeMocks.adapter.placeMarketOrder.mockResolvedValue({success:false,status:'unknown',landingDisposition:'unconfirmed',venue:'pacifica',httpStatus:503,error:'EXAMPLE_UNCONFIRMED'});
        await webhook(path,entryPayload);expect(bot.stats.signalKeyFailures?.count).toBe(2);
        routeMocks.adapter.placeMarketOrder.mockResolvedValue(auth);await webhook(path,entryPayload);expect(bot.stats.signalKeyFailures?.count).toBe(3);expect(keyAlerts()).toHaveLength(1);
      }finally{leverage.mockRestore();}
    });
  });
  describe.each([401,403])('r6.real.close.auth.%s',status=>{
    it.each(['full','partial','flip'] as const)('r3.close.%s.venue.auth.counts',async kind=>{
      const {bot}=keySetup(.25);const leverage=primeRiskSizing();failKey();await repeat(path,2);
      routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});const sender=await realCloseSender(status);
      try{await webhook(path,kind==='partial'?partialPayload:kind==='flip'?{...entryPayload,action:'sell',position_size:'-0.1'}:closePayload);
        expect(sender.posts).toHaveLength(1);expect(bot.stats.signalKeyFailures.count).toBe(3);expect(bot.stats.signalKeyFailures.kind).toBe('venue_auth_rejected');expect(keyAlerts()).toHaveLength(1);
      }finally{await sender.close();leverage.mockRestore();}
    });
  });
  it('r5.listing.activated.during.flat.check.alerts.without.pause.or.subscriber.entry',async()=>{
    const {bot,wallet,subscriber}=keySetup();wallet.executionEnabled=false;
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([subscriber] as never);
    let active=false;vi.mocked(storage.getPublishedBotByTradingBotId).mockImplementation(async()=>active?({id:'EXAMPLE_LISTING',isActive:true}) as never:undefined);
    const pause=vi.mocked(storage.pauseActiveSignalBot).getMockImplementation()!;
    vi.mocked(storage.pauseActiveSignalBot).mockImplementation(async(...args)=>active?undefined:pause(...args));
    await repeat(path,2);let release!:()=>void,entered!:()=>void;
    const blocked=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const strict=vi.spyOn(PositionService,'getPositionForCloseAuthority').mockImplementationOnce(async()=>{entered();await blocked;return {side:'FLAT',size:0} as never;});
    const request=webhook(path,entryPayload);
    try {await Promise.race([started,request.then(()=>expect.fail('missing flat check'))]);active=true;release();await request;
      expect(bot.isActive).toBe(true);expect(bot.pauseReason).toBeUndefined();expect(keyAlerts()).toHaveLength(1);
      expect(keyAlerts()[0][1].error).toContain('Not paused because it is a published source.');
      expect(bot.stats.signalKeyFailures.outcome).toBe('published_source');
      await webhook(path,entryPayload);expect(keyAlerts()).toHaveLength(1);expect(subscriberOrders()).toHaveLength(0);
    }finally{release();await request;strict.mockRestore();}
  });
  it('r5.published.flip.routes.before.failed.close.and.uses.honest.notice',async()=>{
    const {bot,wallet,subscriber}=keySetup(.25);listing(true);const leverage=primeRiskSizing();
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([subscriber] as never);
    vi.mocked(storage.getWallet).mockImplementation(async address=>(address===subscriber.walletAddress?{...routeWallet,agentPublicKey:subscriberKey}:wallet) as never);
    failKey();await repeat(path,2);expect(subscriberOrders()).toHaveLength(0);
    routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
    let subscriberRoutedBeforeSourceClose=false;const sender=await realCloseSender(403);
    const submitOriginal=durableClose.submitDurableClose;
    const submit=vi.spyOn(durableClose,'submitDurableClose').mockImplementation(async input=>{
      if(input.identity.bot_id!==bot.id)return submitOriginal(input);
      await vi.waitFor(()=>expect(subscriberOrders().length).toBeGreaterThan(0),{timeout:5000});subscriberRoutedBeforeSourceClose=true;
      return submitOriginal(input);
    });
    try{await settledRouting(()=>webhook(path,{...entryPayload,action:'sell',position_size:'-0.1'}));
      expect(subscriberRoutedBeforeSourceClose).toBe(true);expect(bot.isActive).toBe(true);expect(keyAlerts()).toHaveLength(1);
      expect(keyAlerts()[0][1].error).toContain('Not paused because it is a published source. Its copy-traders may still receive some of its signals, but this bot is not trading.');
      expect(keyAlerts()[0][1].error).not.toContain('copy-traders are not receiving');
    }finally{submit.mockRestore();await sender.close();leverage.mockRestore();}
  });
  it('generic.close.save.failure.does.not.count',async()=>{
    const {bot}=keySetup(.25);routeMocks.adapter.prepareReduceOnlyMarketOrder=vi.fn(async()=>{throw new Error('EXAMPLE_SAVE');});
    await webhook(path,closePayload);expect(storage.incrementSignalKeyFailure).not.toHaveBeenCalled();expect(bot.stats.signalKeyFailures).toBeUndefined();
  });
  it('paused.close.still.runs.reduce.only',async()=>{
    const {bot}=keySetup(.25);bot.isActive=false;await webhook(path,closePayload);await waitForCloseEffects();
    expect(sourceOrders()).toHaveLength(1);expect(sourceOrders()[0].reduceOnly).toBe(true);expect(storage.incrementSignalKeyFailure).not.toHaveBeenCalled();
  });
});
it.each(['execution_disabled','execution_expired'] as const)('r2.published.source.%s.honest.copy.and.subscriber.closes', async kind => {
  const { bot, wallet, subscriber } = keySetup(.25); listing(true);
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([subscriber] as never);
  vi.mocked(storage.getWallet).mockImplementation(async address => (address === subscriber.walletAddress
    ? { ...routeWallet, agentPublicKey: subscriberKey } : wallet) as never);
  if (kind === 'execution_disabled') wallet.executionEnabled = false;
  else wallet.executionExpiresAt = new Date(0);
  await settledRouting(() => repeat('tv', 3, closePayload));
  expect(bot.isActive).toBe(true); expect(storage.pauseActiveSignalBot).not.toHaveBeenCalled();
  expect(keyAlerts()[0][1].error).toContain('Not paused because it is a published source. Copy-traders still receive its signals, but this bot is not trading.');
  expect(subscriberOrders().length).toBeGreaterThan(0);
  for (const order of subscriberOrders()) expect(order.reduceOnly).toBe(true);
  expect(sourceOrders()).toHaveLength(0);
});
it('paused.user.key.failure.never.increments',async()=>{const {bot,wallet}=keySetup();bot.isActive=false;wallet.executionEnabled=false;await webhook('user',entryPayload);expect(storage.incrementSignalKeyFailure).not.toHaveBeenCalled();});
it('protocol.branches.never.touch.key.streak',async()=>{
  for(const protocol of ['phoenix','flash']) {const {bot,wallet}=keySetup();bot.activeProtocol=protocol;wallet.executionEnabled=false;
    await webhook('tv',entryPayload);await webhook('user',entryPayload);expect(storage.incrementSignalKeyFailure).not.toHaveBeenCalled();}
});
it.each(['execution_disabled','v3_decrypt_failed','emergency_stopped'] as const)('subscriber.transition.%s.alert.once',async reason=>{
  const {subscriber}=setup({active:true,subscriber:true});
  vi.mocked(storage.markBotSubscriptionPausedBySubscriberBotId).mockResolvedValueOnce(true).mockResolvedValue(false);
  if(reason==='v3_decrypt_failed') routeMocks.decryptAgentKeyStrict.mockResolvedValue(null);
  else routeMocks.getUmkForWebhook.mockResolvedValue(null);
  vi.mocked(storage.getWallet).mockResolvedValue({...routeWallet,emergencyStopTriggered:reason==='emergency_stopped'} as never);
  await route({action:'buy',contracts:'0.1',positionSize:'0.1',strategyPositionSize:'0.1',price:'1000',isCloseSignal:false});await route({action:'buy',contracts:'0.1',positionSize:'0.1',strategyPositionSize:'0.1',price:'1000',isCloseSignal:false});
  const messages=routeMocks.notify.mock.calls.filter(([owner,m])=>owner===subscriber.walletAddress&&m.type==='bot_paused');
  expect(messages).toHaveLength(reason==='emergency_stopped'?0:1);
});
it.each(['success','resume'] as const)('stale.flat.check.%s.vetoes.pause',async change=>{
 const {bot,wallet}=keySetup();wallet.executionEnabled=false;
 await repeat('tv',2);let release!:()=>void,entered!:()=>void;
 const pending=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const strict=vi.spyOn(PositionService,'getPositionForCloseAuthority').mockImplementation(async()=>{entered();await pending;return {side:'FLAT',size:0} as never;});
 try{const request=webhook('tv',entryPayload);await Promise.race([started,request.then(()=>{expect.fail('threshold request finished without a flat check');})]);
  if(change==='resume') await storage.updateTradingBot(bot.id,{isActive:true});else await storage.clearSignalKeyFailures(bot.id);
  release();await request;expect(bot.isActive).toBe(true);expect(keyAlerts()).toHaveLength(0);
 }finally{release();strict.mockRestore();}
});
it('nullable.query.account.returns.unavailable',async()=>{
 const {bot,wallet}=keySetup();bot.protocolSubaccountId=null;bot.subaccountAuthMode=null;wallet.agentPublicKey=null;wallet.executionEnabled=false;
 await repeat('tv',3);expect(bot.isActive).toBe(true);expect(keyAlerts()[0][1].error).toContain('its position could not be checked');
});

it('r10.missing.current.query.account.alerts.without.flat.read', async () => {
  const { bot, wallet } = keySetup();
  bot.protocolSubaccountId = null;
  wallet.executionEnabled = false;
  const strict = vi.spyOn(PositionService, 'getPositionForCloseAuthority')
    .mockResolvedValue({ side: 'FLAT', size: 0, source: 'on-chain', entryPrice: 0 });
  const claim = vi.mocked(storage.claimSignalKeyFailureAlert).getMockImplementation()!;
  vi.mocked(storage.claimSignalKeyFailureAlert).mockImplementation(async (...args) => {
    const lease = await claim(...args);
    if (lease) wallet.agentPublicKey = null;
    return lease;
  });
  try {
    await repeat('tv', 3);
    expect(bot.stats.signalKeyFailures.outcome).toBe('unavailable');
    expect(bot.isActive).toBe(true);
    expect(strict).not.toHaveBeenCalled();
    expect(keyAlerts()).toHaveLength(1);
  } finally {
    strict.mockRestore();
  }
});

it.each(['policy_hmac', 'agent_mismatch', 'agent_verification_error'] as const)('r10.user.wipes.%s.before.tracker', async refusal => {
  const { bot } = keySetup();
  const key = refusal === 'policy_hmac' ? Buffer.alloc(32, 1)
    : refusal === 'agent_mismatch' ? Keypair.generate().secretKey : new Uint8Array([1]);
  const cleanup = vi.fn(() => { key.fill(0); });
  if (refusal === 'policy_hmac') {
    bot.policyHmac = 'EXAMPLE';
    routeMocks.getUmkForWebhook.mockResolvedValue({ umk: key as Buffer, cleanup });
  } else {
    routeMocks.decryptAgentKeyStrict.mockResolvedValue({ secretKey: key, cleanup });
  }
  let wipedAtTracker: boolean | undefined;
  const increment = vi.mocked(storage.incrementSignalKeyFailure).getMockImplementation()!;
  vi.mocked(storage.incrementSignalKeyFailure).mockImplementation(async (...args) => {
    wipedAtTracker = key.every(byte => byte === 0);
    return increment(...args);
  });
  const response = await webhook('user', entryPayload);
  expect(response).toEqual(refusal === 'policy_hmac'
    ? { status: 403, body: { error: 'Bot configuration has been tampered with. Please reconfigure the bot.' } }
    : { status: 500, body: { error: refusal === 'agent_mismatch'
      ? 'Agent key verification failed. Please reconfigure your agent wallet in Settings.'
      : 'Agent key verification failed. Please reconfigure your agent wallet.' } });
  expect(cleanup).toHaveBeenCalledOnce();
  expect(wipedAtTracker).toBe(true);
});

it('r10.user.success.response.and.subscriber.dispatch.proceed.during.clear', async () => {
  const { bot } = keySetup();
  listing(true);
  const leverage = primeRiskSizing();
  let started!: () => void;
  let release!: () => void;
  const clearing = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const clear = vi.mocked(storage.clearSignalKeyFailures);
  clear.mockImplementation(async () => { started(); await held; });
  let response: Awaited<ReturnType<typeof webhook>> | undefined;
  const request = webhook('user', entryPayload).then(result => { response = result; return result; });
  try {
    await Promise.race([clearing, request.then(() => expect(clear).toHaveBeenCalled())]);
    await vi.waitFor(() => {
      expect(response).toMatchObject({ status: 200, body: { success: true, botId: bot.id } });
      expect(storage.getSubscriberBotsBySourceId).toHaveBeenCalledWith(bot.id, { sourceTradingBotId: true });
    }, { timeout: 1000 });
    expect(sourceOrders()).toHaveLength(1);
  } finally {
    release();
    await request;
    leverage.mockRestore();
  }
});

it.each(['hang','increment.throw'] as const)('r3.published.disabled.routing.survives.%s',async failure=>{
 const {wallet,subscriber,orders}=keySetup(.25);listing(true);wallet.executionEnabled=false;
 vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([subscriber] as never);
 vi.mocked(storage.getWallet).mockImplementation(async address=>(address===subscriber.walletAddress?{...routeWallet,agentPublicKey:subscriberKey}:wallet) as never);
 let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
 if(failure==='hang')routeMocks.notify.mockImplementation(async(_owner,message)=>{if(message.type==='bot_paused')await blocked;return true;});
 else vi.mocked(storage.incrementSignalKeyFailure).mockRejectedValue(new Error('EXAMPLE_INCREMENT'));
 let origin=0;vi.mocked(storage.createWebhookLog).mockImplementation(async()=>({id:`EXAMPLE_WEBHOOK_${++origin}`}) as never);
 for(let i=0;i<2;i++){await settledRouting(()=>webhook('tv',closePayload));orders.clear();(closeIntentStore as any).reset();}
 const before=subscriberOrders().length;const request=webhook('tv',closePayload);
 try{await vi.waitFor(()=>expect(subscriberOrders().length).toBeGreaterThan(before),{timeout:5000});
   for(const order of subscriberOrders())expect(order.reduceOnly).toBe(true);expect(sourceOrders()).toHaveLength(0);
 }finally{release();await request;await waitForCloseEffects();}
});
it('r3.stale.claimant.cannot.pause.after.takeover.one.notice',async()=>{
 const {bot,wallet}=keySetup();wallet.executionEnabled=false;await repeat('tv',2);
 const claim=vi.mocked(storage.claimSignalKeyFailureAlert).getMockImplementation()!;let claimClock=Date.now();
 vi.mocked(storage.claimSignalKeyFailureAlert).mockImplementation(async(...args)=>{
   const claimed=await claim(...args);if(!claimed)return claimed;
   const lease=new Date(++claimClock).toISOString();bot.stats.signalKeyFailures.claimedAt=lease;return lease;
 });
 let release!:()=>void,entered!:()=>void;const pending=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const strict=vi.spyOn(PositionService,'getPositionForCloseAuthority').mockImplementationOnce(async()=>{entered();await pending;return {side:'FLAT',size:0} as never;});
 const a=webhook('tv',entryPayload);let b:ReturnType<typeof webhook>|undefined;
 try{await Promise.race([started,a.then(()=>expect.fail('missing first claimant flat check'))]);
   bot.stats.signalKeyFailures.claimedAt=new Date(Date.now()-120_001).toISOString();b=webhook('tv',entryPayload);
   await vi.waitFor(()=>expect(storage.claimSignalKeyFailureAlert).toHaveBeenCalledTimes(2));
   release();await Promise.all([a,b]);expect(bot.isActive).toBe(false);expect(keyAlerts()).toHaveLength(1);
   expect(bot.stats.signalKeyFailures).toMatchObject({outcome:'paused',alertedAt:expect.any(String)});
   const pauses=vi.mocked(storage.pauseActiveSignalBot);expect(pauses).toHaveBeenCalledTimes(2);
   expect(await pauses.mock.results[0].value).toBeUndefined();
   expect(await pauses.mock.results[1].value).toMatchObject({isActive:false});
   expect(pauses.mock.calls[0][3]).not.toBe(pauses.mock.calls[1][3]);
 }finally{release();await a;if(b)await b;strict.mockRestore();}
});

it.each(['execution_disabled','v3_decrypt_failed'] as const)('r4.subscriber.hanging.transition.%s.does.not.block.next.order',async reason=>{
  const {source,subscriber}=setup({active:true,subscriber:true});
  const bKey=Keypair.generate();const bPublicKey=bKey.publicKey.toBase58();
  const a={...subscriber,id:'EXAMPLE_SUB_A_'+reason,walletAddress:'EXAMPLE_OWNER_A_'+reason};
  const b={...subscriber,id:'EXAMPLE_SUB_B_'+reason,walletAddress:'EXAMPLE_OWNER_B_'+reason};
  vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([a,b] as never);
  vi.mocked(storage.getTradingBotById).mockImplementation(async id=>(id===a.id?a:id===b.id?b:source) as never);
  vi.mocked(storage.getWallet).mockImplementation(async owner=>({...routeWallet,agentPublicKey:owner===b.walletAddress?bPublicKey:routeWallet.agentPublicKey}) as never);
  vi.mocked(storage.markBotSubscriptionPausedBySubscriberBotId).mockResolvedValue(true);
  routeMocks.getUmkForWebhook.mockReset().mockImplementation(async owner=>reason==='execution_disabled'&&owner===a.walletAddress?null:{umk:Buffer.alloc(32),cleanup:vi.fn()});
  let failedDecrypt=false;
  routeMocks.decryptAgentKeyStrict.mockReset().mockImplementation(async owner=>{
    if(reason==='v3_decrypt_failed'&&owner===a.walletAddress){failedDecrypt=true;return null;}
    return {secretKey:owner===b.walletAddress?bKey.secretKey:routeKeypair.secretKey,cleanup:vi.fn()};
  });
  let release!:()=>void;let noticePending=false;let released=false;
  const blocked=new Promise<boolean>(resolve=>release=()=>{released=true;resolve(true);});
  routeMocks.notify.mockImplementation(async(owner,message)=>{
    if(owner===a.walletAddress&&message.type==='bot_paused'){noticePending=true;return blocked;}return true;
  });
  const request=route({originId:'EXAMPLE_FANOUT_'+reason,action:'sell',contracts:'0.25',positionSize:'0',strategyPositionSize:'0',price:'1000',isCloseSignal:true});
  try {
    await vi.waitFor(()=>expect(noticePending).toBe(true),{timeout:3000});
    if(reason==='v3_decrypt_failed')expect(failedDecrypt).toBe(true);
    await vi.waitFor(()=>expect(routeMocks.adapter.placeMarketOrder.mock.calls.filter(([o])=>o.agentPublicKey===bPublicKey)).toHaveLength(1),{timeout:3000});
    expect(released).toBe(false);
    expect(routeMocks.adapter.placeMarketOrder.mock.calls.find(([o])=>o.agentPublicKey===bPublicKey)![0].reduceOnly).toBe(true);
  } finally {release();await request;await waitForCloseEffects();}

},10000);

it('r5.user.published.partial.close.responds.while.notice.hangs',async()=>{
  keySetup(.25);listing(true);const leverage=primeRiskSizing();
  failKey();await repeat('user',2);routeMocks.decryptBotSubaccountKey.mockResolvedValue({secretKey:routeKeypair.secretKey,cleanup:vi.fn()});
  const sender=await realCloseSender(403);const submit=vi.spyOn(durableClose,'submitDurableClose');
  let release!:()=>void;let released=false;const blocked=new Promise<boolean>(resolve=>release=()=>{released=true;resolve(true);});
  routeMocks.notify.mockImplementation(async(_owner,message)=>message.type==='bot_paused'?blocked:true);
  const request=webhook('user',partialPayload);
  try{
    await vi.waitFor(()=>expect(keyAlerts()).toHaveLength(1),{timeout:3000});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const response=await Promise.race([request,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('response blocked by notice')),3000);})]).finally(()=>clearTimeout(timer));
    expect(response.status).toBe(202);expect(released).toBe(false);expect(sender.posts).toHaveLength(1);expect(subscriberOrders()).toHaveLength(0);
    const {intent}=await submit.mock.results[0].value;
    expect(intent.status).toBe('pending');expect(intent.attempt_log[0].outcome).toMatchObject({kind:'ambiguous',httpStatus:403});
  }finally{release();await request;await waitForCloseEffects();submit.mockRestore();await sender.close();leverage.mockRestore();}
});
it('r6.user.published.non.key.released.partial.close.never.routes',async()=>{
  const {subscriber}=keySetup(.25);listing(true);vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([subscriber] as never);
  const original=durableClose.submitDurableClose;
  // Run the real expiry/release pass after the non-entry response. The route
  // receives the durable worker's released state, without inventing an outcome.
  const submit=vi.spyOn(durableClose,'submitDurableClose').mockImplementation(async input=>{
    const result=await original(input);const intent=result.intent;
    const last=intent.attempt_log.at(-1)!;const future=last.timestamp+last.expiry_window+300_001;
    const clock=vi.spyOn(closeIntentStore,'databaseTime').mockResolvedValue(future);
    const read=routeMocks.adapter.getCloseConfirmationSnapshot.getMockImplementation()!;
    routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async(...args:any[])=>{const value=await read(...args);return {...value,evidence:{...value.evidence,venueClockMs:future}};});
    (routeMocks.adapter as any).getCloseOpenOrders=async(account:string)=>({account,environment:intent.environment,complete:true,fresh:true,noDedup:true,lastOrderId:100,orders:[]});
    try{return (await closeIntentStore.withScope(intent.environment,intent.original_account,intent.market,async scope=>{
      await observeCloseIntent(scope,intent,{adapter:()=>routeMocks.adapter as never,epochUnchanged:async()=>true,signer:async()=>null,account:async()=>{}});
      const released=await closeIntentStore.byId(scope,intent.id);expect(released).toMatchObject({status:'released',release_mode:'not_sent'});
      return {created:false,intent:released!};
    }))!;}finally{clock.mockRestore();routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(read);delete (routeMocks.adapter as any).getCloseOpenOrders;}
  });
  const sender=await realCloseSender('ECONNREFUSED');
  try{const response=await webhook('user',partialPayload);const returned=await submit.mock.results[0].value;expect(returned.intent).toMatchObject({status:'released',release_mode:'not_sent'});expect(response.status).toBe(202);await waitForCloseEffects();expect(storage.getSubscriberBotsBySourceId).not.toHaveBeenCalled();expect(sender.posts).toHaveLength(1);expect(subscriberOrders()).toHaveLength(0);expect(keyAlerts()).toHaveLength(0);}
  finally{submit.mockRestore();await sender.close();}
});
