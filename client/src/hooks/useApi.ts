import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

// API fetch functions
async function fetchBots(featured?: boolean) {
  const url = featured ? "/api/bots?featured=true" : "/api/bots";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch bots");
  return res.json();
}

async function fetchSubscriptions() {
  const res = await fetch("/api/subscriptions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch subscriptions");
  return res.json();
}

async function fetchPortfolio() {
  const res = await fetch("/api/portfolio", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch portfolio");
  return res.json();
}

async function fetchPositions() {
  const res = await fetch("/api/positions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch positions");
  return res.json();
}

async function fetchTrades(limit?: number) {
  const url = limit ? `/api/trades?limit=${limit}` : "/api/trades";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch trades");
  return res.json();
}

async function fetchLeaderboard(limit?: number) {
  const url = limit ? `/api/leaderboard?limit=${limit}` : "/api/leaderboard";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch leaderboard");
  return res.json();
}

async function subscribeToBot(botId: string) {
  const res = await fetch("/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId }),
    credentials: "include",
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || "Failed to subscribe");
  }
  return res.json();
}

async function updateSubscriptionStatus(id: string, status: string) {
  const res = await fetch(`/api/subscriptions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to update subscription");
  return res.json();
}

// Hooks
export function useBots(featured?: boolean) {
  return useQuery({
    queryKey: ["bots", featured],
    queryFn: () => fetchBots(featured),
  });
}

export function useSubscriptions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["subscriptions"],
    queryFn: fetchSubscriptions,
    enabled: !!user,
  });
}

export function usePortfolio() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: fetchPortfolio,
    enabled: !!user,
  });
}

export function usePositions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["positions"],
    queryFn: fetchPositions,
    enabled: !!user,
  });
}

export function useTrades(limit?: number) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["trades", limit],
    queryFn: () => fetchTrades(limit),
    enabled: !!user,
  });
}

export function useLeaderboard(limit?: number) {
  return useQuery({
    queryKey: ["leaderboard", limit],
    queryFn: () => fetchLeaderboard(limit),
  });
}

export function useSubscribeToBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: subscribeToBot,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["bots"] });
    },
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateSubscriptionStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    },
  });
}
