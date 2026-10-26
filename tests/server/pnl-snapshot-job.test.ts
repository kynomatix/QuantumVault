import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: {
    getPublishedBots: vi.fn(), getTradingBotById: vi.fn(), getWallet: vi.fn(),
    getCanonicalBotTradeStats: vi.fn(), getBotEquityEvents: vi.fn(), getPnlSnapshots: vi.fn(),
    createPnlSnapshot: vi.fn(), updatePublishedBotStats: vi.fn(),
    incrementPublishedBotSubscribers: vi.fn(), createMarketplaceEquitySnapshot: vi.fn(),
  },
  adapter: { getAccountInfo: vi.fn(), subaccountCaps: { accountModel: 'shared' } },
  parked: vi.fn(),
}));
vi.mock('../../server/storage', () => ({ storage: mocks.storage }));
vi.mock('../../server/protocol/adapter-registry', () => ({
  getDefaultAdapter: () => mocks.adapter, getAdapterForBot: () => mocks.adapter,
}));
vi.mock('../../server/vault/vault-service', () => ({ sumVaultPositionValueUsdc: mocks.parked }));
import { takePnlSnapshots } from '../../server/pnl-snapshot-job';

const firstId = 'EXAMPLE_FIRST_BOT';
const nextId = 'EXAMPLE_NEXT_BOT';
const writeMethods = ['createPnlSnapshot', 'updatePublishedBotStats',
  'incrementPublishedBotSubscribers', 'createMarketplaceEquitySnapshot'] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.adapter.subaccountCaps.accountModel = 'shared';
  mocks.storage.getPublishedBots.mockResolvedValue([{
    id: 'EXAMPLE_PUBLIC', tradingBotId: firstId, isActive: true,
    creatorCapital: '100', totalCapitalInvested: '150', pnlPercentAllTime: '12.3456',
  }]);
  mocks.storage.getTradingBotById.mockImplementation(async (id: string) => ({
    id, name: id, activeProtocol: 'pacifica', walletAddress: 'EXAMPLE_WALLET',
    subaccountAuthMode: 'external_key', subaccountStatus: 'active',
    protocolSubaccountId: 'EXAMPLE_ACCOUNT', maxPositionSize: '9999', stats: { totalPnl: 4 },
  }));
  mocks.storage.getWallet.mockResolvedValue({});
  mocks.storage.getCanonicalBotTradeStats.mockResolvedValue({ totalTrades: 3, winningTrades: 2 });
  mocks.storage.getBotEquityEvents.mockResolvedValue([{ eventType: 'deposit', amount: '100' }]);
  mocks.storage.getPnlSnapshots.mockResolvedValue([]);
  mocks.adapter.getAccountInfo.mockResolvedValue({ balance: 120, unrealizedPnl: 5 });
  mocks.parked.mockResolvedValue({ ok: true, valueUsdc: 7 });
});
afterEach(() => vi.restoreAllMocks());

function expectNoWrites() {
  for (const method of writeMethods) expect(mocks.storage[method]).not.toHaveBeenCalled();
}

describe('published PnL equity availability', () => {
  it('skips all writes on adapter failure and snapshots the next bot', async () => {
    const first = (await mocks.storage.getPublishedBots())[0];
    mocks.storage.getPublishedBots.mockResolvedValue([
      first, { ...first, id: 'EXAMPLE_NEXT_PUBLIC', tradingBotId: nextId },
    ]);
    mocks.adapter.getAccountInfo.mockRejectedValueOnce(Error('EXAMPLE_RPC_FAILURE'));
    await takePnlSnapshots();
    for (const method of writeMethods) expect(mocks.storage[method]).toHaveBeenCalledTimes(1);
    expect(mocks.storage.createPnlSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      tradingBotId: nextId, equity: '120', unrealizedPnl: '5', totalDeposited: '100',
    }));
    expect(mocks.storage.updatePublishedBotStats).toHaveBeenCalledWith('EXAMPLE_NEXT_PUBLIC',
      expect.objectContaining({ creatorCapital: '120', pnlPercentAllTime: '20.0000' }));
    expect(mocks.storage.incrementPublishedBotSubscribers).toHaveBeenCalledWith('EXAMPLE_NEXT_PUBLIC', 0, 20);
    expect(mocks.storage.createMarketplaceEquitySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      publishedBotId: 'EXAMPLE_NEXT_PUBLIC', pnlPercent: '20.0000',
    }));
    expect(console.log).toHaveBeenCalledWith(
      `[PnL Snapshots] Skipping bot ${firstId.slice(0, 8)} (${firstId}): account equity unreadable (fail-closed)`);
    expect(mocks.storage.getCanonicalBotTradeStats).not.toHaveBeenCalledWith(firstId);
  });

  it.each([null, undefined, NaN, Infinity, -Infinity, '0'])(
    'skips malformed balance %s', async balance => {
      mocks.adapter.getAccountInfo.mockResolvedValue({ balance, unrealizedPnl: 0 });
      await takePnlSnapshots();
      expectNoWrites();
    });
  it.each([null, undefined, NaN, Infinity, -Infinity, '0'])(
    'skips malformed unrealized PnL %s', async unrealizedPnl => {
      mocks.adapter.getAccountInfo.mockResolvedValue({ balance: 120, unrealizedPnl });
      await takePnlSnapshots();
      expectNoWrites();
    });

  it('records a genuine finite zero, including its real loss percentage', async () => {
    mocks.adapter.getAccountInfo.mockResolvedValue({ balance: 0, unrealizedPnl: 0 });
    await takePnlSnapshots();
    expect(mocks.storage.createPnlSnapshot).toHaveBeenCalledWith(expect.objectContaining({ equity: '0', unrealizedPnl: '0' }));
    expect(mocks.storage.updatePublishedBotStats).toHaveBeenCalledWith('EXAMPLE_PUBLIC', expect.objectContaining({ creatorCapital: '0', pnlPercentAllTime: '-100.0000' }));
    expect(mocks.storage.incrementPublishedBotSubscribers).toHaveBeenCalledWith('EXAMPLE_PUBLIC', 0, -100);
    expect(mocks.storage.createMarketplaceEquitySnapshot).toHaveBeenCalledWith(expect.objectContaining({ equity: '0', pnlPercent: '-100.0000' }));
  });
});

describe('unknown deposit base', () => {
  it.each([
    { events: [], sum: '0' },
    { events: [{ eventType: 'withdrawal', amount: '-20' }], sum: '-20' },
    { events: [{ eventType: 'deposit', amount: '50' }, { eventType: 'withdrawal', amount: '-50' }], sum: '0' },
  ])('keeps private equity and capital, omits all-time and public history with net $sum', async ({ events, sum }) => {
    mocks.storage.getBotEquityEvents.mockResolvedValue(events);
    mocks.storage.getPnlSnapshots.mockResolvedValue([7, 30, 90].map(days => ({
      snapshotDate: new Date(Date.now() - days * 86400000), equity: '100',
    })));
    await takePnlSnapshots();
    expect(mocks.storage.createPnlSnapshot).toHaveBeenCalledWith(expect.objectContaining({ equity: '120', totalDeposited: sum }));
    const updates = mocks.storage.updatePublishedBotStats.mock.calls[0][1];
    expect(updates).not.toHaveProperty('pnlPercentAllTime');
    expect(updates).toEqual({ totalTrades: 3, winningTrades: 2, creatorCapital: '120',
      pnlPercent7d: '20.0000', pnlPercent30d: '20.0000', pnlPercent90d: '20.0000' });
    expect(mocks.storage.incrementPublishedBotSubscribers).toHaveBeenCalledWith('EXAMPLE_PUBLIC', 0, 20);
    expect(mocks.storage.createMarketplaceEquitySnapshot).not.toHaveBeenCalled();
  });
});

describe('parked vault equity', () => {
  it('still skips all writes when parked value is unavailable', async () => {
    mocks.adapter.subaccountCaps.accountModel = 'independent_trader';
    mocks.parked.mockResolvedValue({ ok: false });
    await takePnlSnapshots();
    expect(mocks.parked).toHaveBeenCalledWith('EXAMPLE_ACCOUNT');
    expectNoWrites();
  });
  it('still includes readable parked value', async () => {
    mocks.adapter.subaccountCaps.accountModel = 'independent_trader';
    await takePnlSnapshots();
    expect(mocks.storage.createPnlSnapshot).toHaveBeenCalledWith(expect.objectContaining({ equity: '127' }));
    expect(mocks.storage.createMarketplaceEquitySnapshot).toHaveBeenCalledWith(expect.objectContaining({ equity: '127', pnlPercent: '27.0000' }));
  });
});
