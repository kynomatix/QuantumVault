import { beforeEach, expect, it, vi } from 'vitest';
import type { InsertPortfolioDailySnapshot } from '@shared/schema';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), values: vi.fn(), skip: vi.fn(), update: vi.fn(), returning: vi.fn() }));
vi.mock('../../server/db', () => ({
  db: { insert: mocks.insert }, pool: { connect: vi.fn() },
  ensureSchema: vi.fn(), checkUmkStorageSecretHealth: vi.fn(),
}));
import { DatabaseStorage } from '../../server/storage';
import { portfolioDailySnapshots } from '@shared/schema';

const snapshot: InsertPortfolioDailySnapshot = {
  walletAddress: 'EXAMPLE_OWNER', snapshotDate: new Date('2026-10-27T12:00:00.000Z'),
  totalBalance: '120', cumulativeDeposits: '100', cumulativeWithdrawals: '0', netPnl: '20',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ onConflictDoNothing: mocks.skip, onConflictDoUpdate: mocks.update });
  mocks.skip.mockReturnValue({ returning: mocks.returning });
  mocks.update.mockReturnValue({ returning: mocks.returning });
});

it('preserves a competing boot row through the wallet/date unique constraint', async () => {
  mocks.returning.mockResolvedValue([]);
  expect(await new DatabaseStorage().upsertPortfolioDailySnapshot(snapshot, true)).toBeUndefined();
  expect(mocks.skip).toHaveBeenCalledWith({ target: [portfolioDailySnapshots.walletAddress, portfolioDailySnapshots.snapshotDate] });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('returns a successfully inserted boot row', async () => {
  mocks.returning.mockResolvedValue([snapshot]);
  expect(await new DatabaseStorage().upsertPortfolioDailySnapshot(snapshot, true)).toEqual(snapshot);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('retains the existing upsert behavior for scheduled snapshots', async () => {
  mocks.returning.mockResolvedValue([snapshot]);
  expect(await new DatabaseStorage().upsertPortfolioDailySnapshot(snapshot)).toEqual(snapshot);
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ totalBalance: '120', cumulativeTradingPnl: undefined }) }));
  expect(mocks.skip).not.toHaveBeenCalled();
});
