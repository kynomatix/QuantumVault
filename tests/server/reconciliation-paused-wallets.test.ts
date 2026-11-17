import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cycleDone: vi.fn(),
  storage: {
    getWalletsWithActiveBots: vi.fn(), getWalletsForReconciliation: vi.fn(),
    getWallet: vi.fn(), getTradingBots: vi.fn(), getTradingBotById: vi.fn(),
    getBotPosition: vi.fn(), upsertBotPosition: vi.fn(), getBotTrades: vi.fn(),
    updateTradingBot: vi.fn(), updateBotTrade: vi.fn(), recordCloseEventAtomic: vi.fn(),
    getRecentCanonicalCloseForBot: vi.fn(), getSubscriberCloseAccountingCandidates: vi.fn(),
    updatePendingBotTrade: vi.fn(), remediateSubscriberCloseAccountingAtomic: vi.fn(),
  },
  adapter: {
    protocolName: 'pacifica', getCloseConfirmationSnapshot: vi.fn(),
    getPositions: vi.fn(), getTradeHistory: vi.fn(), getAccountInfo: vi.fn(),
    placeMarketOrder: vi.fn(), closePosition: vi.fn(), cancelOrder: vi.fn(),
  },
}));
vi.mock('../../server/job-timing', () => ({ startJobTiming: () => mocks.cycleDone }));
vi.mock('../../server/storage', () => ({ storage: mocks.storage,
  DatabaseStorage: { canonicalCloseFillId: () => 'EXAMPLE_CANONICAL_CLOSE' } }));
vi.mock('../../server/protocol/adapter-registry', () => ({
  getDefaultAdapter: () => mocks.adapter, getAdapterForBot: () => mocks.adapter,
}));
vi.mock('../../server/trading/close-intent-store', () => ({
  closeIntentStore: { hasUnresolvedPosition: vi.fn(async () => false) },
}));
vi.mock('../../server/notification-service', () => ({
  sendTradeNotification: vi.fn(), getCloseReasonLabel: vi.fn(), schedulePartialCloseNotification: vi.fn(),
}));
vi.mock('../../server/vault/auto-repark', () => ({ maybeScheduleAutoRepark: vi.fn(), cancelAutoRepark: vi.fn() }));

import { startPeriodicReconciliation, stopPeriodicReconciliation } from '../../server/reconciliation-service';

function bot(id: string, walletAddress: string, fields: Record<string, unknown> = {}) {
  return { id, walletAddress, market: 'BTC-PERP', activeProtocol: 'pacifica', isActive: false,
    protocolSubaccountId: `EXAMPLE_ACCOUNT_${id}`, subaccountAuthMode: 'external_key',
    subaccountStatus: 'active', riskConfig: { maxDailyLoss: 20 }, ...fields };
}
type Bot = ReturnType<typeof bot> & Record<string, unknown>;
let bots: Bot[];
let positions: Map<string, { baseSize: string; avgEntryPrice: string; lastTradeId: string }>;
function add(row: Bot, size: string) {
  bots.push(row);
  positions.set(row.id, { baseSize: size, avgEntryPrice: '100', lastTradeId: 'EXAMPLE_ENTRY' });
}
async function tick() {
  const completed = mocks.cycleDone.mock.calls.length;
  startPeriodicReconciliation();
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(mocks.cycleDone).toHaveBeenCalledTimes(completed + 1));
  stopPeriodicReconciliation();
}
function noWritesOrOrders() {
  for (const method of ['upsertBotPosition', 'recordCloseEventAtomic', 'updateBotTrade', 'updateTradingBot',
    'updatePendingBotTrade', 'remediateSubscriberCloseAccountingAtomic'] as const)
    expect(mocks.storage[method]).not.toHaveBeenCalled();
  for (const method of ['placeMarketOrder', 'closePosition', 'cancelOrder'] as const)
    expect(mocks.adapter[method]).not.toHaveBeenCalled();
}

describe('SB07 periodic wallet admission', () => {
  beforeEach(() => {
    stopPeriodicReconciliation();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bots = []; positions = new Map();
    mocks.storage.getWalletsWithActiveBots.mockImplementation(async () =>
      [...new Set(bots.filter(b => b.isActive).map(b => b.walletAddress))]);
    // SQL semantics are independently exercised against real PostgreSQL in the storage suite.
    mocks.storage.getWalletsForReconciliation.mockImplementation(async () => [...new Set(bots.filter(b =>
      b.isActive || (b.activeProtocol !== 'flash' && Math.abs(Number(positions.get(b.id)?.baseSize)) > 0.0001),
    ).map(b => b.walletAddress))]);
    mocks.storage.getWallet.mockImplementation(async address => ({ address, agentPublicKey: 'EXAMPLE_MAIN' }));
    mocks.storage.getTradingBots.mockImplementation(async address => bots.filter(b => b.walletAddress === address));
    mocks.storage.getTradingBotById.mockImplementation(async id => bots.find(b => b.id === id));
    mocks.storage.getBotPosition.mockImplementation(async id => positions.get(id));
    mocks.storage.upsertBotPosition.mockImplementation(async row => row);
    mocks.storage.getBotTrades.mockResolvedValue([]);
    let sequence = 0;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async (account: string) => {
      const row = bots.find(b => b.protocolSubaccountId === account);
      // The main agent wallet is flat; it cannot stand in for the protocol account.
      const size = row ? Number(positions.get(row.id)?.baseSize ?? 0) * 1.25 : 0;
      const now = Date.now();
      return { positions: size ? [{ internalSymbol: row!.market, baseSize: size,
        entryPrice: 101, markPrice: 102, unrealizedPnl: 1 }] : [],
      evidence: { account, environment: 'EXAMPLE', requestId: `EXAMPLE_${++sequence}`,
        startedAt: now, dispatchedAt: now, receivedAt: now, lastOrderId: sequence,
        fresh: true, complete: true, noDedup: true } };
    });
  });
  afterEach(() => {
    stopPeriodicReconciliation(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  it.each(['1', '-1'])('refreshes paused-only stored size %s through the periodic loop', async size => {
    add(bot('EXAMPLE_HELD', 'EXAMPLE_WALLET'), size);
    await tick();
    expect(mocks.adapter.getCloseConfirmationSnapshot, 'not reconciled').toHaveBeenCalledTimes(1);
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledWith('EXAMPLE_ACCOUNT_EXAMPLE_HELD', undefined);
    expect(mocks.storage.upsertBotPosition).toHaveBeenCalledWith(expect.objectContaining({
      tradingBotId: 'EXAMPLE_HELD', baseSize: String(Number(size) * 1.25), avgEntryPrice: '101',
    }));
    expect(mocks.storage.getWalletsWithActiveBots).not.toHaveBeenCalled();
    expect(mocks.storage.updateTradingBot).not.toHaveBeenCalled();
    expect(mocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
    expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
  });

  it('visits a mixed wallet once and reads each eligible bot once', async () => {
    add(bot('EXAMPLE_ACTIVE', 'EXAMPLE_MIXED', { isActive: true }), '0');
    add(bot('EXAMPLE_PAUSED', 'EXAMPLE_MIXED'), '1');
    await tick();
    expect(mocks.storage.getWallet.mock.calls.filter(([address]) => address === 'EXAMPLE_MIXED')).toHaveLength(1);
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(2);
    for (const row of bots)
      expect(mocks.adapter.getCloseConfirmationSnapshot.mock.calls.filter(([account]) => account === row.protocolSubaccountId)).toHaveLength(1);
  });

  it('N paused-flat wallets add zero venue reads across cycles', async () => {
    for (let i = 0; i < 50; i++) add(bot(`EXAMPLE_FLAT_${i}`, `EXAMPLE_WALLET_${i}`), '0');
    add(bot('EXAMPLE_HELD', 'EXAMPLE_HELD_WALLET'), '1');
    await tick(); await tick();
    expect(mocks.storage.getWallet).toHaveBeenCalledTimes(2);
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.storage.getBotPosition.mock.calls.every(([id]) => id === 'EXAMPLE_HELD')).toBe(true);
  });

  function onlyOwnAccount(account: string) {
    expect(mocks.adapter.getCloseConfirmationSnapshot, 'missing protocol account read').toHaveBeenCalled();
    for (const method of ['getCloseConfirmationSnapshot', 'getPositions', 'getTradeHistory', 'getAccountInfo'] as const)
      for (const [readAccount] of mocks.adapter[method].mock.calls) expect(readAccount).toBe(account);
  }

  it.each(['pending', 'error'])('R2 account long paused %s reads own account with main flat', async subaccountStatus => {
    const row = bot('EXAMPLE_UNVERIFIED', 'EXAMPLE_WALLET', { subaccountStatus });
    add(row, '1');
    await tick();
    onlyOwnAccount(row.protocolSubaccountId);
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.storage.upsertBotPosition).toHaveBeenCalledWith(expect.objectContaining({
      tradingBotId: row.id, baseSize: '1.25', avgEntryPrice: '101',
    }));
    expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(mocks.storage.updateTradingBot).not.toHaveBeenCalled();
    expect(mocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it.each(['pending', 'error'])('R2 account flat control %s retires through strict snapshots', async subaccountStatus => {
    const row = bot('EXAMPLE_CLOSED', 'EXAMPLE_WALLET', { subaccountStatus });
    add(row, '1');
    const snapshot = mocks.adapter.getCloseConfirmationSnapshot.getMockImplementation()!;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => ({ ...(await snapshot(account)), positions: [] }));
    mocks.adapter.getTradeHistory.mockResolvedValue([{ internalSymbol: row.market, tradeId: 'EXAMPLE_CLOSE_FILL',
      orderId: 'EXAMPLE_CLOSE_ORDER', venueEventKind: 'close_long', side: 'short', size: 1, price: 110, fee: 1, timestamp: Date.now() }]);
    mocks.storage.getRecentCanonicalCloseForBot.mockResolvedValue(undefined);
    mocks.storage.recordCloseEventAtomic.mockImplementation(async event => {
      // Model the existing storage transaction's confirmed-close effect.
      if (event.confirmedPositionClose) positions.set(row.id, { ...positions.get(row.id)!, baseSize: '0' });
      return { isNew: false };
    });
    await tick();
    onlyOwnAccount(row.protocolSubaccountId);
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.storage.recordCloseEventAtomic).toHaveBeenCalledWith(expect.objectContaining({
      botId: row.id, confirmedPositionClose: expect.objectContaining({ walletAddress: row.walletAddress, market: row.market }),
    }));
    expect(positions.get(row.id)?.baseSize).toBe('0');
    expect(mocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it.each(['pending', 'error'])('R2 never funded %s keeps position and makes no writes', async subaccountStatus => {
    const row = bot('EXAMPLE_NEVER_FUNDED', 'EXAMPLE_WALLET', { subaccountStatus });
    add(row, '1');
    const before = JSON.stringify({ bots, positions: [...positions] });
    const snapshot = mocks.adapter.getCloseConfirmationSnapshot.getMockImplementation()!;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => {
      const result = await snapshot(account);
      return { ...result, positions: [], evidence: { ...result.evidence, lastOrderId: null } };
    });
    await tick();
    onlyOwnAccount(row.protocolSubaccountId);
    expect(mocks.adapter.getTradeHistory).not.toHaveBeenCalled();
    expect(JSON.stringify({ bots, positions: [...positions] })).toBe(before);
    noWritesOrOrders();
  });

  it.each(['pending', 'error'])('R2 failed read %s keeps position and makes no writes', async subaccountStatus => {
    const row = bot('EXAMPLE_FAILED_READ', 'EXAMPLE_WALLET', { subaccountStatus });
    add(row, '1');
    const before = JSON.stringify({ bots, positions: [...positions] });
    mocks.adapter.getCloseConfirmationSnapshot.mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    await tick();
    onlyOwnAccount(row.protocolSubaccountId);
    expect(mocks.adapter.getTradeHistory).not.toHaveBeenCalled();
    expect(JSON.stringify({ bots, positions: [...positions] })).toBe(before);
    noWritesOrOrders();
  });

  it.each(['pending', 'error'])('R2 account long active %s reads own account with main flat', async subaccountStatus => {
    const row = bot('EXAMPLE_ACTIVE_ERROR', 'EXAMPLE_WALLET', { isActive: true, subaccountStatus });
    add(row, '1');
    await tick();
    onlyOwnAccount(row.protocolSubaccountId);
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.storage.upsertBotPosition).toHaveBeenCalledWith(expect.objectContaining({ tradingBotId: row.id, baseSize: '1.25' }));
    expect(mocks.storage.recordCloseEventAtomic).not.toHaveBeenCalled();
    expect(mocks.storage.updateTradingBot).not.toHaveBeenCalled();
    expect(mocks.adapter.placeMarketOrder).not.toHaveBeenCalled();
  });

  it.each(['active', 'pending', 'error'])('R2 non external key %s retains base Pacifica guard', async subaccountStatus => {
    add(bot('EXAMPLE_OTHER_AUTH', 'EXAMPLE_WALLET', { subaccountStatus, subaccountAuthMode: null }), '1');
    await tick();
    expect(mocks.storage.getTradingBotById).toHaveBeenCalledWith('EXAMPLE_OTHER_AUTH');
    for (const method of ['getCloseConfirmationSnapshot', 'getPositions', 'getTradeHistory', 'getAccountInfo'] as const)
      expect(mocks.adapter[method]).not.toHaveBeenCalled();
    expect(positions.get('EXAMPLE_OTHER_AUTH')?.baseSize).toBe('1');
    noWritesOrOrders();
  });

  it.each(['pending', 'error'])('R2 missing own account %s never falls back to main', async subaccountStatus => {
    add(bot('EXAMPLE_MISSING_ACCOUNT', 'EXAMPLE_WALLET', { subaccountStatus, protocolSubaccountId: null }), '1');
    await tick();
    expect(mocks.adapter.getCloseConfirmationSnapshot).not.toHaveBeenCalled();
    expect(mocks.adapter.getPositions).not.toHaveBeenCalled();
    expect(positions.get('EXAMPLE_MISSING_ACCOUNT')?.baseSize).toBe('1');
    noWritesOrOrders();
  });

  it.each(['pending', 'error'])('R2 non active subscriber evidence recovery %s uses own account', async subaccountStatus => {
    const row = bot('EXAMPLE_RECOVERY', 'EXAMPLE_WALLET', { subaccountStatus, sourcePublishedBotId: 'EXAMPLE_LISTING' });
    add(row, '1');
    mocks.storage.getSubscriberCloseAccountingCandidates.mockResolvedValue([]);
    await tick();
    expect(mocks.storage.getSubscriberCloseAccountingCandidates).toHaveBeenCalledWith(row.id);
    onlyOwnAccount(row.protocolSubaccountId);
    expect(mocks.storage.updatePendingBotTrade).not.toHaveBeenCalled();
    expect(mocks.storage.remediateSubscriberCloseAccountingAtomic).not.toHaveBeenCalled();
  });

  it('preserves the stored position on venue read failure and dispatches nothing', async () => {
    add(bot('EXAMPLE_HELD', 'EXAMPLE_WALLET'), '1');
    mocks.adapter.getCloseConfirmationSnapshot.mockRejectedValue(new Error('EXAMPLE_UNAVAILABLE'));
    await tick();
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(1);
    expect(positions.get('EXAMPLE_HELD')?.baseSize).toBe('1');
    noWritesOrOrders();
  });

  it('re-reads no-order-history discrepancies each cycle without retiring stored exposure', async () => {
    add(bot('EXAMPLE_NO_HISTORY', 'EXAMPLE_WALLET'), '1');
    const snapshot = mocks.adapter.getCloseConfirmationSnapshot.getMockImplementation()!;
    mocks.adapter.getCloseConfirmationSnapshot.mockImplementation(async account => {
      const result = await snapshot(account);
      return { ...result, positions: [], evidence: { ...result.evidence, lastOrderId: null } };
    });
    await tick(); await tick();
    expect(mocks.adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(2);
    expect(positions.get('EXAMPLE_NO_HISTORY')?.baseSize).toBe('1');
    noWritesOrOrders();
  });

  it.each([false, true])('keeps Phoenix executionActive=%s and performs no adapter orders', async executionActive => {
    add(bot('EXAMPLE_PHOENIX', 'EXAMPLE_WALLET', { activeProtocol: 'phoenix', executionActive }), '1');
    await tick();
    expect(mocks.storage.getTradingBotById).toHaveBeenCalledWith('EXAMPLE_PHOENIX');
    expect(bots[0].executionActive).toBe(executionActive);
    expect(mocks.adapter.getCloseConfirmationSnapshot).not.toHaveBeenCalled();
    noWritesOrOrders();
  });
});
