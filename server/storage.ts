import { eq, ne, desc, asc, sql, and, or, ilike, gte, lte, lt, inArray, notInArray, isNotNull, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { vaultLockKey as computeVaultLockKey } from "./vault/scope";
import { db } from "./db";
import Decimal from "decimal.js";
import { sumNetDepositedFromEvents, VAULT_INTERNAL_EVENT_TYPES } from "./equity-events-util";
import {
  users,
  wallets,
  bots,
  tradingBots,
  protocolSubaccounts,
  type ProtocolSubaccount,
  botTrades,
  botPositions,
  equityEvents,
  vaultPositions,
  borrowPositions,
  borrowOperations,
  fyPositions,
  yieldPriceSnapshots,
  yieldApyCache,
  loopRateSamples,
  loopPolicyDecisions,
  loopTickHeartbeats,
  webhookLogs,
  subscriptions,
  portfolios,
  positions,
  trades,
  leaderboardStats,
  orphanedSubaccounts,
  errorLog,
  type ErrorLog,
  type InsertErrorLog,
  publishedBots,
  botSubscriptions,
  pnlSnapshots,
  marketplaceEquitySnapshots,
  telegramConnectionTokens,
  tradeRetryQueue,
  platformMetrics,
  pendingProfitShares,
  portfolioDailySnapshots,
  type User,
  type InsertUser,
  type Wallet,
  type InsertWallet,
  type Bot,
  type InsertBot,
  type TradingBot,
  type InsertTradingBot,
  type BotTrade,
  type InsertBotTrade,
  type BotPosition,
  type InsertBotPosition,
  type EquityEvent,
  type InsertEquityEvent,
  type VaultPosition,
  type BorrowPosition,
  type BorrowOperation,
  type FyPosition,
  type InsertFyPosition,
  type YieldPriceSnapshot,
  type InsertYieldPriceSnapshot,
  type YieldApyCache,
  type InsertYieldApyCache,
  type LoopRateSample,
  type InsertLoopRateSample,
  type LoopPolicyDecision,
  type InsertLoopPolicyDecision,
  type LoopTickHeartbeat,
  type InsertLoopTickHeartbeat,
  type WebhookLog,
  type InsertWebhookLog,
  type Subscription,
  type InsertSubscription,
  type Portfolio,
  type InsertPortfolio,
  type Position,
  type InsertPosition,
  type Trade,
  type InsertTrade,
  type LeaderboardStats,
  type InsertLeaderboardStats,
  type OrphanedSubaccount,
  type InsertOrphanedSubaccount,
  type PublishedBot,
  type InsertPublishedBot,
  type BotSubscription,
  type InsertBotSubscription,
  type PnlSnapshot,
  type InsertPnlSnapshot,
  type MarketplaceEquitySnapshot,
  type InsertMarketplaceEquitySnapshot,
  authNonces,
  type AuthNonce,
  type InsertAuthNonce,
  type TelegramConnectionToken,
  type InsertTelegramConnectionToken,
  type TradeRetryQueue,
  type InsertTradeRetryQueue,
  type PlatformMetric,
  type InsertPlatformMetric,
  type PlatformMetricType,
  type PendingProfitShare,
  type InsertPendingProfitShare,
  type PortfolioDailySnapshot,
  type InsertPortfolioDailySnapshot,
  platformCumulativeStats,
  type PlatformCumulativeStats,
  referralLinks,
  referralRewardEvents,
  type ReferralLink,
  type InsertReferralLink,
  type ReferralRewardEvent,
  type InsertReferralRewardEvent,
  aiTraderBots,
  aiTraderDecisions,
  type AiTraderBot,
  type InsertAiTraderBot,
  type AiTraderDecision,
  type InsertAiTraderDecision,
} from "@shared/schema";

/** A spare subaccount row atomically claimed for reuse (Subaccount Recycling Plan §5.1). */
export type ClaimedSpare = {
  id: number;
  walletAddress: string;
  protocol: string;
  protocolSubaccountId: string | null;
  agentPublicKey: string | null;
  subaccountKeyEncryptedV3: string | null;
  aadVersion: number | null;
  botId: string | null;
  claimToken: string | null;
  status: string;
  // HD-derivation metadata retained from the original bot. NULL/NULL for legacy
  // random-key spares; non-null for HD spares (the reused bot inherits these so the
  // seed fallback re-derives the SAME pubkey).
  derivationIndex: number | null;
  derivationPathVersion: number | null;
};

/** Input for storage.recordError — the central admin error-log upsert (see error_log table). */
export type ErrorLogInput = {
  fingerprint: string;
  category: string;
  severity?: string;
  source?: string | null;
  message: string;
  detail?: string | null;
  context?: unknown;
  /** Increment amount for coalesced flushes (default 1). */
  count?: number;
  /** Occurrence time (default now); used for both firstSeen on insert and lastSeen. */
  lastSeen?: Date;
};

export type ErrorLogFilter = {
  category?: string;
  severity?: string;
  resolved?: boolean;
  since?: Date;
  limit?: number;
  offset?: number;
};

export type ErrorStatRow = {
  category: string;
  severity: string;
  rows: number;
  occurrences: number;
  unresolved: number;
};

/**
 * WO-15A: batch financial-enrichment result keyed by trading-bot ID.
 * Returned by getTradingBotListEnrichment; consumed by the route slice (WO-15B/15C).
 * All maps are absent-key = zero/undefined (never contain another wallet's data).
 */
export type BotListEnrichment = {
  /** Canonical trade count per bot (getCanonicalBotTradeCount semantics, phantom-dup excluded). */
  tradeCounts: Map<string, number>;
  /** All bot_positions rows per bot (unique per bot+market; slice by bot.market in route). */
  positions: Map<string, BotPosition[]>;
  /** Published-bot row per bot (unique by schema; absent = not published). */
  publishedBotMap: Map<string, PublishedBot>;
  /** Net-deposited (signed external sum) + totalDeposits (positive external sum) per bot. */
  equityAgg: Map<string, { netDeposited: number; totalDeposits: number }>;
  /** Open USDC borrow debt in USD per bot (sumOpenBorrowDebtUsdcForBot semantics). */
  borrowDebts: Map<string, number>;
};

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getWallet(address: string): Promise<Wallet | undefined>;
  getWalletByAgentPublicKey(agentPublicKey: string): Promise<Wallet | undefined>;
  getWalletByWebhookSecret(secret: string): Promise<Wallet | undefined>;
  getWalletByReferralCode(referralCode: string): Promise<Wallet | undefined>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  updateWalletLastSeen(address: string): Promise<void>;
  getOrCreateWallet(address: string): Promise<Wallet>;
  updateWalletAgentKeys(address: string, agentPublicKey: string, agentPrivateKeyEncrypted: string): Promise<void>;
  updateWalletAgentKeyV3(address: string, agentPrivateKeyEncryptedV3: string): Promise<void>;
  setWalletLlmApiKey(address: string, encryptedV3: string, last4: string, provider: string): Promise<void>;
  clearWalletLlmApiKey(address: string): Promise<void>;
  getWalletLlmApiKeyMeta(address: string): Promise<{ hasKey: boolean; last4: string | null; provider: string | null; updatedAt: Date | null }>;
  getWalletLlmApiKeyCiphertext(address: string): Promise<string | null>;
  updateWalletWebhookSecret(address: string, userWebhookSecret: string): Promise<void>;
  updateWallet(address: string, updates: Partial<InsertWallet>): Promise<Wallet | undefined>;
  addRecoveredOrphanIndices(address: string, indices: number[]): Promise<void>;
  markPacificaBuilderApproved(agentPublicKey: string): Promise<void>;
  markPacificaReferralClaimed(agentPublicKey: string): Promise<void>;
  // Task 201: QuantumLab Assistant hands-off auto-mode admin whitelist.
  isHandsOffApproved(address: string): Promise<boolean>;
  setHandsOffApproved(address: string, approved: boolean): Promise<void>;
  listHandsOffApproved(): Promise<{ address: string; displayName: string | null }[]>;
  // Task 149: per-bot Pacifica enrollment (each Phase 4b bot is its own
  // Pacifica main account, keyed by trading_bots.protocol_subaccount_id).
  getBotByAgentPublicKey(agentPublicKey: string): Promise<TradingBot | undefined>;
  markBotPacificaBuilderApproved(agentPublicKey: string): Promise<void>;
  markBotPacificaReferralClaimed(agentPublicKey: string): Promise<void>;

  getAllBots(): Promise<Bot[]>;
  getFeaturedBots(): Promise<Bot[]>;
  getBotById(id: string): Promise<Bot | undefined>;
  createBot(bot: InsertBot): Promise<Bot>;
  incrementBotSubscribers(botId: string, delta: number): Promise<void>;

  getTradingBots(walletAddress: string): Promise<TradingBot[]>;
  getTradingBotById(id: string): Promise<TradingBot | undefined>;
  getTradingBotBySecret(webhookSecret: string): Promise<TradingBot | undefined>;
  // Admin "Errors" panel — bounded, deduped critical-error log.
  recordError(input: ErrorLogInput): Promise<void>;
  listErrors(filter?: ErrorLogFilter): Promise<ErrorLog[]>;
  getErrorStats(since?: Date): Promise<ErrorStatRow[]>;
  setErrorResolved(id: string, resolved: boolean): Promise<void>;
  pruneErrors(opts?: { maxAgeDays?: number; maxRows?: number }): Promise<{ deletedByAge: number; deletedByCap: number }>;

  getNextSubaccountId(walletAddress: string): Promise<number>;
  getAllocatedSubaccountIds(walletAddress: string): Promise<number[]>;
  getAllocatedProtocolSubaccountIds(walletAddress: string, protocol?: string): Promise<string[]>;
  assignProtocolSubaccountId(botId: string, protocolSubaccountId: string, protocol: string): Promise<void>;
  clearProtocolSubaccount(botId: string): Promise<void>;
  findBotByProtocolSubaccount(walletAddress: string, protocolSubaccountId: string, protocol?: string): Promise<TradingBot | undefined>;
  // Subaccount Recycling Plan §7.2 (Phase D). Pool a swept-empty subaccount as a
  // reusable spare, retaining its re-bound (POOLED v2) signing key. Upserts on the
  // unique (protocol, protocolSubaccountId) so a backfilled row is updated in place.
  poolSubaccountAsSpare(params: {
    walletAddress: string;
    protocol: string;
    protocolSubaccountId: string;
    agentPublicKey: string | null;
    subaccountKeyEncryptedV3: string;
    aadVersion: number;
  }): Promise<void>;
  // Subaccount Recycling Plan §7.2.4 (Phase D). Quarantine a subaccount whose
  // sub→main transfer failed: funds are stranded, so it must NOT be pooled. Keeps
  // the bot link and records the error. Upserts on (protocol, protocolSubaccountId).
  markSubaccountStuckFunds(params: {
    walletAddress: string;
    protocol: string;
    protocolSubaccountId: string;
    botId: string | null;
    agentPublicKey: string | null;
    lastError: string;
    // §5.1.4: when set, the quarantine is CAS-guarded on (status='reserving' AND
    // claim_token) so a stale lease holder cannot clobber a reclaimed/finalized row.
    // Returns false when the CAS is lost (lease no longer ours). Omit for paths that
    // own the row outright (delete / fresh-provision).
    claimToken?: string;
  }): Promise<boolean>;
  // Subaccount Recycling Plan §5.1 (Phase E). Atomically claim the oldest reusable
  // spare for a given (wallet, protocol, agent), flipping it spare→reserving under a
  // per-reservation token. Uses FOR UPDATE SKIP LOCKED so concurrent creates never
  // hand out the same spare. Only claims rows that still have a retained key + id.
  // Returns the claimed row, or undefined when the pool is empty.
  claimSpareSubaccount(params: {
    walletAddress: string;
    protocol: string;
    agentPublicKey: string;
    claimToken: string;
  }): Promise<ClaimedSpare | undefined>;
  // §5.1. Finalize a reservation: reserving→active, attach the new bot, clear the
  // token. CAS-guarded on (status='reserving' AND claim_token) so a lost race (token
  // mismatch / already recovered) returns false instead of clobbering another owner.
  finalizeReusedSubaccount(params: {
    protocol: string;
    protocolSubaccountId: string;
    claimToken: string;
    botId: string;
  }): Promise<boolean>;
  // §5.1.4. Return a still-reserving slot to the spare pool (verified empty). CAS on
  // status='reserving' (+ optional token). Refreshes released_at/last_verified_empty_at.
  releaseReservationToSpare(params: {
    protocol: string;
    protocolSubaccountId: string;
    claimToken?: string;
  }): Promise<boolean>;
  // §5.1.4. Reservations whose lease (claimed_at) is older than ttlMs — recovery input.
  findExpiredReservations(ttlMs: number): Promise<ProtocolSubaccount[]>;
  // §8. Record a successful verify-empty check (advisory freshness for the next reuse).
  markSubaccountVerifiedEmpty(protocol: string, protocolSubaccountId: string): Promise<void>;
  createTradingBot(bot: InsertTradingBot): Promise<TradingBot>;
  // Phase 4b (Flash agent-HD wallets): atomically allocate the next monotonic HD
  // index for a wallet's per-bot wallets. Burn-on-allocate (never decremented or
  // reused, even if bot creation later fails) so an index always maps to one wallet.
  allocateBotDerivationIndex(walletAddress: string): Promise<number>;
  updateTradingBot(id: string, updates: Partial<InsertTradingBot>): Promise<TradingBot | undefined>;
  // Auto-repark idle funds: arm the debounce deadline when a position fully closes,
  // clear it when a new position opens, and atomically claim every due bot (so the
  // periodic scanner processes each exactly once). See server/vault/auto-repark.ts.
  scheduleBotAutoParkDueAt(id: string, dueAt: Date): Promise<void>;
  clearBotAutoParkDueAt(id: string): Promise<void>;
  claimDueAutoReparkBots(): Promise<TradingBot[]>;
  // Phase 4b: write V3 ciphertext for per-bot subaccount key.
  updateBotSubaccountKeyV3(id: string, encryptedV3: string): Promise<void>;
  clearTradingBotSubaccount(id: string): Promise<void>;
  deleteTradingBot(id: string): Promise<void>;
  updateTradingBotStats(id: string, stats: TradingBot['stats']): Promise<void>;
  getCanonicalBotTradeStats(tradingBotId: string): Promise<{ totalTrades: number; winningTrades: number; losingTrades: number }>;
  getCanonicalBotTradeCount(tradingBotId: string): Promise<number>;
  recomputeAndMergeBotStats(
    tradingBotId: string,
    deltas?: { totalPnlDelta?: number; totalVolumeDelta?: number; lastTradeAt?: string },
    txArg?: any,
  ): Promise<void>;
  recordCloseEventAtomic(opts: {
    botId: string;
    insert?: InsertBotTrade;
    update?: { tradeId: string; fields: Partial<InsertBotTrade> };
    deltas: { totalPnlDelta?: number; totalVolumeDelta?: number; lastTradeAt?: string };
  }): Promise<{ trade?: BotTrade; isNew: boolean }>;
  getRecentCanonicalCloseForBot(opts: {
    botId: string;
    market: string;
    sinceMs: number;
    afterTimestamp?: Date | string | null;
    sizeApprox?: number;
    sizeTolerancePct?: number;
    excludeReconciled?: boolean;
  }): Promise<BotTrade | undefined>;

  getBotTrades(tradingBotId: string, limit?: number): Promise<BotTrade[]>;
  getBotTradeCount(tradingBotId: string): Promise<number>;
  getBotTrade(tradeId: string): Promise<BotTrade | undefined>;
  getWalletBotTrades(walletAddress: string, limit?: number): Promise<BotTrade[]>;
  createBotTrade(trade: InsertBotTrade): Promise<BotTrade>;
  createBotTradeIdempotent(trade: InsertBotTrade): Promise<{ trade: BotTrade; isNew: boolean }>;
  updateBotTrade(id: string, updates: Partial<InsertBotTrade>): Promise<void>;
  getOrphanedPendingTrades(maxAgeMinutes?: number): Promise<BotTrade[]>;
  getBotPerformanceSeries(tradingBotId: string, since?: Date): Promise<{ timestamp: Date; pnl: number; cumulativePnl: number }[]>;

  createWebhookLog(log: InsertWebhookLog): Promise<WebhookLog>;
  updateWebhookLog(id: string, updates: Partial<InsertWebhookLog>): Promise<void>;
  checkDuplicateSignal(signalHash: string, botId: string): Promise<boolean>;

  createSubscription(subscription: InsertSubscription): Promise<Subscription>;
  getUserSubscriptions(userId: string): Promise<(Subscription & { bot: Bot })[]>;
  updateSubscriptionStatus(id: string, status: string): Promise<void>;

  getPortfolio(userId: string): Promise<Portfolio | undefined>;
  upsertPortfolio(portfolio: InsertPortfolio): Promise<Portfolio>;

  getUserPositions(userId: string): Promise<Position[]>;
  createPosition(position: InsertPosition): Promise<Position>;
  updatePosition(id: string, updates: Partial<InsertPosition>): Promise<void>;

  getUserTrades(userId: string, limit?: number): Promise<Trade[]>;
  createTrade(trade: InsertTrade): Promise<Trade>;

  getLeaderboard(limit?: number): Promise<(LeaderboardStats & { user: User })[]>;
  upsertLeaderboardStats(stats: InsertLeaderboardStats): Promise<LeaderboardStats>;
  getWalletLeaderboard(limit?: number): Promise<Array<{
    walletAddress: string;
    displayName: string | null;
    xUsername: string | null;
    totalVolume: number;
    totalPnl: number;
    pnlPercent: number;
    winRate: number;
    tradeCount: number;
  }>>;

  createEquityEvent(event: InsertEquityEvent): Promise<EquityEvent>;
  getEquityEventByTxSignature(txSignature: string): Promise<EquityEvent | undefined>;
  reconcileDeposit(walletAddress: string, botId: string, gap: number, onChainBalance: number): Promise<boolean>;
  getEquityEvents(walletAddress: string, limit?: number): Promise<EquityEvent[]>;
  getBotEquityEvents(tradingBotId: string, limit?: number): Promise<EquityEvent[]>;
  getBotNetDeposited(tradingBotId: string): Promise<number>;

  // Phase 0a Vaults.
  getVaultPosition(walletAddress: string, assetKey: string, tradingBotId?: string | null): Promise<VaultPosition | undefined>;
  getVaultPositions(walletAddress: string, tradingBotId?: string | null): Promise<VaultPosition[]>;
  getVaultPositionsAllScopes(walletAddress: string): Promise<VaultPosition[]>;
  applyVaultPark(p: { walletAddress: string; tradingBotId?: string | null; assetKey: string; mint: string; tokensReceivedRaw: string; usdcSpent: number; txSignature?: string; txBlockTime?: Date; notes?: string; }): Promise<VaultPosition>;
  applyVaultUnpark(p: { walletAddress: string; tradingBotId?: string | null; assetKey: string; mint: string; tokensSoldRaw: string; usdcReceived: number; txSignature?: string; txBlockTime?: Date; notesPrefix?: string; }): Promise<{ position: VaultPosition; costBasisRemoved: number; realizedPnl: number }>;

  // Vaults borrow engine (Phase C, READ-ONLY). On-chain is the source of truth;
  // these readers expose the DB-cache/audit rows for display and the exposure
  // builder. No writers here — borrow/repay money paths are gated on owner go-ahead.
  getBorrowPosition(walletAddress: string, id: string): Promise<BorrowPosition | undefined>;
  // kind defaults to 'borrow': classic borrow surfaces never see SOL-loop rows.
  // The loop engine passes kind:'loop' explicitly.
  getBorrowPositions(walletAddress: string, tradingBotId?: string | null, kind?: string): Promise<BorrowPosition[]>;
  getBorrowPositionsAllScopes(walletAddress: string, kind?: string): Promise<BorrowPosition[]>;
  getActiveBorrowPositionsAllWallets(): Promise<BorrowPosition[]>;
  // Autonomous auto-collateral-top-up scanner support (opt-in "defend the loan").
  getAutoTopUpCandidatePositions(): Promise<{ position: BorrowPosition; bot: TradingBot }[]>;
  claimBorrowPositionAutoTopupAttempt(id: string, cooldownMs: number): Promise<BorrowPosition | null>;
  claimBorrowPositionPolicyAction(id: string, cooldownMs: number): Promise<BorrowPosition | null>;
  getBorrowOperations(walletAddress: string, borrowPositionId?: string | null): Promise<BorrowOperation[]>;
  createBorrowPosition(p: { walletAddress: string; tradingBotId?: string | null; debtVenue: string; venueVaultId?: string | null; venuePositionId?: string | null; collateralAssetKey: string; collateralMint: string; collateralAmountRaw?: string; debtAssetKey?: string; debtMint: string; debtAmountRaw?: string; attributedBotId?: string | null; status?: string; kind?: string; }): Promise<BorrowPosition>;
  updateBorrowPosition(id: string, patch: { venuePositionId?: string | null; venueVaultId?: string | null; collateralAmountRaw?: string; debtAmountRaw?: string; status?: string; attributedBotId?: string | null; healthSnapshot?: BorrowPosition['healthSnapshot']; healthAsOf?: Date | null; healthSource?: string | null; lastObservedHealthBand?: string | null; healthBandChangedAt?: Date | null; lastHealthAlertBand?: string | null; lastHealthAlertAt?: Date | null; }, ifStatus?: string): Promise<BorrowPosition | undefined>;
  createBorrowOperation(p: { walletAddress: string; borrowPositionId?: string | null; operationType: string; status?: string; step?: string | null; clientRequestId?: string | null; metadata?: Record<string, unknown> | null; }): Promise<BorrowOperation>;
  updateBorrowOperation(id: string, patch: { status?: string; step?: string | null; error?: string | null; borrowPositionId?: string | null; appendTxSignature?: string; metadata?: Record<string, unknown> | null; mergeMetadata?: Record<string, unknown>; result?: Record<string, unknown> | null; }): Promise<BorrowOperation | undefined>;
  getBorrowOperationById(id: string): Promise<BorrowOperation | undefined>;
  getBorrowOperationByClientRequestId(walletAddress: string, clientRequestId: string): Promise<BorrowOperation | undefined>;
  getPendingLoopHopOperations(): Promise<BorrowOperation[]>;
  sumOpenBorrowDebtUsdc(walletAddress: string): Promise<number>;

  // Fixed Yield vault: PT holdings (cost-basis + maturity bookkeeping cache).
  createFyPosition(p: InsertFyPosition): Promise<FyPosition>;
  updateFyPosition(id: string, patch: { ptAmountRaw?: string; costBasisUsdc?: string; status?: string; notifiedMaturityAt?: Date | null; }): Promise<FyPosition | undefined>;
  getFyPositionById(id: string): Promise<FyPosition | undefined>;
  getFyPositionsByWallet(walletAddress: string, includeClosed?: boolean): Promise<FyPosition[]>;
  getMaturedUnnotifiedFyPositions(now: Date, limit?: number): Promise<FyPosition[]>;
  sumOpenBorrowDebtUsdcForBot(walletAddress: string, tradingBotId: string): Promise<number>;

  // Phase 1 Vaults yield oracle: display-only realized-APY price snapshots.
  insertYieldPriceSnapshot(s: InsertYieldPriceSnapshot): Promise<YieldPriceSnapshot>;
  getYieldPriceSnapshots(assetKey: string, since: Date): Promise<YieldPriceSnapshot[]>;
  pruneYieldPriceSnapshots(olderThan: Date): Promise<void>;
  upsertYieldApyCache(row: InsertYieldApyCache): Promise<void>;
  getYieldApyCacheAll(): Promise<YieldApyCache[]>;
  // SOL Loop Vault P3: rate telemetry samples (allocation-tick input).
  insertLoopRateSamples(rows: InsertLoopRateSample[]): Promise<void>;
  // Newest persisted sample per vault id, at or after `since` (staleness gate at caller).
  getLatestLoopRateSamples(since: Date): Promise<LoopRateSample[]>;
  // One vault's series at or after `since`, oldest first (trailing-window smoothing).
  getLoopRateSamples(vaultId: number, since: Date): Promise<LoopRateSample[]>;
  pruneLoopRateSamples(olderThan: Date): Promise<void>;
  // SOL Loop Vault P3: append-only policy decision journal (audit + hysteresis).
  insertLoopPolicyDecision(d: InsertLoopPolicyDecision): Promise<LoopPolicyDecision>;
  // Newest first; optional tick filter. Hysteresis reads the last N for one vault+wallet.
  getRecentLoopPolicyDecisions(opts: { walletAddress: string; vaultId: number; tick?: string; borrowPositionId?: string; limit: number }): Promise<LoopPolicyDecision[]>;
  pruneLoopPolicyDecisions(olderThan: Date): Promise<void>;
  // T106 gate instrumentation: cross-wallet decision window + tick heartbeats.
  listLoopPolicyDecisionsSince(since: Date, limit: number): Promise<LoopPolicyDecision[]>;
  insertLoopTickHeartbeat(h: InsertLoopTickHeartbeat): Promise<void>;
  listLoopTickHeartbeatsSince(tick: string, since: Date): Promise<LoopTickHeartbeat[]>;
  pruneLoopTickHeartbeats(olderThan: Date): Promise<void>;

  getBotPosition(tradingBotId: string, market: string): Promise<BotPosition | undefined>;
  getBotPositions(walletAddress: string): Promise<BotPosition[]>;
  upsertBotPosition(position: InsertBotPosition): Promise<BotPosition>;
  updateBotPositionFromTrade(tradingBotId: string, market: string, walletAddress: string, side: string, size: number, price: number, fee: number, tradeId: string): Promise<BotPosition>;
  getWalletsWithActiveBots(): Promise<string[]>;

  createOrphanedSubaccount(data: InsertOrphanedSubaccount): Promise<OrphanedSubaccount>;
  getOrphanedSubaccounts(): Promise<OrphanedSubaccount[]>;
  getOrphanedSubaccountsByWallet(walletAddress: string): Promise<OrphanedSubaccount[]>;
  deleteOrphanedSubaccount(id: string): Promise<void>;
  updateOrphanedSubaccountRetry(id: string): Promise<void>;

  // Marketplace: Published Bots
  getPublishedBots(options?: { search?: string; market?: string; sortBy?: string; limit?: number }): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null }; activeProtocol: string | null })[]>;
  getPublishedBotsByCreator(walletAddress: string): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null } })[]>;
  getPublishedBotById(id: string): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null } }) | undefined>;
  getPublishedBotByTradingBotId(tradingBotId: string): Promise<PublishedBot | undefined>;
  createPublishedBot(bot: InsertPublishedBot): Promise<PublishedBot>;
  updatePublishedBot(id: string, updates: Partial<InsertPublishedBot>): Promise<PublishedBot | undefined>;
  deletePublishedBot(id: string): Promise<void>;
  incrementPublishedBotSubscribers(id: string, delta: number, capitalDelta: number): Promise<void>;
  updatePublishedBotStats(id: string, stats: { 
    totalTrades: number; 
    winningTrades: number; 
    creatorCapital?: string;
    pnlPercent7d?: string; 
    pnlPercent30d?: string; 
    pnlPercent90d?: string; 
    pnlPercentAllTime?: string 
  }): Promise<void>;

  // Marketplace: Bot Subscriptions
  getBotSubscription(publishedBotId: string, subscriberWalletAddress: string): Promise<BotSubscription | undefined>;
  getBotSubscriptionsByPublishedBot(publishedBotId: string): Promise<BotSubscription[]>;
  getBotSubscriptionsByWallet(walletAddress: string): Promise<(BotSubscription & { publishedBot: PublishedBot })[]>;
  getBotSubscriptionBySubscriberBotId(botId: string): Promise<(BotSubscription & { publishedBot: PublishedBot }) | undefined>;
  getSubscriberBotsBySourceId(publishedBotId: string): Promise<TradingBot[]>;
  createBotSubscription(subscription: InsertBotSubscription): Promise<BotSubscription>;
  updateBotSubscription(id: string, updates: Partial<InsertBotSubscription>): Promise<BotSubscription | undefined>;
  reactivateBotSubscription(id: string, updates: { subscriberBotId: string; capitalInvested: string }): Promise<BotSubscription | undefined>;
  cancelBotSubscription(id: string): Promise<void>;
  // V3 Phase 3b: mark a subscription paused with a reason. Used when fan-out
  // discovers a subscriber whose execution authorization has been revoked or
  // emergency-stopped, so the UI can surface "Your subscription is paused
  // because execution authorization was revoked".
  markBotSubscriptionPausedBySubscriberBotId(subscriberBotId: string, reason: string): Promise<void>;

  // Marketplace: PnL Snapshots
  createPnlSnapshot(snapshot: InsertPnlSnapshot): Promise<PnlSnapshot>;
  getPnlSnapshots(tradingBotId: string, since?: Date): Promise<PnlSnapshot[]>;
  getLatestPnlSnapshot(tradingBotId: string): Promise<PnlSnapshot | undefined>;

  // Marketplace: Public Equity Snapshots
  createMarketplaceEquitySnapshot(snapshot: InsertMarketplaceEquitySnapshot): Promise<MarketplaceEquitySnapshot>;
  getMarketplaceEquitySnapshots(publishedBotId: string, since?: Date): Promise<MarketplaceEquitySnapshot[]>;

  // Security v3: Wallet security updates
  updateWalletSecurityV3(address: string, updates: {
    userSalt?: string;
    encryptedUserMasterKey?: string;
    encryptedMnemonicWords?: string;
    umkVersion?: number;
    executionEnabled?: boolean;
    umkEncryptedForExecution?: string;
    policyHmac?: string;
  }): Promise<Wallet | undefined>;

  /**
   * Atomic "first-writer-wins" UMK initialiser.
   * Writes userSalt + encryptedUserMasterKey + umkVersion=3 only when the row
   * currently has user_salt IS NULL. Returns true if this call wrote the row
   * (won the race), false if another call had already written (lost the race).
   * Callers that lose the race must discard their generated UMK and re-derive
   * the winner's UMK from the DB.
   */
  initWalletUmkIfAbsent(address: string, userSalt: string, encryptedUserMasterKey: string): Promise<boolean>;

  // V3 Phase 0: monitor UMK-at-rest re-keying progress.
  getUmkVersionDistribution(): Promise<Array<{ umkVersion: number; count: number }>>;
  // V3 Phase 0: startup health check - returns true if any wallet row has umk_version >= 3.
  hasAnyUmkV3OrAbove(): Promise<boolean>;

  // Security v3: Execution authorization
  updateWalletExecution(address: string, updates: {
    executionEnabled: boolean;
    umkEncryptedForExecution: string | null;
    executionExpiresAt: Date | null;
  }): Promise<Wallet | undefined>;
  resyncWalletExecutionUmk(address: string, umkEncryptedForExecution: string): Promise<boolean>;

  // Phase 4b: atomically revoke execution AND pause all owned active bots.
  // Returns the bots that were paused (id + name) so the caller can notify.
  atomicRevokeExecutionAndPauseBots(
    walletAddress: string,
    pauseReason: string,
  ): Promise<{ id: string; name: string }[]>;

  // Security v3: Emergency stop
  updateWalletEmergencyStop(address: string, updates: {
    executionEnabled: boolean;
    umkEncryptedForExecution: string | null;
    executionExpiresAt: Date | null;
    emergencyStopTriggered: boolean;
    emergencyStopAt: Date;
    emergencyStopBy: string;
  }): Promise<Wallet | undefined>;

  // Security v3: Auth nonces for signature verification
  createAuthNonce(nonce: InsertAuthNonce): Promise<AuthNonce>;
  getAuthNonceByHash(nonceHash: string): Promise<AuthNonce | undefined>;
  markNonceUsed(id: string): Promise<void>;
  cleanupExpiredNonces(): Promise<number>;

  // Telegram connection tokens
  createTelegramConnectionToken(token: InsertTelegramConnectionToken): Promise<TelegramConnectionToken>;
  getTelegramConnectionTokenByToken(token: string): Promise<TelegramConnectionToken | undefined>;
  deleteTelegramConnectionToken(id: string): Promise<void>;
  deleteExpiredTelegramTokens(): Promise<number>;
  getWalletByTelegramChatId(chatId: string): Promise<Wallet | undefined>;
  getWalletsByTelegramChatId(chatId: string): Promise<Wallet[]>;

  // Platform Analytics
  upsertPlatformMetric(metricType: PlatformMetricType, value: number, metadata?: Record<string, unknown>): Promise<PlatformMetric>;
  cleanupOldMetrics(retentionDays?: number): Promise<number>;
  getLatestPlatformMetric(metricType: PlatformMetricType): Promise<PlatformMetric | undefined>;
  getLatestPlatformMetrics(): Promise<PlatformMetric[]>;
  getPlatformMetricHistory(metricType: PlatformMetricType, since?: Date, limit?: number): Promise<PlatformMetric[]>;
  calculatePlatformTVL(): Promise<number>;
  calculatePlatformVolume(): Promise<{ total: number; volume24h: number; volume7d: number }>;
  calculatePlatformStats(): Promise<{ activeBots: number; activeUsers: number; totalTrades: number }>;
  getAllAgentWalletAddresses(): Promise<string[]>;

  getCumulativeStats(): Promise<PlatformCumulativeStats | undefined>;
  incrementCumulativeStats(volumeDelta: number, tradesDelta: number): Promise<void>;
  seedCumulativeStats(volume: number, trades: number): Promise<void>;
  snapshotBotStatsBeforeDeletion(botId: string): Promise<void>;

  // Profit Sharing: IOU records for failed profit share transfers
  createPendingProfitShare(data: InsertPendingProfitShare): Promise<PendingProfitShare>;
  getPendingProfitSharesBySubscriber(subscriberWalletAddress: string): Promise<PendingProfitShare[]>;
  getPendingProfitSharesByBot(subscriberBotId: string): Promise<PendingProfitShare[]>;
  getUnsettledProfitSharesByBot(subscriberBotId: string): Promise<PendingProfitShare[]>;
  getAllPendingProfitShares(): Promise<PendingProfitShare[]>;
  updatePendingProfitShareStatus(id: string, updates: { status?: string; retryCount?: number; lastError?: string | null; lastAttemptAt?: Date }): Promise<PendingProfitShare | undefined>;
  deletePendingProfitShare(id: string): Promise<void>;

  upsertPortfolioDailySnapshot(snapshot: InsertPortfolioDailySnapshot): Promise<PortfolioDailySnapshot>;
  getPortfolioDailySnapshots(walletAddress: string, since?: Date): Promise<PortfolioDailySnapshot[]>;
  getPortfolioDailySnapshotsBatch(walletAddresses: string[], since?: Date): Promise<Map<string, PortfolioDailySnapshot[]>>;
  getEarliestPortfolioSnapshotDates(walletAddresses: string[]): Promise<Map<string, Date>>;
  getLatestPortfolioDailySnapshot(walletAddress: string): Promise<PortfolioDailySnapshot | undefined>;
  getWalletCumulativeDepositsWithdrawals(walletAddress: string, asOf?: Date): Promise<{ deposits: number; withdrawals: number; internalTransfers: number }>;
  getWalletExternalFlows(walletAddress: string, asOf?: Date): Promise<Array<{ time: Date; amount: number }>>;
  getWalletTradeStats(walletAddress: string): Promise<{ totalTrades: number; totalVolume: number }>;
  getWalletCreatorEarnings(walletAddress: string): Promise<number>;
  getPublishedBotEarnings(publishedBotId: string): Promise<number>;
  getWalletsWithTradingBots(): Promise<string[]>;
  getWalletFirstDepositDate(walletAddress: string): Promise<Date | null>;

  // MLM Referral chain & rewards
  getReferralChain(descendantWallet: string): Promise<ReferralLink[]>;
  createReferralLinks(links: InsertReferralLink[]): Promise<void>;
  getReferralDescendantsByLevel(ancestorWallet: string, level: number): Promise<{ descendantWallet: string; createdAt: Date }[]>;
  insertReferralRewardEvent(event: InsertReferralRewardEvent): Promise<ReferralRewardEvent | null>;
  upsertReferralRewardEventPending(event: InsertReferralRewardEvent): Promise<ReferralRewardEvent>;
  updateReferralRewardEventStatus(id: string, patch: { status?: string; transferSignature?: string | null; lastError?: string | null; retryCount?: number; lastAttemptAt?: Date | null }): Promise<void>;
  claimReferralRewardEventForProcessing(id: string, expectedStatus: string[]): Promise<boolean>;
  getPendingReferralRewardEvents(): Promise<ReferralRewardEvent[]>;
  getProcessingReferralRewardEvents(): Promise<ReferralRewardEvent[]>;
  getReferralEarnings(earnerWallet: string): Promise<{ l1: number; l2: number; l3: number; total: number }>;
  getReferralEarningsForReferee(earnerWallet: string, refereeWallet: string): Promise<number>;
  getReferralEarningsByReferee(earnerWallet: string, refereeWallets: string[]): Promise<Map<string, number>>;

  // AI Trader (Agentic Trader plan §7 / WO-2) — schema + storage only.
  createAiTraderBot(bot: InsertAiTraderBot): Promise<AiTraderBot>;
  getAiTraderBot(id: string): Promise<AiTraderBot | undefined>;
  getAiTraderBotsByWallet(walletAddress: string): Promise<AiTraderBot[]>;
  getActiveAiTraderBots(): Promise<AiTraderBot[]>;
  // graduatedAt/trialStartedAt are omitted from InsertAiTraderBot (never
  // client-set at creation); graduatedAt is written by the monitor's
  // graduation path, trialStartedAt by WO-7's restart-trial route (the only
  // other legitimate server-side writer of either field).
  updateAiTraderBot(id: string, updates: Partial<InsertAiTraderBot> & { graduatedAt?: Date; trialStartedAt?: Date }): Promise<AiTraderBot | undefined>;
  insertAiTraderDecision(decision: InsertAiTraderDecision): Promise<AiTraderDecision>;
  updateAiTraderDecision(id: string, updates: Partial<InsertAiTraderDecision>): Promise<AiTraderDecision | undefined>;
  getAiTraderDecisions(botId: string, limit: number): Promise<AiTraderDecision[]>;
  getExecutedDecisions(botId: string, limit: number): Promise<AiTraderDecision[]>;
  getRecentClosedDecisions(botId: string, limit: number): Promise<AiTraderDecision[]>;
  compressOldAiTraderDecisions(olderThanDays: number, batchSize: number): Promise<number>;
  /**
   * Paginated history fetch with server-side outcome filtering.
   * outcomes: 'all' (default) | 'executed' (trades only) | 'non_flat' (exclude flat stand-asides).
   * Keyset cursor: pass before + beforeId from the previous page's nextCursor to get older rows.
   * Returns rows (length ≤ limit) + nextCursor (null when no more rows exist).
   * Executed rows are NEVER stripped by compressOldAiTraderDecisions — full jsonb preserved.
   */
  getAiTraderDecisionsPaged(
    botId: string,
    limit: number,
    opts?: { outcomes?: 'all' | 'executed' | 'non_flat'; before?: Date; beforeId?: string },
  ): Promise<{ rows: AiTraderDecision[]; nextCursor: { before: string; beforeId: string } | null }>;
  // WO-7 additions.
  getAiTraderDecision(id: string): Promise<AiTraderDecision | undefined>;
  deleteAiTraderBot(id: string): Promise<void>;
  /** Batch-fetch open (outcome='executed', closedAt IS NULL) decisions for multiple bots at once. Used by the PnL list endpoint to avoid N+1 price fetches. Returns at most one row per bot. */
  getAiTraderOpenDecisionsByBotIds(botIds: string[]): Promise<AiTraderDecision[]>;
  /** Per-bot sum of lifetime realized PnL from all closed executed decisions. Missing keys ⇒ 0. */
  getAiTraderTotalRealizedPnlMap(botIds: string[]): Promise<Map<string, number>>;
  getAiTraderBotLifetimeStats(botIds: string[]): Promise<Map<string, { totalRealized: number; totalFees: number; totalLlmCost: number }>>;
  /**
   * Atomically claims one free platform-key paper trial for a wallet with no
   * BYO OpenRouter key. Returns the post-increment count when the wallet was
   * under `limit` (caller may proceed), or null when the cap was already hit
   * (conditional `UPDATE ... WHERE ai_trader_free_calls_used < limit`, so
   * concurrent requests can never push the counter past `limit`).
   */
  incrementAiTraderFreeCalls(walletAddress: string, limit: number): Promise<number | null>;
  /** Refunds one free trial when a claimed call never actually reached the LLM (e.g. stale-context abort). Floors at 0. */
  decrementAiTraderFreeCalls(walletAddress: string): Promise<void>;

  /**
   * WO-15A: Batch financial-enrichment for a list of trading bots.
   *
   * Executes exactly FIVE set-based DB queries for any non-empty botIds list —
   * one per dataset — regardless of how many bots are requested. Empty input
   * returns empty maps with zero queries. All queries are scoped to both
   * walletAddress and botIds; no cross-wallet rows can enter any result map.
   *
   * Reproduces the per-bot semantics of:
   *   - getCanonicalBotTradeCount (incl. phantom-dup-close exclusion)
   *   - sumNetDepositedFromEvents + totalDeposits (VAULT_INTERNAL_EVENT_TYPES excluded)
   *   - sumOpenBorrowDebtUsdcForBot (BigInt arithmetic, USDC-only, open status)
   *   - getPublishedBotByTradingBotId (unique-by-schema, no tie-breaking needed)
   *   - getBotPosition (all markets returned; caller picks bot.market)
   *
   * Do NOT wire into routes until WO-15B/15C.
   */
  getTradingBotListEnrichment(walletAddress: string, botIds: string[]): Promise<BotListEnrichment>;
}

// Raw SQL predicate that is TRUE for a "phantom duplicate" close row: a
// redundant close booked by a SECOND writer (reconciler or a re-fired webhook)
// under a different protocol_fill_id id-space (nosig-/reconcile-close-/NULL vs
// tx-<sig>), which dodges the protocol_fill_id unique index. The phantom row is
// weak — no tx_signature AND zero fee, i.e. nothing actually filled on-chain —
// AND it mirrors a STRONGER real close (one carrying a tx_signature or a real
// fee) of the same size within 120s. Such rows must NOT inflate the canonical
// trade count / performance series. The asymmetric "stronger sibling" test
// guarantees we never drop BOTH rows of a pair, and lone reconciler-detected
// closes (no sibling) are kept. See memory: double-close-webhook-reconciler-race.
// References the unaliased `bot_trades` table, so it only embeds in queries
// whose primary FROM is bot_trades with no alias.
const PHANTOM_DUP_CLOSE_PREDICATE = `
  bot_trades.tx_signature IS NULL
  AND COALESCE(bot_trades.fee, 0) = 0
  AND EXISTS (
    SELECT 1 FROM bot_trades s
    WHERE s.trading_bot_id = bot_trades.trading_bot_id
      AND s.market = bot_trades.market
      AND s.id <> bot_trades.id
      AND s.pnl IS NOT NULL
      AND s.status IN ('executed','liquidated','recovered')
      AND ABS(EXTRACT(EPOCH FROM (s.executed_at - bot_trades.executed_at))) <= 120
      AND ABS(ABS(s.size) - ABS(bot_trades.size)) <= 0.01 * ABS(bot_trades.size)
      AND (s.tx_signature IS NOT NULL OR COALESCE(s.fee, 0) > 0)
  )`;

// Drizzle SQL chunk: TRUE when a bot_trades row is NOT a phantom duplicate.
// Returns a fresh chunk per call so it can be embedded in multiple queries.
function notPhantomDupClose() {
  return sql.raw(`NOT (${PHANTOM_DUP_CLOSE_PREDICATE})`);
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  async getWallet(address: string): Promise<Wallet | undefined> {
    const result = await db.select().from(wallets).where(eq(wallets.address, address)).limit(1);
    return result[0];
  }

  async getWalletByAgentPublicKey(agentPublicKey: string): Promise<Wallet | undefined> {
    const result = await db.select().from(wallets).where(eq(wallets.agentPublicKey, agentPublicKey)).limit(1);
    return result[0];
  }

  async getWalletByWebhookSecret(secret: string): Promise<Wallet | undefined> {
    const result = await db.select().from(wallets).where(eq(wallets.userWebhookSecret, secret)).limit(1);
    return result[0];
  }

  async getWalletByReferralCode(referralCode: string): Promise<Wallet | undefined> {
    const result = await db.select().from(wallets).where(eq(wallets.referralCode, referralCode)).limit(1);
    return result[0];
  }

  async createWallet(wallet: InsertWallet): Promise<Wallet> {
    const result = await db.insert(wallets).values(wallet).returning();
    return result[0];
  }

  async updateWalletLastSeen(address: string): Promise<void> {
    await db.update(wallets).set({ lastSeen: sql`NOW()` }).where(eq(wallets.address, address));
  }

  async getOrCreateWallet(address: string): Promise<Wallet> {
    const existing = await this.getWallet(address);
    if (existing) {
      await this.updateWalletLastSeen(address);
      return existing;
    }
    return this.createWallet({ address });
  }

  async updateWalletAgentKeys(address: string, agentPublicKey: string, agentPrivateKeyEncrypted: string): Promise<void> {
    await db.update(wallets).set({ 
      agentPublicKey, 
      agentPrivateKeyEncrypted 
    }).where(eq(wallets.address, address));
  }

  async updateWalletAgentKeyV3(address: string, agentPrivateKeyEncryptedV3: string): Promise<void> {
    await db.update(wallets).set({ 
      agentPrivateKeyEncryptedV3 
    }).where(eq(wallets.address, address));
  }

  // --- QuantumLab AI Strategy Creator (Task 187): BYO LLM key (V3-encrypted) ---
  // The ciphertext column is never selected into any client-facing payload; only
  // the meta reader (last4/provider/updatedAt) is. getWalletLlmApiKeyCiphertext is
  // server-internal — its result is decrypted transiently and discarded.
  async setWalletLlmApiKey(address: string, encryptedV3: string, last4: string, provider: string): Promise<void> {
    await db.update(wallets).set({
      llmApiKeyEncrypted: encryptedV3,
      llmApiKeyLast4: last4,
      llmApiKeyProvider: provider,
      llmApiKeyUpdatedAt: new Date(),
    }).where(eq(wallets.address, address));
  }

  async clearWalletLlmApiKey(address: string): Promise<void> {
    await db.update(wallets).set({
      llmApiKeyEncrypted: null,
      llmApiKeyLast4: null,
      llmApiKeyProvider: null,
      llmApiKeyUpdatedAt: null,
    }).where(eq(wallets.address, address));
  }

  async getWalletLlmApiKeyMeta(address: string): Promise<{ hasKey: boolean; last4: string | null; provider: string | null; updatedAt: Date | null }> {
    const [row] = await db.select({
      enc: wallets.llmApiKeyEncrypted,
      last4: wallets.llmApiKeyLast4,
      provider: wallets.llmApiKeyProvider,
      updatedAt: wallets.llmApiKeyUpdatedAt,
    }).from(wallets).where(eq(wallets.address, address)).limit(1);
    return {
      hasKey: !!row?.enc,
      last4: row?.last4 ?? null,
      provider: row?.provider ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async getWalletLlmApiKeyCiphertext(address: string): Promise<string | null> {
    const [row] = await db.select({ enc: wallets.llmApiKeyEncrypted })
      .from(wallets).where(eq(wallets.address, address)).limit(1);
    return row?.enc ?? null;
  }

  async updateWalletWebhookSecret(address: string, userWebhookSecret: string): Promise<void> {
    await db.update(wallets).set({ userWebhookSecret }).where(eq(wallets.address, address));
  }

  async updateWallet(address: string, updates: Partial<InsertWallet>): Promise<Wallet | undefined> {
    const result = await db.update(wallets).set(updates).where(eq(wallets.address, address)).returning();
    return result[0];
  }

  // Atomically union `indices` into wallets.recovered_orphan_indices. Computed
  // server-side from the live column value (not a stale snapshot) so concurrent
  // orphan-recovery runs can never lose each other's writes. Deduped + sorted.
  async addRecoveredOrphanIndices(address: string, indices: number[]): Promise<void> {
    if (indices.length === 0) return;
    await db
      .update(wallets)
      .set({
        recoveredOrphanIndices: sql`(
          SELECT COALESCE(array_agg(DISTINCT e ORDER BY e), '{}')
          FROM unnest(${wallets.recoveredOrphanIndices} || ${sql.raw(`ARRAY[${indices.map((n) => Number(n)).join(",")}]::int[]`)}) AS e
        )`,
      })
      .where(eq(wallets.address, address));
  }

  async markPacificaBuilderApproved(agentPublicKey: string): Promise<void> {
    await db.update(wallets).set({ pacificaBuilderApproved: true }).where(eq(wallets.agentPublicKey, agentPublicKey));
  }

  async markPacificaReferralClaimed(agentPublicKey: string): Promise<void> {
    await db.update(wallets).set({ pacificaReferralClaimed: true }).where(eq(wallets.agentPublicKey, agentPublicKey));
  }

  // --- Task 201: hands-off auto-mode admin whitelist ---------------------------
  // Read is the live authorization the orchestrator re-checks (fail-closed) before
  // every auto-approval, so admin removal immediately drops a run back to watched.
  async isHandsOffApproved(address: string): Promise<boolean> {
    const result = await db
      .select({ handsOffApproved: wallets.handsOffApproved })
      .from(wallets)
      .where(eq(wallets.address, address))
      .limit(1);
    return result[0]?.handsOffApproved === true;
  }

  // ADD upserts a row (a whitelist is an admin intent list — the wallet may not
  // have connected yet); REMOVE only flips an existing row (a no-op if absent).
  async setHandsOffApproved(address: string, approved: boolean): Promise<void> {
    if (approved) {
      await db
        .insert(wallets)
        .values({ address, handsOffApproved: true })
        .onConflictDoUpdate({ target: wallets.address, set: { handsOffApproved: true } });
    } else {
      await db.update(wallets).set({ handsOffApproved: false }).where(eq(wallets.address, address));
    }
  }

  async listHandsOffApproved(): Promise<{ address: string; displayName: string | null }[]> {
    return db
      .select({ address: wallets.address, displayName: wallets.displayName })
      .from(wallets)
      .where(eq(wallets.handsOffApproved, true))
      .orderBy(desc(wallets.lastSeen));
  }

  // Task 149: per-bot Pacifica enrollment helpers. The bot's Pacifica main
  // account public key lives in trading_bots.protocol_subaccount_id (Phase 4b
  // — each bot has its own keypair under bot_subaccount_key_encrypted_v3).
  async getBotByAgentPublicKey(agentPublicKey: string): Promise<TradingBot | undefined> {
    const result = await db.select().from(tradingBots).where(eq(tradingBots.protocolSubaccountId, agentPublicKey)).limit(1);
    return result[0];
  }

  async markBotPacificaBuilderApproved(agentPublicKey: string): Promise<void> {
    await db.update(tradingBots).set({ pacificaBuilderApproved: true }).where(eq(tradingBots.protocolSubaccountId, agentPublicKey));
  }

  async markBotPacificaReferralClaimed(agentPublicKey: string): Promise<void> {
    await db.update(tradingBots).set({ pacificaReferralClaimed: true }).where(eq(tradingBots.protocolSubaccountId, agentPublicKey));
  }

  async getAllBots(): Promise<Bot[]> {
    return db.select().from(bots).orderBy(desc(bots.subscribers));
  }

  async getFeaturedBots(): Promise<Bot[]> {
    return db.select().from(bots).where(eq(bots.featured, true)).limit(6);
  }

  async getBotById(id: string): Promise<Bot | undefined> {
    const result = await db.select().from(bots).where(eq(bots.id, id)).limit(1);
    return result[0];
  }

  async createBot(bot: InsertBot): Promise<Bot> {
    const result = await db.insert(bots).values(bot).returning();
    return result[0];
  }

  async incrementBotSubscribers(botId: string, delta: number): Promise<void> {
    await db
      .update(bots)
      .set({ subscribers: sql`${bots.subscribers} + ${delta}` })
      .where(eq(bots.id, botId));
  }

  async getTradingBots(walletAddress: string): Promise<TradingBot[]> {
    return db.select().from(tradingBots).where(eq(tradingBots.walletAddress, walletAddress)).orderBy(desc(tradingBots.createdAt));
  }

  async getTradingBotById(id: string): Promise<TradingBot | undefined> {
    const result = await db.select().from(tradingBots).where(eq(tradingBots.id, id)).limit(1);
    return result[0];
  }

  async getTradingBotBySecret(webhookSecret: string): Promise<TradingBot | undefined> {
    const result = await db.select().from(tradingBots).where(eq(tradingBots.webhookSecret, webhookSecret)).limit(1);
    return result[0];
  }

  async getNextSubaccountId(walletAddress: string): Promise<number> {
    const bots = await db.select({ driftSubaccountId: tradingBots.driftSubaccountId })
      .from(tradingBots)
      .where(eq(tradingBots.walletAddress, walletAddress));
    
    const usedIds = new Set(
      bots
        .map(b => b.driftSubaccountId)
        .filter((id): id is number => id !== null)
    );
    
    // Drift requires sequential subaccounts starting from 1 (0 is main account)
    // Find the first available ID in sequence
    let nextId = 1;
    while (usedIds.has(nextId)) {
      nextId++;
    }
    
    return nextId;
  }
  
  async getAllocatedSubaccountIds(walletAddress: string): Promise<number[]> {
    const bots = await db.select({ driftSubaccountId: tradingBots.driftSubaccountId })
      .from(tradingBots)
      .where(eq(tradingBots.walletAddress, walletAddress));
    
    return bots
      .map(b => b.driftSubaccountId)
      .filter((id): id is number => id !== null);
  }

  async getAllocatedProtocolSubaccountIds(walletAddress: string, protocol?: string): Promise<string[]> {
    let query = db.select({
      protocolSubaccountId: tradingBots.protocolSubaccountId,
      activeProtocol: tradingBots.activeProtocol,
    })
      .from(tradingBots)
      .where(eq(tradingBots.walletAddress, walletAddress));

    const bots = await query;

    return bots
      .filter(b => b.protocolSubaccountId !== null && (!protocol || b.activeProtocol === protocol))
      .map(b => b.protocolSubaccountId as string);
  }

  async assignProtocolSubaccountId(botId: string, protocolSubaccountId: string, protocol: string): Promise<void> {
    await db.update(tradingBots)
      .set({
        protocolSubaccountId,
        activeProtocol: protocol,
        updatedAt: sql`NOW()`,
      } as any)
      .where(eq(tradingBots.id, botId));
  }

  async clearProtocolSubaccount(botId: string): Promise<void> {
    // Group D item 18 (April 17, 2026): activeProtocol is now NOT NULL with a CHECK
    // constraint (see shared/schema.ts and server/db.ts). The protocol tag is a
    // permanent property of the bot — it records which adapter created the bot,
    // not transient state that should be cleared alongside the subaccount ID.
    // This method clears only the on-chain subaccount identifier; the protocol
    // tag remains so any future re-creation routes through the same adapter.
    await db.update(tradingBots)
      .set({
        protocolSubaccountId: null,
        updatedAt: sql`NOW()`,
      } as any)
      .where(eq(tradingBots.id, botId));
  }

  async findBotByProtocolSubaccount(walletAddress: string, protocolSubaccountId: string, protocol?: string): Promise<TradingBot | undefined> {
    const conditions = [
      eq(tradingBots.walletAddress, walletAddress),
      eq(tradingBots.protocolSubaccountId, protocolSubaccountId),
    ];
    if (protocol) {
      // Cast: the column's narrowed union type ('pacifica'|'drift') is enforced by
      // the SQL CHECK constraint on writes. For this SELECT predicate, an out-of-
      // domain value won't be rejected — it just yields no matches. Callers that
      // want input validation should narrow the parameter upstream (e.g. with a
      // Zod enum) rather than relying on the cast for safety.
      conditions.push(eq(tradingBots.activeProtocol, protocol as 'pacifica' | 'drift' | 'flash'));
    }
    const result = await db.select()
      .from(tradingBots)
      .where(and(...conditions))
      .limit(1);
    return result[0];
  }

  async poolSubaccountAsSpare(params: {
    walletAddress: string;
    protocol: string;
    protocolSubaccountId: string;
    agentPublicKey: string | null;
    subaccountKeyEncryptedV3: string;
    aadVersion: number;
    // HD-derivation metadata of the bot being deleted. Retained on the spare so a
    // future reuse can re-stamp the SAME index on the new bot (seed re-derives the
    // same pubkey). NULL/NULL for legacy random-key bots (blob-only, as before).
    derivationIndex?: number | null;
    derivationPathVersion?: number | null;
  }): Promise<void> {
    await db.insert(protocolSubaccounts)
      .values({
        walletAddress: params.walletAddress,
        botId: null,
        protocol: params.protocol,
        protocolSubaccountId: params.protocolSubaccountId,
        status: 'spare',
        agentPublicKey: params.agentPublicKey,
        subaccountKeyEncryptedV3: params.subaccountKeyEncryptedV3,
        aadVersion: params.aadVersion,
        derivationIndex: params.derivationIndex ?? null,
        derivationPathVersion: params.derivationPathVersion ?? null,
        releasedAt: sql`NOW()`,
        lastVerifiedEmptyAt: sql`NOW()`,
        lastError: null,
      } as any)
      .onConflictDoUpdate({
        target: [protocolSubaccounts.protocol, protocolSubaccounts.protocolSubaccountId],
        set: {
          walletAddress: params.walletAddress,
          // Detach from the (about-to-be-deleted) bot so the spare is unowned.
          botId: null,
          status: 'spare',
          agentPublicKey: params.agentPublicKey,
          subaccountKeyEncryptedV3: params.subaccountKeyEncryptedV3,
          aadVersion: params.aadVersion,
          derivationIndex: params.derivationIndex ?? null,
          derivationPathVersion: params.derivationPathVersion ?? null,
          releasedAt: sql`NOW()`,
          lastVerifiedEmptyAt: sql`NOW()`,
          lastError: null,
        } as any,
      });
  }

  async markSubaccountStuckFunds(params: {
    walletAddress: string;
    protocol: string;
    protocolSubaccountId: string;
    botId: string | null;
    agentPublicKey: string | null;
    lastError: string;
    claimToken?: string;
    // Optional structured HD-recovery metadata. When supplied (always BOTH or
    // NEITHER), the seed re-derives this subaccount's signing key as
    // deriveBotKeypairFromAgentSeed(seed, derivationIndex) — typed columns make
    // recovery deterministic instead of parsing it out of lastError. OMIT on the
    // reuse/CAS path: the pooled row already carries the spare's ORIGINAL index and
    // we must not overwrite it.
    derivationIndex?: number | null;
    derivationPathVersion?: number | null;
  }): Promise<boolean> {
    // Fund-safety: by the time this is called the caller has decided funds are genuinely
    // stranded (sweep failed / stranding on delete). Surface it in the admin panel even if
    // the CAS below later no-ops (another owner already quarantined the same slot).
    void import("./error-log").then((m) => m.recordCriticalError({
      category: "fund_safety",
      severity: "critical",
      source: "stuck-funds-quarantine",
      message: `Subaccount quarantined as stuck_funds: ${params.lastError || "sweep failed / funds stranded"}`,
      context: { protocol: params.protocol, subaccountId: params.protocolSubaccountId, botId: params.botId },
    })).catch(() => {});
    // Only overwrite derivation columns when the caller explicitly supplies them, so
    // an omitting caller (e.g. reuse CAS) leaves any existing original index intact.
    const derivationSet: Record<string, any> = {};
    if (params.derivationIndex !== undefined) derivationSet.derivationIndex = params.derivationIndex;
    if (params.derivationPathVersion !== undefined) derivationSet.derivationPathVersion = params.derivationPathVersion;
    // §5.1.4 CAS-guarded quarantine. When a claimToken is supplied the caller is a
    // lease holder (reuse-on-create / lease-recovery). A TTL-based recovery assumes
    // a slow holder is dead and can reclaim+re-finalize the slot to another owner;
    // if the original (now stale) holder later quarantines, an UNCONDITIONAL write
    // would clobber that new owner's active row and detach its bot. So guard on
    // (status='reserving' AND claim_token) and no-op when we've lost the lease.
    if (params.claimToken !== undefined) {
      const result = await db.update(protocolSubaccounts)
        .set({
          status: 'stuck_funds',
          botId: params.botId,
          agentPublicKey: params.agentPublicKey,
          lastError: params.lastError,
          claimToken: null,
          claimedAt: null,
          ...derivationSet,
        } as any)
        .where(and(
          eq(protocolSubaccounts.protocol, params.protocol),
          eq(protocolSubaccounts.protocolSubaccountId, params.protocolSubaccountId),
          eq(protocolSubaccounts.status, 'reserving'),
          eq(protocolSubaccounts.claimToken, params.claimToken),
        ))
        .returning({ id: protocolSubaccounts.id });
      if (result.length === 0) {
        console.warn(`[Storage] markSubaccountStuckFunds CAS lost for ${params.protocol}/${params.protocolSubaccountId} (lease reclaimed/finalized by another owner) — not clobbering current row`);
        return false;
      }
      return true;
    }
    // Unconditional path: the caller owns the row outright (delete/fresh-provision),
    // with no competing lease holder.
    await db.insert(protocolSubaccounts)
      .values({
        walletAddress: params.walletAddress,
        botId: params.botId,
        protocol: params.protocol,
        protocolSubaccountId: params.protocolSubaccountId,
        status: 'stuck_funds',
        agentPublicKey: params.agentPublicKey,
        lastError: params.lastError,
        ...derivationSet,
      } as any)
      .onConflictDoUpdate({
        target: [protocolSubaccounts.protocol, protocolSubaccounts.protocolSubaccountId],
        set: {
          walletAddress: params.walletAddress,
          botId: params.botId,
          status: 'stuck_funds',
          agentPublicKey: params.agentPublicKey,
          lastError: params.lastError,
          ...derivationSet,
        } as any,
      });
    return true;
  }

  async claimSpareSubaccount(params: {
    walletAddress: string;
    protocol: string;
    agentPublicKey: string;
    claimToken: string;
  }): Promise<ClaimedSpare | undefined> {
    // Single atomic statement: lock the oldest eligible spare with SKIP LOCKED so
    // concurrent creates fan out across distinct rows (never the same one), then
    // flip it to 'reserving' under our claim token. Only rows that still have a
    // retained key + on-chain id are eligible — a keyless spare can't be re-signed.
    // HD-recoverability race guard: a reused HD spare re-stamps its ORIGINAL
    // derivation index onto the new bot. Pooling (poolSubaccountAsSpare) runs BEFORE
    // the old bot row is deleted, so for a brief window the old bot still holds that
    // index. If we claimed the spare in that window the new INSERT would collide on
    // the trading_bots (wallet_address, derivation_index) UNIQUE. So skip any HD spare
    // whose index is still held by a live trading_bots row; once the delete lands it
    // becomes claimable. Legacy random spares (derivation_index IS NULL) are unaffected.
    const result = await db.execute(sql`
      UPDATE protocol_subaccounts
      SET status = 'reserving', claim_token = ${params.claimToken}, claimed_at = NOW()
      WHERE id = (
        SELECT ps.id FROM protocol_subaccounts ps
        WHERE ps.wallet_address = ${params.walletAddress}
          AND ps.protocol = ${params.protocol}
          AND ps.agent_public_key = ${params.agentPublicKey}
          AND ps.status = 'spare'
          AND ps.protocol_subaccount_id IS NOT NULL
          AND ps.subaccount_key_encrypted_v3 IS NOT NULL
          AND (
            ps.derivation_index IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM trading_bots tb
              WHERE tb.wallet_address = ps.wallet_address
                AND tb.derivation_index = ps.derivation_index
            )
          )
        ORDER BY ps.released_at ASC NULLS FIRST
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, wallet_address, protocol, protocol_subaccount_id, agent_public_key,
                subaccount_key_encrypted_v3, aad_version, bot_id, claim_token, status,
                derivation_index, derivation_path_version
    `);
    const row: any = (result as any).rows?.[0] ?? (result as any)[0];
    if (!row) return undefined;
    return {
      id: Number(row.id),
      walletAddress: row.wallet_address,
      protocol: row.protocol,
      protocolSubaccountId: row.protocol_subaccount_id,
      agentPublicKey: row.agent_public_key,
      subaccountKeyEncryptedV3: row.subaccount_key_encrypted_v3,
      aadVersion: row.aad_version == null ? null : Number(row.aad_version),
      botId: row.bot_id,
      claimToken: row.claim_token,
      status: row.status,
      derivationIndex: row.derivation_index == null ? null : Number(row.derivation_index),
      derivationPathVersion: row.derivation_path_version == null ? null : Number(row.derivation_path_version),
    };
  }

  async finalizeReusedSubaccount(params: {
    protocol: string;
    protocolSubaccountId: string;
    claimToken: string;
    botId: string;
  }): Promise<boolean> {
    const result = await db.update(protocolSubaccounts)
      .set({
        status: 'active',
        botId: params.botId,
        claimToken: null,
        claimedAt: null,
        confirmedAt: sql`NOW()`,
        lastError: null,
      } as any)
      .where(and(
        eq(protocolSubaccounts.protocol, params.protocol),
        eq(protocolSubaccounts.protocolSubaccountId, params.protocolSubaccountId),
        eq(protocolSubaccounts.status, 'reserving'),
        eq(protocolSubaccounts.claimToken, params.claimToken),
      ))
      .returning({ id: protocolSubaccounts.id });
    return result.length > 0;
  }

  async releaseReservationToSpare(params: {
    protocol: string;
    protocolSubaccountId: string;
    claimToken?: string;
  }): Promise<boolean> {
    const conditions = [
      eq(protocolSubaccounts.protocol, params.protocol),
      eq(protocolSubaccounts.protocolSubaccountId, params.protocolSubaccountId),
      eq(protocolSubaccounts.status, 'reserving'),
    ];
    if (params.claimToken) conditions.push(eq(protocolSubaccounts.claimToken, params.claimToken));
    const result = await db.update(protocolSubaccounts)
      .set({
        status: 'spare',
        botId: null,
        claimToken: null,
        claimedAt: null,
        releasedAt: sql`NOW()`,
        lastVerifiedEmptyAt: sql`NOW()`,
        lastError: null,
      } as any)
      .where(and(...conditions))
      .returning({ id: protocolSubaccounts.id });
    return result.length > 0;
  }

  async findExpiredReservations(ttlMs: number): Promise<ProtocolSubaccount[]> {
    const cutoffEpochSec = Math.floor((Date.now() - ttlMs) / 1000);
    return await db.select()
      .from(protocolSubaccounts)
      .where(and(
        eq(protocolSubaccounts.status, 'reserving'),
        sql`${protocolSubaccounts.claimedAt} IS NOT NULL`,
        sql`${protocolSubaccounts.claimedAt} < to_timestamp(${cutoffEpochSec})`,
      ));
  }

  async markSubaccountVerifiedEmpty(protocol: string, protocolSubaccountId: string): Promise<void> {
    await db.update(protocolSubaccounts)
      .set({ lastVerifiedEmptyAt: sql`NOW()` } as any)
      .where(and(
        eq(protocolSubaccounts.protocol, protocol),
        eq(protocolSubaccounts.protocolSubaccountId, protocolSubaccountId),
      ));
  }

  async createTradingBot(bot: InsertTradingBot): Promise<TradingBot> {
    const result = await db.insert(tradingBots).values(bot as any).returning();
    return result[0];
  }

  // Phase 4b (Flash agent-HD wallets): single-statement atomic allocator. The
  // UPDATE takes a row lock, so concurrent creates for the same wallet serialize
  // and each gets a unique, monotonic index. RETURNING (post-increment value - 1)
  // yields the allocated index (first allocation = 1, since the column defaults to 1).
  async allocateBotDerivationIndex(walletAddress: string): Promise<number> {
    const result: any = await db.execute(sql`
      UPDATE wallets
         SET next_bot_derivation_index = next_bot_derivation_index + 1
       WHERE address = ${walletAddress}
       RETURNING (next_bot_derivation_index - 1) AS allocated
    `);
    const allocated = result?.rows?.[0]?.allocated;
    if (allocated == null) {
      throw new Error(`allocateBotDerivationIndex: wallet ${walletAddress} not found`);
    }
    return Number(allocated);
  }

  async updateTradingBot(id: string, updates: Partial<InsertTradingBot>): Promise<TradingBot | undefined> {
    const result = await db.update(tradingBots).set({ ...updates, updatedAt: sql`NOW()` } as any).where(eq(tradingBots.id, id)).returning();
    return result[0];
  }

  async scheduleBotAutoParkDueAt(id: string, dueAt: Date): Promise<void> {
    // Arm (or re-arm to the later deadline under the double-close race) the
    // repark debounce. Does NOT bump updatedAt — this is internal scheduling
    // state, not a user-visible bot edit.
    await db.update(tradingBots)
      .set({ autoParkDueAt: dueAt })
      .where(eq(tradingBots.id, id));
  }

  async clearBotAutoParkDueAt(id: string): Promise<void> {
    // Cancel a pending repark (a new position opened). Guarded so a normal open
    // on a bot with nothing pending is a no-op write.
    await db.update(tradingBots)
      .set({ autoParkDueAt: null })
      .where(and(eq(tradingBots.id, id), isNotNull(tradingBots.autoParkDueAt)));
  }

  async claimDueAutoReparkBots(): Promise<TradingBot[]> {
    // Atomically claim every bot whose debounce has elapsed: null the deadline
    // and return the rows in ONE statement so a bot is handed to the scanner
    // exactly once even if two ticks overlap.
    const result = await db.update(tradingBots)
      .set({ autoParkDueAt: null })
      .where(and(
        isNotNull(tradingBots.autoParkDueAt),
        lte(tradingBots.autoParkDueAt, sql`NOW()`),
      ))
      .returning();
    return result;
  }

  async updateBotSubaccountKeyV3(id: string, encryptedV3: string): Promise<void> {
    await db
      .update(tradingBots)
      .set({ botSubaccountKeyEncryptedV3: encryptedV3, updatedAt: sql`NOW()` })
      .where(eq(tradingBots.id, id));
  }

  async clearTradingBotSubaccount(id: string): Promise<void> {
    await db.update(tradingBots).set({ driftSubaccountId: null, updatedAt: sql`NOW()` }).where(eq(tradingBots.id, id));
  }

  async deleteTradingBot(id: string): Promise<void> {
    await this.snapshotBotStatsBeforeDeletion(id);
    await db.delete(tradingBots).where(eq(tradingBots.id, id));
  }

  async updateTradingBotStats(id: string, stats: TradingBot['stats']): Promise<void> {
    // JSON-merge: preserve fields not present in the partial update so concurrent
    // writes (e.g. recomputed counters vs. PnL/volume deltas) don't blow each
    // other away. See task #67.
    await db.transaction(async (tx) => {
      const rows = await tx.select({ stats: tradingBots.stats }).from(tradingBots).where(eq(tradingBots.id, id)).limit(1);
      const existing = (rows[0]?.stats as any) ?? {};
      const merged = { ...existing, ...((stats as any) ?? {}) };
      await tx.update(tradingBots).set({ stats: merged, updatedAt: sql`NOW()` }).where(eq(tradingBots.id, id));
    });
  }

  /**
   * Canonical "trade" definition: one closed-position lifecycle event with a
   * realized PnL recorded (breakeven uses '0', never NULL). Opens never count.
   * SQL-derived single source of truth for stats counters.
   */
  async getCanonicalBotTradeStats(tradingBotId: string): Promise<{ totalTrades: number; winningTrades: number; losingTrades: number }> {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS "totalTrades",
        SUM(CASE WHEN ${botTrades.pnl}::numeric > 0 THEN 1 ELSE 0 END)::int AS "winningTrades",
        SUM(CASE WHEN ${botTrades.pnl}::numeric < 0 THEN 1 ELSE 0 END)::int AS "losingTrades"
      FROM ${botTrades}
      WHERE ${botTrades.tradingBotId} = ${tradingBotId}
        AND ${botTrades.pnl} IS NOT NULL
        AND ${botTrades.status} IN ('executed','liquidated','recovered')
        AND ${notPhantomDupClose()}
    `);
    const row: any = (result as any).rows?.[0] ?? (result as any)[0] ?? {};
    return {
      totalTrades: Number(row.totalTrades ?? 0),
      winningTrades: Number(row.winningTrades ?? 0),
      losingTrades: Number(row.losingTrades ?? 0),
    };
  }

  async getCanonicalBotTradeCount(tradingBotId: string): Promise<number> {
    return (await this.getCanonicalBotTradeStats(tradingBotId)).totalTrades;
  }

  /**
   * Recompute totalTrades / winningTrades / losingTrades from `bot_trades`
   * and JSON-merge them into `trading_bots.stats`, preserving non-counter
   * fields (`totalPnl`, `totalVolume`, `lastTradeAt`, etc.). Optional deltas
   * are added on top — pass when a close fires so PnL/volume accumulate.
   * DB-only transaction: no RPC.
   */
  async recomputeAndMergeBotStats(
    tradingBotId: string,
    deltas?: { totalPnlDelta?: number; totalVolumeDelta?: number; lastTradeAt?: string },
    txArg?: any,
  ): Promise<void> {
    const run = async (tx: any) => {
      const countsRows = await tx
        .select({
          totalTrades: sql<number>`COUNT(*)::int`,
          winningTrades: sql<number>`SUM(CASE WHEN ${botTrades.pnl}::numeric > 0 THEN 1 ELSE 0 END)::int`,
          losingTrades: sql<number>`SUM(CASE WHEN ${botTrades.pnl}::numeric < 0 THEN 1 ELSE 0 END)::int`,
        })
        .from(botTrades)
        .where(and(
          eq(botTrades.tradingBotId, tradingBotId),
          sql`${botTrades.pnl} IS NOT NULL`,
          sql`${botTrades.status} IN ('executed','liquidated','recovered')`,
          notPhantomDupClose(),
        ));
      const counts = {
        totalTrades: Number(countsRows[0]?.totalTrades ?? 0),
        winningTrades: Number(countsRows[0]?.winningTrades ?? 0),
        losingTrades: Number(countsRows[0]?.losingTrades ?? 0),
      };
      const rows = await tx.select({ stats: tradingBots.stats }).from(tradingBots).where(eq(tradingBots.id, tradingBotId)).limit(1);
      const existing: any = rows[0]?.stats ?? {};
      const merged: any = {
        ...existing,
        totalTrades: counts.totalTrades,
        winningTrades: counts.winningTrades,
        losingTrades: counts.losingTrades,
      };
      if (deltas?.totalPnlDelta !== undefined && Number.isFinite(deltas.totalPnlDelta)) {
        merged.totalPnl = (Number(existing.totalPnl) || 0) + deltas.totalPnlDelta;
      }
      if (deltas?.totalVolumeDelta !== undefined && Number.isFinite(deltas.totalVolumeDelta)) {
        merged.totalVolume = (Number(existing.totalVolume) || 0) + deltas.totalVolumeDelta;
      }
      if (deltas?.lastTradeAt) {
        merged.lastTradeAt = deltas.lastTradeAt;
      }
      await tx.update(tradingBots).set({ stats: merged, updatedAt: sql`NOW()` }).where(eq(tradingBots.id, tradingBotId));
    };
    if (txArg) return run(txArg);
    await db.transaction(run);
  }

  /**
   * Canonical close-event identity used by EVERY close writer (webhook,
   * reconciler, retry, manual, pause, flip, subscriber routing). When a
   * tx signature exists, it IS the cross-path identity: `tx-<sig>`.
   * Without a signature we fall back to a deterministic
   * `nosig-<bot>-<side>-<size>` hash so re-runs against identical
   * economic state still collide on the unique index.
   *
   * Treat `protocolFillId` as the single source of truth for "is this
   * the same on-chain close?" — never use log/request scoped IDs here.
   */
  static canonicalCloseFillId(opts: {
    signature?: string | null;
    botId: string;
    side: string;
    size: string | number;
    market?: string;
    fillPrice?: string | number | null;
    timestampMs?: number;
  }): string {
    // Primary: protocol-level fill ID (tx signature or reconciler tradeId).
    if (opts.signature) return `tx-${opts.signature}`;

    // Fallback: deterministic hash over bot+market+size+price+time-bucket.
    // Side is excluded so callers using 'long'/'short' vs 'CLOSE' agree.
    const sizeStr = typeof opts.size === 'number' ? opts.size.toFixed(8) : opts.size;
    const priceStr = opts.fillPrice == null
      ? 'na'
      : (typeof opts.fillPrice === 'number' ? opts.fillPrice.toFixed(6) : opts.fillPrice);
    const market = opts.market ?? 'na';
    // Deterministic only when caller passes timestampMs. Otherwise mint
    // a per-write random ID so distinct closes don't collide; the storage
    // guard demotes such writes to pending for reconciler canonicalization.
    if (opts.timestampMs != null) {
      const FIVE_MIN_MS = 5 * 60 * 1000;
      const bucket = Math.floor(opts.timestampMs / FIVE_MIN_MS);
      const raw = `nosig|${opts.botId}|${market}|${sizeStr}|${priceStr}|${bucket}`;
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 24);
      return `nosig-${hash}`;
    }
    return `nosig-uniq-${randomBytes(12).toString('hex')}`;
  }

  /**
   * Atomic close-event recorder (task #67). Inserts (or updates) the canonical
   * close-event row AND recomputes stats inside a SINGLE DB transaction so the
   * `bot_trades` rows and `trading_bots.stats.totalTrades/win/loss` counters
   * can never disagree, even if a process is killed mid-write.
   *
   * Caller passes either:
   *   - `insert`: a fresh canonical close row keyed on `protocolFillId`. If
   *     another writer (reconciler / retry / racing webhook) already inserted
   *     a row with the same fill ID, the existing row is returned and the
   *     stats recompute still runs (it's idempotent — recompute reads the
   *     authoritative SQL aggregate).
   *   - `update`: { tradeId, fields } — used by the create-pending-then-update
   *     close pattern. Marks the pending row executed with realized PnL and
   *     recomputes in the same tx.
   *
   * RPC must NEVER happen inside this helper (TradingView 5s SLA).
   */
  async recordCloseEventAtomic(opts: {
    botId: string;
    insert?: InsertBotTrade;
    update?: { tradeId: string; fields: Partial<InsertBotTrade> };
    deltas: { totalPnlDelta?: number; totalVolumeDelta?: number; lastTradeAt?: string };
  }): Promise<{ trade?: BotTrade; isNew: boolean }> {
    // Defense-in-depth: demote non-deterministic close IDs to pending
    // so the reconciler canonicalizes them later instead of double-counting.
    const isNonDeterministic = (fillId: string | null | undefined): boolean =>
      typeof fillId === 'string' && fillId.startsWith('nosig-uniq-');
    const demoteFields = (fields: Partial<InsertBotTrade>): Partial<InsertBotTrade> => ({
      ...fields,
      status: 'pending',
      protocolFillId: null,
      errorMessage: fields.errorMessage
        ? `${fields.errorMessage} (awaiting reconciler canonicalization)`
        : 'Awaiting reconciler canonicalization (no signature/timestamp)',
    });
    if (opts.insert && isNonDeterministic(opts.insert.protocolFillId)) {
      opts = { ...opts, insert: demoteFields(opts.insert) as InsertBotTrade, deltas: {} };
    }
    if (opts.update && isNonDeterministic(opts.update.fields.protocolFillId)) {
      opts = {
        ...opts,
        update: { tradeId: opts.update.tradeId, fields: demoteFields(opts.update.fields) },
        deltas: {},
      };
    }
    // Stamp the executing protocol on a fresh close row when the caller omits
    // it — this atomic path inserts directly and bypasses createBotTrade()'s
    // central stamp. opts.botId identifies the venue (bot.activeProtocol is what
    // getAdapterForBot routes to). Cheap PK read; kept OUT of the tx below.
    if (opts.insert && !opts.insert.protocol && opts.botId) {
      const ownerBot = await this.getTradingBotById(opts.botId);
      if (ownerBot?.activeProtocol) {
        opts = { ...opts, insert: { ...opts.insert, protocol: ownerBot.activeProtocol } };
      }
    }
    return await db.transaction(async (tx) => {
      let trade: BotTrade | undefined;
      let isNew = true;
      if (opts.insert) {
        if (opts.insert.protocolFillId) {
          const existing = await tx.select().from(botTrades).where(eq(botTrades.protocolFillId, opts.insert.protocolFillId)).limit(1);
          if (existing[0]) {
            trade = existing[0];
            isNew = false;
          }
        }
        if (!trade) {
          try {
            const inserted = await tx.insert(botTrades).values(opts.insert).returning();
            trade = inserted[0];
          } catch (err: any) {
            if (err?.code === '23505' && opts.insert.protocolFillId) {
              const winner = await tx.select().from(botTrades).where(eq(botTrades.protocolFillId, opts.insert.protocolFillId)).limit(1);
              if (winner[0]) {
                trade = winner[0];
                isNew = false;
              } else throw err;
            } else throw err;
          }
        }
      } else if (opts.update) {
        // Lock the pending row first so racing callers serialize on it.
        // If the row is ALREADY in a canonical-close status, this call is
        // a replay (retry / double-fire) — return the existing row and
        // skip both the field update AND the delta merge so totalPnl /
        // totalVolume can never double-count.
        const lockedRows = await tx
          .select()
          .from(botTrades)
          .where(eq(botTrades.id, opts.update.tradeId))
          .for('update')
          .limit(1);
        const locked = lockedRows[0];
        if (!locked) {
          throw new Error(`recordCloseEventAtomic: trade ${opts.update.tradeId} not found`);
        }
        const CANONICAL_STATUSES = new Set(['executed', 'liquidated', 'recovered']);
        if (CANONICAL_STATUSES.has(locked.status)) {
          // Already finalized — pure no-op. Counters were merged by the
          // first writer; replays must not re-apply deltas.
          return { trade: locked, isNew: false };
        }

        // Reconciler-first race (DIFFERENT id spaces): the reconciler may have
        // already booked the canonical close under `tx-<exchange-fill-id>` while
        // THIS pending row promotes to `tx-<close-tx-signature>`. Those strings
        // differ, so the unique index can't collapse them and the plain update
        // below would create a SECOND canonical row → double-count. If a
        // reconciler-booked close already exists for this bot+market+approx size
        // at/after this pending row's creation, supersede our row and defer to
        // it (it already merged the stats deltas). isNew:false keeps callers
        // from re-sending notifications / re-booking IOUs.
        if (locked.side === 'CLOSE' || locked.pnl != null) {
          const reconcilerWinner = await this.getRecentCanonicalCloseForBot({
            botId: opts.botId,
            market: locked.market,
            sinceMs: 30 * 60 * 1000,
            afterTimestamp: locked.executedAt,
            sizeApprox: Math.abs(parseFloat(locked.size || '0')),
            sizeTolerancePct: 0.10,
            onlyReconciled: true,
          });
          if (reconcilerWinner) {
            await tx
              .update(botTrades)
              .set({ status: 'superseded', errorMessage: `Superseded by reconciler close ${reconcilerWinner.protocolFillId ?? reconcilerWinner.id}` })
              .where(eq(botTrades.id, opts.update.tradeId));
            return { trade: reconcilerWinner, isNew: false };
          }
        }

        // Cross-path race: another writer (reconciler / retry) may have
        // already inserted the canonical close row under this fillId. If
        // so, the unique-index update would fail with 23505 — handle it
        // by demoting OUR pending row to 'superseded' (excluded from the
        // canonical SQL stats filter) and returning the winner without
        // re-merging deltas (the winner already counted).
        const wantedFillId = opts.update.fields.protocolFillId;
        let updateFailedDueToConflict = false;
        try {
          await tx.update(botTrades).set(opts.update.fields).where(eq(botTrades.id, opts.update.tradeId));
        } catch (err: any) {
          if (err?.code === '23505' && wantedFillId) {
            updateFailedDueToConflict = true;
          } else {
            throw err;
          }
        }

        if (updateFailedDueToConflict && wantedFillId) {
          const winnerRows = await tx
            .select()
            .from(botTrades)
            .where(eq(botTrades.protocolFillId, wantedFillId))
            .limit(1);
          const winner = winnerRows[0];
          // Demote our losing pending row so it never participates in the
          // canonical stats SQL (status NOT IN executed/liquidated/recovered).
          await tx
            .update(botTrades)
            .set({ status: 'superseded', errorMessage: `Superseded by canonical close ${wantedFillId}` })
            .where(eq(botTrades.id, opts.update.tradeId));
          return { trade: winner ?? locked, isNew: false };
        }

        const found = await tx.select().from(botTrades).where(eq(botTrades.id, opts.update.tradeId)).limit(1);
        trade = found[0];
        // Only recompute on update path when the row actually transitioned
        // INTO a canonical status (locked.status was non-canonical above).
        await this.recomputeAndMergeBotStats(opts.botId, opts.deltas, tx);
        return { trade, isNew: true };
      }
      // Insert path: recompute only when we actually introduced a new
      // canonical row. Duplicate inserts (idempotency hits) are no-ops —
      // the original writer already merged deltas.
      if (opts.insert && isNew) {
        await this.recomputeAndMergeBotStats(opts.botId, opts.deltas, tx);
      }
      return { trade, isNew };
    });
  }

  async getBotTrades(tradingBotId: string, limit: number = 50): Promise<BotTrade[]> {
    return db.select().from(botTrades).where(eq(botTrades.tradingBotId, tradingBotId)).orderBy(desc(botTrades.executedAt)).limit(limit);
  }

  /**
   * Back-stop dedup helper for the reconciler. Returns the most recent
   * canonical close trade (executed/liquidated/recovered) for a bot+market
   * that was booked by a NON-reconciler path (webhook / manual / pause /
   * subscriber), within a time window and (optionally) matching an approximate
   * size and only counting closes at/after a given timestamp.
   *
   * Why: the webhook close keys `protocolFillId` on `tx-<close-tx-signature>`
   * while the reconciler keys on `tx-<exchange-fill-id>` — DIFFERENT id spaces
   * for the SAME close — so the `protocolFillId` unique index can't collapse
   * them. The reconciler uses this to detect "already booked by another path"
   * and skip a duplicate insert that would double-count realized PnL.
   */
  async getRecentCanonicalCloseForBot(opts: {
    botId: string;
    market: string;
    sinceMs: number;
    afterTimestamp?: Date | string | null;
    sizeApprox?: number;
    sizeTolerancePct?: number;
    excludeReconciled?: boolean;
    onlyReconciled?: boolean;
    closeSide?: string;
  }): Promise<BotTrade | undefined> {
    const since = new Date(Date.now() - opts.sinceMs);
    const afterTs = opts.afterTimestamp ? new Date(opts.afterTimestamp) : null;
    // Lower bound = whichever is more recent: the time window or the caller's
    // floor (position lastTradeAt / pending-row creation time). The floor
    // prevents matching a PRIOR close of the same size (e.g. a quick
    // reopen→close of the same market) and skipping a genuinely new close.
    const lowerBound = afterTs && afterTs > since ? afterTs : since;
    const conds: any[] = [
      eq(botTrades.tradingBotId, opts.botId),
      eq(botTrades.market, opts.market),
      or(
        eq(botTrades.status, 'executed'),
        eq(botTrades.status, 'liquidated'),
        eq(botTrades.status, 'recovered'),
      ),
      gte(botTrades.executedAt, lowerBound),
    ];
    if (opts.closeSide) {
      // Close-only via SIDE semantics: non-reconciler closes store side='CLOSE',
      // the reconciler stores the lowercase close side ('long'/'short'), while
      // opens/entries ALWAYS store UPPERCASE 'LONG'/'SHORT'. Matching on side
      // (rather than pnl-not-null) also catches RECOVERED closes whose pnl was
      // left null — retry recovery only sets pnl when entry+fill prices are both
      // > 0, but the row still carries side='CLOSE'. A pnl-not-null filter would
      // miss those and let the reconciler book a duplicate canonical close.
      conds.push(or(eq(botTrades.side, 'CLOSE'), eq(botTrades.side, opts.closeSide)));
    } else {
      // No side hint (onlyReconciled lookups): the reconciler always books
      // realized PnL, so pnl-not-null is a safe close-only proxy here and
      // excludes any pnl-less open/entry row.
      conds.push(isNotNull(botTrades.pnl));
    }
    const rows = await db
      .select()
      .from(botTrades)
      .where(and(...conds))
      .orderBy(desc(botTrades.executedAt))
      .limit(20);

    const tol = opts.sizeTolerancePct ?? 0.10;
    for (const row of rows) {
      const reconciled = (row.webhookPayload as any)?.reconciled === true
        || row.executionMethod === 'on-chain-detected';
      // onlyReconciled: detect ONLY reconciler-booked closes (used by the close
      // recorder to defer to a reconciler that already booked this close).
      // excludeReconciled (default): detect ONLY non-reconciler closes (used by
      // the reconciler to defer to a webhook/manual/etc. that already booked).
      if (opts.onlyReconciled === true) {
        if (!reconciled) continue;
      } else if (opts.excludeReconciled !== false) {
        if (reconciled) continue;
      }
      if (opts.sizeApprox != null && opts.sizeApprox > 0) {
        const rowSize = Math.abs(parseFloat(row.size || '0'));
        if (rowSize <= 0) continue;
        const diff = Math.abs(rowSize - opts.sizeApprox) / opts.sizeApprox;
        if (diff > tol) continue;
      }
      return row;
    }
    return undefined;
  }

  async getBotTradeCount(tradingBotId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` }).from(botTrades).where(eq(botTrades.tradingBotId, tradingBotId));
    return result[0]?.count || 0;
  }

  async getBotTrade(tradeId: string): Promise<BotTrade | undefined> {
    const result = await db.select().from(botTrades).where(eq(botTrades.id, tradeId)).limit(1);
    return result[0];
  }

  async getBotPerformanceSeries(tradingBotId: string, since?: Date): Promise<{ timestamp: Date; pnl: number; cumulativePnl: number }[]> {
    const conditions = [
      eq(botTrades.tradingBotId, tradingBotId),
      // Canonical close-event status set — MUST match
      // getCanonicalBotTradeStats so the share-card / performance series
      // tradeCount agrees with overview / leaderboard / balance counts.
      // Recovered close trades (from the retry flow) carry realized PnL
      // and are real canonical events, so they're included here too.
      or(
        eq(botTrades.status, 'executed'),
        eq(botTrades.status, 'liquidated'),
        eq(botTrades.status, 'recovered'),
      ),
      sql`${botTrades.pnl} IS NOT NULL`,
      // Drop phantom duplicate closes so the series length (tradeCount on the
      // performance card) matches getCanonicalBotTradeStats. MUST stay in
      // lockstep with that function's filter.
      notPhantomDupClose(),
    ];
    if (since) {
      conditions.push(gte(botTrades.executedAt, since));
    }
    const trades = await db
      .select({
        executedAt: botTrades.executedAt,
        pnl: botTrades.pnl,
        fee: botTrades.fee,
      })
      .from(botTrades)
      .where(and(...conditions))
      .orderBy(botTrades.executedAt);

    let cumulativePnl = 0;
    return trades.map((trade) => {
      // Calculate NET PnL: gross pnl minus fee
      const grossPnl = parseFloat(trade.pnl || '0');
      const fee = parseFloat(trade.fee || '0');
      const netPnl = grossPnl - fee;
      cumulativePnl += netPnl;
      return {
        timestamp: trade.executedAt,
        pnl: netPnl,
        cumulativePnl,
      };
    });
  }

  async getWalletBotTrades(walletAddress: string, limit: number = 50): Promise<(BotTrade & { botName?: string })[]> {
    const results = await db.select({
      trade: botTrades,
      botName: tradingBots.name,
    })
    .from(botTrades)
    .leftJoin(tradingBots, eq(botTrades.tradingBotId, tradingBots.id))
    .where(eq(botTrades.walletAddress, walletAddress))
    .orderBy(desc(botTrades.executedAt))
    .limit(limit);
    
    return results.map(r => ({
      ...r.trade,
      botName: r.botName ?? undefined,
    }));
  }

  private async incrementCumulativeStatsInTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], volumeDelta: number, tradesDelta: number): Promise<void> {
    await tx.insert(platformCumulativeStats).values({
      id: DatabaseStorage.CUMULATIVE_STATS_SINGLETON_ID,
      totalVolume: volumeDelta.toString(),
      totalTrades: tradesDelta,
    }).onConflictDoUpdate({
      target: platformCumulativeStats.id,
      set: {
        totalVolume: sql`CAST(${platformCumulativeStats.totalVolume} AS DECIMAL) + ${volumeDelta}`,
        totalTrades: sql`${platformCumulativeStats.totalTrades} + ${tradesDelta}`,
        updatedAt: sql`NOW()`,
      },
    });
  }

  async createBotTrade(trade: InsertBotTrade): Promise<BotTrade> {
    // Stamp the executing protocol so every trade row reflects the real
    // exchange/adapter that handled it (e.g. 'flash', 'drift', 'pacifica'),
    // not the schema fallback. Callers that don't pass `protocol` get it
    // derived from the owning bot here — `tradingBotId` is NOT NULL with an
    // FK, so the bot exists at insert time, and `activeProtocol` is exactly
    // what getAdapterForBot() routes the execution to. This central stamp
    // keeps labels correct for current AND future call sites/exchanges.
    if (!trade.protocol && trade.tradingBotId) {
      const ownerBot = await this.getTradingBotById(trade.tradingBotId);
      if (ownerBot?.activeProtocol) {
        trade = { ...trade, protocol: ownerBot.activeProtocol };
      }
    }

    if (trade.status === 'executed' && trade.size && trade.price) {
      const volume = Math.abs(parseFloat(String(trade.size)) * parseFloat(String(trade.price)));
      if (volume > 0) {
        const result = await db.transaction(async (tx) => {
          const tradeResult = await tx.insert(botTrades).values(trade).returning();
          await this.incrementCumulativeStatsInTx(tx, volume, 1);
          return tradeResult[0];
        });
        return result;
      }
    }

    const result = await db.insert(botTrades).values(trade).returning();
    return result[0];
  }

  /**
   * Idempotent insert keyed on `protocolFillId` (canonical close-event ID).
   * If a row with the same fill ID already exists, return it with isNew=false
   * — this lets racing close paths (reconciler, webhook, retry) safely call
   * the same write without producing duplicate rows.
   */
  async createBotTradeIdempotent(trade: InsertBotTrade): Promise<{ trade: BotTrade; isNew: boolean }> {
    if (trade.protocolFillId) {
      const existing = await db
        .select()
        .from(botTrades)
        .where(eq(botTrades.protocolFillId, trade.protocolFillId))
        .limit(1);
      if (existing[0]) {
        return { trade: existing[0], isNew: false };
      }
      try {
        const inserted = await this.createBotTrade(trade);
        return { trade: inserted, isNew: true };
      } catch (err: any) {
        // 23505 = unique_violation — racing path beat us; fetch the winner.
        if (err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message ?? '')) {
          const winner = await db
            .select()
            .from(botTrades)
            .where(eq(botTrades.protocolFillId, trade.protocolFillId))
            .limit(1);
          if (winner[0]) {
            return { trade: winner[0], isNew: false };
          }
        }
        throw err;
      }
    }
    const inserted = await this.createBotTrade(trade);
    return { trade: inserted, isNew: true };
  }

  async updateBotTrade(id: string, updates: Partial<InsertBotTrade>): Promise<void> {
    if (updates.status === 'executed') {
      const existing = await this.getBotTrade(id);
      if (existing && existing.status !== 'executed') {
        const size = updates.size ?? existing.size;
        const price = updates.price ?? existing.price;
        if (size && price) {
          const volume = Math.abs(parseFloat(String(size)) * parseFloat(String(price)));
          if (volume > 0) {
            await db.transaction(async (tx) => {
              await tx.update(botTrades).set(updates).where(eq(botTrades.id, id));
              await this.incrementCumulativeStatsInTx(tx, volume, 1);
            });
            return;
          }
        }
      }
    }
    await db.update(botTrades).set(updates).where(eq(botTrades.id, id));
  }

  async getOrphanedPendingTrades(maxAgeMinutes: number = 5): Promise<BotTrade[]> {
    const threshold = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    return db.select().from(botTrades)
      .where(and(
        eq(botTrades.status, "pending"),
        sql`${botTrades.executedAt} < ${threshold}`
      ))
      .orderBy(desc(botTrades.executedAt));
  }

  async createWebhookLog(log: InsertWebhookLog): Promise<WebhookLog> {
    const result = await db.insert(webhookLogs).values(log).returning();
    return result[0];
  }

  async updateWebhookLog(id: string, updates: Partial<InsertWebhookLog>): Promise<void> {
    await db.update(webhookLogs).set(updates).where(eq(webhookLogs.id, id));
  }

  async checkDuplicateSignal(signalHash: string, botId: string): Promise<boolean> {
    // Check if a webhook with this hash was already processed for this bot
    const result = await db.select()
      .from(webhookLogs)
      .where(and(
        eq(webhookLogs.signalHash, signalHash),
        eq(webhookLogs.tradingBotId, botId),
        eq(webhookLogs.tradeExecuted, true)
      ))
      .limit(1);
    return result.length > 0;
  }

  async createSubscription(subscription: InsertSubscription): Promise<Subscription> {
    const result = await db.insert(subscriptions).values(subscription).returning();
    return result[0];
  }

  async getUserSubscriptions(userId: string): Promise<(Subscription & { bot: Bot })[]> {
    const result = await db
      .select()
      .from(subscriptions)
      .innerJoin(bots, eq(subscriptions.botId, bots.id))
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.subscribedAt));

    return result.map((row) => ({
      ...row.subscriptions,
      bot: row.bots,
    }));
  }

  async updateSubscriptionStatus(id: string, status: string): Promise<void> {
    await db.update(subscriptions).set({ status }).where(eq(subscriptions.id, id));
  }

  async getPortfolio(userId: string): Promise<Portfolio | undefined> {
    const result = await db.select().from(portfolios).where(eq(portfolios.userId, userId)).limit(1);
    return result[0];
  }

  async upsertPortfolio(portfolio: InsertPortfolio): Promise<Portfolio> {
    const result = await db
      .insert(portfolios)
      .values(portfolio)
      .onConflictDoUpdate({
        target: portfolios.userId,
        set: {
          totalValue: portfolio.totalValue,
          unrealizedPnl: portfolio.unrealizedPnl,
          realizedPnl: portfolio.realizedPnl,
          solBalance: portfolio.solBalance,
          usdcBalance: portfolio.usdcBalance,
          updatedAt: sql`NOW()`,
        },
      })
      .returning();
    return result[0];
  }

  async getUserPositions(userId: string): Promise<Position[]> {
    return db.select().from(positions).where(eq(positions.userId, userId)).orderBy(desc(positions.createdAt));
  }

  async createPosition(position: InsertPosition): Promise<Position> {
    const result = await db.insert(positions).values(position).returning();
    return result[0];
  }

  async updatePosition(id: string, updates: Partial<InsertPosition>): Promise<void> {
    await db.update(positions).set(updates).where(eq(positions.id, id));
  }

  async getUserTrades(userId: string, limit: number = 50): Promise<Trade[]> {
    return db.select().from(trades).where(eq(trades.userId, userId)).orderBy(desc(trades.timestamp)).limit(limit);
  }

  async createTrade(trade: InsertTrade): Promise<Trade> {
    const result = await db.insert(trades).values(trade).returning();
    return result[0];
  }

  async getLeaderboard(limit: number = 100): Promise<(LeaderboardStats & { user: User })[]> {
    const result = await db
      .select()
      .from(leaderboardStats)
      .innerJoin(users, eq(leaderboardStats.userId, users.id))
      .orderBy(desc(leaderboardStats.totalPnl))
      .limit(limit);

    return result.map((row, index) => ({
      ...row.leaderboard_stats,
      rank: index + 1,
      user: row.users,
    }));
  }

  async upsertLeaderboardStats(stats: InsertLeaderboardStats): Promise<LeaderboardStats> {
    const result = await db
      .insert(leaderboardStats)
      .values(stats)
      .onConflictDoUpdate({
        target: leaderboardStats.userId,
        set: {
          totalVolume: stats.totalVolume,
          totalPnl: stats.totalPnl,
          winRate: stats.winRate,
          totalTrades: stats.totalTrades,
          updatedAt: sql`NOW()`,
        },
      })
      .returning();
    return result[0];
  }

  async getWalletLeaderboard(limit: number = 20): Promise<Array<{
    walletAddress: string;
    displayName: string | null;
    xUsername: string | null;
    totalVolume: number;
    totalPnl: number;
    pnlPercent: number;
    winRate: number;
    tradeCount: number;
  }>> {
    const allWallets = await db.select().from(wallets);
    const results: Array<{
      walletAddress: string;
      displayName: string | null;
      xUsername: string | null;
      totalVolume: number;
      totalPnl: number;
      pnlPercent: number;
      winRate: number;
      tradeCount: number;
    }> = [];

    for (const wallet of allWallets) {
      const bots = await db.select().from(tradingBots).where(eq(tradingBots.walletAddress, wallet.address));
      if (bots.length === 0) continue;

      // Canonical SQL-derived counts: closed-position events with realized PnL
      // (matches the share card / overview / balance endpoints).
      let totalWinningTrades = 0;
      let totalTrades = 0;
      for (const bot of bots) {
        const counts = await this.getCanonicalBotTradeStats(bot.id);
        totalTrades += counts.totalTrades;
        totalWinningTrades += counts.winningTrades;
      }

      const botIds = bots.map(b => b.id);
      let totalVolume = 0;
      let totalPnl = 0;

      for (const botId of botIds) {
        // Only count executed trades for volume (not failed/pending trades)
        const trades = await db.select().from(botTrades)
          .where(and(
            eq(botTrades.tradingBotId, botId),
            eq(botTrades.status, "executed")
          ));
        for (const trade of trades) {
          const size = parseFloat(trade.size);
          const price = parseFloat(trade.price);
          totalVolume += Math.abs(size * price);
        }

        const positions = await db.select().from(botPositions).where(eq(botPositions.tradingBotId, botId));
        for (const pos of positions) {
          totalPnl += parseFloat(pos.realizedPnl);
        }
      }

      const winRate = totalTrades > 0 ? (totalWinningTrades / totalTrades) * 100 : 0;

      // Task 119: Use the wallet's latest portfolio snapshot as the source of
      // truth for both `$ totalPnl` and `pnlPercent` so the leaderboard agrees
      // with the wallet owner's portfolio page and the Task 120 sparkline
      // tip. Falls back to the per-bot realized-only sum if no snapshot has
      // been taken yet (new wallets).
      const latestSnap = await this.getLatestPortfolioDailySnapshot(wallet.address);
      let leaderTotalPnl = totalPnl;
      let pnlPercent = 0;
      if (latestSnap) {
        leaderTotalPnl = parseFloat(latestSnap.cumulativeTradingPnl ?? latestSnap.netPnl);
        pnlPercent = parseFloat(latestSnap.pnlPercent ?? '0');
      } else {
        const { deposits } = await this.getWalletCumulativeDepositsWithdrawals(wallet.address);
        pnlPercent = deposits > 0 ? (totalPnl / deposits) * 100 : 0;
      }

      results.push({
        walletAddress: wallet.address,
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        totalVolume,
        totalPnl: leaderTotalPnl,
        pnlPercent,
        winRate,
        tradeCount: totalTrades,
      });
    }

    // Sort by % P&L (best performers first)
    results.sort((a, b) => b.pnlPercent - a.pnlPercent);
    return results.slice(0, limit);
  }

  async createEquityEvent(event: InsertEquityEvent): Promise<EquityEvent> {
    const result = await db.insert(equityEvents).values(event).returning();
    return result[0];
  }

  async getEquityEventByTxSignature(txSignature: string): Promise<EquityEvent | undefined> {
    const result = await db.select().from(equityEvents).where(eq(equityEvents.txSignature, txSignature)).limit(1);
    return result[0];
  }

  // --- Phase 0a Vaults -------------------------------------------------------

  // Scope (Phase 4): tradingBotId === null|undefined ⇒ account-level vault rows
  // (trading_bot_id IS NULL). A non-null id ⇒ that specific bot's per-bot wallet.
  private vaultScopeCond(tradingBotId: string | null | undefined) {
    return tradingBotId == null
      ? isNull(vaultPositions.tradingBotId)
      : eq(vaultPositions.tradingBotId, tradingBotId);
  }

  // Stable, unambiguous advisory-lock key for a (wallet, scope, asset) tuple.
  // Delegates to the shared, pure helper so account and per-bot rows never share
  // a lock slot (see server/vault/scope.ts).
  private vaultLockKey(walletAddress: string, tradingBotId: string | null | undefined, assetKey: string): number {
    return computeVaultLockKey(walletAddress, tradingBotId, assetKey);
  }

  async getVaultPosition(walletAddress: string, assetKey: string, tradingBotId: string | null = null): Promise<VaultPosition | undefined> {
    const result = await db.select().from(vaultPositions)
      .where(and(eq(vaultPositions.walletAddress, walletAddress), this.vaultScopeCond(tradingBotId), eq(vaultPositions.assetKey, assetKey)))
      .limit(1);
    return result[0];
  }

  async getVaultPositions(walletAddress: string, tradingBotId: string | null = null): Promise<VaultPosition[]> {
    return await db.select().from(vaultPositions)
      .where(and(eq(vaultPositions.walletAddress, walletAddress), this.vaultScopeCond(tradingBotId)))
      .orderBy(desc(vaultPositions.updatedAt));
  }

  // Every parked row the wallet owns, across ALL scopes (account + per-bot),
  // for the read-only "all parked balances" aggregate. Grouping by scope is the
  // caller's job (see /api/vault/positions/all).
  async getVaultPositionsAllScopes(walletAddress: string): Promise<VaultPosition[]> {
    return await db.select().from(vaultPositions)
      .where(eq(vaultPositions.walletAddress, walletAddress))
      .orderBy(desc(vaultPositions.updatedAt));
  }

  // --- Vaults borrow engine (Phase C, READ-ONLY) ---
  // Scope mirrors the vault readers: tradingBotId === null|undefined ⇒
  // account-level rows (trading_bot_id IS NULL); a non-null id ⇒ that bot's
  // per-bot wallet. On-chain remains the source of truth; these are cache reads.
  private borrowScopeCond(tradingBotId: string | null | undefined) {
    return tradingBotId == null
      ? isNull(borrowPositions.tradingBotId)
      : eq(borrowPositions.tradingBotId, tradingBotId);
  }

  async getBorrowPosition(walletAddress: string, id: string): Promise<BorrowPosition | undefined> {
    const result = await db.select().from(borrowPositions)
      .where(and(eq(borrowPositions.walletAddress, walletAddress), eq(borrowPositions.id, id)))
      .limit(1);
    return result[0];
  }

  // kind-scoped BY DEFAULT ('borrow'): every pre-loop call site (routes, UI
  // reads, NFT-reuse scans, carve, repay orchestrators) expects only classic
  // borrow rows. SOL-loop rows share this table but are a different product —
  // they must never leak into borrow UX, USDC repay paths, or NFT reuse.
  // The loop engine passes kind:'loop' explicitly.
  async getBorrowPositions(walletAddress: string, tradingBotId: string | null = null, kind: string = 'borrow'): Promise<BorrowPosition[]> {
    return await db.select().from(borrowPositions)
      .where(and(
        eq(borrowPositions.walletAddress, walletAddress),
        this.borrowScopeCond(tradingBotId),
        eq(borrowPositions.kind, kind),
      ))
      .orderBy(desc(borrowPositions.updatedAt));
  }

  // Every borrow row the wallet owns, across ALL scopes (account + per-bot), for
  // the read-only exposure aggregate. Grouping by scope is the caller's job.
  // kind-scoped to 'borrow' by default (loop rows are not part of the borrow book).
  async getBorrowPositionsAllScopes(walletAddress: string, kind: string = 'borrow'): Promise<BorrowPosition[]> {
    return await db.select().from(borrowPositions)
      .where(and(eq(borrowPositions.walletAddress, walletAddress), eq(borrowPositions.kind, kind)))
      .orderBy(desc(borrowPositions.updatedAt));
  }

  // Platform-wide active borrow rows for the monitor (Phase C read path) and the
  // aggregate-exposure circuit-breaker input. Terminal rows ('closed' = repaid,
  // 'failed' = never opened) are excluded — they carry no live platform debt.
  // Deliberately ALL kinds: the health monitor must watch loop rows too. Callers
  // feeding the USDC exposure book must drop kind==='loop' rows themselves
  // (buildBorrowExposureContext does) — SOL-denominated loop debt is not part of
  // the dollar book and would otherwise fail the builder closed platform-wide.
  async getActiveBorrowPositionsAllWallets(): Promise<BorrowPosition[]> {
    return await db.select().from(borrowPositions)
      .where(and(ne(borrowPositions.status, 'closed'), ne(borrowPositions.status, 'failed')))
      .orderBy(desc(borrowPositions.updatedAt));
  }

  async getAutoTopUpCandidatePositions(): Promise<{ position: BorrowPosition; bot: TradingBot }[]> {
    // Cheap prefilter for the autonomous "defend the loan" scanner: only OPEN,
    // per-bot (Flash) positions whose owner bot OPTED IN to EITHER defense (auto
    // collateral top-up OR auto repay), and whose LAST monitored band the
    // borrow-health monitor recorded as urgent-or-worse. The scanner does a FRESH
    // live read AND re-checks each per-action flag before spending anything — this
    // join just bounds the RPC to genuinely at-risk opted-in loans. (Depends on
    // the monitor having populated lastObservedHealthBand; a cold start yields no
    // candidates until it runs once.)
    const rows = await db.select({ position: borrowPositions, bot: tradingBots })
      .from(borrowPositions)
      .innerJoin(tradingBots, eq(tradingBots.id, borrowPositions.tradingBotId))
      .where(and(
        eq(borrowPositions.status, 'open'),
        isNotNull(borrowPositions.tradingBotId),
        isNotNull(borrowPositions.venuePositionId),
        or(
          eq(tradingBots.autoCollateralTopUp, true),
          eq(tradingBots.autoRepayEnabled, true),
        ),
        eq(tradingBots.activeProtocol, 'flash'),
        inArray(borrowPositions.lastObservedHealthBand, ['urgent', 'liquidation']),
        // NEVER hand a SOL-loop row to the USDC "defend the loan" machinery —
        // it would try to defend WSOL debt with USDC. (Loops are account-scope
        // in P2 so the bot join already excludes them; this is the hard guard.)
        eq(borrowPositions.kind, 'borrow'),
      ));
    return rows;
  }

  async claimBorrowPositionAutoTopupAttempt(id: string, cooldownMs: number): Promise<BorrowPosition | null> {
    // Atomic re-fire throttle: stamp the attempt time and return the row in ONE
    // statement, but ONLY when the position is still open AND the cooldown window
    // has elapsed. Overlapping ticks race to this UPDATE; exactly one wins, so a
    // still-urgent loan is handed to the executor at most once per window. Does NOT
    // bump updatedAt (internal scheduling state, not a user-visible edit).
    const [row] = await db.update(borrowPositions)
      .set({ lastAutoTopupAttemptAt: sql`NOW()` })
      .where(and(
        eq(borrowPositions.id, id),
        eq(borrowPositions.status, 'open'),
        or(
          isNull(borrowPositions.lastAutoTopupAttemptAt),
          lte(borrowPositions.lastAutoTopupAttemptAt, sql`NOW() - make_interval(secs => ${cooldownMs} / 1000.0)`),
        ),
      ))
      .returning();
    return row ?? null;
  }

  // SOL Loop Vault P3 safety tick: same atomic-claim pattern as the auto-topup
  // throttle above, on its OWN column (last_policy_action_at) so the two
  // autonomous defenders never share a cooldown. Exactly one caller per window
  // wins the UPDATE; a loop that stays unhealthy re-fires at most once per
  // cooldown. Does NOT bump updatedAt (internal scheduling state).
  async claimBorrowPositionPolicyAction(id: string, cooldownMs: number): Promise<BorrowPosition | null> {
    const [row] = await db.update(borrowPositions)
      .set({ lastPolicyActionAt: sql`NOW()` })
      .where(and(
        eq(borrowPositions.id, id),
        eq(borrowPositions.status, 'open'),
        or(
          isNull(borrowPositions.lastPolicyActionAt),
          lte(borrowPositions.lastPolicyActionAt, sql`NOW() - make_interval(secs => ${cooldownMs} / 1000.0)`),
        ),
      ))
      .returning();
    return row ?? null;
  }

  async getBorrowOperations(walletAddress: string, borrowPositionId: string | null = null): Promise<BorrowOperation[]> {
    const cond = borrowPositionId == null
      ? eq(borrowOperations.walletAddress, walletAddress)
      : and(eq(borrowOperations.walletAddress, walletAddress), eq(borrowOperations.borrowPositionId, borrowPositionId));
    return await db.select().from(borrowOperations)
      .where(cond)
      .orderBy(desc(borrowOperations.createdAt));
  }

  // ---- Borrow money-state WRITERS (Phase D money engine) ---------------------
  // Mirror the audited park/unpark safety model: a 'pending' position row plus an
  // append-only operation log give the executor a resumable, idempotent record.
  // Status transitions use optional CAS (ifStatus) so a resume/recovery holder
  // can never double-apply a terminal write.

  async createBorrowPosition(p: {
    walletAddress: string;
    tradingBotId?: string | null;
    debtVenue: string;
    venueVaultId?: string | null;
    venuePositionId?: string | null;
    collateralAssetKey: string;
    collateralMint: string;
    collateralAmountRaw?: string;
    debtAssetKey?: string;
    debtMint: string;
    debtAmountRaw?: string;
    attributedBotId?: string | null;
    status?: string;
    kind?: string;
  }): Promise<BorrowPosition> {
    const rows = await db.insert(borrowPositions).values({
      walletAddress: p.walletAddress,
      tradingBotId: p.tradingBotId ?? null,
      debtVenue: p.debtVenue,
      venueVaultId: p.venueVaultId ?? null,
      venuePositionId: p.venuePositionId ?? null,
      collateralAssetKey: p.collateralAssetKey,
      collateralMint: p.collateralMint,
      collateralAmountRaw: p.collateralAmountRaw ?? '0',
      debtAssetKey: p.debtAssetKey ?? 'usdc',
      debtMint: p.debtMint,
      debtAmountRaw: p.debtAmountRaw ?? '0',
      attributedBotId: p.attributedBotId ?? null,
      status: p.status ?? 'pending',
      kind: p.kind ?? 'borrow',
    }).returning();
    return rows[0];
  }

  // Update a borrow position. When `ifStatus` is given the write is a CAS: it
  // only lands if the row is STILL in that status (returns undefined on loss),
  // so two executors / a crash-resume cannot both apply a terminal transition.
  async updateBorrowPosition(
    id: string,
    patch: {
      venuePositionId?: string | null;
      venueVaultId?: string | null;
      collateralAmountRaw?: string;
      debtAmountRaw?: string;
      status?: string;
      attributedBotId?: string | null;
      healthSnapshot?: BorrowPosition['healthSnapshot'];
      healthAsOf?: Date | null;
      healthSource?: string | null;
      lastObservedHealthBand?: string | null;
      healthBandChangedAt?: Date | null;
      lastHealthAlertBand?: string | null;
      lastHealthAlertAt?: Date | null;
      policyState?: string | null;
      policyReason?: string | null;
      policyStateChangedAt?: Date | null;
    },
    ifStatus?: string,
  ): Promise<BorrowPosition | undefined> {
    const cond = ifStatus
      ? and(eq(borrowPositions.id, id), eq(borrowPositions.status, ifStatus))
      : eq(borrowPositions.id, id);
    const rows = await db.update(borrowPositions)
      .set({ ...patch, updatedAt: new Date() })
      .where(cond)
      .returning();
    return rows[0];
  }

  async createBorrowOperation(p: {
    walletAddress: string;
    borrowPositionId?: string | null;
    operationType: string;
    status?: string;
    step?: string | null;
    clientRequestId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<BorrowOperation> {
    const rows = await db.insert(borrowOperations).values({
      walletAddress: p.walletAddress,
      borrowPositionId: p.borrowPositionId ?? null,
      operationType: p.operationType,
      status: p.status ?? 'pending',
      step: p.step ?? null,
      clientRequestId: p.clientRequestId ?? null,
      metadata: p.metadata ?? null,
    }).returning();
    return rows[0];
  }

  // Update an operation-log row. `appendTxSignature` does an atomic jsonb array
  // append (row-level), so per-step signatures accumulate without a read-modify-
  // write race. `mergeMetadata` likewise merges into the existing jsonb via `||`
  // (progressive step breadcrumbs); `metadata` REPLACES it wholesale. All other
  // fields are plain sets.
  async updateBorrowOperation(
    id: string,
    patch: {
      status?: string;
      step?: string | null;
      error?: string | null;
      borrowPositionId?: string | null;
      appendTxSignature?: string;
      metadata?: Record<string, unknown> | null;
      mergeMetadata?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
    },
  ): Promise<BorrowOperation | undefined> {
    const sets: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) sets.status = patch.status;
    if (patch.step !== undefined) sets.step = patch.step;
    if (patch.error !== undefined) sets.error = patch.error;
    if (patch.borrowPositionId !== undefined) sets.borrowPositionId = patch.borrowPositionId;
    if (patch.appendTxSignature) {
      sets.txSignatures = sql`${borrowOperations.txSignatures} || ${JSON.stringify([patch.appendTxSignature])}::jsonb`;
    }
    if (patch.metadata !== undefined) {
      sets.metadata = patch.metadata;
    } else if (patch.mergeMetadata !== undefined) {
      sets.metadata = sql`COALESCE(${borrowOperations.metadata}, '{}'::jsonb) || ${JSON.stringify(patch.mergeMetadata)}::jsonb`;
    }
    if (patch.result !== undefined) sets.result = patch.result;
    const rows = await db.update(borrowOperations).set(sets).where(eq(borrowOperations.id, id)).returning();
    return rows[0];
  }

  async getBorrowOperationById(id: string): Promise<BorrowOperation | undefined> {
    const rows = await db.select().from(borrowOperations).where(eq(borrowOperations.id, id)).limit(1);
    return rows[0];
  }

  // Idempotency lookup: a retried logical op (same wallet + client request id)
  // resolves to its existing row so the caller can resume / return the result
  // instead of re-executing. The partial UNIQUE index guarantees at most one.
  async getBorrowOperationByClientRequestId(walletAddress: string, clientRequestId: string): Promise<BorrowOperation | undefined> {
    const rows = await db.select().from(borrowOperations)
      .where(and(eq(borrowOperations.walletAddress, walletAddress), eq(borrowOperations.clientRequestId, clientRequestId)))
      .limit(1);
    return rows[0];
  }

  // P4 HOP resume sweep: every loop_hop op that is NOT terminal (still pending)
  // across ALL wallets, oldest first. The allocation tick re-drives each one so
  // a hop interrupted mid-flight (after the close, before the re-open) always
  // resumes from its step breadcrumb — the SOL is sitting in the agent wallet
  // and must be re-looped, never stranded. Terminal rows (succeeded/failed) are
  // excluded so the sweep is idempotent.
  async getPendingLoopHopOperations(): Promise<BorrowOperation[]> {
    return await db.select().from(borrowOperations)
      .where(and(
        eq(borrowOperations.operationType, 'loop_hop'),
        ne(borrowOperations.status, 'succeeded'),
        ne(borrowOperations.status, 'completed'),
        ne(borrowOperations.status, 'failed'),
      ))
      .orderBy(asc(borrowOperations.createdAt));
  }

  // --- Fixed Yield vault positions -----------------------------------------

  async createFyPosition(p: InsertFyPosition): Promise<FyPosition> {
    const [row] = await db.insert(fyPositions).values(p).returning();
    return row;
  }

  async updateFyPosition(id: string, patch: { ptAmountRaw?: string; costBasisUsdc?: string; status?: string; notifiedMaturityAt?: Date | null; }): Promise<FyPosition | undefined> {
    const [row] = await db.update(fyPositions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(fyPositions.id, id))
      .returning();
    return row;
  }

  async getFyPositionById(id: string): Promise<FyPosition | undefined> {
    const rows = await db.select().from(fyPositions).where(eq(fyPositions.id, id)).limit(1);
    return rows[0];
  }

  async getFyPositionsByWallet(walletAddress: string, includeClosed = false): Promise<FyPosition[]> {
    const cond = includeClosed
      ? eq(fyPositions.walletAddress, walletAddress)
      : and(eq(fyPositions.walletAddress, walletAddress), ne(fyPositions.status, 'closed'));
    return db.select().from(fyPositions).where(cond).orderBy(desc(fyPositions.createdAt));
  }

  // Matured, still-active fixed-yield positions whose owner has NOT yet been
  // told — the maturity-notify scan's worklist (bounded; oldest first).
  async getMaturedUnnotifiedFyPositions(now: Date, limit = 50): Promise<FyPosition[]> {
    return db.select().from(fyPositions)
      .where(and(
        eq(fyPositions.status, 'active'),
        lte(fyPositions.maturityAt, now),
        isNull(fyPositions.notifiedMaturityAt),
      ))
      .orderBy(fyPositions.maturityAt)
      .limit(limit);
  }

  // Sum of the wallet's OPEN borrow debt (USDC), in USD — the liability to
  // subtract from displayed net worth so borrowed USDC sitting in the wallet is
  // not counted as equity. Sources the DB cache (refreshed from on-chain on
  // open/close/monitor), mirroring how parked vault value is surfaced. Only
  // USDC-denominated debt is summed (MVP is USDC-only); terminal rows excluded.
  async sumOpenBorrowDebtUsdc(walletAddress: string): Promise<number> {
    const rows = await db.select({
      debtAmountRaw: borrowPositions.debtAmountRaw,
      debtAssetKey: borrowPositions.debtAssetKey,
    }).from(borrowPositions)
      .where(and(
        eq(borrowPositions.walletAddress, walletAddress),
        ne(borrowPositions.status, 'closed'),
        ne(borrowPositions.status, 'failed'),
      ));
    let totalRaw = BigInt(0);
    for (const r of rows) {
      if (String(r.debtAssetKey).toLowerCase() !== 'usdc') continue;
      try {
        const v = BigInt(r.debtAmountRaw);
        if (v > BigInt(0)) totalRaw += v;
      } catch { /* writes are always valid integer strings; unreachable */ }
    }
    return new Decimal(totalRaw.toString()).div(1_000_000).toNumber();
  }

  // Same as sumOpenBorrowDebtUsdc but scoped to a SINGLE bot's per-bot borrow
  // positions (trading_bot_id = botId). Used to subtract a bot's OWN open borrow
  // liability from its DISPLAYED net equity / net PnL so borrowed USDC sitting in
  // the bot wallet is not counted as the bot's own gains. Terminal rows excluded;
  // USDC-denominated debt only (MVP is USDC-only).
  async sumOpenBorrowDebtUsdcForBot(walletAddress: string, tradingBotId: string): Promise<number> {
    const rows = await db.select({
      debtAmountRaw: borrowPositions.debtAmountRaw,
      debtAssetKey: borrowPositions.debtAssetKey,
    }).from(borrowPositions)
      .where(and(
        eq(borrowPositions.walletAddress, walletAddress),
        eq(borrowPositions.tradingBotId, tradingBotId),
        ne(borrowPositions.status, 'closed'),
        ne(borrowPositions.status, 'failed'),
      ));
    let totalRaw = BigInt(0);
    for (const r of rows) {
      if (String(r.debtAssetKey).toLowerCase() !== 'usdc') continue;
      try {
        const v = BigInt(r.debtAmountRaw);
        if (v > BigInt(0)) totalRaw += v;
      } catch { /* writes are always valid integer strings; unreachable */ }
    }
    return new Decimal(totalRaw.toString()).div(1_000_000).toNumber();
  }

  // Bounded retry for the brief cost-basis DB write that follows a SUCCESSFUL
  // on-chain park/unpark swap. The money already moved on-chain; a transient DB
  // hiccup (pool exhaustion, lock wait, connection blip) must not lose the
  // bookkeeping. We only retry when an idempotency key (the swap signature) is
  // present: the transaction body dedupes on that signature so a lost commit-ack
  // can't double-apply, and a fully rolled-back attempt retries cleanly.
  private async withVaultWriteRetry<T>(fn: (attempt: number) => Promise<T>, idempotent: boolean): Promise<T> {
    const maxAttempts = idempotent ? 4 : 1;
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    throw lastErr;
  }

  // Atomic: add parked tokens + add USDC cost basis (average cost) and record the
  // swap as a taxable equity event, all in one transaction. The realized on-chain
  // token delta and the exact USDC spent are computed by the caller before this.
  async applyVaultPark(p: {
    walletAddress: string;
    tradingBotId?: string | null;
    assetKey: string;
    mint: string;
    tokensReceivedRaw: string;
    usdcSpent: number;
    txSignature?: string;
    txBlockTime?: Date;
    notes?: string;
  }): Promise<VaultPosition> {
    const tradingBotId = p.tradingBotId ?? null;
    const run = (attempt: number) => db.transaction(async (tx) => {
      const lockKey = this.vaultLockKey(p.walletAddress, tradingBotId, p.assetKey);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${778811}, ${lockKey})`);

      // Idempotency: on a retry, if this exact swap was already recorded, don't
      // double-apply (which would double the cost basis and duplicate the history
      // event) — return the current position unchanged.
      if (attempt > 1 && p.txSignature) {
        const already = (await tx.select({ id: equityEvents.id }).from(equityEvents)
          .where(and(eq(equityEvents.walletAddress, p.walletAddress), eq(equityEvents.eventType, 'vault_park'), eq(equityEvents.txSignature, p.txSignature)))
          .limit(1))[0];
        if (already) {
          const current = (await tx.select().from(vaultPositions)
            .where(and(eq(vaultPositions.walletAddress, p.walletAddress), this.vaultScopeCond(tradingBotId), eq(vaultPositions.assetKey, p.assetKey)))
            .limit(1))[0];
          if (current) return current;
        }
      }

      const existing = (await tx.select().from(vaultPositions)
        .where(and(eq(vaultPositions.walletAddress, p.walletAddress), this.vaultScopeCond(tradingBotId), eq(vaultPositions.assetKey, p.assetKey)))
        .limit(1))[0];

      const newTokens = (BigInt(existing?.tokenAmountRaw ?? '0') + BigInt(p.tokensReceivedRaw)).toString();
      const newBasis = new Decimal(existing?.usdcCostBasis ?? '0').plus(p.usdcSpent).toFixed(6);

      let row: VaultPosition;
      if (existing) {
        row = (await tx.update(vaultPositions)
          .set({ tokenAmountRaw: newTokens, usdcCostBasis: newBasis, mint: p.mint, status: 'active', updatedAt: new Date() })
          .where(eq(vaultPositions.id, existing.id))
          .returning())[0];
      } else {
        row = (await tx.insert(vaultPositions)
          .values({ walletAddress: p.walletAddress, tradingBotId, assetKey: p.assetKey, mint: p.mint, tokenAmountRaw: newTokens, usdcCostBasis: newBasis, status: 'active' })
          .returning())[0];
      }

      await tx.insert(equityEvents).values({
        walletAddress: p.walletAddress,
        tradingBotId,
        eventType: 'vault_park',
        amount: new Decimal(p.usdcSpent).toFixed(6),
        assetType: 'USDC',
        txSignature: p.txSignature ?? null,
        txBlockTime: p.txBlockTime ?? null,
        notes: p.notes ?? null,
      });

      return row;
    });
    return await this.withVaultWriteRetry(run, !!p.txSignature);
  }

  // Atomic: reduce parked tokens by the exact sold amount, remove a proportional
  // slice of cost basis (average cost), compute realized P/L, and record the swap
  // as a taxable equity event. Returns the updated row and the realized figures.
  async applyVaultUnpark(p: {
    walletAddress: string;
    tradingBotId?: string | null;
    assetKey: string;
    mint: string;
    tokensSoldRaw: string;
    usdcReceived: number;
    txSignature?: string;
    txBlockTime?: Date;
    notesPrefix?: string;
  }): Promise<{ position: VaultPosition; costBasisRemoved: number; realizedPnl: number }> {
    const tradingBotId = p.tradingBotId ?? null;
    const run = (attempt: number) => db.transaction(async (tx) => {
      const lockKey = this.vaultLockKey(p.walletAddress, tradingBotId, p.assetKey);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${778811}, ${lockKey})`);

      // Idempotency (see applyVaultPark + withVaultWriteRetry): a retry after a
      // lost commit-ack must not re-apply. If this swap was already recorded,
      // return the current position unchanged — the realized figures are already
      // persisted on the recorded event.
      if (attempt > 1 && p.txSignature) {
        const already = (await tx.select({ id: equityEvents.id }).from(equityEvents)
          .where(and(eq(equityEvents.walletAddress, p.walletAddress), eq(equityEvents.eventType, 'vault_unpark'), eq(equityEvents.txSignature, p.txSignature)))
          .limit(1))[0];
        if (already) {
          const current = (await tx.select().from(vaultPositions)
            .where(and(eq(vaultPositions.walletAddress, p.walletAddress), this.vaultScopeCond(tradingBotId), eq(vaultPositions.assetKey, p.assetKey)))
            .limit(1))[0];
          if (current) return { position: current, costBasisRemoved: 0, realizedPnl: 0 };
        }
      }

      const existing = (await tx.select().from(vaultPositions)
        .where(and(eq(vaultPositions.walletAddress, p.walletAddress), this.vaultScopeCond(tradingBotId), eq(vaultPositions.assetKey, p.assetKey)))
        .limit(1))[0];
      if (!existing) {
        // No recorded basis (e.g. tokens held on-chain with no DB row, or a prior
        // park whose DB write failed after a good swap). The swap already happened
        // on-chain, so we MUST still record the taxable event. Basis is unknown, so
        // realized P/L cannot be computed; report 0 and note it. We persist a closed
        // 0/0 row so the position is represented and the event is attached.
        const closedRow = (await tx.insert(vaultPositions).values({
          walletAddress: p.walletAddress,
          tradingBotId,
          assetKey: p.assetKey,
          mint: p.mint,
          tokenAmountRaw: '0',
          usdcCostBasis: '0',
          status: 'closed',
        }).returning())[0];

        const noBasisNotes = `${p.notesPrefix ? p.notesPrefix + ' ' : ''}cost basis unknown (no recorded basis), realized P/L not computed`;
        await tx.insert(equityEvents).values({
          walletAddress: p.walletAddress,
          tradingBotId,
          eventType: 'vault_unpark',
          amount: new Decimal(p.usdcReceived).toFixed(6),
          assetType: 'USDC',
          txSignature: p.txSignature ?? null,
          txBlockTime: p.txBlockTime ?? null,
          notes: noBasisNotes,
        });

        return { position: closedRow, costBasisRemoved: 0, realizedPnl: 0 };
      }

      const beforeTokens = BigInt(existing.tokenAmountRaw);
      let sold = BigInt(p.tokensSoldRaw);
      if (sold > beforeTokens) sold = beforeTokens; // clamp; on-chain balance is truth

      const beforeBasis = new Decimal(existing.usdcCostBasis);
      const costBasisRemoved = beforeTokens > BigInt(0)
        ? beforeBasis.mul(sold.toString()).div(beforeTokens.toString())
        : new Decimal(0);

      const newTokens = (beforeTokens - sold).toString();
      const fullyClosed = newTokens === '0';
      const newBasis = fullyClosed ? new Decimal(0) : Decimal.max(beforeBasis.minus(costBasisRemoved), 0);
      const realizedPnl = new Decimal(p.usdcReceived).minus(costBasisRemoved);

      const row = (await tx.update(vaultPositions)
        .set({
          tokenAmountRaw: newTokens,
          usdcCostBasis: newBasis.toFixed(6),
          status: fullyClosed ? 'closed' : 'active',
          mint: p.mint,
          updatedAt: new Date(),
        })
        .where(eq(vaultPositions.id, existing.id))
        .returning())[0];

      const notes = `${p.notesPrefix ? p.notesPrefix + ' ' : ''}cost basis removed ${costBasisRemoved.toFixed(6)} USDC, realized P/L ${realizedPnl.toFixed(6)} USDC`;
      await tx.insert(equityEvents).values({
        walletAddress: p.walletAddress,
        tradingBotId,
        eventType: 'vault_unpark',
        amount: new Decimal(p.usdcReceived).toFixed(6),
        assetType: 'USDC',
        txSignature: p.txSignature ?? null,
        txBlockTime: p.txBlockTime ?? null,
        notes,
      });

      return { position: row, costBasisRemoved: costBasisRemoved.toNumber(), realizedPnl: realizedPnl.toNumber() };
    });
    return await this.withVaultWriteRetry(run, !!p.txSignature);
  }

  // --- Phase 1 Vaults yield oracle (display-only price snapshots). ---
  async insertYieldPriceSnapshot(s: InsertYieldPriceSnapshot): Promise<YieldPriceSnapshot> {
    return (await db.insert(yieldPriceSnapshots).values(s).returning())[0];
  }

  // One asset's series at or after `since`, oldest first (drives trailing-window APY).
  async getYieldPriceSnapshots(assetKey: string, since: Date): Promise<YieldPriceSnapshot[]> {
    return await db.select().from(yieldPriceSnapshots)
      .where(and(eq(yieldPriceSnapshots.assetKey, assetKey), gte(yieldPriceSnapshots.asOf, since)))
      .orderBy(yieldPriceSnapshots.asOf);
  }

  // Bounded retention: drop snapshots older than the cutoff (cross-asset).
  async pruneYieldPriceSnapshots(olderThan: Date): Promise<void> {
    await db.delete(yieldPriceSnapshots).where(lt(yieldPriceSnapshots.asOf, olderThan));
  }

  // Vaults: persist the last-good external (DeFiLlama) APY for an asset. One row
  // per asset_key, upserted, with as_of bumped to now() so freshness is tracked.
  async upsertYieldApyCache(row: InsertYieldApyCache): Promise<void> {
    await db.insert(yieldApyCache).values(row).onConflictDoUpdate({
      target: yieldApyCache.assetKey,
      set: {
        apy: row.apy ?? null,
        apyBase: row.apyBase ?? null,
        apyReward: row.apyReward ?? null,
        apyMean30d: row.apyMean30d ?? null,
        source: row.source,
        poolId: row.poolId ?? null,
        asOf: new Date(),
      },
    });
  }

  // All cached external-APY rows (a handful), for the oracle's last-good fallback.
  async getYieldApyCacheAll(): Promise<YieldApyCache[]> {
    return await db.select().from(yieldApyCache);
  }

  // --- SOL Loop Vault P3: rate telemetry samples. ---
  async insertLoopRateSamples(rows: InsertLoopRateSample[]): Promise<void> {
    if (rows.length === 0) return;
    await db.insert(loopRateSamples).values(rows);
  }

  // Newest sample per vault id at or after `since`. DISTINCT ON keeps this one
  // SQL pass; the caller applies the staleness gate (rows older than its window
  // simply don't come back because of the `since` bound).
  async getLatestLoopRateSamples(since: Date): Promise<LoopRateSample[]> {
    return await db.selectDistinctOn([loopRateSamples.vaultId]).from(loopRateSamples)
      .where(gte(loopRateSamples.asOf, since))
      .orderBy(loopRateSamples.vaultId, desc(loopRateSamples.asOf));
  }

  // One vault's series at or after `since`, oldest first.
  async getLoopRateSamples(vaultId: number, since: Date): Promise<LoopRateSample[]> {
    return await db.select().from(loopRateSamples)
      .where(and(eq(loopRateSamples.vaultId, vaultId), gte(loopRateSamples.asOf, since)))
      .orderBy(loopRateSamples.asOf);
  }

  // Bounded retention: drop samples older than the cutoff (cross-vault).
  async pruneLoopRateSamples(olderThan: Date): Promise<void> {
    await db.delete(loopRateSamples).where(lt(loopRateSamples.asOf, olderThan));
  }

  // --- SOL Loop Vault P3: policy decision journal (append-only). ---
  async insertLoopPolicyDecision(d: InsertLoopPolicyDecision): Promise<LoopPolicyDecision> {
    const rows = await db.insert(loopPolicyDecisions).values(d).returning();
    return rows[0];
  }

  // Newest first, bounded. Hysteresis derives streaks from the last N rows.
  // Scope by borrowPositionId where possible — a position closed and re-opened
  // on the same vault must NEVER inherit the old position's streak rows.
  async getRecentLoopPolicyDecisions(opts: { walletAddress: string; vaultId: number; tick?: string; borrowPositionId?: string; limit: number }): Promise<LoopPolicyDecision[]> {
    const conds = [
      eq(loopPolicyDecisions.walletAddress, opts.walletAddress),
      eq(loopPolicyDecisions.vaultId, opts.vaultId),
      ...(opts.tick ? [eq(loopPolicyDecisions.tick, opts.tick)] : []),
      ...(opts.borrowPositionId ? [eq(loopPolicyDecisions.borrowPositionId, opts.borrowPositionId)] : []),
    ];
    return await db.select().from(loopPolicyDecisions)
      .where(and(...conds))
      .orderBy(desc(loopPolicyDecisions.createdAt))
      .limit(Math.max(1, Math.min(opts.limit, 500)));
  }

  // Bounded retention: decisions are telemetry/audit, not a ledger — prune old rows.
  async pruneLoopPolicyDecisions(olderThan: Date): Promise<void> {
    await db.delete(loopPolicyDecisions).where(lt(loopPolicyDecisions.createdAt, olderThan));
  }

  // T106 gate instrumentation: admin status view — ALL wallets, one window.
  async listLoopPolicyDecisionsSince(since: Date, limit: number): Promise<LoopPolicyDecision[]> {
    return await db.select().from(loopPolicyDecisions)
      .where(gte(loopPolicyDecisions.createdAt, since))
      .orderBy(desc(loopPolicyDecisions.createdAt))
      .limit(Math.max(1, Math.min(limit, 1000)));
  }

  // T106 gate instrumentation: tick heartbeats (fail-soft at every call site —
  // telemetry must never break a tick).
  async insertLoopTickHeartbeat(h: InsertLoopTickHeartbeat): Promise<void> {
    await db.insert(loopTickHeartbeats).values(h);
  }

  // Ascending by time so gap analysis is a single linear pass.
  async listLoopTickHeartbeatsSince(tick: string, since: Date): Promise<LoopTickHeartbeat[]> {
    return await db.select().from(loopTickHeartbeats)
      .where(and(eq(loopTickHeartbeats.tick, tick), gte(loopTickHeartbeats.createdAt, since)))
      .orderBy(asc(loopTickHeartbeats.createdAt))
      .limit(5000);
  }

  async pruneLoopTickHeartbeats(olderThan: Date): Promise<void> {
    await db.delete(loopTickHeartbeats).where(lt(loopTickHeartbeats.createdAt, olderThan));
  }

  async reconcileDeposit(walletAddress: string, botId: string, gap: number, onChainBalance: number): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const lockKey = Buffer.from(botId.slice(0, 8), 'hex').readInt32BE(0);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${893742}, ${lockKey})`);

      const events = await tx.select().from(equityEvents).where(eq(equityEvents.tradingBotId, botId));
      // Exclude internal Vault park/unpark reallocations — they are not deposits.
      const freshDeposited = sumNetDepositedFromEvents(events);
      const freshGap = onChainBalance - freshDeposited;

      if (freshGap <= 1.0) {
        return false;
      }

      console.log(`[Reconciliation] Bot ${botId}: on-chain=$${onChainBalance.toFixed(2)}, tracked=$${freshDeposited.toFixed(2)}, gap=$${freshGap.toFixed(2)} — inserting reconciliation event`);
      await tx.insert(equityEvents).values({
        walletAddress,
        tradingBotId: botId,
        eventType: 'drift_deposit',
        amount: String(freshGap),
        txSignature: null,
        notes: `Deposit reconciled from on-chain (untracked $${freshGap.toFixed(2)})`,
      });
      return true;
    });
  }

  async getEquityEvents(walletAddress: string, limit: number = 50): Promise<EquityEvent[]> {
    return db.select().from(equityEvents).where(eq(equityEvents.walletAddress, walletAddress)).orderBy(desc(equityEvents.createdAt)).limit(limit);
  }

  async getBotEquityEvents(tradingBotId: string, limit: number = 50): Promise<EquityEvent[]> {
    return db.select().from(equityEvents).where(eq(equityEvents.tradingBotId, tradingBotId)).orderBy(desc(equityEvents.createdAt)).limit(limit);
  }

  async getBotNetDeposited(tradingBotId: string): Promise<number> {
    const events = await db.select().from(equityEvents).where(eq(equityEvents.tradingBotId, tradingBotId));
    // Exclude internal Vault park/unpark reallocations — they are not deposits.
    return sumNetDepositedFromEvents(events);
  }

  async getWalletNetDeposited(walletAddress: string): Promise<number> {
    // Get all drift_deposit and drift_withdraw events for this wallet
    const events = await db.select().from(equityEvents)
      .where(eq(equityEvents.walletAddress, walletAddress));
    let netDeposited = 0;
    for (const event of events) {
      // Only count drift deposits/withdrawals (not agent wallet transfers)
      if (event.eventType === 'drift_deposit' || event.eventType === 'drift_withdraw') {
        const amount = parseFloat(event.amount);
        netDeposited += amount;
      }
    }
    return netDeposited;
  }

  async getBotPosition(tradingBotId: string, market: string): Promise<BotPosition | undefined> {
    const result = await db.select().from(botPositions)
      .where(and(eq(botPositions.tradingBotId, tradingBotId), eq(botPositions.market, market)))
      .limit(1);
    return result[0];
  }

  async getBotPositions(walletAddress: string): Promise<BotPosition[]> {
    return db.select().from(botPositions)
      .where(eq(botPositions.walletAddress, walletAddress))
      .orderBy(desc(botPositions.updatedAt));
  }

  async upsertBotPosition(position: InsertBotPosition): Promise<BotPosition> {
    const result = await db.insert(botPositions)
      .values(position)
      .onConflictDoUpdate({
        target: [botPositions.tradingBotId, botPositions.market],
        set: {
          baseSize: position.baseSize,
          avgEntryPrice: position.avgEntryPrice,
          costBasis: position.costBasis,
          realizedPnl: position.realizedPnl,
          totalFees: position.totalFees,
          lastTradeId: position.lastTradeId,
          lastTradeAt: position.lastTradeAt,
          updatedAt: sql`NOW()`,
        },
      })
      .returning();
    return result[0];
  }

  async updateBotPositionFromTrade(
    tradingBotId: string,
    market: string,
    walletAddress: string,
    side: string,
    size: number,
    price: number,
    fee: number,
    tradeId: string
  ): Promise<BotPosition> {
    const existing = await this.getBotPosition(tradingBotId, market);
    
    // Use Decimal.js for precise calculations (avoids floating point errors in trading)
    Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });
    
    let baseSize = new Decimal(existing?.baseSize || "0");
    let costBasis = new Decimal(existing?.costBasis || "0");
    let realizedPnl = new Decimal(existing?.realizedPnl || "0");
    let totalFees = new Decimal(existing?.totalFees || "0");

    const tradeSizeNum = new Decimal(size);
    const priceNum = new Decimal(price);
    const feeNum = new Decimal(fee);
    
    // Accumulate fees
    totalFees = totalFees.plus(feeNum);
    
    const isLong = side.toUpperCase() === 'LONG' || side.toUpperCase() === 'BUY';
    const tradeSize = isLong ? tradeSizeNum : tradeSizeNum.negated();
    const sameSide = (baseSize.gte(0) && tradeSize.gt(0)) || (baseSize.lte(0) && tradeSize.lt(0));

    if (sameSide || baseSize.isZero()) {
      // Adding to position - increase cost basis (includes fee to get accurate breakeven)
      costBasis = costBasis.plus(tradeSizeNum.abs().times(priceNum)).plus(feeNum);
      baseSize = baseSize.plus(tradeSize);
    } else {
      // Reducing or flipping position
      const closeSize = Decimal.min(baseSize.abs(), tradeSizeNum.abs());
      const avgEntry = baseSize.abs().gt(0) ? costBasis.div(baseSize.abs()) : new Decimal(0);
      
      // Prorate fee: only the portion for closed size affects realized PnL
      const closeFeeRatio = closeSize.div(tradeSizeNum.abs());
      const feeForClose = feeNum.times(closeFeeRatio);
      const feeForNewPosition = feeNum.minus(feeForClose);
      
      // Calculate realized PnL on closed portion (only close fee deducted)
      const closedPnl = baseSize.gt(0)
        ? priceNum.minus(avgEntry).times(closeSize).minus(feeForClose)
        : avgEntry.minus(priceNum).times(closeSize).minus(feeForClose);
      realizedPnl = realizedPnl.plus(closedPnl);
      
      // Reduce cost basis proportionally
      costBasis = costBasis.minus(closeSize.times(avgEntry));
      baseSize = baseSize.plus(tradeSize);
      
      // If we flipped sides, the excess starts a new position (with its portion of the fee)
      if (tradeSize.abs().gt(closeSize)) {
        const newSize = tradeSize.abs().minus(closeSize);
        costBasis = newSize.times(priceNum).plus(feeForNewPosition);
      }
    }

    const avgEntryPrice = baseSize.abs().gt(0) ? costBasis.div(baseSize.abs()) : new Decimal(0);

    return this.upsertBotPosition({
      tradingBotId,
      market,
      walletAddress,
      baseSize: baseSize.toFixed(8),
      avgEntryPrice: avgEntryPrice.toFixed(6),
      costBasis: costBasis.toFixed(6),
      realizedPnl: realizedPnl.toFixed(6),
      totalFees: totalFees.toFixed(6),
      lastTradeId: tradeId,
      lastTradeAt: new Date(),
    });
  }

  async getWalletsWithActiveBots(): Promise<string[]> {
    const result = await db.selectDistinct({ walletAddress: tradingBots.walletAddress })
      .from(tradingBots)
      .where(eq(tradingBots.isActive, true));
    return result.map(r => r.walletAddress);
  }

  async createOrphanedSubaccount(data: InsertOrphanedSubaccount): Promise<OrphanedSubaccount> {
    const result = await db.insert(orphanedSubaccounts).values(data).returning();
    return result[0];
  }

  async getOrphanedSubaccounts(): Promise<OrphanedSubaccount[]> {
    return db.select().from(orphanedSubaccounts).orderBy(desc(orphanedSubaccounts.createdAt));
  }

  async getOrphanedSubaccountsByWallet(walletAddress: string): Promise<OrphanedSubaccount[]> {
    return db.select().from(orphanedSubaccounts).where(eq(orphanedSubaccounts.walletAddress, walletAddress)).orderBy(desc(orphanedSubaccounts.createdAt));
  }

  async deleteOrphanedSubaccount(id: string): Promise<void> {
    await db.delete(orphanedSubaccounts).where(eq(orphanedSubaccounts.id, id));
  }

  async updateOrphanedSubaccountRetry(id: string): Promise<void> {
    await db.update(orphanedSubaccounts).set({
      retryCount: sql`${orphanedSubaccounts.retryCount} + 1`,
      lastRetryAt: sql`NOW()`,
    }).where(eq(orphanedSubaccounts.id, id));
  }

  // Marketplace: Published Bots
  async getPublishedBots(options?: { search?: string; market?: string; sortBy?: string; limit?: number }): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null }; activeProtocol: string | null })[]> {
    const conditions = [eq(publishedBots.isActive, true)];
    
    if (options?.market) {
      conditions.push(eq(publishedBots.market, options.market));
    }
    
    if (options?.search) {
      const searchTerm = `%${options.search}%`;
      conditions.push(
        or(
          ilike(publishedBots.name, searchTerm),
          ilike(publishedBots.market, searchTerm)
        )!
      );
    }

    let orderByColumn: any = desc(publishedBots.subscriberCount);
    if (options?.sortBy === 'pnl7d') {
      orderByColumn = desc(publishedBots.pnlPercent7d);
    } else if (options?.sortBy === 'pnl30d') {
      orderByColumn = desc(publishedBots.pnlPercent30d);
    } else if (options?.sortBy === 'pnl90d') {
      orderByColumn = desc(publishedBots.pnlPercent90d);
    } else if (options?.sortBy === 'pnlAllTime') {
      orderByColumn = desc(publishedBots.pnlPercentAllTime);
    } else if (options?.sortBy === 'subscribers') {
      orderByColumn = desc(publishedBots.subscriberCount);
    }

    const results = await db.select({
      publishedBot: publishedBots,
      displayName: wallets.displayName,
      xUsername: wallets.xUsername,
      activeProtocol: tradingBots.activeProtocol,
    })
    .from(publishedBots)
    .leftJoin(wallets, eq(publishedBots.creatorWalletAddress, wallets.address))
    .leftJoin(tradingBots, eq(publishedBots.tradingBotId, tradingBots.id))
    .where(and(...conditions))
    .orderBy(orderByColumn)
    .limit(options?.limit || 50);

    return results.map(r => ({
      ...r.publishedBot,
      activeProtocol: r.activeProtocol,
      creator: {
        displayName: r.displayName,
        xUsername: r.xUsername,
      },
    }));
  }

  async getPublishedBotsByCreator(walletAddress: string): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null } })[]> {
    const results = await db.select({
      publishedBot: publishedBots,
      displayName: wallets.displayName,
      xUsername: wallets.xUsername,
    })
    .from(publishedBots)
    .leftJoin(wallets, eq(publishedBots.creatorWalletAddress, wallets.address))
    .where(eq(publishedBots.creatorWalletAddress, walletAddress))
    .orderBy(desc(publishedBots.publishedAt));

    return results.map(r => ({
      ...r.publishedBot,
      creator: {
        displayName: r.displayName,
        xUsername: r.xUsername,
      },
    }));
  }

  async getPublishedBotById(id: string): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null } }) | undefined> {
    const results = await db.select({
      publishedBot: publishedBots,
      displayName: wallets.displayName,
      xUsername: wallets.xUsername,
    })
    .from(publishedBots)
    .leftJoin(wallets, eq(publishedBots.creatorWalletAddress, wallets.address))
    .where(eq(publishedBots.id, id))
    .limit(1);

    if (results.length === 0) return undefined;
    
    return {
      ...results[0].publishedBot,
      creator: {
        displayName: results[0].displayName,
        xUsername: results[0].xUsername,
      },
    };
  }

  async getPublishedBotByTradingBotId(tradingBotId: string): Promise<PublishedBot | undefined> {
    const result = await db.select().from(publishedBots).where(eq(publishedBots.tradingBotId, tradingBotId)).limit(1);
    return result[0];
  }

  async createPublishedBot(bot: InsertPublishedBot): Promise<PublishedBot> {
    const result = await db.insert(publishedBots).values(bot).returning();
    return result[0];
  }

  async updatePublishedBot(id: string, updates: Partial<InsertPublishedBot>): Promise<PublishedBot | undefined> {
    const result = await db.update(publishedBots).set({ ...updates, updatedAt: sql`NOW()` }).where(eq(publishedBots.id, id)).returning();
    return result[0];
  }

  async deletePublishedBot(id: string): Promise<void> {
    await db.delete(publishedBots).where(eq(publishedBots.id, id));
  }

  async incrementPublishedBotSubscribers(id: string, delta: number, capitalDelta: number): Promise<void> {
    await db.update(publishedBots).set({
      subscriberCount: sql`${publishedBots.subscriberCount} + ${delta}`,
      totalCapitalInvested: sql`${publishedBots.totalCapitalInvested} + ${capitalDelta}`,
      updatedAt: sql`NOW()`,
    }).where(eq(publishedBots.id, id));
  }

  async updatePublishedBotStats(id: string, stats: { 
    totalTrades: number; 
    winningTrades: number; 
    creatorCapital?: string;
    pnlPercent7d?: string; 
    pnlPercent30d?: string; 
    pnlPercent90d?: string; 
    pnlPercentAllTime?: string 
  }): Promise<void> {
    const updates: any = {
      totalTrades: stats.totalTrades,
      winningTrades: stats.winningTrades,
      pnlPercent7d: stats.pnlPercent7d,
      pnlPercent30d: stats.pnlPercent30d,
      pnlPercent90d: stats.pnlPercent90d,
      pnlPercentAllTime: stats.pnlPercentAllTime,
      updatedAt: sql`NOW()`,
    };
    if (stats.creatorCapital !== undefined) {
      updates.creatorCapital = stats.creatorCapital;
    }
    await db.update(publishedBots).set(updates).where(eq(publishedBots.id, id));
  }

  // Marketplace: Bot Subscriptions
  async getBotSubscription(publishedBotId: string, subscriberWalletAddress: string): Promise<BotSubscription | undefined> {
    const result = await db.select().from(botSubscriptions)
      .where(and(
        eq(botSubscriptions.publishedBotId, publishedBotId),
        eq(botSubscriptions.subscriberWalletAddress, subscriberWalletAddress)
      ))
      .limit(1);
    return result[0];
  }

  async getBotSubscriptionsByPublishedBot(publishedBotId: string): Promise<BotSubscription[]> {
    return db.select().from(botSubscriptions)
      .where(and(
        eq(botSubscriptions.publishedBotId, publishedBotId),
        eq(botSubscriptions.status, 'active')
      ))
      .orderBy(desc(botSubscriptions.subscribedAt));
  }

  async getBotSubscriptionsByWallet(walletAddress: string): Promise<(BotSubscription & { publishedBot: PublishedBot })[]> {
    const results = await db.select({
      subscription: botSubscriptions,
      publishedBot: publishedBots,
    })
    .from(botSubscriptions)
    .innerJoin(publishedBots, eq(botSubscriptions.publishedBotId, publishedBots.id))
    .where(and(
      eq(botSubscriptions.subscriberWalletAddress, walletAddress),
      // Exclude cancelled subscriptions so the UI doesn't treat an
      // unsubscribed bot as still subscribed. 'active' and 'paused' rows are
      // kept so the paused-state banner still renders.
      ne(botSubscriptions.status, 'cancelled'),
    ))
    .orderBy(desc(botSubscriptions.subscribedAt));

    return results.map(r => ({
      ...r.subscription,
      publishedBot: r.publishedBot,
    }));
  }

  async getBotSubscriptionBySubscriberBotId(botId: string): Promise<(BotSubscription & { publishedBot: PublishedBot }) | undefined> {
    const results = await db.select({
      subscription: botSubscriptions,
      publishedBot: publishedBots,
    })
    .from(botSubscriptions)
    .innerJoin(publishedBots, eq(botSubscriptions.publishedBotId, publishedBots.id))
    .where(and(
      eq(botSubscriptions.subscriberBotId, botId),
      eq(botSubscriptions.status, 'active')
    ))
    .limit(1);

    if (results.length === 0) return undefined;
    return { ...results[0].subscription, publishedBot: results[0].publishedBot };
  }

  async getSubscriberBotsBySourceId(publishedBotId: string): Promise<TradingBot[]> {
    // Join with bot_subscriptions to only return bots with active subscriptions
    // This ensures cancelled subscriptions don't receive signals
    const results = await db.select({ bot: tradingBots })
      .from(tradingBots)
      .innerJoin(botSubscriptions, and(
        eq(botSubscriptions.subscriberBotId, tradingBots.id),
        eq(botSubscriptions.publishedBotId, publishedBotId),
        eq(botSubscriptions.status, 'active')
      ))
      .where(eq(tradingBots.sourcePublishedBotId, publishedBotId))
      .orderBy(desc(tradingBots.createdAt));
    
    return results.map(r => r.bot);
  }

  async createBotSubscription(subscription: InsertBotSubscription): Promise<BotSubscription> {
    const result = await db.insert(botSubscriptions).values(subscription).returning();
    return result[0];
  }

  async updateBotSubscription(id: string, updates: Partial<InsertBotSubscription>): Promise<BotSubscription | undefined> {
    const result = await db.update(botSubscriptions).set(updates).where(eq(botSubscriptions.id, id)).returning();
    return result[0];
  }

  async cancelBotSubscription(id: string): Promise<void> {
    await db.update(botSubscriptions).set({
      status: 'cancelled',
      unsubscribedAt: sql`NOW()`,
    }).where(eq(botSubscriptions.id, id));
  }

  // Reactivate a previously cancelled/paused subscription row. The
  // (publishedBotId, subscriberWalletAddress) unique constraint means we cannot
  // INSERT a second row when re-subscribing, so the subscribe flow updates the
  // existing row in place instead. Clears the unsubscribed timestamp and any
  // pause reason and points it at the freshly-created subscriber bot.
  async reactivateBotSubscription(
    id: string,
    updates: { subscriberBotId: string; capitalInvested: string },
  ): Promise<BotSubscription | undefined> {
    const result = await db.update(botSubscriptions).set({
      status: 'active',
      subscriberBotId: updates.subscriberBotId,
      capitalInvested: updates.capitalInvested,
      subscriptionStatusReason: null,
      unsubscribedAt: null,
      subscribedAt: sql`NOW()`,
    }).where(eq(botSubscriptions.id, id)).returning();
    return result[0];
  }

  async markBotSubscriptionPausedBySubscriberBotId(
    subscriberBotId: string,
    reason: string,
  ): Promise<void> {
    // Look up subscription by subscriberBotId. Only flip 'active' rows so we
    // don't clobber already-cancelled subscriptions.
    await db
      .update(botSubscriptions)
      .set({ status: 'paused', subscriptionStatusReason: reason })
      .where(
        and(
          eq(botSubscriptions.subscriberBotId, subscriberBotId),
          eq(botSubscriptions.status, 'active'),
        ),
      );
  }

  // Marketplace: PnL Snapshots
  async createPnlSnapshot(snapshot: InsertPnlSnapshot): Promise<PnlSnapshot> {
    const result = await db.insert(pnlSnapshots).values(snapshot)
      .onConflictDoUpdate({
        target: [pnlSnapshots.tradingBotId, pnlSnapshots.snapshotDate],
        set: {
          equity: snapshot.equity,
          realizedPnl: snapshot.realizedPnl,
          unrealizedPnl: snapshot.unrealizedPnl,
          totalDeposited: snapshot.totalDeposited,
        },
      })
      .returning();
    return result[0];
  }

  async getPnlSnapshots(tradingBotId: string, since?: Date): Promise<PnlSnapshot[]> {
    const conditions = [eq(pnlSnapshots.tradingBotId, tradingBotId)];
    if (since) {
      conditions.push(gte(pnlSnapshots.snapshotDate, since));
    }
    return db.select().from(pnlSnapshots)
      .where(and(...conditions))
      .orderBy(desc(pnlSnapshots.snapshotDate));
  }

  async getLatestPnlSnapshot(tradingBotId: string): Promise<PnlSnapshot | undefined> {
    const result = await db.select().from(pnlSnapshots)
      .where(eq(pnlSnapshots.tradingBotId, tradingBotId))
      .orderBy(desc(pnlSnapshots.snapshotDate))
      .limit(1);
    return result[0];
  }

  // Marketplace: Public Equity Snapshots
  async createMarketplaceEquitySnapshot(snapshot: InsertMarketplaceEquitySnapshot): Promise<MarketplaceEquitySnapshot> {
    const result = await db.insert(marketplaceEquitySnapshots).values(snapshot)
      .onConflictDoUpdate({
        target: [marketplaceEquitySnapshots.publishedBotId, marketplaceEquitySnapshots.snapshotDate],
        set: {
          equity: snapshot.equity,
          pnlPercent: snapshot.pnlPercent,
        },
      })
      .returning();
    return result[0];
  }

  async getMarketplaceEquitySnapshots(publishedBotId: string, since?: Date): Promise<MarketplaceEquitySnapshot[]> {
    const conditions = [eq(marketplaceEquitySnapshots.publishedBotId, publishedBotId)];
    if (since) {
      conditions.push(gte(marketplaceEquitySnapshots.snapshotDate, since));
    }
    return db.select().from(marketplaceEquitySnapshots)
      .where(and(...conditions))
      .orderBy(desc(marketplaceEquitySnapshots.snapshotDate));
  }

  // Security v3: Wallet security updates
  async updateWalletSecurityV3(address: string, updates: {
    userSalt?: string;
    encryptedUserMasterKey?: string;
    encryptedMnemonicWords?: string;
    umkVersion?: number;
    executionEnabled?: boolean;
    umkEncryptedForExecution?: string;
    policyHmac?: string;
  }): Promise<Wallet | undefined> {
    const result = await db.update(wallets).set(updates).where(eq(wallets.address, address)).returning();
    return result[0];
  }

  async initWalletUmkIfAbsent(address: string, userSalt: string, encryptedUserMasterKey: string): Promise<boolean> {
    // Atomic first-writer-wins UMK init. This is an UPSERT (not a plain UPDATE)
    // because a brand-new wallet has NO row yet at /api/auth/verify time — the
    // nonce + signature-verify steps never create one. A plain UPDATE would
    // affect 0 rows for a first-time signup, the caller would read back no UMK,
    // and initializeWalletSecurity would throw "concurrent UMK init lost but DB
    // has no UMK" — bricking every new account.
    //
    // ON CONFLICT semantics preserve the original race guard:
    //   - row absent           -> INSERT          -> rowCount 1 -> won
    //   - row present, salt NULL-> DO UPDATE match -> rowCount 1 -> won
    //   - row present, salt set -> WHERE fails     -> rowCount 0 -> lost
    // Postgres serializes the conflict, so two concurrent first-time inserts
    // resolve to exactly one winner; the loser sees salt set and re-derives.
    const result = await db.execute(sql`
      INSERT INTO wallets (address, user_salt, encrypted_user_master_key, umk_version)
      VALUES (${address}, ${userSalt}, ${encryptedUserMasterKey}, 3)
      ON CONFLICT (address) DO UPDATE
         SET user_salt = EXCLUDED.user_salt,
             encrypted_user_master_key = EXCLUDED.encrypted_user_master_key,
             umk_version = 3
       WHERE wallets.user_salt IS NULL
    `);
    return (result.rowCount ?? 0) > 0;
  }

  // V3 Phase 0: UMK-at-rest re-keying progress monitor.
  // Group by umk_version so operators can confirm every initialized wallet
  // reaches v3 after the Phase 0 backfill window closes.
  async getUmkVersionDistribution(): Promise<Array<{ umkVersion: number; count: number }>> {
    const rows = await db.execute<{ umk_version: number; count: string }>(sql`
      SELECT umk_version, COUNT(*)::text AS count
        FROM wallets
       GROUP BY umk_version
       ORDER BY umk_version
    `);
    return rows.rows.map(r => ({ umkVersion: Number(r.umk_version), count: Number(r.count) }));
  }

  // V3 Phase 0: startup health-check input.
  // Returns true if at least one wallet row has umk_version >= 3. Once that's
  // true, UMK_STORAGE_SECRET MUST be configured or those users lose UMK access.
  async hasAnyUmkV3OrAbove(): Promise<boolean> {
    const rows = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM wallets WHERE umk_version >= 3) AS exists
    `);
    return Boolean(rows.rows[0]?.exists);
  }

  // Security v3: Execution authorization
  async updateWalletExecution(address: string, updates: {
    executionEnabled: boolean;
    umkEncryptedForExecution: string | null;
    executionExpiresAt: Date | null;
  }): Promise<Wallet | undefined> {
    const result = await db.update(wallets).set(updates).where(eq(wallets.address, address)).returning();
    return result[0];
  }

  // Security v3: resync ONLY the execution-wrapped UMK copy, and ONLY while
  // execution is still enabled. CAS on execution_enabled = true so a concurrent
  // revoke (which sets execution_enabled = false and nulls the copy) cannot be
  // clobbered back into an enabled state by a login-time resync — money paths
  // must fail closed. Returns true iff the row was updated (still enabled).
  async resyncWalletExecutionUmk(address: string, umkEncryptedForExecution: string): Promise<boolean> {
    const result = await db
      .update(wallets)
      .set({ umkEncryptedForExecution })
      .where(and(eq(wallets.address, address), eq(wallets.executionEnabled, true)))
      .returning({ address: wallets.address });
    return result.length > 0;
  }

  // Phase 4b: atomically clear the wallet's execution authorization AND pause
  // every active trading bot the wallet owns. Wrapped in a single transaction
  // so we cannot end up in a state where execution is cleared but bots are
  // still marked active (which would cause webhook failures the user can't see).
  async atomicRevokeExecutionAndPauseBots(
    walletAddress: string,
    pauseReason: string,
  ): Promise<{ id: string; name: string }[]> {
    return await db.transaction(async (tx) => {
      await tx
        .update(wallets)
        .set({
          executionEnabled: false,
          umkEncryptedForExecution: null,
          executionExpiresAt: null,
        })
        .where(eq(wallets.address, walletAddress));

      const paused = await tx
        .update(tradingBots)
        .set({
          isActive: false,
          pauseReason,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(tradingBots.walletAddress, walletAddress),
            eq(tradingBots.isActive, true),
          ),
        )
        .returning({ id: tradingBots.id, name: tradingBots.name });

      return paused;
    });
  }

  // Security v3: Emergency stop
  async updateWalletEmergencyStop(address: string, updates: {
    executionEnabled: boolean;
    umkEncryptedForExecution: string | null;
    executionExpiresAt: Date | null;
    emergencyStopTriggered: boolean;
    emergencyStopAt: Date;
    emergencyStopBy: string;
  }): Promise<Wallet | undefined> {
    const result = await db.update(wallets).set(updates).where(eq(wallets.address, address)).returning();
    return result[0];
  }

  // Security v3: Auth nonces for signature verification
  async createAuthNonce(nonce: InsertAuthNonce): Promise<AuthNonce> {
    const result = await db.insert(authNonces).values(nonce).returning();
    return result[0];
  }

  async getAuthNonceByHash(nonceHash: string): Promise<AuthNonce | undefined> {
    const result = await db.select().from(authNonces)
      .where(eq(authNonces.nonceHash, nonceHash))
      .limit(1);
    return result[0];
  }

  async markNonceUsed(id: string): Promise<void> {
    await db.update(authNonces).set({ usedAt: sql`NOW()` }).where(eq(authNonces.id, id));
  }

  async cleanupExpiredNonces(): Promise<number> {
    const result = await db.delete(authNonces)
      .where(lte(authNonces.expiresAt, sql`NOW()`))
      .returning();
    return result.length;
  }

  // Telegram connection tokens
  async createTelegramConnectionToken(token: InsertTelegramConnectionToken): Promise<TelegramConnectionToken> {
    const result = await db.insert(telegramConnectionTokens).values(token).returning();
    return result[0];
  }

  async getTelegramConnectionTokenByToken(token: string): Promise<TelegramConnectionToken | undefined> {
    const result = await db.select().from(telegramConnectionTokens)
      .where(eq(telegramConnectionTokens.token, token))
      .limit(1);
    return result[0];
  }

  async deleteTelegramConnectionToken(id: string): Promise<void> {
    await db.delete(telegramConnectionTokens).where(eq(telegramConnectionTokens.id, id));
  }

  async deleteExpiredTelegramTokens(): Promise<number> {
    const result = await db.delete(telegramConnectionTokens)
      .where(lte(telegramConnectionTokens.expiresAt, sql`NOW()`))
      .returning();
    return result.length;
  }

  async getWalletByTelegramChatId(chatId: string): Promise<Wallet | undefined> {
    const result = await db.select().from(wallets)
      .where(eq(wallets.telegramChatId, chatId))
      .limit(1);
    return result[0];
  }

  async getWalletsByTelegramChatId(chatId: string): Promise<Wallet[]> {
    return db.select().from(wallets)
      .where(eq(wallets.telegramChatId, chatId));
  }

  // Trade retry queue - persists failed trades for retry across server restarts
  async createTradeRetryJob(job: InsertTradeRetryQueue): Promise<TradeRetryQueue> {
    const result = await db.insert(tradeRetryQueue).values(job).returning();
    return result[0];
  }

  async getTradeRetryJobById(id: string): Promise<TradeRetryQueue | undefined> {
    const result = await db.select().from(tradeRetryQueue)
      .where(eq(tradeRetryQueue.id, id))
      .limit(1);
    return result[0];
  }

  async getPendingTradeRetryJobs(): Promise<TradeRetryQueue[]> {
    return db.select().from(tradeRetryQueue)
      .where(eq(tradeRetryQueue.status, 'pending'))
      .orderBy(tradeRetryQueue.nextRetryAt);
  }

  async updateTradeRetryJob(id: string, updates: Partial<InsertTradeRetryQueue>): Promise<TradeRetryQueue | undefined> {
    const result = await db.update(tradeRetryQueue)
      .set(updates)
      .where(eq(tradeRetryQueue.id, id))
      .returning();
    return result[0];
  }

  async deleteTradeRetryJob(id: string): Promise<void> {
    await db.delete(tradeRetryQueue).where(eq(tradeRetryQueue.id, id));
  }

  async markTradeRetryJobFailed(id: string, error: string): Promise<void> {
    await db.update(tradeRetryQueue)
      .set({ status: 'failed', lastError: error })
      .where(eq(tradeRetryQueue.id, id));
  }

  async markTradeRetryJobCompleted(id: string): Promise<void> {
    await db.update(tradeRetryQueue)
      .set({ status: 'completed' })
      .where(eq(tradeRetryQueue.id, id));
  }

  async cleanupCompletedRetryJobs(): Promise<number> {
    const result = await db.delete(tradeRetryQueue)
      .where(or(
        eq(tradeRetryQueue.status, 'completed'),
        eq(tradeRetryQueue.status, 'failed')
      ))
      .returning();
    return result.length;
  }

  // Platform Analytics
  async upsertPlatformMetric(metricType: PlatformMetricType, value: number, metadata?: Record<string, unknown>): Promise<PlatformMetric> {
    const now = new Date();
    const isCumulative = metricType === 'total_volume' || metricType === 'total_trades';

    if (isCumulative) {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${metricType}))`);

        const prev = await tx.select({ value: platformMetrics.value })
          .from(platformMetrics)
          .where(eq(platformMetrics.metricType, metricType))
          .orderBy(desc(platformMetrics.calculatedAt))
          .limit(1);
        const prevValue = prev.length > 0 ? parseFloat(prev[0].value) : 0;
        const finalValue = Math.max(value, prevValue);

        const result = await tx.insert(platformMetrics).values({
          metricType,
          value: finalValue.toString(),
          metadata: metadata ?? null,
          calculatedAt: now,
        }).returning();
        return result[0];
      });
    }
    
    const result = await db.insert(platformMetrics).values({
      metricType,
      value: value.toString(),
      metadata: metadata ?? null,
      calculatedAt: now,
    }).returning();
    return result[0];
  }
  
  async cleanupOldMetrics(retentionDays: number = 30): Promise<number> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await db.delete(platformMetrics)
      .where(lte(platformMetrics.calculatedAt, cutoffDate))
      .returning();
    return result.length;
  }

  async getLatestPlatformMetric(metricType: PlatformMetricType): Promise<PlatformMetric | undefined> {
    const result = await db.select().from(platformMetrics)
      .where(eq(platformMetrics.metricType, metricType))
      .orderBy(desc(platformMetrics.calculatedAt))
      .limit(1);
    return result[0];
  }

  async getLatestPlatformMetrics(): Promise<PlatformMetric[]> {
    const metricTypes: PlatformMetricType[] = [
      'tvl', 'total_volume', 'total_trades', 'active_bots', 'active_users', 'volume_24h', 'volume_7d'
    ];
    
    const results: PlatformMetric[] = [];
    for (const metricType of metricTypes) {
      const metric = await this.getLatestPlatformMetric(metricType);
      if (metric) results.push(metric);
    }
    return results;
  }

  async getPlatformMetricHistory(metricType: PlatformMetricType, since?: Date, limit?: number): Promise<PlatformMetric[]> {
    let query = db.select().from(platformMetrics)
      .where(eq(platformMetrics.metricType, metricType))
      .orderBy(desc(platformMetrics.calculatedAt));
    
    if (since) {
      query = db.select().from(platformMetrics)
        .where(and(
          eq(platformMetrics.metricType, metricType),
          gte(platformMetrics.calculatedAt, since)
        ))
        .orderBy(desc(platformMetrics.calculatedAt));
    }
    
    if (limit) {
      return query.limit(limit);
    }
    return query;
  }

  async calculatePlatformTVL(): Promise<number> {
    // Sum the most recent portfolio snapshot balance per wallet.
    // This captures both deployed capital (exchange accounts) and
    // uninvested capital sitting in agent wallets, giving a true TVL.
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(latest.total_balance), 0) AS tvl
      FROM (
        SELECT DISTINCT ON (wallet_address) total_balance
        FROM portfolio_daily_snapshots
        ORDER BY wallet_address, created_at DESC
      ) latest
    `);
    const row = (result as any).rows?.[0] ?? (result as any)[0];
    return parseFloat(row?.tvl ?? '0');
  }
  
  async getAllAgentWalletAddresses(): Promise<string[]> {
    const result = await db.select({
      agentPublicKey: wallets.agentPublicKey,
    }).from(wallets)
      .where(sql`${wallets.agentPublicKey} IS NOT NULL`);
    
    return result
      .map(r => r.agentPublicKey)
      .filter((addr): addr is string => addr !== null);
  }

  async calculatePlatformVolume(): Promise<{ total: number; volume24h: number; volume7d: number }> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const allBots = await db.select({
      stats: tradingBots.stats,
    }).from(tradingBots);
    
    let totalVolume = 0;
    for (const bot of allBots) {
      const stats = bot.stats as { totalVolume?: number } | null;
      totalVolume += stats?.totalVolume || 0;
    }
    
    const trades24h = await db.select({
      volume: sql<string>`COALESCE(SUM(ABS(CAST(size AS DECIMAL) * CAST(price AS DECIMAL))), 0)`,
    }).from(botTrades)
      .where(and(
        eq(botTrades.status, 'executed'),
        gte(botTrades.executedAt, oneDayAgo)
      ));
    
    const trades7d = await db.select({
      volume: sql<string>`COALESCE(SUM(ABS(CAST(size AS DECIMAL) * CAST(price AS DECIMAL))), 0)`,
    }).from(botTrades)
      .where(and(
        eq(botTrades.status, 'executed'),
        gte(botTrades.executedAt, sevenDaysAgo)
      ));
    
    return {
      total: totalVolume,
      volume24h: parseFloat(trades24h[0]?.volume || '0'),
      volume7d: parseFloat(trades7d[0]?.volume || '0'),
    };
  }

  async calculatePlatformStats(): Promise<{ activeBots: number; activeUsers: number; totalTrades: number }> {
    const activeBots = await db.select({
      count: sql<string>`COUNT(*)`,
    }).from(tradingBots)
      .where(eq(tradingBots.isActive, true));
    
    const activeUsers = await db.select({
      count: sql<string>`COUNT(DISTINCT wallet_address)`,
    }).from(tradingBots)
      .where(eq(tradingBots.isActive, true));
    
    const totalTrades = await db.select({
      count: sql<string>`COUNT(*)`,
    }).from(botTrades)
      .where(eq(botTrades.status, 'executed'));
    
    return {
      activeBots: parseInt(activeBots[0]?.count || '0'),
      activeUsers: parseInt(activeUsers[0]?.count || '0'),
      totalTrades: parseInt(totalTrades[0]?.count || '0'),
    };
  }

  private static readonly CUMULATIVE_STATS_SINGLETON_ID = 'singleton';

  async getCumulativeStats(): Promise<PlatformCumulativeStats | undefined> {
    const result = await db.select().from(platformCumulativeStats)
      .where(eq(platformCumulativeStats.id, DatabaseStorage.CUMULATIVE_STATS_SINGLETON_ID))
      .limit(1);
    return result[0];
  }

  async incrementCumulativeStats(volumeDelta: number, tradesDelta: number): Promise<void> {
    await db.insert(platformCumulativeStats).values({
      id: DatabaseStorage.CUMULATIVE_STATS_SINGLETON_ID,
      totalVolume: volumeDelta.toString(),
      totalTrades: tradesDelta,
    }).onConflictDoUpdate({
      target: platformCumulativeStats.id,
      set: {
        totalVolume: sql`CAST(${platformCumulativeStats.totalVolume} AS DECIMAL) + ${volumeDelta}`,
        totalTrades: sql`${platformCumulativeStats.totalTrades} + ${tradesDelta}`,
        updatedAt: sql`NOW()`,
      },
    });
  }

  async seedCumulativeStats(volume: number, trades: number): Promise<void> {
    await db.insert(platformCumulativeStats).values({
      id: DatabaseStorage.CUMULATIVE_STATS_SINGLETON_ID,
      totalVolume: volume.toString(),
      totalTrades: trades,
    }).onConflictDoUpdate({
      target: platformCumulativeStats.id,
      set: {
        totalVolume: sql`GREATEST(CAST(${platformCumulativeStats.totalVolume} AS DECIMAL), ${volume})`,
        totalTrades: sql`GREATEST(${platformCumulativeStats.totalTrades}, ${trades})`,
        updatedAt: sql`NOW()`,
      },
    });
  }

  async snapshotBotStatsBeforeDeletion(botId: string): Promise<void> {
    const bot = await this.getTradingBotById(botId);
    if (!bot) return;

    const allBots = await db.select({ stats: tradingBots.stats }).from(tradingBots);
    let liveVolume = 0;
    for (const b of allBots) {
      const s = b.stats as { totalVolume?: number } | null;
      liveVolume += s?.totalVolume || 0;
    }
    const liveTrades = await db.select({ count: sql<string>`COUNT(*)` })
      .from(botTrades).where(eq(botTrades.status, 'executed'));
    const liveTradeCount = parseInt(liveTrades[0]?.count || '0');

    await this.seedCumulativeStats(liveVolume, liveTradeCount);
    console.log(`[CumulativeStats] Ensured ledger >= live totals before deleting bot ${botId}: volume=$${liveVolume.toFixed(2)}, trades=${liveTradeCount}`);
  }

  // Profit Sharing: IOU records for failed profit share transfers
  async createPendingProfitShare(data: InsertPendingProfitShare): Promise<PendingProfitShare> {
    const result = await db.insert(pendingProfitShares).values(data)
      .onConflictDoNothing({ target: [pendingProfitShares.subscriberBotId, pendingProfitShares.tradeId] })
      .returning();
    if (result.length === 0) {
      const existing = await db.select().from(pendingProfitShares)
        .where(and(
          eq(pendingProfitShares.subscriberBotId, data.subscriberBotId),
          eq(pendingProfitShares.tradeId, data.tradeId)
        ))
        .limit(1);
      return existing[0];
    }
    return result[0];
  }

  async getPendingProfitSharesBySubscriber(subscriberWalletAddress: string): Promise<PendingProfitShare[]> {
    return db.select().from(pendingProfitShares)
      .where(and(
        eq(pendingProfitShares.subscriberWalletAddress, subscriberWalletAddress),
        eq(pendingProfitShares.status, 'pending')
      ))
      .orderBy(desc(pendingProfitShares.createdAt));
  }

  async getPendingProfitSharesByBot(subscriberBotId: string): Promise<PendingProfitShare[]> {
    // Include both 'pending' and 'processing' to prevent hostage escape during retry
    return db.select().from(pendingProfitShares)
      .where(and(
        eq(pendingProfitShares.subscriberBotId, subscriberBotId),
        or(
          eq(pendingProfitShares.status, 'pending'),
          eq(pendingProfitShares.status, 'processing')
        )
      ))
      .orderBy(desc(pendingProfitShares.createdAt));
  }
  
  // Alias for routes.ts compatibility
  async getPendingProfitSharesBySubscriberBot(subscriberBotId: string): Promise<PendingProfitShare[]> {
    return this.getPendingProfitSharesByBot(subscriberBotId);
  }

  // Every still-owed creator share for a bot: 'pending'/'processing' (immediate-payout
  // retries in flight) PLUS 'deferred' (accumulate+claim venues like Pacifica whose
  // per-trade payout is uneconomical). Used by teardown paths (unsubscribe/delete) so a
  // departing subscriber settles the full liability — the immediate-payout retry job
  // deliberately ignores 'deferred' and would otherwise never pay these.
  async getUnsettledProfitSharesByBot(subscriberBotId: string): Promise<PendingProfitShare[]> {
    return db.select().from(pendingProfitShares)
      .where(and(
        eq(pendingProfitShares.subscriberBotId, subscriberBotId),
        or(
          eq(pendingProfitShares.status, 'pending'),
          eq(pendingProfitShares.status, 'processing'),
          eq(pendingProfitShares.status, 'deferred')
        )
      ))
      .orderBy(desc(pendingProfitShares.createdAt));
  }
  
  async getPendingProfitSharesProcessing(): Promise<PendingProfitShare[]> {
    return db.select().from(pendingProfitShares)
      .where(eq(pendingProfitShares.status, 'processing'))
      .orderBy(pendingProfitShares.createdAt);
  }

  async getAllPendingProfitShares(): Promise<PendingProfitShare[]> {
    return db.select().from(pendingProfitShares)
      .where(eq(pendingProfitShares.status, 'pending'))
      .orderBy(pendingProfitShares.createdAt);
  }

  async updatePendingProfitShareStatus(
    id: string, 
    updates: { status?: string; retryCount?: number; lastError?: string | null; lastAttemptAt?: Date }
  ): Promise<PendingProfitShare | undefined> {
    const result = await db.update(pendingProfitShares)
      .set(updates)
      .where(eq(pendingProfitShares.id, id))
      .returning();
    return result[0];
  }

  async deletePendingProfitShare(id: string): Promise<void> {
    await db.delete(pendingProfitShares).where(eq(pendingProfitShares.id, id));
  }

  async upsertPortfolioDailySnapshot(snapshot: InsertPortfolioDailySnapshot): Promise<PortfolioDailySnapshot> {
    const result = await db.insert(portfolioDailySnapshots).values(snapshot)
      .onConflictDoUpdate({
        target: [portfolioDailySnapshots.walletAddress, portfolioDailySnapshots.snapshotDate],
        set: {
          totalBalance: snapshot.totalBalance,
          cumulativeDeposits: snapshot.cumulativeDeposits,
          cumulativeWithdrawals: snapshot.cumulativeWithdrawals,
          netPnl: snapshot.netPnl,
          activeBotCount: snapshot.activeBotCount,
          totalTrades: snapshot.totalTrades,
          totalVolume: snapshot.totalVolume,
          creatorEarnings: snapshot.creatorEarnings,
          cumulativeExternalDeposits: snapshot.cumulativeExternalDeposits,
          cumulativeExternalWithdrawals: snapshot.cumulativeExternalWithdrawals,
          cumulativeInternalTransfers: snapshot.cumulativeInternalTransfers,
          cumulativeTradingPnl: snapshot.cumulativeTradingPnl,
          netExternalFlow: snapshot.netExternalFlow,
          pnlPercent: snapshot.pnlPercent,
        }
      })
      .returning();
    return result[0];
  }

  async getPortfolioDailySnapshots(walletAddress: string, since?: Date): Promise<PortfolioDailySnapshot[]> {
    const conditions = [eq(portfolioDailySnapshots.walletAddress, walletAddress)];
    if (since) {
      conditions.push(gte(portfolioDailySnapshots.snapshotDate, since));
    }
    return db.select().from(portfolioDailySnapshots)
      .where(and(...conditions))
      .orderBy(portfolioDailySnapshots.snapshotDate);
  }

  async getPortfolioDailySnapshotsBatch(
    walletAddresses: string[],
    since?: Date,
  ): Promise<Map<string, PortfolioDailySnapshot[]>> {
    const out = new Map<string, PortfolioDailySnapshot[]>();
    if (walletAddresses.length === 0) return out;
    const conditions = [inArray(portfolioDailySnapshots.walletAddress, walletAddresses)];
    if (since) {
      conditions.push(gte(portfolioDailySnapshots.snapshotDate, since));
    }
    const rows = await db.select().from(portfolioDailySnapshots)
      .where(and(...conditions))
      .orderBy(portfolioDailySnapshots.snapshotDate);
    for (const addr of walletAddresses) out.set(addr, []);
    for (const row of rows) {
      const arr = out.get(row.walletAddress);
      if (arr) arr.push(row);
    }
    return out;
  }

  async getEarliestPortfolioSnapshotDates(walletAddresses: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (walletAddresses.length === 0) return out;
    const rows = await db
      .select({
        walletAddress: portfolioDailySnapshots.walletAddress,
        earliest: sql<Date>`MIN(${portfolioDailySnapshots.snapshotDate})`,
      })
      .from(portfolioDailySnapshots)
      .where(inArray(portfolioDailySnapshots.walletAddress, walletAddresses))
      .groupBy(portfolioDailySnapshots.walletAddress);
    for (const r of rows) {
      if (r.earliest) out.set(r.walletAddress, r.earliest instanceof Date ? r.earliest : new Date(r.earliest as any));
    }
    return out;
  }

  async getLatestPortfolioDailySnapshot(walletAddress: string): Promise<PortfolioDailySnapshot | undefined> {
    const result = await db.select().from(portfolioDailySnapshots)
      .where(eq(portfolioDailySnapshots.walletAddress, walletAddress))
      .orderBy(desc(portfolioDailySnapshots.snapshotDate))
      .limit(1);
    return result[0];
  }

  async getWalletCumulativeDepositsWithdrawals(
    walletAddress: string,
    asOf?: Date,
  ): Promise<{ deposits: number; withdrawals: number; internalTransfers: number }> {
    const events = await db.select().from(equityEvents)
      .where(eq(equityEvents.walletAddress, walletAddress));

    let deposits = 0;
    let withdrawals = 0;
    let internalTransfers = 0;

    const { classifyEquityEvent } = await import('./equity-event-classifier');

    for (const event of events) {
      // Use on-chain block time when available — critical so the deposit
      // reconciler backfilling a deposit weeks later still attributes it to
      // when it actually happened on-chain, not when we discovered it.
      const eventTime = event.txBlockTime ?? event.createdAt;
      if (asOf && eventTime > asOf) continue;

      const amount = parseFloat(event.amount);
      const category = classifyEquityEvent(event);
      if (category === 'external_deposit') {
        deposits += Math.abs(amount);
      } else if (category === 'external_withdraw') {
        withdrawals += Math.abs(amount);
      } else if (category === 'internal_transfer') {
        internalTransfers += Math.abs(amount);
      }
    }

    return { deposits, withdrawals, internalTransfers };
  }

  async getWalletExternalFlows(
    walletAddress: string,
    asOf?: Date,
  ): Promise<Array<{ time: Date; amount: number }>> {
    const events = await db.select().from(equityEvents)
      .where(eq(equityEvents.walletAddress, walletAddress));
    const { classifyEquityEvent } = await import('./equity-event-classifier');
    const out: Array<{ time: Date; amount: number }> = [];
    for (const event of events) {
      const eventTime = event.txBlockTime ?? event.createdAt;
      if (asOf && eventTime > asOf) continue;
      const category = classifyEquityEvent(event);
      const amount = Math.abs(parseFloat(event.amount));
      if (category === 'external_deposit') {
        out.push({ time: eventTime, amount });
      } else if (category === 'external_withdraw') {
        out.push({ time: eventTime, amount: -amount });
      }
    }
    out.sort((a, b) => a.time.getTime() - b.time.getTime());
    return out;
  }

  async getWalletTradeStats(walletAddress: string): Promise<{ totalTrades: number; totalVolume: number }> {
    const bots = await this.getTradingBots(walletAddress);
    let totalTrades = 0;
    let totalVolume = 0;

    for (const bot of bots) {
      const counts = await this.getCanonicalBotTradeStats(bot.id);
      totalTrades += counts.totalTrades;
      const stats = bot.stats as any;
      if (stats) {
        totalVolume += Number(stats.totalVolume) || 0;
      }
    }

    return { totalTrades, totalVolume };
  }

  async getWalletCreatorEarnings(walletAddress: string): Promise<number> {
    const paidShares = await db.select().from(pendingProfitShares)
      .where(and(
        eq(pendingProfitShares.creatorWalletAddress, walletAddress),
        eq(pendingProfitShares.status, 'paid')
      ));
    
    let totalEarnings = 0;
    for (const share of paidShares) {
      totalEarnings += parseFloat(share.amount);
    }
    
    return totalEarnings;
  }

  async getPublishedBotEarnings(publishedBotId: string): Promise<number> {
    const paidShares = await db.select().from(pendingProfitShares)
      .where(and(
        eq(pendingProfitShares.publishedBotId, publishedBotId),
        eq(pendingProfitShares.status, 'paid')
      ));
    
    let totalEarnings = 0;
    for (const share of paidShares) {
      totalEarnings += parseFloat(share.amount);
    }
    
    return totalEarnings;
  }

  async getWalletsWithTradingBots(): Promise<string[]> {
    const result = await db.selectDistinct({ walletAddress: tradingBots.walletAddress })
      .from(tradingBots);
    return result.map(r => r.walletAddress);
  }

  async getWalletFirstDepositDate(walletAddress: string): Promise<Date | null> {
    const result = await db.select({ createdAt: equityEvents.createdAt })
      .from(equityEvents)
      .where(and(
        eq(equityEvents.walletAddress, walletAddress),
        eq(equityEvents.eventType, 'agent_deposit')
      ))
      .orderBy(equityEvents.createdAt)
      .limit(1);
    
    return result[0]?.createdAt || null;
  }

  // MLM Referral chain & rewards
  async getReferralChain(descendantWallet: string): Promise<ReferralLink[]> {
    return db.select().from(referralLinks)
      .where(eq(referralLinks.descendantWallet, descendantWallet))
      .orderBy(referralLinks.level);
  }

  async createReferralLinks(links: InsertReferralLink[]): Promise<void> {
    if (links.length === 0) return;
    await db.insert(referralLinks).values(links).onConflictDoNothing();
  }

  async getReferralDescendantsByLevel(ancestorWallet: string, level: number): Promise<{ descendantWallet: string; createdAt: Date }[]> {
    const rows = await db.select({
      descendantWallet: referralLinks.descendantWallet,
      createdAt: referralLinks.createdAt,
    }).from(referralLinks)
      .where(and(eq(referralLinks.ancestorWallet, ancestorWallet), eq(referralLinks.level, level)))
      .orderBy(desc(referralLinks.createdAt));
    return rows;
  }

  async insertReferralRewardEvent(event: InsertReferralRewardEvent): Promise<ReferralRewardEvent | null> {
    const result = await db.insert(referralRewardEvents).values(event).onConflictDoNothing().returning();
    return result[0] ?? null;
  }

  async upsertReferralRewardEventPending(event: InsertReferralRewardEvent): Promise<ReferralRewardEvent> {
    const inserted = await db.insert(referralRewardEvents).values(event).onConflictDoNothing().returning();
    if (inserted[0]) return inserted[0];
    const existing = await db.select().from(referralRewardEvents)
      .where(and(
        eq(referralRewardEvents.sourceType, event.sourceType),
        eq(referralRewardEvents.sourceId, event.sourceId),
        eq(referralRewardEvents.earnerWallet, event.earnerWallet),
        eq(referralRewardEvents.level, event.level),
      ))
      .limit(1);
    if (!existing[0]) {
      throw new Error(`upsertReferralRewardEventPending: row vanished after conflict for source=${event.sourceType}:${event.sourceId} earner=${event.earnerWallet} L${event.level}`);
    }
    return existing[0];
  }

  async updateReferralRewardEventStatus(
    id: string,
    patch: { status?: string; transferSignature?: string | null; lastError?: string | null; retryCount?: number; lastAttemptAt?: Date | null }
  ): Promise<void> {
    const update: Record<string, any> = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.transferSignature !== undefined) update.transferSignature = patch.transferSignature;
    if (patch.lastError !== undefined) update.lastError = patch.lastError;
    if (patch.retryCount !== undefined) update.retryCount = patch.retryCount;
    if (patch.lastAttemptAt !== undefined) update.lastAttemptAt = patch.lastAttemptAt;
    if (Object.keys(update).length === 0) return;
    await db.update(referralRewardEvents).set(update).where(eq(referralRewardEvents.id, id));
  }

  async claimReferralRewardEventForProcessing(id: string, expectedStatus: string[]): Promise<boolean> {
    // Atomic compare-and-set: only one worker can transition a row from
    // pending/failed -> processing. Returns true if this caller won the claim.
    const result = await db.update(referralRewardEvents)
      .set({ status: 'processing', lastAttemptAt: new Date() })
      .where(and(
        eq(referralRewardEvents.id, id),
        inArray(referralRewardEvents.status, expectedStatus),
      ))
      .returning({ id: referralRewardEvents.id });
    return result.length > 0;
  }

  async getPendingReferralRewardEvents(): Promise<ReferralRewardEvent[]> {
    return db.select().from(referralRewardEvents)
      .where(or(
        eq(referralRewardEvents.status, 'pending'),
        eq(referralRewardEvents.status, 'failed'),
      ))
      .orderBy(referralRewardEvents.createdAt);
  }

  async getProcessingReferralRewardEvents(): Promise<ReferralRewardEvent[]> {
    return db.select().from(referralRewardEvents)
      .where(eq(referralRewardEvents.status, 'processing'))
      .orderBy(referralRewardEvents.createdAt);
  }

  async getReferralEarnings(earnerWallet: string): Promise<{ l1: number; l2: number; l3: number; total: number }> {
    const rows = await db.select({
      level: referralRewardEvents.level,
      sum: sql<string>`COALESCE(SUM(${referralRewardEvents.amountUsdc}), 0)`,
    }).from(referralRewardEvents)
      .where(and(
        eq(referralRewardEvents.earnerWallet, earnerWallet),
        inArray(referralRewardEvents.status, ['paid', 'confirmed']),
      ))
      .groupBy(referralRewardEvents.level);

    const out = { l1: 0, l2: 0, l3: 0, total: 0 };
    for (const r of rows) {
      const v = parseFloat(r.sum) || 0;
      if (r.level === 1) out.l1 = v;
      else if (r.level === 2) out.l2 = v;
      else if (r.level === 3) out.l3 = v;
      out.total += v;
    }
    return out;
  }

  async getReferralEarningsForReferee(earnerWallet: string, refereeWallet: string): Promise<number> {
    const rows = await db.select({
      sum: sql<string>`COALESCE(SUM(${referralRewardEvents.amountUsdc}), 0)`,
    }).from(referralRewardEvents)
      .where(and(
        eq(referralRewardEvents.earnerWallet, earnerWallet),
        eq(referralRewardEvents.refereeWallet, refereeWallet),
        inArray(referralRewardEvents.status, ['paid', 'confirmed']),
      ));
    return parseFloat(rows[0]?.sum ?? '0') || 0;
  }

  async getReferralEarningsByReferee(earnerWallet: string, refereeWallets: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (refereeWallets.length === 0) return out;
    const rows = await db.select({
      referee: referralRewardEvents.refereeWallet,
      sum: sql<string>`COALESCE(SUM(${referralRewardEvents.amountUsdc}), 0)`,
    }).from(referralRewardEvents)
      .where(and(
        eq(referralRewardEvents.earnerWallet, earnerWallet),
        inArray(referralRewardEvents.refereeWallet, refereeWallets),
        inArray(referralRewardEvents.status, ['paid', 'confirmed']),
      ))
      .groupBy(referralRewardEvents.refereeWallet);
    for (const r of rows) {
      out.set(r.referee, parseFloat(r.sum) || 0);
    }
    return out;
  }

  // ─── Admin "Errors" panel ──────────────────────────────────────────────────
  // Dedup by fingerprint: a repeat occurrence upserts onto the same row (count +=,
  // lastSeen refreshed, latest message/detail/context wins, resolved auto-reset).
  async recordError(input: ErrorLogInput): Promise<void> {
    const inc = input.count && input.count > 0 ? input.count : 1;
    const last = input.lastSeen ?? new Date();
    const values = {
      fingerprint: input.fingerprint,
      category: input.category,
      severity: input.severity ?? "error",
      source: input.source ?? null,
      message: input.message,
      detail: input.detail ?? null,
      context: (input.context ?? null) as any,
      count: inc,
      firstSeen: last,
      lastSeen: last,
      resolved: false,
      resolvedAt: null,
    };
    await db.insert(errorLog).values(values).onConflictDoUpdate({
      target: errorLog.fingerprint,
      set: {
        count: sql`${errorLog.count} + ${inc}`,
        lastSeen: last,
        message: input.message,
        detail: input.detail ?? null,
        context: (input.context ?? null) as any,
        severity: input.severity ?? "error",
        source: input.source ?? null,
        // Recurrence means it's back — un-resolve so the admin sees it again.
        resolved: false,
        resolvedAt: null,
      },
    });
  }

  async listErrors(filter: ErrorLogFilter = {}): Promise<ErrorLog[]> {
    const conds: any[] = [];
    if (filter.category) conds.push(eq(errorLog.category, filter.category));
    if (filter.severity) conds.push(eq(errorLog.severity, filter.severity));
    if (filter.resolved !== undefined) conds.push(eq(errorLog.resolved, filter.resolved));
    if (filter.since) conds.push(gte(errorLog.lastSeen, filter.since));
    const where = conds.length ? and(...conds) : undefined;
    return db.select().from(errorLog)
      .where(where)
      .orderBy(desc(errorLog.lastSeen))
      .limit(Math.min(filter.limit ?? 200, 500))
      .offset(filter.offset ?? 0);
  }

  // Summary counts per category/severity for the "what happened yesterday" glance.
  async getErrorStats(since?: Date): Promise<ErrorStatRow[]> {
    const where = since ? gte(errorLog.lastSeen, since) : undefined;
    return db.select({
      category: errorLog.category,
      severity: errorLog.severity,
      rows: sql<number>`count(*)::int`,
      occurrences: sql<number>`coalesce(sum(${errorLog.count}), 0)::int`,
      unresolved: sql<number>`sum(case when ${errorLog.resolved} = false then 1 else 0 end)::int`,
    }).from(errorLog)
      .where(where)
      .groupBy(errorLog.category, errorLog.severity);
  }

  async setErrorResolved(id: string, resolved: boolean): Promise<void> {
    await db.update(errorLog)
      .set({ resolved, resolvedAt: resolved ? new Date() : null })
      .where(eq(errorLog.id, id));
  }

  // Keep the table bounded: delete anything older than maxAgeDays (by lastSeen), then
  // evict the oldest rows beyond a hard maxRows cap. Both guards run every prune.
  async pruneErrors(opts: { maxAgeDays?: number; maxRows?: number } = {}): Promise<{ deletedByAge: number; deletedByCap: number }> {
    const maxAgeDays = opts.maxAgeDays ?? 30;
    const maxRows = opts.maxRows ?? 500;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const byAge = await db.delete(errorLog)
      .where(lt(errorLog.lastSeen, cutoff))
      .returning({ id: errorLog.id });
    let deletedByCap = 0;
    const overflow = await db.select({ id: errorLog.id })
      .from(errorLog)
      .orderBy(desc(errorLog.lastSeen))
      .offset(maxRows);
    if (overflow.length) {
      const byCap = await db.delete(errorLog)
        .where(inArray(errorLog.id, overflow.map((r) => r.id)))
        .returning({ id: errorLog.id });
      deletedByCap = byCap.length;
    }
    return { deletedByAge: byAge.length, deletedByCap };
  }

  // --- AI Trader (Agentic Trader plan §7 / WO-2) — schema + storage only. ---
  async createAiTraderBot(bot: InsertAiTraderBot): Promise<AiTraderBot> {
    const [created] = await db.insert(aiTraderBots).values(bot as any).returning();
    // WO-8e: drizzle-zod 0.7 marks .default()-columns optional in InsertAiTraderBot.
    // Drizzle 0.39 values(obj as any) can silently fall back to the Postgres column
    // default for those keys, letting the DB default win over the caller's value.
    // Detect and repair on the way out so the returned row always matches the intent.
    if (bot.riskProfile !== undefined && created.riskProfile !== bot.riskProfile) {
      const [patched] = await db
        .update(aiTraderBots)
        .set({ riskProfile: bot.riskProfile })
        .where(eq(aiTraderBots.id, created.id))
        .returning();
      return patched;
    }
    return created;
  }

  async getAiTraderBot(id: string): Promise<AiTraderBot | undefined> {
    const result = await db.select().from(aiTraderBots).where(eq(aiTraderBots.id, id));
    return result[0];
  }

  async getAiTraderBotsByWallet(walletAddress: string): Promise<AiTraderBot[]> {
    return db.select().from(aiTraderBots).where(eq(aiTraderBots.walletAddress, walletAddress));
  }

  // "Active" = not permanently retired. Used by the monitor loop (WO-6) to
  // decide which bots still need polling; 'stopped' is the only terminal state.
  async getActiveAiTraderBots(): Promise<AiTraderBot[]> {
    return db.select().from(aiTraderBots).where(ne(aiTraderBots.status, 'stopped'));
  }

  async updateAiTraderBot(id: string, updates: Partial<InsertAiTraderBot> & { graduatedAt?: Date; trialStartedAt?: Date }): Promise<AiTraderBot | undefined> {
    const result = await db.update(aiTraderBots)
      .set({ ...updates, updatedAt: sql`NOW()` } as any)
      .where(eq(aiTraderBots.id, id))
      .returning();
    return result[0];
  }

  async insertAiTraderDecision(decision: InsertAiTraderDecision): Promise<AiTraderDecision> {
    const result = await db.insert(aiTraderDecisions).values(decision as any).returning();
    return result[0];
  }

  async updateAiTraderDecision(id: string, updates: Partial<InsertAiTraderDecision>): Promise<AiTraderDecision | undefined> {
    const result = await db.update(aiTraderDecisions)
      .set(updates as any)
      .where(eq(aiTraderDecisions.id, id))
      .returning();
    return result[0];
  }

  async getAiTraderDecisions(botId: string, limit: number): Promise<AiTraderDecision[]> {
    return db.select().from(aiTraderDecisions)
      .where(eq(aiTraderDecisions.botId, botId))
      .orderBy(desc(aiTraderDecisions.decidedAt))
      .limit(limit);
  }

  // Executed decisions only (includes open trades where closedAt is null).
  async getExecutedDecisions(botId: string, limit: number): Promise<AiTraderDecision[]> {
    return db.select().from(aiTraderDecisions)
      .where(and(eq(aiTraderDecisions.botId, botId), eq(aiTraderDecisions.outcome, "executed")))
      .orderBy(desc(aiTraderDecisions.decidedAt))
      .limit(limit);
  }

  // Last N CLOSED decisions (closedAt set) — the WO-3 memory-context block.
  async getRecentClosedDecisions(botId: string, limit: number): Promise<AiTraderDecision[]> {
    return db.select().from(aiTraderDecisions)
      .where(and(eq(aiTraderDecisions.botId, botId), isNotNull(aiTraderDecisions.closedAt)))
      .orderBy(desc(aiTraderDecisions.decidedAt))
      .limit(limit);
  }

  // Thin old non-trade decision rows: strip heavy jsonb, keep all scalars.
  // Preserves a slim stub in raw_decision with the action and first 120 chars of rationale
  // so old Activity rows still render meaningfully (show excerpt, not a blank card).
  // INVARIANT: outcome='executed' rows are NEVER in the allowlist — full jsonb preserved forever.
  //            Those rows feed graduation, net PnL, calibration, ZEC counter, and the playbook.
  // Returns the number of rows updated in this batch (0 = done).
  async compressOldAiTraderDecisions(olderThanDays: number, batchSize: number): Promise<number> {
    const result = await db.execute(sql`
      UPDATE ai_trader_decisions SET
        context_digest = NULL,
        guardrail_violations = NULL,
        raw_decision = jsonb_build_object(
          'compressed', true,
          'action', COALESCE(clamped_decision->>'action', raw_decision->>'action'),
          'rationaleExcerpt', left(COALESCE(clamped_decision->>'rationale', ''), 120)
        ),
        clamped_decision = NULL
      WHERE id IN (
        SELECT id FROM ai_trader_decisions
        WHERE decided_at < now() - (${olderThanDays}::text || ' days')::interval
          AND outcome IN ('flat','user_skipped','rejected_guardrails','aborted_malformed','aborted_stale','aborted_funding','expired')
          AND NOT (raw_decision ? 'compressed')
        LIMIT ${batchSize}
      )
    `);
    return Number((result as any).rowCount ?? 0);
  }

  // Paginated history fetch with server-side outcome filtering + keyset cursor.
  // outcomes: 'all' = no filter, 'executed' = trades only, 'non_flat' = exclude flat stand-asides.
  // Cursor: pass { before, beforeId } from previous nextCursor to fetch the next older page.
  // Fetches limit+1 rows to detect whether another page exists; returns at most limit rows.
  async getAiTraderDecisionsPaged(
    botId: string,
    limit: number,
    opts?: { outcomes?: 'all' | 'executed' | 'non_flat'; before?: Date; beforeId?: string },
  ): Promise<{ rows: AiTraderDecision[]; nextCursor: { before: string; beforeId: string } | null }> {
    const { outcomes = 'all', before, beforeId } = opts ?? {};

    const outcomesCond =
      outcomes === 'executed' ? eq(aiTraderDecisions.outcome, 'executed') :
      outcomes === 'non_flat' ? ne(aiTraderDecisions.outcome, 'flat') :
      undefined;

    const cursorCond =
      before && beforeId
        ? or(
            lt(aiTraderDecisions.decidedAt, before),
            and(
              eq(aiTraderDecisions.decidedAt, before),
              lt(aiTraderDecisions.id, beforeId),
            ),
          )
        : undefined;

    const whereCond = and(
      eq(aiTraderDecisions.botId, botId),
      outcomesCond,
      cursorCond,
    );

    const fetched = await db.select().from(aiTraderDecisions)
      .where(whereCond)
      .orderBy(desc(aiTraderDecisions.decidedAt), desc(aiTraderDecisions.id))
      .limit(limit + 1);

    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      hasMore && lastRow && lastRow.decidedAt != null
        ? { before: lastRow.decidedAt.toISOString(), beforeId: lastRow.id }
        : null;

    return { rows, nextCursor };
  }

  // --- AI Trader (WO-7) ---
  async getAiTraderDecision(id: string): Promise<AiTraderDecision | undefined> {
    const result = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, id));
    return result[0];
  }

  async deleteAiTraderBot(id: string): Promise<void> {
    await db.delete(aiTraderBots).where(eq(aiTraderBots.id, id));
  }

  async getAiTraderOpenDecisionsByBotIds(botIds: string[]): Promise<AiTraderDecision[]> {
    if (botIds.length === 0) return [];
    return db
      .select()
      .from(aiTraderDecisions)
      .where(
        and(
          inArray(aiTraderDecisions.botId, botIds),
          eq(aiTraderDecisions.outcome, "executed"),
          isNull(aiTraderDecisions.closedAt),
        ),
      );
  }

  async getAiTraderTotalRealizedPnlMap(botIds: string[]): Promise<Map<string, number>> {
    if (botIds.length === 0) return new Map();
    const rows = await db
      .select({
        botId: aiTraderDecisions.botId,
        total: sql<string>`COALESCE(SUM(${aiTraderDecisions.realizedPnl}::numeric), 0)`,
      })
      .from(aiTraderDecisions)
      .where(
        and(
          inArray(aiTraderDecisions.botId, botIds),
          isNotNull(aiTraderDecisions.closedAt),
          eq(aiTraderDecisions.outcome, "executed"),
        ),
      )
      .groupBy(aiTraderDecisions.botId);
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.botId) map.set(row.botId, Number(row.total));
    }
    return map;
  }

  // WO-8h item 1: lifetime stats for Net P&L computation (one batch query for
  // all bots of a user — totalRealized already net-of-fees, fees shown for info).
  async getAiTraderBotLifetimeStats(
    botIds: string[],
  ): Promise<Map<string, { totalRealized: number; totalFees: number; totalLlmCost: number }>> {
    if (botIds.length === 0) return new Map();
    const rows = await db
      .select({
        botId: aiTraderDecisions.botId,
        totalRealized: sql<string>`COALESCE(SUM(${aiTraderDecisions.realizedPnl}::numeric)
          FILTER (WHERE ${aiTraderDecisions.outcome} = 'executed' AND ${aiTraderDecisions.closedAt} IS NOT NULL), 0)`,
        totalFees: sql<string>`COALESCE(SUM(${aiTraderDecisions.feesPaid}::numeric), 0)`,
        totalLlmCost: sql<string>`COALESCE(SUM(${aiTraderDecisions.llmCostUsd}::numeric), 0)`,
      })
      .from(aiTraderDecisions)
      .where(inArray(aiTraderDecisions.botId, botIds))
      .groupBy(aiTraderDecisions.botId);
    const map = new Map<string, { totalRealized: number; totalFees: number; totalLlmCost: number }>();
    for (const row of rows) {
      if (row.botId) {
        map.set(row.botId, {
          totalRealized: Number(row.totalRealized),
          totalFees: Number(row.totalFees),
          totalLlmCost: Number(row.totalLlmCost),
        });
      }
    }
    return map;
  }

  async incrementAiTraderFreeCalls(walletAddress: string, limit: number): Promise<number | null> {
    const result = await db.update(wallets)
      .set({ aiTraderFreeCallsUsed: sql`${wallets.aiTraderFreeCallsUsed} + 1` })
      .where(and(eq(wallets.address, walletAddress), lt(wallets.aiTraderFreeCallsUsed, limit)))
      .returning({ count: wallets.aiTraderFreeCallsUsed });
    return result[0]?.count ?? null;
  }

  async decrementAiTraderFreeCalls(walletAddress: string): Promise<void> {
    await db.update(wallets)
      .set({ aiTraderFreeCallsUsed: sql`GREATEST(${wallets.aiTraderFreeCallsUsed} - 1, 0)` })
      .where(eq(wallets.address, walletAddress));
  }

  // ---------------------------------------------------------------------------
  // WO-15A: Batch financial enrichment
  // ---------------------------------------------------------------------------
  async getTradingBotListEnrichment(walletAddress: string, botIds: string[]): Promise<BotListEnrichment> {
    const empty: BotListEnrichment = {
      tradeCounts: new Map(),
      positions: new Map(),
      publishedBotMap: new Map(),
      equityAgg: new Map(),
      borrowDebts: new Map(),
    };
    // Deduplicate before querying; empty input produces zero queries.
    const dedupedIds = [...new Set(botIds)];
    if (dedupedIds.length === 0) return empty;

    // --- Query 1: canonical trade counts ---
    // Reproduces getCanonicalBotTradeCount exactly: pnl IS NOT NULL, terminal
    // statuses, phantom-dup-close exclusion. One GROUP BY replaces N per-bot calls.
    const tradeCountRows = await db
      .select({
        botId: botTrades.tradingBotId,
        tradeCount: sql<number>`COUNT(*)::int`,
      })
      .from(botTrades)
      .where(and(
        inArray(botTrades.tradingBotId, dedupedIds),
        eq(botTrades.walletAddress, walletAddress),
        isNotNull(botTrades.pnl),
        sql`${botTrades.status} IN ('executed','liquidated','recovered')`,
        notPhantomDupClose(),
      ))
      .groupBy(botTrades.tradingBotId);

    const tradeCounts = new Map<string, number>();
    for (const row of tradeCountRows) {
      tradeCounts.set(row.botId, Number(row.tradeCount ?? 0));
    }

    // --- Query 2: bot position rows (all markets per bot) ---
    // unique(tradingBotId, market) ensures one row per market; caller picks bot.market.
    const positionRows = await db
      .select()
      .from(botPositions)
      .where(and(
        inArray(botPositions.tradingBotId, dedupedIds),
        eq(botPositions.walletAddress, walletAddress),
      ));

    const positions = new Map<string, BotPosition[]>();
    for (const row of positionRows) {
      const arr = positions.get(row.tradingBotId) ?? [];
      arr.push(row);
      positions.set(row.tradingBotId, arr);
    }

    // --- Query 3: published-bot rows ---
    // published_bots.trading_bot_id has a UNIQUE constraint → at most 1 row per
    // bot → the map is deterministic with no tie-breaking logic required.
    const publishedRows = await db
      .select()
      .from(publishedBots)
      .where(and(
        inArray(publishedBots.tradingBotId, dedupedIds),
        eq(publishedBots.creatorWalletAddress, walletAddress),
      ));

    const publishedBotMap = new Map<string, PublishedBot>();
    for (const row of publishedRows) {
      publishedBotMap.set(row.tradingBotId, row);
    }

    // --- Query 4: equity aggregation ---
    // Reproduces sumNetDepositedFromEvents + totalDeposits per bot in SQL.
    // VAULT_INTERNAL_EVENT_TYPES is imported directly from the authoritative
    // utility — never a second hard-coded list — so any future additions to the
    // set are automatically reflected here without drift.
    const internalTypesArr = [...VAULT_INTERNAL_EVENT_TYPES];
    const equityRows = await db
      .select({
        botId: equityEvents.tradingBotId,
        netDeposited: sql<string>`SUM(
          CASE WHEN ${notInArray(equityEvents.eventType, internalTypesArr)}
            THEN CAST(${equityEvents.amount} AS numeric)
            ELSE 0::numeric
          END
        )::text`,
        totalDeposits: sql<string>`SUM(
          CASE WHEN ${notInArray(equityEvents.eventType, internalTypesArr)}
                 AND CAST(${equityEvents.amount} AS numeric) > 0
            THEN CAST(${equityEvents.amount} AS numeric)
            ELSE 0::numeric
          END
        )::text`,
      })
      .from(equityEvents)
      .where(and(
        isNotNull(equityEvents.tradingBotId),
        inArray(equityEvents.tradingBotId as any, dedupedIds),
        eq(equityEvents.walletAddress, walletAddress),
      ))
      .groupBy(equityEvents.tradingBotId);

    const equityAgg = new Map<string, { netDeposited: number; totalDeposits: number }>();
    for (const row of equityRows) {
      if (!row.botId) continue;
      const nd = parseFloat(row.netDeposited ?? '0');
      const td = parseFloat(row.totalDeposits ?? '0');
      equityAgg.set(row.botId, {
        netDeposited: Number.isFinite(nd) ? nd : 0,
        totalDeposits: Number.isFinite(td) ? td : 0,
      });
    }

    // --- Query 5: open USDC borrow debt ---
    // Reproduces sumOpenBorrowDebtUsdcForBot semantics exactly: BigInt arithmetic
    // on the raw integer text field, USDC-only, open status (not closed/failed).
    const borrowRows = await db
      .select({
        tradingBotId: borrowPositions.tradingBotId,
        debtAmountRaw: borrowPositions.debtAmountRaw,
        debtAssetKey: borrowPositions.debtAssetKey,
      })
      .from(borrowPositions)
      .where(and(
        isNotNull(borrowPositions.tradingBotId),
        inArray(borrowPositions.tradingBotId as any, dedupedIds),
        eq(borrowPositions.walletAddress, walletAddress),
        ne(borrowPositions.status, 'closed'),
        ne(borrowPositions.status, 'failed'),
      ));

    const borrowDebts = new Map<string, number>();
    const rawByBot = new Map<string, bigint>();
    for (const r of borrowRows) {
      if (!r.tradingBotId) continue;
      if (String(r.debtAssetKey).toLowerCase() !== 'usdc') continue;
      try {
        const v = BigInt(r.debtAmountRaw);
        if (v > BigInt(0)) {
          rawByBot.set(r.tradingBotId, (rawByBot.get(r.tradingBotId) ?? BigInt(0)) + v);
        }
      } catch { /* debtAmountRaw is always a valid integer string on valid rows */ }
    }
    for (const [botId, totalRaw] of rawByBot) {
      borrowDebts.set(botId, new Decimal(totalRaw.toString()).div(1_000_000).toNumber());
    }

    return { tradeCounts, positions, publishedBotMap, equityAgg, borrowDebts };
  }
}

export const storage = new DatabaseStorage();
