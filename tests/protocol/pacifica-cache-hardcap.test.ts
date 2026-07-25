/**
 * Regression test — 2026-07-24 prod incident.
 *
 * A Pacifica /book fetch hung forever despite AbortSignal.timeout (wedged
 * socket; the abort never fired). Its dedup entry never cleaned up, so every
 * subsequent price caller joined the dead promise: /api/prices hung for 13+
 * hours and the dashboard went dark.
 *
 * The fix: dedup() races the producer against a hard settle cap. These tests
 * pin that behavior:
 *   1. A never-settling producer rejects ALL joiners at the cap.
 *   2. The inflight entry is removed, so the next caller starts a FRESH fetch.
 *   3. Normal fast producers are untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';

const HARD_SETTLE_MS = 60_000;

describe('pacificaCache.dedup hard settle cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pacificaCache.invalidateAll();
    pacificaCache.resetCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects all joiners when the producer never settles', async () => {
    const wedged = () => new Promise<never>(() => { /* never settles */ });

    const first = pacificaCache.dedup('/book?symbol=SOL', wedged);
    const joiner = pacificaCache.dedup('/book?symbol=SOL', wedged);

    const firstOutcome = first.catch((e: Error) => e.message);
    const joinerOutcome = joiner.catch((e: Error) => e.message);

    await vi.advanceTimersByTimeAsync(HARD_SETTLE_MS + 1);

    const [f, j] = await Promise.all([firstOutcome, joinerOutcome]);
    expect(f).toContain('hard cap');
    expect(j).toContain('hard cap');
    expect(pacificaCache.snapshot().hardCapReleases).toBe(1);
  });

  it('clears the inflight entry so the next caller starts fresh', async () => {
    const wedged = () => new Promise<never>(() => { /* never settles */ });
    const outcome = pacificaCache.dedup('/book?symbol=ETH', wedged).catch(() => 'released');
    await vi.advanceTimersByTimeAsync(HARD_SETTLE_MS + 1);
    expect(await outcome).toBe('released');
    expect(pacificaCache.snapshot().inflight).toBe(0);

    // Fresh caller after the wedge: producer runs again and succeeds.
    const fresh = vi.fn(async () => 'fresh-data');
    const result = await pacificaCache.dedup('/book?symbol=ETH', fresh);
    expect(result).toBe('fresh-data');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('does not interfere with producers that settle normally', async () => {
    const ok = await pacificaCache.dedup('/info', async () => ({ markets: 3 }));
    expect(ok).toEqual({ markets: 3 });
    expect(pacificaCache.snapshot().inflight).toBe(0);
    expect(pacificaCache.snapshot().hardCapReleases).toBe(0);

    // A producer that rejects on its own also cleans up (pre-existing behavior).
    const failing = pacificaCache.dedup('/positions', async () => {
      throw new Error('upstream 500');
    });
    await expect(failing).rejects.toThrow('upstream 500');
    expect(pacificaCache.snapshot().inflight).toBe(0);
  });

  it('a late-settling producer beats the cap and is served to all joiners', async () => {
    const slow = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('slow-but-fine'), 30_000));
    const p1 = pacificaCache.dedup('/book?symbol=AVAX', slow);
    const p2 = pacificaCache.dedup('/book?symbol=AVAX', slow);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await p1).toBe('slow-but-fine');
    expect(await p2).toBe('slow-but-fine');
    expect(pacificaCache.snapshot().hardCapReleases).toBe(0);
    expect(pacificaCache.snapshot().dedupedJoins).toBe(1);
  });
});
