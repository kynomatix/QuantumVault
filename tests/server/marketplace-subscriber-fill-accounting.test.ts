import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

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
  sessionMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../server/trading/close-intent-store', async () => {
  const { makeCloseRouteStore } = await import('../helpers/close-route-intent-store');
  const { storage } = await import('../../server/storage');
  return { closeIntentStore: makeCloseRouteStore(storage) };
});
import { closeIntentStore } from '../../server/trading/close-intent-store';
import { bridgePreparedClose } from '../helpers/close-route-intent-store';

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
import { routeSignalToSubscribers } from '../../server/routes';
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


import { subscriberCloseAccounting, subscriberClosePersistence, type SubscriberCloseEvidenceInput } from '../../server/trading/subscriber-close-accounting';
import { resolveBotTradeNetPnl } from '../../server/trading/bot-trade-pnl-convention';
import type { CloseSnapshot } from '../../server/protocol/close-outcome';
import type { TradeRecord } from '../../server/protocol/protocol-types';
import type { ProtocolAdapter } from '../../server/protocol/adapter';
import { recoverSubscriberCloseEvidence } from '../../server/trading/subscriber-close-recovery';
import { selectPendingPartialCloseMarker } from '../../server/reconciliation-service';

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
function evidence(): SubscriberCloseEvidenceInput {
  const baseline = snapshot('EXAMPLE_ACCOUNT', 1, 0.25);
  return { account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP', orderId: 'EXAMPLE_ORDER', openSide: 'long',
    requestedSize: 0.25, sentAt: Date.now() - 100, observedAt: Date.now() + 100,
    baseline, closeResult: { outcome: 'confirmed', account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP',
      reason: 'qualified_flat_observation', baseline: baseline.evidence }, trades: [fill()] };
}
function prime(side: 'long' | 'short' = 'long', rows: () => TradeRecord[] = () => [fill()]) {
  vi.clearAllMocks();
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
async function route(partial = false) {
  await routeSignalToSubscribers('EXAMPLE_SOURCE', { originId: 'EXAMPLE_SIGNAL', action: 'sell', contracts: '0', positionSize: '0',
    price: '90000', isCloseSignal: !partial, strategyPositionSize: null,
    ...(partial ? { partialCloseFraction: 0.5 } : {}) });
}

describe('subscriber execution accounting through the routing seam', () => {
  it.each(['long', 'short'] as const)('uses the %s subscriber fills, not the differing signal price', async side => {
    prime(side, () => [fill({ side: side === 'long' ? 'short' : 'long', price: side === 'long' ? 65000 : 63000 })]);
    await route();
    expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
    const event = vi.mocked(storage.recordCloseEventAtomic).mock.calls[0]?.[0];
    expect(event?.update?.fields, JSON.stringify({size:event?.update?.fields.size,price:event?.update?.fields.price,pnl:event?.update?.fields.pnl,fee:event?.update?.fields.fee,payload:event?.update?.fields.webhookPayload})).toMatchObject({ size: '0.25', price: side === 'long' ? '65000' : '63000',
      pnl: '249', fee: '1', protocolFillId: 'tx-EXAMPLE_ORDER' });
    expect(event?.deltas?.totalPnlDelta).toBe(249);
    expect(event?.deltas?.totalVolumeDelta).toBe(side === 'long' ? 16250 : 15750);
    expect(storage.getBotSubscriptionBySubscriberBotId).toHaveBeenCalledOnce();
  });
  it('weights multiple fills and deducts a zero exact fee only once', async () => {
    prime('long', () => [fill({ tradeId: 'EXAMPLE_A', size: 0.1, price: 65000, fee: 0 }),
      fill({ tradeId: 'EXAMPLE_B', size: 0.15, price: 66000, fee: 0 })]);
    await route();
    expect(vi.mocked(storage.recordCloseEventAtomic).mock.calls[0]?.[0].update?.fields)
      .toMatchObject({ size: '0.25', price: '65600', fee: '0', pnl: '400' });
  });
  it.each(['missing', 'coverage', 'duplicate', 'fee', 'price', 'size', 'entry', 'unconfirmed'])('keeps %s evidence incomplete without a reorder or share', async defect => {
    prime('long', () => defect === 'missing' ? [] : defect === 'duplicate' ? [fill(), fill()]
      : [fill({ ...(defect === 'coverage' ? { size: 0.24 } : {}), ...(defect === 'fee' ? { fee: NaN } : {}),
        ...(defect === 'price' ? { price: NaN } : {}), ...(defect === 'size' ? { size: NaN } : {}) })]);
    if (defect === 'entry' || defect === 'unconfirmed') {
      let seq = 0;
      routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => {
        const value = snapshot(account, ++seq, !routeMocks.adapter.placeMarketOrder.mock.calls.length || defect === 'unconfirmed' ? 0.25 : 0);
        if (defect === 'entry' && value.positions[0]) value.positions[0].entryPrice = NaN;
        return value;
      });
    }
    await route();
    expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
    expect(storage.getBotSubscriptionBySubscriberBotId).not.toHaveBeenCalled();
    expect(storage.createTradeRetryJob).not.toHaveBeenCalled();
    if (defect !== 'unconfirmed') {
      const event = vi.mocked(storage.recordCloseEventAtomic).mock.calls[0]?.[0];
      expect(event?.update?.fields.pnl).toBeNull();
      expect(event).toHaveProperty('confirmedPositionCloseIncomplete');
      expect(event?.update?.fields.webhookPayload).toHaveProperty('closeAccounting.kind', 'unavailable');
    }
  });
  it('retains actual partial fills without crystallizing or substituting the requested quantity', async () => {
    prime('long', () => [fill({ size: 0.1 })]);
    await route(true);
    const marker = vi.mocked(storage.updatePendingBotTrade).mock.calls[0]?.[1];
    expect(storage.updatePendingBotTrade).toHaveBeenCalledWith('EXAMPLE_PENDING', expect.any(Object));
    expect(storage.createBotTradeIdempotent).not.toHaveBeenCalled();
    expect(storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(marker).toMatchObject({ size: '0.1', price: '65000', fee: null, pnl: null, status: 'pending' });
    expect(marker?.webhookPayload).toMatchObject({ partialClose: true, partialCloseAccounting: {
      expectedBaseSize: '0.25', expectedLastTradeId: 'EXAMPLE_ENTRY', requestedClosedSize: 0.1 } });
    const restarted = selectPendingPartialCloseMarker({
      trades: [{ market: 'BTC-PERP', side: 'short', tradingBotId: ROUTE_BOT_ID, ...marker, id: 'EXAMPLE_PENDING', executedAt: new Date() } as never],
      protocol: 'pacifica', market: 'BTC-PERP', closeSide: 'short', dbBaseSize: 0.25,
      dbLastTradeId: 'EXAMPLE_ENTRY', closedSlice: 0.1, closingFills: [fill({ size: 0.1 })], nowMs: Date.now(),
    });
    expect(restarted.kind).toBe('eligible');
    expect(storage.getBotSubscriptionBySubscriberBotId).not.toHaveBeenCalled();
    expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
  });
  it('uses exact subscriber accounting for a FLIP close before a paused replacement open', async () => {
    prime();
    const paused = { ...routeBot, isActive: false };
    vi.mocked(storage.getTradingBotById).mockResolvedValue(paused as never);
    vi.mocked(storage.getSubscriberBotsBySourceId).mockResolvedValue([paused] as never);
    routeMocks.adapter.getStrictPositionForMarket
      .mockResolvedValueOnce({ internalSymbol: 'BTC-PERP', baseSize: 0.25, entryPrice: 64000 })
      .mockResolvedValue(null);
    await routeSignalToSubscribers('EXAMPLE_SOURCE', { originId: 'EXAMPLE_SIGNAL', action: 'sell', contracts: '0.25', positionSize: '0.25',
      price: '90000', isCloseSignal: false, strategyPositionSize: '-0.25' });
    expect(routeMocks.adapter.placeMarketOrder).toHaveBeenCalledOnce();
    expect(vi.mocked(storage.recordCloseEventAtomic).mock.calls[0]?.[0].update?.fields)
      .toMatchObject({ size: '0.25', price: '65000', fee: '1', pnl: '249' });
    expect(storage.getBotSubscriptionBySubscriberBotId).toHaveBeenCalledOnce();
  });
  it('keeps a requested full close that only reduced exposure pending with actual facts', async () => {
    prime('long', () => [fill({ size: 0.1 })]);
    let seq = 0;
    routeMocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) =>
      snapshot(account, ++seq, !routeMocks.adapter.placeMarketOrder.mock.calls.length ? 0.25 : 0.15));
    await route();
    expect(storage.updatePendingBotTrade).toHaveBeenCalledWith('EXAMPLE_PENDING', expect.objectContaining({
      status: 'pending', size: '0.1', price: '65000', fee: '1', pnl: null,
    }));
    expect(storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(storage.getBotSubscriptionBySubscriberBotId).not.toHaveBeenCalled();
  });
  it('cannot substitute an estimated submit fee for missing fill fees', async () => {
    prime('long', () => [fill({ fee: NaN })]);
    routeMocks.adapter.placeMarketOrder.mockResolvedValue({ success: true, orderId: 'EXAMPLE_ORDER', fee: 0 });
    routeMocks.adapter.getFeeRateQuote.mockResolvedValue({ kind: 'rate_estimate', rate: 0.0005 });
    await route();
    expect(vi.mocked(storage.recordCloseEventAtomic).mock.calls[0]?.[0].update?.fields)
      .toMatchObject({ size: '0.25', price: '65000', fee: null, pnl: null });
    expect(storage.getBotSubscriptionBySubscriberBotId).not.toHaveBeenCalled();
  });
  it('uses the canonical winner identity when one later repair becomes eligible', async () => {
    prime();
    vi.mocked(storage.recordCloseEventAtomic).mockResolvedValue({ isNew: false, trade: { id: 'EXAMPLE_RECONCILED' } } as never);
    vi.mocked(storage.remediateSubscriberCloseAccountingAtomic).mockResolvedValue({ remediated: true,
      trade: { id: 'EXAMPLE_RECONCILED', protocolFillId: 'tx-EXAMPLE_CANONICAL' } } as never);
    await route();
    expect(storage.remediateSubscriberCloseAccountingAtomic).toHaveBeenCalledOnce();
    expect(storage.getBotSubscriptionBySubscriberBotId).toHaveBeenCalledOnce();
  });
  it('does not charge after a canonical replay or reconciler-first finalization', async () => {
    prime();
    vi.mocked(storage.recordCloseEventAtomic).mockResolvedValue({ isNew: false, trade: { id: 'EXAMPLE_RECONCILED' } } as never);
    await route();
    expect(storage.recordCloseEventAtomic).toHaveBeenCalledOnce();
    expect(storage.getBotSubscriptionBySubscriberBotId).not.toHaveBeenCalled();
  });
});

describe('subscriber evidence validation', () => {
  it('attaches delayed partial fills to the same restart marker without ordering or paying', async () => {
    const request = evidence();
    request.requestedSize = 0.125;
    request.closeResult!.outcome = 'partial';
    request.trades = [];
    const prior = subscriberCloseAccounting(request);
    const payload = { partialClose: true, ...subscriberClosePersistence(prior).webhookPayload,
      partialCloseAccounting: { status: 'pending_venue_authority', expectedBaseSize: '0.25',
        expectedLastTradeId: 'EXAMPLE_ENTRY', requestedClosedSize: 0.125 } };
    const trade = { id: 'EXAMPLE_PENDING', status: 'pending', market: 'BTC-PERP', side: 'short',
      txSignature: 'EXAMPLE_ORDER', protocolFillId: 'tx-EXAMPLE_ORDER', executedAt: new Date(), webhookPayload: payload };
    const updatePendingBotTrade = vi.fn();
    const remediateSubscriberCloseAccountingAtomic = vi.fn();
    const placeMarketOrder = vi.fn();
    const adapter = { protocolName: 'pacifica', placeMarketOrder, getTradeHistory: vi.fn(async () => [fill({ size: 0.1 })]) };
    await recoverSubscriberCloseEvidence({ botId: ROUTE_BOT_ID, account: request.account,
      adapter: adapter as unknown as ProtocolAdapter,
      storage: { getSubscriberCloseAccountingCandidates: vi.fn(async () => [trade] as never),
        updatePendingBotTrade, remediateSubscriberCloseAccountingAtomic } });
    expect(updatePendingBotTrade).toHaveBeenCalledOnce();
    const fields = updatePendingBotTrade.mock.calls[0][1];
    expect(fields).toMatchObject({ size: '0.1', price: '65000', fee: null, pnl: null,
      webhookPayload: { partialCloseAccounting: { requestedClosedSize: 0.1 },
        executionAccounting: { price: 65000, fee: 1, pnl: 99, priceAuthority: 'venue_execution' } } });
    const restarted = selectPendingPartialCloseMarker({ trades: [{ ...trade, ...fields }],
      protocol: 'pacifica', market: 'BTC-PERP', closeSide: 'short', dbBaseSize: 0.25,
      dbLastTradeId: 'EXAMPLE_ENTRY', closedSlice: 0.1, closingFills: [fill({ size: 0.1 })], nowMs: Date.now() });
    expect(restarted.kind).toBe('eligible');
    expect(remediateSubscriberCloseAccountingAtomic).not.toHaveBeenCalled();
    expect(placeMarketOrder).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid price %s', price => {
    const input = evidence(); input.trades = [fill({ price })];
    expect(subscriberCloseAccounting(input).pnl).toBeNull();
  });
  it.each(['account', 'market', 'order', 'side', 'time', 'duplicate', 'fee', 'entry', 'coverage'])('blocks ambiguous %s evidence', defect => {
    const input = evidence();
    if (defect === 'account') input.closeResult!.account = 'EXAMPLE_OTHER';
    if (defect === 'market') input.trades[0].internalSymbol = 'ETH-PERP';
    if (defect === 'order') input.trades[0].orderId = 'EXAMPLE_OTHER';
    if (defect === 'side') input.trades[0].side = 'long';
    if (defect === 'time') input.trades[0].timestamp = input.sentAt - 1;
    if (defect === 'duplicate') input.trades.push(input.trades[0]);
    if (defect === 'fee') input.trades[0].fee = NaN;
    if (defect === 'entry') input.baseline!.positions[0].entryPrice = 0;
    if (defect === 'coverage') input.trades[0].size = 0.24;
    const result = subscriberClosePersistence(subscriberCloseAccounting(input));
    expect(result.pnl).toBeNull(); expect(result.shareEligible).toBe(false);
  });
  it('does not double-subtract the close fee in the existing read convention', () => {
    const result = subscriberClosePersistence(subscriberCloseAccounting(evidence()));
    expect(result.pnl).toBe('249');
    expect(resolveBotTradeNetPnl({ pnlConvention: 'net_of_close_fee', pnl: result.pnl, fee: result.fee })).toBe(249);
  });
});
