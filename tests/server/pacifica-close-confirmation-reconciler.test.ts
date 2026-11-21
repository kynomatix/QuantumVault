import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    protocolName: 'pacifica',
    getCloseConfirmationSnapshot: vi.fn(),
    getPositions: vi.fn(),
    getTradeHistory: vi.fn(),
    getAccountInfo: vi.fn(),
    getPrice: vi.fn(),
  },
  storage: {
    getTradingBotById: vi.fn(),
    getBotPosition: vi.fn(),
    getBotTrades: vi.fn(),
    getRecentCanonicalCloseForBot: vi.fn(),
    recordCloseEventAtomic: vi.fn(),
    updateBotTrade: vi.fn(),
    upsertBotPosition: vi.fn(),
    updateTradingBot: vi.fn(),
  },
  canonicalCloseFillId: vi.fn((input: { signature?: string | null }) =>
    input.signature ? `tx-${input.signature}` : 'unexpected-nosig-fallback'),
  sendTradeNotification: vi.fn(),
  schedulePartialCloseNotification: vi.fn(),
  maybeScheduleAutoRepark: vi.fn(),
  cancelAutoRepark: vi.fn(),
  recoveredRoute: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: mocks.storage,
  DatabaseStorage: {
    canonicalCloseFillId: mocks.canonicalCloseFillId,
  },
}));

vi.mock('../../server/trading/close-intent-store', async () => {
  const { makeLifecycleFenceFixture } = await import('../helpers/close-lifecycle-fence');
  return { closeIntentStore: makeLifecycleFenceFixture() };
});

vi.mock('../../server/protocol/adapter-registry', () => ({
  getDefaultAdapter: vi.fn(() => mocks.adapter),
  getAdapterForBot: vi.fn(() => mocks.adapter),
}));

vi.mock('../../server/notification-service', () => ({
  sendTradeNotification: mocks.sendTradeNotification,
  getCloseReasonLabel: vi.fn((reason: string) => reason),
  schedulePartialCloseNotification: mocks.schedulePartialCloseNotification,
}));

vi.mock('../../server/vault/auto-repark', () => ({
  maybeScheduleAutoRepark: mocks.maybeScheduleAutoRepark,
  cancelAutoRepark: mocks.cancelAutoRepark,
}));

import {
  buildRecoveredFullCloseRoutingSignal,
  buildRecoveredPartialCloseRoutingSignal,
  canonicalReconcilerFullCloseId,
  reconcileBotPosition,
  registerRecoveredCloseRoutingCallback,
  selectPendingPartialCloseMarker,
  selectPendingPartialMarkerForFullClose,
} from '../../server/reconciliation-service';
import {
  buildAccountingIncompleteFlatPosition,
  buildConfirmedFlatPosition,
} from '../../server/trading/signal-bot-close-integrity';

const walletAddress = 'wallet-public-address';
const agentPublicKey = 'agent-public-address';
const subaccountPublicKey = 'subaccount-public-address';
const market = 'BTC-PERP';

const bot = {
  id: 'bot',
  name: 'Signal Bot',
  activeProtocol: 'pacifica',
  protocolSubaccountId: subaccountPublicKey,
  autoParkIdle: false,
  parkDestinationAsset: null,
  riskConfig: null,
};

function storedPosition(lastTradeId: string | null) {
  return {
    baseSize: '0.00972',
    avgEntryPrice: '116500',
    realizedPnl: '0',
    totalFees: '0',
    lastTradeId,
    lastTradeAt: new Date('2026-07-21T00:00:00.000Z'),
  };
}

function pendingPartialMarker(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pending-partial-row',
    status: 'pending',
    side: 'short',
    market,
    size: '0.02',
    executedAt: new Date('2026-08-03T23:59:30.000Z'),
    txSignature: 'order-partial-one',
    protocolFillId: 'tx-partial-fill-partial-one',
    protocol: 'pacifica',
    webhookPayload: {
      partialClose: true,
      partialCloseAccounting: {
        expectedBaseSize: '1',
        expectedLastTradeId: 'entry-epoch-one',
        requestedClosedSize: 0.02,
      },
      executionAccounting: {
        price: 101,
        priceAuthority: 'venue_execution',
        fee: 0.01,
        pnl: 0.5,
      },
      feeEvidence: { kind: 'venue_exact' },
    },
    ...overrides,
  };
}

async function reconcile(botId: string) {
  return reconcileBotPosition(
    botId,
    walletAddress,
    agentPublicKey,
    0,
    market,
    subaccountPublicKey,
  );
}

describe('public reconciler requires qualified flatness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storage.getTradingBotById.mockResolvedValue(bot);
    mocks.storage.getBotPosition.mockResolvedValue(storedPosition('EXAMPLE_ENTRY'));
    mocks.storage.getBotTrades.mockResolvedValue([]);
    mocks.storage.getRecentCanonicalCloseForBot.mockResolvedValue(null);
    mocks.adapter.getPositions.mockResolvedValue([]);
    mocks.adapter.getTradeHistory.mockResolvedValue([]);
    mocks.adapter.getAccountInfo.mockResolvedValue({ exists: true, balance: 0, equity: 0 });
    mocks.adapter.getPrice.mockResolvedValue(117000);
    mocks.storage.recordCloseEventAtomic.mockResolvedValue({ isNew: true, trade: { id: 'EXAMPLE_CLOSE' } });
    mocks.sendTradeNotification.mockResolvedValue(undefined);
  });
  it.each([null, 'flat', 'exposed'])('handles no history with stored state %s without changing positions', async state => {
    mocks.storage.getBotPosition.mockResolvedValue(state === null ? null
      : { ...storedPosition('EXAMPLE_ENTRY'), baseSize: state === 'flat' ? '0' : '0.00972' });
    let sequence = 0;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => {
      const now = Date.now();
      return { positions: [], evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${++sequence}`,
        startedAt: now, dispatchedAt: now, receivedAt: now, lastOrderId: null, fresh: true, complete: true, noDedup: true } };
    });
    const result = await reconcile(`EXAMPLE_NO_HISTORY_${state}`);
    expect(result.synced).toBe(state !== 'exposed');
    expect(result.discrepancy).toBe(state === 'exposed');
    expect(mocks.storage.upsertBotPosition).not.toHaveBeenCalled();
    expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(mocks.storage.updateBotTrade).not.toHaveBeenCalled();
    expect(mocks.adapter.getPositions).not.toHaveBeenCalled();
  });
  it('completes qualified flat pending exposure without fabricating no-fill accounting', async () => {
    mocks.storage.getBotTrades.mockResolvedValue([{ id: 'EXAMPLE_PENDING', status: 'pending', side: 'CLOSE', market,
      executedAt: new Date(), txSignature: 'EXAMPLE_ORDER' }]);
    let sequence = 0;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => {
      const now = Date.now();
      return { positions: [], evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${++sequence}`,
        startedAt: now, dispatchedAt: now, receivedAt: now, lastOrderId: sequence, fresh: true, complete: true, noDedup: true } };
    });
    await reconcileBotPosition('EXAMPLE_PENDING_BOT', walletAddress, agentPublicKey, 0, market, subaccountPublicKey);
    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledOnce();
    expect(mocks.storage.recordCloseEventAtomic.mock.calls[0][0]).toMatchObject({
      update: { tradeId: 'EXAMPLE_PENDING', fields: { status: 'executed', fee: null, pnl: null } },
      confirmedPositionCloseIncomplete: { walletAddress, market },
    });
  });
  // Exercise the venue parser and both downstream money writers with a real envelope.
  it.each([
    { partial: false, orderId: '17,17', matches: false },
    // A rounded numeric acknowledgment persisted as text must not acquire a string-ID history fill.
    { partial: false, orderId: String(Number.MAX_SAFE_INTEGER + 1), signature: String(Number.MAX_SAFE_INTEGER + 1), matches: false },
    { partial: false, orderId: 17, matches: true },
    { partial: true, orderId: ' 17 ', matches: false },
    { partial: true, orderId: 17, matches: true },
  ])('ACCT-01 reconciles raw order $orderId (partial=$partial)', async ({ partial, orderId, signature = '17', matches }) => {
    const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
    (adapter as any).registry = new SymbolRegistry([{ internal: market, protocol: 'BTC', aliases: [] }]);
    (adapter as any).initialized = true;
    const now = Date.now();
    const envelope = { success: true, has_more: false, next_cursor: null, data: [{
      history_id: 901, order_id: orderId, symbol: 'BTC', amount: partial ? '0.02' : '1',
      price: '101', entry_price: '100', fee: '0.01', pnl: '1', event_type: 'fulfill_taker',
      side: 'close_long', cause: 'normal', created_at: now,
    }] };
    const transport = vi.spyOn(adapter as any, 'get').mockResolvedValue(envelope);
    mocks.adapter.getTradeHistory.mockImplementation(adapter.getTradeHistory.bind(adapter));
    mocks.storage.getBotPosition.mockResolvedValue({ ...storedPosition('entry-epoch-one'), baseSize: '1', avgEntryPrice: '100' });
    const pending = { id: 'EXAMPLE_PENDING', status: 'pending', market, executedAt: new Date(now - 1000), txSignature: signature };
    mocks.storage.getBotTrades.mockResolvedValue([partial ? pendingPartialMarker(pending) : { ...pending, side: 'CLOSE' }]);
    let sequence = 0;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => {
      const at = Date.now();
      return { positions: partial ? [{ internalSymbol: market, baseSize: 0.98, entryPrice: 100 }] : [],
        evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE-${++sequence}`, startedAt: at,
          dispatchedAt: at, receivedAt: at, lastOrderId: sequence, fresh: true, complete: true, noDedup: true } };
    });
    registerRecoveredCloseRoutingCallback(mocks.recoveredRoute);
    try {
      await reconcile('EXAMPLE_' + String(orderId) + partial);
      expect(transport).toHaveBeenCalled();
      if (partial && !matches) {
        expect(mocks.storage.updateBotTrade).toHaveBeenCalledWith(pending.id, expect.objectContaining({
          webhookPayload: expect.objectContaining({ partialCloseAuthorityOutcome: expect.objectContaining({
            incompleteReason: 'pending_partial_marker_identity_or_money_unavailable',
          }) }),
        }));
        expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
        expect(mocks.recoveredRoute).not.toHaveBeenCalled();
      } else {
        expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledOnce();
        const event = mocks.storage.recordCloseEventAtomic.mock.calls[0][0];
        expect(event.update.tradeId).toBe(pending.id);
        if (matches) {
          expect(event).toHaveProperty(partial ? 'confirmedPositionReduction' : 'confirmedPositionClose');
          expect(Number(event.update.fields.fee)).toBeGreaterThan(0);
          if (partial) expect(mocks.recoveredRoute).toHaveBeenCalledOnce();
        } else {
          expect(event).toHaveProperty('confirmedPositionCloseIncomplete');
          expect(event.update.fields).toMatchObject({ pnl: null, fee: null });
          expect(event.deltas).not.toHaveProperty('totalPnlDelta');
        }
      }
    } finally { registerRecoveredCloseRoutingCallback(async () => {}); }
  });
  it.each(['unavailable', 'wrong-account', 'residual', 'second-read-failed'])('low equity cannot substitute for %s inventory', async defect => {
    let sequence = 0;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => {
      sequence++;
      if (defect === 'unavailable' || (defect === 'second-read-failed' && sequence > 1)) throw new Error('EXAMPLE unavailable');
      const now = Date.now();
      return { positions: defect === 'residual' ? [{ internalSymbol: market, baseSize: 0.000000001, entryPrice: 116500 }] : [],
        evidence: { account: defect === 'wrong-account' ? 'EXAMPLE_WRONG' : account, environment: 'EXAMPLE', requestId: `EXAMPLE-${sequence}`,
          startedAt: now, dispatchedAt: now, receivedAt: now, lastOrderId: sequence, fresh: true, complete: true, noDedup: true } };
    });
    await reconcileBotPosition(`EXAMPLE_${defect}`, walletAddress, agentPublicKey, 0, market, subaccountPublicKey);
    if (defect !== 'residual') expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    for (const [event] of mocks.storage.recordCloseEventAtomic.mock.calls) {
      expect(event).not.toHaveProperty('confirmedPositionClose');
      expect(event).not.toHaveProperty('confirmedPositionCloseIncomplete');
    }
    expect(mocks.storage.updateBotTrade).not.toHaveBeenCalled();
    expect(mocks.storage.upsertBotPosition.mock.calls.every(([position]) => position.baseSize !== '0')).toBe(true);
  });
});
