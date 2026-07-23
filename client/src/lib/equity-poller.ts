/**
 * EquityPoller — completion-based, no-overlap equity polling coordinator.
 *
 * Invariants:
 *  - At most one request in flight at any time (inFlight guard).
 *  - Next poll fires POLL_MS after the current request SETTLES (not after start).
 *  - stop() / manualRefresh() abort the in-flight request and cancel the timer.
 *  - manualRefresh() replaces any in-flight request; guarantees at most one.
 *  - A late result from an aborted request is NEVER delivered to onResult.
 *  - After stop() all further _run() calls are no-ops (stopped flag).
 *    This prevents a stopped old-wallet coordinator from being restarted
 *    through a stale pollerRef.current reference (WO-15C Defect 3).
 *
 * Injectable fetchFn and POLL_MS make the class fully testable with fake timers.
 */

/**
 * Server freshness verdict for the total-equity snapshot.
 * - 'fresh'   — all data current; client may clear the degraded indicator.
 * - 'partial' — some fields populated but not all sources responded; degraded.
 * - 'stale'   — data is from a prior snapshot; degraded.
 *
 * Only 'fresh' may clear the stale/degraded marker.  Every other verdict,
 * including null (field absent) and any unrecognized string, stays degraded.
 */
export type EquityDataStatus = 'fresh' | 'partial' | 'stale';

export interface EquitySnapshot {
  totalEquity: number | null;
  agentBalance: number | null;
  vaultBalance: number | null;
  exchangeBalance: number | null;
  mainAccountFreeCollateral: number | null;
  solBalance: number | null;
  /**
   * Server-reported freshness verdict.  Parsed from `financialDataStatus` in the
   * response body by `parseFinancialDataStatus`.  null when absent or unrecognized.
   *
   * Only 'fresh' clears the client stale indicator.  'partial', 'stale', null, and
   * any unrecognized value must all keep the degraded state visible.
   */
  dataStatus: EquityDataStatus | null;
  /**
   * Server-reported observation time as a numeric epoch-ms value.
   * Parsed from `financialDataObservedAt` (authoritative wire type: number).
   * ISO strings are accepted for compatibility.  Malformed or absent → null.
   * Use `new Date(observedAt)` to render a human-readable time.
   */
  observedAt: number | null;
}

export interface EquityPollResult {
  ok: boolean;
  snapshot: EquitySnapshot | null;
}

export type EquityFetchFn = (signal: AbortSignal) => Promise<EquitySnapshot | null>;
export type EquityResultCallback = (result: EquityPollResult) => void;

export class EquityPoller {
  private abortCtrl: AbortController | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** Set permanently by stop(); prevents _run() after the coordinator is retired. */
  private stopped = false;

  constructor(
    private readonly fetchFn: EquityFetchFn,
    private readonly onResult: EquityResultCallback,
    readonly POLL_MS = 30_000,
  ) {}

  /** Run once immediately then schedule every POLL_MS after each settlement. */
  start(): void {
    this._run();
  }

  /**
   * Permanently retire this coordinator.  All further _run() calls — including
   * those triggered by manualRefresh() through a stale pollerRef — are no-ops.
   * Safe to call multiple times.
   */
  stop(): void {
    this.stopped = true;
    this._cancel();
  }

  /**
   * Trigger an immediate refresh.  If the coordinator has been stopped (e.g.
   * wallet switched, unmounted) this is a guaranteed no-op.  Otherwise the
   * in-flight request is aborted and replaced; the 30-s timer restarts after
   * this request settles.
   */
  manualRefresh(): void {
    if (this.stopped) return;
    this._cancel();
    this._run();
  }

  private _cancel(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.abortCtrl !== null) {
      this.abortCtrl.abort();
      this.abortCtrl = null;
    }
    this.inFlight = false;
  }

  private async _run(): Promise<void> {
    if (this.stopped) return;   // retired coordinator — do nothing
    if (this.inFlight) return;  // no-overlap guard
    this.inFlight = true;
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    try {
      const snapshot = await this.fetchFn(ctrl.signal);
      if (!ctrl.signal.aborted) {
        this.onResult({ ok: true, snapshot });
      }
    } catch {
      if (!ctrl.signal.aborted) {
        this.onResult({ ok: false, snapshot: null });
      }
    } finally {
      // Only reschedule when this invocation was NOT aborted by stop()/manualRefresh().
      // If aborted, the caller already reset inFlight via _cancel().
      if (!ctrl.signal.aborted) {
        this.inFlight = false;
        this.abortCtrl = null;
        if (!this.stopped) {
          // Completion-based: next poll fires POLL_MS after THIS request settles.
          this.timerId = setTimeout(() => {
            this.timerId = null;
            this._run();
          }, this.POLL_MS);
        }
      }
    }
  }
}
