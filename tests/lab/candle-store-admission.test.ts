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

const { fakePool, fakeDb } = vi.hoisted(() => ({
  fakePool: {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn<() => Promise<unknown>>(),
  },
  fakeDb: { insert: vi.fn() },
}));

vi.mock("../../server/db", () => ({ db: fakeDb, pool: fakePool }));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: vi.fn() }));

import {
  getCachedCandles,
  getCandleStoreLoad,
  saveCandlesToDb,
  CandleWriteQueueFullError,
  CACHE_BUDGET_ABORT_REASON,
  type CandleReadPhases,
} from "../../server/lab/candle-store";
import type { CandleFinality, ProvenancedOHLCV } from "../../server/lab/datafeed";

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
  fakePool.connect.mockReset();
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

    const updates = Array.from({ length: 16 }, (_, index) =>
      saveCandlesToDb("COLD", "1h", [candle(3, 100 + index)])
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
    const replacements = Array.from({ length: 20 }, (_, index) =>
      saveCandlesToDb("HOT", "1h", [candle(102, 2 + index)])
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
    expect(getCandleStoreLoad().queuedWrites).toBe(2);

    activeA.resolve();
    activeB.resolve();
    await Promise.all([occupyingA, occupyingB, forming, finalized]);
    expect(finalities).toEqual(["forming", "finalized"]);
  });
});

describe("getCachedCandles — cancellation-aware admission", () => {
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
