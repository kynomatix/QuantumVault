import { safeResponseJson } from "./safe-fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";
import {
  coreReadJson,
  CoreReadError,
  CoreReadTimeoutError,
  registerRecoveryListener,
} from "./server-health";

// The currently connected Solana wallet address, mirrored here so module-level
// fetch helpers can stamp an `x-wallet-address` header on every authenticated
// request. The server (requireWallet) rejects any request whose header doesn't
// match the session wallet, so this makes stale-session reads fail closed
// instead of silently leaking the previously connected wallet's data.
let activeWalletAddress: string | null = null;

export function setActiveWalletAddress(address: string | null): void {
  activeWalletAddress = address;
}

export function getActiveWalletAddress(): string | null {
  return activeWalletAddress;
}

export function walletAuthHeaders(): Record<string, string> {
  return activeWalletAddress ? { "x-wallet-address": activeWalletAddress } : {};
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...walletAuthHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";

/**
 * Default React Query queryFn: enforces the same 15-second deadline as named
 * core reads via coreReadJson, but does NOT use the result as a global health
 * or session verdict (coreHealth: false). Used for peripheral and public reads
 * that share the budget but should not affect the dashboard health banner.
 *
 * WO-20.1 corrections vs. original:
 *  - Accepts and propagates the RQ query-context signal (caller cancellation).
 *  - Replaces raw fetch + unclamped `setTimeout(r, retryAfterSec * 1000)` with
 *    coreReadJson, which clamps Retry-After to ≤5s and keeps everything inside
 *    one 15-second absolute budget.
 *  - Body is consumed inside the deadline (no post-timer `safeResponseJson`).
 */
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    const { status, ok, data } = await coreReadJson(
      queryKey[0] as string,
      queryKey.join("/") as string,
      { credentials: "include", headers: walletAuthHeaders() },
      { authed: false, signal, coreHealth: false },
    );

    if (unauthorizedBehavior === "returnNull" && status === 401) {
      // T is a type parameter on the outer signature, not in scope here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return null as any;
    }

    if (!ok) {
      // data is an error-shaped object from safeResponseJson for non-ok responses.
      const text =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : String(status);
      throw new Error(`${status}: ${text}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any;
  };

/**
 * Transient = worth retrying: network failures (fetch TypeError) and 5xx
 * responses. 4xx (including auth) must NOT retry — the server answered and
 * meant it. 2026-07-19 incident: `retry: false` turned a 60s DB-pool blip
 * into a permanently stuck dashboard because failed queries never re-ran.
 *
 * CoreReadTimeoutError is semantically transient (stale data is preserved by
 * React Query and a later success clears degradation), but it receives ZERO
 * automatic retries — recovery is via the health/boot transition, not by
 * dispatching a second request that is equally likely to time out. This
 * eliminates the ~51-second three-attempt path from the old code.
 */
export function isTransientReadError(error: unknown): boolean {
  if (error instanceof CoreReadTimeoutError) return true; // transient, but no auto-retry
  if (error instanceof CoreReadError) return error.kind === "server";
  if (error instanceof TypeError) return true; // fetch network failure
  if (error instanceof Error) return /^5\d\d:/.test(error.message);
  return false;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      // Bounded self-heal for transient failures only (network / 5xx): up to
      // 2 retries with exponential backoff (~2s, ~4s). Longer outages are
      // covered by the recovery listener below, which refetches every errored
      // query the moment a core read succeeds again.
      //
      // WO-20.1: CoreReadTimeoutError and AbortError (caller cancellation) are
      // explicitly excluded from automatic retry. A timeout recovery must go
      // through the health/boot transition; retrying immediately just burns the
      // budget again. Caller cancellation (wallet switch, unmount) must never
      // replay.
      retry: (failureCount, error) => {
        if (error instanceof CoreReadTimeoutError) return false;
        if (
          error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
          return false;
        if (error instanceof Error && error.name === "AbortError") return false;
        return failureCount < 2 && isTransientReadError(error);
      },
      retryDelay: (attempt) => Math.min(2_000 * 2 ** attempt, 10_000),
    },
    mutations: {
      retry: false,
    },
  },
});

// Self-heal on backend recovery: when server-health flips degraded→healthy or
// session-expired→valid (driven by the 5s positions poll succeeding), refetch
// every query stuck in an error state. Without this, non-polling reads
// (portfolio, bots, subscriptions) that failed during the outage stay failed
// forever (staleTime: Infinity, no refetch triggers) → empty dashboard until
// a full page reload.
//
// WO-20.1: the predicate now also requires:
//  - fetchStatus !== "fetching": don't interrupt queries currently retrying
//    (they already have an in-flight request; adding another would duplicate it)
//  - isTransientReadError: don't refetch auth / 4xx failures (the server
//    answered authoritatively) or non-transient app errors (mutations, etc.)
registerRecoveryListener(() => {
  queryClient
    .refetchQueries({
      predicate: (q) =>
        q.state.status === "error" &&
        q.state.fetchStatus !== "fetching" &&
        isTransientReadError(q.state.error),
    })
    .catch(() => {});
});

// Re-export safeResponseJson for callers that still need it directly
// (e.g. mutation error-body reading, non-core reads).
export { safeResponseJson };
