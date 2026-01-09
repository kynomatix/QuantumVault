import { eq, desc, sql } from "drizzle-orm";
import { db } from "./db";
import {
  wallets,
  tradingBots,
  botTrades,
  webhookLogs,
  type Wallet,
  type InsertWallet,
  type TradingBot,
  type InsertTradingBot,
  type BotTrade,
  type InsertBotTrade,
  type WebhookLog,
  type InsertWebhookLog,
} from "@shared/schema";

export interface IStorage {
  getWallet(address: string): Promise<Wallet | undefined>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  updateWalletLastSeen(address: string): Promise<void>;
  getOrCreateWallet(address: string): Promise<Wallet>;
  updateWalletAgentKeys(address: string, agentPublicKey: string, agentPrivateKeyEncrypted: string): Promise<void>;

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
}

export class DatabaseStorage implements IStorage {
  async getWallet(address: string): Promise<Wallet | undefined> {
    const result = await db.select().from(wallets).where(eq(wallets.address, address)).limit(1);
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
}

export const storage = new DatabaseStorage();
