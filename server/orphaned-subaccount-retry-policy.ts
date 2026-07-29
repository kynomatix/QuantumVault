/**
 * Orphaned Drift subaccounts retain rent under the agent generation that
 * created them. Automated cleanup may slow down after repeated failures, but
 * it must never abandon a still-current generation: Reset deliberately keeps
 * that row as a custody blocker until close succeeds.
 */
export const ORPHANED_SUBACCOUNT_FAST_RETRY_LIMIT = 5;
export const ORPHANED_SUBACCOUNT_SLOW_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface OrphanCleanupRetryState {
  retryCount: number;
  lastRetryAt: Date | string | null;
}

/** Pure scheduling predicate shared with focused tests. */
export function shouldAttemptOrphanCleanup(
  row: OrphanCleanupRetryState,
  nowMs: number = Date.now(),
): boolean {
  // Malformed counters must not turn into a permanent no-retry state.
  if (!Number.isSafeInteger(row.retryCount) || row.retryCount < 0) return true;
  if (row.retryCount < ORPHANED_SUBACCOUNT_FAST_RETRY_LIMIT) return true;
  if (row.lastRetryAt == null) return true;

  const lastRetryMs = new Date(row.lastRetryAt).getTime();
  if (!Number.isFinite(lastRetryMs)) return true;
  if (lastRetryMs > nowMs) return true;
  return nowMs - lastRetryMs >= ORPHANED_SUBACCOUNT_SLOW_RETRY_INTERVAL_MS;
}
