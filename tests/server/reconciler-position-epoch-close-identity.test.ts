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
    getRecentCanonicalCloseForBot: vi.fn(),
    recordCloseEventAtomic: vi.fn(),
    upsertBotPosition: vi.fn(),
    updateTradingBot: vi.fn(),
  },
  canonicalCloseFillId: vi.fn((input: { signature?: string | null }) =>
    input.signature ? `tx-${input.signature}` : 'unexpected-nosig-fallback'),
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

import {
  canonicalReconcilerFullCloseId,
  reconcileBotPosition,
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
    mocks.storage.recordCloseEventAtomic.mockResolvedValue({ isNew: true });
    mocks.storage.upsertBotPosition.mockImplementation(async value => value);
    mocks.adapter.getPositions.mockResolvedValue([]);
    mocks.adapter.getTradeHistory.mockResolvedValue([]);
    mocks.adapter.getAccountInfo.mockResolvedValue({
      exists: true,
      balance: 100,
      equity: 100,
    });
    mocks.adapter.getPrice.mockResolvedValue(117000);
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
