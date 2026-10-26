import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: {
    getWalletsWithTradingBots: vi.fn(), getWallet: vi.fn(), getTradingBots: vi.fn(),
    sumOpenBorrowDebtUsdc: vi.fn(), getWalletTradeStats: vi.fn(),
    getWalletCreatorEarnings: vi.fn(), getWalletCumulativeDepositsWithdrawals: vi.fn(),
    getLatestPortfolioDailySnapshot: vi.fn(), getPortfolioDailySnapshots: vi.fn(),
    upsertPortfolioDailySnapshot: vi.fn(),
  },
  adapter: { getAccountInfo: vi.fn() },
  reconcile: vi.fn(),
}));
vi.mock('../../server/storage', () => ({ storage: mocks.storage }));
vi.mock('../../server/rpc-config', () => ({ createSolanaRpcConnection: vi.fn() }));
vi.mock('../../server/deposit-reconciler', () => ({ reconcileWalletDeposits: mocks.reconcile }));
vi.mock('../../server/vault/vault-service', () => ({ sumVaultPositionValueUsdc: vi.fn() }));
vi.mock('../../server/protocol/adapter-registry', () => ({
  getDefaultAdapter: () => mocks.adapter, getAdapterForBot: () => mocks.adapter,
}));
vi.mock('../../server/protocol/flash/manual-withdrawal', () => ({ getManualFlashWithdrawalAdapter: vi.fn() }));
import { processWalletSnapshot, startPortfolioSnapshotJob, takePortfolioSnapshots } from '../../server/portfolio-snapshot-job';

const wallet = 'EXAMPLE_OWNER';
const boundary = new Date('2026-10-27T12:00:00.000Z');
let rows: Array<{ snapshotDate: Date; totalBalance: string }>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:03:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rows = [];
  mocks.storage.getWalletsWithTradingBots.mockResolvedValue([wallet]);
  mocks.storage.getWallet.mockResolvedValue({});
  mocks.storage.getTradingBots.mockResolvedValue([{
    id: 'EXAMPLE_BOT', activeProtocol: 'pacifica', isActive: true,
    subaccountAuthMode: 'external_key', subaccountStatus: 'active', protocolSubaccountId: 'EXAMPLE_ACCOUNT',
  }]);
  mocks.adapter.getAccountInfo.mockResolvedValue({ balance: 120 });
  mocks.storage.sumOpenBorrowDebtUsdc.mockResolvedValue(0);
  mocks.storage.getWalletTradeStats.mockResolvedValue({ totalTrades: 1, totalVolume: 30 });
  mocks.storage.getWalletCreatorEarnings.mockResolvedValue(0);
  mocks.storage.getWalletCumulativeDepositsWithdrawals.mockResolvedValue({ deposits: 100, withdrawals: 0, internalTransfers: 0 });
  mocks.storage.getLatestPortfolioDailySnapshot.mockResolvedValue(undefined);
  mocks.storage.getPortfolioDailySnapshots.mockImplementation(async () => rows);
  mocks.storage.upsertPortfolioDailySnapshot.mockImplementation(async (snapshot, preserveExisting) => {
    if (preserveExisting && rows.some(row => +row.snapshotDate === +snapshot.snapshotDate)) return undefined;
    rows.push(snapshot);
    return snapshot;
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('portfolio snapshot boot capture', () => {
  it('leaves the 12:00 row untouched on a 15:37 boot and logs one skip', async () => {
    vi.setSystemTime(new Date('2026-10-27T15:37:00.000Z'));
    rows.push({ snapshotDate: boundary, totalBalance: '75' });
    startPortfolioSnapshotJob();
    vi.mocked(console.log).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rows).toEqual([{ snapshotDate: boundary, totalBalance: '75' }]);
    expect(mocks.storage.getWalletsWithTradingBots).not.toHaveBeenCalled();
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('writes a missing 12:00 bucket on a 12:03 boot', async () => {
    startPortfolioSnapshotJob();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshotDate: boundary, totalBalance: '120', cumulativeTradingPnl: '20',
    }), true);
    expect(mocks.storage.getWalletCumulativeDepositsWithdrawals).toHaveBeenCalledWith(wallet, new Date('2026-10-27T12:03:05.000Z'));
  });

  it('does not read live balances or overwrite an existing bucket on boot', async () => {
    rows.push({ snapshotDate: boundary, totalBalance: '75' });
    startPortfolioSnapshotJob();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.storage.getPortfolioDailySnapshots).toHaveBeenCalledWith(wallet, boundary);
    expect(mocks.adapter.getAccountInfo).not.toHaveBeenCalled();
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
    expect(rows[0].totalBalance).toBe('75');
  });

  it('requests atomic preservation if a row appears after the initial existence check', async () => {
    mocks.storage.upsertPortfolioDailySnapshot.mockResolvedValue(undefined);
    await takePortfolioSnapshots('boot');
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshotDate: boundary }), true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('current bucket already exists'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Saved snapshot'));
  });

  it.each(['scheduled', 'boot'] as const)('skips a %s capture outside the window', async trigger => {
    vi.setSystemTime(new Date('2026-10-27T12:10:00.000Z'));
    await processWalletSnapshot(wallet, trigger);
    expect(mocks.storage.getWallet).not.toHaveBeenCalled();
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
  });

  it('discards a balance read that crosses the window cutoff', async () => {
    mocks.adapter.getAccountInfo.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-27T12:10:00.000Z'));
      return { balance: 120 };
    });
    await processWalletSnapshot(wallet, 'boot');
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
  });

  it('does not move a slow previous-bucket read into the new bucket', async () => {
    mocks.adapter.getAccountInfo.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-28T00:03:00.000Z'));
      return { balance: 120 };
    });
    await processWalletSnapshot(wallet, 'boot');
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
  });

  it('uses the balance observation time for deposit and withdrawal totals', async () => {
    const observed = new Date('2026-10-27T12:03:07.123Z');
    mocks.adapter.getAccountInfo.mockImplementation(async () => {
      vi.setSystemTime(observed);
      return { balance: 125 };
    });
    mocks.reconcile.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-27T12:04:00.000Z'));
    });
    mocks.storage.getWalletCumulativeDepositsWithdrawals.mockImplementation(async (_wallet, asOf) => ({
      deposits: +asOf >= +observed ? 130 : 100, withdrawals: +asOf >= +observed ? 5 : 0, internalTransfers: 2,
    }));
    await processWalletSnapshot(wallet);
    expect(mocks.storage.getWalletCumulativeDepositsWithdrawals).toHaveBeenCalledWith(wallet, observed);
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshotDate: boundary, totalBalance: '125', cumulativeExternalDeposits: '130',
      cumulativeExternalWithdrawals: '5', cumulativeTradingPnl: '0', netExternalFlow: '125',
    }));
  });

  it('retains the failed-balance skip', async () => {
    mocks.adapter.getAccountInfo.mockRejectedValue(new Error('EXAMPLE_READ_FAILURE'));
    await processWalletSnapshot(wallet, 'boot');
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
    expect(mocks.storage.getWalletCumulativeDepositsWithdrawals).not.toHaveBeenCalled();
  });
});

describe('UTC boundaries and scheduling', () => {
  it.each(['Asia/Kolkata', 'Australia/Adelaide'])('keeps midnight and noon on the grid in %s', async tz => {
    vi.stubEnv('TZ', tz);
    try {
      for (const hour of ['00', '12']) {
        vi.setSystemTime(new Date(`2026-10-27T${hour}:03:45.678Z`));
        await processWalletSnapshot(wallet);
        expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
          snapshotDate: new Date(`2026-10-27T${hour}:00:00.000Z`),
        }));
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['2026-10-27T11:59:59.900Z', '2026-10-27T23:59:59.900Z'])('fires exactly at the next boundary from %s', async started => {
    vi.setSystemTime(new Date(started));
    const nextBoundary = new Date(Date.now() + 100);
    startPortfolioSnapshotJob();
    await vi.advanceTimersByTimeAsync(99);
    expect(mocks.storage.upsertPortfolioDailySnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshotDate: nextBoundary }));
    expect(mocks.storage.getWalletCumulativeDepositsWithdrawals).toHaveBeenCalledWith(wallet, nextBoundary);
  });

  it('reschedules to midnight after a slow noon run without accumulating drift', async () => {
    vi.setSystemTime(new Date('2026-10-27T11:59:59.900Z'));
    let finishRead: ((balance: { balance: number }) => void) | undefined;
    mocks.adapter.getAccountInfo.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    startPortfolioSnapshotJob();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(120_000);
    finishRead!({ balance: 120 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(43_080_000 - 1);
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      snapshotDate: new Date('2026-10-28T00:00:00.000Z'),
    }));
    expect(mocks.storage.upsertPortfolioDailySnapshot).toHaveBeenCalledTimes(2);
  });
});
