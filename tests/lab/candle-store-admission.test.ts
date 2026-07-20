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

const { fakePool } = vi.hoisted(() => ({
  fakePool: {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn<() => Promise<unknown>>(),
  },
}));

vi.mock("../../server/db", () => ({ db: {}, pool: fakePool }));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: vi.fn() }));

import {
  getCachedCandles,
  getCandleStoreLoad,
  CACHE_BUDGET_ABORT_REASON,
  type CandleReadPhases,
} from "../../server/lab/candle-store";

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

function read(
  signal: AbortSignal | undefined,
  onPhases?: (p: CandleReadPhases) => void,
  symbol = "BTC-PERP",
) {
  return getCachedCandles(symbol, "1h", RANGE.start, RANGE.end, {
    queryTimeoutMs: 500,
    signal,
    callerClass: "scanner",
    onPhases,
  });
}

beforeEach(() => {
  fakePool.connect.mockReset();
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

  it("E: signal-free reads keep the historical contract — empty result is a miss, client released", async () => {
    const release = vi.fn();
    fakePool.connect.mockResolvedValueOnce({
      release,
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    });
    let phases: CandleReadPhases | undefined;
    const result = await getCachedCandles("BTC-PERP", "1h", RANGE.start, RANGE.end, {
      queryTimeoutMs: 500,
      callerClass: "lab",
      onPhases: (p) => (phases = p),
    });
    expect(result).toBeNull();
    expect(phases?.outcome).toBe("miss");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
