import { safeResponseJson } from "@/lib/safe-fetch";
import { coreFetch, coreReadJson, CoreReadError } from "@/lib/server-health";
import { walletAuthHeaders } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "./useWallet";

// API fetch functions
// Core dashboard reads (bots, positions, portfolio) go through coreReadJson so
// a degraded server (5xx / network failure) raises the "connection lost" banner
// and a 401/403 raises the "session expired" state instead of the UI silently
// rendering empty states (2026-07-19 incident). They also send the explicit
// x-wallet-address header so the server fail-closes if its session identifies
// a different wallet than the one active in the UI — a stale cookie must never
// return another wallet's (or an empty) view as if it were this wallet's data.
//
// WO-20.1: all 9 account-critical reads now use coreReadJson, which enforces a
// 15-second budget that covers body consumption (not just the initial request),
// propagates the React Query cancellation signal, and reports health correctly.
async function fetchBots(featured?: boolean) {
  const url = featured ? "/api/bots?featured=true" : "/api/bots";
  // Public (unauthenticated) endpoint: its 200s say nothing about the wallet
  // session, so it must not clear the session-expired latch.
  const res = await coreFetch(url, { credentials: "include" }, { authed: false });
  if (!res.ok) throw new CoreReadError("bots", res.status);
  return safeResponseJson(res);
}

// NOTE: /api/portfolio and /api/subscriptions are LEGACY routes from the old
// username/password demo system (requireAuth → req.session.userId, which the
// wallet sign-in flow never sets). They 401 for every wallet user by design.
// Routing them through coreFetch(authed) falsely latched the "session expired"
// banner in an unfixable loop (2026-07-20). Their hooks were removed — do not
// re-add client calls to these endpoints.

async function fetchPositions(walletAddress: string, signal?: AbortSignal) {
  // Explicit wallet identity: the session cookie alone could be pinned to a
  // previously connected wallet. The header makes the server fail closed
  // (403) on any mismatch instead of silently answering for the wrong wallet.
  const { ok, status, data } = await coreReadJson(
    "positions",
    `/api/positions?wallet=${walletAddress}`,
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (!ok) throw new CoreReadError("positions", status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data as any).positions || [];
}

async function reconcilePositions() {
  const res = await fetch(`/api/positions/reconcile`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to reconcile positions");
  return safeResponseJson(res);
}

async function fetchTrades(walletAddress: string, limit?: number, signal?: AbortSignal) {
  const url = limit ? `/api/bot-trades?limit=${limit}` : `/api/bot-trades`;
  const { ok, status, data } = await coreReadJson(
    "trades",
    url,
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (!ok) throw new CoreReadError("trades", status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
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

async function fetchHealthMetrics(signal?: AbortSignal): Promise<HealthMetrics | null> {
  // 404 = genuinely no Drift account opened yet (not an error, render null).
  // All other non-ok responses throw so React Query enters error state (never
  // false-empty). WO-20.1: body consumption is now inside the 15-second budget
  // via coreReadJson.
  const { ok, status, data } = await coreReadJson(
    "health-metrics",
    "/api/health-metrics",
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (status === 404) return null;
  if (!ok) throw new CoreReadError("health-metrics", status);
  return data as HealthMetrics;
}

async function fetchTradingBots(walletAddress: string, signal?: AbortSignal) {
  const { ok, status, data } = await coreReadJson(
    "trading-bots",
    `/api/trading-bots?wallet=${walletAddress}`,
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (!ok) throw new CoreReadError("trading bots", status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

// Hooks
export function useBots(featured?: boolean) {
  return useQuery({
    queryKey: ["bots", featured],
    queryFn: () => fetchBots(featured),
  });
}

export function usePositions() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["positions", publicKeyString],
    queryFn: ({ signal }) => fetchPositions(publicKeyString!, signal),
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
    queryFn: ({ signal }) => fetchTrades(publicKeyString!, limit, signal),
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

export interface LeaderboardSparklinesResponse {
  range: string;
  sparklines: Record<string, Array<{ date: string; pnlPercent: number }>>;
}

async function fetchLeaderboardSparklines(
  wallets: string[],
  range: string,
): Promise<LeaderboardSparklinesResponse> {
  if (wallets.length === 0) return { range, sparklines: {} };
  const params = new URLSearchParams({
    wallets: wallets.join(","),
    range,
  });
  const res = await fetch(`/api/leaderboard/sparklines?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch leaderboard sparklines");
  return safeResponseJson(res);
}

export function useLeaderboardSparklines(wallets: string[], range: string = "30d") {
  const key = wallets.slice().sort().join(",");
  return useQuery({
    queryKey: ["leaderboardSparklines", key, range],
    queryFn: () => fetchLeaderboardSparklines(wallets, range),
    enabled: wallets.length > 0,
    staleTime: 60_000,
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
    queryFn: ({ signal }) => fetchTradingBots(publicKeyString!, signal),
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
    queryFn: ({ signal }) => fetchHealthMetrics(signal),
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

async function fetchBotHealth(botId: string, signal?: AbortSignal): Promise<BotHealthMetrics | null> {
  const { ok, status, data } = await coreReadJson(
    "bot-health",
    `/api/trading-bots/${botId}/position`,
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  // 404 = bot not found or no position yet — genuine not-found, not an error.
  if (status === 404) return null;
  if (!ok) throw new CoreReadError("bot-health", status);
  const d = data as Record<string, unknown>;
  if (!d.hasPosition) return null; // position slot exists but is empty

  return {
    healthFactor: (d.healthFactor as number) ?? 0,
    marginRatio: 0,
    totalCollateral: (d.totalCollateral as number) ?? 0,
    freeCollateral: (d.freeCollateral as number) ?? 0,
    unrealizedPnl: (d.unrealizedPnl as number) ?? 0,
    positions: [
      {
        marketIndex: 0,
        market: (d.market as string) ?? "",
        baseSize: (d.size as number) ?? 0,
        notionalValue: 0,
        liquidationPrice: (d.liquidationPrice as number | null) ?? null,
        entryPrice: (d.avgEntryPrice as number) ?? 0,
        unrealizedPnl: (d.unrealizedPnl as number) ?? 0,
      },
    ],
  };
}

export function useBotHealth(botId: string | null, enabled: boolean = false) {
  return useQuery({
    queryKey: ["botHealth", botId],
    queryFn: ({ signal }) => fetchBotHealth(botId!, signal),
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
  activeProtocol?: "pacifica" | "drift" | "flash" | null;
  creator: {
    displayName: string | null;
    xUsername: string | null;
  };
}

// V3 Phase 3b: typed error thrown by `subscribeToPublishedBot` when the
// backend returns 412 because the subscriber has not yet authorized
// server-side execution. The subscribe UI catches this specific class to
// route the user through `enableExecution()` instead of just showing a
// generic toast. Using a real subclass (vs. an `any`-tagged Error) lets
// `error instanceof SubscribeAuthorizationRequiredError` stay type-safe.
export class SubscribeAuthorizationRequiredError extends Error {
  readonly action = "enable_execution" as const;
  readonly status = 412 as const;
  constructor(message: string) {
    super(message);
    this.name = "SubscribeAuthorizationRequiredError";
  }
}

export interface MarketplaceSubscription {
  id: string;
  publishedBotId: string;
  capitalInvested: string;
  leverage: number;
  isActive: boolean;
  subscribedAt: string;
  publishedBot: PublishedBot;
  // V3 Phase 3b: when fan-out can't decrypt the subscriber's agent key (e.g.
  // execution revoked, emergency-stopped, or no V3 key), the subscription is
  // paused with a machine-readable reason so the UI can tell the subscriber
  // exactly why their copy bot stopped trading.
  status?: "active" | "paused" | "cancelled" | string;
  subscriptionStatusReason?:
    | "execution_disabled"
    | "emergency_stopped"
    | "v3_decrypt_failed"
    | string
    | null;
}

// Marketplace API functions
async function fetchMarketplace(options?: {
  search?: string;
  market?: string;
  sortBy?: string;
  limit?: number;
}): Promise<PublishedBot[]> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  if (options?.market) params.set("market", options.market);
  if (options?.sortBy) params.set("sortBy", options.sortBy);
  if (options?.limit) params.set("limit", options.limit.toString());

  const url = `/api/marketplace${params.toString() ? "?" + params.toString() : ""}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch marketplace");
  return safeResponseJson(res);
}

async function fetchPublishedBot(id: string): Promise<PublishedBot> {
  const res = await fetch(`/api/marketplace/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch published bot");
  return safeResponseJson(res);
}

async function fetchMySubscriptions(signal?: AbortSignal): Promise<MarketplaceSubscription[]> {
  const { ok, status, data } = await coreReadJson(
    "subscriptions",
    "/api/my-subscriptions",
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (!ok) throw new CoreReadError("subscriptions", status);
  return data as MarketplaceSubscription[];
}

async function checkBotPublished(
  botId: string,
): Promise<{ published: boolean; publishedBotId?: string }> {
  const res = await fetch(`/api/trading-bots/${botId}/published`, {
    credentials: "include",
  });
  if (!res.ok) return { published: false };
  return safeResponseJson(res);
}

async function publishBot(
  botId: string,
  data: { name: string; description?: string; profitSharePercent?: number },
): Promise<PublishedBot> {
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

async function subscribeToPublishedBot(
  publishedBotId: string,
  data: { capitalInvested: number; leverage: number; investmentAmount?: number },
): Promise<any> {
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
    if (res.status === 412 && error?.action === "enable_execution") {
      throw new SubscribeAuthorizationRequiredError(
        error.error || "Execution authorization required before subscribing.",
      );
    }
    throw new Error(error.error || "Failed to subscribe");
  }
  return safeResponseJson(res);
}

interface UnsubscribeResult {
  success: boolean;
  recovered?: boolean;
  recoveredAmount?: number;
  rentReclaimed?: boolean;
  message?: string;
}

async function unsubscribeFromBot(publishedBotId: string): Promise<UnsubscribeResult> {
  const res = await fetch(`/api/marketplace/${publishedBotId}/unsubscribe`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const error = await safeResponseJson(res);
    throw new Error(error.error || "Failed to unsubscribe");
  }
  return safeResponseJson(res);
}

// Marketplace hooks
export function useMarketplace(options?: {
  search?: string;
  market?: string;
  sortBy?: string;
  limit?: number;
}) {
  return useQuery({
    queryKey: [
      "marketplace",
      options?.search,
      options?.market,
      options?.sortBy,
      options?.limit,
    ],
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
    queryFn: ({ signal }) => fetchMySubscriptions(signal),
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
    mutationFn: ({
      botId,
      data,
    }: {
      botId: string;
      data: { name: string; description?: string; profitSharePercent?: number };
    }) => publishBot(botId, data),
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
    mutationFn: ({
      publishedBotId,
      data,
    }: {
      publishedBotId: string;
      data: { capitalInvested: number; leverage: number; investmentAmount?: number };
    }) => subscribeToPublishedBot(publishedBotId, data),
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

async function fetchMyPublishedBots(signal?: AbortSignal): Promise<PublishedBot[]> {
  const { ok, status, data } = await coreReadJson(
    "my-published-bots",
    "/api/marketplace/my-published",
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (!ok) throw new CoreReadError("my-published-bots", status);
  return data as PublishedBot[];
}

export function useMyPublishedBots() {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["myPublishedBots", publicKeyString],
    queryFn: ({ signal }) => fetchMyPublishedBots(signal),
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
    queryKey: ["/api/marketplace", botId, "performance"],
    queryFn: async (): Promise<BotPerformanceData | null> => {
      if (!botId) return null;
      const res = await fetch(`/api/marketplace/${botId}/performance`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch performance");
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

async function fetchPortfolioPerformance(
  range: string,
  signal?: AbortSignal,
): Promise<PortfolioPerformanceData | null> {
  const { ok, status, data } = await coreReadJson(
    "portfolio-performance",
    `/api/portfolio-performance?range=${encodeURIComponent(range)}`,
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (status === 404) return null;
  if (!ok) throw new CoreReadError("portfolio-performance", status);
  return data as PortfolioPerformanceData;
}

export function usePortfolioPerformance(range: string = "3m") {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["portfolioPerformance", publicKeyString, range],
    queryFn: ({ signal }) => fetchPortfolioPerformance(range, signal),
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

async function fetchPortfolioBotPerformance(
  range: string,
  signal?: AbortSignal,
): Promise<PortfolioBotPerformanceData | null> {
  const { ok, status, data } = await coreReadJson(
    "portfolio-bot-performance",
    `/api/portfolio/bot-performance?range=${encodeURIComponent(range)}`,
    { credentials: "include", headers: walletAuthHeaders() },
    { signal, coreHealth: true },
  );
  if (status === 404) return null;
  if (!ok) throw new CoreReadError("portfolio-bot-performance", status);
  return data as PortfolioBotPerformanceData;
}

export function usePortfolioBotPerformance(range: string = "all") {
  const { publicKeyString, sessionConnected } = useWallet();
  return useQuery({
    queryKey: ["portfolioBotPerformance", publicKeyString, range],
    queryFn: ({ signal }) => fetchPortfolioBotPerformance(range, signal),
    enabled: !!publicKeyString && sessionConnected,
    refetchInterval: 60000,
    staleTime: 30000,
  });
}
