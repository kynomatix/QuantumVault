import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean, jsonb, unique } from "drizzle-orm/pg-core";
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
  xUsername: text("x_username"),
  referralCode: text("referral_code").unique(),
  referredBy: text("referred_by"),
  driftSubaccount: integer("drift_subaccount").default(0),
  defaultLeverage: integer("default_leverage").default(3),
  slippageBps: integer("slippage_bps").default(50),
  agentPublicKey: text("agent_public_key"),
  agentPrivateKeyEncrypted: text("agent_private_key_encrypted"),            // Legacy: encrypted with AGENT_ENCRYPTION_KEY
  agentPrivateKeyEncryptedV3: text("agent_private_key_encrypted_v3"),       // V3: encrypted with key_privkey derived from UMK
  userWebhookSecret: text("user_webhook_secret"),
  notificationsEnabled: boolean("notifications_enabled").default(false),
  notifyTradeExecuted: boolean("notify_trade_executed").default(true),
  notifyTradeFailed: boolean("notify_trade_failed").default(true),
  notifyPositionClosed: boolean("notify_position_closed").default(true),
  telegramConnected: boolean("telegram_connected").default(false),
  telegramChatId: text("telegram_chat_id"),
  dialectAddress: text("dialect_address"),
  dialectBearerToken: text("dialect_bearer_token"),
  
  // Security v3: Per-user cryptographic salt and UMK envelope
  userSalt: text("user_salt"),                                      // 32 bytes hex, generated once per user
  encryptedUserMasterKey: text("encrypted_user_master_key"),        // EUMK: UMK encrypted with session key
  encryptedMnemonicWords: text("encrypted_mnemonic_words"),         // BIP-39 mnemonic encrypted with key_mnemonic
  umkVersion: integer("umk_version").default(0).notNull(),          // Increments on key rotation
  
  // Security v3: Execution authorization
  executionEnabled: boolean("execution_enabled").default(false).notNull(),
  umkEncryptedForExecution: text("umk_encrypted_for_execution"),    // EUMK_exec: UMK wrapped with SERVER_EXECUTION_KEY
  executionExpiresAt: timestamp("execution_expires_at"),            // EUMK_exec expiry (1 hour)
  policyHmac: text("policy_hmac"),                                  // HMAC of execution policy for integrity
  
  // Security v3: Emergency controls
  emergencyStopTriggered: boolean("emergency_stop_triggered").default(false).notNull(),
  emergencyStopAt: timestamp("emergency_stop_at"),
  emergencyStopBy: text("emergency_stop_by"),                       // Admin ID who triggered
  
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
  botType: text("bot_type").default("signal").notNull(),
  side: text("side").default("both").notNull(),
  totalInvestment: decimal("total_investment", { precision: 20, scale: 2 }).default("100").notNull(),
  maxPositionSize: decimal("max_position_size", { precision: 20, scale: 2 }),
  leverage: integer("leverage").default(1).notNull(),
  profitReinvest: boolean("profit_reinvest").default(false).notNull(),
  autoWithdrawThreshold: decimal("auto_withdraw_threshold", { precision: 20, scale: 2 }),
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
    totalVolume: number;
    lastTradeAt?: string;
  }>().default({ totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 }),
  sourcePublishedBotId: varchar("source_published_bot_id"),
  
  // Security v3: Execution authorization per bot
  executionActive: boolean("execution_active").default(false).notNull(), // Whether execution is currently enabled
  umkEncryptedForBot: text("umk_encrypted_for_bot"),              // Bot-specific encrypted UMK for trade execution
  policyHmac: text("policy_hmac"),                                // HMAC of bot policy (market, leverage, maxPositionSize) for integrity
  
  // Auto top-up: Automatically deposit required collateral when margin is insufficient
  autoTopUp: boolean("auto_top_up").default(false).notNull(),
  pauseReason: text("pause_reason"), // Reason why bot was auto-paused (e.g., "Insufficient margin")
  
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
  fee: decimal("fee", { precision: 20, scale: 6 }).default("0"),
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
  totalFees: decimal("total_fees", { precision: 20, scale: 6 }).notNull().default("0"),
  lastTradeId: varchar("last_trade_id"),
  lastTradeAt: timestamp("last_trade_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  uniqueBotMarket: unique("bot_positions_bot_market_unique").on(table.tradingBotId, table.market),
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
  assetType: text("asset_type").notNull().default('USDC'),
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
  signalHash: text("signal_hash").unique(),
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

export const orphanedSubaccounts = pgTable("orphaned_subaccounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  agentPublicKey: text("agent_public_key").notNull(),
  agentPrivateKeyEncrypted: text("agent_private_key_encrypted").notNull(),
  driftSubaccountId: integer("drift_subaccount_id").notNull(),
  reason: text("reason"),
  retryCount: integer("retry_count").default(0).notNull(),
  lastRetryAt: timestamp("last_retry_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrphanedSubaccountSchema = createInsertSchema(orphanedSubaccounts).omit({
  id: true,
  retryCount: true,
  lastRetryAt: true,
  createdAt: true,
});
export type InsertOrphanedSubaccount = z.infer<typeof insertOrphanedSubaccountSchema>;
export type OrphanedSubaccount = typeof orphanedSubaccounts.$inferSelect;

// Marketplace: Published bots that can be subscribed to
export const publishedBots = pgTable("published_bots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull().references(() => tradingBots.id, { onDelete: "cascade" }).unique(),
  creatorWalletAddress: text("creator_wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  market: text("market").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isFeatured: boolean("is_featured").default(false).notNull(),
  subscriberCount: integer("subscriber_count").default(0).notNull(),
  creatorCapital: decimal("creator_capital", { precision: 20, scale: 2 }).default("0").notNull(),
  totalCapitalInvested: decimal("total_capital_invested", { precision: 20, scale: 2 }).default("0").notNull(),
  totalTrades: integer("total_trades").default(0).notNull(),
  winningTrades: integer("winning_trades").default(0).notNull(),
  pnlPercent7d: decimal("pnl_percent_7d", { precision: 10, scale: 4 }),
  pnlPercent30d: decimal("pnl_percent_30d", { precision: 10, scale: 4 }),
  pnlPercent90d: decimal("pnl_percent_90d", { precision: 10, scale: 4 }),
  pnlPercentAllTime: decimal("pnl_percent_all_time", { precision: 10, scale: 4 }),
  profitSharePercent: decimal("profit_share_percent", { precision: 5, scale: 2 }).default("0").notNull(),
  publishedAt: timestamp("published_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPublishedBotSchema = createInsertSchema(publishedBots).omit({
  id: true,
  subscriberCount: true,
  creatorCapital: true,
  totalCapitalInvested: true,
  totalTrades: true,
  winningTrades: true,
  pnlPercent7d: true,
  pnlPercent30d: true,
  pnlPercent90d: true,
  pnlPercentAllTime: true,
  publishedAt: true,
  updatedAt: true,
}).extend({
  profitSharePercent: z.string().optional(),
});
export type InsertPublishedBot = z.infer<typeof insertPublishedBotSchema>;
export type PublishedBot = typeof publishedBots.$inferSelect;

// Marketplace: Subscriptions to published bots
export const botSubscriptions = pgTable("bot_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  publishedBotId: varchar("published_bot_id").notNull().references(() => publishedBots.id, { onDelete: "cascade" }),
  subscriberWalletAddress: text("subscriber_wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  subscriberBotId: varchar("subscriber_bot_id").references(() => tradingBots.id, { onDelete: "set null" }),
  capitalInvested: decimal("capital_invested", { precision: 20, scale: 2 }).notNull(),
  status: text("status").notNull().default("active"),
  subscribedAt: timestamp("subscribed_at").defaultNow().notNull(),
  unsubscribedAt: timestamp("unsubscribed_at"),
}, (table) => ({
  uniqueSubscription: unique("bot_subscriptions_unique").on(table.publishedBotId, table.subscriberWalletAddress),
}));

export const insertBotSubscriptionSchema = createInsertSchema(botSubscriptions).omit({
  id: true,
  subscribedAt: true,
  unsubscribedAt: true,
});
export type InsertBotSubscription = z.infer<typeof insertBotSubscriptionSchema>;
export type BotSubscription = typeof botSubscriptions.$inferSelect;

// Marketplace: Daily PnL snapshots for time-based performance tracking
export const pnlSnapshots = pgTable("pnl_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull().references(() => tradingBots.id, { onDelete: "cascade" }),
  snapshotDate: timestamp("snapshot_date").notNull(),
  equity: decimal("equity", { precision: 20, scale: 6 }).notNull(),
  realizedPnl: decimal("realized_pnl", { precision: 20, scale: 6 }).notNull().default("0"),
  unrealizedPnl: decimal("unrealized_pnl", { precision: 20, scale: 6 }).notNull().default("0"),
  totalDeposited: decimal("total_deposited", { precision: 20, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueBotDate: unique("pnl_snapshots_bot_date_unique").on(table.tradingBotId, table.snapshotDate),
}));

export const insertPnlSnapshotSchema = createInsertSchema(pnlSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertPnlSnapshot = z.infer<typeof insertPnlSnapshotSchema>;
export type PnlSnapshot = typeof pnlSnapshots.$inferSelect;

// Marketplace: Public equity snapshots for published bots (decoupled from private trading bot data)
export const marketplaceEquitySnapshots = pgTable("marketplace_equity_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  publishedBotId: varchar("published_bot_id").notNull().references(() => publishedBots.id, { onDelete: "cascade" }),
  snapshotDate: timestamp("snapshot_date").notNull(),
  equity: decimal("equity", { precision: 20, scale: 6 }).notNull(),
  pnlPercent: decimal("pnl_percent", { precision: 10, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueBotDate: unique("marketplace_equity_snapshots_bot_date_unique").on(table.publishedBotId, table.snapshotDate),
}));

export const insertMarketplaceEquitySnapshotSchema = createInsertSchema(marketplaceEquitySnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertMarketplaceEquitySnapshot = z.infer<typeof insertMarketplaceEquitySnapshotSchema>;
export type MarketplaceEquitySnapshot = typeof marketplaceEquitySnapshots.$inferSelect;

// Security v3: Single-use nonces for signature verification
export const authNonces = pgTable("auth_nonces", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull(),
  nonceHash: text("nonce_hash").notNull().unique(),              // SHA-256 of nonce, prevents replay
  purpose: text("purpose").notNull(),                             // unlock_umk, enable_execution, reveal_mnemonic, revoke_execution
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),                                   // NULL until used, single-use enforcement
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAuthNonceSchema = createInsertSchema(authNonces).omit({
  id: true,
  usedAt: true,
  createdAt: true,
});
export type InsertAuthNonce = z.infer<typeof insertAuthNonceSchema>;
export type AuthNonce = typeof authNonces.$inferSelect;

// Security v3: Signature purpose types
export type SignaturePurpose = 
  | "unlock_umk"
  | "enable_execution"
  | "reveal_mnemonic"
  | "revoke_execution";

// Telegram connection tokens for linking Telegram to wallets
export const telegramConnectionTokens = pgTable("telegram_connection_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTelegramConnectionTokenSchema = createInsertSchema(telegramConnectionTokens).omit({
  id: true,
  createdAt: true,
});
export type InsertTelegramConnectionToken = z.infer<typeof insertTelegramConnectionTokenSchema>;
export type TelegramConnectionToken = typeof telegramConnectionTokens.$inferSelect;

// Trade retry queue - persists failed trades for retry across server restarts
export const tradeRetryQueue = pgTable("trade_retry_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  originalTradeId: varchar("original_trade_id").notNull(),
  botId: varchar("bot_id").notNull().references(() => tradingBots.id, { onDelete: "cascade" }),
  walletAddress: text("wallet_address").notNull(),
  market: text("market").notNull(),
  side: text("side").notNull(),
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  price: decimal("price", { precision: 20, scale: 8 }),
  leverage: integer("leverage").default(1).notNull(),
  priority: text("priority").default("normal").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  nextRetryAt: timestamp("next_retry_at").notNull(),
  lastError: text("last_error"),
  status: text("status").default("pending").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTradeRetryQueueSchema = createInsertSchema(tradeRetryQueue).omit({
  id: true,
  createdAt: true,
});
export type InsertTradeRetryQueue = z.infer<typeof insertTradeRetryQueueSchema>;
export type TradeRetryQueue = typeof tradeRetryQueue.$inferSelect;

// Platform Analytics: Aggregated metrics for landing page and monitoring
export const platformMetrics = pgTable("platform_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  metricType: text("metric_type").notNull(),
  value: decimal("value", { precision: 30, scale: 6 }).notNull(),
  metadata: jsonb("metadata"),
  calculatedAt: timestamp("calculated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPlatformMetricSchema = createInsertSchema(platformMetrics).omit({
  id: true,
  createdAt: true,
});
export type InsertPlatformMetric = z.infer<typeof insertPlatformMetricSchema>;
export type PlatformMetric = typeof platformMetrics.$inferSelect;

// Platform metrics types
export type PlatformMetricType = 
  | "tvl"              // Total Value Locked - sum of all USDC in Drift accounts
  | "total_volume"     // Total trading volume across all bots
  | "total_trades"     // Total number of trades executed
  | "active_bots"      // Number of active trading bots
  | "active_users"     // Number of active users (wallets with bots)
  | "volume_24h"       // 24-hour trading volume
  | "volume_7d";       // 7-day trading volume

// Profit Sharing: IOU records for failed profit share transfers
// Tracks pending transfers that need to be retried (SOL starvation, RPC failures, etc.)
export const pendingProfitShares = pgTable("pending_profit_shares", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriberBotId: varchar("subscriber_bot_id").notNull().references(() => tradingBots.id, { onDelete: "cascade" }),
  subscriberWalletAddress: text("subscriber_wallet_address").notNull(),
  creatorWalletAddress: text("creator_wallet_address").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  realizedPnl: decimal("realized_pnl", { precision: 20, scale: 6 }).notNull(),
  profitSharePercent: decimal("profit_share_percent", { precision: 5, scale: 2 }).notNull(),
  tradeId: text("trade_id").notNull(),
  publishedBotId: varchar("published_bot_id").references(() => publishedBots.id, { onDelete: "set null" }),
  driftSubaccountId: integer("drift_subaccount_id").notNull(),
  status: text("status").notNull().default("pending"), // pending, processing, paid, voided
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueSubscriberTrade: unique("pending_profit_shares_unique").on(table.subscriberBotId, table.tradeId),
}));

export const insertPendingProfitShareSchema = createInsertSchema(pendingProfitShares).omit({
  id: true,
  status: true,
  retryCount: true,
  lastError: true,
  lastAttemptAt: true,
  createdAt: true,
});
export type InsertPendingProfitShare = z.infer<typeof insertPendingProfitShareSchema>;
export type PendingProfitShare = typeof pendingProfitShares.$inferSelect;
