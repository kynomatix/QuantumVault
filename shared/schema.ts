import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const wallets = pgTable("wallets", {
  address: text("address").primaryKey(),
  displayName: text("display_name"),
  referralCode: text("referral_code").unique(),
  driftSubaccount: integer("drift_subaccount").default(0),
  agentPublicKey: text("agent_public_key"),
  agentPrivateKeyEncrypted: text("agent_private_key_encrypted"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
});

export const insertWalletSchema = createInsertSchema(wallets).omit({
  createdAt: true,
  lastSeen: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof wallets.$inferSelect;

export const tradingBots = pgTable("trading_bots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  name: text("name").notNull(),
  market: text("market").notNull(),
  webhookSecret: text("webhook_secret").notNull(),
  webhookUrl: text("webhook_url"),
  driftSubaccountId: integer("drift_subaccount_id"),
  agentPublicKey: text("agent_public_key"),
  agentPrivateKeyEncrypted: text("agent_private_key_encrypted"),
  isActive: boolean("is_active").default(true).notNull(),
  side: text("side").default("both").notNull(),
  maxPositionSize: decimal("max_position_size", { precision: 20, scale: 2 }),
  leverage: integer("leverage").default(1).notNull(),
  signalConfig: jsonb("signal_config").$type<{
    entryKeyword?: string;
    exitKeyword?: string;
    longKeyword?: string;
    shortKeyword?: string;
  }>(),
  riskConfig: jsonb("risk_config").$type<{
    maxDailyLoss?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
    cooldownMinutes?: number;
  }>(),
  stats: jsonb("stats").$type<{
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
    lastTradeAt?: string;
  }>().default({ totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTradingBotSchema = createInsertSchema(tradingBots).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  stats: true,
  webhookUrl: true,
  driftSubaccountId: true,
  agentPublicKey: true,
  agentPrivateKeyEncrypted: true,
});
export type InsertTradingBot = z.infer<typeof insertTradingBotSchema>;
export type TradingBot = typeof tradingBots.$inferSelect;

export const botTrades = pgTable("bot_trades", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull().references(() => tradingBots.id, { onDelete: "cascade" }),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  market: text("market").notNull(),
  side: text("side").notNull(),
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  price: decimal("price", { precision: 20, scale: 6 }).notNull(),
  pnl: decimal("pnl", { precision: 20, scale: 2 }),
  status: text("status").notNull().default("pending"),
  txSignature: text("tx_signature"),
  webhookPayload: jsonb("webhook_payload"),
  errorMessage: text("error_message"),
  executedAt: timestamp("executed_at").defaultNow().notNull(),
});

export const insertBotTradeSchema = createInsertSchema(botTrades).omit({
  id: true,
  executedAt: true,
});
export type InsertBotTrade = z.infer<typeof insertBotTradeSchema>;
export type BotTrade = typeof botTrades.$inferSelect;

export const webhookLogs = pgTable("webhook_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").references(() => tradingBots.id, { onDelete: "set null" }),
  payload: jsonb("payload").notNull(),
  headers: jsonb("headers"),
  ipAddress: text("ip_address"),
  processed: boolean("processed").default(false).notNull(),
  errorMessage: text("error_message"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
});

export const insertWebhookLogSchema = createInsertSchema(webhookLogs).omit({
  id: true,
  receivedAt: true,
});
export type InsertWebhookLog = z.infer<typeof insertWebhookLogSchema>;
export type WebhookLog = typeof webhookLogs.$inferSelect;
