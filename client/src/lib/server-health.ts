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

/** Report a core authed read that succeeded — session is valid again. */
export function reportCoreAuthSuccess(): void {
  if (sessionExpiredSince !== null) {
    sessionExpiredSince = null;
    emit();
    emitRecovery();
  }
}

/** Test-only: reset module state between unit tests. */
export function __resetServerHealthForTests(): void {
  degradedSince = null;
  sessionExpiredSince = null;
  consecutiveFailures = 0;
  recoveryListeners.clear();
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
        reportCoreAuthFailure();
      } else if (res.ok) {
        reportCoreAuthSuccess();
      }
    }
  }
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
