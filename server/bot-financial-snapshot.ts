/**
 * WO-15B / WO-15B.1 / WO-15B.2: Per-wallet financial snapshot module.
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
 *     tracked (no-stampede invariant). The caller-envelope timer is cleared
 *     immediately when the underlying settles early (no lingering timers).
 *   - Slots released only on underlying settlement, never on the caller deadline.
 *   - Stale waiters cancelled on deadline; they do not consume future wake-ups.
 *   - Snapshots are immutable once returned: no closure can mutate a published
 *     snapshot's maps or values after _refresh returns.
 *   - LRU cache, max 100 wallet entries; in-flight entries are never evicted.
 *   - Stale-on-failure: last successful snapshot survives 60 s after observedAt,
 *     evaluated at actual response time (not pre-await).
 *   - Only a fully-fresh (snapshotStatus === 'fresh') snapshot replaces the
 *     last-known-good used for stale fallback. Partial results do not overwrite.
 *   - status:'unavailable' is truthfully propagated; routes return 503.
 *   - status:'partial' when ANY required main-account component is null, or when
 *     enrichment or parked-hint reads failed. Batch-derived fields are null (not
 *     zero) when enrichment is unavailable; deposit basis unknown → no PnL.
 *   - Parked-hint failure is tracked separately from successful empty results;
 *     snapshot is marked partial, not silently clean.
 *   - Per-bot financialStatus distinguishes 'live', 'db-only', and 'unavailable'.
 *   - Failed live venue reads are null/unavailable, never DB estimates as current.
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
  /**
   * Per-bot account info via venue adapter.
   * STRICT: must throw on RPC/adapter failure (no internal catch).
   * Successful zero balance is a valid result and must NOT throw.
   */
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
  /**
   * Main-account exchange info (account-model subaccount 0).
   * STRICT: must throw on RPC/adapter failure (no internal catch).
   */
  getExchangeAccountInfo(
    walletAddress: string,
    subAccountId?: number,
  ): Promise<{
    totalCollateral: number;
    freeCollateral: number;
    usdcBalance?: number;
  }>;
  /**
   * STRICT: must throw on RPC failure (no internal catch).
   * Successful zero (e.g. ATA not yet initialized) is a valid result.
   */
  getAgentUsdcBalance(agentAddress: string): Promise<number>;
  /**
   * STRICT: must throw on RPC failure (no internal catch).
   * Successful zero is a valid result.
   */
  getAgentSolBalance(agentAddress: string): Promise<number>;
  /**
   * Account-scope Vault yield value (routable on demand).
   * STRICT: must throw on failure (no internal catch).
   */
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
  /** netPnl = exchangeBalance – netDeposited. null when exchangeBalance or deposit basis unknown. */
  netPnl: number | null;
  /** Percent relative to totalDeposits. null when exchangeBalance or deposit basis unknown. */
  netPnlPercent: number | null;
  /**
   * Open USDC borrow debt (from batch enrichment).
   * null when enrichment failed (debt unknown — not zero).
   */
  borrowDebtUsdc: number | null;
  /** USD value of tokens parked in Vault (Flash per-bot only). 0 if unavailable. */
  parkedValueUsdc: number;
  parkedValueIncluded: boolean;
  parkedValueUnavailable: boolean;
  /** True when exchangeBalance came from a live venue call (not DB fallback). */
  liveDataAvailable: boolean;
  /**
   * Per-bot read status:
   *   'live'        — live venue data successfully retrieved.
   *   'db-only'     — intentional DB-only path (Flash alias, no live context).
   *   'unavailable' — live was attempted but timed out or failed.
   */
  botFinancialStatus: 'live' | 'db-only' | 'unavailable';
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
  /**
   * True when batch enrichment succeeded. False means tradeCounts, positions,
   * publishedBotMap, equityAgg, borrowDebts are empty/unknown — routes must
   * not substitute zero for those fields.
   */
  enrichmentSucceeded: boolean;
  /**
   * True when the parked-position hint DB read succeeded.
   * False means we don't know which bots have parked rows; snapshot is partial.
   */
  parkedHintSucceeded: boolean;
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
 *
 * waitForSlotCancellable() returns a { promise, cancel } pair so that callers
 * whose deadline fires can unregister their waiter immediately, preventing
 * stale waiters from consuming future slot wake-ups.
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
  /** Number of pending waiters (for testing). */
  get waiterCount(): number { return this._waiters.length; }

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

  /**
   * Returns a cancellable slot-wait: { promise, cancel }.
   *
   * If the caller's deadline fires before the slot opens, call cancel() to
   * remove the waiter from the queue so it does not consume the next wake-up.
   * Resolves immediately (cancel is a no-op) when a slot is already available.
   */
  waitForSlotCancellable(): { promise: Promise<void>; cancel: () => void } {
    if (this._active < this.capacity) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
      resolve = r;
      this._waiters.push(resolve);
    });
    return {
      promise,
      cancel: () => {
        const idx = this._waiters.indexOf(resolve);
        if (idx >= 0) this._waiters.splice(idx, 1);
      },
    };
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
  enrichmentSucceeded: boolean;
  parkedHintSucceeded: boolean;
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
  /**
   * 'partial' when ANY required main-account component is null, or when
   * enrichment or parked-hint reads failed. Only 'fresh' snapshots may
   * replace lastSuccess used for stale fallback.
   */
  snapshotStatus: 'fresh' | 'partial';
};

type CacheEntry = {
  walletAddress: string;
  /** Only updated by a snapshotStatus==='fresh' result. */
  lastSuccess: SnapshotData | null;
  /**
   * Last partial result. Cached for FRESH_TTL_MS so repeated callers within 5 s
   * reuse it instead of re-running DB/RPC work. Does NOT update lastSuccess (the
   * stale-fallback anchor). Cleared when a fresh result arrives.
   */
  lastPartial: SnapshotData | null;
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
  // Clear the timer whenever p settles (resolve or reject) so no timer lingers.
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
 * Timed-out waiters are cancelled immediately so they do not consume future
 * slot wake-ups and do not starve subsequent refreshes.
 *
 * The slot is ALWAYS released when fn's underlying promise settles regardless
 * of whether _waitAndRun already returned false due to the deadline.
 */
async function _waitAndRun(
  pool: BoundedPool,
  deadlineAt: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  // Retry loop handles the rare race where a cancellable wait resolves but
  // another concurrent wrapper steals the slot before tryRun.
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

    // Pool full — use cancellable wait so timed-out waiters are removed.
    const remaining2 = deadlineAt - Date.now();
    const { promise: slotP, cancel: cancelWaiter } = pool.waitForSlotCancellable();
    const slotOrDeadline = await _raceDeadline(slotP, remaining2);
    if (slotOrDeadline === DEADLINE_SENTINEL) {
      cancelWaiter(); // remove stale waiter from the queue immediately
      return false;
    }
    // A slot opened — loop back to tryRun.
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
    lastPartial: null,
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

/**
 * DB-only financial fallback for bots that either have no live context or
 * whose live call failed. When enrichmentSucceeded is false, deposit basis
 * is unknown and all batch-derived fields are null.
 */
function _fallbackFinancials(
  bot: TradingBot,
  enrichment: BotListEnrichment,
  prices: Record<string, number>,
  enrichmentSucceeded: boolean,
  parkedHintSucceeded: boolean,
  parkedBotIds: Set<string>,
  status: 'db-only' | 'unavailable',
): BotFinancialData {
  if (!enrichmentSucceeded) {
    return {
      exchangeBalance: null,
      netPnl: null,
      netPnlPercent: null,
      borrowDebtUsdc: null,
      parkedValueUsdc: 0,
      parkedValueIncluded: false,
      parkedValueUnavailable: false,
      liveDataAvailable: false,
      botFinancialStatus: status,
    };
  }
  const borrowDebtUsdc = enrichment.borrowDebts.get(bot.id) ?? 0;

  // A bot marked 'unavailable' must never emit a numeric DB estimate as equity,
  // even when enrichment data is present. The DB estimate is only safe when the
  // DB path was intentional ('db-only'). Live-eligible bots skipped by the
  // deadline, adapter-resolution failures, and any other unavailable path all
  // belong here — they tried (or were eligible to try) the live path and failed.
  if (status === 'unavailable') {
    return {
      exchangeBalance: null,
      netPnl: null,
      netPnlPercent: null,
      borrowDebtUsdc,
      parkedValueUsdc: 0,
      parkedValueIncluded: false,
      parkedValueUnavailable: false,
      liveDataAvailable: false,
      botFinancialStatus: 'unavailable',
    };
  }

  const fallback = _dbFallback(bot, enrichment, prices);

  // DB-only Flash bots can have parked funds in the vault. The DB fallback
  // cannot value parked yield-tokens, so the estimate is incomplete whenever:
  //   (a) the parked-hint read failed (parkedHintSucceeded=false) — we cannot
  //       confirm whether parked rows exist for this bot; OR
  //   (b) the hint succeeded BUT positively identified a row for this bot —
  //       the DB fallback has no way to value the parked asset/yield.
  // Non-Flash protocols do not support vault parking, so they are unaffected.
  const botIsParkedCapable = (bot as any).activeProtocol === 'flash';
  const parkedUnavailable = botIsParkedCapable &&
    (!parkedHintSucceeded || parkedBotIds.has(bot.id));

  if (parkedUnavailable) {
    return {
      exchangeBalance: null,
      netPnl: null,
      netPnlPercent: null,
      borrowDebtUsdc,
      parkedValueUsdc: 0,
      parkedValueIncluded: false,
      parkedValueUnavailable: true,
      liveDataAvailable: false,
      botFinancialStatus: 'unavailable',
    };
  }

  // status='db-only', enrichmentSucceeded=true, parked hint ok (or non-Flash).
  // A bot with no equityAgg row is a new bot with zero history — legitimately 0.
  // Null applies only when enrichment itself failed (handled above).
  return {
    exchangeBalance: fallback?.exchangeBalance ?? 0,
    netPnl: fallback?.netPnl ?? 0,
    netPnlPercent: fallback?.netPnlPercent ?? 0,
    borrowDebtUsdc,
    parkedValueUsdc: 0,
    parkedValueIncluded: false,
    parkedValueUnavailable: false,
    liveDataAvailable: false,
    botFinancialStatus: 'db-only',
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
  // Phase 1a: Bot list + wallet. Awaited WITHOUT a deadline race so the
  // underlying DB calls settle naturally, preserving the no-stampede contract:
  // when callers time out at CALLER_DEADLINE_MS (awaitWithCallerDeadline),
  // entry.inFlight continues and is reused by subsequent callers — no duplicate
  // DB calls. Throws on genuine DB failure; VENUE_DEADLINE_MS still bounds all
  // Phase-2 venue/RPC calls via _waitAndRun.
  // -------------------------------------------------------------------------
  const [bots, wallet] = await Promise.all([
    storage.getTradingBots(walletAddress),
    storage.getWallet(walletAddress),
  ]);

  // -------------------------------------------------------------------------
  // Phase 1b: Parked-position hint. Awaited WITHOUT a deadline race so the
  // underlying DB call settles naturally, preserving no-stampede parity with
  // Phase-1a. Callers that time out at CALLER_DEADLINE_MS leave entry.inFlight
  // alive — a subsequent caller joining the in-flight finds getVaultPositions
  // already in-progress and issues zero duplicate calls.
  // Deadline is checked BEFORE invoking: if Phase-1a settled after VENUE_DEADLINE
  // has elapsed, Phase-1b is skipped entirely rather than launching more work.
  // -------------------------------------------------------------------------
  let parkedHintSucceeded = true;
  let parkedHintRows: any[] = [];
  if (Date.now() < deadlineAt) {
    try {
      parkedHintRows = await storage.getVaultPositionsAllScopes(walletAddress);
    } catch {
      parkedHintSucceeded = false;
    }
  } else {
    parkedHintSucceeded = false; // deadline exceeded before Phase-1b; skip to avoid new work
  }

  // -------------------------------------------------------------------------
  // Phase 1c: Batch enrichment. Awaited WITHOUT a deadline race (no-stampede
  // parity). Deadline checked BEFORE invoking — skipped if Phase-1b settled
  // after the absolute deadline.
  // When enrichment fails, deposit basis, trade counts, debt, publication
  // state are all unknown. Routes must propagate null rather than zero.
  // -------------------------------------------------------------------------
  let enrichment: BotListEnrichment;
  let enrichmentSucceeded = true;
  if (Date.now() < deadlineAt) {
    try {
      enrichment = await storage.getTradingBotListEnrichment(
        walletAddress, bots.map((b: any) => b.id),
      );
    } catch {
      enrichment = _emptyEnrichment();
      enrichmentSucceeded = false;
    }
  } else {
    enrichment = _emptyEnrichment();
    enrichmentSucceeded = false; // deadline exceeded before Phase-1c; skip to avoid new work
  }

  const parkedBotIds = new Set<string>();
  if (parkedHintSucceeded) {
    for (const r of parkedHintRows) {
      const id = (r as any).tradingBotId;
      if (id) parkedBotIds.add(id);
    }
  }

  const botMarkets = [...new Set(bots.map((b: any) => b.market as string))];
  const { prices, pricesAsOf, pricesStale } = deps.getCachedPricesMeta(botMarkets);

  // -------------------------------------------------------------------------
  // Phase 2: Venue enrichment
  //
  // Architecture: each external call is exactly ONE pool slot. Main-account
  // has four independent ops; per-bot has two sequential ops (but different
  // bots overlap). All wrapper promises are launched concurrently and compete
  // for the shared two-slot pool. Wrappers write results before returning —
  // no closure mutates state after _refresh returns.
  //
  // When enrichment failed: borrowDebt and deposit basis are null (unknown).
  // netPnl is null whenever deposit basis is unknown (prevents false profit).
  // When a live bot call fails: exchangeBalance is null (not DB estimate).
  // -------------------------------------------------------------------------
  const pool = entry.pool;
  const agentAddress: string | null = (wallet as any)?.agentPublicKey ?? null;

  // -------------------------------------------------------------------------
  // Pre-classify bot live-eligibility (synchronous, no network calls).
  //
  // Computed BEFORE the Phase-2 deadline guard so that the defensive fill
  // after the guard can assign the correct fallback status even when Phase-2
  // is skipped entirely (deadline elapsed before Phase-2 started).
  //
  // A bot is live-eligible when it has a non-null live context (from
  // getBotSubaccountContext) and is not a Flash alias. Flash alias bots are
  // excluded because they deliberately use the main-account's data.
  //
  // Note: agentAddress may be null even for live-eligible bots. Those bots
  // would have been attempted via the live path but failed immediately (no
  // agent key → can't read). They must report 'unavailable', not 'db-only'.
  //
  // A live-eligible bot NOT enriched by Phase-2 (e.g. deadline fired before
  // Phase-2, or agentAddress absent) must report 'unavailable' to prevent a
  // numeric DB estimate from being presented as current venue data.
  // -------------------------------------------------------------------------
  const liveEligibleBotIds = new Set<string>();
  for (const bot of bots) {
    // Alias check mirrors Phase-2: alias requires agentAddress to be non-null.
    const isAlias =
      (bot as any).activeProtocol === 'flash' &&
      agentAddress !== null &&
      (bot as any).protocolSubaccountId === agentAddress;
    if (isAlias) continue;
    if (deps.getBotSubaccountContext(bot)) {
      liveEligibleBotIds.add(bot.id);
    }
  }

  // Mutable locals; wrappers write here before returning.
  let agentBalance: number | null = null;
  let solBalance: number | null = null;
  let mainAccount: { totalCollateral: number; freeCollateral: number } | null = null;
  let vaultBalance: number | null = null;
  const perBotFinancials = new Map<string, BotFinancialData>();

  // -------------------------------------------------------------------------
  // Phase 2: Venue enrichment — only when deadline has not elapsed after
  // Phase-1. Skipping ensures no pool slots are consumed and no venue calls
  // are started when Phase-1 settled late. perBotFinancials stays empty and
  // is populated entirely by the defensive fill below (DB fallback).
  // -------------------------------------------------------------------------
  if (Date.now() < deadlineAt) {
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

      // When enrichment failed, deposit basis and debt are unknown (null).
      const eq = enrichmentSucceeded ? enrichment.equityAgg.get(botId) : undefined;
      const netDeposited: number | null = enrichmentSucceeded ? (eq?.netDeposited ?? 0) : null;
      const totalDeposits: number | null = enrichmentSucceeded ? (eq?.totalDeposits ?? 0) : null;
      const borrowDebtUsdc: number | null = enrichmentSucceeded
        ? (enrichment.borrowDebts.get(botId) ?? 0)
        : null;

      // Flash double-count: bot wallet IS the agent wallet — skip live call.
      const isFlashAgentAlias =
        (bot as any).activeProtocol === 'flash' &&
        agentAddress !== null &&
        (bot as any).protocolSubaccountId === agentAddress;

      if (isFlashAgentAlias) {
        perBotFinancials.set(botId, {
          exchangeBalance: 0,
          netPnl: netDeposited !== null ? -netDeposited : null,
          netPnlPercent: (netDeposited !== null && totalDeposits !== null && totalDeposits > 0)
            ? (-netDeposited / totalDeposits) * 100
            : null,
          borrowDebtUsdc,
          parkedValueUsdc: 0,
          parkedValueIncluded: false,
          parkedValueUnavailable: false,
          liveDataAvailable: false,
          botFinancialStatus: 'db-only',
        });
        continue;
      }

      // Bots with no live context get DB-based fallback immediately (no pool slot).
      const botCtx = deps.getBotSubaccountContext(bot);
      if (!botCtx || !agentAddress) {
        // 'db-only': planned path was always DB-only (no live context at all).
        // 'unavailable': live context exists but agentAddress absent — was
        //   eligible for live data but the key required to read it is missing.
        const fallbackStatus = (botCtx && !agentAddress) ? 'unavailable' : 'db-only';
        perBotFinancials.set(botId, _fallbackFinancials(
          bot, enrichment, prices, enrichmentSucceeded, parkedHintSucceeded, parkedBotIds, fallbackStatus,
        ));
        continue;
      }

      // Resolve adapter ONLY after confirming we need the live path.
      let botAdapter: unknown;
      try {
        botAdapter = deps.getAdapterForBot(bot);
      } catch {
        perBotFinancials.set(botId, _fallbackFinancials(
          bot, enrichment, prices, enrichmentSucceeded, parkedHintSucceeded, parkedBotIds, 'unavailable',
        ));
        continue;
      }

      // Pipeline within this bot: Op1 → Op2 sequential; this wrapper runs
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
          // Deadline fired or live call threw — null balance, never DB estimate.
          perBotFinancials.set(botId, {
            exchangeBalance: null,
            netPnl: null,
            netPnlPercent: null,
            borrowDebtUsdc,
            parkedValueUsdc: 0,
            parkedValueIncluded: false,
            parkedValueUnavailable: false,
            liveDataAvailable: false,
            botFinancialStatus: 'unavailable',
          });
          return;
        }

        // Op 2: parked vault value (1 pool slot, best-effort)
        let adj: any = null;
        await _waitAndRun(pool, deadlineAt, async () => {
          adj = await deps.addParkedValueForBotDisplayEquity(
            bot, botAdapter, (liveInfo as any).totalCollateral,
            // When hint failed, do not pass hasVaultRows:false — that would
            // incorrectly skip the real check. Pass undefined to force it.
            parkedHintSucceeded ? { hasVaultRows: parkedBotIds.has(botId) } : undefined,
          );
        });

        // adj may be null (Op2 timed out) or adj.parkedValueUnavailable=true
        // (Op2 settled but parked value is uncertain). In either case, returning
        // raw collateral as the full equity number is misleading — parked funds
        // may exist that are not reflected in totalCollateral. Return null
        // so callers know the equity figure is incomplete.
        const parkedUnavailable = adj === null || (adj as any).parkedValueUnavailable;
        if (parkedUnavailable) {
          perBotFinancials.set(botId, {
            exchangeBalance: null,
            netPnl: null,
            netPnlPercent: null,
            borrowDebtUsdc,
            parkedValueUsdc: adj?.parkedValueUsdc ?? 0,
            parkedValueIncluded: adj?.parkedValueIncluded ?? false,
            parkedValueUnavailable: true,
            liveDataAvailable: adj !== null, // Op2 settled but uncertain
            botFinancialStatus: 'unavailable',
          });
          return;
        }

        // adj settled with known parked value.
        const equityBase: number = (adj as any).equityUsdc;
        const adjustedDebt = borrowDebtUsdc ?? 0;
        const botBalance = equityBase - adjustedDebt;
        // netPnl is null whenever deposit basis is unknown (enrichment failed).
        const netPnl = netDeposited !== null ? botBalance - netDeposited : null;
        const netPnlPercent = (netPnl !== null && totalDeposits !== null && totalDeposits > 0)
          ? (netPnl / totalDeposits) * 100
          : null;

        perBotFinancials.set(botId, {
          exchangeBalance: botBalance,
          netPnl,
          netPnlPercent,
          borrowDebtUsdc,
          parkedValueUsdc: (adj as any).parkedValueUsdc,
          parkedValueIncluded: (adj as any).parkedValueIncluded,
          parkedValueUnavailable: false,
          liveDataAvailable: true,
          botFinancialStatus: 'live',
        });
      })());
    }

    // Run all wrappers concurrently — they share the two-slot pool.
    await Promise.all(wrappers);
  } // end Phase-2 deadline guard

  // Defensive fill: any bot not written by a wrapper (or Phase-2 skipped
  // entirely due to deadline) gets an appropriate fallback.
  //
  // Planned path classification uses the pre-computed liveEligibleBotIds:
  //   - live-eligible bot not enriched by Phase-2 → 'unavailable': its DB
  //     estimate must NOT be presented as current venue data. The fact that
  //     Phase-2 did not run does not convert it into a genuine DB-only bot.
  //   - genuinely DB-only bot (no live context, Flash alias, etc.) → 'db-only':
  //     the DB estimate is the intended path and is safe to present.
  for (const bot of bots) {
    if (!perBotFinancials.has(bot.id)) {
      const status = liveEligibleBotIds.has(bot.id) ? 'unavailable' : 'db-only';
      perBotFinancials.set(bot.id, _fallbackFinancials(
        bot, enrichment, prices, enrichmentSucceeded, parkedHintSucceeded, parkedBotIds, status,
      ));
    }
  }

  // Determine snapshot quality.
  // 'partial' when ANY required main-account component is null (not only when
  // all fail), OR when enrichment/parked-hint reads failed.
  // Absent agent address is itself a partial condition: no on-chain data can be
  // read without it. When present, every main-account component must succeed.
  const anyMainMissing =
    agentAddress === null ||
    agentBalance === null || solBalance === null ||
    mainAccount === null || vaultBalance === null;
  // Per-bot failures propagate: any bot with unavailable live balance or uncertain
  // parked value makes the wallet snapshot partial (caller cannot trust that data).
  const anyBotUnavailable = [...perBotFinancials.values()].some(
    f => f.botFinancialStatus === 'unavailable',
  );
  const anyBotParkedUncertain = [...perBotFinancials.values()].some(
    f => f.parkedValueUnavailable,
  );
  const snapshotStatus: 'fresh' | 'partial' =
    (anyMainMissing || !enrichmentSucceeded || !parkedHintSucceeded ||
     anyBotUnavailable || anyBotParkedUncertain)
      ? 'partial'
      : 'fresh';

  return {
    bots,
    wallet,
    enrichment,
    enrichmentSucceeded,
    parkedHintSucceeded,
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
 *   'fresh':       Computed within the last 5 s; all required components present.
 *   'partial':     Fresh bot list but at least one main-account venue component
 *                  null, OR enrichment/parked-hint reads failed.
 *   'stale':       Refresh failed; returning last-known-good (≤ 60 s old at
 *                  actual response time).
 *   'unavailable': No viable snapshot. Routes MUST return HTTP 503.
 *
 * The caller envelope is CALLER_DEADLINE_MS (10 s). A never-settling Phase-1
 * DB promise will not block either route beyond that window. The underlying
 * inFlight promise continues to run and is tracked in the cache entry so no
 * replacement refresh is started (no-stampede invariant). After timeout,
 * subsequent callers join the still-in-flight underlying promise at zero
 * additional DB cost.
 *
 * The caller-envelope timer is cleared immediately when the refresh settles
 * early so no lingering timers accumulate after fast completions.
 *
 * Only a fully-fresh (snapshotStatus === 'fresh') refresh result updates the
 * last-known-good cache entry; partial results do not overwrite a previous
 * fully-good snapshot.
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

  // Short-lived partial cache hit (same 5 s window as fresh TTL). Reuses the
  // last partial result to avoid duplicate DB/RPC work within the window.
  // Does NOT affect lastSuccess (the stale-fallback anchor for the 60 s window).
  if (entry.lastPartial && now - entry.lastPartial.observedAt < FRESH_TTL_MS) {
    return _wrap(entry.lastPartial);
  }

  // Helper: race the result promise against the caller deadline and fall back.
  // The caller-envelope timer is cleared immediately when the underlying settles
  // first so it does not linger after fast completions.
  const awaitWithCallerDeadline = async (
    p: Promise<SnapshotData>,
  ): Promise<WalletFinancialSnapshot> => {
    // Initialized to no-op so it is always callable after the race regardless
    // of whether the Promise constructor callback ran (avoids TS post-await
    // narrowing problems with `(() => void) | null`).
    let clearCallerTimer: () => void = () => {};
    const outcome = await Promise.race([
      p.then(data => ({ type: 'ok' as const, data }))
       .catch(() => ({ type: 'err' as const })),
      new Promise<{ type: 'timeout' }>(resolve => {
        const t = setTimeout(() => resolve({ type: 'timeout' }), CALLER_DEADLINE_MS);
        clearCallerTimer = () => clearTimeout(t);
      }),
    ]);
    // Always clear the caller timer when outcome is known (fast or timeout).
    clearCallerTimer();
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
  // Only a fully-fresh result replaces lastSuccess; partial results do not
  // overwrite a previous good snapshot used for stale fallback.
  inFlight.then(
    (data) => {
      if (data.snapshotStatus === 'fresh') {
        entry.lastSuccess = data;
        entry.lastPartial = null; // fresh result supersedes any cached partial
      } else {
        entry.lastPartial = data; // cache partial for FRESH_TTL_MS (see below)
      }
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
    enrichmentSucceeded: data.enrichmentSucceeded,
    parkedHintSucceeded: data.parkedHintSucceeded,
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
    enrichmentSucceeded: false,
    parkedHintSucceeded: false,
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

/** Pool waiter count for a wallet. Returns -1 outside NODE_ENV=test. */
export function _waiterCount(walletAddress: string): number {
  if (process.env.NODE_ENV !== 'test') return -1;
  return _cache.get(walletAddress)?.pool.waiterCount ?? 0;
}

// ---------------------------------------------------------------------------
// Per-bot financialDataStatus derivation (exported for route + test use)
// ---------------------------------------------------------------------------

/**
 * Derive an honest per-bot financialDataStatus from the bot's own outcome,
 * independently of wallet-level main-account failures.
 *
 * Rules (in priority order):
 *  1. Stale snapshot → every bot is stale (last-known-good data).
 *  2. Bot's own live call failed → unavailable for that bot.
 *  3. Batch enrichment failed → unavailable (deposit basis / trade counts unknown).
 *  4. Parked value uncertain for this bot → unavailable.
 *  5. Otherwise → fresh (main-account failures do NOT mislabel healthy bots).
 *
 * 'unavailable' at the wallet level is never reached here — callers return 503
 * before calling this. 'partial' at the wallet level (e.g. agentBalance=null)
 * does NOT propagate to individual bots whose own data is fully intact.
 */
export function derivePerBotFinancialDataStatus(
  fin: BotFinancialData | undefined,
  snapshotStatus: 'fresh' | 'partial' | 'stale',
  enrichmentSucceeded: boolean,
): 'fresh' | 'stale' | 'unavailable' {
  if (snapshotStatus === 'stale') return 'stale';
  if (fin?.botFinancialStatus === 'unavailable') return 'unavailable';
  if (!enrichmentSucceeded) return 'unavailable';
  if (fin?.parkedValueUnavailable) return 'unavailable';
  return 'fresh';
}

// ---------------------------------------------------------------------------
// Route-mapper helper (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Map a single TradingBot to its GET /api/trading-bots API response shape.
 *
 * Pure function: no side effects, no network calls, fully deterministic for
 * a given set of inputs. Extracted from the inline route mapper for testability;
 * behavior is identical to the previous inline implementation.
 *
 * @param bot            The raw TradingBot row from storage.
 * @param fin            Per-bot financial data from the snapshot (undefined when absent).
 * @param enrichment     Batch enrichment from the snapshot.
 * @param enrichmentSucceeded  Whether the enrichment read succeeded.
 * @param snapshotStatus The wallet-level snapshot status (fresh|partial|stale).
 * @param observedAt     Snapshot observation timestamp (null when unavailable).
 */
export function mapBotToApiResponse(
  bot: TradingBot,
  fin: BotFinancialData | undefined,
  enrichment: BotListEnrichment,
  enrichmentSucceeded: boolean,
  snapshotStatus: 'fresh' | 'partial' | 'stale',
  observedAt: number | null,
): Record<string, unknown> {
  const ens = enrichmentSucceeded;
  const eq = ens ? enrichment.equityAgg.get(bot.id) : undefined;
  const positions = ens ? (enrichment.positions.get(bot.id) ?? []) : [];
  const position = (positions as any[]).find((p: any) => p.market === bot.market) ?? null;
  const publishedBot = ens ? (enrichment.publishedBotMap.get(bot.id) ?? null) : null;

  return {
    ...bot,
    // null when enrichment failed — zero when enrichment succeeded but bot has no rows.
    // (successful-empty parity: new bots have zero history, not unknown history)
    actualTradeCount: ens ? (enrichment.tradeCounts.get(bot.id) ?? 0) : null,
    realizedPnl: ens ? ((position as any)?.realizedPnl ?? '0') : null,
    totalFees: ens ? ((position as any)?.totalFees ?? '0') : null,
    exchangeBalance: fin?.exchangeBalance ?? null,
    // null when enrichment failed (debt unknown, not zero).
    borrowDebtUsdc: fin?.borrowDebtUsdc ?? null,
    // null when enrichment failed (deposit basis unknown); zero for a new bot.
    netDeposited: ens ? (eq?.netDeposited ?? 0) : null,
    netPnl: fin?.netPnl ?? null,
    netPnlPercent: fin?.netPnlPercent ?? null,
    // null when enrichment failed (publication state unknown).
    isPublished: ens ? (!!publishedBot && (publishedBot as any).isActive) : null,
    publishedBotId: ens ? ((publishedBot as any)?.id || null) : null,
    botSubaccountIdentifier: bot.protocolSubaccountId || null,
    botFinancialStatus: fin?.botFinancialStatus ?? 'db-only',
    // Per-bot status: independent of main-account failures. A wallet-level
    // 'partial' (agentBalance=null) must NOT mislabel a healthy bot 'unavailable'.
    // Only the bot's own live call failure, enrichment failure, or parked
    // uncertainty makes the bot unavailable. Stale propagates from the wallet.
    financialDataStatus: derivePerBotFinancialDataStatus(fin, snapshotStatus, ens),
    financialDataObservedAt: observedAt,
  };
}
