import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  displayName: text("display_name"),
  referralCode: text("referral_code").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  displayName: true,
  referralCode: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const wallets = pgTable("wallets", {
  address: text("address").primaryKey(),
  displayName: text("display_name"),
  referralCode: text("referral_code").unique(),
  driftSubaccount: integer("drift_subaccount").default(0),
  agentPublicKey: text("agent_public_key"),
  agentPrivateKeyEncrypted: text("agent_private_key_encrypted"),
  userWebhookSecret: text("user_webhook_secret"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
});

export const insertWalletSchema = createInsertSchema(wallets).omit({
  createdAt: true,
  lastSeen: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof wallets.$inferSelect;

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  market: text("market").notNull(),
  apr: decimal("apr", { precision: 10, scale: 2 }).notNull(),
  subscribers: integer("subscribers").default(0).notNull(),
  creatorUsername: text("creator_username").notNull(),
  rating: decimal("rating", { precision: 3, scale: 1 }).notNull(),
  minDeposit: integer("min_deposit").notNull(),
  featured: boolean("featured").default(false).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBotSchema = createInsertSchema(bots).omit({
  createdAt: true,
  subscribers: true,
});
export type InsertBot = z.infer<typeof insertBotSchema>;
export type Bot = typeof bots.$inferSelect;

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
  totalInvestment: decimal("total_investment", { precision: 20, scale: 2 }).default("100").notNull(),
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

export const botPositions = pgTable("bot_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull().references(() => tradingBots.id, { onDelete: "cascade" }),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  market: text("market").notNull(),
  baseSize: decimal("base_size", { precision: 20, scale: 8 }).notNull().default("0"),
  avgEntryPrice: decimal("avg_entry_price", { precision: 20, scale: 6 }).notNull().default("0"),
  costBasis: decimal("cost_basis", { precision: 20, scale: 6 }).notNull().default("0"),
  realizedPnl: decimal("realized_pnl", { precision: 20, scale: 6 }).notNull().default("0"),
  lastTradeId: varchar("last_trade_id"),
  lastTradeAt: timestamp("last_trade_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  uniqueBotMarket: sql`CONSTRAINT bot_positions_bot_market_unique UNIQUE (${table.tradingBotId}, ${table.market})`,
}));

export const insertBotPositionSchema = createInsertSchema(botPositions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBotPosition = z.infer<typeof insertBotPositionSchema>;
export type BotPosition = typeof botPositions.$inferSelect;

export const equityEvents = pgTable("equity_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  tradingBotId: varchar("trading_bot_id").references(() => tradingBots.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  txSignature: text("tx_signature"),
  balanceAfter: decimal("balance_after", { precision: 20, scale: 6 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEquityEventSchema = createInsertSchema(equityEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertEquityEvent = z.infer<typeof insertEquityEventSchema>;
export type EquityEvent = typeof equityEvents.$inferSelect;

export const webhookLogs = pgTable("webhook_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").references(() => tradingBots.id, { onDelete: "set null" }),
  payload: jsonb("payload").notNull(),
  headers: jsonb("headers"),
  ipAddress: text("ip_address"),
  processed: boolean("processed").default(false).notNull(),
  signalHash: text("signal_hash"),
  tradeExecuted: boolean("trade_executed").default(false).notNull(),
  errorMessage: text("error_message"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
});

export const insertWebhookLogSchema = createInsertSchema(webhookLogs).omit({
  id: true,
  receivedAt: true,
});
export type InsertWebhookLog = z.infer<typeof insertWebhookLogSchema>;
export type WebhookLog = typeof webhookLogs.$inferSelect;

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  subscribedAt: timestamp("subscribed_at").defaultNow().notNull(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptions).omit({
  id: true,
  subscribedAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

export const portfolios = pgTable("portfolios", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  totalValue: decimal("total_value", { precision: 20, scale: 2 }).default("0").notNull(),
  unrealizedPnl: decimal("unrealized_pnl", { precision: 20, scale: 2 }).default("0").notNull(),
  realizedPnl: decimal("realized_pnl", { precision: 20, scale: 2 }).default("0").notNull(),
  solBalance: decimal("sol_balance", { precision: 20, scale: 8 }).default("0").notNull(),
  usdcBalance: decimal("usdc_balance", { precision: 20, scale: 2 }).default("0").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPortfolioSchema = createInsertSchema(portfolios);
export type InsertPortfolio = z.infer<typeof insertPortfolioSchema>;
export type Portfolio = typeof portfolios.$inferSelect;

export const positions = pgTable("positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  market: text("market").notNull(),
  side: text("side").notNull(),
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  entryPrice: decimal("entry_price", { precision: 20, scale: 2 }).notNull(),
  currentPrice: decimal("current_price", { precision: 20, scale: 2 }).notNull(),
  pnl: decimal("pnl", { precision: 20, scale: 2 }).notNull(),
  pnlPercent: decimal("pnl_percent", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPositionSchema = createInsertSchema(positions).omit({
  id: true,
  createdAt: true,
});
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Position = typeof positions.$inferSelect;

export const trades = pgTable("trades", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  market: text("market").notNull(),
  side: text("side").notNull(),
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  price: decimal("price", { precision: 20, scale: 2 }).notNull(),
  total: decimal("total", { precision: 20, scale: 2 }).notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const insertTradeSchema = createInsertSchema(trades).omit({
  id: true,
  timestamp: true,
});
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof trades.$inferSelect;

export const leaderboardStats = pgTable("leaderboard_stats", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  totalVolume: decimal("total_volume", { precision: 20, scale: 2 }).default("0").notNull(),
  totalPnl: decimal("total_pnl", { precision: 20, scale: 2 }).default("0").notNull(),
  winRate: decimal("win_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  totalTrades: integer("total_trades").default(0).notNull(),
  rank: integer("rank"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLeaderboardStatsSchema = createInsertSchema(leaderboardStats);
export type InsertLeaderboardStats = z.infer<typeof insertLeaderboardStatsSchema>;
export type LeaderboardStats = typeof leaderboardStats.$inferSelect;
