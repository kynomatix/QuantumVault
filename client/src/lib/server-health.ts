// Tracks whether core dashboard reads (bots, positions, equity) are failing so
// pages can show an honest "connection lost" banner instead of silently
// rendering empty states. 2026-07-19 incident: a wedged DB pool 500'd every
// read and the dashboard showed "no bots / no positions" as if the account
// were empty — indistinguishable from real data loss to the user.
//
// Two independent signals:
// - degraded: consecutive network/5xx failures → "server unavailable"
// - sessionExpired: a core authed read returned 401/403 → the express session
//   no longer matches the active wallet. This is NOT server degradation (the
//   server answered), but it must NEVER render as an empty account either —
//   it needs an explicit "session expired, sign in again" state.
//
// WO-20 additions:
// - CoreReadTimeoutError: a hard 15-second wall-clock deadline for every core
//   dashboard read. Timeout = transient server degradation (never auth/empty).
// - coreReadFetch: the budget-enforced wrapper (coreFetch stays unchanged for
//   callers that don't need the budget). Covers the initial request, the
//   single 503 retry, its clamped delay, and the retry request.
// - Boot-id tracking: when the server boot identifier changes across responses
//   the module fires a recovery event, unblocking queries stuck in error state.
import { useSyncExternalStore } from "react";

type Listener = () => void;

let degradedSince: number | null = null;
let sessionExpiredSince: number | null = null;
let consecutiveFailures = 0;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((l) => l());
}

// Recovery listeners fire on the degraded→healthy and session-expired→valid
// transitions (NOT on every success). 2026-07-19 incident follow-up: with
// `retry: false` + `staleTime: Infinity`, any query that failed during a
// transient backend outage stayed failed forever — the polling reads (positions)
// recovered and even cleared the degraded banner, while non-polling reads
// (portfolio, bots) rendered a permanently empty dashboard. queryClient.ts
// registers a listener that refetches every errored query on these edges.
const recoveryListeners = new Set<Listener>();

/** Register a callback fired when the server or session RECOVERS. */
export function registerRecoveryListener(cb: Listener): () => void {
  recoveryListeners.add(cb);
  return () => recoveryListeners.delete(cb);
}

function emitRecovery(): void {
  recoveryListeners.forEach((l) => {
    try {
      l();
    } catch {
      // a broken recovery hook must never break health reporting
    }
  });
}

/**
 * Typed error for core dashboard reads so callers (and React Query error
 * states) can distinguish auth failures from server failures instead of
 * collapsing everything into a generic Error → false-empty UI.
 */
export class CoreReadError extends Error {
  readonly status: number;
  readonly kind: "auth" | "server" | "http";
  constructor(resource: string, status: number) {
    super(`Failed to load ${resource} (HTTP ${status})`);
    this.name = "CoreReadError";
    this.status = status;
    this.kind = status === 401 || status === 403 ? "auth" : status >= 500 ? "server" : "http";
  }
}

/**
 * Thrown when a core dashboard read exceeds the 15-second wall-clock budget.
 * kind="timeout" so callers and isTransientReadError() can distinguish it from
 * auth failures (kind="auth") and HTTP errors (kind="http"). A timeout is
 * transient server degradation — it must NEVER be classified as session expiry,
 * empty wallet, zero balance, no bots, or no positions.
 */
export class CoreReadTimeoutError extends Error {
  readonly kind = "timeout" as const;
  readonly resource: string;
  constructor(resource: string) {
    super(`Core read timed out after ${CORE_READ_BUDGET_MS}ms: ${resource}`);
    this.name = "CoreReadTimeoutError";
    this.resource = resource;
  }
}

/** Absolute wall-clock budget for a single core dashboard read (ms). */
export const CORE_READ_BUDGET_MS = 15_000;

/** Retry-After header is clamped to this ceiling (seconds) regardless of what the server says. */
const MAX_RETRY_AFTER_SEC = 5;

/** Report a core read that failed with a server (5xx) or network error. */
export function reportCoreReadFailure(): void {
  consecutiveFailures++;
  // Two consecutive failures before flagging: one blip (e.g. a mid-deploy
  // request) should not flash the banner.
  if (consecutiveFailures >= 2 && degradedSince === null) {
    degradedSince = Date.now();
    emit();
  }
}

/** Report a core read that reached the server (any non-5xx response). */
export function reportCoreReadSuccess(): void {
  consecutiveFailures = 0;
  if (degradedSince !== null) {
    degradedSince = null;
    emit();
    emitRecovery();
  }
}

/** Report a core authed read that came back 401/403 — session no longer valid. */
export function reportCoreAuthFailure(): void {
  if (sessionExpiredSince === null) {
    sessionExpiredSince = Date.now();
    emit();
  }
}

/**
 * Auth-rejection arbiter (2026-07-20 incident): a single core 401/403 must
 * NOT immediately become the global verdict "session expired" — during the
 * incident, reads racing a half-established session latched the banner while
 * the 7-day cookie was perfectly valid. When an arbiter is registered
 * (session-probe.ts does so on load), coreFetch hands it the rejection
 * evidence instead of latching; the arbiter runs ONE authoritative probe and
 * only an authoritative invalid result latches (via reportCoreAuthFailure).
 * With no arbiter registered we keep the old direct latch as the fail-safe.
 */
export interface CoreAuthRejectionInfo {
  endpoint: string;
  status: number;
  requestWallet: string | null;
}
type AuthRejectionArbiter = (info: CoreAuthRejectionInfo) => void;
let authRejectionArbiter: AuthRejectionArbiter | null = null;
export function setAuthRejectionArbiter(cb: AuthRejectionArbiter | null): void {
  authRejectionArbiter = cb;
}

function describeEndpoint(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.pathname;
    return (input as Request).url ?? String(input);
  } catch {
    return "unknown";
  }
}

function extractWalletHeader(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  try {
    if (typeof Headers !== "undefined" && h instanceof Headers) {
      return h.get("x-wallet-address");
    }
    if (Array.isArray(h)) {
      const hit = h.find(([k]) => k.toLowerCase() === "x-wallet-address");
      return hit?.[1] ?? null;
    }
    const rec = h as Record<string, string>;
    for (const k of Object.keys(rec)) {
      if (k.toLowerCase() === "x-wallet-address") return rec[k];
    }
    return null;
  } catch {
    return null;
  }
}

/** Report a core authed read that succeeded — session is valid again. */
export function reportCoreAuthSuccess(): void {
  if (sessionExpiredSince !== null) {
    sessionExpiredSince = null;
    emit();
    emitRecovery();
  }
}

// ---------------------------------------------------------------------------
// Boot-id tracking (WO-20)
// When the server restarts its X-Boot-Id header changes. Detecting a change
// fires emitRecovery() so queries stuck in a timeout/error state unblock
// automatically on the new boot, exactly as they do on a degraded→healthy
// health transition.
// ---------------------------------------------------------------------------
let lastSeenBootId: string | null = null;

/** Process an X-Boot-Id header value from a server response. */
export function reportBootId(id: string): void {
  if (lastSeenBootId !== null && id !== lastSeenBootId) {
    emitRecovery();
  }
  lastSeenBootId = id;
}

/** Test-only: reset module state between unit tests. */
export function __resetServerHealthForTests(): void {
  degradedSince = null;
  sessionExpiredSince = null;
  consecutiveFailures = 0;
  recoveryListeners.clear();
  lastSeenBootId = null;
}

/** Non-hook snapshot readers (usable from plain code and unit tests). */
export function isServerDegraded(): boolean {
  return degradedSince !== null;
}
export function isSessionExpired(): boolean {
  return sessionExpiredSince !== null;
}

/**
 * fetch wrapper for core reads: network errors and 5xx responses mark the
 * connection degraded; any non-5xx response clears degradation. 401/403
 * additionally flips the session-expired flag (an auth problem is not server
 * degradation, but it must surface as its own state — never as an empty
 * account). Response handling is otherwise untouched: callers keep their own
 * ok-checks and error throws.
 *
 * `opts.authed` (default true): whether this request carries wallet/session
 * auth. Unauthenticated reads (e.g. public marketplace lists) MUST pass
 * `authed: false` — their 200s say nothing about the session, and letting
 * them clear the session-expired latch would flicker the banner against
 * authed polls that keep re-latching it.
 */
export async function coreFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { authed?: boolean },
): Promise<Response> {
  const authed = opts?.authed !== false;
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    reportCoreReadFailure();
    throw err;
  }
  if (res.status >= 500) {
    reportCoreReadFailure();
  } else {
    reportCoreReadSuccess();
    if (authed) {
      if (res.status === 401 || res.status === 403) {
        if (authRejectionArbiter) {
          // Evidence, not verdict: let the session-probe arbiter decide via
          // one authoritative probe instead of latching from a stray 401.
          authRejectionArbiter({
            endpoint: describeEndpoint(input),
            status: res.status,
            requestWallet: extractWalletHeader(init),
          });
        } else {
          reportCoreAuthFailure();
        }
      } else if (res.ok) {
        reportCoreAuthSuccess();
      }
    }
  }
  return res;
}

/**
 * Combine multiple AbortSignals into one that aborts when ANY input fires.
 * Uses AbortSignal.any() (Node 20+ / modern browsers) with a manual fallback.
 */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as { any?: unknown }).any === "function") {
    return (AbortSignal as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const ctrl = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      ctrl.abort(sig.reason);
      return ctrl.signal;
    }
    sig.addEventListener("abort", () => ctrl.abort(sig.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * Core read wrapper with a hard 15-second wall-clock budget (WO-20).
 *
 * Contract:
 * - The budget covers the initial request, one 503 retry, its clamped
 *   Retry-After delay, the retry request, and response consumption.
 * - Propagates the query library's cancellation signal (React Query passes
 *   `signal` via the queryFn context). Caller cancellation is preserved as
 *   an AbortError — no health penalty and no degradation latch.
 * - Deadline expiry throws CoreReadTimeoutError (kind="timeout") and counts
 *   toward server degradation — never toward session expiry.
 * - Retry-After is clamped to [0, 5] seconds AND to the remaining budget.
 * - Reads `X-Boot-Id` from every response; a changed id fires emitRecovery().
 * - Health reporting mirrors coreFetch exactly for non-timeout, non-cancel
 *   outcomes.
 *
 * NEVER use this function for mutations, transaction signing, order broadcasts,
 * position closing, vault actions, borrowing, or any money-changing request.
 * Those must go through apiRequest() or plain fetch() so they are never
 * subject to replay or automatic retry.
 */
export async function coreReadFetch(
  resource: string,
  input: string,
  init: RequestInit | undefined,
  opts?: { authed?: boolean; signal?: AbortSignal },
): Promise<Response> {
  const authed = opts?.authed !== false;
  const callerSignal = opts?.signal;
  const startMs = Date.now();

  // Deadline via setTimeout so fake timers work in unit tests.
  const deadlineCtrl = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      deadlineCtrl.abort(
        new DOMException("Core read deadline exceeded", "TimeoutError"),
      ),
    CORE_READ_BUDGET_MS,
  );

  const signalsToMerge: AbortSignal[] = [deadlineCtrl.signal];
  if (callerSignal) signalsToMerge.push(callerSignal);
  const combined = signalsToMerge.length > 1 ? combineSignals(signalsToMerge) : deadlineCtrl.signal;

  /** True if OUR deadline fired (not the caller's cancellation). */
  const isDeadline = (): boolean => deadlineCtrl.signal.aborted;
  /** True if the caller cancelled (wallet switch, key change, unmount). */
  const isCancelled = (): boolean => !!(callerSignal?.aborted && !deadlineCtrl.signal.aborted);

  function applyHealthReporting(res: Response): void {
    if (res.status >= 500) {
      reportCoreReadFailure();
    } else {
      reportCoreReadSuccess();
      if (authed) {
        if (res.status === 401 || res.status === 403) {
          if (authRejectionArbiter) {
            authRejectionArbiter({
              endpoint: input,
              status: res.status,
              requestWallet: extractWalletHeader(init),
            });
          } else {
            reportCoreAuthFailure();
          }
        } else if (res.ok) {
          reportCoreAuthSuccess();
        }
      }
    }
    // Boot-id tracking: a changed id triggers recovery for stuck queries.
    const bootId = res.headers.get("X-Boot-Id");
    if (bootId) reportBootId(bootId);
  }

  async function doFetch(): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(input, { ...init, signal: combined });
    } catch (err) {
      if (isDeadline()) {
        reportCoreReadFailure();
        throw new CoreReadTimeoutError(resource);
      }
      if (isCancelled()) {
        // Caller cancelled — no health penalty.
        throw err;
      }
      // Genuine network error.
      reportCoreReadFailure();
      throw err;
    }
    return res;
  }

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    clearTimeout(deadlineTimer);
    throw err;
  }

  // Single 503 retry within the remaining budget.
  if (res.status === 503) {
    const rawRetryAfterSec = parseInt(res.headers.get("Retry-After") ?? "5", 10);
    const elapsedMs = Date.now() - startMs;
    const remainingMs = CORE_READ_BUDGET_MS - elapsedMs;
    // Clamp Retry-After to [0, 5] seconds and to remaining budget.
    const cappedSec = Math.max(0, Math.min(rawRetryAfterSec, MAX_RETRY_AFTER_SEC));
    // Reserve a small margin for the retry request itself.
    const delayMs = Math.min(cappedSec * 1000, Math.max(0, remainingMs - 200));

    // Honour the delay unless already cancelled/timed-out.
    try {
      await new Promise<void>((resolve, reject) => {
        if (combined.aborted) {
          reject(combined.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        const t = setTimeout(resolve, delayMs);
        combined.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(combined.reason ?? new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    } catch {
      clearTimeout(deadlineTimer);
      if (isDeadline()) {
        reportCoreReadFailure();
        throw new CoreReadTimeoutError(resource);
      }
      // Caller cancelled during retry delay.
      throw new DOMException("Request cancelled", "AbortError");
    }

    // Retry request.
    try {
      res = await doFetch();
    } catch (err) {
      clearTimeout(deadlineTimer);
      throw err;
    }
  }

  clearTimeout(deadlineTimer);
  applyHealthReporting(res);
  return res;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getDegradedSnapshot(): boolean {
  return degradedSince !== null;
}

function getSessionExpiredSnapshot(): boolean {
  return sessionExpiredSince !== null;
}

/** True while core reads are consistently failing (server unreachable/degraded). */
export function useServerDegraded(): boolean {
  return useSyncExternalStore(subscribe, getDegradedSnapshot, getDegradedSnapshot);
}

/** True after a core authed read returned 401/403 until one succeeds again. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, getSessionExpiredSnapshot, getSessionExpiredSnapshot);
}
