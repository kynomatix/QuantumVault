/**
 * WO-15B / WO-15B.1: Per-wallet financial snapshot module.
 *
 * Provides a shared, cached, deadline-bounded per-wallet enrichment layer for
 * both GET /api/trading-bots and GET /api/total-equity. Replaces the previous
 * N-bot per-bot DB fan-out and uncapped venue concurrency with:
 *
 *   - One getTradingBotListEnrichment call per refresh (batch DB, no per-bot).
 *   - True two-operation concurrency: each external venue/RPC call occupies
 *     exactly one pool slot; at most two operations are active simultaneously.
 *   - Per-bot enrichment is pipelined: independent bots run concurrently (each
 *     pair of ops sequential within a bot; different bots overlap).
 *   - 10-second wall-clock deadline over all venue work AND Phase-1 DB reads.
 *   - Caller envelope: each caller waits at most CALLER_DEADLINE_MS regardless
 *     of how long the underlying in-flight promise runs; the underlying stays
 *     tracked (no-stampede invariant).
 *   - Slots released only on underlying settlement, never on the caller deadline.
 *   - Snapshots are immutable once returned: no closure can mutate a published
 *     snapshot's maps or values after _refresh returns.
 *   - Enrichment failure is non-fatal: the bot list is preserved.
 *   - LRU cache, max 100 wallet entries; in-flight entries are never evicted.
 *   - Stale-on-failure: last successful snapshot survives 60 s after observedAt,
 *     evaluated at actual response time (not pre-await).
 *   - status:'unavailable' is truthfully propagated; routes return 503.
 *   - status:'partial' when the bot list is good but main-account venue data
 *     is fully unavailable; total-equity aggregates are null, not zero.
 */

import { storage } from './storage';
import type { BotListEnrichment } from './storage';
import type { TradingBot } from '../shared/schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FinancialStatus = 'fresh' | 'stale' | 'partial' | 'unavailable';

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
  /** True when getTradingBots() succeeded. False only on unavailable (→ 503). */
  botsReadSucceeded: boolean;
  bots: TradingBot[];
  wallet: Awaited<ReturnType<typeof storage.getWallet>>;
  enrichment: BotListEnrichment;
  perBotFinancials: Map<string, BotFinancialData>;
  /** Main-account exchange equity/collateral. null if venue unavailable. */
  mainAccount: { totalCollateral: number; freeCollateral: number } | null;
  /** null when venue call failed or timed out. */
  agentBalance: number | null;
  /** null when venue call failed or timed out. */
  solBalance: number | null;
  /** Account-scope Vault yield value. Route applies ?includeVault filter. */
  vaultBalance: number | null;
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
 * of stuck underlying calls.
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
   * Returns the underlying promise, or null if the pool is at capacity.
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
/** Each caller's maximum wait regardless of underlying inFlight duration. */
const CALLER_DEADLINE_MS = 10_000;
const MAX_WALLET_ENTRIES = 100;
const DEADLINE_SENTINEL: unique symbol = Symbol('deadline');

type SnapshotData = {
  bots: TradingBot[];
  wallet: Awaited<ReturnType<typeof storage.getWallet>>;
  enrichment: BotListEnrichment;
  /** Immutable after _refresh returns: wrappers write before they exit. */
  perBotFinancials: Map<string, BotFinancialData>;
  mainAccount: { totalCollateral: number; freeCollateral: number } | null;
  agentBalance: number | null;
  solBalance: number | null;
  vaultBalance: number | null;
  prices: Record<string, number>;
  pricesAsOf: number | null;
  pricesStale: boolean;
  observedAt: number;
  /** 'partial' when bot list succeeded but all main-account venue calls failed. */
  snapshotStatus: 'fresh' | 'partial';
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
// Small utilities
// ---------------------------------------------------------------------------

/** Promise that resolves after `ms` milliseconds (setTimeout-based → fake-timer compatible). */
function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Race `p` against a deadline. Clears the timer if `p` settles first.
 * DOES NOT release pool slots — that is BoundedPool's responsibility.
 */
function _raceDeadline<T>(
  p: Promise<T>,
  remainingMs: number,
): Promise<T | typeof DEADLINE_SENTINEL> {
  if (remainingMs <= 0) return Promise.resolve(DEADLINE_SENTINEL);
  let timer!: ReturnType<typeof setTimeout>;
  const deadlineP = new Promise<typeof DEADLINE_SENTINEL>(resolve => {
    timer = setTimeout(() => resolve(DEADLINE_SENTINEL), remainingMs);
  });
  // Clear the timer whenever p settles (resolve or reject) so no timer accumulates.
  p.then(() => clearTimeout(timer), () => clearTimeout(timer));
  return Promise.race([p, deadlineP]);
}

/**
 * Acquire a BoundedPool slot and run fn(), bounded by deadlineAt.
 *
 * Returns true  if fn ran and settled before the deadline.
 * Returns false if the deadline fired before a slot was obtained OR before
 *               fn settled (fn's underlying op may still be running —
 *               it holds its slot until it settles naturally).
 *
 * The slot is ALWAYS released when fn's underlying promise settles regardless
 * of whether _waitAndRun already returned false due to the deadline.
 */
async function _waitAndRun(
  pool: BoundedPool,
  deadlineAt: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  // Retry loop handles the rare race where waitForSlot resolves but another
  // concurrent wrapper steals the slot before tryRun.
  while (true) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return false;

    if (pool.available > 0) {
      const p = pool.tryRun(fn);
      if (p !== null) {
        const r = await _raceDeadline(
          p.then(() => true as const).catch(() => false as const),
          deadlineAt - Date.now(),
        );
        return r !== DEADLINE_SENTINEL ? r : false;
      }
      // tryRun returned null (slot stolen in a race) — loop back immediately.
      continue;
    }

    // Pool full — wait for a slot to open.
    const slotOrDeadline = await _raceDeadline(pool.waitForSlot(), remaining);
    if (slotOrDeadline === DEADLINE_SENTINEL) return false;
    // A slot opened. Loop back to tryRun.
  }
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
    if (victim === null) return null; // all 100 entries are in-flight — fail closed
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
// DB-based fallback balance (no venue calls needed)
// ---------------------------------------------------------------------------

function _dbFallback(
  bot: TradingBot,
  enrichment: BotListEnrichment,
  prices: Record<string, number>,
): { exchangeBalance: number; netPnl: number; netPnlPercent: number } | null {
  try {
    const eq = enrichment.equityAgg.get(bot.id);
    // No enrichment data → cannot produce a meaningful estimate.
    if (!eq) return null;
    const netDeposited = eq.netDeposited ?? 0;
    const totalDeposits = eq.totalDeposits ?? 0;

    // Exact-market lookup only — never fall back to another market's position.
    const positions = enrichment.positions.get(bot.id) ?? [];
    const position = (positions as any[]).find((p: any) => p.market === bot.market) ?? null;

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
  // Phase 1a: Bot list + wallet (authoritative — throws on failure/timeout)
  // -------------------------------------------------------------------------
  const phase1Remaining = deadlineAt - Date.now();
  const phase1Result = await _raceDeadline(
    Promise.all([
      storage.getTradingBots(walletAddress),
      storage.getWallet(walletAddress),
      storage.getVaultPositionsAllScopes(walletAddress).catch(() => [] as any[]),
    ]),
    phase1Remaining,
  );
  if (phase1Result === DEADLINE_SENTINEL) {
    throw new Error('[bot-financial-snapshot] Phase-1 DB deadline exceeded');
  }
  const [bots, wallet, parkedHintRows] = phase1Result;

  // -------------------------------------------------------------------------
  // Phase 1b: Batch enrichment (best-effort — non-fatal)
  // -------------------------------------------------------------------------
  let enrichment: BotListEnrichment;
  try {
    const enrichRemaining = deadlineAt - Date.now();
    const er = await _raceDeadline(
      storage.getTradingBotListEnrichment(walletAddress, bots.map((b: any) => b.id)),
      enrichRemaining,
    );
    enrichment = er === DEADLINE_SENTINEL ? _emptyEnrichment() : er;
  } catch {
    enrichment = _emptyEnrichment();
  }

  const parkedBotIds = new Set<string>();
  for (const r of parkedHintRows as any[]) {
    const id = (r as any).tradingBotId;
    if (id) parkedBotIds.add(id);
  }

  const botMarkets = [...new Set(bots.map((b: any) => b.market as string))];
  const { prices, pricesAsOf, pricesStale } = deps.getCachedPricesMeta(botMarkets);

  // -------------------------------------------------------------------------
  // Phase 2: Venue enrichment
  //
  // Architecture: each external call is exactly ONE pool slot. Main-account
  // has four independent ops; per-bot has two sequential ops (but different
  // bots overlap). All wrapper promises are launched concurrently and compete
  // for the shared two-slot pool. Wrappers are responsible for writing results
  // before returning — no closure mutates state after _refresh returns.
  // -------------------------------------------------------------------------
  const pool = entry.pool;
  const agentAddress: string | null = (wallet as any)?.agentPublicKey ?? null;

  // Mutable locals; wrappers write here before returning.
  let agentBalance: number | null = null;
  let solBalance: number | null = null;
  let mainAccount: { totalCollateral: number; freeCollateral: number } | null = null;
  let vaultBalance: number | null = null;
  const perBotFinancials = new Map<string, BotFinancialData>();

  const wrappers: Promise<void>[] = [];

  // --- Main-account: four independent ops (one slot each) ---
  if (agentAddress) {
    wrappers.push((async () => {
      await _waitAndRun(pool, deadlineAt, async () => {
        agentBalance = await deps.getAgentUsdcBalance(agentAddress!);
      });
    })());

    wrappers.push((async () => {
      await _waitAndRun(pool, deadlineAt, async () => {
        solBalance = await deps.getAgentSolBalance(agentAddress!);
      });
    })());

    wrappers.push((async () => {
      await _waitAndRun(pool, deadlineAt, async () => {
        const info = await deps.getExchangeAccountInfo(agentAddress!, 0);
        mainAccount = {
          totalCollateral: (info as any).totalCollateral ?? 0,
          freeCollateral: (info as any).freeCollateral ?? 0,
        };
      });
    })());

    wrappers.push((async () => {
      await _waitAndRun(pool, deadlineAt, async () => {
        vaultBalance = await deps.accountVaultRoutableValueUsdc(walletAddress, agentAddress!);
      });
    })());
  }

  // --- Per-bot: two sequential ops within a bot; bots are concurrent ---
  for (const bot of bots) {
    const botId = bot.id;
    const eq = enrichment.equityAgg.get(botId);
    const netDeposited = eq?.netDeposited ?? 0;
    const totalDeposits = eq?.totalDeposits ?? 0;
    const borrowDebtUsdc = enrichment.borrowDebts.get(botId) ?? 0;

    // Flash double-count: bot wallet IS the agent wallet — skip live call.
    const isFlashAgentAlias =
      (bot as any).activeProtocol === 'flash' &&
      agentAddress !== null &&
      (bot as any).protocolSubaccountId === agentAddress;

    if (isFlashAgentAlias) {
      perBotFinancials.set(botId, {
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

    // Bots with no live context get DB-based fallback immediately (no pool slot).
    const botCtx = deps.getBotSubaccountContext(bot);
    if (!botCtx || !agentAddress) {
      perBotFinancials.set(botId, _fallbackFinancials(bot, enrichment, prices));
      continue;
    }

    // Resolve adapter ONLY after confirming we need the live path.
    let botAdapter: unknown;
    try {
      botAdapter = deps.getAdapterForBot(bot);
    } catch {
      perBotFinancials.set(botId, _fallbackFinancials(bot, enrichment, prices));
      continue;
    }

    // Pipeline within this bot: Op1 → Op2 sequential; but this wrapper runs
    // concurrently with all other bot wrappers and main-account wrappers.
    wrappers.push((async () => {
      // Op 1: exchange account info (1 pool slot)
      let liveInfo: any = null;
      const op1ok = await _waitAndRun(pool, deadlineAt, async () => {
        liveInfo = await deps.getExchangeAccountInfoForBot(
          agentAddress!, 0, botCtx, botAdapter,
        );
      });

      if (!op1ok || !liveInfo) {
        // Deadline fired or live call failed — use DB fallback.
        perBotFinancials.set(botId, _fallbackFinancials(bot, enrichment, prices));
        return;
      }

      // Op 2: parked vault value (1 pool slot, best-effort)
      let adj: any = null;
      await _waitAndRun(pool, deadlineAt, async () => {
        adj = await deps.addParkedValueForBotDisplayEquity(
          bot, botAdapter, (liveInfo as any).totalCollateral,
          { hasVaultRows: parkedBotIds.has(botId) },
        );
      });

      // adj may be null if Op2 timed out — fall back to raw collateral.
      const equityBase: number = adj?.equityUsdc ?? (liveInfo as any).totalCollateral;
      const botBalance = equityBase - borrowDebtUsdc;
      const netPnl = botBalance - netDeposited;
      perBotFinancials.set(botId, {
        exchangeBalance: botBalance,
        netPnl,
        netPnlPercent: totalDeposits > 0 ? (netPnl / totalDeposits) * 100 : 0,
        borrowDebtUsdc,
        parkedValueUsdc: adj?.parkedValueUsdc ?? 0,
        parkedValueIncluded: adj?.parkedValueIncluded ?? false,
        parkedValueUnavailable: adj?.parkedValueUnavailable ?? (adj === null),
        liveDataAvailable: true,
      });
    })());
  }

  // Run all wrappers concurrently — they share the two-slot pool.
  // Each wrapper exits at or shortly after deadlineAt; no wrapper runs forever.
  await Promise.all(wrappers);

  // Defensive fill: any bot not written by a wrapper gets DB fallback.
  for (const bot of bots) {
    if (!perBotFinancials.has(bot.id)) {
      perBotFinancials.set(bot.id, _fallbackFinancials(bot, enrichment, prices));
    }
  }

  // Determine snapshot quality. 'partial' when all main-account venue calls
  // failed despite an agent address being present.
  const hasAnyMainAccountData =
    agentBalance !== null || solBalance !== null ||
    mainAccount !== null || vaultBalance !== null;
  const snapshotStatus: 'fresh' | 'partial' =
    (agentAddress && !hasAnyMainAccountData) ? 'partial' : 'fresh';

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
    snapshotStatus,
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
 *   'fresh':       Computed within the last 5 s; all bot-list data is current.
 *   'partial':     Fresh bot list but all main-account venue calls failed.
 *   'stale':       Refresh failed; returning last-known-good (≤ 60 s old at
 *                  actual response time).
 *   'unavailable': No viable snapshot. Routes MUST return HTTP 503.
 *
 * The caller envelope is CALLER_DEADLINE_MS (10 s). A never-settling Phase-1
 * DB promise will not block either route beyond that window. The underlying
 * inFlight promise continues to run and is tracked in the cache entry so no
 * replacement refresh is started (no-stampede invariant).
 */
export async function getWalletFinancialSnapshot(
  walletAddress: string,
): Promise<WalletFinancialSnapshot> {
  if (!_deps) throw new Error('[bot-financial-snapshot] Not initialized — call initSnapshotModule().');
  const deps = _deps;

  const entry = _getOrCreate(walletAddress);
  if (entry === null) {
    // Cache at capacity with all entries in-flight — fail closed.
    return _unavailable();
  }

  const now = Date.now();

  // Fresh cache hit.
  if (entry.lastSuccess && now - entry.lastSuccess.observedAt < FRESH_TTL_MS) {
    return _wrap(entry.lastSuccess);
  }

  // Helper: race the result promise against the caller deadline and fall back.
  const awaitWithCallerDeadline = async (
    p: Promise<SnapshotData>,
  ): Promise<WalletFinancialSnapshot> => {
    const outcome = await Promise.race([
      p.then(data => ({ type: 'ok' as const, data }))
       .catch(() => ({ type: 'err' as const })),
      _sleep(CALLER_DEADLINE_MS).then(() => ({ type: 'timeout' as const })),
    ]);
    if (outcome.type === 'ok') return _wrap(outcome.data);
    // Use Date.now() at actual response time for the 60-second stale window.
    return _fallbackToStale(entry, Date.now());
  };

  // Join existing in-flight refresh.
  if (entry.inFlight !== null) {
    return awaitWithCallerDeadline(entry.inFlight);
  }

  // Start a new refresh.
  const inFlight = _refresh(entry, walletAddress, deps);
  entry.inFlight = inFlight;

  // Hook: update cache when the underlying settles (regardless of caller deadline).
  inFlight.then(
    (data) => {
      entry.lastSuccess = data;
      entry.inFlight = null;
      entry.lruTimestamp = Date.now();
    },
    () => { entry.inFlight = null; },
  );

  return awaitWithCallerDeadline(inFlight);
}

function _fallbackToStale(entry: CacheEntry, responseAt: number): WalletFinancialSnapshot {
  // responseAt is Date.now() at the moment the caller receives the response —
  // not a pre-await timestamp — so data older than STALE_WINDOW_MS at response
  // time is never labeled stale.
  if (entry.lastSuccess && responseAt - entry.lastSuccess.observedAt < STALE_WINDOW_MS) {
    return _wrap(entry.lastSuccess, 'stale');
  }
  return _unavailable();
}

function _wrap(data: SnapshotData, statusOverride?: 'stale'): WalletFinancialSnapshot {
  return {
    status: statusOverride ?? data.snapshotStatus,
    observedAt: data.observedAt,
    botsReadSucceeded: true,
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
    botsReadSucceeded: false,
    bots: [],
    wallet: undefined,
    enrichment: _emptyEnrichment(),
    perBotFinancials: new Map(),
    mainAccount: null,
    agentBalance: null,
    solBalance: null,
    vaultBalance: null,
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
