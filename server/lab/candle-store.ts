import { labCandleCache } from "@shared/schema";
import { db, pool } from "../db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import type { OHLCV } from "./engine";
import { appendTelemetry } from "../telemetry";
import { registerPoolLoadTag } from "../pool-load";

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

function poolSnapshot(): { total: number; idle: number; waiting: number } {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

// Marker attached as AbortSignal.reason by fetchOHLCV's cache-budget timer so
// this module can classify budget expiry ("deadline") separately from caller
// cancellation ("cancelled", e.g. sweep teardown).
export const CACHE_BUDGET_ABORT_REASON = "candle-cache-budget-exceeded";

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
}));

/** Test/telemetry snapshot of candle-store pool pressure. */
export function getCandleStoreLoad() {
  return {
    activeReads: activeCandleReads,
    queuedReads: queuedCandleReads,
    activeWrites: activeCandleWrites,
    queuedWrites: queuedCandleWrites,
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
};

export type GetCachedCandlesOpts = {
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

export async function getCachedCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  opts?: GetCachedCandlesOpts
): Promise<OHLCV[] | null> {
  const startedAt = Date.now();
  const signal = opts?.signal;
  const phases: CandleReadPhases = {
    callerClass: opts?.callerClass ?? "lab",
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
      opts?.onPhases?.(phases);
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
    if (err?.name === "AbortError") {
      finish(abortOutcome());
      throw err; // typed cancellation propagates to fetchOHLCV's classifier
    }
    // Fail-open (historical contract): a non-abort read error is a cache
    // miss — deadline-less callers (Lab) fall through to the network.
    console.log(`[CandleCache] Read error: ${err?.message ?? err}`);
    finish("query_error");
    return null;
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
  phases: CandleReadPhases
): Promise<PoolClient> {
  const acquireStart = Date.now();
  if (isSignalAborted(signal)) {
    phases.poolAcquireMs = 0;
    throw makeAbortError(signal!.reason);
  }
  if (!signal) {
    const client = await pool.connect();
    phases.poolAcquireMs = Date.now() - acquireStart;
    return client;
  }
  const checkout = pool.connect();
  const client = await new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      // Self-releasing orphan: return the client to the pool untouched the
      // moment the checkout lands (clean release — no query ever ran on it).
      checkout.then((c) => c.release()).catch(() => {});
      reject(makeAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    checkout.then(
      (c) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return; // abort won the race; client released above
        settled = true;
        resolve(c);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
  phases.poolAcquireMs = Date.now() - acquireStart;
  return client;
}

async function getCachedCandlesInner(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  opts: GetCachedCandlesOpts | undefined,
  phases: CandleReadPhases
): Promise<OHLCV[] | null> {
  const signal = opts?.signal;
  let rows: CandleCacheRow[];
  const queryTimeoutMs = opts?.queryTimeoutMs;
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
          "SELECT time, open, high, low, close, volume FROM lab_candle_cache " +
          "WHERE symbol = $1 AND timeframe = $2 AND time >= $3 AND time <= $4 " +
          "ORDER BY time",
        values: [symbol, timeframe, String(startMs), String(endMs)],
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
      .from(labCandleCache)
      .where(
        and(
          eq(labCandleCache.symbol, symbol),
          eq(labCandleCache.timeframe, timeframe),
          gte(labCandleCache.time, String(startMs)),
          lte(labCandleCache.time, String(endMs))
        )
      )
      .orderBy(labCandleCache.time);
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
  phases: CandleReadPhases
): Promise<OHLCV[] | null> {
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
  if (tailGapCandles > 3) {
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
        await db.delete(labCandleCache)
          .where(and(eq(labCandleCache.symbol, symbol), eq(labCandleCache.timeframe, timeframe)));
      } catch (err: any) {
        console.log(`[CandleCache] Purge error: ${err.message}`);
      }
      return null;
    }
  }

  return rows.map((r) => ({
    time: Number(r.time),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
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

export async function saveCandlesToDb(
  symbol: string,
  timeframe: string,
  candles: OHLCV[]
): Promise<void> {
  if (candles.length === 0) return;
  if (activeCandleWrites >= MAX_ACTIVE_CANDLE_WRITES) {
    if (queuedCandleWrites >= MAX_QUEUED_CANDLE_WRITES) {
      const wqLine = `[CandleCache] Write queue full — dropping best-effort save of ${candles.length} candles for ${symbol} ${timeframe}`;
      console.log(wqLine);
      appendTelemetry(wqLine);
      return;
    }
    queuedCandleWrites++;
    try {
      while (activeCandleWrites >= MAX_ACTIVE_CANDLE_WRITES) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      queuedCandleWrites--;
    }
  }
  activeCandleWrites++;
  try {
    const batchSize = 500;
    let inserted = 0;
    for (let i = 0; i < candles.length; i += batchSize) {
      const batch = candles.slice(i, i + batchSize);
      const values = batch.map((c) => ({
        symbol,
        timeframe,
        time: String(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      await db
        .insert(labCandleCache)
        .values(values)
        .onConflictDoNothing();
      inserted += batch.length;
    }
    console.log(`[CandleCache] Saved ${inserted} candles for ${symbol} ${timeframe}`);
  } catch (err: any) {
    console.log(`[CandleCache] Write error: ${err.message}`);
  } finally {
    activeCandleWrites--;
  }
}

export async function getCacheStats(): Promise<{
  totalCandles: number;
  symbols: number;
  estimatedSizeMb: number;
}> {
  try {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(labCandleCache);
    const symbolResult = await db
      .select({ count: sql<number>`count(distinct ${labCandleCache.symbol})` })
      .from(labCandleCache);
    const totalCandles = Number(countResult[0]?.count ?? 0);
    const symbols = Number(symbolResult[0]?.count ?? 0);
    const estimatedSizeMb = Math.round((totalCandles * 130) / (1024 * 1024) * 100) / 100;
    return { totalCandles, symbols, estimatedSizeMb };
  } catch {
    return { totalCandles: 0, symbols: 0, estimatedSizeMb: 0 };
  }
}

export async function clearCandleCache(): Promise<number> {
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
      text: "DELETE FROM lab_candle_cache",
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
