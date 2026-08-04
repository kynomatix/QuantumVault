import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: {
    getWalletsWithActiveBots: vi.fn(),
    getWallet: vi.fn(),
    getTradingBots: vi.fn(),
    getBotPosition: vi.fn(),
  },
  adapter: {
    getPositions: vi.fn(),
  },
}));

vi.mock('../../server/storage', () => ({
  storage: mocks.storage,
  DatabaseStorage: {},
}));

vi.mock('../../server/protocol/adapter-registry', () => ({
  getDefaultAdapter: vi.fn(() => mocks.adapter),
  getAdapterForBot: vi.fn(() => mocks.adapter),
}));

vi.mock('../../server/notification-service', () => ({
  sendTradeNotification: vi.fn(),
  getCloseReasonLabel: vi.fn((reason: string) => reason),
  schedulePartialCloseNotification: vi.fn(),
}));

vi.mock('../../server/vault/auto-repark', () => ({
  maybeScheduleAutoRepark: vi.fn(),
  cancelAutoRepark: vi.fn(),
}));

import {
  startPeriodicReconciliation,
  stopPeriodicReconciliation,
} from '../../server/reconciliation-service';

const TICK_MS = 60_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleAsyncCycle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

describe('periodic reconciler single-flight', () => {
  beforeEach(() => {
    stopPeriodicReconciliation();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.storage.getWalletsWithActiveBots.mockResolvedValue([]);
  });

  afterEach(() => {
    stopPeriodicReconciliation();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips an overlapping tick and allows a later tick after successful completion', async () => {
    const firstCycle = deferred<string[]>();
    mocks.storage.getWalletsWithActiveBots
      .mockImplementationOnce(() => firstCycle.promise)
      .mockResolvedValue([]);

    startPeriodicReconciliation();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[Reconcile] Skipping tick - previous cycle still running',
    );

    firstCycle.resolve([]);
    await settleAsyncCycle();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(2);
  });

  it('releases the lease in finally after a cycle failure', async () => {
    const failedCycle = deferred<string[]>();
    mocks.storage.getWalletsWithActiveBots
      .mockImplementationOnce(() => failedCycle.promise)
      .mockResolvedValue([]);

    startPeriodicReconciliation();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(1);

    failedCycle.reject(new Error('controlled cycle failure'));
    await settleAsyncCycle();
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      '[Reconcile] Periodic reconciliation error:',
      expect.any(Error),
    );
  });

  it('does not falsely release an active lease when the interval is stopped and restarted', async () => {
    const firstCycle = deferred<string[]>();
    mocks.storage.getWalletsWithActiveBots
      .mockImplementationOnce(() => firstCycle.promise)
      .mockResolvedValue([]);

    startPeriodicReconciliation();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(1);

    stopPeriodicReconciliation();
    startPeriodicReconciliation();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(1);

    firstCycle.resolve([]);
    await settleAsyncCycle();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(mocks.storage.getWalletsWithActiveBots).toHaveBeenCalledTimes(2);
  });
});
