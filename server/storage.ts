import { eq, desc, sql } from "drizzle-orm";
import { db } from "./db";
import {
  users,
  bots,
  subscriptions,
  portfolios,
  positions,
  trades,
  leaderboardStats,
  type User,
  type InsertUser,
  type Bot,
  type InsertBot,
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
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Bots
  getAllBots(): Promise<Bot[]>;
  getFeaturedBots(): Promise<Bot[]>;
  getBotById(id: string): Promise<Bot | undefined>;
  createBot(bot: InsertBot): Promise<Bot>;
  incrementBotSubscribers(botId: string, delta: number): Promise<void>;

  // Subscriptions
  createSubscription(subscription: InsertSubscription): Promise<Subscription>;
  getUserSubscriptions(userId: string): Promise<(Subscription & { bot: Bot })[]>;
  updateSubscriptionStatus(id: string, status: string): Promise<void>;

  // Portfolio
  getPortfolio(userId: string): Promise<Portfolio | undefined>;
  upsertPortfolio(portfolio: InsertPortfolio): Promise<Portfolio>;

  // Positions
  getUserPositions(userId: string): Promise<Position[]>;
  createPosition(position: InsertPosition): Promise<Position>;
  updatePosition(id: string, updates: Partial<InsertPosition>): Promise<void>;

  // Trades
  getUserTrades(userId: string, limit?: number): Promise<Trade[]>;
  createTrade(trade: InsertTrade): Promise<Trade>;

  // Leaderboard
  getLeaderboard(limit?: number): Promise<(LeaderboardStats & { user: User })[]>;
  upsertLeaderboardStats(stats: InsertLeaderboardStats): Promise<LeaderboardStats>;
}

export class DatabaseStorage implements IStorage {
  // Users
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

  // Bots
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

  // Subscriptions
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

  // Portfolio
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

  // Positions
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

  // Trades
  async getUserTrades(userId: string, limit: number = 50): Promise<Trade[]> {
    return db.select().from(trades).where(eq(trades.userId, userId)).orderBy(desc(trades.timestamp)).limit(limit);
  }

  async createTrade(trade: InsertTrade): Promise<Trade> {
    const result = await db.insert(trades).values(trade).returning();
    return result[0];
  }

  // Leaderboard
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
}

export const storage = new DatabaseStorage();
