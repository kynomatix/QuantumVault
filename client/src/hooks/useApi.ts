import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "./useWallet";

// API fetch functions
async function fetchBots(featured?: boolean) {
  const url = featured ? "/api/bots?featured=true" : "/api/bots";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch bots");
  return res.json();
}

async function fetchSubscriptions(walletAddress: string) {
  const res = await fetch(`/api/subscriptions?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch subscriptions");
  return res.json();
}

async function fetchPortfolio(walletAddress: string) {
  const res = await fetch(`/api/portfolio?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch portfolio");
  return res.json();
}

async function fetchPositions(walletAddress: string) {
  const res = await fetch(`/api/positions`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch positions");
  const data = await res.json();
  return data.positions || [];
}

async function reconcilePositions() {
  const res = await fetch(`/api/positions/reconcile`, { 
    method: 'POST',
    credentials: "include" 
  });
  if (!res.ok) throw new Error("Failed to reconcile positions");
  return res.json();
}

async function fetchTrades(walletAddress: string, limit?: number) {
  const url = limit ? `/api/bot-trades?limit=${limit}` : `/api/bot-trades`;
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

async function fetchPrices(): Promise<Record<string, number>> {
  const res = await fetch("/api/prices");
  if (!res.ok) throw new Error("Failed to fetch prices");
  return res.json();
}

export interface HealthMetrics {
  healthFactor: number;
  marginRatio: number;
  totalCollateral: number;
  freeCollateral: number;
  unrealizedPnl: number;
  positions: Array<{
    marketIndex: number;
    market: string;
    baseSize: number;
    notionalValue: number;
    liquidationPrice: number | null;
    entryPrice: number;
    unrealizedPnl: number;
  }>;
}

async function fetchHealthMetrics(): Promise<HealthMetrics | null> {
  try {
    const res = await fetch("/api/health-metrics", { credentials: "include" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchTradingBots(walletAddress: string) {
  const res = await fetch(`/api/trading-bots?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch trading bots");
  return res.json();
}

async function subscribeToBot(botId: string, walletAddress: string) {
  const res = await fetch("/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId, walletAddress }),
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
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["subscriptions", publicKeyString],
    queryFn: () => fetchSubscriptions(publicKeyString!),
    enabled: !!publicKeyString && sessionConnected,
  });
}

export function usePortfolio() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["portfolio", publicKeyString],
    queryFn: () => fetchPortfolio(publicKeyString!),
    enabled: !!publicKeyString && sessionConnected,
  });
}

export function usePositions() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["positions", publicKeyString],
    queryFn: () => fetchPositions(publicKeyString!),
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 2000,
    staleTime: 1500,
  });
}

export function useReconcilePositions() {
  const queryClient = useQueryClient();
  const { publicKeyString } = useWallet();
  return useMutation({
    mutationFn: reconcilePositions,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["positions", publicKeyString] });
    },
  });
}

export function useTrades(limit?: number) {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["trades", publicKeyString, limit],
    queryFn: () => fetchTrades(publicKeyString!, limit),
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 5000,
    staleTime: 3000,
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
  const { publicKeyString } = useWallet();
  return useMutation({
    mutationFn: (botId: string) => subscribeToBot(botId, publicKeyString!),
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

export function usePrices() {
  return useQuery({
    queryKey: ["prices"],
    queryFn: fetchPrices,
    refetchInterval: 1500,
    staleTime: 1000,
  });
}

export function useTradingBots() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["tradingBots", publicKeyString, sessionConnected],
    queryFn: () => fetchTradingBots(publicKeyString!),
    enabled: !!publicKeyString && sessionConnected,
    refetchOnMount: true,
    staleTime: 1000,
    refetchOnWindowFocus: true,
  });
}

export function useHealthMetrics() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["healthMetrics", publicKeyString],
    queryFn: fetchHealthMetrics,
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 10000,
    staleTime: 8000,
  });
}

export interface BotHealthMetrics {
  healthFactor: number;
  marginRatio: number;
  totalCollateral: number;
  freeCollateral: number;
  unrealizedPnl: number;
  positions: Array<{
    marketIndex: number;
    market: string;
    baseSize: number;
    notionalValue: number;
    liquidationPrice: number | null;
    entryPrice: number;
    unrealizedPnl: number;
  }>;
}

async function fetchBotHealth(botId: string): Promise<BotHealthMetrics | null> {
  try {
    const res = await fetch(`/api/trading-bots/${botId}/position`, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    return data.health || null;
  } catch {
    return null;
  }
}

export function useBotHealth(botId: string | null, enabled: boolean = false) {
  return useQuery({
    queryKey: ["botHealth", botId],
    queryFn: () => fetchBotHealth(botId!),
    enabled: !!botId && enabled,
    staleTime: 5000,
  });
}
