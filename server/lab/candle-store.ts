import { labCandleCacheV2 } from "@shared/schema";
import { db, pool, scannerCandlePool } from "../db";
import { eq, and, gte, lte, sql, inArray, ne } from "drizzle-orm";
import type { PoolClient } from "pg";
import type {
  CandleBasisPolicy,
  CandleBasis,
  CandleFinality,
  CandleProxy,
  CandleSource,
  CandleVenue,
  CandleTimeSemantic,
  ProvenancedOHLCV,
} from "./datafeed";
import { appendTelemetry } from "../telemetry";
import { registerPoolLoadTag } from "../pool-load";
import { requireSchemaCapabilityReady } from "../schema-readiness";

async function requireCandleCacheSchema(): Promise<void> {
  await requireSchemaCapabilityReady("lab_scanner", async (text, values) => {
    const result = await pool.query(text, values ? [...values] : undefined);
    return { rows: result.rows as readonly Record<string, unknown>[] };
  });
}

// ----- candle read bulkhead -------------------------------------------------
// The scanner, position monitor and Lab all funnel candle-cache DB reads
// through this module, and in the web process they share ONE pg pool (max 8)
// with every interactive endpoint (auth, dashboard, positions, bots). During
// a cold-cache sweep the pre-2026-07-19 code could zombie-hold enough
// connections to starve the whole pool and 500 the dashboard. The
// self-cancelling per-query timeout closed the zombie mechanism; this
// semaphore is the hard guarantee on top: candle READS can never occupy more
// than MAX_ACTIVE_CANDLE_READS slots, and combined with the write cap below
// (MAX_ACTIVE_CANDLE_WRITES=2) candle work is bounded to 5 of 8 connections —
// at least 3 always remain for interactive/auth traffic no matter how cold
// the cache is. Waiters queue OUTSIDE the pool (no connection held while
// waiting); deadline-bounded callers (scanner/monitor via fetchOHLCV) pass an
// AbortSignal and are cancelled cooperatively when their budget expires — the
// waiter is removed promptly and the invocation fails typed
// (CacheDegradedError at the datafeed layer), never silently degrading to a
// network fetch that would add load while the DB is under pressure.
let activeCandleReads = 0;
let queuedCandleReads = 0;
const MAX_ACTIVE_CANDLE_READS = 3;

// ----- phase-attributed read telemetry --------------------------------------
// 2026-07-20 incident: slow_cache events measured TOTAL elapsed time only, so
// "the DB is slow" could not be distinguished from "the read queued behind the
// semaphore" or "pool.connect() starved". Every read now records where its
// time went; the breakdown is surfaced to callers (onPhases) and emitted as a
// rate-limited telemetry line whenever a read is slow or fails.
export type CandleReadCallerClass =
  | "scanner"
  | "paper_monitor"
  | "live_monitor"
  | "context"
  | "lab";

export type CandleReadOutcome =
  | "hit"
  | "miss"
  | "deadline"
  | "cancelled"
  | "query_error";

export type CandleReadPhases = {
  callerClass: CandleReadCallerClass;
  symbol: string;
  timeframe: string;
  outcome: CandleReadOutcome;
  semaphoreWaitMs: number;
  /** -1 on the drizzle path (pool checkout is internal to drizzle there). */
  poolAcquireMs: number;
  queryMs: number;
  resultProcessingMs: number;
  totalMs: number;
  rows: number;
  pool: { total: number; idle: number; waiting: number };
};

// Rate limit: at most PHASE_LINES_PER_WINDOW telemetry lines per minute; a
// storm degrades to one summary line per window instead of another log flood.
const PHASE_LINE_WINDOW_MS = 60_000;
const PHASE_LINES_PER_WINDOW = 10;
let phaseLineWindowStart = 0;
let phaseLinesInWindow = 0;
let phaseLinesDropped = 0;

function emitPhaseLine(p: CandleReadPhases): void {
  const slow = p.totalMs > 1_000;
  const notable = p.outcome === "deadline" || p.outcome === "cancelled" || p.outcome === "query_error";
  if (!slow && !notable) return;
  const now = Date.now();
  if (now - phaseLineWindowStart >= PHASE_LINE_WINDOW_MS) {
    if (phaseLinesDropped > 0) {
      const dropLine = `[CandleRead] rate-limit: suppressed ${phaseLinesDropped} phase lines in the last window`;
      console.log(dropLine);
      appendTelemetry(dropLine);
    }
    phaseLineWindowStart = now;
    phaseLinesInWindow = 0;
    phaseLinesDropped = 0;
  }
  if (phaseLinesInWindow >= PHASE_LINES_PER_WINDOW) {
    phaseLinesDropped++;
    return;
  }
  phaseLinesInWindow++;
  const line =
    `[CandleRead] ${p.callerClass} ${p.symbol} ${p.timeframe} outcome=${p.outcome} ` +
    `sem=${p.semaphoreWaitMs}ms acquire=${p.poolAcquireMs}ms query=${p.queryMs}ms ` +
    `process=${p.resultProcessingMs}ms total=${p.totalMs}ms rows=${p.rows} ` +
    `pool=${p.pool.total}/${p.pool.idle}i/${p.pool.waiting}w`;
  console.log(line);
  appendTelemetry(line);
}

type CandleReadPool = Pick<typeof pool, "connect" | "totalCount" | "idleCount" | "waitingCount">;

function poolSnapshot(readPool: CandleReadPool = pool): { total: number; idle: number; waiting: number } {
  return { total: readPool.totalCount, idle: readPool.idleCount, waiting: readPool.waitingCount };
}

// Marker attached as AbortSignal.reason by fetchOHLCV's cache-budget timer so
// this module can classify budget expiry ("deadline") separately from caller
// cancellation ("cancelled", e.g. sweep teardown).
export const CACHE_BUDGET_ABORT_REASON = "candle-cache-budget-exceeded";

// Bound checkout to the dedicated pool's physical connection timeout. A
// reconnect that can still succeed inside that established limit must not be
// abandoned early and turn one cold lane into all-market provider fan-out.
// The late-checkout self-release guarantee remains the hard upper bound.
export const SCANNER_BATCH_POOL_ACQUIRE_TIMEOUT_MS = 5_000;
// PostgreSQL's five-second statement_timeout is the business deadline. This
// longer pg client timer is only a dead-socket guard: it is implemented by a
// JavaScript timer and therefore must not race a completed/backend-cancelled
// query when the web-process event loop is temporarily stalled.
export const SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS = 60_000;
// Production telemetry showed that one 78-symbol result can synchronously
// materialize about 31,000 rows in node-postgres and starve the web event loop.
// Bound each wire response, while retaining one fail-closed batch deadline.
export const SCANNER_BATCH_SYMBOL_CHUNK_SIZE = 10;

function makeAbortError(reason?: unknown): Error {
  const err = new Error(
    typeof reason === "string" ? reason : "Candle cache read aborted",
  );
  err.name = "AbortError";
  return err;
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

/** Sleep that rejects IMMEDIATELY when the signal aborts (prompt waiter removal). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(makeAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

registerPoolLoadTag("candles", () => ({
  r: activeCandleReads,
  rq: queuedCandleReads,
  w: activeCandleWrites,
  wq: queuedCandleWrites,
  wc: coalescedCandleWrites,
  ws: supersededCandleWrites,
  wd: droppedCandleWrites,
  wcv: durablyConvergedCandleWrites,
}));

/** Test/telemetry snapshot of candle-store pool pressure. */
export function getCandleStoreLoad() {
  return {
    activeReads: activeCandleReads,
    queuedReads: queuedCandleReads,
    activeWrites: activeCandleWrites,
    queuedWrites: queuedCandleWrites,
    coalescedWrites: coalescedCandleWrites,
    supersededWrites: supersededCandleWrites,
    droppedWrites: droppedCandleWrites,
    durablyConvergedWrites: durablyConvergedCandleWrites,
  };
}

// Minimal row shape shared by the drizzle path and the raw-client path below.
type CandleCacheRow = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: CandleSource;
  venue: CandleVenue;
  basis: CandleBasis;
  proxy: CandleProxy;
  finality: CandleFinality;
  timeSemantic: CandleTimeSemantic;
};

type CandleCacheBatchRow = CandleCacheRow & { symbol: string };

export type CandleBatchReadOutcome = CandleReadOutcome;

export type CandleBatchReadTermination =
  | "success"
  | "pool_acquire_timeout"
  | "batch_deadline_exhausted"
  | "session_restore_failed"
  | "server_statement_timeout"
  | "client_query_timeout"
  | "connection_error"
  | "caller_cancelled"
  | "query_error";

export type CandleBatchReadPhases = {
  callerClass: CandleReadCallerClass;
  poolLane: "scanner-candle";
  timeframe: string;
  outcome: CandleBatchReadOutcome;
  termination: CandleBatchReadTermination;
  sqlstate: string | null;
  requestedSymbols: number;
  resolvedSymbols: number;
  unresolvedSymbols: number;
  plannedChunks: number;
  chunks: number;
  batchBudgetMs: number;
  hits: number;
  misses: number;
  semaphoreWaitMs: number;
  poolAcquireMs: number;
  queryMs: number;
  resultProcessingMs: number;
  totalMs: number;
  rows: number;
  pool: { total: number; idle: number; waiting: number };
};

export class CandleBatchReadError extends Error {
  readonly code: "candle_batch_read_failed" | "candle_batch_partial_read" = "candle_batch_read_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CandleBatchReadError";
  }
}

export class CandleBatchPartialReadError extends CandleBatchReadError {
  readonly code = "candle_batch_partial_read";

  constructor(
    public readonly completed: Map<string, ProvenancedOHLCV[] | null>,
    public readonly unresolvedSymbols: ReadonlySet<string>,
    public readonly termination: Exclude<CandleBatchReadTermination, "success" | "caller_cancelled">,
    options?: ErrorOptions,
  ) {
    super("Batch candle-cache read completed only a strict symbol prefix", options);
    this.name = "CandleBatchPartialReadError";
  }
}

export function isCandleBatchPartialReadError(error: unknown): error is CandleBatchPartialReadError {
  return error instanceof CandleBatchPartialReadError
    || (typeof error === "object"
      && error !== null
      && (error as { name?: unknown }).name === "CandleBatchPartialReadError"
      && (error as { code?: unknown }).code === "candle_batch_partial_read"
      && (error as { completed?: unknown }).completed instanceof Map
      && (error as { unresolvedSymbols?: unknown }).unresolvedSymbols instanceof Set
      && ["pool_acquire_timeout", "batch_deadline_exhausted", "server_statement_timeout", "client_query_timeout", "connection_error", "query_error"]
        .includes(String((error as { termination?: unknown }).termination)));
}

class CandlePoolAcquireTimeoutError extends Error {
  readonly code = "candle_pool_acquire_timeout";

  constructor() {
    super("Scanner candle pool acquisition timed out");
    this.name = "CandlePoolAcquireTimeoutError";
  }
}

class CandleBatchDeadlineExhaustedError extends Error {
  readonly code = "candle_batch_deadline_exhausted";

  constructor(options?: ErrorOptions) {
    super("Candle batch aggregate deadline exhausted", options);
    this.name = "CandleBatchDeadlineExhaustedError";
  }
}

class CandleBatchSessionRestoreError extends Error {
  readonly code = "candle_batch_session_restore_failed";
  readonly sqlstate: string | null;

  constructor(cause: unknown) {
    super("Candle batch session timeout restore failed", { cause });
    this.name = "CandleBatchSessionRestoreError";
    const value = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
    this.sqlstate = typeof value.code === "string" ? value.code : null;
  }
}

function classifyBatchTermination(error: unknown): {
  termination: Exclude<CandleBatchReadTermination, "success" | "caller_cancelled">;
  sqlstate: string | null;
} {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof value.code === "string" ? value.code : null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (code === "candle_pool_acquire_timeout" || error instanceof CandlePoolAcquireTimeoutError) {
    return { termination: "pool_acquire_timeout", sqlstate: null };
  }
  if (code === "candle_batch_deadline_exhausted" || error instanceof CandleBatchDeadlineExhaustedError) {
    return { termination: "batch_deadline_exhausted", sqlstate: null };
  }
  if (code === "candle_batch_session_restore_failed" || error instanceof CandleBatchSessionRestoreError) {
    return {
      termination: "session_restore_failed",
      sqlstate: error instanceof CandleBatchSessionRestoreError ? error.sqlstate : null,
    };
  }
  if (message === "timeout exceeded when trying to connect"
      || message === "Connection terminated due to connection timeout") {
    return { termination: "pool_acquire_timeout", sqlstate: code };
  }
  if (code === "57014") return { termination: "server_statement_timeout", sqlstate: code };
  if (error instanceof Error && error.message === "Query read timeout") {
    return { termination: "client_query_timeout", sqlstate: code };
  }
  if (code?.startsWith("08") || /connection|socket|ECONN/i.test(message)) {
    return { termination: "connection_error", sqlstate: code };
  }
  return { termination: "query_error", sqlstate: code };
}

export type GetCachedCandlesOpts = {
  /** Explicit admission policy. There is intentionally no default. */
  basisPolicy: CandleBasisPolicy;
  /**
   * Client-side per-query timeout. Deadline-bounded callers (the AI-trader
   * scanner/monitor via fetchOHLCV) previously abandoned slow cache reads
   * via Promise.race, but the abandoned drizzle query kept RUNNING on its
   * pool connection for up to the pool-level 60s query_timeout — during a
   * boundary burst that zombie-holds connections the sweep itself needs. A
   * positive override here makes the read self-cancel at the caller's
   * budget instead. Same pg gotcha as clearCandleCache: the override MUST
   * be a truthy finite positive number (`0` is silently ignored by pg).
   */
  queryTimeoutMs?: number;
  /**
   * Cooperative cancellation through the FULL admission path: aborting
   * cancels the semaphore wait and the pool checkout promptly (the read
   * fails with an AbortError; a checkout that lands after abort releases
   * itself). Only an already-in-flight SELECT runs on to its own
   * query_timeout. Abort reason CACHE_BUDGET_ABORT_REASON is classified as
   * outcome "deadline"; any other reason as "cancelled".
   */
  signal?: AbortSignal;
  /** Attributes the read in phase telemetry. Defaults to "lab". */
  callerClass?: CandleReadCallerClass;
  /** Receives the phase breakdown for EVERY read (hit, miss, or failure). */
  onPhases?: (phases: CandleReadPhases) => void;
};

export type GetCachedCandlesBatchOpts = Omit<GetCachedCandlesOpts, "onPhases"> & {
  /**
   * Retain an otherwise-admissible deep prefix whose only defect is a stale
   * tail. The scanner must complete and revalidate it before decision use.
   */
  admission?: "complete" | "scanner_prefix";
  /**
   * Absolute caller deadline for the whole batch. The batch also applies its
   * own finite ceiling of one queryTimeoutMs allowance per serial chunk; the
   * earlier deadline wins. This is an absolute timestamp so event-loop delay
   * cannot silently replenish the caller's sweep budget.
   */
  batchDeadlineAtMs?: number;
  onPhases?: (phases: CandleBatchReadPhases) => void;
};

export async function getCachedCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  opts: GetCachedCandlesOpts
): Promise<ProvenancedOHLCV[] | null> {
  if (!opts?.basisPolicy) {
    throw new Error("getCachedCandles requires an explicit basisPolicy");
  }
  // The Lab child is a separate OS process, so the web process's installed
  // snapshot cannot be shared with it. The first child-process call performs
  // one memoized catalog-only probe; web-process calls use the boot snapshot.
  // This is also required after LabSupervisor's internal child respawn, which
  // does not rerun the web process's boot-time ensureSchema check.
  await requireCandleCacheSchema();
  const startedAt = Date.now();
  const signal = opts.signal;
  const phases: CandleReadPhases = {
    callerClass: opts.callerClass ?? "lab",
    symbol,
    timeframe,
    outcome: "miss",
    semaphoreWaitMs: 0,
    poolAcquireMs: -1,
    queryMs: 0,
    resultProcessingMs: 0,
    totalMs: 0,
    rows: 0,
    pool: poolSnapshot(),
  };
  const finish = (outcome: CandleReadOutcome) => {
    phases.outcome = outcome;
    phases.totalMs = Date.now() - startedAt;
    phases.pool = poolSnapshot();
    try {
      opts.onPhases?.(phases);
    } catch {
      // Caller's observer must never break the read path.
    }
    emitPhaseLine(phases);
  };
  const abortOutcome = (): CandleReadOutcome =>
    signal?.reason === CACHE_BUDGET_ABORT_REASON ? "deadline" : "cancelled";

  // Bulkhead: wait for a read slot BEFORE touching the pool. The wait loop
  // holds no DB resources, so a burst of cold-cache dispatches queues here
  // harmlessly instead of stacking connection checkouts. Abort-aware: a
  // deadline-bounded caller whose budget expires while queued leaves the
  // queue immediately instead of eventually running a pointless read.
  const semStart = Date.now();
  if (isSignalAborted(signal)) {
    finish(abortOutcome());
    throw makeAbortError(signal!.reason);
  }
  if (activeCandleReads >= MAX_ACTIVE_CANDLE_READS) {
    queuedCandleReads++;
    try {
      while (activeCandleReads >= MAX_ACTIVE_CANDLE_READS) {
        await abortableSleep(50, signal);
      }
    } catch (err) {
      phases.semaphoreWaitMs = Date.now() - semStart;
      finish(abortOutcome());
      throw err;
    } finally {
      queuedCandleReads--;
    }
  }
  phases.semaphoreWaitMs = Date.now() - semStart;

  activeCandleReads++;
  try {
    const result = await getCachedCandlesInner(symbol, timeframe, startMs, endMs, opts, phases);
    finish(result === null ? "miss" : "hit");
    return result;
  } catch (err: any) {
    // Signal-state is authoritative: even a non-AbortError exception must be
    // reclassified as the governing signal's outcome if that signal has
    // already fired (e.g. a query that rejects with a plain Error after the
    // budget signal fired is still a deadline, not an operational failure).
    if (isSignalAborted(signal)) {
      finish(abortOutcome());
      throw makeAbortError(signal!.reason);
    }
    if (err?.name === "AbortError") {
      finish(abortOutcome());
      throw err; // typed cancellation propagates to fetchOHLCV's classifier
    }
    // Operational error (pool checkout failure, query timeout, connection
    // error, post-query processing error). Record it, then:
    //  - Deadline-bounded callers (signal present): re-throw so the datafeed
    //    boundary converts it to CacheDegradedError — operational failures
    //    are degradation, never a miss that permits network fallback.
    //  - Deadline-less callers (Lab): fail-open to null so a miss triggers a
    //    cheaper network refetch rather than a fatal failure.
    console.log(`[CandleCache] Read error: ${err?.message ?? err}`);
    finish("query_error");
    if (signal) throw err;
    return null;
  } finally {
    activeCandleReads--;
  }
}

/**
 * Read one timeframe/range for the scanner's deduplicated protocol-universe
 * union with serial indexed SELECT chunks. Every symbol is still admitted by the exact
 * per-symbol row processor; a missing or inadmissible group is returned as a
 * miss so the unchanged per-market path remains authoritative for fallback.
 */
export async function getCachedCandlesBatch(
  symbols: readonly string[],
  timeframe: string,
  startMs: number,
  endMs: number,
  opts: GetCachedCandlesBatchOpts,
): Promise<Map<string, ProvenancedOHLCV[] | null>> {
  if (!opts?.basisPolicy) {
    throw new Error("getCachedCandlesBatch requires an explicit basisPolicy");
  }
  if (!Number.isFinite(opts.queryTimeoutMs) || (opts.queryTimeoutMs ?? 0) <= 0) {
    throw new Error("getCachedCandlesBatch requires a positive queryTimeoutMs");
  }
  const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
  if (uniqueSymbols.length === 0) return new Map();

  await requireCandleCacheSchema();
  const startedAt = Date.now();
  const signal = opts.signal;
  const plannedChunks = Math.ceil(uniqueSymbols.length / SCANNER_BATCH_SYMBOL_CHUNK_SIZE);
  const phases: CandleBatchReadPhases = {
    callerClass: opts.callerClass ?? "scanner",
    poolLane: "scanner-candle",
    timeframe,
    outcome: "miss",
    termination: "success",
    sqlstate: null,
    requestedSymbols: uniqueSymbols.length,
    resolvedSymbols: 0,
    unresolvedSymbols: uniqueSymbols.length,
    plannedChunks,
    chunks: 0,
    batchBudgetMs: 0,
    hits: 0,
    misses: uniqueSymbols.length,
    semaphoreWaitMs: 0,
    poolAcquireMs: -1,
    queryMs: 0,
    resultProcessingMs: 0,
    totalMs: 0,
    rows: 0,
    pool: poolSnapshot(scannerCandlePool),
  };
  const finish = (outcome: CandleBatchReadOutcome) => {
    phases.outcome = outcome;
    phases.totalMs = Date.now() - startedAt;
    phases.pool = poolSnapshot(scannerCandlePool);
    try {
      opts.onPhases?.(phases);
    } catch {
      // Observer failures never alter the read path.
    }
    const line =
      `[CandleBatchRead] ${phases.callerClass} ${timeframe} lane=${phases.poolLane} outcome=${outcome} ` +
      `requested=${phases.requestedSymbols} planned_chunks=${phases.plannedChunks} completed_chunks=${phases.chunks} ` +
      `resolved_symbols=${phases.resolvedSymbols} unresolved_symbols=${phases.unresolvedSymbols} ` +
      `batch_budget=${phases.batchBudgetMs}ms hits=${phases.hits} misses=${phases.misses} ` +
      `rows=${phases.rows} sem=${phases.semaphoreWaitMs}ms acquire=${phases.poolAcquireMs}ms ` +
      `query=${phases.queryMs}ms process=${phases.resultProcessingMs}ms total=${phases.totalMs}ms ` +
      `termination=${phases.termination} sqlstate=${phases.sqlstate ?? "none"} ` +
      `pool=${phases.pool.total}/${phases.pool.idle}i/${phases.pool.waiting}w`;
    console.log(line);
    appendTelemetry(line);
  };
  const abortOutcome = (): CandleBatchReadOutcome =>
    signal?.reason === CACHE_BUDGET_ABORT_REASON ? "deadline" : "cancelled";

  const semaphoreStartedAt = Date.now();
  if (isSignalAborted(signal)) {
    phases.termination = "caller_cancelled";
    finish(abortOutcome());
    throw makeAbortError(signal!.reason);
  }
  if (activeCandleReads >= MAX_ACTIVE_CANDLE_READS) {
    queuedCandleReads++;
    try {
      while (activeCandleReads >= MAX_ACTIVE_CANDLE_READS) {
        await abortableSleep(50, signal);
      }
    } catch (error) {
      phases.semaphoreWaitMs = Date.now() - semaphoreStartedAt;
      phases.termination = "caller_cancelled";
      finish(abortOutcome());
      throw error;
    } finally {
      queuedCandleReads--;
    }
  }
  phases.semaphoreWaitMs = Date.now() - semaphoreStartedAt;

  activeCandleReads++;
  try {
    const policy = opts.basisPolicy;
    const requireDirectOkxIdentity = policy.consumer !== "lab"
      && policy.consumer !== "scanner"
      && policy.consumer !== "ai_context";
    const client = await acquireClientWithAbort(
      signal,
      phases as unknown as CandleReadPhases,
      scannerCandlePool,
      SCANNER_BATCH_POOL_ACQUIRE_TIMEOUT_MS,
    );
    const statementTimeoutMs = Math.max(1, Math.floor(opts.queryTimeoutMs!));
    // Count semaphore and pool acquisition against the aggregate batch clock.
    // A contended lane must consume the batch allowance rather than silently
    // minting a fresh per-chunk aggregate after checkout finally succeeds.
    const internalBatchDeadlineAt = startedAt + statementTimeoutMs * plannedChunks;
    const callerBatchDeadlineAt = Number.isFinite(opts.batchDeadlineAtMs)
      ? Math.floor(opts.batchDeadlineAtMs!)
      : Number.POSITIVE_INFINITY;
    const batchDeadlineAt = Math.min(internalBatchDeadlineAt, callerBatchDeadlineAt);
    phases.batchBudgetMs = Math.max(0, batchDeadlineAt - Date.now());
    let selectStartedAt: number | null = null;
    let selectCompleted = true;
    const rows: CandleCacheBatchRow[] = [];
    const completedSymbols = new Set<string>();
    let partialFailure: {
      error: unknown;
      termination: Exclude<CandleBatchReadTermination, "success" | "caller_cancelled">;
    } | null = null;
    try {
      const singletonPolicy = policy.acceptedBasis.length === 1
        && policy.acceptedFinality.length === 1
        && policy.acceptedProxy.length === 1;
      for (let offset = 0; offset < uniqueSymbols.length; offset += SCANNER_BATCH_SYMBOL_CHUNK_SIZE) {
        if (isSignalAborted(signal)) throw makeAbortError(signal!.reason);
        const remainingMs = Math.floor(batchDeadlineAt - Date.now());
        if (remainingMs <= 0) throw new CandleBatchDeadlineExhaustedError();
        const chunkStatementTimeoutMs = Math.min(statementTimeoutMs, remainingMs);
        await client.query({
          text: "SELECT set_config('statement_timeout', $1, false)",
          values: [String(chunkStatementTimeoutMs)],
          query_timeout: SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
        } as any);
        const symbolChunk = uniqueSymbols.slice(offset, offset + SCANNER_BATCH_SYMBOL_CHUNK_SIZE);
        selectStartedAt = Date.now();
        selectCompleted = false;
        const result = await client.query({
          text:
            "SELECT symbol, time, open, high, low, close, volume, source, venue, basis, proxy, finality, time_semantic AS \"timeSemantic\" FROM lab_candle_cache_v2 " +
            "WHERE symbol = ANY($1::text[]) AND timeframe = $2 AND time >= $3 AND time <= $4 " +
            (singletonPolicy
              ? "AND basis = $5 AND finality = $6 AND proxy = $7 "
              : "AND basis = ANY($5::text[]) AND finality = ANY($6::text[]) AND proxy = ANY($7::text[]) ") +
            "AND source <> 'unknown' AND venue <> 'unknown' AND time_semantic <> 'unknown' " +
            "AND (NOT $8::boolean OR (source = 'okx' AND venue = 'okx' AND time_semantic = 'open_time')) " +
            "ORDER BY symbol, time",
          values: [
            symbolChunk, timeframe, String(startMs), String(endMs),
            ...(singletonPolicy
              ? [policy.acceptedBasis[0], policy.acceptedFinality[0], policy.acceptedProxy[0]]
              : [[...policy.acceptedBasis], [...policy.acceptedFinality], [...policy.acceptedProxy]]),
            requireDirectOkxIdentity,
          ],
          query_timeout: SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
        } as any);
        phases.queryMs += Date.now() - selectStartedAt;
        selectCompleted = true;
        phases.chunks++;
        for (const symbol of symbolChunk) completedSymbols.add(symbol);
        rows.push(...result.rows as CandleCacheBatchRow[]);
        if (offset + SCANNER_BATCH_SYMBOL_CHUNK_SIZE < uniqueSymbols.length) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      await client.query({
        text: "SELECT set_config('statement_timeout', '30000', false)",
        query_timeout: SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
      } as any);
      phases.termination = "success";
      client.release();
    } catch (error) {
      if (selectStartedAt !== null && !selectCompleted) {
        phases.queryMs += Date.now() - selectStartedAt;
      }
      const classified = classifyBatchTermination(error);
      phases.termination = classified.termination;
      phases.sqlstate = classified.sqlstate;
      let partialCause = error;
      if (classified.termination === "batch_deadline_exhausted") {
        // The local clock expired between chunks, not while PostgreSQL was
        // executing. Restore the shared session default and keep the healthy
        // max-one scanner-pool connection available to the next timeframe.
        try {
          await client.query({
            text: "SELECT set_config('statement_timeout', '30000', false)",
            query_timeout: SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
          } as any);
          client.release();
        } catch (restoreError) {
          client.release(restoreError instanceof Error ? restoreError : new Error(String(restoreError)));
          const sessionRestoreFailure = new CandleBatchSessionRestoreError(restoreError);
          phases.termination = "session_restore_failed";
          phases.sqlstate = sessionRestoreFailure.sqlstate;
          // Session hygiene controls connection reuse, not the truth of SELECTs
          // that already completed. Retain a strict prefix while preserving the
          // restore failure in the typed deadline cause for diagnosis.
          if (completedSymbols.size === 0 || completedSymbols.size === uniqueSymbols.length) {
            throw sessionRestoreFailure;
          }
          partialCause = new CandleBatchDeadlineExhaustedError({ cause: sessionRestoreFailure });
        }
      } else {
        client.release(error instanceof Error ? error : new Error(String(error)));
      }
      // Preserve only a strict prefix. If no SELECT completed there are no
      // trustworthy bytes to retain; if every SELECT completed, the failure
      // belongs to session cleanup and retains the existing full-failure
      // semantics rather than masquerading as an unresolved-symbol suffix.
      if (completedSymbols.size === 0 || completedSymbols.size === uniqueSymbols.length) throw error;
      partialFailure = { error: partialCause, termination: classified.termination };
    }
    if (isSignalAborted(signal)) throw makeAbortError(signal!.reason);

    phases.rows = rows.length;
    const symbolsToProcess = partialFailure ? [...completedSymbols] : uniqueSymbols;
    phases.resolvedSymbols = symbolsToProcess.length;
    phases.unresolvedSymbols = phases.requestedSymbols - phases.resolvedSymbols;
    const grouped = new Map(symbolsToProcess.map((symbol) => [symbol, [] as CandleCacheRow[]]));
    for (const row of rows) grouped.get(row.symbol)?.push(row);

    const processStartedAt = Date.now();
    const admittedBySymbol = new Map<string, ProvenancedOHLCV[] | null>();
    for (const symbol of symbolsToProcess) {
      if (isSignalAborted(signal)) throw makeAbortError(signal!.reason);
      const localPhases: CandleReadPhases = {
        callerClass: phases.callerClass,
        symbol,
        timeframe,
        outcome: "miss",
        semaphoreWaitMs: phases.semaphoreWaitMs,
        poolAcquireMs: phases.poolAcquireMs,
        queryMs: phases.queryMs,
        resultProcessingMs: 0,
        totalMs: 0,
        rows: 0,
        pool: phases.pool,
      };
      const admitted = await processCandleRows(
        symbol,
        timeframe,
        startMs,
        endMs,
        grouped.get(symbol) ?? [],
        localPhases,
        opts.admission === "scanner_prefix",
      );
      admittedBySymbol.set(symbol, admitted);
      if (admitted !== null) phases.hits++;
    }
    phases.misses = phases.resolvedSymbols - phases.hits;
    phases.resultProcessingMs = Date.now() - processStartedAt;
    if (partialFailure) {
      const unresolvedSymbols = new Set(uniqueSymbols.filter((symbol) => !completedSymbols.has(symbol)));
      finish(phases.hits > 0 ? "hit" : "miss");
      throw new CandleBatchPartialReadError(
        admittedBySymbol,
        unresolvedSymbols,
        partialFailure.termination,
        { cause: partialFailure.error },
      );
    }
    finish(phases.hits > 0 ? "hit" : "miss");
    return admittedBySymbol;
  } catch (error: any) {
    if (error instanceof CandleBatchPartialReadError) throw error;
    if (isSignalAborted(signal)) {
      phases.termination = "caller_cancelled";
      finish(abortOutcome());
      throw makeAbortError(signal!.reason);
    }
    if (error?.name === "AbortError") {
      phases.termination = "caller_cancelled";
      finish(abortOutcome());
      throw error;
    }
    const classified = classifyBatchTermination(error);
    phases.termination = classified.termination;
    phases.sqlstate = classified.sqlstate;
    finish("query_error");
    throw new CandleBatchReadError(
      `Batch candle-cache read failed for ${timeframe}`,
      { cause: error },
    );
  } finally {
    activeCandleReads--;
  }
}

/**
 * pg-pool checkout with cooperative cancellation. pool.connect() is not
 * natively abortable, so on abort the pending checkout keeps running in the
 * background and releases itself the moment it lands — the CALLER is
 * unblocked promptly and no client ever leaks.
 */
async function acquireClientWithAbort(
  signal: AbortSignal | undefined,
  phases: CandleReadPhases,
  readPool: CandleReadPool = pool,
  timeoutMs?: number,
): Promise<PoolClient> {
  const acquireStart = Date.now();
  if (isSignalAborted(signal)) {
    phases.poolAcquireMs = 0;
    throw makeAbortError(signal!.reason);
  }
  if (!signal && !timeoutMs) {
    const client = await readPool.connect();
    phases.poolAcquireMs = Date.now() - acquireStart;
    return client;
  }
  const checkout = readPool.connect();
  const client = await new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      phases.poolAcquireMs = Date.now() - acquireStart;
      if (timer) clearTimeout(timer);
      // Self-releasing orphan: return the client to the pool untouched the
      // moment the checkout lands (clean release — no query ever ran on it).
      checkout.then((c) => c.release()).catch(() => {});
      reject(makeAbortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        phases.poolAcquireMs = Date.now() - acquireStart;
        signal?.removeEventListener("abort", onAbort);
        // The checkout itself cannot be cancelled. It owns no query and must
        // release itself cleanly whenever pg eventually supplies a client.
        checkout.then((c) => c.release()).catch(() => {});
        reject(new CandlePoolAcquireTimeoutError());
      }, timeoutMs);
      timer.unref?.();
    }
    checkout.then(
      (c) => {
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        if (settled) return; // abort/timeout won; client released above
        settled = true;
        phases.poolAcquireMs = Date.now() - acquireStart;
        resolve(c);
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        phases.poolAcquireMs = Date.now() - acquireStart;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
  return client;
}

async function getCachedCandlesInner(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  opts: GetCachedCandlesOpts,
  phases: CandleReadPhases
): Promise<ProvenancedOHLCV[] | null> {
  const signal = opts.signal;
  const policy = opts.basisPolicy;
  const requireDirectOkxIdentity = policy.consumer !== "lab"
    && policy.consumer !== "scanner"
    && policy.consumer !== "ai_context";
  let rows: CandleCacheRow[];
  const queryTimeoutMs = opts.queryTimeoutMs;
  if (queryTimeoutMs && Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0) {
    // Raw checked-out client: drizzle does not expose per-query timeout
    // overrides. Release discipline mirrors clearCandleCache — on ANY
    // error release WITH the error so pg-pool destroys the client instead
    // of recycling a possibly-still-busy socket.
    const client = await acquireClientWithAbort(signal, phases);
    const queryStart = Date.now();
    try {
      const result = await client.query({
        text:
          "SELECT time, open, high, low, close, volume, source, venue, basis, proxy, finality, time_semantic AS \"timeSemantic\" FROM lab_candle_cache_v2 " +
          "WHERE symbol = $1 AND timeframe = $2 AND time >= $3 AND time <= $4 " +
          "AND basis = ANY($5::text[]) AND finality = ANY($6::text[]) AND proxy = ANY($7::text[]) " +
          "AND source <> 'unknown' AND venue <> 'unknown' AND time_semantic <> 'unknown' " +
          "AND (NOT $8::boolean OR (source = 'okx' AND venue = 'okx' AND time_semantic = 'open_time')) " +
          "ORDER BY time",
        values: [
          symbol, timeframe, String(startMs), String(endMs),
          [...policy.acceptedBasis], [...policy.acceptedFinality], [...policy.acceptedProxy],
          requireDirectOkxIdentity,
        ],
        query_timeout: Math.max(1, Math.floor(queryTimeoutMs)),
      } as any);
      phases.queryMs = Date.now() - queryStart;
      client.release();
      rows = result.rows as CandleCacheRow[];
    } catch (err) {
      phases.queryMs = Date.now() - queryStart;
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    // Post-SELECT abort check: the SELECT may complete just as the budget
    // expires; the caller has already classified the invocation as failed,
    // so honor the abort rather than returning a result nobody awaits.
    if (isSignalAborted(signal)) throw makeAbortError(signal!.reason);
  } else {
    if (isSignalAborted(signal)) throw makeAbortError(signal!.reason);
    const queryStart = Date.now();
    rows = await db
      .select()
      .from(labCandleCacheV2)
      .where(
        and(
          eq(labCandleCacheV2.symbol, symbol),
          eq(labCandleCacheV2.timeframe, timeframe),
          gte(labCandleCacheV2.time, String(startMs)),
          lte(labCandleCacheV2.time, String(endMs)),
          inArray(labCandleCacheV2.basis, [...policy.acceptedBasis]),
          inArray(labCandleCacheV2.finality, [...policy.acceptedFinality]),
          inArray(labCandleCacheV2.proxy, [...policy.acceptedProxy]),
          requireDirectOkxIdentity ? eq(labCandleCacheV2.source, "okx") : ne(labCandleCacheV2.source, "unknown"),
          requireDirectOkxIdentity ? eq(labCandleCacheV2.venue, "okx") : ne(labCandleCacheV2.venue, "unknown"),
          requireDirectOkxIdentity ? eq(labCandleCacheV2.timeSemantic, "open_time") : ne(labCandleCacheV2.timeSemantic, "unknown"),
        )
      )
      .orderBy(labCandleCacheV2.time) as unknown as CandleCacheRow[];
    phases.queryMs = Date.now() - queryStart;
  }

  const processStart = Date.now();
  try {
    return await processCandleRows(symbol, timeframe, startMs, endMs, rows, phases);
  } finally {
    phases.resultProcessingMs = Date.now() - processStart;
  }
}

/** Coverage/staleness/alignment validation + row mapping (null = treat as miss). */
async function processCandleRows(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  rows: CandleCacheRow[],
  phases: CandleReadPhases,
  allowStaleTailPrefix = false,
): Promise<ProvenancedOHLCV[] | null> {
  // Finality is part of immutable cache identity, so the same bar can be
  // observed first as forming and later as finalized. OHLCV consumers require
  // one monotonically ordered row per open time; prefer the strongest retained
  // observation and use the complete identity only as a deterministic tie-break.
  const finalityRank: Record<CandleFinality, number> = { finalized: 0, forming: 1, unknown: 2 };
  const rowIdentity = (row: CandleCacheRow) =>
    `${row.source}/${row.venue}/${row.basis}/${row.proxy}/${row.finality}/${row.timeSemantic}`;
  const byTime = new Map<string, CandleCacheRow>();
  for (const row of rows) {
    const key = String(row.time);
    const retained = byTime.get(key);
    if (!retained
        || finalityRank[row.finality] < finalityRank[retained.finality]
        || (finalityRank[row.finality] === finalityRank[retained.finality]
          && rowIdentity(row) < rowIdentity(retained))) {
      byTime.set(key, row);
    }
  }
  rows = [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time));
  phases.rows = rows.length;
  const tfSeconds = getTimeframeSecondsForCache(timeframe);
  const tfMs = tfSeconds * 1000;
  const expectedCandles = Math.floor((endMs - startMs) / tfMs);

  // Range-aware floor: short requests (e.g. an open position's entry→now
  // window) can never contain 50 rows, so a flat floor forced a network
  // refetch on every monitor tick for young positions. Coverage-ratio and
  // tail-gap checks below still guard correctness for short ranges.
  const minRows = Math.min(50, Math.max(1, expectedCandles - 1));
  if (rows.length < minRows) return null;
  const coverageRatio = rows.length / Math.max(expectedCandles, 1);

  if (coverageRatio < 0.7) {
    console.log(`[CandleCache] Partial hit for ${symbol} ${timeframe}: ${rows.length}/${expectedCandles} candles (${(coverageRatio * 100).toFixed(0)}% coverage) — refetching`);
    return null;
  }

  const lastCachedTime = Number(rows[rows.length - 1].time);
  const tailGapCandles = Math.floor((endMs - lastCachedTime) / tfMs);
  if (tailGapCandles > 3 && !allowStaleTailPrefix) {
    console.log(`[CandleCache] Tail gap: ${tailGapCandles} candles behind for ${symbol} ${timeframe} (last cached: ${new Date(lastCachedTime).toISOString()}, requested end: ${new Date(endMs).toISOString()}) — refetching to append tail`);
    return null;
  }

  if (tfMs >= 28800000 && rows.length >= 3) {
    const sampleSize = Math.min(rows.length, 20);
    let misaligned = 0;
    let wrongInterval = 0;
    for (let i = 0; i < sampleSize; i++) {
      const ts = Number(rows[i].time);
      if (ts % tfMs !== 0) misaligned++;
      if (i > 0) {
        const gap = ts - Number(rows[i - 1].time);
        if (gap > 0 && gap < tfMs) wrongInterval++;
      }
    }
    if (misaligned > 0 || wrongInterval > 0) {
      console.log(`[CandleCache] MISALIGNED: ${symbol} ${timeframe} — ${misaligned}/${sampleSize} off-boundary, ${wrongInterval}/${sampleSize - 1} wrong-interval — purging & refetching`);
      try {
        await db.delete(labCandleCacheV2)
          .where(and(eq(labCandleCacheV2.symbol, symbol), eq(labCandleCacheV2.timeframe, timeframe)));
      } catch (err: any) {
        console.log(`[CandleCache] Purge error: ${err.message}`);
      }
      return null;
    }
  }

  const mapped = rows.map((r) => ({
    time: Number(r.time),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    provenance: {
      source: r.source,
      venue: r.venue,
      basis: r.basis,
      proxy: r.proxy,
      finality: r.finality,
      timeSemantic: r.timeSemantic,
    },
  }));
  if (phases.callerClass === "lab") {
    const identities = [...new Set(mapped.map(({ provenance: p }) =>
      `${p.source}/${p.venue}/${p.basis}/${p.proxy}/${p.finality}/${p.timeSemantic}`,
    ))].sort().join(",");
    console.log(`[CandleProvenance] ${symbol} ${timeframe} ${identities} bars=${mapped.length}`);
  }
  return mapped;
}

function getTimeframeSecondsForCache(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "45m": 2700,
    "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800,
  };
  return map[tf] || 3600;
}

// Backpressure for best-effort cache writes: callers fire-and-forget these,
// so a boundary burst (many markets fetched at once) could otherwise queue an
// unbounded number of INSERT jobs against the shared pool (max 8 connections).
// Cap concurrency and the wait queue; beyond that, drop the write — the cache
// is best-effort and the next fetch simply re-saves.
let activeCandleWrites = 0;
let queuedCandleWrites = 0;
const MAX_ACTIVE_CANDLE_WRITES = 2;
const MAX_QUEUED_CANDLE_WRITES = 12;

type CandleWriteJob = {
  symbol: string;
  timeframe: string;
  candles: Map<string, ProvenancedOHLCV>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  coalesced: boolean;
};

const candleWriteQueue: CandleWriteJob[] = [];
const pendingCandleWritesByIdentity = new Map<string, CandleWriteJob>();
const activeCandleWriteIdentities = new Set<string>();
let coalescedCandleWrites = 0;
let supersededCandleWrites = 0;
let droppedCandleWrites = 0;
let durablyConvergedCandleWrites = 0;

export class CandleWriteQueueFullError extends Error {
  readonly code = "candle_write_queue_full";
  readonly dropped: number;

  constructor(dropped: number) {
    super(`Candle write queue full — ${dropped} observation(s) were not admitted`);
    this.name = "CandleWriteQueueFullError";
    this.dropped = dropped;
  }
}

function candleWriteIdentity(symbol: string, timeframe: string, candle: ProvenancedOHLCV): string {
  const p = candle.provenance;
  return [
    symbol,
    timeframe,
    String(candle.time),
    p.source,
    p.venue,
    p.basis,
    p.proxy,
    p.finality,
    p.timeSemantic,
  ].join("\u001f");
}

function makeCandleWriteJob(
  symbol: string,
  timeframe: string,
  candles: Map<string, ProvenancedOHLCV>,
): CandleWriteJob {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { symbol, timeframe, candles, promise, resolve, reject, coalesced: false };
}

async function persistCandleWriteJob(job: CandleWriteJob): Promise<void> {
  const candles = [...job.candles.values()];
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < candles.length; i += batchSize) {
    const batch = candles.slice(i, i + batchSize);
    const values = batch.map((c) => ({
      symbol: job.symbol,
      timeframe: job.timeframe,
      time: String(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      source: c.provenance.source,
      venue: c.provenance.venue,
      basis: c.provenance.basis,
      proxy: c.provenance.proxy,
      finality: c.provenance.finality,
      timeSemantic: c.provenance.timeSemantic,
    }));
    await db
      .insert(labCandleCacheV2)
      .values(values)
      .onConflictDoUpdate({
        target: [
          labCandleCacheV2.symbol,
          labCandleCacheV2.timeframe,
          labCandleCacheV2.time,
          labCandleCacheV2.source,
          labCandleCacheV2.venue,
          labCandleCacheV2.basis,
          labCandleCacheV2.proxy,
          labCandleCacheV2.finality,
          labCandleCacheV2.timeSemantic,
        ],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
        },
      });
    inserted += batch.length;
  }
  console.log(`[CandleCache] Saved ${inserted} candles for ${job.symbol} ${job.timeframe}`);
}

function startCandleWriteJob(job: CandleWriteJob): void {
  activeCandleWrites++;
  for (const identity of job.candles.keys()) activeCandleWriteIdentities.add(identity);
  void (async () => {
    try {
      await persistCandleWriteJob(job);
      if (job.coalesced) durablyConvergedCandleWrites++;
      job.resolve();
    } catch (error) {
      console.log(`[CandleCache] Write error: ${error instanceof Error ? error.message : String(error)}`);
      job.reject(error);
    } finally {
      activeCandleWrites--;
      for (const identity of job.candles.keys()) activeCandleWriteIdentities.delete(identity);
      drainCandleWriteQueue();
    }
  })();
}

function drainCandleWriteQueue(): void {
  while (activeCandleWrites < MAX_ACTIVE_CANDLE_WRITES && candleWriteQueue.length > 0) {
    const index = candleWriteQueue.findIndex((job) =>
      [...job.candles.keys()].every((identity) => !activeCandleWriteIdentities.has(identity))
    );
    if (index < 0) return;
    const [job] = candleWriteQueue.splice(index, 1);
    queuedCandleWrites = candleWriteQueue.length;
    for (const identity of job.candles.keys()) {
      if (pendingCandleWritesByIdentity.get(identity) === job) {
        pendingCandleWritesByIdentity.delete(identity);
      }
    }
    startCandleWriteJob(job);
  }
}

export async function saveCandlesToDb(
  symbol: string,
  timeframe: string,
  candles: ProvenancedOHLCV[]
): Promise<void> {
  await requireCandleCacheSchema();
  if (candles.length === 0) return;
  const newestByIdentity = new Map<string, ProvenancedOHLCV>();
  for (const candle of candles) {
    newestByIdentity.set(candleWriteIdentity(symbol, timeframe, candle), candle);
  }

  const waits = new Set<Promise<void>>();
  const unmerged = new Map<string, ProvenancedOHLCV>();
  for (const [identity, candle] of newestByIdentity) {
    const pending = pendingCandleWritesByIdentity.get(identity);
    if (!pending) {
      unmerged.set(identity, candle);
      continue;
    }
    pending.candles.set(identity, candle);
    pending.coalesced = true;
    coalescedCandleWrites++;
    supersededCandleWrites++;
    waits.add(pending.promise);
  }

  let droppedError: CandleWriteQueueFullError | null = null;
  if (unmerged.size > 0) {
    const conflictsWithActive = [...unmerged.keys()].some((identity) =>
      activeCandleWriteIdentities.has(identity)
    );
    const canStartNow = activeCandleWrites < MAX_ACTIVE_CANDLE_WRITES
      && candleWriteQueue.length === 0
      && !conflictsWithActive;
    if (canStartNow) {
      const job = makeCandleWriteJob(symbol, timeframe, unmerged);
      waits.add(job.promise);
      startCandleWriteJob(job);
    } else if (candleWriteQueue.length < MAX_QUEUED_CANDLE_WRITES) {
      const job = makeCandleWriteJob(symbol, timeframe, unmerged);
      candleWriteQueue.push(job);
      queuedCandleWrites = candleWriteQueue.length;
      for (const identity of unmerged.keys()) pendingCandleWritesByIdentity.set(identity, job);
      waits.add(job.promise);
      drainCandleWriteQueue();
    } else {
      droppedCandleWrites += unmerged.size;
      droppedError = new CandleWriteQueueFullError(unmerged.size);
      const wqLine = `[CandleCache] Write queue full — dropping ${unmerged.size} observation(s) for ${symbol} ${timeframe}`;
      console.log(wqLine);
      appendTelemetry(wqLine);
    }
  }

  await Promise.all(waits);
  if (droppedError) throw droppedError;
}

export async function getCacheStats(): Promise<{
  totalCandles: number;
  symbols: number;
  estimatedSizeMb: number;
}> {
  await requireCandleCacheSchema();
  try {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(labCandleCacheV2);
    const symbolResult = await db
      .select({ count: sql<number>`count(distinct ${labCandleCacheV2.symbol})` })
      .from(labCandleCacheV2);
    const totalCandles = Number(countResult[0]?.count ?? 0);
    const symbols = Number(symbolResult[0]?.count ?? 0);
    const estimatedSizeMb = Math.round((totalCandles * 130) / (1024 * 1024) * 100) / 100;
    return { totalCandles, symbols, estimatedSizeMb };
  } catch {
    return { totalCandles: 0, symbols: 0, estimatedSizeMb: 0 };
  }
}

export async function clearCandleCache(): Promise<number> {
  await requireCandleCacheSchema();
  // Full-table delete over ~2M rows can exceed BOTH timeouts: the pool's 30s
  // server-side statement_timeout AND the pool-level 60s client-side
  // query_timeout (see server/db.ts — added after the 2026-07-19 pool-wedge
  // incident). This is a rare admin operation, so widen both for this
  // transaction only: SET LOCAL lifts the server timeout, and a per-query
  // `query_timeout` override widens the client one to 15 minutes. NOTE: the
  // override MUST be a truthy finite number — pg reads it as
  // `config.query_timeout || pool default`, so `0` is silently ignored.
  // Uses a raw checked-out client because drizzle does not expose per-query
  // timeout overrides.
  //
  // Release discipline: on ANY error, release WITH the error so pg-pool
  // destroys the client instead of recycling it — after a client-side
  // timeout the server may still be executing the DELETE on that socket,
  // and returning a busy client to the pool is exactly the poisoned-client
  // failure class the 2026-07-19 patch exists to kill.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    const result = await client.query({
      text: "DELETE FROM lab_candle_cache_v2",
      query_timeout: 15 * 60_000,
    } as any);
    await client.query("COMMIT");
    client.release();
    return result.rowCount ?? 0;
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
