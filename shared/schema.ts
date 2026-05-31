import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean, jsonb, unique, json, index, serial, real, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Express session table (managed by connect-pg-simple, defined here to prevent deletion)
export const userSessions = pgTable("user_sessions", {
  sid: varchar("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { withTimezone: false }).notNull(),
}, (table) => [
  index("IDX_session_expire").on(table.expire),
]);

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
  dailySummaryEnabled: boolean("daily_summary_enabled").default(false).notNull(),
  dailySummaryLastSentDate: text("daily_summary_last_sent_date"),

  // Task 143: Pacifica Builder Code & Referral Wiring. Per-user idempotency
  // flags so the adapter only signs+POSTs each enrollment once. The adapter
  // resets them to false implicitly on failure (it just doesn't flip them),
  // so the next interaction retries. The two flags are independent: builder
  // approval gates the on-trade `builder_code` injection (fail-closed), while
  // referral claim is best-effort and never blocks trading (fail-open).
  pacificaBuilderApproved: boolean("pacifica_builder_approved").default(false).notNull(),
  pacificaReferralClaimed: boolean("pacifica_referral_claimed").default(false).notNull(),
  
  protocolSubaccountId: text("protocol_subaccount_id"),
  
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
  
  protocolSubaccountId: text("protocol_subaccount_id"),
  // Group D item 18 (April 17, 2026): which protocol adapter created/owns this bot.
  // Allowed values are constrained at the DB level by `trading_bots_active_protocol_check`
  // (see check() block below) and bootstrapped from the runtime migration in
  // server/db.ts ensureSchema() (which also backfills any pre-existing NULL rows to
  // 'drift' before applying NOT NULL). Drizzle's $type<...> here documents the union;
  // the SQL CHECK is the actual enforcement.
  activeProtocol: text("active_protocol").$type<'pacifica' | 'drift' | 'flash'>().notNull(),
  botSubaccountKeyEncrypted: text("bot_subaccount_key_encrypted"),
  // Phase 4b: V3-encrypted bot subaccount key (subkey derived from owner UMK
  // with per-bot AAD). Legacy column remains during the Phase 5b/6 drop window.
  botSubaccountKeyEncryptedV3: text("bot_subaccount_key_encrypted_v3"),

  // Task 149: Per-bot Pacifica enrollment flags. Each Phase 4b bot has its
  // own Pacifica account (the keypair behind bot_subaccount_key_encrypted_v3,
  // with the public key in protocol_subaccount_id). Enrollment must be
  // tracked per-bot since each bot is a distinct main account upstream.
  // Mirrors wallets.pacificaBuilderApproved / pacificaReferralClaimed.
  pacificaBuilderApproved: boolean("pacifica_builder_approved").default(false).notNull(),
  pacificaReferralClaimed: boolean("pacifica_referral_claimed").default(false).notNull(),

  subaccountStatus: text("subaccount_status").default("none"),
  subaccountAuthMode: text("subaccount_auth_mode").$type<'external_key' | 'main_plus_id'>().notNull(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ([
  index("idx_trading_bots_protocol_subaccount").on(table.activeProtocol, table.protocolSubaccountId),
  check(
    "trading_bots_subaccount_auth_mode_check",
    sql`${table.subaccountAuthMode} IN ('external_key', 'main_plus_id')`,
  ),
  check(
    "trading_bots_external_key_invariant",
    sql`NOT (${table.subaccountAuthMode} = 'external_key' AND ${table.subaccountStatus} = 'active') OR (${table.protocolSubaccountId} IS NOT NULL AND (${table.botSubaccountKeyEncrypted} IS NOT NULL OR ${table.botSubaccountKeyEncryptedV3} IS NOT NULL))`,
  ),
  check(
    "trading_bots_active_protocol_check",
    sql`${table.activeProtocol} IN ('pacifica', 'drift', 'flash')`,
  ),
]));

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
  status: text("status").notNull().default("pending"), // pending, executed, failed, recovered, liquidated
  txSignature: text("tx_signature"),
  webhookPayload: jsonb("webhook_payload"),
  errorMessage: text("error_message"),
  recoveredFromError: text("recovered_from_error"), // Stores original error when trade recovered via retry
  retryAttempts: integer("retry_attempts"), // Number of retry attempts before success
  executionMethod: text("execution_method").default("legacy"), // 'swift' | 'legacy'
  swiftOrderId: text("swift_order_id"),
  auctionDurationMs: integer("auction_duration_ms"),
  priceImprovement: decimal("price_improvement", { precision: 10, scale: 4 }),
  protocolOrderId: text("protocol_order_id"),
  clientOrderId: text("client_order_id"),
  protocolFillId: text("protocol_fill_id").unique(),
  protocol: text("protocol").default("pacifica"),
  protocolStatus: text("protocol_status"),
  submittedAt: timestamp("submitted_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  filledAt: timestamp("filled_at"),
  requestedSizeBase: decimal("requested_size_base", { precision: 20, scale: 8 }),
  filledSizeBase: decimal("filled_size_base", { precision: 20, scale: 8 }),
  remainingSizeBase: decimal("remaining_size_base", { precision: 20, scale: 8 }),
  averageFillPrice: decimal("average_fill_price", { precision: 20, scale: 6 }),
  lastProtocolError: text("last_protocol_error"),
  lastReconcileAt: timestamp("last_reconcile_at"),
  executedAt: timestamp("executed_at").defaultNow().notNull(),
}, (table) => ([
  index("idx_bot_trades_protocol_client_order").on(table.protocol, table.clientOrderId),
  index("idx_bot_trades_protocol_order_id").on(table.protocolOrderId),
  index("idx_bot_trades_protocol_status").on(table.protocolStatus),
]));

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
  // On-chain confirmation time. When NULL, fall back to createdAt. Critical for
  // Task 119: deposits backfilled by the reconciler weeks after the fact must
  // still be attributed to their actual on-chain time so historical snapshots
  // don't double-count them as profit.
  txBlockTime: timestamp("tx_block_time"),
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
  // V3 Phase 3b: reason a subscription was paused/disabled by fan-out
  // (e.g. "execution_disabled", "emergency_stopped", "v3_decrypt_failed").
  // NULL when status is 'active'.
  subscriptionStatusReason: text("subscription_status_reason"),
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
  // V3 Phase 4: column kept for read-compat with rows written before the
  // migration; cleanup now resolves the agent key via wallet V3 envelope at
  // run time. New inserts leave this null. Phase 6 will drop the column.
  agentPrivateKeyEncrypted: text("agent_private_key_encrypted"),
  driftSubaccountId: integer("drift_subaccount_id").notNull(),
  protocolSubaccountId: text("protocol_subaccount_id"),
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
  // V3 Phase 3b: reason a subscription was paused/disabled by fan-out
  // (e.g. "execution_disabled", "emergency_stopped", "v3_decrypt_failed").
  // NULL when status is 'active'.
  subscriptionStatusReason: text("subscription_status_reason"),
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
  cooldownRetries: integer("cooldown_retries").default(0).notNull(),
  nextRetryAt: timestamp("next_retry_at").notNull(),
  lastError: text("last_error"),
  status: text("status").default("pending").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  webhookPayload: jsonb("webhook_payload"),
  entryPrice: decimal("entry_price", { precision: 20, scale: 8 }),
  swiftAttempts: integer("swift_attempts").default(0),
  originalExecutionMethod: text("original_execution_method").default("legacy"),
  protocol: text("protocol"),
  protocolSubaccountId: text("protocol_subaccount_id"),
  agentPublicKey: text("agent_public_key"),
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

export const platformCumulativeStats = pgTable("platform_cumulative_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  totalVolume: decimal("total_volume", { precision: 30, scale: 6 }).notNull().default("0"),
  totalTrades: integer("total_trades").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PlatformCumulativeStats = typeof platformCumulativeStats.$inferSelect;

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
  protocolSubaccountId: text("protocol_subaccount_id"),
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

// MLM Referral Chain: up to 3 levels of ancestor wallets per descendant
export const referralLinks = pgTable("referral_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  descendantWallet: text("descendant_wallet").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  ancestorWallet: text("ancestor_wallet").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  level: integer("level").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ([
  unique("referral_links_descendant_level_unique").on(table.descendantWallet, table.level),
  index("idx_referral_links_ancestor").on(table.ancestorWallet),
  index("idx_referral_links_descendant").on(table.descendantWallet),
  check("referral_links_no_self", sql`${table.descendantWallet} <> ${table.ancestorWallet}`),
  check("referral_links_level_range", sql`${table.level} BETWEEN 1 AND 3`),
]));

export const insertReferralLinkSchema = createInsertSchema(referralLinks).omit({
  id: true,
  createdAt: true,
});
export type InsertReferralLink = z.infer<typeof insertReferralLinkSchema>;
export type ReferralLink = typeof referralLinks.$inferSelect;

// MLM Referral Rewards: ledger of reward events tied to revenue events (e.g. profit_share_paid)
export const referralRewardEvents = pgTable("referral_reward_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  earnerWallet: text("earner_wallet").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  refereeWallet: text("referee_wallet").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  fundingWallet: text("funding_wallet"),
  level: integer("level").notNull(),
  amountUsdc: decimal("amount_usdc", { precision: 20, scale: 6 }).notNull(),
  status: text("status").notNull().default("pending"),
  transferSignature: text("transfer_signature"),
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ([
  unique("referral_reward_events_unique").on(table.sourceType, table.sourceId, table.earnerWallet, table.level),
  index("idx_referral_reward_events_earner").on(table.earnerWallet),
  index("idx_referral_reward_events_status_created").on(table.status, table.createdAt),
  check("referral_reward_events_level_range", sql`${table.level} BETWEEN 1 AND 3`),
]));

export const insertReferralRewardEventSchema = createInsertSchema(referralRewardEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertReferralRewardEvent = z.infer<typeof insertReferralRewardEventSchema>;
export type ReferralRewardEvent = typeof referralRewardEvents.$inferSelect;

export const protocolOrderEvents = pgTable("protocol_order_events", {
  id: serial("id").primaryKey(),
  botTradeId: varchar("bot_trade_id").references(() => botTrades.id, { onDelete: "cascade" }),
  protocolOrderId: text("protocol_order_id"),
  clientOrderId: text("client_order_id"),
  eventType: text("event_type").notNull(),
  eventSource: text("event_source").notNull(),
  status: text("status"),
  filledSize: decimal("filled_size", { precision: 20, scale: 8 }),
  fillPrice: decimal("fill_price", { precision: 20, scale: 6 }),
  protocolFillId: text("protocol_fill_id"),
  rawPayload: jsonb("raw_payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ([
  index("idx_protocol_order_events_order_id").on(table.protocolOrderId),
  index("idx_protocol_order_events_client_order_id").on(table.clientOrderId),
  index("idx_protocol_order_events_trade_created").on(table.botTradeId, table.createdAt),
]));

export const insertProtocolOrderEventSchema = createInsertSchema(protocolOrderEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertProtocolOrderEvent = z.infer<typeof insertProtocolOrderEventSchema>;
export type ProtocolOrderEvent = typeof protocolOrderEvents.$inferSelect;

export const protocolSubaccounts = pgTable("protocol_subaccounts", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  botId: varchar("bot_id").references(() => tradingBots.id, { onDelete: "set null" }),
  protocol: text("protocol").notNull(),
  protocolSubaccountId: text("protocol_subaccount_id"),
  status: text("status").notNull(),
  initiationTx: text("initiation_tx"),
  confirmationTx: text("confirmation_tx"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at"),
  lastError: text("last_error"),
  // --- Subaccount Recycling Plan §5 (Phase B scaffolding). All nullable, no behavior change. ---
  // Which agent (PDA) owns this subaccount — scopes the spare pool per (wallet, protocol, agent).
  agentPublicKey: text("agent_public_key"),
  // RETAINED subaccount signing key, re-bound AAD (§6). Populated in later phases, NOT during Phase B backfill.
  subaccountKeyEncryptedV3: text("subaccount_key_encrypted_v3"),
  // Crypto envelope version for the retained key (§6 dual-read/single-write).
  aadVersion: integer("aad_version"),
  // When the subaccount entered the spare pool (status='spare').
  releasedAt: timestamp("released_at"),
  // Last successful Pacifica verify-empty check before reuse.
  lastVerifiedEmptyAt: timestamp("last_verified_empty_at"),
  // Per-reservation claim token + lease start for concurrency-safe reuse (§5.1).
  claimToken: text("claim_token"),
  claimedAt: timestamp("claimed_at"),
}, (table) => ([
  unique("uq_protocol_subaccount").on(table.protocol, table.protocolSubaccountId),
  index("idx_protocol_subaccounts_wallet_protocol").on(table.walletAddress, table.protocol),
  index("idx_protocol_subaccounts_status").on(table.status),
  // Reuse hot path (§5): claim the oldest spare for a given (wallet, protocol, agent).
  index("idx_protocol_subaccounts_reuse").on(table.walletAddress, table.protocol, table.agentPublicKey, table.status, table.releasedAt),
]));

export const insertProtocolSubaccountSchema = createInsertSchema(protocolSubaccounts).omit({
  id: true,
  createdAt: true,
  confirmedAt: true,
});
export type InsertProtocolSubaccount = z.infer<typeof insertProtocolSubaccountSchema>;
export type ProtocolSubaccount = typeof protocolSubaccounts.$inferSelect;

export const builderAuthorizations = pgTable("builder_authorizations", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  builderCode: text("builder_code").notNull(),
  maxFeeRate: decimal("max_fee_rate", { precision: 10, scale: 6 }).notNull(),
  signature: text("signature").notNull(),
  status: text("status").notNull(),
  approvedAt: timestamp("approved_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => ([
  unique("uq_builder_auth_wallet_code").on(table.walletAddress, table.builderCode),
  index("idx_builder_authorizations_status").on(table.status),
]));

export const insertBuilderAuthorizationSchema = createInsertSchema(builderAuthorizations).omit({
  id: true,
  approvedAt: true,
  revokedAt: true,
});
export type InsertBuilderAuthorization = z.infer<typeof insertBuilderAuthorizationSchema>;
export type BuilderAuthorization = typeof builderAuthorizations.$inferSelect;

// Portfolio Daily Snapshots: Track daily balance for true P&L charting
// Net P&L = currentBalance - totalDeposits + totalWithdrawals (deposits/withdrawals are cumulative)
export const portfolioDailySnapshots = pgTable("portfolio_daily_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  snapshotDate: timestamp("snapshot_date").notNull(),
  totalBalance: decimal("total_balance", { precision: 20, scale: 6 }).notNull(),
  cumulativeDeposits: decimal("cumulative_deposits", { precision: 20, scale: 6 }).notNull(),
  cumulativeWithdrawals: decimal("cumulative_withdrawals", { precision: 20, scale: 6 }).notNull(),
  netPnl: decimal("net_pnl", { precision: 20, scale: 6 }).notNull(),
  activeBotCount: integer("active_bot_count").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  totalVolume: decimal("total_volume", { precision: 20, scale: 6 }).notNull().default("0"),
  creatorEarnings: decimal("creator_earnings", { precision: 20, scale: 6 }).notNull().default("0"),
  // Task 119: trading-P&L fields. These are the authoritative source for the
  // portfolio chart and leaderboard going forward; the older `netPnl` /
  // `cumulativeDeposits` columns are retained for backwards compatibility but
  // are no longer used for display math.
  // Cumulative EXTERNAL deposits (main wallet -> agent ATA) only.
  cumulativeExternalDeposits: decimal("cumulative_external_deposits", { precision: 20, scale: 6 }).notNull().default("0"),
  cumulativeExternalWithdrawals: decimal("cumulative_external_withdrawals", { precision: 20, scale: 6 }).notNull().default("0"),
  // Cumulative INTERNAL transfers (agent <-> subaccount, auto top-ups, reinvestments).
  cumulativeInternalTransfers: decimal("cumulative_internal_transfers", { precision: 20, scale: 6 }).notNull().default("0"),
  // Trading P&L $: totalBalance - (cumExtDeposits - cumExtWithdrawals). Flow-neutral.
  cumulativeTradingPnl: decimal("cumulative_trading_pnl", { precision: 20, scale: 6 }).notNull().default("0"),
  // Day's net external flow (deposits - withdrawals between prev snapshot and this one).
  netExternalFlow: decimal("net_external_flow", { precision: 20, scale: 6 }).notNull().default("0"),
  // Chained time-weighted return up to this snapshot (percentage, e.g. 27.5 = +27.5%).
  pnlPercent: decimal("pnl_percent", { precision: 12, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueWalletDate: unique("portfolio_snapshots_wallet_date").on(table.walletAddress, table.snapshotDate),
}));

export const insertPortfolioDailySnapshotSchema = createInsertSchema(portfolioDailySnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertPortfolioDailySnapshot = z.infer<typeof insertPortfolioDailySnapshotSchema>;
export type PortfolioDailySnapshot = typeof portfolioDailySnapshots.$inferSelect;

export const superteamAgents = pgTable("superteam_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentName: text("agent_name").notNull(),
  agentId: text("agent_id"),
  apiKey: text("api_key"),
  claimCode: text("claim_code"),
  username: text("username"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSuperteamAgentSchema = createInsertSchema(superteamAgents).omit({
  id: true,
  createdAt: true,
});
export type InsertSuperteamAgent = z.infer<typeof insertSuperteamAgentSchema>;
export type SuperteamAgent = typeof superteamAgents.$inferSelect;

export const superteamSubmissions = pgTable("superteam_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: text("agent_id").notNull(),
  listingId: text("listing_id").notNull(),
  listingSlug: text("listing_slug"),
  listingTitle: text("listing_title"),
  link: text("link"),
  otherInfo: text("other_info"),
  tweet: text("tweet"),
  telegram: text("telegram"),
  status: text("status").notNull().default("submitted"),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const insertSuperteamSubmissionSchema = createInsertSchema(superteamSubmissions).omit({
  id: true,
  submittedAt: true,
  updatedAt: true,
});
export type InsertSuperteamSubmission = z.infer<typeof insertSuperteamSubmissionSchema>;
export type SuperteamSubmission = typeof superteamSubmissions.$inferSelect;

export const labStrategies = pgTable("lab_strategies", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  name: text("name").notNull(),
  description: text("description"),
  pineScript: text("pine_script").notNull(),
  parsedInputs: jsonb("parsed_inputs").notNull(),
  groups: jsonb("groups"),
  strategySettings: jsonb("strategy_settings"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const labOptimizationRuns = pgTable("lab_optimization_runs", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  strategyId: integer("strategy_id").notNull(),
  tickers: jsonb("tickers").notNull(),
  timeframes: jsonb("timeframes").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  randomSamples: integer("random_samples").notNull(),
  topK: integer("top_k").notNull(),
  refinementsPerSeed: integer("refinements_per_seed").notNull(),
  minTrades: integer("min_trades").notNull(),
  maxDrawdownCap: real("max_drawdown_cap").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("running"),
  totalConfigsTested: integer("total_configs_tested"),
  checkpoint: jsonb("checkpoint"),
  queueOrder: integer("queue_order"),
  configSnapshot: jsonb("config_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const labCandleCache = pgTable("lab_candle_cache", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  time: decimal("time", { precision: 20, scale: 0 }).notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: real("volume").notNull(),
}, (table) => [
  unique("lab_candle_cache_unique").on(table.symbol, table.timeframe, table.time),
  index("lab_candle_cache_lookup").on(table.symbol, table.timeframe),
]);

export const labOptimizationResults = pgTable("lab_optimization_results", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull(),
  ticker: text("ticker").notNull(),
  timeframe: text("timeframe").notNull(),
  rank: integer("rank").notNull(),
  netProfitPercent: real("net_profit_percent").notNull(),
  winRatePercent: real("win_rate_percent").notNull(),
  maxDrawdownPercent: real("max_drawdown_percent").notNull(),
  profitFactor: real("profit_factor").notNull(),
  totalTrades: integer("total_trades").notNull(),
  params: jsonb("params").notNull(),
  trades: jsonb("trades"),
  equityCurve: jsonb("equity_curve"),
  sharpeRatio: real("sharpe_ratio"),
});

export const labInsightsReports = pgTable("lab_insights_reports", {
  id: serial("id").primaryKey(),
  strategyId: integer("strategy_id").notNull(),
  reportData: jsonb("report_data").notNull(),
  totalResults: integer("total_results"),
  totalRuns: integer("total_runs"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Personal access tokens used by AI agents (Claude/MCP/etc.) and external
// automation to call lab/backtest endpoints on behalf of the wallet owner.
// Only the SHA-256 hash of the token is stored; the plaintext is shown to the
// user once at creation time and never again.
export const userApiTokens = pgTable("user_api_tokens", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  name: text("name").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().default(sql`'["lab:read","lab:write"]'::jsonb`),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("user_api_tokens_wallet_idx").on(table.walletAddress),
]);

export const insertUserApiTokenSchema = createInsertSchema(userApiTokens).omit({ id: true, createdAt: true, lastUsedAt: true });
export type UserApiToken = typeof userApiTokens.$inferSelect;
export type InsertUserApiToken = z.infer<typeof insertUserApiTokenSchema>;

export const insertLabStrategySchema = createInsertSchema(labStrategies).omit({ id: true, createdAt: true });
export const insertLabRunSchema = createInsertSchema(labOptimizationRuns).omit({ id: true, createdAt: true, completedAt: true });
export const insertLabResultSchema = createInsertSchema(labOptimizationResults).omit({ id: true });
export const insertLabInsightsReportSchema = createInsertSchema(labInsightsReports).omit({ id: true, createdAt: true });

export type LabStrategy = typeof labStrategies.$inferSelect;
export type InsertLabStrategy = z.infer<typeof insertLabStrategySchema>;
export type LabOptimizationRun = typeof labOptimizationRuns.$inferSelect;
export type InsertLabRun = z.infer<typeof insertLabRunSchema>;
export type LabOptResult = typeof labOptimizationResults.$inferSelect;
export type InsertLabResult = z.infer<typeof insertLabResultSchema>;
export type LabInsightsReport = typeof labInsightsReports.$inferSelect;
export type InsertLabInsightsReport = z.infer<typeof insertLabInsightsReportSchema>;

export interface LabPineInput {
  name: string;
  type: "int" | "float" | "bool" | "string" | "time";
  default: any;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  group?: string;
  groupLabel?: string;
  options?: string[];
  optimizable: boolean;
}

export interface LabPineParseResult {
  inputs: LabPineInput[];
  groups: Record<string, string>;
  strategyName?: string;
  strategySettings: {
    initialCapital?: number;
    defaultQtyValue?: number;
    commission?: number;
    processOrdersOnClose?: boolean;
  };
}

export interface GuidedInsights {
  paramSensitivity: {
    name: string;
    type: string;
    impactScore: number;
    bestBucket: { rangeMin: number; rangeMax: number };
  }[];
  topConfigs?: {
    params: Record<string, any>;
    score: number;
  }[];
}

export interface LabOptimizationConfig {
  pineScript: string;
  parsedInputs: LabPineInput[];
  tickers: string[];
  timeframes: string[];
  startDate: string;
  endDate: string;
  randomSamples: number;
  topK: number;
  refinementsPerSeed: number;
  minTrades: number;
  maxDrawdownCap: number;
  minAvgBarsHeld: number;
  mode: "smoke" | "sweep";
  strategyId?: number;
  engineType?: string;
  useInsights?: boolean;
  deepSearch?: boolean;
  coordinateTune?: boolean;
}

export interface LabTradeRecord {
  entryTime: string;
  exitTime: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlDollar: number;
  exitReason: string;
  barsHeld: number;
}

export interface LabBacktestResult {
  ticker: string;
  timeframe: string;
  sharpeRatio?: number;
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  totalTrades: number;
  params: Record<string, any>;
  trades: LabTradeRecord[];
  equityCurve: { time: string; equity: number }[];
  compiledPath?: "compiled" | "interpreter";
}

export interface LabCheckpoint {
  completedCombos: string[];
  configSnapshot: LabOptimizationConfig;
  currentCombo?: string;
  currentStage?: "random" | "refine" | "deep" | "coordinate";
  currentIteration?: number;
  currentDeepRound?: number;
  partialResults?: LabBacktestResult[];
  refineSeeds?: Record<string, any>[];
  coordinateCompleted?: string[];
  bestDiscovery?: {
    combo: string;
    stage: "deep";
    deepRound: number;
    score: number;
    params: Record<string, any>;
  };
  resourceError?: boolean;
  lastHeartbeat?: number;
}

export interface LabJobProgress {
  jobId: string;
  status: "fetching" | "baseline" | "random_search" | "refinement" | "complete" | "error" | "retrying";
  stage: string;
  current: number;
  total: number;
  percent: number;
  bestSoFar?: {
    netProfitPercent: number;
    winRatePercent: number;
    maxDrawdownPercent: number;
    profitFactor: number;
    sharpeRatio?: number;
  };
  eta?: number;
  elapsed: number;
  error?: string;
  newJobId?: string;
  tickerProgress?: Record<string, {
    status: "pending" | "running" | "complete";
    best?: number;
  }>;
}

export interface LabJobResult {
  jobId: string;
  runId?: number;
  configs: LabBacktestResult[];
  totalConfigsTested: number;
  bestByCombo: Record<string, LabBacktestResult[]>;
}

export interface LabRiskAnalysis {
  maxDrawdownPercent: number;
  recommendedLeverage: number;
  maxSafeLeverage: number;
  liquidationBuffer: number;
  longestLosingStreak: number;
  avgLossPercent: number;
  avgWinPercent: number;
  worstTradePercent: number;
  recoveryFactor: number;
  kellyPercent: number;
  riskOfRuin: number;
  recommendedWalletAllocation: number;
  minCapitalRequired: number;
  streakDrawdownPercent: number;
  avgBarsInDrawdown: number;
  riskRating: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  recommendations: string[];
}

export const LAB_AVAILABLE_TICKERS = [
  { symbol: "SOL/USDT:USDT", name: "SOL" },
  { symbol: "BTC/USDT:USDT", name: "BTC" },
  { symbol: "ETH/USDT:USDT", name: "ETH" },
  { symbol: "XRP/USDT:USDT", name: "XRP" },
  { symbol: "ADA/USDT:USDT", name: "ADA" },
  { symbol: "DOGE/USDT:USDT", name: "DOGE" },
  { symbol: "LTC/USDT:USDT", name: "LTC" },
  { symbol: "BNB/USDT:USDT", name: "BNB" },
  { symbol: "AVAX/USDT:USDT", name: "AVAX" },
  { symbol: "LINK/USDT:USDT", name: "LINK" },
  { symbol: "BONK/USDT:USDT", name: "BONK" },
  { symbol: "PEPE/USDT:USDT", name: "PEPE" },
  { symbol: "BCH/USDT:USDT", name: "BCH" },
  { symbol: "NEAR/USDT:USDT", name: "NEAR" },
  { symbol: "UNI/USDT:USDT", name: "UNI" },
  { symbol: "AAVE/USDT:USDT", name: "AAVE" },
  { symbol: "SUI/USDT:USDT", name: "SUI" },
  { symbol: "ARB/USDT:USDT", name: "ARB" },
  { symbol: "INJ/USDT:USDT", name: "INJ" },
  { symbol: "ICP/USDT:USDT", name: "ICP" },
  { symbol: "ENA/USDT:USDT", name: "ENA" },
  { symbol: "CRV/USDT:USDT", name: "CRV" },
  { symbol: "LDO/USDT:USDT", name: "LDO" },
  { symbol: "STRK/USDT:USDT", name: "STRK" },
  { symbol: "WLD/USDT:USDT", name: "WLD" },
  { symbol: "XMR/USDT:USDT", name: "XMR" },
  { symbol: "ZK/USDT:USDT", name: "ZK" },
  { symbol: "ZRO/USDT:USDT", name: "ZRO" },
  { symbol: "JUP/USDT:USDT", name: "JUP" },
  { symbol: "TAO/USDT:USDT", name: "TAO" },
  { symbol: "PUMP/USDT:USDT", name: "PUMP" },
  { symbol: "WIF/USDT:USDT", name: "WIF" },
  { symbol: "FARTCOIN/USDT:USDT", name: "FARTCOIN" },
  { symbol: "PENGU/USDT:USDT", name: "PENGU" },
  { symbol: "TRUMP/USDT:USDT", name: "TRUMP" },
  { symbol: "VIRTUAL/USDT:USDT", name: "VIRTUAL" },
  { symbol: "PIPPIN/USDT:USDT", name: "PIPPIN" },
  { symbol: "WLFI/USDT:USDT", name: "WLFI" },
  { symbol: "MEGA/USDT:USDT", name: "MEGA" },
  { symbol: "HYPE/USDT:USDT", name: "HYPE" },
  { symbol: "LIT/USDT:USDT", name: "LIT" },
  { symbol: "ASTER/USDT:USDT", name: "ASTER" },
  { symbol: "PAXG/USDT:USDT", name: "PAXG" },
  { symbol: "ZEC/USDT:USDT", name: "ZEC" },
  { symbol: "MON/USDT:USDT", name: "MON" },
  { symbol: "XPL/USDT:USDT", name: "XPL" },
  { symbol: "2Z/USDT:USDT", name: "2Z" },
  { symbol: "EURUSD/USDT:USDT", name: "EURUSD" },
  { symbol: "USDJPY/USDT:USDT", name: "USDJPY" },
  { symbol: "XAU/USDT:USDT", name: "XAU" },
  { symbol: "XAG/USDT:USDT", name: "XAG" },
  { symbol: "PLATINUM/USDT:USDT", name: "PLATINUM" },
  { symbol: "CL/USDT:USDT", name: "CL" },
  { symbol: "SP500/USDT:USDT", name: "SP500" },
  { symbol: "NVDA/USDT:USDT", name: "NVDA" },
  { symbol: "TSLA/USDT:USDT", name: "TSLA" },
  { symbol: "GOOGL/USDT:USDT", name: "GOOGL" },
  { symbol: "PLTR/USDT:USDT", name: "PLTR" },
  { symbol: "HOOD/USDT:USDT", name: "HOOD" },
  { symbol: "CRCL/USDT:USDT", name: "CRCL" },
] as const;

export const LAB_AVAILABLE_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h"] as const;

export const insertLabStrategyBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  pineScript: z.string().min(1),
  parsedInputs: z.any(),
  groups: z.any().optional(),
  strategySettings: z.any().optional(),
});

export const updateLabStrategyBodySchema = insertLabStrategyBodySchema.partial();

export const labOptimizationConfigSchema = z.object({
  pineScript: z.string().min(1),
  parsedInputs: z.array(z.any()),
  tickers: z.array(z.string()).min(1),
  timeframes: z.array(z.string()).min(1),
  startDate: z.string(),
  endDate: z.string(),
  randomSamples: z.number().default(900),
  topK: z.number().default(20),
  refinementsPerSeed: z.number().default(60),
  minTrades: z.number().default(10),
  maxDrawdownCap: z.number().default(85),
  minAvgBarsHeld: z.number().default(1),
  mode: z.enum(["smoke", "sweep"]),
  strategyId: z.number().optional(),
  engineType: z.string().optional(),
  useInsights: z.boolean().optional(),
  deepSearch: z.boolean().optional(),
  coordinateTune: z.boolean().optional(),
});
