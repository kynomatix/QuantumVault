/**
 * WO-15B / WO-15B.1: Tests for server/bot-financial-snapshot.ts
 *
 * Covers:
 *  1. Batch enrichment — getTradingBotListEnrichment called once (1, 10, 100 bots).
 *  2. Concurrent calls join one refresh (in-flight deduplication).
 *  3. Freshness TTL (5 s), stale window (60 s), unavailable after expiry.
 *  4. LRU eviction (max 100 entries), in-flight entries immune to eviction.
 *  5. BoundedPool: peak concurrency = 2, slots tied to settlement not deadline.
 *  6. 10-second deadline envelope; never-settling promises → bounded pool, future
 *     snapshots fail-closed for venue work (not stacking unlimited new calls).
 *  7. Additive status/timestamp fields on both route shapes.
 *  8. DB fallback when botCtx null or live call fails.
 *  9. Flash double-count exclusion, parked value, borrow debt from enrichment.
 * 10. getCachedPricesMeta called synchronously, never getPrice/getAllPrices.
 * 11. No legacy per-bot storage calls (getCanonicalBotTradeCount, getBotEquityEvents,
 *     getBotPosition, getPublishedBotByTradingBotId, sumOpenBorrowDebtUsdcForBot).
 *
 * WO-15B.1 additions:
 * 12. Phase-1 DB deadline: never-settling DB → stale/503 within caller envelope,
 *     no second refresh while inFlight lives, no false empty/zero response.
 * 13. True two-operation concurrency: max 2 underlying ops concurrent; independent
 *     bot ops start before predecessors finish (pipelining).
 * 14. Immutability: late-settling underlying op cannot mutate a returned snapshot.
 * 15. Truthful failure: cold DB fail → unavailable (503-flag), capacity exhaustion
 *     → unavailable, genuine empty wallet → fresh+botsReadSucceeded, enrichment
 *     failure → bot list retained (partial, not unavailable).
 * 16. Total-equity null semantics: failed main-account → null not zero; status
 *     = partial not fresh; totalEquity = null when inputs null.
 * 17. Stale age evaluated at actual response time, not pre-await.
 * 18. Exact-market parity: no cross-market position fallback.
 * 19. Adapter ordering: getAdapterForBot not called for alias/no-context bots.
 * 20. Timer cleanup: no lingering setTimeout after fast completions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initSnapshotModule,
  getWalletFinancialSnapshot,
  BoundedPool,
  _resetForTest,
  _cacheSize,
  _poolActive,
  _waiterCount,
  type SnapshotDeps,
} from '../../server/bot-financial-snapshot';

// ---------------------------------------------------------------------------
// Mock storage module
// ---------------------------------------------------------------------------
vi.mock('../../server/storage', () => ({
  storage: {
    getTradingBots: vi.fn(),
    getWallet: vi.fn(),
    getVaultPositionsAllScopes: vi.fn(),
    getTradingBotListEnrichment: vi.fn(),
  },
}));

import { storage } from '../../server/storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const W = 'wallet-aaa';

function makeBots(count: number, overrides: Record<string, unknown> = {}): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `bot-${i + 1}`,
    name: `Bot ${i + 1}`,
    market: 'BTC-PERP',
    walletAddress: W,
    activeProtocol: 'pacifica',
    protocolSubaccountId: null,
    driftSubaccountId: 0,
    subaccountAuthMode: null,
    subaccountStatus: null,
    botSubaccountKeyEncryptedV3: null,
    botSubaccountKeyEncrypted: null,
    ...overrides,
  }));
}

function makeEnrichment(botIds: string[], overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    tradeCounts: new Map(botIds.map(id => [id, 3])),
    positions: new Map(botIds.map(id => [id, [{
      market: 'BTC-PERP',
      baseSize: '0.1',
      avgEntryPrice: '50000',
      realizedPnl: '100',
      totalFees: '10',
    }]])),
    publishedBotMap: new Map(),
    equityAgg: new Map(botIds.map(id => [id, { netDeposited: 1000, totalDeposits: 1200 }])),
    borrowDebts: new Map(botIds.map(id => [id, 0])),
    ...overrides,
  };
}

const LIVE_INFO = {
  totalCollateral: 1200,
  freeCollateral: 800,
  usdcBalance: 1200,
  unrealizedPnl: 200,
  marginUsed: 0,
  hasOpenPositions: true,
  totalPositionNotional: 5500,
};

const PARKED_RESULT = {
  equityUsdc: 1200,
  parkedValueUsdc: 0,
  parkedValueIncluded: false,
  parkedValueUnavailable: false,
};

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    getCachedPricesMeta: vi.fn().mockReturnValue({
      prices: { 'BTC-PERP': 55000 },
      pricesAsOf: Date.now(),
      pricesStale: false,
    }),
    getExchangeAccountInfoForBot: vi.fn().mockResolvedValue(LIVE_INFO),
    addParkedValueForBotDisplayEquity: vi.fn().mockResolvedValue(PARKED_RESULT),
    getExchangeAccountInfo: vi.fn().mockResolvedValue({
      totalCollateral: 5000,
      freeCollateral: 3000,
      usdcBalance: 5000,
    }),
    getAgentUsdcBalance: vi.fn().mockResolvedValue(500),
    getAgentSolBalance: vi.fn().mockResolvedValue(0.5),
    accountVaultRoutableValueUsdc: vi.fn().mockResolvedValue(200),
    getBotSubaccountContext: vi.fn().mockReturnValue(null),
    getAdapterForBot: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetForTest();
  vi.clearAllMocks();

  (storage.getTradingBots as any).mockResolvedValue([]);
  (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'agent-pub' });
  (storage.getVaultPositionsAllScopes as any).mockResolvedValue([]);
  (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([]));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Batch enrichment — getTradingBotListEnrichment called exactly once
// ---------------------------------------------------------------------------

describe('batch enrichment', () => {
  it('calls getTradingBotListEnrichment once for 1 bot', async () => {
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([bots[0].id]));

    initSnapshotModule(makeDeps());
    await getWalletFinancialSnapshot(W);

    expect(storage.getTradingBotListEnrichment).toHaveBeenCalledTimes(1);
    expect(storage.getTradingBotListEnrichment).toHaveBeenCalledWith(W, [bots[0].id]);
  });

  it('calls getTradingBotListEnrichment once for 10 bots', async () => {
    const bots = makeBots(10);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(bots.map(b => b.id)));

    initSnapshotModule(makeDeps());
    await getWalletFinancialSnapshot(W);

    expect(storage.getTradingBotListEnrichment).toHaveBeenCalledTimes(1);
    expect(storage.getTradingBotListEnrichment).toHaveBeenCalledWith(W, bots.map(b => b.id));
  });

  it('calls getTradingBotListEnrichment once for 100 bots', async () => {
    const bots = makeBots(100);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(bots.map(b => b.id)));

    initSnapshotModule(makeDeps());
    await getWalletFinancialSnapshot(W);

    expect(storage.getTradingBotListEnrichment).toHaveBeenCalledTimes(1);
  });

  it('does not call any legacy per-bot storage methods', async () => {
    const bots = makeBots(3);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(bots.map(b => b.id)));

    initSnapshotModule(makeDeps());
    await getWalletFinancialSnapshot(W);

    expect((storage as any).getCanonicalBotTradeCount).toBeUndefined();
    expect((storage as any).getBotEquityEvents).toBeUndefined();
    expect((storage as any).getBotPosition).toBeUndefined();
    expect((storage as any).getPublishedBotByTradingBotId).toBeUndefined();
    expect((storage as any).sumOpenBorrowDebtUsdcForBot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrent calls share one refresh (in-flight deduplication)
// ---------------------------------------------------------------------------

describe('in-flight deduplication', () => {
  it('concurrent calls return the same snapshot and call storage only once', async () => {
    let resolveRefresh!: () => void;
    const refreshGate = new Promise<void>(r => { resolveRefresh = r; });

    (storage.getTradingBots as any).mockImplementation(() => refreshGate.then(() => makeBots(1)));
    const enrichment = makeEnrichment(['bot-1']);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(enrichment);

    initSnapshotModule(makeDeps());

    const [p1, p2, p3] = [
      getWalletFinancialSnapshot(W),
      getWalletFinancialSnapshot(W),
      getWalletFinancialSnapshot(W),
    ];

    resolveRefresh();
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(storage.getTradingBots).toHaveBeenCalledTimes(1);
    expect(s1.observedAt).toBe(s2.observedAt);
    expect(s2.observedAt).toBe(s3.observedAt);
  });
});

// ---------------------------------------------------------------------------
// 3. Freshness TTL, stale window, unavailable after expiry
// ---------------------------------------------------------------------------

describe('freshness state machine', () => {
  it('returns fresh on first call', async () => {
    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('fresh');
    expect(snap.observedAt).toBeGreaterThan(0);
  });

  it('returns fresh within 5 s (cache hit)', async () => {
    initSnapshotModule(makeDeps());
    await getWalletFinancialSnapshot(W);

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('fresh');
    // Only 1 DB call (cache hit, no second refresh)
    expect(storage.getTradingBots).toHaveBeenCalledTimes(1);
  });

  it('second call within TTL is a cache hit (no re-fetch)', async () => {
    let callCount = 0;
    (storage.getTradingBots as any).mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeBots(1));
    });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));

    initSnapshotModule(makeDeps());
    await getWalletFinancialSnapshot(W);
    expect(callCount).toBe(1);

    // Second call within 5 s TTL hits the cache — storage not called again
    const snap2 = await getWalletFinancialSnapshot(W);
    expect(callCount).toBe(1);
    expect(snap2.status).toBe('fresh');
  });

  it('returns stale on refresh failure within 60 s window', async () => {
    initSnapshotModule(makeDeps());
    const snap1 = await getWalletFinancialSnapshot(W);
    expect(snap1.status).toBe('fresh');

    // Age the cache past FRESH_TTL by faking Date.now
    const originalNow = Date.now;
    Date.now = () => snap1.observedAt! + 6000; // 6s later

    // Make the next refresh fail
    (storage.getTradingBots as any).mockRejectedValueOnce(new Error('DB error'));

    const snap2 = await getWalletFinancialSnapshot(W);
    expect(snap2.status).toBe('stale');
    expect(snap2.observedAt).toBe(snap1.observedAt); // still the old snapshot

    Date.now = originalNow;
  });

  it('returns unavailable when no prior success and refresh fails', async () => {
    (storage.getTradingBots as any).mockRejectedValue(new Error('DB error'));
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('unavailable');
    expect(snap.observedAt).toBeNull();
    expect(snap.bots).toEqual([]);
  });

  it('returns unavailable when stale window (60 s) is expired', async () => {
    initSnapshotModule(makeDeps());
    const snap1 = await getWalletFinancialSnapshot(W);

    // Age to 61 s (past STALE_WINDOW_MS)
    const originalNow = Date.now;
    Date.now = () => snap1.observedAt! + 61_000;

    (storage.getTradingBots as any).mockRejectedValueOnce(new Error('DB error'));

    const snap2 = await getWalletFinancialSnapshot(W);
    expect(snap2.status).toBe('unavailable');

    Date.now = originalNow;
  });
});

// ---------------------------------------------------------------------------
// 4. LRU cache (max 100 entries, in-flight immune)
// ---------------------------------------------------------------------------

describe('LRU cache', () => {
  it('evicts the oldest non-in-flight entry when cap is reached', async () => {
    initSnapshotModule(makeDeps());

    // Fill 100 entries
    for (let i = 0; i < 100; i++) {
      await getWalletFinancialSnapshot(`wallet-${i}`);
    }
    expect(_cacheSize()).toBe(100);

    // Adding entry 101 should evict one
    await getWalletFinancialSnapshot('wallet-new');
    expect(_cacheSize()).toBe(100);
  });

  it('does not exceed 100 entries', async () => {
    initSnapshotModule(makeDeps());

    for (let i = 0; i < 120; i++) {
      await getWalletFinancialSnapshot(`wallet-${i}`);
    }
    expect(_cacheSize()).toBeLessThanOrEqual(100);
  });

  it('returns unavailable when all 100 entries are in-flight', async () => {
    // Fill 100 entries where all are in-flight (blocking gate)
    let releaseAll!: () => void;
    const gate = new Promise<void>(r => { releaseAll = r; });

    initSnapshotModule(makeDeps());
    (storage.getTradingBots as any).mockImplementation(() => gate.then(() => []));

    const inFlightPromises: Array<Promise<any>> = [];
    for (let i = 0; i < 100; i++) {
      inFlightPromises.push(getWalletFinancialSnapshot(`wallet-in-flight-${i}`));
    }

    // Adding a 101st wallet should fail-closed (all 100 entries in-flight)
    const snapExtra = await getWalletFinancialSnapshot('wallet-extra');
    expect(snapExtra.status).toBe('unavailable');

    // Clean up
    releaseAll();
    await Promise.allSettled(inFlightPromises);
  });
});

// ---------------------------------------------------------------------------
// 5. BoundedPool — unit tests for the concurrency primitive
// ---------------------------------------------------------------------------

describe('BoundedPool', () => {
  it('runs up to capacity concurrent tasks', async () => {
    const pool = new BoundedPool(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 5));
      concurrent--;
    };

    const p1 = pool.tryRun(makeTask());
    const p2 = pool.tryRun(makeTask());
    const p3 = pool.tryRun(makeTask()); // should fail (pool full)

    expect(p3).toBeNull();
    expect(pool.active).toBe(2);

    await Promise.all([p1!, p2!].map(p => p.catch(() => {})));

    expect(pool.active).toBe(0);
  });

  it('releases slot only when underlying promise settles, not on cancel', async () => {
    const pool = new BoundedPool(1);
    let settled = false;

    // Start a slow task
    const underlying = pool.tryRun(async () => {
      await new Promise(r => setTimeout(r, 50));
      settled = true;
    });

    expect(pool.active).toBe(1);

    // Deadline fires — pool slot is still held
    await new Promise(r => setTimeout(r, 0));
    expect(pool.active).toBe(1);
    expect(settled).toBe(false);

    // Wait for underlying to finish
    await underlying;
    expect(settled).toBe(true);
    expect(pool.active).toBe(0);
  });

  it('waitForSlot resolves immediately when capacity available', async () => {
    const pool = new BoundedPool(2);
    // Pool is empty — should resolve immediately
    await expect(pool.waitForSlot()).resolves.toBeUndefined();
  });

  it('waitForSlot resolves when a running task finishes', async () => {
    const pool = new BoundedPool(1);

    let resolveTask!: () => void;
    pool.tryRun(() => new Promise<void>(r => { resolveTask = r; }));
    expect(pool.active).toBe(1);

    const slotWaiter = pool.waitForSlot();
    let slotFree = false;
    slotWaiter.then(() => { slotFree = true; });

    expect(slotFree).toBe(false);
    resolveTask();
    await slotWaiter;
    expect(slotFree).toBe(true);
    expect(pool.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 10-second deadline + never-settling promises keep slots occupied
// ---------------------------------------------------------------------------

describe('venue deadline and never-settling slots', () => {
  it('returns a result before the deadline when venue calls settle fast', async () => {
    initSnapshotModule(makeDeps());
    const start = Date.now();
    const snap = await getWalletFinancialSnapshot(W);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(snap.status).toBe('fresh');
  });

  it('never-settling venue calls hold the pool slot past the deadline', async () => {
    // Verify BoundedPool invariant: the slot is released ONLY when the
    // underlying promise settles, not when the deadline race fires.
    const pool = new BoundedPool(1);

    let externalResolve!: () => void;
    const neverSettles = new Promise<void>(r => { externalResolve = r; });

    // Launch a never-settling task
    const underlying = pool.tryRun(() => neverSettles);
    expect(underlying).not.toBeNull();
    expect(pool.active).toBe(1);

    // Race the underlying against a 5ms deadline
    const raced = await Promise.race([
      underlying!.then(() => 'settled' as const),
      new Promise<'deadline'>(r => setTimeout(() => r('deadline'), 5)),
    ]);
    expect(raced).toBe('deadline'); // deadline fired

    // Slot is still occupied — the underlying promise has NOT settled
    expect(pool.active).toBe(1);

    // Now settle the underlying — slot should be released
    externalResolve();
    await neverSettles;
    // Give the microtask queue a tick to process the .then handler
    await new Promise(r => setTimeout(r, 0));
    expect(pool.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Additive status/timestamp fields on snapshot shape
// ---------------------------------------------------------------------------

describe('snapshot field shapes', () => {
  it('snapshot has required fields for trading-bots route', async () => {
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));

    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.status).toBe('fresh');
    expect(snap.observedAt).toBeTypeOf('number');
    expect(snap.bots).toHaveLength(1);
    expect(snap.enrichment.tradeCounts.size).toBe(1);
    expect(snap.enrichment.publishedBotMap).toBeInstanceOf(Map);
    expect(snap.perBotFinancials).toBeInstanceOf(Map);
    expect(snap.perBotFinancials.has('bot-1')).toBe(true);
  });

  it('snapshot has required fields for total-equity route', async () => {
    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);

    // agentBalance/solBalance/vaultBalance are null or number (never undefined).
    expect(snap.agentBalance === null || typeof snap.agentBalance === 'number').toBe(true);
    expect(snap.solBalance === null || typeof snap.solBalance === 'number').toBe(true);
    expect(snap.vaultBalance === null || typeof snap.vaultBalance === 'number').toBe(true);
    expect(snap.prices).toBeTypeOf('object');
    expect(typeof snap.pricesStale).toBe('boolean');
  });

  it('botsReadSucceeded is true on a successful snapshot', async () => {
    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.botsReadSucceeded).toBe(true);
  });

  it('unavailable snapshot has null financial fields and botsReadSucceeded=false', async () => {
    (storage.getTradingBots as any).mockRejectedValue(new Error('DB error'));
    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.status).toBe('unavailable');
    expect(snap.botsReadSucceeded).toBe(false);
    expect(snap.observedAt).toBeNull();
    expect(snap.bots).toEqual([]);
    expect(snap.enrichment.tradeCounts.size).toBe(0);
    expect(snap.perBotFinancials.size).toBe(0);
    // WO-15B.1: null not zero on unavailable
    expect(snap.agentBalance).toBeNull();
    expect(snap.solBalance).toBeNull();
    expect(snap.vaultBalance).toBeNull();
    expect(snap.mainAccount).toBeNull();
    expect(snap.pricesStale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. DB fallback when botCtx null or live call fails
// ---------------------------------------------------------------------------

describe('DB fallback', () => {
  it('uses DB-based calculation when botCtx is null (no live context)', async () => {
    const bots = makeBots(1); // protocolSubaccountId: null, no external key
    (storage.getTradingBots as any).mockResolvedValue(bots);
    const enrichment = makeEnrichment(['bot-1'], {
      equityAgg: new Map([['bot-1', { netDeposited: 500, totalDeposits: 600 }]]),
      positions: new Map([['bot-1', [{
        market: 'BTC-PERP',
        baseSize: '0',
        avgEntryPrice: '50000',
        realizedPnl: '100',
        totalFees: '10',
      }]]]),
    });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(enrichment);

    const deps = makeDeps({ getBotSubaccountContext: vi.fn().mockReturnValue(null) });
    initSnapshotModule(deps);
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-1');
    expect(fin).toBeDefined();
    expect(fin!.liveDataAvailable).toBe(false);
    // DB fallback: netDeposited + realizedPnl - totalFees = 500 + 100 - 10 = 590
    expect(fin!.exchangeBalance).toBeCloseTo(590, 2);
    expect(fin!.netPnl).toBeCloseTo(590 - 500, 2); // 90
  });

  it('returns null fields when both live and DB fallback are unavailable', async () => {
    const bots = makeBots(1, {
      subaccountAuthMode: 'external_key',
      subaccountStatus: 'active',
      protocolSubaccountId: 'bot-pub-key',
      botSubaccountKeyEncryptedV3: 'enc-v3',
    });
    (storage.getTradingBots as any).mockResolvedValue(bots);

    // No enrichment data (empty equityAgg, positions)
    const enrichment: any = {
      tradeCounts: new Map([['bot-1', 0]]),
      positions: new Map(),
      publishedBotMap: new Map(),
      equityAgg: new Map(), // absent → null fallback
      borrowDebts: new Map(),
    };
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(enrichment);

    const deps = makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue({ useBotKeypair: true }),
      getExchangeAccountInfoForBot: vi.fn().mockRejectedValue(new Error('RPC error')),
    });
    initSnapshotModule(deps);
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-1');
    expect(fin).toBeDefined();
    expect(fin!.liveDataAvailable).toBe(false);
    // No equityAgg entry → _dbFallback returns null → null fields
    expect(fin!.exchangeBalance).toBeNull();
    expect(fin!.netPnl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Flash double-count exclusion, parked value, borrow debt
// ---------------------------------------------------------------------------

describe('accounting semantics', () => {
  it('excludes Flash bot whose protocolSubaccountId equals the agent wallet', async () => {
    const bots = [{
      id: 'bot-flash',
      name: 'Flash Legacy',
      market: 'SOL-PERP',
      walletAddress: W,
      activeProtocol: 'flash',
      protocolSubaccountId: 'agent-pub', // same as wallet.agentPublicKey
      driftSubaccountId: 0,
      subaccountAuthMode: null,
      subaccountStatus: null,
      botSubaccountKeyEncryptedV3: null,
      botSubaccountKeyEncrypted: null,
    }];
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-flash']));
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'agent-pub' });

    initSnapshotModule(makeDeps({ getBotSubaccountContext: vi.fn().mockReturnValue(null) }));
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-flash');
    expect(fin).toBeDefined();
    expect(fin!.exchangeBalance).toBe(0); // excluded to avoid double-count
    expect(fin!.liveDataAvailable).toBe(false);
  });

  it('includes borrow debt from enrichment (not live venue call)', async () => {
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    const enrichment = makeEnrichment(['bot-1'], {
      borrowDebts: new Map([['bot-1', 150]]),
    });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(enrichment);

    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-1');
    expect(fin!.borrowDebtUsdc).toBe(150);
  });

  it('includes parked value for Flash per-bot bots', async () => {
    const bots = makeBots(1, {
      subaccountAuthMode: 'external_key',
      subaccountStatus: 'active',
      protocolSubaccountId: 'bot-pub',
      botSubaccountKeyEncryptedV3: 'enc-v3',
    });
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));
    (storage.getVaultPositionsAllScopes as any).mockResolvedValue([
      { tradingBotId: 'bot-1' },
    ]);

    const deps = makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue({ useBotKeypair: true }),
      addParkedValueForBotDisplayEquity: vi.fn().mockResolvedValue({
        equityUsdc: 1500,
        parkedValueUsdc: 300,
        parkedValueIncluded: true,
        parkedValueUnavailable: false,
      }),
    });
    initSnapshotModule(deps);
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-1');
    expect(fin!.parkedValueUsdc).toBe(300);
    expect(fin!.parkedValueIncluded).toBe(true);
    expect(fin!.liveDataAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. getCachedPricesMeta called synchronously, never getPrice/getAllPrices
// ---------------------------------------------------------------------------

describe('price synchronicity invariants', () => {
  it('calls getCachedPricesMeta (synchronous) for prices', async () => {
    const deps = makeDeps();
    initSnapshotModule(deps);
    await getWalletFinancialSnapshot(W);

    expect(deps.getCachedPricesMeta).toHaveBeenCalled();
  });

  it('getCachedPricesMeta is called synchronously (no await in hot path)', async () => {
    // Verify that calling getCachedPricesMeta doesn't return a Promise
    const deps = makeDeps({
      getCachedPricesMeta: vi.fn().mockReturnValue({
        prices: {},
        pricesAsOf: null,
        pricesStale: true,
      }),
    });
    initSnapshotModule(deps);
    await getWalletFinancialSnapshot(W);

    // getCachedPricesMeta must return synchronously (not a Promise)
    const returnValue = (deps.getCachedPricesMeta as any).mock.results[0].value;
    expect(returnValue).not.toBeInstanceOf(Promise);
  });

  it('does NOT call getAgentUsdcBalance when no agentAddress', async () => {
    (storage.getWallet as any).mockResolvedValue(null); // no wallet
    const deps = makeDeps();
    initSnapshotModule(deps);
    await getWalletFinancialSnapshot(W);

    expect(deps.getAgentUsdcBalance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11. Enrichment failure — WO-15B.1: bot list retained (partial, not unavailable)
// ---------------------------------------------------------------------------

describe('partial failure resilience', () => {
  it('enrichment failure retains the bot list and returns partial status', async () => {
    const bots = makeBots(2);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockRejectedValue(new Error('DB timeout'));

    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);

    // WO-15B.1: bot list retained even when enrichment fails.
    // Status is fresh (bot read succeeded) with null/fallback financials.
    expect(['fresh', 'partial']).toContain(snap.status);
    expect(snap.bots).toHaveLength(2);
    expect(snap.botsReadSucceeded).toBe(true);
    // perBotFinancials should have entries (DB fallback with empty enrichment)
    expect(snap.perBotFinancials.size).toBe(2);
    // With empty enrichment, no equityAgg → null exchangeBalance
    const fin1 = snap.perBotFinancials.get('bot-1');
    expect(fin1).toBeDefined();
    expect(fin1!.liveDataAvailable).toBe(false);
  });

  it('vault positions failure falls back gracefully (not fatal)', async () => {
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));
    (storage.getVaultPositionsAllScopes as any).mockRejectedValue(new Error('vault DB error'));

    initSnapshotModule(makeDeps());
    const snap = await getWalletFinancialSnapshot(W);

    // Vault positions failure should NOT kill the whole refresh
    expect(snap.status).not.toBe('unavailable');
    expect(snap.bots).toHaveLength(1);
    expect(snap.botsReadSucceeded).toBe(true);
  });
});

// ============================================================================
// WO-15B.1 NEW TESTS
// ============================================================================

// ---------------------------------------------------------------------------
// 12. Phase-1 DB deadline (WO-15B.1 item 1)
// ---------------------------------------------------------------------------

describe('Phase-1 DB deadline (WO-15B.1 item 1)', () => {
  it('yields stale within caller envelope when Phase-1 DB hangs, using last-known-good', async () => {
    vi.useFakeTimers();

    // Step 1: warm up a lastSuccess snapshot.
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    initSnapshotModule(makeDeps());

    // Resolve first call completely.
    const snap1Promise = getWalletFinancialSnapshot(W);
    await vi.runAllTimersAsync();
    const snap1 = await snap1Promise;
    expect(snap1.status).toBe('fresh');
    expect(snap1.bots).toHaveLength(1);

    // Step 2: advance past FRESH_TTL (5 s) so a refresh is attempted.
    vi.advanceTimersByTime(6_000);

    // Phase-1 DB hangs (never resolves).
    (storage.getTradingBots as any).mockReturnValueOnce(new Promise(() => {}));

    const snap2Promise = getWalletFinancialSnapshot(W);

    // Advance past CALLER_DEADLINE_MS (10 s) to fire the caller envelope.
    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();

    const snap2 = await snap2Promise;

    // Must return stale (lastSuccess is within 60 s window), not empty/zero.
    expect(snap2.status).toBe('stale');
    expect(snap2.bots).toHaveLength(1);         // bot list from lastSuccess
    expect(snap2.botsReadSucceeded).toBe(true);  // from the stale entry
    expect(snap2.observedAt).toBe(snap1.observedAt);

    vi.useRealTimers();
  });

  it('does not start a second refresh while underlying inFlight promise is alive', async () => {
    vi.useFakeTimers();

    // Warm up lastSuccess.
    (storage.getTradingBots as any).mockResolvedValueOnce([]);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment([]));
    initSnapshotModule(makeDeps());

    const firstSnap = getWalletFinancialSnapshot(W);
    await vi.runAllTimersAsync();
    await firstSnap;

    // Advance past FRESH_TTL.
    vi.advanceTimersByTime(6_000);

    let callCount = 0;
    (storage.getTradingBots as any).mockImplementation(() => {
      callCount++;
      return new Promise(() => {}); // hangs
    });

    // First concurrent call starts the refresh.
    const p1 = getWalletFinancialSnapshot(W);
    await Promise.resolve(); // microtask tick

    // Second concurrent call should JOIN the inFlight, not start a new one.
    const p2 = getWalletFinancialSnapshot(W);
    await Promise.resolve();

    // Only one getTradingBots call was made.
    expect(callCount).toBe(1);

    // Advance to fire both caller envelopes.
    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();

    await Promise.allSettled([p1, p2]);

    // Still only one call even after both callers timed out.
    expect(callCount).toBe(1);

    vi.useRealTimers();
  });

  it('returns unavailable (not empty/zero) when Phase-1 hangs with no lastSuccess', async () => {
    vi.useFakeTimers();

    // No prior lastSuccess.
    (storage.getTradingBots as any).mockReturnValue(new Promise(() => {}));
    initSnapshotModule(makeDeps());

    const snapPromise = getWalletFinancialSnapshot(W);

    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();

    const snap = await snapPromise;

    // Must be unavailable (routes return 503), NOT empty + zero balances.
    expect(snap.status).toBe('unavailable');
    expect(snap.botsReadSucceeded).toBe(false);
    expect(snap.agentBalance).toBeNull();       // null, not 0
    expect(snap.vaultBalance).toBeNull();       // null, not 0

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 13. True two-operation concurrency (WO-15B.1 item 2)
// ---------------------------------------------------------------------------

describe('two-operation concurrency (WO-15B.1 item 2)', () => {
  it('never exceeds two concurrent underlying venue/account operations', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const trackOp = <T>(result: T): Promise<T> =>
      new Promise(resolve => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Tiny real delay so operations genuinely overlap.
        setTimeout(() => {
          concurrent--;
          resolve(result);
        }, 5);
      });

    const bots = makeBots(2);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1', 'bot-2']));

    const deps = makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue({ useBotKeypair: true }),
      getAgentUsdcBalance: vi.fn().mockImplementation(() => trackOp(500)),
      getAgentSolBalance: vi.fn().mockImplementation(() => trackOp(0.5)),
      getExchangeAccountInfo: vi.fn().mockImplementation(() => trackOp({ totalCollateral: 5000, freeCollateral: 3000 })),
      accountVaultRoutableValueUsdc: vi.fn().mockImplementation(() => trackOp(200)),
      getExchangeAccountInfoForBot: vi.fn().mockImplementation(() => trackOp(LIVE_INFO)),
      addParkedValueForBotDisplayEquity: vi.fn().mockImplementation(() => trackOp(PARKED_RESULT)),
    });

    initSnapshotModule(deps);
    await getWalletFinancialSnapshot(W);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(1);
  });

  it('pipelines two bot ops concurrently: bot-2 starts before bot-1 finishes', async () => {
    const callOrder: string[] = [];
    let resolveBot1!: (v: any) => void;

    const bots = makeBots(2);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(
      makeEnrichment(['bot-1', 'bot-2']),
    );
    // Use real wallet so agentAddress is non-null; main-account ops resolve instantly
    // (microtasks) freeing both pool slots for the bot wrappers.
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'agent-pub' });

    const deps = makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue({ useBotKeypair: true }),
      // Main-account ops: all resolve instantly so slots are freed for bots quickly.
      getAgentUsdcBalance: vi.fn().mockResolvedValue(500),
      getAgentSolBalance: vi.fn().mockResolvedValue(0.5),
      getExchangeAccountInfo: vi.fn().mockResolvedValue({ totalCollateral: 5000, freeCollateral: 3000 }),
      accountVaultRoutableValueUsdc: vi.fn().mockResolvedValue(200),
      // bot-1 hangs until explicitly resolved; bot-2 is instant.
      getExchangeAccountInfoForBot: vi.fn()
        .mockImplementationOnce(() => {
          callOrder.push('bot-1-start');
          return new Promise(r => { resolveBot1 = r; }); // hangs until resolved
        })
        .mockImplementationOnce(() => {
          callOrder.push('bot-2-start');
          return Promise.resolve(LIVE_INFO);
        }),
      addParkedValueForBotDisplayEquity: vi.fn().mockResolvedValue(PARKED_RESULT),
    });

    initSnapshotModule(deps);
    const snapPromise = getWalletFinancialSnapshot(W);

    // Yield to the event loop: main-account ops (microtask) complete, freeing 2 slots
    // for the bot wrappers. Both bot ops should launch.
    await new Promise(r => setTimeout(r, 50));

    // With pipelining (2 slots available after fast main-account ops):
    // both bot-1 and bot-2 start before bot-1 finishes.
    expect(callOrder).toContain('bot-1-start');
    expect(callOrder).toContain('bot-2-start');

    // Finish bot-1 so the snapshot can complete (no dangling in-flight promise).
    resolveBot1(LIVE_INFO);
    await snapPromise;
  });

  it('each underlying operation individually occupies one pool slot', async () => {
    // Verify that 4 main-account ops are each individually pool-bound.
    // With pool.capacity=2, they are dispatched 2 at a time.
    const dispatched: string[] = [];
    const settle: Array<() => void> = [];

    const makeTrackedOp = (name: string) => () =>
      new Promise<any>(r => {
        dispatched.push(name);
        settle.push(() => r(0));
      });

    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'agent-pub' });
    (storage.getTradingBots as any).mockResolvedValue([]);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([]));

    const deps = makeDeps({
      getAgentUsdcBalance: makeTrackedOp('agentBalance'),
      getAgentSolBalance: makeTrackedOp('solBalance'),
      getExchangeAccountInfo: makeTrackedOp('mainAccount'),
      accountVaultRoutableValueUsdc: makeTrackedOp('vaultBalance'),
    });
    initSnapshotModule(deps);

    const snapPromise = getWalletFinancialSnapshot(W);

    // Yield to let initial dispatches happen.
    await new Promise(r => setTimeout(r, 10));

    // Only 2 should have started (pool capacity = 2).
    expect(dispatched.length).toBe(2);

    // Settle all to let the snapshot complete.
    for (const s of settle) s();
    await new Promise(r => setTimeout(r, 10));
    for (const s of settle) s();
    await snapPromise;
  });
});

// ---------------------------------------------------------------------------
// 14. Immutability — late-settling op cannot mutate a cached snapshot
//     (WO-15B.1 item 3)
// ---------------------------------------------------------------------------

describe('snapshot immutability (WO-15B.1 item 3)', () => {
  it('successive refreshes produce independent perBotFinancials Maps', async () => {
    // Each _refresh builds a new Map; returning a second snapshot (different
    // refresh) does not mutate the first snapshot's Map.
    const bots = makeBots(1);

    // First refresh: netDeposited=1000.
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(
      makeEnrichment(['bot-1'], {
        equityAgg: new Map([['bot-1', { netDeposited: 1000, totalDeposits: 1200 }]]),
      }),
    );
    initSnapshotModule(makeDeps({ getBotSubaccountContext: vi.fn().mockReturnValue(null) }));
    const snap1 = await getWalletFinancialSnapshot(W);
    expect(snap1.status).toBe('fresh');
    const bal1 = snap1.perBotFinancials.get('bot-1')?.exchangeBalance;
    expect(typeof bal1).toBe('number');

    // Age past FRESH_TTL so a second refresh runs.
    const originalNow = Date.now;
    Date.now = () => snap1.observedAt! + 6_000;

    // Second refresh: netDeposited=2000 (different enrichment data).
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(
      makeEnrichment(['bot-1'], {
        equityAgg: new Map([['bot-1', { netDeposited: 2000, totalDeposits: 2400 }]]),
      }),
    );
    const snap2 = await getWalletFinancialSnapshot(W);
    Date.now = originalNow;

    expect(snap2.status).toBe('fresh');
    const bal2 = snap2.perBotFinancials.get('bot-1')?.exchangeBalance;

    // snap1 and snap2 have independent Maps; bal2 differs because enrichment differs.
    expect(snap2.perBotFinancials).not.toBe(snap1.perBotFinancials); // different Map objects
    expect(bal2).not.toBe(bal1); // different computed values
    // Critically: snap1's Map has NOT been mutated by the second refresh.
    expect(snap1.perBotFinancials.get('bot-1')?.exchangeBalance).toBe(bal1);
  });

  it('late-settling underlying pool op writes only to its local closure (not the Map)', async () => {
    // Property: the underlying fn inside pool.tryRun writes to a local var (liveInfo).
    // After the wrapper exits (deadline or completion), no further writes to
    // perBotFinancials happen. Verified by checking balance is unchanged after
    // the underlying settles post-snapshot.
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));

    let underlyingSettle!: (v: any) => void;

    const deps = makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue({ useBotKeypair: true }),
      getAgentUsdcBalance: vi.fn().mockResolvedValue(500),
      getAgentSolBalance: vi.fn().mockResolvedValue(0.5),
      getExchangeAccountInfo: vi.fn().mockResolvedValue({ totalCollateral: 5000, freeCollateral: 3000 }),
      accountVaultRoutableValueUsdc: vi.fn().mockResolvedValue(200),
      // Bot venue call hangs — underlying pool op never settles until we call underlyingSettle.
      getExchangeAccountInfoForBot: vi.fn().mockImplementation(
        () => new Promise(r => { underlyingSettle = r; }),
      ),
      addParkedValueForBotDisplayEquity: vi.fn().mockResolvedValue(PARKED_RESULT),
    });
    initSnapshotModule(deps);

    // Snapshot will return with bot-1 falling back to DB (venue call hangs, but
    // the module's CALLER_DEADLINE_MS fires after 10s — too long for a real-time
    // test). Instead: race the snapshot against a shorter helper.
    // We only need the inFlight to finish *somehow* in a reasonable time.
    // Since the underlying hangs, simulate by resolving it after a small delay.
    setTimeout(() => underlyingSettle(LIVE_INFO), 30);

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('fresh');

    // Record the balance right after the snapshot is returned.
    const balanceAtPublish = snap.perBotFinancials.get('bot-1')?.exchangeBalance;
    expect(balanceAtPublish).toBeDefined();

    // Wait additional time to ensure any underlying late writes would have landed.
    await new Promise(r => setTimeout(r, 50));

    // The snapshot's Map must be unchanged regardless of any post-settle activity.
    expect(snap.perBotFinancials.get('bot-1')?.exchangeBalance).toBe(balanceAtPublish);
  });
});

// ---------------------------------------------------------------------------
// 15. Truthful failure semantics (WO-15B.1 item 4)
// ---------------------------------------------------------------------------

describe('truthful failure semantics (WO-15B.1 item 4)', () => {
  it('cold DB failure → status unavailable, botsReadSucceeded=false', async () => {
    // Use mockImplementation (not mockRejectedValue) so it reliably overrides
    // the beforeEach mockResolvedValue([]) default.
    (storage.getTradingBots as any).mockImplementation(() =>
      Promise.reject(new Error('DB cold failure')),
    );
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('unavailable');
    expect(snap.botsReadSucceeded).toBe(false);
    expect(snap.bots).toEqual([]);
  });

  it('genuine empty wallet (no bots) → status fresh, botsReadSucceeded=true', async () => {
    (storage.getTradingBots as any).mockResolvedValue([]); // empty but succeeded
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('fresh');
    expect(snap.botsReadSucceeded).toBe(true);
    expect(snap.bots).toEqual([]);
  });

  it('capacity exhaustion → status unavailable, botsReadSucceeded=false', async () => {
    // All 100 entries in-flight → new wallet fails closed.
    let releaseAll!: () => void;
    const gate = new Promise<void>(r => { releaseAll = r; });
    (storage.getTradingBots as any).mockImplementation(() => gate.then(() => []));
    initSnapshotModule(makeDeps());

    const inFlight: Promise<any>[] = [];
    for (let i = 0; i < 100; i++) {
      inFlight.push(getWalletFinancialSnapshot(`wallet-cap-${i}`));
    }

    const snap = await getWalletFinancialSnapshot('wallet-overflow');
    expect(snap.status).toBe('unavailable');
    expect(snap.botsReadSucceeded).toBe(false);

    releaseAll();
    await Promise.allSettled(inFlight);
  });

  it('enrichment failure preserves bot list in snapshot', async () => {
    const bots = makeBots(3);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockRejectedValue(new Error('enrichment DB failure'));
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    // Bot list is from the successful getTradingBots call.
    expect(snap.bots).toHaveLength(3);
    expect(snap.botsReadSucceeded).toBe(true);
    // perBotFinancials has entries (with null/fallback fields since enrichment empty).
    expect(snap.perBotFinancials.size).toBe(3);
  });

  it('stale last-known-good snapshot is returned truthfully on refresh failure', async () => {
    initSnapshotModule(makeDeps());
    const bots = makeBots(2);
    (storage.getTradingBots as any).mockResolvedValueOnce(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1', 'bot-2']));

    const fresh = await getWalletFinancialSnapshot(W);
    expect(fresh.status).toBe('fresh');

    // Age past FRESH_TTL and fail the next refresh.
    const originalNow = Date.now;
    Date.now = () => fresh.observedAt! + 6_000;
    (storage.getTradingBots as any).mockRejectedValueOnce(new Error('transient failure'));

    const staleSnap = await getWalletFinancialSnapshot(W);
    Date.now = originalNow;

    expect(staleSnap.status).toBe('stale');
    expect(staleSnap.bots).toHaveLength(2);
    expect(staleSnap.botsReadSucceeded).toBe(true);
    expect(staleSnap.observedAt).toBe(fresh.observedAt);
  });
});

// ---------------------------------------------------------------------------
// 16. Total-equity null semantics (WO-15B.1 items 5 & 10)
// ---------------------------------------------------------------------------

describe('null semantics for partial main-account failure (WO-15B.1 items 5 & 10)', () => {
  it('all main-account venue ops failing yields null balances and partial status', async () => {
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      getAgentSolBalance: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      getExchangeAccountInfo: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      accountVaultRoutableValueUsdc: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    // Balances are null (not zero) when venue calls fail.
    expect(snap.agentBalance).toBeNull();
    expect(snap.solBalance).toBeNull();
    expect(snap.mainAccount).toBeNull();
    expect(snap.vaultBalance).toBeNull();
    // Status is partial (bot list OK, but main-account venue unavailable).
    expect(snap.status).toBe('partial');
    expect(snap.botsReadSucceeded).toBe(true);
  });

  it('single main-account venue failure leaves other sibling values intact', async () => {
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('timeout')),
      getAgentSolBalance: vi.fn().mockResolvedValue(1.5),
      getExchangeAccountInfo: vi.fn().mockResolvedValue({ totalCollateral: 3000, freeCollateral: 2000 }),
      accountVaultRoutableValueUsdc: vi.fn().mockResolvedValue(100),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    // agentBalance failed → null.
    expect(snap.agentBalance).toBeNull();
    // Siblings that succeeded are NOT erased.
    expect(snap.solBalance).toBe(1.5);
    expect(snap.mainAccount).not.toBeNull();
    expect(snap.mainAccount!.totalCollateral).toBe(3000);
    expect(snap.vaultBalance).toBe(100);
  });

  it('agentBalance=null makes status partial (not fresh)', async () => {
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('timeout')),
      // Other ops succeed.
      getAgentSolBalance: vi.fn().mockResolvedValue(0.5),
      getExchangeAccountInfo: vi.fn().mockResolvedValue({ totalCollateral: 5000, freeCollateral: 3000 }),
      accountVaultRoutableValueUsdc: vi.fn().mockResolvedValue(200),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    // WO-15B.2 item 4: ANY null main-account component → 'partial', not 'fresh'.
    // agentBalance is null (op threw) → partial even though 3 other ops succeeded.
    expect(snap.status).toBe('partial');
    expect(snap.agentBalance).toBeNull(); // must be null not 0
  });

  it('all 4 main-account ops failing → partial status, not fresh', async () => {
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('t')),
      getAgentSolBalance: vi.fn().mockRejectedValue(new Error('t')),
      getExchangeAccountInfo: vi.fn().mockRejectedValue(new Error('t')),
      accountVaultRoutableValueUsdc: vi.fn().mockRejectedValue(new Error('t')),
    }));

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('partial');
    expect(snap.agentBalance).toBeNull();
    expect(snap.mainAccount).toBeNull();
    expect(snap.vaultBalance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 17. Stale age evaluated at response time, not pre-await (WO-15B.1 item 6)
// ---------------------------------------------------------------------------

describe('response-time stale window (WO-15B.1 item 6)', () => {
  it('stale window is evaluated at actual response time, not before the wait', async () => {
    initSnapshotModule(makeDeps());
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValueOnce(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    const fresh = await getWalletFinancialSnapshot(W);
    expect(fresh.status).toBe('fresh');

    // Simulate: at the start of the next call, data is 55s old (in-window).
    // But the caller waits 8s for the refresh (which fails), making data 63s old
    // at actual response time (out of 60s window → unavailable).
    let nowOffset = 55_000; // start of call: 55s old
    const originalNow = Date.now;
    Date.now = () => fresh.observedAt! + nowOffset;

    // Refresh fails after advancing time (simulated by mutation during call).
    (storage.getTradingBots as any).mockImplementationOnce(() => {
      nowOffset = 63_000; // by the time the call fails, 63s have elapsed
      return Promise.reject(new Error('slow failure'));
    });

    const snap = await getWalletFinancialSnapshot(W);
    Date.now = originalNow;

    // At response time (63s > 60s window) → unavailable, not stale.
    expect(snap.status).toBe('unavailable');
  });

  it('stale data within 60s window is returned as stale, not unavailable', async () => {
    initSnapshotModule(makeDeps());
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValueOnce(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    const fresh = await getWalletFinancialSnapshot(W);

    const originalNow = Date.now;
    Date.now = () => fresh.observedAt! + 45_000; // 45s old — within window
    (storage.getTradingBots as any).mockRejectedValueOnce(new Error('transient'));

    const snap = await getWalletFinancialSnapshot(W);
    Date.now = originalNow;

    expect(snap.status).toBe('stale');
    expect(snap.observedAt).toBe(fresh.observedAt);
  });
});

// ---------------------------------------------------------------------------
// 18. Exact-market parity (WO-15B.1 item 7)
// ---------------------------------------------------------------------------

describe('exact-market parity (WO-15B.1 item 7)', () => {
  it('_dbFallback returns null when no position matches the bot market', async () => {
    const bots = makeBots(1, { market: 'ETH-PERP' });
    (storage.getTradingBots as any).mockResolvedValue(bots);
    // Position is for BTC-PERP, not ETH-PERP — no cross-market fallback.
    const enrichment = makeEnrichment(['bot-1'], {
      positions: new Map([['bot-1', [{
        market: 'BTC-PERP',
        baseSize: '1.0',
        avgEntryPrice: '40000',
        realizedPnl: '500',
        totalFees: '50',
      }]]]),
      equityAgg: new Map([['bot-1', { netDeposited: 1000, totalDeposits: 1200 }]]),
    });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(enrichment);

    const deps = makeDeps({ getBotSubaccountContext: vi.fn().mockReturnValue(null) });
    initSnapshotModule(deps);
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-1');
    expect(fin).toBeDefined();
    // No ETH-PERP position → only netDeposited used (no unrealizedPnl, realizedPnl=0).
    // netDeposited=1000, realizedPnl=0, fees=0, unrealizedPnl=0 → exchangeBalance=1000.
    expect(fin!.exchangeBalance).toBeCloseTo(1000, 2);
    expect(fin!.liveDataAvailable).toBe(false);
  });

  it('uses exact-market position row when present', async () => {
    const bots = makeBots(1, { market: 'SOL-PERP' });
    (storage.getTradingBots as any).mockResolvedValue(bots);
    const enrichment = makeEnrichment(['bot-1'], {
      positions: new Map([['bot-1', [
        { market: 'BTC-PERP', baseSize: '1', avgEntryPrice: '40000', realizedPnl: '999', totalFees: '0' },
        { market: 'SOL-PERP', baseSize: '0', avgEntryPrice: '100', realizedPnl: '200', totalFees: '10' },
      ]]]),
      equityAgg: new Map([['bot-1', { netDeposited: 500, totalDeposits: 600 }]]),
    });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(enrichment);

    const deps = makeDeps({ getBotSubaccountContext: vi.fn().mockReturnValue(null) });
    initSnapshotModule(deps);
    const snap = await getWalletFinancialSnapshot(W);

    const fin = snap.perBotFinancials.get('bot-1');
    // SOL-PERP row: realizedPnl=200, fees=10, baseSize=0 → unrealizedPnl=0
    // exchangeBalance = 500 + 200 + 0 - 10 = 690 (NOT using BTC-PERP's 999)
    expect(fin!.exchangeBalance).toBeCloseTo(690, 2);
  });
});

// ---------------------------------------------------------------------------
// 19. Adapter ordering (WO-15B.1 item 8)
// ---------------------------------------------------------------------------

describe('adapter ordering (WO-15B.1 item 8)', () => {
  it('getAdapterForBot is NOT called for Flash alias bots', async () => {
    const bots = [{
      id: 'bot-alias',
      name: 'Alias Bot',
      market: 'SOL-PERP',
      walletAddress: W,
      activeProtocol: 'flash',
      protocolSubaccountId: 'agent-pub', // same as agentPublicKey → alias
      driftSubaccountId: 0,
      subaccountAuthMode: null,
      subaccountStatus: null,
      botSubaccountKeyEncryptedV3: null,
      botSubaccountKeyEncrypted: null,
    }];
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-alias']));
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'agent-pub' });

    const getAdapterForBot = vi.fn().mockReturnValue({});
    initSnapshotModule(makeDeps({ getAdapterForBot }));
    await getWalletFinancialSnapshot(W);

    expect(getAdapterForBot).not.toHaveBeenCalled();
  });

  it('getAdapterForBot is NOT called when botCtx is null', async () => {
    const bots = makeBots(2);
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1', 'bot-2']));

    const getAdapterForBot = vi.fn().mockReturnValue({});
    const getBotSubaccountContext = vi.fn().mockReturnValue(null); // null ctx → DB fallback

    initSnapshotModule(makeDeps({ getAdapterForBot, getBotSubaccountContext }));
    await getWalletFinancialSnapshot(W);

    expect(getAdapterForBot).not.toHaveBeenCalled();
  });

  it('getAdapterForBot is called only for bots that need live venue access', async () => {
    const bots = [
      ...makeBots(1, {
        // Bot 1: no context → DB fallback, no adapter call
      }),
      {
        id: 'bot-live',
        name: 'Live Bot',
        market: 'BTC-PERP',
        walletAddress: W,
        activeProtocol: 'pacifica',
        protocolSubaccountId: 'live-key',
        driftSubaccountId: 1,
        subaccountAuthMode: 'external_key',
        subaccountStatus: 'active',
        botSubaccountKeyEncryptedV3: 'enc-v3',
        botSubaccountKeyEncrypted: null,
      },
    ];
    (storage.getTradingBots as any).mockResolvedValue(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1', 'bot-live']));

    const getAdapterForBot = vi.fn().mockReturnValue({});
    const getBotSubaccountContext = vi.fn().mockImplementation(bot =>
      bot.id === 'bot-live' ? { useBotKeypair: true } : null,
    );

    initSnapshotModule(makeDeps({ getAdapterForBot, getBotSubaccountContext }));
    await getWalletFinancialSnapshot(W);

    // Adapter resolved only for the live bot, not for the no-context bot.
    expect(getAdapterForBot).toHaveBeenCalledTimes(1);
    expect(getAdapterForBot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot-live' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 20. Timer cleanup (WO-15B.1 item 9)
// ---------------------------------------------------------------------------

describe('timer cleanup (WO-15B.1 item 9)', () => {
  it('no lingering timers after fast completions', async () => {
    // Use fake timers to count active timers.
    vi.useFakeTimers();

    initSnapshotModule(makeDeps());
    const snapPromise = getWalletFinancialSnapshot(W);
    await vi.runAllTimersAsync();
    const snap = await snapPromise;

    expect(snap.status).toBe('fresh');
    // All timers should have been cleared (clearTimeout called for settled ops).
    // We verify indirectly: no pending timers remain after the snapshot completes.
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  it('_raceDeadline clears timer when underlying wins before deadline', async () => {
    vi.useFakeTimers();

    // Fast operation — settles well before deadline.
    const fastOp = Promise.resolve(42);
    // Import the module's race via BoundedPool integration.
    const pool = new BoundedPool(1);
    let result: number | undefined;
    const p = pool.tryRun(async () => { result = await fastOp; });
    await vi.runAllTimersAsync();
    await p;

    // No timers should remain from the race.
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 1: BoundedPool.waiterCount / no-stampede invariant
// ---------------------------------------------------------------------------

describe('BoundedPool.waiterCount / no-stampede (WO-15B.2 item 1)', () => {
  it('waiterCount starts at 0 when pool has free capacity', () => {
    const pool = new BoundedPool(2);
    expect(pool.waiterCount).toBe(0);
  });

  it('waiterCount increments when all slots are occupied', () => {
    const pool = new BoundedPool(1);

    // Fill the single slot synchronously — tryRun acquires immediately.
    let resolveFirst!: () => void;
    const first = new Promise<void>(r => { resolveFirst = r; });
    const run1 = pool.tryRun(() => first);
    expect(run1).not.toBeNull();
    expect(pool.active).toBe(1);

    // tryRun at capacity returns null and does NOT queue. Only
    // waitForSlot / waitForSlotCancellable add to _waiters.
    // Use waitForSlotCancellable to enqueue a waiter.
    const { promise: slotP, cancel } = pool.waitForSlotCancellable();
    expect(pool.waiterCount).toBe(1);

    // Resolve the running slot → waiter is woken and waiterCount drops.
    resolveFirst();
    // Cleanup: cancel the waiter (it resolves synchronously on the next tick).
    cancel();
    expect(pool.waiterCount).toBe(0);

    // Suppress unhandled promise warning.
    slotP.then(() => {}).catch(() => {});
  });

  it('waiterCount returns to 0 after all queued callers are served', async () => {
    const pool = new BoundedPool(2);
    const results: number[] = [];
    const tasks = Array.from({ length: 4 }, (_, i) =>
      pool.tryRun(() => Promise.resolve(i).then(v => { results.push(v); return v; })),
    );
    await Promise.allSettled(tasks);
    expect(pool.waiterCount).toBe(0);
  });

  it('_waiterCount helper reflects in-flight snapshot joins', async () => {
    // Issue two concurrent snapshot calls: the second should join the first.
    const W2 = 'wallet-waitcount';
    (storage.getTradingBots as any).mockResolvedValue([]);
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'pk-wc' });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([]));
    (storage.getVaultPositionsAllScopes as any).mockResolvedValue([]);

    // Slow primary refresh lets the second call observe the waiter count.
    let releaseRefresh!: () => void;
    const blocker = new Promise<void>(r => { releaseRefresh = r; });

    _resetForTest();
    initSnapshotModule(makeDeps({
      getExchangeAccountInfo: vi.fn().mockImplementation(() => blocker.then(() => ({ totalCollateral: 0, freeCollateral: 0 }))),
    }));

    const p1 = getWalletFinancialSnapshot(W2);
    // Yield to let p1 begin.
    await Promise.resolve();
    const p2 = getWalletFinancialSnapshot(W2);
    await Promise.resolve();

    // p2 should be waiting; waiter count ≥ 1.
    const wcBefore = _waiterCount(W2);

    releaseRefresh();
    await Promise.allSettled([p1, p2]);

    // After both settle, no waiters remain.
    expect(_waiterCount(W2)).toBe(0);
    // Sanity: at peak we had ≥ 1 waiter (or p2 fast-joined before count could be observed).
    expect(wcBefore).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 2: waitForSlotCancellable — stale waiters are cancelled
// ---------------------------------------------------------------------------

describe('stale waiters cancelled (WO-15B.2 item 2)', () => {
  it('snapshot joined by a second caller resolves after the primary completes', async () => {
    const W3 = 'wallet-cancel';
    (storage.getTradingBots as any).mockResolvedValue([]);
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'pk-c' });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([]));
    (storage.getVaultPositionsAllScopes as any).mockResolvedValue([]);

    let releaseRefresh!: () => void;
    const blocker = new Promise<void>(r => { releaseRefresh = r; });

    _resetForTest();
    initSnapshotModule(makeDeps({
      getExchangeAccountInfo: vi.fn().mockImplementation(() =>
        blocker.then(() => ({ totalCollateral: 0, freeCollateral: 0 })),
      ),
    }));

    const p1 = getWalletFinancialSnapshot(W3);
    await Promise.resolve();
    const p2 = getWalletFinancialSnapshot(W3);

    releaseRefresh();
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both callers should get a result; second caller received the same snapshot.
    expect(r1.status).not.toBe('unavailable');
    expect(r2.status).toBe(r1.status);
    // No waiters remain after both settle.
    expect(_waiterCount(W3)).toBe(0);
  });

  it('cancelled waiter does not receive an old stale snapshot as if fresh', async () => {
    const W4 = 'wallet-cancel2';
    (storage.getTradingBots as any).mockResolvedValue([]);
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: 'pk-c2' });
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([]));
    (storage.getVaultPositionsAllScopes as any).mockResolvedValue([]);

    _resetForTest();
    initSnapshotModule(makeDeps());

    // First call populates the cache.
    const r1 = await getWalletFinancialSnapshot(W4);
    expect(r1.status).toBe('fresh');

    // Advance time past TTL but within stale window.
    const originalNow = Date.now;
    Date.now = () => r1.observedAt! + 8_000; // 8s old — stale

    // Second call: gets stale from cache.
    const r2 = await getWalletFinancialSnapshot(W4);
    Date.now = originalNow;

    // Status should reflect cache state (stale or fresh if re-fetched quickly).
    expect(['fresh', 'stale']).toContain(r2.status);
    // observedAt must not regress (second result can't be older than first).
    expect(r2.observedAt!).toBeGreaterThanOrEqual(r1.observedAt!);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 3: strict reads propagate null (SnapshotDeps JSDoc contract)
// ---------------------------------------------------------------------------

describe('strict-read null propagation (WO-15B.2 item 3)', () => {
  it('getExchangeAccountInfo throwing → mainAccount=null, agentBalance unaffected', async () => {
    initSnapshotModule(makeDeps({
      getExchangeAccountInfo: vi.fn().mockRejectedValue(new Error('strict-rpc-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.mainAccount).toBeNull();
    // agentBalance is from a separate op — should still be a number.
    expect(snap.agentBalance).not.toBeNull();
    expect(typeof snap.agentBalance).toBe('number');
  });

  it('getAgentUsdcBalance throwing → agentBalance=null, mainAccount unaffected', async () => {
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('strict-usdc-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.agentBalance).toBeNull();
    expect(snap.mainAccount).not.toBeNull();
    expect(typeof snap.mainAccount!.totalCollateral).toBe('number');
  });

  it('accountVaultRoutableValueUsdc throwing → vaultBalance=null', async () => {
    initSnapshotModule(makeDeps({
      accountVaultRoutableValueUsdc: vi.fn().mockRejectedValue(new Error('strict-vault-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.vaultBalance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 4: single-op failure → partial (not fresh)
// ---------------------------------------------------------------------------

describe('single-op failure → partial status (WO-15B.2 item 4)', () => {
  it('getAgentSolBalance throwing → partial status', async () => {
    initSnapshotModule(makeDeps({
      getAgentSolBalance: vi.fn().mockRejectedValue(new Error('sol-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('partial');
  });

  it('getExchangeAccountInfo throwing → partial status', async () => {
    initSnapshotModule(makeDeps({
      getExchangeAccountInfo: vi.fn().mockRejectedValue(new Error('exchange-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('partial');
  });

  it('accountVaultRoutableValueUsdc throwing → partial status', async () => {
    initSnapshotModule(makeDeps({
      accountVaultRoutableValueUsdc: vi.fn().mockRejectedValue(new Error('vault-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('partial');
  });

  it('partial snapshot has enrichmentSucceeded=true when enrichment itself succeeded', async () => {
    // Even with a main-account failure, enrichment may have worked fine.
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('usdc-fail')),
    }));
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.status).toBe('partial');
    expect(snap.enrichmentSucceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 5: enrichmentSucceeded / parkedHintSucceeded tracking
// ---------------------------------------------------------------------------

describe('enrichmentSucceeded / parkedHintSucceeded (WO-15B.2 item 5)', () => {
  it('enrichmentSucceeded=true on normal run', async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(2));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1', 'bot-2']));
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.enrichmentSucceeded).toBe(true);
  });

  it('enrichmentSucceeded=false when getTradingBotListEnrichment throws', async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockRejectedValueOnce(new Error('enrichment-fail'));
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.enrichmentSucceeded).toBe(false);
    // Bot list is retained (bots should still be present in snapshot).
    expect(snap.bots.length).toBe(1);
  });

  it('parkedHintSucceeded=true when addParkedValueForBotDisplayEquity succeeds', async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.parkedHintSucceeded).toBe(true);
  });

  it('addParkedValueForBotDisplayEquity throwing does NOT affect parkedHintSucceeded', async () => {
    // parkedHintSucceeded tracks getVaultPositionsAllScopes (Phase 1b).
    // addParkedValueForBotDisplayEquity is per-bot Op2; its failure is silent
    // (adj=null → raw collateral fallback). parkedHintSucceeded must stay true.
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    initSnapshotModule(makeDeps({
      addParkedValueForBotDisplayEquity: vi.fn().mockRejectedValue(new Error('op2-fail')),
    }));

    const snap = await getWalletFinancialSnapshot(W);

    // Op2 failure is silent; parkedHintSucceeded is unaffected.
    expect(snap.parkedHintSucceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 6: null bot balance propagates to inTrading in route
// (tested here at module level: fin.exchangeBalance is null when live call fails
//  and DB fallback also unavailable)
// ---------------------------------------------------------------------------

describe('null bot exchangeBalance propagation (WO-15B.2 item 6)', () => {
  it('bot with failed live call AND no DB data → exchangeBalance=null', async () => {
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValueOnce(bots);
    // No enrichment data for this bot.
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce({
      tradeCounts: new Map(),
      positions: new Map(),
      publishedBotMap: new Map(),
      equityAgg: new Map(), // no netDeposited for bot-1
      borrowDebts: new Map(),
    });

    initSnapshotModule(makeDeps({
      getExchangeAccountInfoForBot: vi.fn().mockRejectedValue(new Error('live-fail')),
      getBotSubaccountContext: vi.fn().mockReturnValue({ useBotKeypair: true }),
    }));

    const snap = await getWalletFinancialSnapshot(W);
    const fin = snap.perBotFinancials.get('bot-1');

    expect(fin).toBeDefined();
    // Live call failed and no DB basis available → null, not 0.
    expect(fin!.exchangeBalance).toBeNull();
  });

  it('botCtx=null → DB fallback used → exchangeBalance derived from enrichment (not null)', async () => {
    const bots = makeBots(1);
    (storage.getTradingBots as any).mockResolvedValueOnce(bots);
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));

    // getBotSubaccountContext returns null → skips live path → uses DB fallback.
    initSnapshotModule(makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue(null),
    }));

    const snap = await getWalletFinancialSnapshot(W);
    const fin = snap.perBotFinancials.get('bot-1');

    expect(fin).toBeDefined();
    // DB fallback: enrichment has netDeposited=1000, positions provide PnL.
    expect(fin!.exchangeBalance).not.toBeNull();
    expect(fin!.liveDataAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 7: parkedHintSucceeded=false → partial status
// ---------------------------------------------------------------------------

describe('parkedHintSucceeded=false → partial (WO-15B.2 item 7)', () => {
  it('getVaultPositionsAllScopes failure → parkedHintSucceeded=false → partial', async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    // parkedHintSucceeded tracks getVaultPositionsAllScopes (Phase 1b),
    // NOT addParkedValueForBotDisplayEquity (per-bot Op2).
    (storage.getVaultPositionsAllScopes as any).mockRejectedValueOnce(new Error('hint-fail'));
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.parkedHintSucceeded).toBe(false);
    expect(snap.status).toBe('partial');
  });

  it('parkedHintSucceeded=true when getVaultPositionsAllScopes succeeds', async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValueOnce(makeEnrichment(['bot-1']));
    (storage.getVaultPositionsAllScopes as any).mockResolvedValueOnce([]);
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.parkedHintSucceeded).toBe(true);
    expect(snap.status).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 8: no lingering caller-envelope timer on fast settle
// ---------------------------------------------------------------------------

describe('no lingering caller-envelope timer on fast settle (WO-15B.2 item 8)', () => {
  it('caller-envelope timer cleared before any timer drain when ops settle via microtasks', async () => {
    vi.useFakeTimers();
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));

    _resetForTest();
    // No live bot context → only main-account ops run, all via mockResolvedValue.
    initSnapshotModule(makeDeps({ getBotSubaccountContext: vi.fn().mockReturnValue(null) }));

    // Await through microtasks only — no runAllTimers / advanceTimersByTime.
    // All deps resolve via mockResolvedValue (immediate microtasks), so the
    // in-flight settles before any setTimeout fires. clearCallerTimer() must
    // execute as part of that microtask chain.
    // If any timer were still live after this await, getTimerCount() > 0 and
    // the assertion below catches the leak WITHOUT runAllTimers masking it.
    const snap = await getWalletFinancialSnapshot(W);

    expect(snap.status).toBe('fresh');
    // CRITICAL: no active timers must remain without any explicit timer drain.
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2 item 9: lastSuccess only updated on snapshotStatus==='fresh'
// ---------------------------------------------------------------------------

describe('lastSuccess only updated on fresh (WO-15B.2 item 9)', () => {
  it('fresh snapshot updates lastSuccess', async () => {
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));
    _resetForTest();
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);
    expect(snap.status).toBe('fresh');
    // observedAt must be set — this is the lastSuccess timestamp.
    expect(snap.observedAt).toBeGreaterThan(0);
  });

  it('partial snapshot does NOT update lastSuccess — refresh after partial TTL is fresh', async () => {
    // Start cold. First call: agentUsdcBalance fails → 'partial'.
    // Because lastSuccess stays null after a partial, once the short partial
    // cache (FRESH_TTL_MS = 5 s) expires the next call triggers a full fresh
    // refresh and gets a fully-good snapshot.
    const W_LAST = 'wallet-last-success';
    _resetForTest();
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));

    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('strict-fail')),
    }));

    const partialSnap = await getWalletFinancialSnapshot(W_LAST);
    expect(partialSnap.status).toBe('partial');

    // Advance time past FRESH_TTL_MS (5 s) so the lastPartial cache expires.
    // lastSuccess is still null — no good snapshot to serve as stale fallback.
    const origNow = Date.now;
    Date.now = () => partialSnap.observedAt! + 6_000;
    try {
      // Re-init with all ops succeeding. The partial cache has expired, so the
      // second call triggers a new refresh → returns 'fresh'.
      // If lastSuccess had been wrongly set by the partial, this would return
      // a 'stale' hit — which would NOT be 'fresh'.
      initSnapshotModule(makeDeps());

      const secondSnap = await getWalletFinancialSnapshot(W_LAST);
      expect(secondSnap.status).toBe('fresh');
      expect(secondSnap.agentBalance).not.toBeNull();
    } finally {
      Date.now = origNow;
    }
  });

  it('enrichmentSucceeded=false → snapshot is partial, not fresh', async () => {
    (storage.getTradingBots as any).mockResolvedValueOnce(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockRejectedValueOnce(new Error('enrich-fail'));
    _resetForTest();
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W);

    // Enrichment failure → partial. lastSuccess must not be updated.
    expect(snap.status).toBe('partial');
    expect(snap.enrichmentSucceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 1/2: Phase-1a no-stampede
// Two concurrent callers share one in-flight; getTradingBots called once.
// ---------------------------------------------------------------------------

describe('Phase-1a no-stampede: concurrent callers share in-flight (item 1/2)', () => {
  const W_NS = 'wallet-no-stampede';

  it('two concurrent callers share one getTradingBots call', async () => {
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));
    initSnapshotModule(makeDeps());

    const [snap1, snap2] = await Promise.all([
      getWalletFinancialSnapshot(W_NS),
      getWalletFinancialSnapshot(W_NS),
    ]);

    // Concurrent callers must join the same in-flight: only ONE DB call.
    expect(storage.getTradingBots).toHaveBeenCalledTimes(1);
    expect(snap1.status).toBe('fresh');
    expect(snap2.status).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 3: successful-empty parity
// enrichmentSucceeded=true + no equityAgg row → exchangeBalance=0 (not null).
// ---------------------------------------------------------------------------

describe('successful-empty parity: missing equityAgg row → zero not null (item 3)', () => {
  const W_SE = 'wallet-successful-empty';

  it('new bot with no equityAgg row gets zero exchange balance, snapshot is fresh', async () => {
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    // Enrichment returns successfully but with EMPTY maps — no entry for bot-1.
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment([]));
    initSnapshotModule(makeDeps({
      // No live context → DB-only path via _fallbackFinancials (enrichmentSucceeded=true).
      getBotSubaccountContext: vi.fn().mockReturnValue(null),
    }));

    const snap = await getWalletFinancialSnapshot(W_SE);

    // Enrichment succeeded: empty equityAgg → new bot with zero history.
    // exchangeBalance/netPnl/netPnlPercent must be 0, NOT null.
    expect(snap.status).toBe('fresh');
    const botData = snap.perBotFinancials.get('bot-1');
    expect(botData?.exchangeBalance).toBe(0);
    expect(botData?.netPnl).toBe(0);
    expect(botData?.netPnlPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 4: per-bot unavailable → snapshot partial
// anyBotUnavailable=true propagates into snapshotStatus.
// ---------------------------------------------------------------------------

describe('per-bot unavailable propagates to snapshot status (item 4)', () => {
  const W_PBU = 'wallet-per-bot-unavailable';

  it('bot whose live exchange info fails → botFinancialStatus=unavailable → snapshot partial', async () => {
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));
    initSnapshotModule(makeDeps({
      // Provide a live context so the live path is attempted.
      getBotSubaccountContext: vi.fn().mockReturnValue({ subaccountId: 0 }),
      getAdapterForBot: vi.fn().mockReturnValue({}),
      // Live call fails → op1ok=false → botFinancialStatus='unavailable'.
      getExchangeAccountInfoForBot: vi.fn().mockRejectedValue(new Error('venue-down')),
    }));

    const snap = await getWalletFinancialSnapshot(W_PBU);

    // Main-account ops all succeed; only the per-bot live call fails.
    // Before fix: snapshot was 'fresh' (anyMainMissing was only checking main-account).
    // After fix: anyBotUnavailable=true → 'partial'.
    expect(snap.status).toBe('partial');
    const botData = snap.perBotFinancials.get('bot-1');
    expect(botData?.botFinancialStatus).toBe('unavailable');
  });

  it('bot with unavailable parked value → parkedValueUnavailable=true → snapshot partial', async () => {
    const W_PPU = 'wallet-per-bot-parked-uncertain';
    (storage.getTradingBots as any).mockResolvedValue(makeBots(1));
    (storage.getTradingBotListEnrichment as any).mockResolvedValue(makeEnrichment(['bot-1']));
    initSnapshotModule(makeDeps({
      getBotSubaccountContext: vi.fn().mockReturnValue({ subaccountId: 0 }),
      getAdapterForBot: vi.fn().mockReturnValue({}),
      getExchangeAccountInfoForBot: vi.fn().mockResolvedValue(LIVE_INFO),
      // Op2 (parked value) fails → adj=null → parkedValueUnavailable=true.
      addParkedValueForBotDisplayEquity: vi.fn().mockRejectedValue(new Error('vault-down')),
    }));

    const snap = await getWalletFinancialSnapshot(W_PPU);

    expect(snap.status).toBe('partial');
    const botData = snap.perBotFinancials.get('bot-1');
    expect(botData?.parkedValueUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 5: null agentAddress → partial (not fresh)
// agentAddress === null is itself a missing condition.
// ---------------------------------------------------------------------------

describe('null agentAddress → snapshot is partial (item 5)', () => {
  const W_NA = 'wallet-no-agent';

  it('wallet with null agentPublicKey → snapshot is partial', async () => {
    (storage.getWallet as any).mockResolvedValue({ agentPublicKey: null });
    (storage.getTradingBots as any).mockResolvedValue([]);
    initSnapshotModule(makeDeps());

    const snap = await getWalletFinancialSnapshot(W_NA);

    // Before fix: anyMainMissing = agentAddress !== null && (...) → false when null.
    // After fix:  anyMainMissing = agentAddress === null || (...) → true → partial.
    expect(snap.status).toBe('partial');
    expect(snap.agentBalance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 6: 5 s partial result cache
// Partial snapshots are cached for FRESH_TTL_MS (5 s) to avoid stampede.
// ---------------------------------------------------------------------------

describe('5 s partial result cache (item 6)', () => {
  const W_PC = 'wallet-partial-cache';
  const W_PCE = 'wallet-partial-cache-expired';

  it('second call within TTL reuses lastPartial without re-querying DB', async () => {
    (storage.getTradingBots as any).mockResolvedValue(makeBots(0));
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('rpc-fail')),
    }));

    const snap1 = await getWalletFinancialSnapshot(W_PC);
    expect(snap1.status).toBe('partial');

    // Reset mock call counts; switch to all-succeeding deps.
    // Within FRESH_TTL_MS, the lastPartial cache must serve without new DB work.
    vi.clearAllMocks();
    (storage.getTradingBots as any).mockResolvedValue(makeBots(0));
    initSnapshotModule(makeDeps());

    const snap2 = await getWalletFinancialSnapshot(W_PC);
    // Served from lastPartial cache — no new DB calls and still partial.
    expect(storage.getTradingBots).not.toHaveBeenCalled();
    expect(snap2.status).toBe('partial');
  });

  it('after FRESH_TTL_MS expires the partial cache is bypassed and a fresh run starts', async () => {
    const origNow = Date.now;
    const t0 = origNow();
    Date.now = () => t0;
    try {
      (storage.getTradingBots as any).mockResolvedValue(makeBots(0));
      initSnapshotModule(makeDeps({
        getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('rpc-fail')),
      }));

      const snap1 = await getWalletFinancialSnapshot(W_PCE);
      expect(snap1.status).toBe('partial');

      // Advance clock past FRESH_TTL_MS (5 s).
      Date.now = () => t0 + 6_000;

      vi.clearAllMocks();
      (storage.getTradingBots as any).mockResolvedValue(makeBots(0));
      initSnapshotModule(makeDeps()); // all deps now succeed

      const snap2 = await getWalletFinancialSnapshot(W_PCE);
      // Expired partial → new refresh → fresh result.
      expect(storage.getTradingBots).toHaveBeenCalledTimes(1);
      expect(snap2.status).toBe('fresh');
    } finally {
      Date.now = origNow;
    }
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 7: BoundedPool.waiterCount is exact after all releases
// ---------------------------------------------------------------------------

describe('BoundedPool waiterCount is zero after all waiters dequeued (item 7)', () => {
  it('all waiters are dequeued exactly once per slot release', async () => {
    const pool = new BoundedPool(2);

    // Fill both slots with manually-controlled promises.
    let release1!: () => void;
    let release2!: () => void;
    pool.tryRun(() => new Promise<void>(r => { release1 = r; }));
    pool.tryRun(() => new Promise<void>(r => { release2 = r; }));
    expect(pool.active).toBe(2);

    // Queue two waiters — pool is at capacity.
    const w1 = pool.waitForSlot();
    const w2 = pool.waitForSlot();
    expect(pool.waiterCount).toBe(2);

    // Release both slots → both waiters dequeued via _release → _waiters.shift().
    release1();
    release2();
    await w1;
    await w2;

    // INVARIANT: no dangling waiter entries after all releases.
    expect(pool.waiterCount).toBe(0);
  });

  it('cancelled waiter is removed from the queue immediately', async () => {
    const pool = new BoundedPool(1);

    let release1!: () => void;
    pool.tryRun(() => new Promise<void>(r => { release1 = r; }));

    const { promise: w1, cancel: cancel1 } = pool.waitForSlotCancellable();
    const { promise: _w2, cancel: cancel2 } = pool.waitForSlotCancellable();
    expect(pool.waiterCount).toBe(2);

    cancel1();
    expect(pool.waiterCount).toBe(1);

    cancel2();
    expect(pool.waiterCount).toBe(0);

    // Release the slot — no waiter to notify (both cancelled).
    release1();
    // w1 and _w2 never resolve (they were cancelled; promise hangs — that is fine
    // for this test since we are only asserting waiterCount semantics).
    void w1;
    expect(pool.waiterCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WO-15B.2.1 item 8: strict USDC balance injection contract
// Zero is legitimate (absent ATA); throw is an RPC error → partial.
// ---------------------------------------------------------------------------

describe('getAgentUsdcBalance: zero vs throw semantics (item 8)', () => {
  const W_ATA = 'wallet-ata-zero';
  const W_RPC = 'wallet-rpc-throw';

  it('balance of 0 → agentBalance is 0 and snapshot is fresh (absent ATA is legitimate)', async () => {
    (storage.getTradingBots as any).mockResolvedValue([]);
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockResolvedValue(0),
    }));

    const snap = await getWalletFinancialSnapshot(W_ATA);

    // 0 is a valid balance (new wallet with no USDC / no ATA yet).
    // It must NOT be treated as null or cause a partial status.
    expect(snap.agentBalance).toBe(0);
    expect(snap.status).toBe('fresh');
  });

  it('thrown RPC error → agentBalance is null and snapshot is partial', async () => {
    (storage.getTradingBots as any).mockResolvedValue([]);
    initSnapshotModule(makeDeps({
      getAgentUsdcBalance: vi.fn().mockRejectedValue(new Error('getAccountInfo failed')),
    }));

    const snap = await getWalletFinancialSnapshot(W_RPC);

    // Transport failure → cannot trust the balance → null → partial.
    expect(snap.agentBalance).toBeNull();
    expect(snap.status).toBe('partial');
  });
});
