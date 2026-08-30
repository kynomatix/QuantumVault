import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
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

const walletAddress = 'wallet-public-address';
const agentPublicKey = 'agent-public-address';
const subaccountPublicKey = 'subaccount-public-address';
const market = 'BTC-PERP';

const bot = {
  id: 'bot',
  name: 'Signal Bot',
  activeProtocol: 'pacifica',
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

describe('reconciler full-close position epoch identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    mocks.storage.getTradingBotById.mockResolvedValue(bot);
    mocks.storage.getBotPosition.mockResolvedValue(storedPosition('entry-epoch-one'));
    mocks.storage.getRecentCanonicalCloseForBot.mockResolvedValue(null);
    mocks.storage.getBotTrades.mockResolvedValue([]);
    mocks.storage.recordCloseEventAtomic.mockResolvedValue({
      isNew: true,
      trade: { id: 'canonical-close-row' },
    });
    mocks.storage.updateBotTrade.mockResolvedValue(undefined);
    mocks.storage.upsertBotPosition.mockImplementation(async value => value);
    mocks.adapter.getPositions.mockResolvedValue([]);
    mocks.adapter.getTradeHistory.mockResolvedValue([]);
    mocks.adapter.getAccountInfo.mockResolvedValue({
      exists: true,
      balance: 100,
      equity: 100,
    });
    mocks.adapter.getPrice.mockResolvedValue(117000);
    mocks.sendTradeNotification.mockResolvedValue(undefined);
    mocks.recoveredRoute.mockResolvedValue(undefined);
    registerRecoveredCloseRoutingCallback(mocks.recoveredRoute);
  });

  it('selects one exact Pacifica marker and refuses stale or fill-less recovery', () => {
    const marker = pendingPartialMarker();
    const fill = {
      tradeId: 'fill-partial-one',
      orderId: 'order-partial-one',
      internalSymbol: market,
      side: 'short',
      venueEventKind: 'close_long',
      price: 101,
      size: 0.02,
      fee: 0.01,
      realizedPnl: 0.5,
      timestamp: Date.now(),
    };
    expect(selectPendingPartialCloseMarker({
      trades: [marker],
      protocol: 'pacifica',
      market,
      closeSide: 'short',
      dbBaseSize: 1,
      dbLastTradeId: 'entry-epoch-one',
      closedSlice: 0.02,
      closingFills: [fill],
      nowMs: Date.now(),
    })).toMatchObject({ kind: 'eligible', trade: { id: 'pending-partial-row' } });
    expect(selectPendingPartialCloseMarker({
      trades: [marker],
      protocol: 'pacifica',
      market,
      closeSide: 'short',
      dbBaseSize: 1,
      dbLastTradeId: 'entry-epoch-one',
      closedSlice: 0.02,
      closingFills: [],
      nowMs: Date.now(),
    })).toMatchObject({ kind: 'blocked', reason: 'pending_partial_marker_identity_or_money_unavailable' });
    expect(selectPendingPartialCloseMarker({
      trades: [marker],
      protocol: 'pacifica',
      market,
      closeSide: 'short',
      dbBaseSize: 1,
      dbLastTradeId: 'entry-epoch-one',
      closedSlice: 0.02,
      closingFills: [fill],
      nowMs: Date.now() + 60 * 60 * 1000 + 1,
    })).toMatchObject({ kind: 'blocked' });
  });

  it('requires exact fill identity before a pending partial marker can become a full close', () => {
    const marker = pendingPartialMarker();
    expect(selectPendingPartialMarkerForFullClose({
      trades: [marker],
      market,
      closeSide: 'short',
      dbBaseSize: 1,
      dbLastTradeId: 'entry-epoch-one',
      fillTradeIds: ['fill-partial-one'],
      fillOrderIds: [],
      nowMs: Date.now(),
    })).toMatchObject({ kind: 'eligible', trade: { id: 'pending-partial-row' } });
    expect(selectPendingPartialMarkerForFullClose({
      trades: [marker],
      market,
      closeSide: 'short',
      dbBaseSize: 1,
      dbLastTradeId: 'entry-epoch-one',
      fillTradeIds: [],
      fillOrderIds: [],
      nowMs: Date.now(),
    })).toEqual({
      kind: 'blocked',
      reason: 'liquidation_pending_fill_identity',
      markerIds: ['pending-partial-row'],
    });
  });

  it('builds typed recovery routing payloads and rejects invalid fractions', () => {
    expect(buildRecoveredPartialCloseRoutingSignal({
      preCloseBaseSize: 1,
      requestedClosedSize: 0.02,
      residualBaseSize: 0.98,
      price: 101,
    })).toMatchObject({
      action: 'sell',
      contracts: '0.02',
      positionSize: '0.98',
      partialCloseFraction: 0.02,
      isCloseSignal: false,
    });
    expect(buildRecoveredPartialCloseRoutingSignal({
      preCloseBaseSize: 1,
      requestedClosedSize: 1,
      residualBaseSize: 0,
      price: 101,
    })).toBeNull();
    expect(buildRecoveredFullCloseRoutingSignal({ preCloseBaseSize: -1, price: 99 }))
      .toMatchObject({ action: 'buy', positionSize: '0', isCloseSignal: true });
  });

  it('recovers a signed below-three-percent partial from its marker and routes effects once', async () => {
    mocks.storage.getBotPosition.mockResolvedValue({
      ...storedPosition('entry-epoch-one'),
      baseSize: '1',
      avgEntryPrice: '100',
    });
    mocks.storage.getBotTrades.mockResolvedValue([pendingPartialMarker()]);
    mocks.adapter.getPositions.mockResolvedValue([{
      internalSymbol: market,
      baseSize: 0.98,
      entryPrice: 100,
      markPrice: 101,
      unrealizedPnl: 0.98,
    }]);
    mocks.adapter.getTradeHistory.mockResolvedValue([{
      tradeId: 'fill-partial-one',
      orderId: 'order-partial-one',
      internalSymbol: market,
      side: 'short',
      venueEventKind: 'close_long',
      price: 101,
      size: 0.02,
      fee: 0.01,
      realizedPnl: 0.5,
      timestamp: Date.now(),
    }]);

    await expect(reconcile('below-three-percent')).resolves.toEqual({
      synced: true,
      discrepancy: true,
    });
    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ tradeId: 'pending-partial-row' }),
      confirmedPositionReduction: expect.objectContaining({
        expectedBaseSize: '1',
        expectedLastTradeId: 'entry-epoch-one',
        residualBaseSize: 0.98,
      }),
    }));
    expect(mocks.recoveredRoute).toHaveBeenCalledTimes(1);
    expect(mocks.recoveredRoute).toHaveBeenCalledWith('below-three-percent', expect.objectContaining({
      partialCloseFraction: 0.02,
      isCloseSignal: false,
    }));
  });

  it('supersedes a pending partial only with a separate fill-backed full close and routes once', async () => {
    mocks.storage.getBotPosition.mockResolvedValue({
      ...storedPosition('entry-epoch-one'),
      baseSize: '1',
      avgEntryPrice: '100',
    });
    mocks.storage.getBotTrades.mockResolvedValue([pendingPartialMarker()]);
    mocks.adapter.getTradeHistory.mockResolvedValue([{
      tradeId: 'fill-partial-one',
      orderId: 'order-partial-one',
      internalSymbol: market,
      side: 'short',
      venueEventKind: 'close_long',
      price: 99,
      size: 1,
      fee: 0.1,
      realizedPnl: -1,
      timestamp: Date.now(),
    }]);

    await expect(reconcile('fill-backed-full')).resolves.toEqual({
      synced: true,
      discrepancy: true,
      liquidation: false,
    });
    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({
      insert: expect.objectContaining({
        tradingBotId: 'fill-backed-full',
        status: 'executed',
        pnlConvention: 'net_of_close_fee',
      }),
      confirmedPositionClose: expect.any(Object),
      supersedePendingPartialTradeId: 'pending-partial-row',
    }));
    expect(mocks.recoveredRoute).toHaveBeenCalledTimes(1);
    expect(mocks.recoveredRoute).toHaveBeenCalledWith('fill-backed-full', expect.objectContaining({
      isCloseSignal: true,
      positionSize: '0',
    }));
  });

  it('converges exposure flat but leaves a fill-less pending marker incomplete with no money effects', async () => {
    mocks.storage.getBotPosition.mockResolvedValue({
      ...storedPosition('entry-epoch-one'),
      baseSize: '1',
      avgEntryPrice: '100',
    });
    mocks.storage.getBotTrades.mockResolvedValue([pendingPartialMarker()]);
    mocks.adapter.getTradeHistory.mockResolvedValue([]);

    await expect(reconcile('fill-less-flat')).resolves.toEqual({ synced: true, discrepancy: false });
    vi.setSystemTime(new Date('2026-08-04T00:01:31.000Z'));
    await expect(reconcile('fill-less-flat')).resolves.toEqual({
      synced: true,
      discrepancy: true,
      liquidation: false,
    });
    expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(mocks.storage.updateBotTrade).toHaveBeenCalledWith('pending-partial-row', expect.objectContaining({
      errorMessage: expect.stringContaining('liquidation_pending_fill_identity'),
    }));
    expect(mocks.storage.upsertBotPosition).toHaveBeenCalledWith(expect.objectContaining({
      baseSize: '0',
      realizedPnl: '0',
      totalFees: '0',
    }));
    expect(mocks.recoveredRoute).not.toHaveBeenCalled();
  });

  it('ignores mutable estimate price and observation time for one entry epoch', () => {
    const first = canonicalReconcilerFullCloseId({
      botId: 'bot-one',
      market,
      positionEpochId: 'entry-one',
    });
    vi.setSystemTime(new Date('2026-08-04T05:00:00.000Z'));
    mocks.adapter.getPrice.mockResolvedValue(121000);
    const later = canonicalReconcilerFullCloseId({
      botId: 'bot-one',
      market,
      positionEpochId: 'entry-one',
    });

    expect(later).toBe(first);
    expect(mocks.canonicalCloseFillId).toHaveBeenLastCalledWith(expect.objectContaining({
      signature: 'reconciler-position-epoch|bot-one|BTC|entry-one',
    }));
  });

  it('distinguishes two recorded entry epochs even at identical market, size, and price', () => {
    const first = canonicalReconcilerFullCloseId({
      botId: 'bot-one',
      market,
      positionEpochId: 'entry-one',
    });
    const second = canonicalReconcilerFullCloseId({
      botId: 'bot-one',
      market,
      positionEpochId: 'entry-two',
    });

    expect(first).not.toBe(second);
  });

  it('keeps a protocol fill identifier primary', () => {
    expect(canonicalReconcilerFullCloseId({
      protocolFillId: 'venue-fill-one',
      botId: 'bot-one',
      market,
      positionEpochId: 'entry-one',
    })).toBe('tx-venue-fill-one');
  });

  it('promotes the matching pending close row from exact venue fills instead of inserting a duplicate', async () => {
    mocks.storage.getBotTrades.mockResolvedValue([{
      id: 'pending-close-row',
      status: 'pending',
      side: 'CLOSE',
      market,
      executedAt: new Date('2026-08-03T23:59:00.000Z'),
      webhookPayload: { source: 'webhook' },
    }]);
    mocks.adapter.getTradeHistory.mockResolvedValue([{
      tradeId: 'venue-fill-one',
      orderId: 'order-one',
      internalSymbol: market,
      side: 'short',
      venueEventKind: 'close_long',
      price: 117000,
      size: 0.00972,
      fee: 0.25,
      realizedPnl: 4.86,
      timestamp: Date.now(),
    }]);

    await expect(reconcile('pending-close')).resolves.toEqual({
      synced: true,
      discrepancy: true,
      liquidation: false,
    });

    expect(mocks.storage.getRecentCanonicalCloseForBot).not.toHaveBeenCalled();
    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'pending-close',
      update: expect.objectContaining({
        tradeId: 'pending-close-row',
        fields: expect.objectContaining({
          status: 'executed',
          protocolFillId: 'tx-venue-fill-one',
          fee: '0.25',
        }),
      }),
      confirmedPositionClose: expect.objectContaining({
        walletAddress,
        market,
        feeDelta: 0.25,
      }),
    }));
    expect(mocks.storage.upsertBotPosition).not.toHaveBeenCalled();
  });

  it('refuses a no-fill close with no durable position epoch before mutation or notification', async () => {
    mocks.storage.getBotPosition.mockResolvedValue(storedPosition(null));

    await expect(reconcile('missing-epoch')).resolves.toEqual({
      synced: true,
      discrepancy: false,
    });
    vi.setSystemTime(new Date('2026-08-04T00:01:31.000Z'));
    await expect(reconcile('missing-epoch')).resolves.toEqual({
      synced: false,
      discrepancy: true,
    });

    expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(mocks.storage.upsertBotPosition).not.toHaveBeenCalled();
    expect(mocks.sendTradeNotification).not.toHaveBeenCalled();
  });

  it('collapses a repeated no-fill close for one unchanged epoch without a second flatten or alert', async () => {
    mocks.storage.recordCloseEventAtomic
      .mockResolvedValueOnce({ isNew: true })
      .mockResolvedValueOnce({ isNew: false });

    await reconcile('repeat-epoch');
    vi.setSystemTime(new Date('2026-08-04T00:01:31.000Z'));
    await reconcile('repeat-epoch');

    vi.setSystemTime(new Date('2026-08-04T00:02:00.000Z'));
    await reconcile('repeat-epoch');
    vi.setSystemTime(new Date('2026-08-04T00:03:31.000Z'));
    await reconcile('repeat-epoch');

    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledTimes(2);
    const firstId = mocks.storage.recordCloseEventAtomic.mock.calls[0][0].insert.protocolFillId;
    const repeatedId = mocks.storage.recordCloseEventAtomic.mock.calls[1][0].insert.protocolFillId;
    expect(repeatedId).toBe(firstId);
    expect(firstId).toContain('entry-epoch-one');
    expect(mocks.storage.upsertBotPosition).toHaveBeenCalledTimes(1);
    expect(mocks.sendTradeNotification).toHaveBeenCalledTimes(1);
  });
});
