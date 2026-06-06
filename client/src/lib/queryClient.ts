import { safeResponseJson } from "./safe-fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

// The currently connected Solana wallet address, mirrored here so module-level
// fetch helpers can stamp an `x-wallet-address` header on every authenticated
// request. The server (requireWallet) rejects any request whose header doesn't
// match the session wallet, so this makes stale-session reads fail closed
// instead of silently leaking the previously connected wallet's data.
let activeWalletAddress: string | null = null;

export function setActiveWalletAddress(address: string | null): void {
  activeWalletAddress = address;
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

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
