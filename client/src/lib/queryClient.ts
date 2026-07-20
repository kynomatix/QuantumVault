import { safeResponseJson } from "./safe-fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { CoreReadError, registerRecoveryListener } from "./server-health";

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
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    let res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: walletAuthHeaders(),
    });

    if (res.status === 503) {
      const retryAfterSec = parseInt(res.headers.get("Retry-After") || "5", 10);
      await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
      res = await fetch(queryKey.join("/") as string, {
        credentials: "include",
        headers: walletAuthHeaders(),
      });
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await safeResponseJson(res);
  };

/**
 * Transient = worth retrying: network failures (fetch TypeError) and 5xx
 * responses. 4xx (including auth) must NOT retry — the server answered and
 * meant it. 2026-07-19 incident: `retry: false` turned a 60s DB-pool blip
 * into a permanently stuck dashboard because failed queries never re-ran.
 */
export function isTransientReadError(error: unknown): boolean {
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
      retry: (failureCount, error) => failureCount < 2 && isTransientReadError(error),
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
registerRecoveryListener(() => {
  queryClient
    .refetchQueries({ predicate: (q) => q.state.status === "error" })
    .catch(() => {});
});
