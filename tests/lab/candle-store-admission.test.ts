// 2026-07-20 incident regression tests: cancellation-aware admission in
// server/lab/candle-store.ts (getCachedCandles). The old Promise.race in the
// datafeed abandoned slow cache reads but LEFT THEM RUNNING — an abandoned
// read could still queue at the semaphore, wait 30s at pool.connect(), and
// run its SELECT long after the caller had moved on, zombie-holding pool
// connections during exactly the DB-pressure window that caused the outage.
//
// Invariants pinned here:
//   A. A pre-aborted signal short-circuits BEFORE any pool contact.
//   B. Abort while waiting on pool.connect() unblocks the caller promptly;
//      the late checkout self-releases its client and NO query ever runs.
//   C. Abort while queued at the read semaphore removes the waiter promptly
//      and never touches the pool.
//   D. Abort raced by a completing SELECT still honors the abort (typed
//      AbortError) and releases the client cleanly.
//   E. Outcome classification: reason CACHE_BUDGET_ABORT_REASON → "deadline",
//      any other reason → "cancelled" (phase telemetry drives incident
//      attribution from this).

import { describe, it, expect, beforeEach, vi } from "vitest";

const { fakePool, fakeScannerPool, fakeDb } = vi.hoisted(() => ({
  fakePool: {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query: vi.fn(),
    connect: vi.fn<() => Promise<unknown>>(),
  },
  fakeScannerPool: {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query: vi.fn(),
    connect: vi.fn<() => Promise<unknown>>(),
  },
  fakeDb: { insert: vi.fn() },
}));

vi.mock("../../server/db", () => ({
  db: fakeDb,
  pool: fakePool,
  scannerCandlePool: fakeScannerPool,
}));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: vi.fn() }));

import {
  getCachedCandles,
  getCachedCandlesBatch,
  saveCandlesToDb,
  getCacheStats,
  clearCandleCache,
  getCandleStoreLoad,
  CandleWriteQueueFullError,
  CandleBatchReadError,
  CACHE_BUDGET_ABORT_REASON,
  SCANNER_BATCH_POOL_ACQUIRE_TIMEOUT_MS,
  SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
  SCANNER_BATCH_SYMBOL_CHUNK_SIZE,
  type CandleReadPhases,
  type CandleBatchReadPhases,
} from "../../server/lab/candle-store";
import type { CandleFinality, ProvenancedOHLCV } from "../../server/lab/datafeed";
import {
  SchemaCapabilityUnavailableError,
  registerSchemaMigrationManifest,
  resetSchemaReadinessForTests,
  type SchemaMigrationDefinition,
} from "../../server/schema-readiness";

const LAB_READINESS_MANIFEST: readonly SchemaMigrationDefinition[] = [
  {
    id: "000-lab-table",
    sql: "CREATE TABLE lab_candle_cache_v2",
    capabilities: ["lab_scanner"],
    operation: "ddl",
    requirements: [{
      kind: "table",
      table: "lab_candle_cache_v2",
      columns: ["id", "symbol", "timeframe"],
      constraintDefinitions: ["PRIMARY KEY (id)"],
    }],
  },
  {
    id: "001-lab-identity-index",
    sql: "CREATE UNIQUE INDEX lab_candle_cache_v2_identity_unique",
    capabilities: ["lab_scanner"],
    operation: "ddl",
    requirements: [{
      kind: "index",
      table: "lab_candle_cache_v2",
      index: "lab_candle_cache_v2_identity_unique",
      columns: ["symbol", "timeframe"],
      unique: true,
    }],
  },
  {
    id: "002-lab-lookup-index",
    sql: "CREATE INDEX lab_candle_cache_v2_lookup",
    capabilities: ["lab_scanner"],
    operation: "ddl",
    requirements: [{
      kind: "index",
      table: "lab_candle_cache_v2",
      index: "lab_candle_cache_v2_lookup",
      columns: ["symbol", "timeframe"],
      unique: false,
    }],
  },
];

function installSuccessfulCatalog(): void {
  fakePool.query.mockImplementation(async (text: string, values?: readonly unknown[]) => {
    if (text.includes("to_regclass")) return { rows: [{ relation: "lab_candle_cache_v2" }] };
    if (text.includes("information_schema.columns")) {
      return { rows: [{ column_name: "id" }, { column_name: "symbol" }, { column_name: "timeframe" }] };
    }
    if (text.includes("pg_get_constraintdef")) return { rows: [{ definition: "PRIMARY KEY (id)" }] };
    if (text.includes("FROM pg_index")) {
      const index = String(values?.[0]);
      return { rows: [{
        table_name: "lab_candle_cache_v2",
        is_unique: index === "lab_candle_cache_v2_identity_unique",
        predicate: null,
        columns: ["symbol", "timeframe"],
      }] };
    }
    throw new Error(`unexpected readiness query: ${text}`);
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const RANGE = { start: 0, end: 3_600_000 } as const;
const TEST_BASIS_POLICY = {
  consumer: "lab" as const,
  acceptedBasis: ["perp"] as const,
  acceptedFinality: ["finalized"] as const,
  acceptedProxy: ["direct"] as const,
};

function read(
  signal: AbortSignal | undefined,
  onPhases?: (p: CandleReadPhases) => void,
  symbol = "BTC-PERP",
) {
  return getCachedCandles(symbol, "1h", RANGE.start, RANGE.end, {
    basisPolicy: TEST_BASIS_POLICY,
    queryTimeoutMs: 500,
    signal,
    callerClass: "scanner",
    onPhases,
  });
}

beforeEach(() => {
  resetSchemaReadinessForTests();
  registerSchemaMigrationManifest(LAB_READINESS_MANIFEST);
  fakePool.query.mockReset();
  installSuccessfulCatalog();
  fakePool.connect.mockReset();
  fakeScannerPool.query.mockReset();
  fakeScannerPool.connect.mockReset();
  fakeScannerPool.totalCount = 0;
  fakeScannerPool.idleCount = 0;
  fakeScannerPool.waitingCount = 0;
});

function candle(
  time: number,
  close: number,
  finality: CandleFinality = "finalized",
): ProvenancedOHLCV {
  return {
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10,
    provenance: {
      source: "okx",
      venue: "okx",
      basis: "perp",
      proxy: "direct",
      finality,
      timeSemantic: "open_time",
    },
  };
}

function insertTerminal(result: Promise<void> | void = undefined) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue(result),
    }),
  };
}

async function waitForLoad(predicate: (load: ReturnType<typeof getCandleStoreLoad>) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const load = getCandleStoreLoad();
    if (predicate(load)) return load;
    await tick();
  }
  throw new Error(`candle-write load did not converge: ${JSON.stringify(getCandleStoreLoad())}`);
}

describe("candle write queue convergence", () => {
  beforeEach(async () => {
    await waitForLoad((load) => load.activeWrites === 0 && load.queuedWrites === 0);
    fakeDb.insert.mockReset();
  });

  it("coalesces more than twelve updates for one cold key and persists the newest", async () => {
    const activeA = deferred<void>();
    const activeB = deferred<void>();
    const persisted: unknown[][] = [];
    fakeDb.insert
      .mockReturnValueOnce(insertTerminal(activeA.promise))
      .mockReturnValueOnce(insertTerminal(activeB.promise))
      .mockImplementation(() => {
        const terminal = vi.fn().mockResolvedValue(undefined);
        return {
          values: vi.fn((rows: unknown[]) => {
            persisted.push(rows);
            return { onConflictDoUpdate: terminal };
          }),
        };
      });

    const occupyingA = saveCandlesToDb("ACTIVE-A", "1h", [candle(1, 1)]);
    const occupyingB = saveCandlesToDb("ACTIVE-B", "1h", [candle(2, 2)]);
    await waitForLoad((load) => load.activeWrites === 2);

    const coalescedBefore = getCandleStoreLoad().coalescedWrites;
    const updates = Array.from({ length: 16 }, (_, index) =>
      saveCandlesToDb("COLD", "1h", [candle(3, 100 + index)])
    );
    await waitForLoad((load) =>
      load.activeWrites + load.queuedWrites + (load.coalescedWrites - coalescedBefore) === 18
    );
    expect(getCandleStoreLoad().queuedWrites).toBe(1);
    expect(getCandleStoreLoad().coalescedWrites).toBeGreaterThanOrEqual(15);

    activeA.resolve();
    activeB.resolve();
    await Promise.all([occupyingA, occupyingB, ...updates]);
    const coldRows = persisted.flat().filter((row: any) => row.symbol === "COLD") as any[];
    expect(coldRows).toHaveLength(1);
    expect(coldRows[0].close).toBe(115);
    expect(getCandleStoreLoad().durablyConvergedWrites).toBeGreaterThanOrEqual(1);
  });

  it("drops excess distinct keys with truthful accounting", async () => {
    const activeA = deferred<void>();
    const activeB = deferred<void>();
    fakeDb.insert
      .mockReturnValueOnce(insertTerminal(activeA.promise))
      .mockReturnValueOnce(insertTerminal(activeB.promise))
      .mockImplementation(() => insertTerminal(Promise.resolve()));

    const occupyingA = saveCandlesToDb("ACTIVE-A", "1h", [candle(10, 1)]);
    const occupyingB = saveCandlesToDb("ACTIVE-B", "1h", [candle(11, 2)]);
    await waitForLoad((load) => load.activeWrites === 2);
    const admitted = Array.from({ length: 12 }, (_, index) =>
      saveCandlesToDb(`KEY-${index}`, "1h", [candle(20 + index, index)])
    );
    const before = getCandleStoreLoad().droppedWrites;
    await expect(saveCandlesToDb("EXCESS", "1h", [candle(99, 99)]))
      .rejects.toBeInstanceOf(CandleWriteQueueFullError);
    expect(getCandleStoreLoad().queuedWrites).toBe(12);
    expect(getCandleStoreLoad().droppedWrites).toBe(before + 1);

    activeA.resolve();
    activeB.resolve();
    await Promise.all([occupyingA, occupyingB, ...admitted]);
  });

  it("drains an admitted cold key despite repeated hot-key replacement", async () => {
    const activeA = deferred<void>();
    const activeB = deferred<void>();
    const order: string[] = [];
    fakeDb.insert
      .mockReturnValueOnce(insertTerminal(activeA.promise))
      .mockReturnValueOnce(insertTerminal(activeB.promise))
      .mockImplementation(() => ({
        values: vi.fn((rows: any[]) => ({
          onConflictDoUpdate: vi.fn(async () => { order.push(rows[0].symbol); }),
        })),
      }));

    const occupyingA = saveCandlesToDb("ACTIVE-A", "1h", [candle(100, 1)]);
    const occupyingB = saveCandlesToDb("ACTIVE-B", "1h", [candle(101, 2)]);
    await waitForLoad((load) => load.activeWrites === 2);
    const hot = saveCandlesToDb("HOT", "1h", [candle(102, 1)]);
    const cold = saveCandlesToDb("COLD", "1h", [candle(103, 1)]);
    const coalescedBefore = getCandleStoreLoad().coalescedWrites;
    const replacements = Array.from({ length: 20 }, (_, index) =>
      saveCandlesToDb("HOT", "1h", [candle(102, 2 + index)])
    );
    await waitForLoad((load) =>
      load.activeWrites + load.queuedWrites + (load.coalescedWrites - coalescedBefore) === 24
    );

    activeA.resolve();
    activeB.resolve();
    await Promise.all([occupyingA, occupyingB, hot, cold, ...replacements]);
    expect(order).toEqual(["HOT", "COLD"]);
  });

  it("keeps forming and finalized identities separate", async () => {
    const activeA = deferred<void>();
    const activeB = deferred<void>();
    const finalities: string[] = [];
    fakeDb.insert
      .mockReturnValueOnce(insertTerminal(activeA.promise))
      .mockReturnValueOnce(insertTerminal(activeB.promise))
      .mockImplementation(() => ({
        values: vi.fn((rows: any[]) => ({
          onConflictDoUpdate: vi.fn(async () => { finalities.push(rows[0].finality); }),
        })),
      }));

    const occupyingA = saveCandlesToDb("ACTIVE-A", "1h", [candle(200, 1)]);
    const occupyingB = saveCandlesToDb("ACTIVE-B", "1h", [candle(201, 2)]);
    await waitForLoad((load) => load.activeWrites === 2);
    const forming = saveCandlesToDb("BAR", "1h", [candle(202, 10, "forming")]);
    const finalized = saveCandlesToDb("BAR", "1h", [candle(202, 11, "finalized")]);
    // Async readiness makes mid-flight queue depth unobservable without a
    // tautological wait. Exact finality order below proves both entries stayed
    // distinct; the settled drain assertions prove durable convergence.

    activeA.resolve();
    activeB.resolve();
    await Promise.all([occupyingA, occupyingB, forming, finalized]);
    expect(finalities).toEqual(["forming", "finalized"]);
    expect(getCandleStoreLoad().activeWrites).toBe(0);
    expect(getCandleStoreLoad().queuedWrites).toBe(0);
  });
});

describe("getCachedCandles — cancellation-aware admission", () => {
  it("fails all DB-touching entry points before business pool/semaphore work when child readiness is absent", async () => {
    fakePool.query.mockImplementation(async (text: string) => {
      if (text.includes("to_regclass")) return { rows: [{ relation: null }] };
      return { rows: [] };
    });

    await expect(read(undefined)).rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    await expect(saveCandlesToDb("BTC-PERP", "1h", [])).rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    await expect(getCacheStats()).rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    await expect(clearCandleCache()).rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(getCandleStoreLoad()).toMatchObject({ activeReads: 0, activeWrites: 0 });
  });

  it("A: pre-aborted signal fails typed BEFORE any pool contact, outcome=deadline for budget reason", async () => {
    const ctrl = new AbortController();
    ctrl.abort(CACHE_BUDGET_ABORT_REASON);
    let phases: CandleReadPhases | undefined;
    await expect(read(ctrl.signal, (p) => (phases = p))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(phases?.outcome).toBe("deadline");
  });

  it("B: abort during a pending pool.connect() unblocks promptly; late checkout self-releases, query NEVER runs", async () => {
    const checkout = deferred<unknown>();
    fakePool.connect.mockReturnValueOnce(checkout.promise);
    const ctrl = new AbortController();
    let phases: CandleReadPhases | undefined;

    const p = read(ctrl.signal, (ph) => (phases = ph));
    await tick(); // reach the pool checkout
    expect(fakePool.connect).toHaveBeenCalledTimes(1);

    ctrl.abort("sweep-teardown"); // non-budget reason
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(phases?.outcome).toBe("cancelled");

    // The checkout lands AFTER the caller already failed: the client must be
    // returned to the pool untouched.
    const release = vi.fn();
    const query = vi.fn();
    checkout.resolve({ release, query });
    await tick();
    expect(release).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it("C: abort while queued at the read semaphore removes the waiter promptly and never touches the pool", async () => {
    // Saturate the 3 read slots with reads parked on pending checkouts.
    const holds = [0, 1, 2].map(() => deferred<unknown>());
    holds.forEach((d) => fakePool.connect.mockReturnValueOnce(d.promise));
    const holdCtrls = holds.map(() => new AbortController());
    const holdReads = holds.map((_, i) =>
      read(holdCtrls[i].signal, undefined, `HOLD-${i}`).catch(() => {}),
    );
    await tick();
    expect(getCandleStoreLoad().activeReads).toBe(3);

    const ctrl = new AbortController();
    let phases: CandleReadPhases | undefined;
    const queued = read(ctrl.signal, (p) => (phases = p), "QUEUED");
    await tick();
    expect(getCandleStoreLoad().queuedReads).toBe(1);

    ctrl.abort(CACHE_BUDGET_ABORT_REASON);
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(phases?.outcome).toBe("deadline");
    expect(getCandleStoreLoad().queuedReads).toBe(0);
    // Only the 3 slot-holders ever reached the pool.
    expect(fakePool.connect).toHaveBeenCalledTimes(3);

    // Cleanup: release the slot-holders so module counters return to zero.
    holdCtrls.forEach((c) => c.abort("test-cleanup"));
    await Promise.all(holdReads);
    expect(getCandleStoreLoad().activeReads).toBe(0);
  });

  it("D: abort raced by a completing SELECT still fails typed and releases the client cleanly", async () => {
    const release = vi.fn();
    const query = deferred<{ rows: unknown[] }>();
    fakePool.connect.mockResolvedValueOnce({
      release,
      query: vi.fn().mockReturnValueOnce(query.promise),
    });
    const ctrl = new AbortController();
    let phases: CandleReadPhases | undefined;

    const p = read(ctrl.signal, (ph) => (phases = ph));
    await tick(); // SELECT in flight
    ctrl.abort(CACHE_BUDGET_ABORT_REASON);
    query.resolve({ rows: [] }); // SELECT completes just after the budget fired

    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(phases?.outcome).toBe("deadline");
    // Clean release (no error argument): the socket is reusable — pg only
    // destroys the client when release() receives an error.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });

  it("F (WO-10): pool checkout fails with non-AbortError, signal present and not yet aborted → re-throws (not null); semaphore decremented; outcome=query_error", async () => {
    // Verifies: operational failures (pool, connection, query-timeout) are
    // re-thrown for deadline-bounded callers instead of being swallowed to null.
    const checkoutErr = new Error("Pool checkout timeout");
    fakePool.connect.mockRejectedValueOnce(checkoutErr);
    const ctrl = new AbortController(); // signal present but NOT aborted
    let phases: CandleReadPhases | undefined;

    await expect(read(ctrl.signal, (p) => (phases = p))).rejects.toThrow("Pool checkout timeout");
    expect(phases?.outcome).toBe("query_error");
    // Semaphore must be released (counter returns to zero).
    expect(getCandleStoreLoad().activeReads).toBe(0);
    // Pool was contacted exactly once (checkout was attempted).
    expect(fakePool.connect).toHaveBeenCalledTimes(1);
  });

  it("G (WO-10): budget signal fires while query pending, query then rejects with plain Error → AbortError (signal-state wins); client released-with-error", async () => {
    // Verifies: a non-AbortError exception is reclassified as the governing
    // signal's outcome when that signal has already fired — the error name is
    // NOT authoritative once the signal state is known.
    const release = vi.fn();
    const queryDef = deferred<{ rows: unknown[] }>();
    fakePool.connect.mockResolvedValueOnce({
      release,
      query: vi.fn().mockReturnValueOnce(queryDef.promise),
    });
    const ctrl = new AbortController();
    let phases: CandleReadPhases | undefined;

    const p = read(ctrl.signal, (ph) => (phases = ph));
    p.catch(() => {}); // suppress unhandled-rejection before expect() adds its handler
    await tick(); // SELECT is now in-flight

    // Fire the budget signal FIRST, then reject the query with a plain Error.
    ctrl.abort(CACHE_BUDGET_ABORT_REASON);
    queryDef.reject(new Error("DB reset connection"));
    await tick();

    // The caller must see AbortError (signal-state wins over error name).
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(phases?.outcome).toBe("deadline");
    // The query failed, so the client must be released WITH an error so
    // pg-pool destroys the suspect connection instead of recycling it.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
    // Semaphore must be decremented.
    expect(getCandleStoreLoad().activeReads).toBe(0);
  });

  it("E: signal-free reads keep the historical contract — empty result is a miss, client released", async () => {
    const release = vi.fn();
    fakePool.connect.mockResolvedValueOnce({
      release,
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    });
    let phases: CandleReadPhases | undefined;
    const result = await getCachedCandles("BTC-PERP", "1h", RANGE.start, RANGE.end, {
      basisPolicy: TEST_BASIS_POLICY,
      queryTimeoutMs: 500,
      callerClass: "lab",
      onPhases: (p) => (phases = p),
    });
    expect(result).toBeNull();
    expect(phases?.outcome).toBe("miss");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("getCachedCandlesBatch — scanner universe admission", () => {
  const row = (symbol: string, finality: CandleFinality = "finalized", close = 10) => ({
    symbol,
    time: "3600000",
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10,
    source: "okx",
    venue: "okx",
    basis: "perp",
    proxy: "direct",
    finality,
    timeSemantic: "open_time",
  });

  it("uses one exact-bounded SELECT for deduplicated symbols and returns explicit misses", async () => {
    const release = vi.fn();
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = vi.fn()
      .mockImplementationOnce(async () => { now += 100; return { rows: [] }; })
      .mockImplementationOnce(async () => { now += 7; return { rows: [row("BTC-PERP")] }; })
      .mockImplementationOnce(async () => { now += 200; return { rows: [] }; });
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });
    let phases: CandleBatchReadPhases | undefined;

    const result = await getCachedCandlesBatch(
      ["BTC-PERP", "SOL-PERP", "BTC-PERP"], "1h", RANGE.start, RANGE.end,
      {
        basisPolicy: TEST_BASIS_POLICY,
        queryTimeoutMs: 5_000,
        callerClass: "scanner",
        onPhases: (value) => (phases = value),
      },
    );

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toMatchObject({
      text: "SELECT set_config('statement_timeout', $1, false)",
      values: ["5000"],
      query_timeout: SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
    });
    const queryConfig = query.mock.calls[1][0];
    expect(queryConfig.query_timeout).toBe(SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS);
    expect(SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(queryConfig.text).toContain('time_semantic AS "timeSemantic"');
    expect(queryConfig.text).toContain("basis = $5 AND finality = $6 AND proxy = $7");
    expect(queryConfig.text).not.toContain("basis = ANY($5::text[])");
    expect(queryConfig.text).not.toMatch(/time_semantic AS\s+imeSemantic\b/);
    expect(queryConfig.values.slice(0, 4)).toEqual([
      ["BTC-PERP", "SOL-PERP"], "1h", "0", "3600000",
    ]);
    expect(queryConfig.values.slice(4, 7)).toEqual(["perp", "finalized", "direct"]);
    expect(query.mock.calls[2][0]).toMatchObject({
      text: "SELECT set_config('statement_timeout', '30000', false)",
      query_timeout: SCANNER_BATCH_CLIENT_QUERY_TIMEOUT_MS,
    });
    const dataStatements = query.mock.calls.filter(([value]) =>
      typeof value === "object" && value !== null && String(value.text).includes("FROM lab_candle_cache_v2")
    );
    expect(dataStatements).toHaveLength(1);
    expect(result.get("BTC-PERP")?.[0].close).toBe(10);
    expect(result.get("SOL-PERP")).toBeNull();
    expect(phases).toMatchObject({ poolLane: "scanner-candle", requestedSymbols: 2, hits: 1, misses: 1, outcome: "hit", termination: "success", sqlstate: null, queryMs: 7 });
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
    nowSpy.mockRestore();
  });

  it("retains ANY predicates for a genuinely multi-valued admission policy", async () => {
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });

    await getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      {
        basisPolicy: {
          ...TEST_BASIS_POLICY,
          acceptedFinality: ["finalized", "forming"] as const,
        },
        queryTimeoutMs: 5_000,
        callerClass: "scanner",
      },
    );

    const queryConfig = query.mock.calls[1][0];
    expect(queryConfig.text).toContain(
      "basis = ANY($5::text[]) AND finality = ANY($6::text[]) AND proxy = ANY($7::text[])",
    );
    expect(queryConfig.values.slice(4, 7)).toEqual([
      ["perp"], ["finalized", "forming"], ["direct"],
    ]);
    expect(release).toHaveBeenCalledWith();
  });

  it("bounds each wire result to ten symbols, yields between chunks, and aggregates under one batch", async () => {
    const symbols = Array.from({ length: 21 }, (_, index) => `M${index}-PERP`);
    const release = vi.fn();
    const query = vi.fn(async (config: { text: string; values?: unknown[] }) => {
      if (!config.text.includes("FROM lab_candle_cache_v2")) return { rows: [] };
      const chunk = config.values?.[0] as string[];
      return { rows: chunk.map((symbol, index) => row(symbol, "finalized", index + 1)) };
    });
    const immediateSpy = vi.spyOn(globalThis, "setImmediate");
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });
    let phases: CandleBatchReadPhases | undefined;

    const result = await getCachedCandlesBatch(
      symbols, "1h", RANGE.start, RANGE.end,
      { basisPolicy: TEST_BASIS_POLICY, queryTimeoutMs: 5_000, callerClass: "scanner", onPhases: (value) => (phases = value) },
    );

    const dataStatements = query.mock.calls.filter(([value]) => value.text.includes("FROM lab_candle_cache_v2"));
    expect(SCANNER_BATCH_SYMBOL_CHUNK_SIZE).toBe(10);
    expect(dataStatements.map(([value]) => (value.values?.[0] as string[]).length)).toEqual([10, 10, 1]);
    expect(immediateSpy).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(21);
    expect(phases).toMatchObject({ requestedSymbols: 21, chunks: 3, hits: 21, misses: 0, termination: "success" });
    expect(release).toHaveBeenCalledWith();
    immediateSpy.mockRestore();
  });

  it("shares one absolute deadline across chunks and destroys the client before starting an expired chunk", async () => {
    const symbols = Array.from({ length: 11 }, (_, index) => `M${index}-PERP`);
    const release = vi.fn();
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = vi.fn(async (config: { text: string }) => {
      if (config.text.includes("FROM lab_candle_cache_v2")) now += 5_001;
      return { rows: [] };
    });
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });
    let phases: CandleBatchReadPhases | undefined;

    await expect(getCachedCandlesBatch(
      symbols, "1h", RANGE.start, RANGE.end,
      { basisPolicy: TEST_BASIS_POLICY, queryTimeoutMs: 5_000, callerClass: "scanner", onPhases: (value) => (phases = value) },
    )).rejects.toBeInstanceOf(CandleBatchReadError);

    const dataStatements = query.mock.calls.filter(([value]) => value.text.includes("FROM lab_candle_cache_v2"));
    expect(dataStatements).toHaveLength(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ message: "Query read timeout" }));
    expect(phases).toMatchObject({ requestedSymbols: 11, chunks: 1, termination: "client_query_timeout" });
    nowSpy.mockRestore();
  });

  it("preserves per-symbol strongest-finality semantics", async () => {
    fakeScannerPool.connect.mockResolvedValueOnce({
      release: vi.fn(),
      query: vi.fn().mockResolvedValue({
        rows: [row("BTC-PERP", "forming", 9), row("BTC-PERP", "finalized", 11)],
      }),
    });

    const result = await getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      { basisPolicy: TEST_BASIS_POLICY, queryTimeoutMs: 5_000, callerClass: "scanner" },
    );
    expect(result.get("BTC-PERP")).toMatchObject([
      { close: 11, provenance: { finality: "finalized" } },
    ]);
  });

  it("keeps a 7-bar stale tail fail-closed by default but admits it only as an explicit scanner prefix", async () => {
    const tfMs = 15 * 60 * 1000;
    const startMs = 0;
    const endMs = 100 * tfMs;
    const rows = Array.from({ length: 94 }, (_, index) => ({
      ...row("BTC-PERP"),
      time: String(index * tfMs),
    }));
    const client = () => ({
      release: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows }),
    });
    fakeScannerPool.connect.mockResolvedValueOnce(client()).mockResolvedValueOnce(client());

    const ordinary = await getCachedCandlesBatch(
      ["BTC-PERP"], "15m", startMs, endMs,
      {
        basisPolicy: TEST_BASIS_POLICY,
        queryTimeoutMs: 5_000,
        callerClass: "scanner",
      },
    );
    const prefix = await getCachedCandlesBatch(
      ["BTC-PERP"], "15m", startMs, endMs,
      {
        basisPolicy: TEST_BASIS_POLICY,
        queryTimeoutMs: 5_000,
        callerClass: "scanner",
        admission: "scanner_prefix",
      },
    );

    expect(ordinary.get("BTC-PERP")).toBeNull();
    expect(prefix.get("BTC-PERP")).toHaveLength(94);
  });

  it("honors caller cancellation before checkout and during a pending checkout", async () => {
    const preAborted = new AbortController();
    preAborted.abort(CACHE_BUDGET_ABORT_REASON);
    await expect(getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      {
        basisPolicy: TEST_BASIS_POLICY,
        queryTimeoutMs: 5_000,
        signal: preAborted.signal,
        callerClass: "scanner",
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(fakeScannerPool.connect).not.toHaveBeenCalled();

    const checkout = deferred<unknown>();
    fakeScannerPool.connect.mockReturnValueOnce(checkout.promise);
    const controller = new AbortController();
    const pending = getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      {
        basisPolicy: TEST_BASIS_POLICY,
        queryTimeoutMs: 5_000,
        signal: controller.signal,
        callerClass: "scanner",
      },
    );
    await tick();
    controller.abort("scanner-stopped");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const release = vi.fn();
    const query = vi.fn();
    checkout.resolve({ release, query });
    await tick();
    expect(release).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(getCandleStoreLoad().activeReads).toBe(0);
  });

  it("bounds scanner-pool checkout and self-releases a late client without querying", async () => {
    vi.useFakeTimers();
    try {
      const checkout = deferred<unknown>();
      fakeScannerPool.connect.mockReturnValueOnce(checkout.promise);
      let phases: CandleBatchReadPhases | undefined;
      const pending = getCachedCandlesBatch(
        ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
        {
          basisPolicy: TEST_BASIS_POLICY,
          queryTimeoutMs: 5_000,
          callerClass: "scanner",
          onPhases: (value) => (phases = value),
        },
      );
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SCANNER_BATCH_POOL_ACQUIRE_TIMEOUT_MS);
      await expect(pending).rejects.toBeInstanceOf(CandleBatchReadError);
      expect(phases).toMatchObject({
        outcome: "query_error",
        termination: "pool_acquire_timeout",
        poolAcquireMs: SCANNER_BATCH_POOL_ACQUIRE_TIMEOUT_MS,
        sqlstate: null,
      });

      const release = vi.fn();
      const query = vi.fn();
      checkout.resolve({ release, query });
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
      expect(getCandleStoreLoad().activeReads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a failed SELECT with error and exposes a typed batch failure", async () => {
    const failure = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(failure);
    let phases: CandleBatchReadPhases | undefined;
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });

    await expect(getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      { basisPolicy: TEST_BASIS_POLICY, queryTimeoutMs: 5_000, callerClass: "scanner", onPhases: (value) => (phases = value) },
    )).rejects.toBeInstanceOf(CandleBatchReadError);
    expect(release).toHaveBeenCalledWith(failure);
    expect(release).not.toHaveBeenCalledWith();
    expect(phases).toMatchObject({ outcome: "query_error", termination: "server_statement_timeout", sqlstate: "57014" });
    expect(getCandleStoreLoad().activeReads).toBe(0);
  });

  it("destroys the client when restoring the shared 30-second session default fails", async () => {
    const failure = new Error("restore failed");
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row("BTC-PERP")] })
      .mockRejectedValueOnce(failure);
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });

    await expect(getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      { basisPolicy: TEST_BASIS_POLICY, queryTimeoutMs: 5_000, callerClass: "scanner" },
    )).rejects.toBeInstanceOf(CandleBatchReadError);
    expect(release).toHaveBeenCalledWith(failure);
    expect(release).not.toHaveBeenCalledWith();
  });

  it("classifies pg's JavaScript client timeout separately from the server deadline", async () => {
    const failure = new Error("Query read timeout");
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(failure);
    let phases: CandleBatchReadPhases | undefined;
    fakeScannerPool.connect.mockResolvedValueOnce({ release, query });

    await expect(getCachedCandlesBatch(
      ["BTC-PERP"], "1h", RANGE.start, RANGE.end,
      { basisPolicy: TEST_BASIS_POLICY, queryTimeoutMs: 5_000, callerClass: "scanner", onPhases: (value) => (phases = value) },
    )).rejects.toBeInstanceOf(CandleBatchReadError);
    expect(release).toHaveBeenCalledWith(failure);
    expect(phases).toMatchObject({ outcome: "query_error", termination: "client_query_timeout", sqlstate: null });
  });
});
