/**
 * WO-15B: Per-wallet financial snapshot module.
 *
 * Provides a shared, cached, deadline-bounded per-wallet enrichment layer for
 * both GET /api/trading-bots and GET /api/total-equity. Replaces the previous
 * N-bot per-bot DB fan-out and uncapped venue concurrency with:
 *
 *   - One getTradingBotListEnrichment call per refresh (batch DB, no per-bot).
 *   - Venue/account concurrency capped at 2 per refresh (BoundedPool).
 *   - 10-second wall-clock deadline over all venue work.
 *   - Never-releasing slots: pool slots track to underlying promise settlement,
 *     not to the response deadline (satisfies the no-detached-work invariant).
 *   - LRU cache, max 100 wallet entries; in-flight entries are never evicted.
 *   - Stale-on-failure: last successful snapshot survives 60 s after observedAt.
 *   - Snapshot shared across concurrent callers for the same wallet (one refresh).
 */

import { storage } from './storage';
import type { BotListEnrichment } from './storage';
import type { TradingBot } from '../shared/schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FinancialStatus = 'fresh' | 'stale' | 'unavailable';

/** Route-local helpers injected to avoid circular imports (routes.ts → this). */
export type SnapshotDeps = {
  /** Synchronous cached-price snapshot (no network, stale-ok). */
  getCachedPricesMeta(symbols: string[]): {
    prices: Record<string, number>;
    pricesAsOf: number | null;
    pricesStale: boolean;
  };
  /** Per-bot account info via venue adapter. Fail-open (returns zeros). */
  getExchangeAccountInfoForBot(
    agentPublicKey: string,
    subAccountId: number,
    botCtx: unknown,
    adapter: unknown,
  ): Promise<{
    totalCollateral: number;
    freeCollateral: number;
    usdcBalance: number;
    unrealizedPnl: number;
    marginUsed: number;
    hasOpenPositions: boolean;
    totalPositionNotional: number;
  }>;
  /** Flash-only: add parked vault value to live exchange balance. Fail-open. */
  addParkedValueForBotDisplayEquity(
    bot: TradingBot,
    adapter: unknown,
    baseUsdc: number,
    opts?: { hasVaultRows?: boolean },
  ): Promise<{
    equityUsdc: number;
    parkedValueUsdc: number;
    parkedValueIncluded: boolean;
    parkedValueUnavailable: boolean;
  }>;
  /** Main-account exchange info (account-model subaccount 0). Fail-open. */
  getExchangeAccountInfo(
    walletAddress: string,
    subAccountId?: number,
  ): Promise<{
    totalCollateral: number;
    freeCollateral: number;
    usdcBalance?: number;
  }>;
  getAgentUsdcBalance(agentAddress: string): Promise<number>;
  getAgentSolBalance(agentAddress: string): Promise<number>;
  /** Account-scope Vault yield value (routable on demand). Fail-open. */
  accountVaultRoutableValueUsdc(
    walletAddress: string,
    agentAddress: string,
  ): Promise<number>;
  /** Returns a context object for bots with an external per-bot key, else null. */
  getBotSubaccountContext(bot: TradingBot): unknown;
  getAdapterForBot(bot: TradingBot): unknown;
};

/** Per-bot financial data from a wallet snapshot. */
export type BotFinancialData = {
  /** Computed bot equity (live or DB-based). null only if both paths unavailable. */
  exchangeBalance: number | null;
  /** netPnl = exchangeBalance – netDeposited. null when exchangeBalance is null. */
  netPnl: number | null;
  /** Percent relative to totalDeposits. null when exchangeBalance is null. */
  netPnlPercent: number | null;
  /** Open USDC borrow debt (from batch enrichment; always non-null). */
  borrowDebtUsdc: number;
  /** USD value of tokens parked in Vault (Flash per-bot only). 0 if unavailable. */
  parkedValueUsdc: number;
  parkedValueIncluded: boolean;
  parkedValueUnavailable: boolean;
  /** True when exchangeBalance came from a live venue call (not DB fallback). */
  liveDataAvailable: boolean;
};

/** Full wallet-level snapshot consumed by both routes. */
export type WalletFinancialSnapshot = {
  status: FinancialStatus;
  /** Wall-clock ms of the successful snapshot. null when status === 'unavailable'. */
  observedAt: number | null;
  bots: TradingBot[];
  wallet: Awaited<ReturnType<typeof storage.getWallet>>;
  enrichment: BotListEnrichment;
  perBotFinancials: Map<string, BotFinancialData>;
  /** Main-account exchange equity/collateral. null if venue unavailable. */
  mainAccount: { totalCollateral: number; freeCollateral: number } | null;
  agentBalance: number;
  solBalance: number;
  /** Account-scope Vault yield value. Route applies ?includeVault filter. */
  vaultBalance: number;
  prices: Record<string, number>;
  pricesAsOf: number | null;
  pricesStale: boolean;
};

// ---------------------------------------------------------------------------
// BoundedPool — concurrency limiter with settlement-based slot release
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity semaphore for venue/RPC work.
 *
 * Slots are released ONLY when the underlying promise settles. A
 * response-deadline race does NOT release slots; future snapshots that see a
 * full pool fail-closed/defer rather than stacking unlimited new work on top
 * of stuck underlying calls (WO-15B requirement 13).
 */
export class BoundedPool {
  private _active = 0;
  private _waiters: Array<() => void> = [];
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get active(): number { return this._active; }
  get available(): number { return this.capacity - this._active; }

  /**
   * Acquire a slot if available and run fn(). Slot released on fn's settlement.
   * Returns the underlying promise (for use in a deadline race), or null if
   * the pool is at capacity (fail-closed — do NOT retry without waiting).
   */
  tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
    if (this._active >= this.capacity) return null;
    this._active++;
    const p = fn();
    p.then(() => this._release(), () => this._release());
    return p;
  }

  /**
   * Resolves when any currently running item finishes (slot opens). Resolves
   * immediately if the pool is already below capacity.
   */
  waitForSlot(): Promise<void> {
    if (this._active < this.capacity) return Promise.resolve();
    return new Promise<void>((resolve) => { this._waiters.push(resolve); });
  }

  private _release(): void {
    this._active--;
    this._waiters.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// Internal constants and state
// ---------------------------------------------------------------------------

const FRESH_TTL_MS = 5_000;
const STALE_WINDOW_MS = 60_000;
const VENUE_DEADLINE_MS = 10_000;
const MAX_WALLET_ENTRIES = 100;
const DEADLINE_SENTINEL: unique symbol = Symbol('deadline');

type SnapshotData = {
  bots: TradingBot[];
  wallet: Awaited<ReturnType<typeof storage.getWallet>>;
  enrichment: BotListEnrichment;
  perBotFinancials: Map<string, BotFinancialData>;
  mainAccount: { totalCollateral: number; freeCollateral: number } | null;
  agentBalance: number;
  solBalance: number;
  vaultBalance: number;
  prices: Record<string, number>;
  pricesAsOf: number | null;
  pricesStale: boolean;
  observedAt: number;
};

type CacheEntry = {
  walletAddress: string;
  lastSuccess: SnapshotData | null;
  inFlight: Promise<SnapshotData> | null;
  lruTimestamp: number;
  /** Persists across refreshes to track never-settling venue promises. */
  pool: BoundedPool;
};

let _deps: SnapshotDeps | null = null;
const _cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initSnapshotModule(deps: SnapshotDeps): void {
  _deps = deps;
}

// ---------------------------------------------------------------------------
// LRU cache helpers
// ---------------------------------------------------------------------------

function _getOrCreate(walletAddress: string): CacheEntry | null {
  const existing = _cache.get(walletAddress);
  if (existing) {
    existing.lruTimestamp = Date.now();
    return existing;
  }

  if (_cache.size >= MAX_WALLET_ENTRIES) {
    // Evict LRU non-in-flight entry.
    let victim: [string, CacheEntry] | null = null;
    for (const [key, entry] of _cache) {
      if (entry.inFlight !== null) continue;
      if (victim === null || entry.lruTimestamp < victim[1].lruTimestamp) {
        victim = [key, entry];
      }
    }
    if (victim === null) return null; // all entries in-flight — fail closed
    _cache.delete(victim[0]);
  }

  const entry: CacheEntry = {
    walletAddress,
    lastSuccess: null,
    inFlight: null,
    lruTimestamp: Date.now(),
    pool: new BoundedPool(2),
  };
  _cache.set(walletAddress, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Deadline-aware race (does NOT release pool slots)
// ---------------------------------------------------------------------------

function _raceDeadline<T>(
  p: Promise<T>,
  remainingMs: number,
): Promise<T | typeof DEADLINE_SENTINEL> {
  if (remainingMs <= 0) return Promise.resolve(DEADLINE_SENTINEL);
  return Promise.race([
    p,
    new Promise<typeof DEADLINE_SENTINEL>(resolve =>
      setTimeout(() => resolve(DEADLINE_SENTINEL), remainingMs),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// DB-based fallback balance (no venue calls needed)
// ---------------------------------------------------------------------------

function _dbFallback(
  bot: TradingBot,
  enrichment: BotListEnrichment,
  prices: Record<string, number>,
): { exchangeBalance: number; netPnl: number; netPnlPercent: number } | null {
  try {
    const eq = enrichment.equityAgg.get(bot.id);
    const netDeposited = eq?.netDeposited ?? 0;
    const totalDeposits = eq?.totalDeposits ?? 0;

    const positions = enrichment.positions.get(bot.id) ?? [];
    const position = (positions as any[]).find((p: any) => p.market === bot.market)
      ?? positions[0]
      ?? null;

    const realizedPnl = parseFloat((position as any)?.realizedPnl || '0');
    const totalFees = parseFloat((position as any)?.totalFees || '0');

    let unrealizedPnl = 0;
    if (position) {
      const baseSize = parseFloat((position as any).baseSize ?? '0');
      const entryPrice = parseFloat((position as any).avgEntryPrice ?? '0');
      const markPrice = prices[(position as any).market] || entryPrice;
      if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
        unrealizedPnl = baseSize > 0
          ? (markPrice - entryPrice) * Math.abs(baseSize)
          : (entryPrice - markPrice) * Math.abs(baseSize);
      }
    }

    const exchangeBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
    const netPnl = exchangeBalance - netDeposited;
    const netPnlPercent = totalDeposits > 0 ? (netPnl / totalDeposits) * 100 : 0;
    return { exchangeBalance, netPnl, netPnlPercent };
  } catch {
    return null;
  }
}

function _fallbackFinancials(
  bot: TradingBot,
  enrichment: BotListEnrichment,
  prices: Record<string, number>,
): BotFinancialData {
  const borrowDebtUsdc = enrichment.borrowDebts.get(bot.id) ?? 0;
  const fallback = _dbFallback(bot, enrichment, prices);
  return {
    exchangeBalance: fallback?.exchangeBalance ?? null,
    netPnl: fallback?.netPnl ?? null,
    netPnlPercent: fallback?.netPnlPercent ?? null,
    borrowDebtUsdc,
    parkedValueUsdc: 0,
    parkedValueIncluded: false,
    parkedValueUnavailable: false,
    liveDataAvailable: false,
  };
}

// ---------------------------------------------------------------------------
// Snapshot refresh
// ---------------------------------------------------------------------------

async function _refresh(
  entry: CacheEntry,
  walletAddress: string,
  deps: SnapshotDeps,
): Promise<SnapshotData> {
  const deadlineAt = Date.now() + VENUE_DEADLINE_MS;

  // -------------------------------------------------------------------------
  // Phase 1: DB (no deadline, no pool — always completes or throws)
  // -------------------------------------------------------------------------
  const [bots, wallet, parkedHintRows] = await Promise.all([
    storage.getTradingBots(walletAddress),
    storage.getWallet(walletAddress),
    storage.getVaultPositionsAllScopes(walletAddress).catch(() => [] as any[]),
  ]);

  const enrichment = await storage.getTradingBotListEnrichment(
    walletAddress,
    bots.map(b => b.id),
  );

  const parkedBotIds = new Set<string>();
  for (const r of parkedHintRows) {
    const id = (r as any).tradingBotId;
    if (id) parkedBotIds.add(id);
  }

  const botMarkets = [...new Set(bots.map((b: any) => b.market as string))];
  const { prices, pricesAsOf, pricesStale } = deps.getCachedPricesMeta(botMarkets);

  // -------------------------------------------------------------------------
  // Phase 2: Venue enrichment — pool (capacity 2) + 10-second deadline
  // -------------------------------------------------------------------------
  const pool = entry.pool;
  const agentAddress: string | null = (wallet as any)?.agentPublicKey ?? null;

  let agentBalance = 0;
  let solBalance = 0;
  let mainAccount: { totalCollateral: number; freeCollateral: number } | null = null;
  let vaultBalance = 0;
  const perBotFinancials = new Map<string, BotFinancialData>();

  /**
   * Run a single venue work item. Acquires a pool slot (waits if full but
   * deadline permits), executes fn, and writes results through the fn closure.
   * Returns true if fn ran (slot acquired + completed/errored before deadline),
   * false if the deadline expired or no slot was ever available.
   * IMPORTANT: the pool slot is released ONLY when fn's underlying promise
   * settles — never when the deadline fires.
   */
  async function runWithPool(fn: () => Promise<void>): Promise<boolean> {
    let remaining = deadlineAt - Date.now();
    if (remaining <= 0) return false;

    // If pool full, wait for one slot to open (bounded by deadline).
    if (pool.available === 0) {
      const slotOrDeadline = await _raceDeadline(pool.waitForSlot(), remaining);
      if (slotOrDeadline === DEADLINE_SENTINEL) return false;
      remaining = deadlineAt - Date.now();
      if (remaining <= 0) return false;
    }

    const underlying = pool.tryRun(fn);
    if (underlying === null) return false; // still no slot (race condition)

    const result = await _raceDeadline(
      underlying.then(() => true as const).catch(() => false as const),
      remaining,
    );
    if (result === DEADLINE_SENTINEL) return false;
    return result;
  }

  // --- Main account enrichment (1 pool slot) ---
  if (agentAddress) {
    await runWithPool(async () => {
      const [ab, sb, info, vb] = await Promise.all([
        deps.getAgentUsdcBalance(agentAddress),
        deps.getAgentSolBalance(agentAddress),
        deps.getExchangeAccountInfo(agentAddress, 0),
        deps.accountVaultRoutableValueUsdc(walletAddress, agentAddress),
      ]);
      agentBalance = ab;
      solBalance = sb;
      mainAccount = {
        totalCollateral: (info as any).totalCollateral ?? 0,
        freeCollateral: (info as any).freeCollateral ?? 0,
      };
      vaultBalance = vb;
    });
  }

  // --- Per-bot venue enrichment (1 pool slot each, pipelined) ---
  for (const bot of bots) {
    if (Date.now() >= deadlineAt) break;

    const botCtx = deps.getBotSubaccountContext(bot);
    const botAdapter = deps.getAdapterForBot(bot);
    const eq = enrichment.equityAgg.get(bot.id);
    const netDeposited = eq?.netDeposited ?? 0;
    const totalDeposits = eq?.totalDeposits ?? 0;
    const borrowDebtUsdc = enrichment.borrowDebts.get(bot.id) ?? 0;

    // Flash double-count: bot wallet IS the agent wallet → already in agentBalance.
    const isFlashAgentAlias =
      (bot as any).activeProtocol === 'flash' &&
      agentAddress &&
      (bot as any).protocolSubaccountId === agentAddress;

    if (isFlashAgentAlias) {
      perBotFinancials.set(bot.id, {
        exchangeBalance: 0,
        netPnl: -netDeposited,
        netPnlPercent: totalDeposits > 0 ? (-netDeposited / totalDeposits) * 100 : 0,
        borrowDebtUsdc,
        parkedValueUsdc: 0,
        parkedValueIncluded: false,
        parkedValueUnavailable: false,
        liveDataAvailable: false,
      });
      continue;
    }

    if (!botCtx || !agentAddress) {
      perBotFinancials.set(bot.id, _fallbackFinancials(bot, enrichment, prices));
      continue;
    }

    const launched = await runWithPool(async () => {
      const liveInfo = await deps.getExchangeAccountInfoForBot(
        agentAddress, 0, botCtx, botAdapter,
      );
      const adj = await deps.addParkedValueForBotDisplayEquity(
        bot, botAdapter, (liveInfo as any).totalCollateral,
        { hasVaultRows: parkedBotIds.has(bot.id) },
      );
      const botBalance = (adj as any).equityUsdc - borrowDebtUsdc;
      const netPnl = botBalance - netDeposited;
      perBotFinancials.set(bot.id, {
        exchangeBalance: botBalance,
        netPnl,
        netPnlPercent: totalDeposits > 0 ? (netPnl / totalDeposits) * 100 : 0,
        borrowDebtUsdc,
        parkedValueUsdc: (adj as any).parkedValueUsdc ?? 0,
        parkedValueIncluded: (adj as any).parkedValueIncluded ?? false,
        parkedValueUnavailable: (adj as any).parkedValueUnavailable ?? false,
        liveDataAvailable: true,
      });
    });

    if (!launched && !perBotFinancials.has(bot.id)) {
      perBotFinancials.set(bot.id, _fallbackFinancials(bot, enrichment, prices));
    }
  }

  // Ensure every bot has a financial data entry (defensive fill).
  for (const bot of bots) {
    if (!perBotFinancials.has(bot.id)) {
      perBotFinancials.set(bot.id, _fallbackFinancials(bot, enrichment, prices));
    }
  }

  return {
    bots,
    wallet,
    enrichment,
    perBotFinancials,
    mainAccount,
    agentBalance,
    solBalance,
    vaultBalance,
    prices,
    pricesAsOf,
    pricesStale,
    observedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Empty enrichment (for unavailable snapshots)
// ---------------------------------------------------------------------------

function _emptyEnrichment(): BotListEnrichment {
  return {
    tradeCounts: new Map(),
    positions: new Map(),
    publishedBotMap: new Map(),
    equityAgg: new Map(),
    borrowDebts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current financial snapshot for a wallet.
 *
 * Status semantics:
 *   'fresh':       Computed within the last 5 s; use as-is.
 *   'stale':       Refresh failed; returning last-known-good (≤ 60 s old).
 *   'unavailable': No viable snapshot (no prior success, or prior expired).
 */
export async function getWalletFinancialSnapshot(
  walletAddress: string,
): Promise<WalletFinancialSnapshot> {
  if (!_deps) throw new Error('[bot-financial-snapshot] Not initialized — call initSnapshotModule().');
  const deps = _deps;

  const entry = _getOrCreate(walletAddress);
  if (entry === null) {
    // Cache at capacity with all entries in-flight.
    return _unavailable();
  }

  const now = Date.now();

  // Fresh cache hit.
  if (entry.lastSuccess && now - entry.lastSuccess.observedAt < FRESH_TTL_MS) {
    return _wrap(entry.lastSuccess, 'fresh');
  }

  // Join existing in-flight refresh.
  if (entry.inFlight !== null) {
    return entry.inFlight.then(
      data => _wrap(data, 'fresh'),
      () => _fallbackToStale(entry, now),
    );
  }

  // Start a new refresh.
  const inFlight = _refresh(entry, walletAddress, deps);
  entry.inFlight = inFlight;

  inFlight.then(
    (data) => {
      entry.lastSuccess = data;
      entry.inFlight = null;
      entry.lruTimestamp = Date.now();
    },
    () => { entry.inFlight = null; },
  );

  return inFlight.then(
    data => _wrap(data, 'fresh'),
    () => _fallbackToStale(entry, now),
  );
}

function _fallbackToStale(entry: CacheEntry, requestedAt: number): WalletFinancialSnapshot {
  if (entry.lastSuccess && requestedAt - entry.lastSuccess.observedAt < STALE_WINDOW_MS) {
    return _wrap(entry.lastSuccess, 'stale');
  }
  return _unavailable();
}

function _wrap(data: SnapshotData, status: FinancialStatus): WalletFinancialSnapshot {
  return {
    status,
    observedAt: data.observedAt,
    bots: data.bots,
    wallet: data.wallet,
    enrichment: data.enrichment,
    perBotFinancials: data.perBotFinancials,
    mainAccount: data.mainAccount,
    agentBalance: data.agentBalance,
    solBalance: data.solBalance,
    vaultBalance: data.vaultBalance,
    prices: data.prices,
    pricesAsOf: data.pricesAsOf,
    pricesStale: data.pricesStale,
  };
}

function _unavailable(): WalletFinancialSnapshot {
  return {
    status: 'unavailable',
    observedAt: null,
    bots: [],
    wallet: undefined,
    enrichment: _emptyEnrichment(),
    perBotFinancials: new Map(),
    mainAccount: null,
    agentBalance: 0,
    solBalance: 0,
    vaultBalance: 0,
    prices: {},
    pricesAsOf: null,
    pricesStale: true,
  };
}

// ---------------------------------------------------------------------------
// Test-only helpers — no-op in production (NODE_ENV !== 'test')
// ---------------------------------------------------------------------------

/** Reset all module state for test isolation. No-op outside NODE_ENV=test. */
export function _resetForTest(): void {
  if (process.env.NODE_ENV !== 'test') return;
  _cache.clear();
  _deps = null;
}

/** Cache entry count. Returns -1 outside NODE_ENV=test. */
export function _cacheSize(): number {
  if (process.env.NODE_ENV !== 'test') return -1;
  return _cache.size;
}

/** Pool active count for a wallet. Returns -1 outside NODE_ENV=test. */
export function _poolActive(walletAddress: string): number {
  if (process.env.NODE_ENV !== 'test') return -1;
  return _cache.get(walletAddress)?.pool.active ?? 0;
}
