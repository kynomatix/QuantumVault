import { safeResponseJson } from "@/lib/safe-fetch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "./useWallet";

// API fetch functions
async function fetchBots(featured?: boolean) {
  const url = featured ? "/api/bots?featured=true" : "/api/bots";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch bots");
  return safeResponseJson(res);
}

async function fetchSubscriptions(walletAddress: string) {
  const res = await fetch(`/api/subscriptions?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch subscriptions");
  return safeResponseJson(res);
}

async function fetchPortfolio(walletAddress: string) {
  const res = await fetch(`/api/portfolio?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch portfolio");
  return safeResponseJson(res);
}

async function fetchPositions(walletAddress: string) {
  const res = await fetch(`/api/positions`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch positions");
  const data = await safeResponseJson(res);
  return data.positions || [];
}

async function reconcilePositions() {
  const res = await fetch(`/api/positions/reconcile`, { 
    method: 'POST',
    credentials: "include" 
  });
  if (!res.ok) throw new Error("Failed to reconcile positions");
  return safeResponseJson(res);
}

async function fetchTrades(walletAddress: string, limit?: number) {
  const url = limit ? `/api/bot-trades?limit=${limit}` : `/api/bot-trades`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch trades");
  return safeResponseJson(res);
}

async function fetchLeaderboard(limit?: number) {
  const url = limit ? `/api/leaderboard?limit=${limit}` : "/api/leaderboard";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch leaderboard");
  return safeResponseJson(res);
}

async function fetchPrices(): Promise<Record<string, number>> {
  const res = await fetch("/api/prices");
  if (!res.ok) throw new Error("Failed to fetch prices");
  return safeResponseJson(res);
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
    return safeResponseJson(res);
  } catch {
    return null;
  }
}

async function fetchTradingBots(walletAddress: string) {
  const res = await fetch(`/api/trading-bots?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch trading bots");
  return safeResponseJson(res);
}

async function subscribeToBot(botId: string, walletAddress: string) {
  const res = await fetch("/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId, walletAddress }),
    credentials: "include",
  });
  if (!res.ok) {
    const error = await safeResponseJson(res);
    throw new Error(error.error || "Failed to subscribe");
  }
  return safeResponseJson(res);
}

async function updateSubscriptionStatus(id: string, status: string) {
  const res = await fetch(`/api/subscriptions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to update subscription");
  return safeResponseJson(res);
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
    refetchInterval: 5000,
    staleTime: 3000,
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
    refetchInterval: 15000,
    staleTime: 10000,
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
    refetchInterval: 5000,
    staleTime: 3000,
  });
}

export function useTradingBots() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["tradingBots", publicKeyString, sessionConnected],
    queryFn: () => fetchTradingBots(publicKeyString!),
    enabled: !!publicKeyString && sessionConnected,
    refetchOnMount: true,
    staleTime: 10000,
    refetchOnWindowFocus: true,
  });
}

export function useHealthMetrics() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["healthMetrics", publicKeyString],
    queryFn: fetchHealthMetrics,
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 15000,
    staleTime: 10000,
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
    const data = await safeResponseJson(res);
    if (!data.hasPosition) return null;
    
    return {
      healthFactor: data.healthFactor ?? 0,
      marginRatio: 0,
      totalCollateral: data.totalCollateral ?? 0,
      freeCollateral: data.freeCollateral ?? 0,
      unrealizedPnl: data.unrealizedPnl ?? 0,
      positions: [{
        marketIndex: 0,
        market: data.market ?? '',
        baseSize: data.size ?? 0,
        notionalValue: 0,
        liquidationPrice: data.liquidationPrice ?? null,
        entryPrice: data.avgEntryPrice ?? 0,
        unrealizedPnl: data.unrealizedPnl ?? 0,
      }]
    };
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

// Marketplace types
export interface PublishedBot {
  id: string;
  tradingBotId: string;
  creatorWalletAddress: string;
  name: string;
  description: string | null;
  market: string;
  isActive: boolean;
  isFeatured: boolean;
  subscriberCount: number;
  creatorCapital: string;
  totalCapitalInvested: string;
  totalTrades: number;
  winningTrades: number;
  pnlPercent7d: string | null;
  pnlPercent30d: string | null;
  pnlPercent90d: string | null;
  pnlPercentAllTime: string | null;
  profitSharePercent: string;
  publishedAt: string;
  creatorEarnings?: string; // Profit share earnings from subscribers
  creator: {
    displayName: string | null;
    xUsername: string | null;
  };
}

export interface MarketplaceSubscription {
  id: string;
  publishedBotId: string;
  capitalInvested: string;
  leverage: number;
  isActive: boolean;
  subscribedAt: string;
  publishedBot: PublishedBot;
}

// Marketplace API functions
async function fetchMarketplace(options?: { search?: string; market?: string; sortBy?: string; limit?: number }): Promise<PublishedBot[]> {
  const params = new URLSearchParams();
  if (options?.search) params.set('search', options.search);
  if (options?.market) params.set('market', options.market);
  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.limit) params.set('limit', options.limit.toString());
  
  const url = `/api/marketplace${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch marketplace");
  return safeResponseJson(res);
}

async function fetchPublishedBot(id: string): Promise<PublishedBot> {
  const res = await fetch(`/api/marketplace/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch published bot");
  return safeResponseJson(res);
}

async function fetchMySubscriptions(): Promise<MarketplaceSubscription[]> {
  const res = await fetch("/api/my-subscriptions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch subscriptions");
  return safeResponseJson(res);
}

async function checkBotPublished(botId: string): Promise<{ published: boolean; publishedBotId?: string }> {
  const res = await fetch(`/api/trading-bots/${botId}/published`, { credentials: "include" });
  if (!res.ok) return { published: false };
  return safeResponseJson(res);
}

async function publishBot(botId: string, data: { name: string; description?: string; profitSharePercent?: number }): Promise<PublishedBot> {
  const res = await fetch(`/api/trading-bots/${botId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  if (!res.ok) {
    const error = await safeResponseJson(res);
    throw new Error(error.error || "Failed to publish bot");
  }
  return safeResponseJson(res);
}

async function unpublishBot(publishedBotId: string): Promise<void> {
  const res = await fetch(`/api/marketplace/${publishedBotId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const error = await safeResponseJson(res);
    throw new Error(error.error || "Failed to unpublish bot");
  }
}

async function subscribeToPublishedBot(publishedBotId: string, data: { capitalInvested: number; leverage: number; investmentAmount?: number }): Promise<any> {
  const res = await fetch(`/api/marketplace/${publishedBotId}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  if (!res.ok) {
    const error = await safeResponseJson(res);
    // V3 Phase 3b: 412 = execution authorization required. The subscribe
    // endpoint refuses to enroll wallets that have not enabled execution (or
    // are emergency-stopped) because subscriber fan-out now strict-decrypts
    // each subscriber's agent key per signal. Throw an enriched error that
    // the subscribe UI surfaces with an "Enable Execution" prompt.
    if (res.status === 412 && error?.action === 'enable_execution') {
      const err: any = new Error(error.error || 'Execution authorization required before subscribing.');
      err.action = 'enable_execution';
      err.status = 412;
      throw err;
    }
    throw new Error(error.error || "Failed to subscribe");
  }
  return safeResponseJson(res);
}

async function unsubscribeFromBot(publishedBotId: string): Promise<void> {
  const res = await fetch(`/api/marketplace/${publishedBotId}/unsubscribe`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const error = await safeResponseJson(res);
    throw new Error(error.error || "Failed to unsubscribe");
  }
}

// Marketplace hooks
export function useMarketplace(options?: { search?: string; market?: string; sortBy?: string; limit?: number }) {
  return useQuery({
    queryKey: ["marketplace", options?.search, options?.market, options?.sortBy, options?.limit],
    queryFn: () => fetchMarketplace(options),
    staleTime: 10000,
  });
}

export function usePublishedBot(id: string | null) {
  return useQuery({
    queryKey: ["publishedBot", id],
    queryFn: () => fetchPublishedBot(id!),
    enabled: !!id,
  });
}

export function useMyMarketplaceSubscriptions() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["myMarketplaceSubscriptions", publicKeyString],
    queryFn: fetchMySubscriptions,
    enabled: !!publicKeyString && sessionConnected,
  });
}

export function useBotPublishedStatus(botId: string | null) {
  return useQuery({
    queryKey: ["botPublished", botId],
    queryFn: () => checkBotPublished(botId!),
    enabled: !!botId,
    staleTime: 30000,
  });
}

export function usePublishBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, data }: { botId: string; data: { name: string; description?: string; profitSharePercent?: number } }) =>
      publishBot(botId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      queryClient.invalidateQueries({ queryKey: ["myPublishedBots"] });
      queryClient.invalidateQueries({ queryKey: ["botPublished"] });
      queryClient.invalidateQueries({ queryKey: ["tradingBots"] });
    },
  });
}

export function useUnpublishBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publishedBotId: string) => unpublishBot(publishedBotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      queryClient.invalidateQueries({ queryKey: ["myPublishedBots"] });
      queryClient.invalidateQueries({ queryKey: ["botPublished"] });
      queryClient.invalidateQueries({ queryKey: ["tradingBots"] });
    },
  });
}

export function useSubscribeToPublishedBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ publishedBotId, data }: { publishedBotId: string; data: { capitalInvested: number; leverage: number; investmentAmount?: number } }) =>
      subscribeToPublishedBot(publishedBotId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      queryClient.invalidateQueries({ queryKey: ["myMarketplaceSubscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["tradingBots"] });
    },
  });
}

export function useUnsubscribeFromBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publishedBotId: string) => unsubscribeFromBot(publishedBotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      queryClient.invalidateQueries({ queryKey: ["myMarketplaceSubscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["tradingBots"] });
    },
  });
}

async function fetchMyPublishedBots(): Promise<PublishedBot[]> {
  const res = await fetch("/api/marketplace/my-published", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch my published bots");
  return safeResponseJson(res);
}

export function useMyPublishedBots() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["myPublishedBots", publicKeyString],
    queryFn: fetchMyPublishedBots,
    enabled: !!publicKeyString && sessionConnected,
    staleTime: 10000,
  });
}

export interface BotPerformanceData {
  botId: string;
  market: string;
  totalTrades: number;
  winningTrades: number;
  winRate: string;
  pnlPercent7d: string | null;
  pnlPercent30d: string | null;
  pnlPercent90d: string | null;
  pnlPercentAllTime: string | null;
  profitSharePercent: string;
  subscriberCount: number;
  creatorCapital: string;
  totalCapitalInvested: string;
  equityHistory: Array<{
    date: string;
    equity: number;
    pnl: number;
  }>;
}

export function useBotPerformance(botId: string | null) {
  return useQuery({
    queryKey: ['/api/marketplace', botId, 'performance'],
    queryFn: async (): Promise<BotPerformanceData | null> => {
      if (!botId) return null;
      const res = await fetch(`/api/marketplace/${botId}/performance`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch performance');
      return safeResponseJson(res);
    },
    enabled: !!botId,
  });
}

export interface PortfolioPerformanceData {
  currentBalance: number;
  totalDeposits: number;
  totalWithdrawals: number;
  netPnl: number;
  pnlPercent: number;
  activeBotCount: number;
  totalBots: number;
  totalTrades: number;
  totalVolume: number;
  creatorEarnings: number;
  chartData: Array<{ date: string; netPnl: number; pnlPercent: number; balance: number }>;
}

async function fetchPortfolioPerformance(range: string): Promise<PortfolioPerformanceData | null> {
  try {
    const res = await fetch(`/api/portfolio-performance?range=${encodeURIComponent(range)}`, { credentials: "include" });
    if (!res.ok) return null;
    return safeResponseJson(res);
  } catch {
    return null;
  }
}

export function usePortfolioPerformance(range: string = '3m') {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["portfolioPerformance", publicKeyString, range],
    queryFn: () => fetchPortfolioPerformance(range),
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 30000,
    staleTime: 20000,
  });
}

export interface PortfolioBotEntry {
  id: string;
  name: string;
  market: string;
  isActive: boolean;
  netPnl: number;
  pnlPercent: number;
  netDeposited: number;
  totalTrades: number;
  winRate: number;
  sharpe: number | null;
  sparkline: { t: string; v: number }[];
}

export interface PortfolioMarketEntry {
  market: string;
  pnl: number;
  pnlPercent: number;
  count: number;
  winRate: number;
}

export interface PortfolioBotPerformanceData {
  bots: PortfolioBotEntry[];
  markets: PortfolioMarketEntry[];
  range: string;
}

async function fetchPortfolioBotPerformance(range: string): Promise<PortfolioBotPerformanceData | null> {
  try {
    const res = await fetch(`/api/portfolio/bot-performance?range=${encodeURIComponent(range)}`, { credentials: "include" });
    if (!res.ok) return null;
    return safeResponseJson(res);
  } catch {
    return null;
  }
}

export function usePortfolioBotPerformance(range: string = 'all') {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["portfolioBotPerformance", publicKeyString, range],
    queryFn: () => fetchPortfolioBotPerformance(range),
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 60000,
    staleTime: 30000,
  });
}
