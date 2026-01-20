import { eq, desc, sql, and, or, ilike, gte, lte } from "drizzle-orm";
import { db } from "./db";
import Decimal from "decimal.js";
import {
  users,
  wallets,
  bots,
  tradingBots,
  botTrades,
  botPositions,
  equityEvents,
  webhookLogs,
  subscriptions,
  portfolios,
  positions,
  trades,
  leaderboardStats,
  orphanedSubaccounts,
  publishedBots,
  botSubscriptions,
  pnlSnapshots,
  marketplaceEquitySnapshots,
  telegramConnectionTokens,
  tradeRetryQueue,
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
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getWallet(address: string): Promise<Wallet | undefined>;
  getWalletByWebhookSecret(secret: string): Promise<Wallet | undefined>;
  getWalletByReferralCode(referralCode: string): Promise<Wallet | undefined>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  updateWalletLastSeen(address: string): Promise<void>;
  getOrCreateWallet(address: string): Promise<Wallet>;
  updateWalletAgentKeys(address: string, agentPublicKey: string, agentPrivateKeyEncrypted: string): Promise<void>;
  updateWalletAgentKeyV3(address: string, agentPrivateKeyEncryptedV3: string): Promise<void>;
  updateWalletWebhookSecret(address: string, userWebhookSecret: string): Promise<void>;
  updateWallet(address: string, updates: Partial<InsertWallet>): Promise<Wallet | undefined>;

  getAllBots(): Promise<Bot[]>;
  getFeaturedBots(): Promise<Bot[]>;
  getBotById(id: string): Promise<Bot | undefined>;
  createBot(bot: InsertBot): Promise<Bot>;
  incrementBotSubscribers(botId: string, delta: number): Promise<void>;

  getTradingBots(walletAddress: string): Promise<TradingBot[]>;
  getTradingBotById(id: string): Promise<TradingBot | undefined>;
  getTradingBotBySecret(webhookSecret: string): Promise<TradingBot | undefined>;
  getNextSubaccountId(walletAddress: string): Promise<number>;
  getAllocatedSubaccountIds(walletAddress: string): Promise<number[]>;
  createTradingBot(bot: InsertTradingBot): Promise<TradingBot>;
  updateTradingBot(id: string, updates: Partial<InsertTradingBot>): Promise<TradingBot | undefined>;
  clearTradingBotSubaccount(id: string): Promise<void>;
  deleteTradingBot(id: string): Promise<void>;
  updateTradingBotStats(id: string, stats: TradingBot['stats']): Promise<void>;

  getBotTrades(tradingBotId: string, limit?: number): Promise<BotTrade[]>;
  getBotTradeCount(tradingBotId: string): Promise<number>;
  getBotTrade(tradeId: string): Promise<BotTrade | undefined>;
  getWalletBotTrades(walletAddress: string, limit?: number): Promise<BotTrade[]>;
  createBotTrade(trade: InsertBotTrade): Promise<BotTrade>;
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
    winRate: number;
    tradeCount: number;
  }>>;

  createEquityEvent(event: InsertEquityEvent): Promise<EquityEvent>;
  getEquityEvents(walletAddress: string, limit?: number): Promise<EquityEvent[]>;
  getBotEquityEvents(tradingBotId: string, limit?: number): Promise<EquityEvent[]>;
  getBotNetDeposited(tradingBotId: string): Promise<number>;

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
  getPublishedBots(options?: { search?: string; market?: string; sortBy?: string; limit?: number }): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null } })[]>;
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
  getSubscriberBotsBySourceId(publishedBotId: string): Promise<TradingBot[]>;
  createBotSubscription(subscription: InsertBotSubscription): Promise<BotSubscription>;
  updateBotSubscription(id: string, updates: Partial<InsertBotSubscription>): Promise<BotSubscription | undefined>;
  cancelBotSubscription(id: string): Promise<void>;

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

  // Security v3: Execution authorization
  updateWalletExecution(address: string, updates: {
    executionEnabled: boolean;
    umkEncryptedForExecution: string | null;
    executionExpiresAt: Date | null;
  }): Promise<Wallet | undefined>;

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

  async updateWalletWebhookSecret(address: string, userWebhookSecret: string): Promise<void> {
    await db.update(wallets).set({ userWebhookSecret }).where(eq(wallets.address, address));
  }

  async updateWallet(address: string, updates: Partial<InsertWallet>): Promise<Wallet | undefined> {
    const result = await db.update(wallets).set(updates).where(eq(wallets.address, address)).returning();
    return result[0];
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

  async createTradingBot(bot: InsertTradingBot): Promise<TradingBot> {
    const result = await db.insert(tradingBots).values(bot as any).returning();
    return result[0];
  }

  async updateTradingBot(id: string, updates: Partial<InsertTradingBot>): Promise<TradingBot | undefined> {
    const result = await db.update(tradingBots).set({ ...updates, updatedAt: sql`NOW()` } as any).where(eq(tradingBots.id, id)).returning();
    return result[0];
  }

  async clearTradingBotSubaccount(id: string): Promise<void> {
    await db.update(tradingBots).set({ driftSubaccountId: null, updatedAt: sql`NOW()` }).where(eq(tradingBots.id, id));
  }

  async deleteTradingBot(id: string): Promise<void> {
    await db.delete(tradingBots).where(eq(tradingBots.id, id));
  }

  async updateTradingBotStats(id: string, stats: TradingBot['stats']): Promise<void> {
    await db.update(tradingBots).set({ stats, updatedAt: sql`NOW()` }).where(eq(tradingBots.id, id));
  }

  async getBotTrades(tradingBotId: string, limit: number = 50): Promise<BotTrade[]> {
    return db.select().from(botTrades).where(eq(botTrades.tradingBotId, tradingBotId)).orderBy(desc(botTrades.executedAt)).limit(limit);
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
      eq(botTrades.status, 'executed'),
      sql`${botTrades.pnl} IS NOT NULL`,
    ];
    if (since) {
      conditions.push(gte(botTrades.executedAt, since));
    }
    const trades = await db
      .select({
        executedAt: botTrades.executedAt,
        pnl: botTrades.pnl,
      })
      .from(botTrades)
      .where(and(...conditions))
      .orderBy(botTrades.executedAt);

    let cumulativePnl = 0;
    return trades.map((trade) => {
      const pnl = parseFloat(trade.pnl || '0');
      cumulativePnl += pnl;
      return {
        timestamp: trade.executedAt,
        pnl,
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

  async createBotTrade(trade: InsertBotTrade): Promise<BotTrade> {
    const result = await db.insert(botTrades).values(trade).returning();
    return result[0];
  }

  async updateBotTrade(id: string, updates: Partial<InsertBotTrade>): Promise<void> {
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
      winRate: number;
      tradeCount: number;
    }> = [];

    for (const wallet of allWallets) {
      const bots = await db.select().from(tradingBots).where(eq(tradingBots.walletAddress, wallet.address));
      if (bots.length === 0) continue;

      let totalWinningTrades = 0;
      let totalTrades = 0;
      for (const bot of bots) {
        const stats = bot.stats as { totalTrades?: number; winningTrades?: number } | null;
        if (stats) {
          totalTrades += stats.totalTrades || 0;
          totalWinningTrades += stats.winningTrades || 0;
        }
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

      results.push({
        walletAddress: wallet.address,
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        totalVolume,
        totalPnl,
        winRate,
        tradeCount: totalTrades,
      });
    }

    results.sort((a, b) => b.totalPnl - a.totalPnl);
    return results.slice(0, limit);
  }

  async createEquityEvent(event: InsertEquityEvent): Promise<EquityEvent> {
    const result = await db.insert(equityEvents).values(event).returning();
    return result[0];
  }

  async getEquityEvents(walletAddress: string, limit: number = 50): Promise<EquityEvent[]> {
    return db.select().from(equityEvents).where(eq(equityEvents.walletAddress, walletAddress)).orderBy(desc(equityEvents.createdAt)).limit(limit);
  }

  async getBotEquityEvents(tradingBotId: string, limit: number = 50): Promise<EquityEvent[]> {
    return db.select().from(equityEvents).where(eq(equityEvents.tradingBotId, tradingBotId)).orderBy(desc(equityEvents.createdAt)).limit(limit);
  }

  async getBotNetDeposited(tradingBotId: string): Promise<number> {
    const events = await db.select().from(equityEvents).where(eq(equityEvents.tradingBotId, tradingBotId));
    let netDeposited = 0;
    for (const event of events) {
      const amount = parseFloat(event.amount);
      netDeposited += amount;
    }
    return netDeposited;
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
  async getPublishedBots(options?: { search?: string; market?: string; sortBy?: string; limit?: number }): Promise<(PublishedBot & { creator: { displayName: string | null; xUsername: string | null } })[]> {
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
    })
    .from(publishedBots)
    .leftJoin(wallets, eq(publishedBots.creatorWalletAddress, wallets.address))
    .where(and(...conditions))
    .orderBy(orderByColumn)
    .limit(options?.limit || 50);

    return results.map(r => ({
      ...r.publishedBot,
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
    .where(eq(botSubscriptions.subscriberWalletAddress, walletAddress))
    .orderBy(desc(botSubscriptions.subscribedAt));

    return results.map(r => ({
      ...r.subscription,
      publishedBot: r.publishedBot,
    }));
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

  // Security v3: Execution authorization
  async updateWalletExecution(address: string, updates: {
    executionEnabled: boolean;
    umkEncryptedForExecution: string | null;
    executionExpiresAt: Date | null;
  }): Promise<Wallet | undefined> {
    const result = await db.update(wallets).set(updates).where(eq(wallets.address, address)).returning();
    return result[0];
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
}

export const storage = new DatabaseStorage();
