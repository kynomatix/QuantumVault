/**
 * EquityPoller — completion-based, no-overlap equity polling coordinator.
 *
 * Guarantees:
 *  - At most one request in flight at any time (inFlight guard).
 *  - Next poll fires POLL_MS after the current request SETTLES (not after start).
 *  - stop() / manualRefresh() abort the in-flight request and cancel the timer.
 *  - manualRefresh() cancels any pending request and starts a new one immediately.
 *  - A late result from an aborted request is never delivered to onResult.
 *
 * Injectable fetchFn and POLL_MS make the class fully testable with vitest fake timers.
 */

export interface EquitySnapshot {
  totalEquity: number | null;
  agentBalance: number | null;
  vaultBalance: number | null;
  exchangeBalance: number | null;
  mainAccountFreeCollateral: number | null;
  solBalance: number | null;
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

  constructor(
    private readonly fetchFn: EquityFetchFn,
    private readonly onResult: EquityResultCallback,
    readonly POLL_MS = 30_000,
  ) {}

  /** Run once immediately then schedule every POLL_MS after each settlement. */
  start(): void {
    this._run();
  }

  /** Cancel in-flight request and pending timer. Safe to call multiple times. */
  stop(): void {
    this._cancel();
  }

  /**
   * Trigger an immediate refresh.  If a request is already in flight it is
   * aborted and replaced — guaranteeing at most one request at a time.  The
   * completion-based timer restarts 30 s after this request settles.
   */
  manualRefresh(): void {
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
    if (this.inFlight) return; // no-overlap guard
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
        // Completion-based: next poll fires POLL_MS after THIS request settles.
        this.timerId = setTimeout(() => {
          this.timerId = null;
          this._run();
        }, this.POLL_MS);
      }
    }
  }
}
