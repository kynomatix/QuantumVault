// Process-local evidence for the web database, independent of boot completion.
// Two serial 20s heartbeat failures tolerate one blip. Connection events are
// supporting evidence only: pg can emit both client and pool errors for one loss.
let failedChecks = 0;
let lastConnectionErrorAt: number | null = null;

export function recordDatabaseConnectionError(): void {
  lastConnectionErrorAt = Date.now();
}

export function recordDatabaseCheck(success: boolean): void {
  if (success) {
    failedChecks = 0;
    lastConnectionErrorAt = null;
  } else {
    failedChecks = Math.min(failedChecks + 1, 2);
  }
}

export function getDatabaseReadiness() {
  return {
    degraded: failedChecks >= 2,
    failedChecks,
    lastConnectionErrorAt,
    reason: failedChecks >= 2 ? "Database unavailable: consecutive health checks failed" : null,
  };
}
