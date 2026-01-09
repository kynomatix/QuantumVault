import { eq, desc, sql } from "drizzle-orm";
import { db } from "./db";
import {
  users,
  wallets,
  bots,
  tradingBots,
  botTrades,
  equityEvents,
  webhookLogs,
  subscriptions,
  portfolios,
  positions,
  trades,
  leaderboardStats,
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
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getWallet(address: string): Promise<Wallet | undefined>;
  getWalletByWebhookSecret(secret: string): Promise<Wallet | undefined>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  updateWalletLastSeen(address: string): Promise<void>;
  getOrCreateWallet(address: string): Promise<Wallet>;
  updateWalletAgentKeys(address: string, agentPublicKey: string, agentPrivateKeyEncrypted: string): Promise<void>;
  updateWalletWebhookSecret(address: string, userWebhookSecret: string): Promise<void>;

  getAllBots(): Promise<Bot[]>;
  getFeaturedBots(): Promise<Bot[]>;
  getBotById(id: string): Promise<Bot | undefined>;
  createBot(bot: InsertBot): Promise<Bot>;
  incrementBotSubscribers(botId: string, delta: number): Promise<void>;

  getTradingBots(walletAddress: string): Promise<TradingBot[]>;
  getTradingBotById(id: string): Promise<TradingBot | undefined>;
  getTradingBotBySecret(webhookSecret: string): Promise<TradingBot | undefined>;
  getNextSubaccountId(walletAddress: string): Promise<number>;
  createTradingBot(bot: InsertTradingBot): Promise<TradingBot>;
  updateTradingBot(id: string, updates: Partial<InsertTradingBot>): Promise<TradingBot | undefined>;
  deleteTradingBot(id: string): Promise<void>;
  updateTradingBotStats(id: string, stats: TradingBot['stats']): Promise<void>;

  getBotTrades(tradingBotId: string, limit?: number): Promise<BotTrade[]>;
  getWalletBotTrades(walletAddress: string, limit?: number): Promise<BotTrade[]>;
  createBotTrade(trade: InsertBotTrade): Promise<BotTrade>;
  updateBotTrade(id: string, updates: Partial<InsertBotTrade>): Promise<void>;

  createWebhookLog(log: InsertWebhookLog): Promise<WebhookLog>;
  updateWebhookLog(id: string, updates: Partial<InsertWebhookLog>): Promise<void>;

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

  createEquityEvent(event: InsertEquityEvent): Promise<EquityEvent>;
  getEquityEvents(walletAddress: string, limit?: number): Promise<EquityEvent[]>;
  getBotEquityEvents(tradingBotId: string, limit?: number): Promise<EquityEvent[]>;
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

  async updateWalletWebhookSecret(address: string, userWebhookSecret: string): Promise<void> {
    await db.update(wallets).set({ userWebhookSecret }).where(eq(wallets.address, address));
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
    
    const usedIds = bots
      .map(b => b.driftSubaccountId)
      .filter((id): id is number => id !== null);
    
    if (usedIds.length === 0) {
      return 0;
    }
    
    return Math.max(...usedIds) + 1;
  }

  async createTradingBot(bot: InsertTradingBot): Promise<TradingBot> {
    const result = await db.insert(tradingBots).values(bot as any).returning();
    return result[0];
  }

  async updateTradingBot(id: string, updates: Partial<InsertTradingBot>): Promise<TradingBot | undefined> {
    const result = await db.update(tradingBots).set({ ...updates, updatedAt: sql`NOW()` } as any).where(eq(tradingBots.id, id)).returning();
    return result[0];
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

  async getWalletBotTrades(walletAddress: string, limit: number = 50): Promise<BotTrade[]> {
    return db.select().from(botTrades).where(eq(botTrades.walletAddress, walletAddress)).orderBy(desc(botTrades.executedAt)).limit(limit);
  }

  async createBotTrade(trade: InsertBotTrade): Promise<BotTrade> {
    const result = await db.insert(botTrades).values(trade).returning();
    return result[0];
  }

  async updateBotTrade(id: string, updates: Partial<InsertBotTrade>): Promise<void> {
    await db.update(botTrades).set(updates).where(eq(botTrades.id, id));
  }

  async createWebhookLog(log: InsertWebhookLog): Promise<WebhookLog> {
    const result = await db.insert(webhookLogs).values(log).returning();
    return result[0];
  }

  async updateWebhookLog(id: string, updates: Partial<InsertWebhookLog>): Promise<void> {
    await db.update(webhookLogs).set(updates).where(eq(webhookLogs.id, id));
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
}

export const storage = new DatabaseStorage();
