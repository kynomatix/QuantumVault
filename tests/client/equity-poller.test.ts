/**
 * WO-15C — equity-poller deterministic tests.
 *
 * All timing is fake (vi.useFakeTimers).  Each test verifies a named invariant
 * from the WO spec:
 *
 *  1. A slow automatic request cannot overlap the next poll tick.
 *  2. The next poll fires POLL_MS after settlement, not after start.
 *  3. Unmount (stop) aborts in-flight and suppresses late writes.
 *  4. Wallet change (stop + new poller) aborts old request and suppresses late writes.
 *  5. Manual refresh cancels the automatic read; at most one request at a time.
 *  6. Polling resumes after a successful completion.
 *  7. Polling resumes after a failure.
 *  8. Explicit null fields reported as null (never coerced to 0 inside the poller).
 *  9. Explicit zero fields reported as 0 (zero is valid, not Unavailable).
 * 10. 503 / throw: onResult called with ok=false; no concurrent request started.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EquityPoller, type EquityPollResult, type EquitySnapshot } from '@/lib/equity-poller';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<EquitySnapshot> = {}): EquitySnapshot {
  return {
    totalEquity: 1000,
    agentBalance: 500,
    vaultBalance: 200,
    exchangeBalance: 300,
    mainAccountFreeCollateral: 0,
    solBalance: 0.1,
    ...overrides,
  };
}

/** A fetchFn that resolves immediately with the given snapshot. */
function immediateFetch(snap: EquitySnapshot | null) {
  return (_signal: AbortSignal): Promise<EquitySnapshot | null> =>
    Promise.resolve(snap);
}

/** A fetchFn that throws immediately (simulates network error / 503). */
function throwingFetch() {
  return (_signal: AbortSignal): Promise<EquitySnapshot | null> =>
    Promise.reject(new Error('503'));
}

/**
 * A fetchFn that never resolves until abort or manual resolve.
 * Each fetchFn call gets its OWN resolve/reject handle tracked by call index,
 * so calls can be settled independently even when they share the same fetchFn.
 */
function pendingFetch() {
  const calls: Array<{
    resolve: (v: EquitySnapshot | null) => void;
    reject: (e: Error) => void;
  }> = [];
  const fetchFn = (signal: AbortSignal): Promise<EquitySnapshot | null> =>
    new Promise<EquitySnapshot | null>((resolve, reject) => {
      calls.push({ resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('AbortError')));
    });
  return {
    fetchFn,
    /** Resolve the i-th call (0-indexed). */
    resolveCall: (i: number, s: EquitySnapshot | null) => calls[i]?.resolve(s),
    /** Reject the i-th call (0-indexed). */
    rejectCall: (i: number, e: Error) => calls[i]?.reject(e),
    /** Resolve the FIRST call (legacy convenience). */
    resolve: (s: EquitySnapshot | null) => calls[0]?.resolve(s),
    reject: (e: Error) => calls[0]?.reject(e),
  };
}

/**
 * A fetchFn that resolves after `delayMs` (respects abort).
 */
function delayedFetch(delayMs: number, snap: EquitySnapshot | null = makeSnapshot()) {
  return (signal: AbortSignal): Promise<EquitySnapshot | null> =>
    new Promise<EquitySnapshot | null>((resolve, reject) => {
      const t = setTimeout(() => resolve(snap), delayMs);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('AbortError')); });
    });
}

/** Flush pending microtasks. */
async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('EquityPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Invariant 1 ──────────────────────────────────────────────────────────
  it('slow automatic request cannot overlap the next poll tick', async () => {
    let callCount = 0;
    const { fetchFn } = pendingFetch(); // never resolves naturally
    const wrappedFetch = (signal: AbortSignal) => {
      callCount++;
      return fetchFn(signal);
    };
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(wrappedFetch, r => results.push(r), 30_000);
    poller.start();

    // First fetch started (callCount=1), still in flight.
    expect(callCount).toBe(1);

    // Advance past the poll interval while the request is still in flight.
    await vi.advanceTimersByTimeAsync(35_000);

    // The inFlight guard must have prevented a second request from starting.
    expect(callCount).toBe(1);
    expect(results).toHaveLength(0); // no result yet (still in flight)

    poller.stop();
  });

  // ── Invariant 2 ──────────────────────────────────────────────────────────
  it('next poll fires POLL_MS after settlement, not after start', async () => {
    let callCount = 0;
    const callTimes: number[] = [];
    // Each call takes 10 s to resolve.
    const fetchFn = delayedFetch(10_000);
    const wrappedFetch = (signal: AbortSignal) => {
      callCount++;
      callTimes.push(Date.now());
      return fetchFn(signal);
    };
    const poller = new EquityPoller(wrappedFetch, () => {}, 30_000);

    // t=0: first fetch starts
    poller.start();
    expect(callCount).toBe(1);

    // t=10 s: first fetch settles; timer for second fetch starts (fires at t=40 s)
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    // t=39 s: second fetch should NOT have started yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(callCount).toBe(1);

    // t=40 s: second fetch starts (10 s settle + 30 s delay)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(2);

    // Verify the gap between the two start times is ≥ 40 s (10 s fetch + 30 s wait)
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(40_000);

    poller.stop();
  });

  // ── Invariant 3 ──────────────────────────────────────────────────────────
  it('unmount (stop) aborts in-flight request and suppresses late writes', async () => {
    const { fetchFn, resolve } = pendingFetch();
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(fetchFn, r => results.push(r), 30_000);

    poller.start();
    // Request is now in flight.

    // Simulate unmount: stop the poller (aborts the in-flight request).
    poller.stop();

    // Resolve the fetch after abort — result must be suppressed.
    resolve(makeSnapshot());
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(35_000); // no timer should fire

    expect(results).toHaveLength(0); // suppressed
  });

  // ── Invariant 4 ──────────────────────────────────────────────────────────
  it('wallet change: old request aborted, late result does not update new wallet state', async () => {
    const { fetchFn: oldFetch, resolve: resolveOld } = pendingFetch();
    const oldResults: EquityPollResult[] = [];
    const poller1 = new EquityPoller(oldFetch, r => oldResults.push(r), 30_000);
    poller1.start();

    // Wallet changes: stop old poller, create new one.
    poller1.stop();
    const newResults: EquityPollResult[] = [];
    const poller2 = new EquityPoller(immediateFetch(makeSnapshot({ totalEquity: 9999 })), r => newResults.push(r), 30_000);
    poller2.start();
    await flushMicrotasks();

    // Old fetch resolves late (after its abort).
    resolveOld(makeSnapshot({ totalEquity: 1111 }));
    await flushMicrotasks();

    // Old result must be suppressed; only new wallet's result present.
    expect(oldResults).toHaveLength(0);
    expect(newResults).toHaveLength(1);
    expect(newResults[0].snapshot?.totalEquity).toBe(9999);

    poller2.stop();
  });

  // ── Invariant 5 ──────────────────────────────────────────────────────────
  it('manual refresh cancels automatic read; at most one request in-flight', async () => {
    let callCount = 0;
    const { fetchFn, resolveCall } = pendingFetch();
    const wrappedFetch = (signal: AbortSignal) => {
      callCount++;
      return fetchFn(signal);
    };
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(wrappedFetch, r => results.push(r), 30_000);

    poller.start(); // fetch[0] starts (callCount=1)
    expect(callCount).toBe(1);

    // Manual refresh: aborts fetch[0] (Promise[0] rejects with AbortError),
    // starts fetch[1] immediately (callCount=2).
    poller.manualRefresh();
    expect(callCount).toBe(2);
    await flushMicrotasks(); // let the AbortError rejection propagate

    // fetch[0] was aborted → _run() catch checks ctrl.signal.aborted → true → onResult NOT called.
    expect(results).toHaveLength(0);

    // Calling resolve on the already-settled (rejected) Promise[0] is a no-op;
    // still no result should be dispatched.
    resolveCall(0, makeSnapshot({ totalEquity: 1111 }));
    await flushMicrotasks();
    expect(results).toHaveLength(0); // old result suppressed

    // fetch[1] is still in flight; no timer fires during this window.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(callCount).toBe(2); // still exactly 2 in-flight requests total

    poller.stop();
  });

  // ── Invariant 6 ──────────────────────────────────────────────────────────
  it('polling resumes 30 s after a successful completion', async () => {
    let callCount = 0;
    const wrappedFetch = (signal: AbortSignal) => {
      callCount++;
      return immediateFetch(makeSnapshot())(signal);
    };
    const poller = new EquityPoller(wrappedFetch, () => {}, 30_000);
    poller.start(); // fetch 1
    await flushMicrotasks(); // fetch 1 settles

    expect(callCount).toBe(1);

    // 30 s after settlement → fetch 2
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(2);

    poller.stop();
  });

  // ── Invariant 7 ──────────────────────────────────────────────────────────
  it('polling resumes 30 s after a failure', async () => {
    let callCount = 0;
    const wrappedFetch = (signal: AbortSignal) => {
      callCount++;
      return throwingFetch()(signal);
    };
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(wrappedFetch, r => results.push(r), 30_000);
    poller.start(); // fetch 1 (fails)
    await flushMicrotasks();

    expect(callCount).toBe(1);
    expect(results[0].ok).toBe(false);

    // 30 s after failure → fetch 2
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(2);

    poller.stop();
  });

  // ── Invariant 8 ──────────────────────────────────────────────────────────
  it('null fields from server reported as null, never coerced to 0', async () => {
    const snapWithNulls = makeSnapshot({ totalEquity: null, agentBalance: null });
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(immediateFetch(snapWithNulls), r => results.push(r), 30_000);
    poller.start();
    await flushMicrotasks();
    poller.stop();

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].snapshot?.totalEquity).toBeNull();
    expect(results[0].snapshot?.agentBalance).toBeNull();
    // Non-null fields unaffected
    expect(results[0].snapshot?.exchangeBalance).toBe(300);
  });

  // ── Invariant 9 ──────────────────────────────────────────────────────────
  it('explicit zero fields reported as 0 (zero is valid)', async () => {
    const snapWithZeros = makeSnapshot({ totalEquity: 0, agentBalance: 0, exchangeBalance: 0 });
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(immediateFetch(snapWithZeros), r => results.push(r), 30_000);
    poller.start();
    await flushMicrotasks();
    poller.stop();

    expect(results[0].snapshot?.totalEquity).toBe(0);
    expect(results[0].snapshot?.agentBalance).toBe(0);
    expect(results[0].snapshot?.exchangeBalance).toBe(0);
  });

  // ── Invariant 10 ─────────────────────────────────────────────────────────
  it('503/throw: onResult called with ok=false; no concurrent request started', async () => {
    let callCount = 0;
    const wrappedFetch = (signal: AbortSignal) => {
      callCount++;
      return throwingFetch()(signal);
    };
    const results: EquityPollResult[] = [];
    const poller = new EquityPoller(wrappedFetch, r => results.push(r), 30_000);
    poller.start();
    await flushMicrotasks();

    expect(callCount).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].snapshot).toBeNull();

    // No second request started yet (timer fires 30 s after failure)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callCount).toBe(1); // still only 1

    poller.stop();
  });

  // ── Post-settle timer guard ───────────────────────────────────────────────
  it('no timer is scheduled when stop() precedes the first settlement', async () => {
    const { fetchFn } = pendingFetch();
    let timerFired = false;
    const poller = new EquityPoller(fetchFn, () => { timerFired = true; }, 30_000);
    poller.start();
    poller.stop(); // abort before settlement
    await vi.advanceTimersByTimeAsync(60_000); // well past POLL_MS
    expect(timerFired).toBe(false);
  });
});
