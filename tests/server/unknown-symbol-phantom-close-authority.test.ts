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
  canonicalCloseFillId: vi.fn(() => 'partial-known-fill'),
  sendTradeNotification: vi.fn(),
  schedulePartialCloseNotification: vi.fn(),
  maybeScheduleAutoRepark: vi.fn(),
  cancelAutoRepark: vi.fn(),
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

import { reconcileBotPosition } from '../../server/reconciliation-service';

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

const dbPosition = {
  baseSize: '10',
  avgEntryPrice: '100',
  realizedPnl: '0',
  totalFees: '0',
  lastTradeId: 'open-trade',
  lastTradeAt: new Date('2026-07-01T00:00:00.000Z'),
};

const position = (internalSymbol: string, baseSize: number) => ({
  internalSymbol,
  baseSize,
  entryPrice: 100,
  markPrice: 101,
  unrealizedPnl: baseSize,
});

const trade = (internalSymbol: string, side: 'long' | 'short' = 'short') => ({
  tradeId: `fill-${internalSymbol}`,
  orderId: 'order',
  internalSymbol,
  side,
  price: 105,
  size: 5,
  fee: 0.1,
  timestamp: Date.now(),
});

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

function expectNoCloseMutation() {
  expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
  expect(mocks.storage.upsertBotPosition).not.toHaveBeenCalled();
  expect(mocks.sendTradeNotification).not.toHaveBeenCalled();
  expect(mocks.schedulePartialCloseNotification).not.toHaveBeenCalled();
}

describe('Signal Bot unknown-symbol close authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    mocks.storage.getTradingBotById.mockResolvedValue(bot);
    mocks.storage.getBotPosition.mockResolvedValue(dbPosition);
    mocks.storage.getBotTrades.mockResolvedValue([]);
    mocks.storage.getRecentCanonicalCloseForBot.mockResolvedValue(null);
    mocks.storage.recordCloseEventAtomic.mockResolvedValue({ isNew: true });
    mocks.storage.upsertBotPosition.mockImplementation(async value => value);
    mocks.adapter.getAccountInfo.mockResolvedValue({
      exists: true,
      balance: 100,
      equity: 100,
    });
    mocks.adapter.getPrice.mockResolvedValue(105);
  });

  it('refuses an initial position set containing an unknown protocol symbol', async () => {
    mocks.adapter.getPositions.mockResolvedValue([position('UNKNOWN-BTC', 10)]);

    await expect(reconcile('initial-unknown')).resolves.toEqual({
      synced: false,
      discrepancy: false,
    });

    expect(mocks.storage.getBotPosition).not.toHaveBeenCalled();
    expect(mocks.adapter.getTradeHistory).not.toHaveBeenCalled();
    expectNoCloseMutation();
  });

  it.each([1, 2, 3])(
    'refuses unknown trade-history evidence from window %i before a full close can be inferred',
    async unknownWindow => {
    mocks.adapter.getPositions.mockResolvedValue([]);
    mocks.adapter.getTradeHistory.mockImplementation(async () => {
      const call = mocks.adapter.getTradeHistory.mock.calls.length;
      return call === unknownWindow ? [trade('UNKNOWN-BTC')] : [];
    });

    await expect(reconcile('history-unknown')).resolves.toEqual({
      synced: true,
      discrepancy: false,
    });

    expect(mocks.adapter.getTradeHistory).toHaveBeenCalledTimes(unknownWindow);
    expect(mocks.adapter.getAccountInfo).not.toHaveBeenCalled();
    expectNoCloseMutation();
    },
  );

  it('resets corroboration and refuses an unknown final confirmation position', async () => {
    mocks.adapter.getPositions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([position('UNKNOWN-BTC', 10)]);
    mocks.adapter.getTradeHistory.mockResolvedValue([]);

    await expect(reconcile('confirm-unknown')).resolves.toEqual({
      synced: true,
      discrepancy: false,
    });

    vi.setSystemTime(new Date('2026-08-04T00:01:31.000Z'));

    await expect(reconcile('confirm-unknown')).resolves.toEqual({
      synced: true,
      discrepancy: false,
    });

    expect(mocks.adapter.getPositions).toHaveBeenCalledTimes(3);
    expect(mocks.adapter.getTradeHistory).toHaveBeenCalledTimes(6);
    expectNoCloseMutation();
  });

  it('preserves the complete stored position when partial-close fill evidence is unknown', async () => {
    mocks.adapter.getPositions.mockResolvedValue([position('BTC-PERP', 5)]);
    mocks.adapter.getTradeHistory.mockResolvedValue([trade('UNKNOWN-ETH')]);

    await expect(reconcile('partial-unknown')).resolves.toEqual({
      synced: false,
      discrepancy: true,
    });

    expect(mocks.storage.getBotPosition).toHaveBeenCalledTimes(1);
    expectNoCloseMutation();
  });

  it('retains the known-symbol partial-reduction accounting and position sync path', async () => {
    mocks.adapter.getPositions.mockResolvedValue([position('BTC-PERP', 5)]);
    mocks.adapter.getTradeHistory.mockResolvedValue([trade('BTC-PERP')]);

    await expect(reconcile('partial-known')).resolves.toEqual({
      synced: true,
      discrepancy: true,
    });

    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledTimes(1);
    expect(mocks.schedulePartialCloseNotification).toHaveBeenCalledTimes(1);
    expect(mocks.storage.upsertBotPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        tradingBotId: 'partial-known',
        market: 'BTC-PERP',
        baseSize: '5',
      }),
    );
  });
});
