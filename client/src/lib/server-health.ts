// Tracks whether core dashboard reads (bots, positions, equity) are failing so
// pages can show an honest "connection lost" banner instead of silently
// rendering empty states. 2026-07-19 incident: a wedged DB pool 500'd every
// read and the dashboard showed "no bots / no positions" as if the account
// were empty — indistinguishable from real data loss to the user.
import { useSyncExternalStore } from "react";

type Listener = () => void;

let degradedSince: number | null = null;
let consecutiveFailures = 0;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((l) => l());
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
  }
}

/**
 * fetch wrapper for core reads: network errors and 5xx responses mark the
 * connection degraded; any non-5xx response (including 4xx — auth problems
 * are not server degradation) clears it. Response handling is otherwise
 * untouched: callers keep their own ok-checks and error throws.
 */
export async function coreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
  }
  return res;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return degradedSince !== null;
}

/** True while core reads are consistently failing (server unreachable/degraded). */
export function useServerDegraded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
