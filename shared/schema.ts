import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean, jsonb, unique, uniqueIndex, json, index, serial, real, check } from "drizzle-orm/pg-core";
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
  vaultEnabled: boolean("vault_enabled").notNull().default(false),
  vaultDefaultAsset: text("vault_default_asset"),
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

  // Task 201: admin-managed whitelist for QuantumLab Assistant "hands-off" auto mode.
  // When true, the deterministic auto-grind loop AUTO-APPROVES its paid LLM steps
  // (create/improve) instead of parking on a confirm chip — all other Task #200 caps
  // (spend cap, 90% guard, ≤3 improve, maxAutoSteps, instant Stop, key-pause) still
  // apply. Flipped ONLY by an admin; the orchestrator re-checks it live (fail-closed)
  // before every auto-approval, so de-whitelisting drops a run back to watched mode.
  handsOffApproved: boolean("hands_off_approved").default(false).notNull(),

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

  // Phase 4b (Flash agent-HD wallets): monotonic allocator for per-bot HD wallet
  // indices. Allocated burn-on-allocate (incremented atomically at bot creation,
  // NEVER decremented or reused, even after a bot is deleted) so the agent seed +
  // a non-secret index always maps to exactly one wallet. Its high-water mark also
  // bounds the recovery scan after data loss.
  nextBotDerivationIndex: integer("next_bot_derivation_index").default(1).notNull(),

  // Derivation slots that were once flagged as orphaned (a burned index with no
  // trading_bots row) but have since been VERIFIED EMPTY — either swept clean by
  // orphan-recovery or confirmed to belong to a live bot (index drift). Excluded
  // from the "stranded funds" indicator so the recovery button disappears once
  // there is nothing left to recover, instead of lingering on a permanently-burned
  // (but now empty) slot. Append-only; an index is only added after a CONFIRMED
  // zero-balance read (reads fail closed → never marked on an unreadable balance).
  recoveredOrphanIndices: integer("recovered_orphan_indices").array().notNull().default([]),

  // QuantumLab AI Strategy Creator (Task 187): the user's OWN OpenRouter API key
  // (BYO), encrypted with the V3 envelope under the LLM_API_KEY subkey + AAD. It is
  // UMK-wrapped ONLY — NEVER SERVER_EXECUTION_KEY-wrapped — so it is decryptable only
  // during a live interactive session. Plaintext is never returned to the client; the
  // UI sees `last4` only. `provider` is informational (e.g. "openrouter").
  llmApiKeyEncrypted: text("llm_api_key_encrypted"),
  llmApiKeyLast4: text("llm_api_key_last4"),
  llmApiKeyProvider: text("llm_api_key_provider"),
  llmApiKeyUpdatedAt: timestamp("llm_api_key_updated_at"),

  // AI Trader (Agentic Trader plan §8/WO-7) — free paper-trial counter. A
  // wallet with no BYO OpenRouter key gets up to FREE_PAPER_TRIAL_LIMIT
  // /analyze calls on the platform's own OpenRouter key, paper bots only,
  // never live. Incremented atomically (WHERE ... < limit) so concurrent
  // requests can't exceed the cap.
  aiTraderFreeCallsUsed: integer("ai_trader_free_calls_used").notNull().default(0),

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

  // Auto-repark idle funds: when ON (persistent per-bot setting), after a position
  // FULLY closes the bot's spare USDC is automatically parked into a yield
  // stablecoin (Flash per-bot wallets only — Pacifica is account-level + fee'd, so
  // it stays manual). `autoParkDueAt` is the server-managed debounce deadline: set
  // when a position closes, cleared when a new position opens; a periodic scanner
  // reparks once it passes AND the bot is re-verified flat. See
  // server/vault/auto-repark.ts.
  autoParkIdle: boolean("auto_park_idle").default(false).notNull(),
  autoParkDueAt: timestamp("auto_park_due_at"),
  // Per-bot park DESTINATION: the yield asset (key from server/vault/yield-assets.ts)
  // the user picked as this bot's parking default. NULL = legacy inference (top up the
  // currently-held asset, else the account default). When set on a Flash bot it is
  // AUTHORITATIVE: the auto-repark/migration executor parks here and migrates any
  // parked funds held in a different asset into it. Flash-only (per-bot isolated
  // wallet); Pacifica picker stays a local manual selector.
  parkDestinationAsset: text("park_destination_asset"),
  // On-open unpark MODE (Flash per-bot vaults). TRUE (default = safest): when a
  // position opens, ALL parked funds are pulled back so the full equity buffer backs
  // the trade (parking can never strip the cushion that keeps it off liquidation).
  // FALSE ("spare only"): pull back just the margin the trade needs; the rest keeps
  // earning, leaving a thinner buffer. Flat-parking is identical in both modes — this
  // only governs the on-open unpark AMOUNT. See computeTradeSizingAndTopUp.
  vaultAllOut: boolean("vault_all_out").default(true).notNull(),

  // Defend-the-loan auto collateral top-up (Flash per-bot borrow positions only).
  // When ON (opt-in, default OFF), a periodic scanner tops up the bot's borrow
  // collateral from the ACCOUNT agent wallet (swapping if needed) to restore a
  // safe LTV whenever the position drifts into the alert band — the same "Add
  // Collateral" action the user can trigger manually from the loan card. OFF =
  // fully manual. See server/vault/jupiter-lend-perbot-carve.ts (runPerbotCollateralTopUp).
  autoCollateralTopUp: boolean("auto_collateral_top_up").default(false).notNull(),

  // Defend-the-loan auto repay (Flash per-bot borrow positions only). When ON
  // (opt-in, default OFF), the same scanner may pay a bot loan's debt DOWN from
  // the BOT wallet's own idle USDC (never trading collateral in the venue) to
  // restore a safe LTV — used when a collateral top-up is not possible (the
  // account wallet holds no spare collateral). OFF = fully manual. See
  // server/vault/auto-topup.ts (decideAutoRepay) and
  // server/vault/jupiter-lend-borrow-executor.ts (repayPartialOnExistingBotPosition).
  autoRepayEnabled: boolean("auto_repay_enabled").default(false).notNull(),

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

  // Phase 4b (Flash agent-HD wallets): for independent_trader bots whose per-bot
  // wallet is derived from the owner's agent seed at m/44'/501'/<derivationIndex>'/0'.
  // derivationIndex is the non-secret, monotonic, never-reused HD index; NULL marks a
  // legacy random-keypair bot (recoverable only via its stored encrypted blob).
  // derivationPathVersion pins the path scheme so a future change can't strand a bot —
  // recovery always re-derives on the bot's own version. The two are set together
  // (both NULL = random; both non-null = agent_hd), enforced by trading_bots_derivation_dual_model.
  derivationIndex: integer("derivation_index"),
  derivationPathVersion: integer("derivation_path_version"),

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
  // Phase 4b (Flash agent-HD wallets): fund-safety invariants. Postgres treats NULL
  // as distinct in UNIQUE, so legacy random bots (NULL index) never collide; two
  // agent_hd bots can never share a derived wallet on the same owner.
  unique("trading_bots_wallet_derivation_index_unique").on(table.walletAddress, table.derivationIndex),
  check(
    "trading_bots_derivation_index_positive",
    sql`${table.derivationIndex} IS NULL OR ${table.derivationIndex} >= 1`,
  ),
  check(
    "trading_bots_derivation_dual_model",
    sql`(${table.derivationIndex} IS NULL AND ${table.derivationPathVersion} IS NULL) OR (${table.derivationIndex} IS NOT NULL AND ${table.derivationPathVersion} IS NOT NULL)`,
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
  autoParkDueAt: true, // server-managed debounce deadline, never client-set
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
  protocol: text("protocol"),
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
}, (table) => ([
  // WO-15A: supports batch financial-enrichment per-bot GROUP BY queries.
  // Rollback: DROP INDEX IF EXISTS idx_equity_events_bot_created
  index("idx_equity_events_bot_created").on(table.tradingBotId, table.createdAt.desc()),
]));

export const insertEquityEventSchema = createInsertSchema(equityEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertEquityEvent = z.infer<typeof insertEquityEventSchema>;
export type EquityEvent = typeof equityEvents.$inferSelect;

// Phase 0a Vaults: per-wallet parked yield-asset positions. The on-chain token
// balance is the display source of truth; this row is the cost-basis accounting
// cache. One row per (wallet, asset). assetKey is a stable registry key from
// server/vault/yield-assets.ts, never a raw mint or symbol.
export const vaultPositions = pgTable("vault_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  // Scope (Phase 4): NULL = account-level vault (the main agent wallet). Non-null
  // = a specific bot's own per-bot wallet (Flash independent_trader model). Plain
  // column, no FK on purpose: on-chain is truth, so an orphan cost-basis row left
  // after a bot is deleted is benign clutter, never a money error.
  tradingBotId: varchar("trading_bot_id"),
  assetKey: text("asset_key").notNull(),
  mint: text("mint").notNull(),
  // Current parked balance in token base units (raw integer string).
  tokenAmountRaw: text("token_amount_raw").notNull().default('0'),
  // Cumulative USDC spent for the current holding (average-cost basis).
  usdcCostBasis: decimal("usdc_cost_basis", { precision: 20, scale: 6 }).notNull().default('0'),
  status: text("status").notNull().default('active'),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Account-scope rows (trading_bot_id IS NULL): one row per (wallet, asset).
  // This partial index reproduces the old blanket unique for existing rows.
  uniqueAccountAsset: uniqueIndex("vault_positions_account_unique")
    .on(table.walletAddress, table.assetKey)
    .where(sql`trading_bot_id IS NULL`),
  // Per-bot-scope rows: one row per (wallet, bot, asset).
  uniqueBotAsset: uniqueIndex("vault_positions_bot_unique")
    .on(table.walletAddress, table.tradingBotId, table.assetKey)
    .where(sql`trading_bot_id IS NOT NULL`),
  botIdx: index("idx_vault_positions_bot").on(table.tradingBotId).where(sql`trading_bot_id IS NOT NULL`),
}));

export const insertVaultPositionSchema = createInsertSchema(vaultPositions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVaultPosition = z.infer<typeof insertVaultPositionSchema>;
export type VaultPosition = typeof vaultPositions.$inferSelect;

// Vaults borrow engine (Phase A scaffold → Phase C reads). DB-cache of borrow
// positions opened against LST collateral via a lending venue (Jupiter Lend on
// Fluid). On-chain is the single source of truth (mirrors vaultPositions); these
// rows are a cache + audit trail, never the authority for a money decision.
// Mirrors the idempotent DDL in server/db.ts (CREATE TABLE IF NOT EXISTS
// borrow_positions / borrow_operations) so db:push sees no drift. Columns are
// policy-neutral: the hard max-LTV cap and fee model live in borrow-risk-policy.ts,
// never in this schema. No writers yet — Phase C wires read-only paths only.
export const borrowPositions = pgTable("borrow_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  // NULL = account-level borrow; non-null = a specific bot's per-bot wallet.
  tradingBotId: varchar("trading_bot_id"),
  debtVenue: text("debt_venue").notNull(),
  venueVaultId: text("venue_vault_id"),
  // The venue's own position identifier (Jupiter Lend position NFT id). Minted at
  // open; required to repay/close/monitor the EXACT position later. Null until the
  // open transaction confirms and the venue assigns it.
  venuePositionId: text("venue_position_id"),
  collateralAssetKey: text("collateral_asset_key").notNull(),
  collateralMint: text("collateral_mint").notNull(),
  collateralAmountRaw: text("collateral_amount_raw").notNull().default('0'),
  debtAssetKey: text("debt_asset_key").notNull().default('usdc'),
  debtMint: text("debt_mint").notNull(),
  debtAmountRaw: text("debt_amount_raw").notNull().default('0'),
  attributedBotId: varchar("attributed_bot_id"),
  // Discriminator between position families sharing this table:
  //   'borrow' — LST collateral → stable debt (the shipped account/per-bot engine).
  //   'loop'   — leveraged LST staking loop (LST collateral → WSOL debt, SOL Loop Vault).
  // Loop rows MUST be excluded from borrow-only machinery (auto-topup defense,
  // USD exposure caps, NFT reuse scans, borrow UI reads) — filter on kind there.
  kind: text("kind").notNull().default('borrow'),
  status: text("status").notNull().default('pending'),
  // Last health read cached for display/monitoring. On-chain remains authority.
  healthSnapshot: jsonb("health_snapshot").$type<{
    healthFactor?: number | null;
    ltv?: number | null;
    collateralValueUsd?: number | null;
    debtUsd?: number | null;
    source?: string;
    [k: string]: unknown;
  } | null>(),
  healthAsOf: timestamp("health_as_of"),
  healthSource: text("health_source"),
  // Borrow-health alert state machine (FC-2 monitor). Durable so band-crossing
  // Telegram alerts survive restarts and never repeat for the same band.
  // lastHealthAlertBand = the worst band we have NOTIFIED on; lastObservedHealthBand
  // + healthBandChangedAt drive anti-flap hysteresis before the baseline lowers.
  lastObservedHealthBand: text("last_observed_health_band"),
  healthBandChangedAt: timestamp("health_band_changed_at"),
  lastHealthAlertBand: text("last_health_alert_band"),
  lastHealthAlertAt: timestamp("last_health_alert_at"),
  // Autonomous "defend the loan" auto top-up throttle. Set to NOW() each time the
  // scanner claims this position for an auto-defense attempt; the atomic claim only
  // succeeds once per cooldown window, so a still-urgent loan can't re-fire every
  // scan tick. NULL = never auto-attempted.
  lastAutoTopupAttemptAt: timestamp("last_auto_topup_attempt_at"),
  // SOL Loop Vault P3 brain state (kind='loop' rows ONLY; null on borrow rows).
  // 'levered' = carries WSOL debt (numeric HF, safety-tick eligible);
  // 'holding' = collateral stays SUPPLIED with ZERO debt (HF null — must NEVER
  // be fed to keeper decideDeleverage). Transitions are ONLY written by the
  // executor legs after on-chain verification, with the deciding reason.
  policyState: text("policy_state"),
  policyReason: text("policy_reason"),
  policyStateChangedAt: timestamp("policy_state_changed_at"),
  // SOL Loop Vault P3 safety-tick throttle (kind='loop' rows). Stamped by the
  // atomic per-position claim before an autonomous reduce/unwind attempt, so a
  // still-unhealthy loop re-fires at most once per cooldown window (mirrors
  // lastAutoTopupAttemptAt on borrow rows). NULL = never policy-acted.
  lastPolicyActionAt: timestamp("last_policy_action_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  walletIdx: index("idx_borrow_positions_wallet").on(table.walletAddress),
  botIdx: index("idx_borrow_positions_bot").on(table.tradingBotId).where(sql`trading_bot_id IS NOT NULL`),
}));

export const insertBorrowPositionSchema = createInsertSchema(borrowPositions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBorrowPosition = z.infer<typeof insertBorrowPositionSchema>;
export type BorrowPosition = typeof borrowPositions.$inferSelect;

// Append-only AUDIT log of every multi-hop borrow/repay/carry operation, so the
// (future) money state machine is resumable + idempotent: unique operation id +
// per-step on-chain tx signatures + status/step. Mirrors the audited park/unpark
// safety model. No writers yet.
export const borrowOperations = pgTable("borrow_operations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  borrowPositionId: varchar("borrow_position_id"),
  operationType: text("operation_type").notNull(),
  // Caller-supplied idempotency key (one per logical user action). A retry of the
  // SAME logical op reuses the existing row instead of re-executing — the linchpin
  // of crash-safe multi-hop repays where a 5-min lock can't span the whole op.
  // UNIQUE per wallet (partial index, non-null only).
  clientRequestId: text("client_request_id"),
  status: text("status").notNull().default('pending'),
  // Resumable step. Single-tx ops use simple steps; multi-hop repays advance
  // through initialized -> transfer_confirmed -> swap_confirmed -> repay_confirmed
  // -> final_read, persisted BEFORE each on-chain action so a crash resumes from
  // the last CONFIRMED step (never re-spends a confirmed leg).
  step: text("step"),
  txSignatures: jsonb("tx_signatures").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Resume context: op params + per-step observed on-chain amounts (merged
  // progressively via jsonb `||`, never read-modify-write). On-chain stays the
  // authority; this is the crash-recovery breadcrumb, not a source of truth.
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  // Final, immutable result payload (so an idempotent re-request returns the same
  // answer without re-running the op).
  result: jsonb("result").$type<Record<string, unknown> | null>(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  walletIdx: index("idx_borrow_operations_wallet").on(table.walletAddress),
  positionIdx: index("idx_borrow_operations_position").on(table.borrowPositionId).where(sql`borrow_position_id IS NOT NULL`),
  clientReqIdx: uniqueIndex("uq_borrow_operations_client_req").on(table.walletAddress, table.clientRequestId).where(sql`client_request_id IS NOT NULL`),
}));

export const insertBorrowOperationSchema = createInsertSchema(borrowOperations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBorrowOperation = z.infer<typeof insertBorrowOperationSchema>;
export type BorrowOperation = typeof borrowOperations.$inferSelect;

// Fixed Yield vault: one row per open PT (principal token) holding bought on a
// fixed-rate venue (Exponent first). On-chain PT balance is the display truth;
// this row is the cost-basis + maturity bookkeeping cache. Ops audit through
// borrow_operations (operation_type 'fy_deposit' / 'fy_exit' / 'fy_redeem') so
// the multi-hop deposit (USDC -> underlying swap -> buy PT) is resumable and
// idempotent. Mirrors the idempotent DDL in server/db.ts.
export const fyPositions = pgTable("fy_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  venue: text("venue").notNull().default('exponent'),
  marketAddress: text("market_address").notNull(),
  venueVaultAddress: text("venue_vault_address"),
  ptMint: text("pt_mint").notNull(),
  ptDecimals: integer("pt_decimals").notNull().default(9),
  underlyingMint: text("underlying_mint").notNull(),
  underlyingSymbol: text("underlying_symbol").notNull(),
  // Current PT holding in base units (raw integer string).
  ptAmountRaw: text("pt_amount_raw").notNull().default('0'),
  // Cumulative USDC spent for the current holding.
  costBasisUsdc: decimal("cost_basis_usdc", { precision: 20, scale: 6 }).notNull().default('0'),
  // Implied APY at entry (fraction, e.g. 0.1585). Display-only.
  impliedApyAtEntry: decimal("implied_apy_at_entry", { precision: 10, scale: 6 }),
  maturityAt: timestamp("maturity_at").notNull(),
  status: text("status").notNull().default('active'),
  notifiedMaturityAt: timestamp("notified_maturity_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  walletIdx: index("idx_fy_positions_wallet").on(table.walletAddress),
}));

export const insertFyPositionSchema = createInsertSchema(fyPositions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFyPosition = z.infer<typeof insertFyPositionSchema>;
export type FyPosition = typeof fyPositions.$inferSelect;

// Phase 1 Vaults: yield-oracle price/rate snapshots. The yield oracle measures
// REALIZED APY per asset from the movement of its own on-chain price over time,
// never a protocol's projected/marketing rate. One row per (asset, sample):
//   - redemption_rate assets (Kamino, Jupiter Lend): priceUsdcPerToken is the
//     on-chain redemption rate (USDC per whole token), noise-free.
//   - market_quote assets (Perena USD*, ONyc, USDY): priceUsdcPerToken is a fixed
//     reference $1000 USDC->token buy quote, reduced to USDC per whole token.
// assetKey is the stable registry key from server/vault/yield-assets.ts. Rows are
// pruned past a bounded retention window; this table is display-only (no money).
export const yieldPriceSnapshots = pgTable("yield_price_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assetKey: text("asset_key").notNull(),
  // USDC value of one whole token at sample time. High precision; display-only.
  priceUsdcPerToken: decimal("price_usdc_per_token", { precision: 30, scale: 12 }).notNull(),
  asOf: timestamp("as_of").defaultNow().notNull(),
}, (table) => ({
  // Trailing-window reads scan one asset's series ordered by time.
  assetTimeIdx: index("idx_yield_price_snapshots_asset_time").on(table.assetKey, table.asOf),
}));

export const insertYieldPriceSnapshotSchema = createInsertSchema(yieldPriceSnapshots).omit({
  id: true,
  asOf: true,
});
export type InsertYieldPriceSnapshot = z.infer<typeof insertYieldPriceSnapshotSchema>;
export type YieldPriceSnapshot = typeof yieldPriceSnapshots.$inferSelect;

// Vaults yield oracle: last-good REAL APY per asset, sourced from an external yield
// index (DeFiLlama). Display-only (no money). One row per asset_key (upserted), so a
// cold process / restart can serve the last-known measured number immediately and the
// UI never regresses to an estimate when the upstream is briefly unreachable. apy is
// the headline shown; the component fields are kept for transparency/debugging.
export const yieldApyCache = pgTable("yield_apy_cache", {
  assetKey: text("asset_key").primaryKey(),
  apy: decimal("apy", { precision: 10, scale: 4 }),
  apyBase: decimal("apy_base", { precision: 10, scale: 4 }),
  apyReward: decimal("apy_reward", { precision: 10, scale: 4 }),
  apyMean30d: decimal("apy_mean_30d", { precision: 10, scale: 4 }),
  source: text("source").notNull(),
  poolId: text("pool_id"),
  asOf: timestamp("as_of").defaultNow().notNull(),
});

export const insertYieldApyCacheSchema = createInsertSchema(yieldApyCache).omit({
  asOf: true,
});
export type InsertYieldApyCache = z.infer<typeof insertYieldApyCacheSchema>;
export type YieldApyCache = typeof yieldApyCache.$inferSelect;

// SOL Loop Vault P3: hourly rate telemetry for the allocation tick. One row per
// (vault_id, sample time) — staking APY from DeFiLlama, WSOL borrow APR +
// withdraw-side utilization from the Jupiter Lend vaults API. All rate columns
// are FRACTIONS (0.08 = 8%), matching BorrowVaultConfig conventions; nullable
// per-field so a partial upstream outage still records what WAS readable (the
// allocation policy fails closed on nulls at read time). Display/telemetry +
// policy input — never a direct money gate; money paths re-read live. Rows are
// pruned past a bounded retention window (memory/disk hygiene).
export const loopRateSamples = pgTable("loop_rate_samples", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Jupiter Lend Multiply vault id (registry-pinned; symbol asserted at sample time).
  vaultId: integer("vault_id").notNull(),
  symbol: text("symbol").notNull(),
  // LST staking APY (fraction) from DeFiLlama; null = upstream unreadable this sample.
  stakingApy: decimal("staking_apy", { precision: 12, scale: 8 }),
  // Trailing 30d mean of the staking APY (fraction); smoother EV input when present.
  stakingApyMean30d: decimal("staking_apy_mean_30d", { precision: 12, scale: 8 }),
  // Vault WSOL borrow APR (fraction) from the lend vaults API.
  borrowApr: decimal("borrow_apr", { precision: 12, scale: 8 }),
  // Per-vault withdraw-side utilization (fraction 0..1); predicts unwind blockage.
  withdrawUtilization: decimal("withdraw_utilization", { precision: 8, scale: 6 }),
  // Vault liquidation threshold (fraction, e.g. 0.95) sampled from the same
  // decoded config the money paths use. Quasi-static venue config; lets the
  // allocation brain + vault ranking compute the DYNAMIC target leverage from
  // the table alone. null = unreadable → consumers fail closed (no target).
  liquidationThreshold: decimal("liquidation_threshold", { precision: 8, scale: 6 }),
  // Net carry at the reference 2x leverage: staking×2 − borrow×1 (fraction).
  // Derivable from the two rate columns; materialized so the P3 gate check and
  // admin views are one SQL pass with no app-side math.
  netCarry2x: decimal("net_carry_2x", { precision: 12, scale: 8 }),
  asOf: timestamp("as_of").defaultNow().notNull(),
}, (table) => ({
  // Latest-per-vault and trailing-window reads scan one vault's series by time.
  vaultTimeIdx: index("idx_loop_rate_samples_vault_time").on(table.vaultId, table.asOf),
}));

export const insertLoopRateSampleSchema = createInsertSchema(loopRateSamples).omit({
  id: true,
  asOf: true,
});
export type InsertLoopRateSample = z.infer<typeof insertLoopRateSampleSchema>;
export type LoopRateSample = typeof loopRateSamples.$inferSelect;

// SOL Loop Vault P3: append-only decision journal for the policy brain. EVERY
// tick evaluation persists one row — including outcome 'none' — so hysteresis
// streaks are derived from the last N rows in DB (survives restarts, no
// separate counter to desync) and the P3 observation gate is one SQL pass.
// Audit/telemetry only: rows are never a money gate; executors re-read live.
export const loopPolicyDecisions = pgTable("loop_policy_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().references(() => wallets.address, { onDelete: "cascade" }),
  // Null when the decision is not about one specific position (e.g. a re-lever
  // considered while flat, or a tick-level refusal such as stale rates).
  borrowPositionId: varchar("borrow_position_id"),
  vaultId: integer("vault_id").notNull(),
  // Which cadence produced it: 'safety' (60s reflex) | 'allocation' (~hourly EV).
  tick: text("tick").notNull(),
  // 'none' | 'reduce' | 'unwind_to_hold' | 'relever' | 'close' — what the policy
  // chose (NOT necessarily what executed; details carries the execution result).
  action: text("action").notNull(),
  // Fraction of the position the action applies to (reduce steps), null otherwise.
  fraction: decimal("fraction", { precision: 8, scale: 6 }),
  reason: text("reason").notNull(),
  // Free-form inputs snapshot: carry numbers, health factor, rate-sample age,
  // execution outcome (opId/signature/error) — whatever made the decision auditable.
  details: jsonb("details"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Hysteresis + gate checks scan one vault's recent decisions by time.
  vaultTimeIdx: index("idx_loop_policy_decisions_vault_time").on(table.vaultId, table.createdAt),
  walletIdx: index("idx_loop_policy_decisions_wallet").on(table.walletAddress),
}));

export const insertLoopPolicyDecisionSchema = createInsertSchema(loopPolicyDecisions).omit({
  id: true,
  createdAt: true,
});
export type InsertLoopPolicyDecision = z.infer<typeof insertLoopPolicyDecisionSchema>;
export type LoopPolicyDecision = typeof loopPolicyDecisions.$inferSelect;

// SOL Loop Vault P3 gate instrumentation: one row per completed tick pass so
// the observation-week gate can measure expected-vs-actual tick coverage from
// DB alone (decision rows only exist when there are candidates; heartbeats
// exist even when the platform holds zero loop positions). Telemetry only.
export const loopTickHeartbeats = pgTable("loop_tick_heartbeats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Which cadence beat: 'safety' (60s reflex scan) | 'allocation' (~hourly EV).
  tick: text("tick").notNull(),
  evaluated: integer("evaluated").notNull().default(0),
  acted: integer("acted").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tickTimeIdx: index("idx_loop_tick_heartbeats_tick_time").on(table.tick, table.createdAt),
}));

export const insertLoopTickHeartbeatSchema = createInsertSchema(loopTickHeartbeats).omit({
  id: true,
  createdAt: true,
});
export type InsertLoopTickHeartbeat = z.infer<typeof insertLoopTickHeartbeatSchema>;
export type LoopTickHeartbeat = typeof loopTickHeartbeats.$inferSelect;

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

// Admin "Errors" panel — system-critical errors at a glance (morning event-viewer style).
// BOUNDED & DEDUPED: rows are keyed by `fingerprint` (a stable hash of category + source +
// normalized message). Repeat occurrences upsert onto the same row, incrementing `count` and
// refreshing `lastSeen` instead of inserting new rows — so a runaway error can never flood the
// table. Auto-pruned by age (lastSeen) + a hard row cap (see storage.pruneErrors). Only
// genuinely-critical events are written here (crashes/500s, failed-after-retry trades,
// fund-safety, failed webhooks for active users, security/decryption) — NOT the console firehose.
export const errorLog = pgTable("error_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Stable dedup key: hash(category + source + normalized message). Volatile bits (ids, amounts,
  // addresses, tx sigs) are stripped before hashing so similar errors collapse onto one row.
  fingerprint: text("fingerprint").notNull().unique(),
  // Broad bucket: 'crash' | 'server_500' | 'trade_failed' | 'fund_safety' | 'webhook_failed' | 'security'.
  category: text("category").notNull(),
  // 'critical' (needs attention now) | 'error' (worth a look).
  severity: text("severity").notNull().default("error"),
  // Where it came from, e.g. '[Executor]', 'webhook', 'auth', 'unhandledRejection'.
  source: text("source"),
  // Human-readable one-liner (truncated). Latest occurrence wins.
  message: text("message").notNull(),
  // Optional stack / extra detail (truncated). Latest occurrence wins.
  detail: text("detail"),
  // Optional triage context (botId, market, txSig, walletAddress, status...) — NEVER secrets.
  context: jsonb("context"),
  // Dedup counter: how many times this fingerprint has fired.
  count: integer("count").default(1).notNull(),
  firstSeen: timestamp("first_seen").defaultNow().notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
  // Admin "I've handled this" flag; auto-reset to false when the error recurs.
  resolved: boolean("resolved").default(false).notNull(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => ({
  bySeverity: index("error_log_severity_idx").on(table.severity),
  byCategory: index("error_log_category_idx").on(table.category),
  byLastSeen: index("error_log_last_seen_idx").on(table.lastSeen),
  byResolved: index("error_log_resolved_idx").on(table.resolved),
}));

export const insertErrorLogSchema = createInsertSchema(errorLog).omit({
  id: true,
  count: true,
  firstSeen: true,
  lastSeen: true,
  resolved: true,
  resolvedAt: true,
});
export type InsertErrorLog = z.infer<typeof insertErrorLogSchema>;
export type ErrorLog = typeof errorLog.$inferSelect;

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
  // 5.5: nullable — venues without a numeric subaccount (e.g. Flash HD wallets)
  // identify the subaccount via protocolSubaccountId instead.
  driftSubaccountId: integer("drift_subaccount_id"),
  protocolSubaccountId: text("protocol_subaccount_id"),
  // 5.5: which protocol this owed share belongs to (e.g. 'pacifica', 'flash').
  // Nullable for legacy rows written before this column existed.
  protocol: text("protocol"),
  status: text("status").notNull().default("pending"), // pending, processing, paid, voided, deferred
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
  // HD-derivation metadata carried over from the bot that owned this subaccount.
  // On reuse the new bot MUST inherit the spare's ORIGINAL index (not a freshly
  // allocated one) so the seed fallback re-derives the SAME on-chain pubkey. NULL
  // for legacy random-key spares → the reused bot stays blob-only (no worse than before).
  derivationIndex: integer("derivation_index"),
  derivationPathVersion: integer("derivation_path_version"),
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
  // Validity (Task 188): out-of-sample holdout fraction actually used for this
  // run (0..0.9). NULL = legacy run (no holdout). Stored explicitly for display;
  // the worker reads it from configSnapshot so resume stays window-consistent.
  oosFraction: real("oos_fraction"),
  // Fidelity (Task 188): per-side slippage (fraction of notional) charged this
  // run. NULL = legacy run (no friction record).
  slippage: real("slippage"),
  // Fidelity (Task 188): run-level engine self-consistency (compiled vs
  // interpreter), aggregated across Pine combos. NULL = not evaluated (native
  // engines, or legacy run). parityDiffs holds a small sample of divergences.
  parityMatch: boolean("parity_match"),
  parityDiffs: jsonb("parity_diffs").$type<string[]>(),
  // --- QuantumLab Sandbox Agent (Phase A): agent ownership + idempotency. ---
  // NULL on every non-agent run (manual / UI runs). When an agent task queues a
  // run these link it back to the owning task and make a resumed task safe to
  // retry: the same (user_id, agent_task_id, agent_idempotency_key) maps to ONE
  // run (enforced by a partial UNIQUE index in server/db.ts), so a reconnect can
  // never double-queue on the single shared worker. Runs stay the source of truth.
  agentTaskId: integer("agent_task_id"),
  agentIdempotencyKey: text("agent_idempotency_key"),
  agentCorrelationId: text("agent_correlation_id"),
  agentOwned: boolean("agent_owned").notNull().default(false),
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
  // Validity (Task 188): in-sample / out-of-sample partition metrics. NULL on
  // legacy rows and on holdout-disabled runs. Primary columns above remain the
  // FULL-period numbers (unchanged headline + equity curve); these add the
  // robustness story (the optimizer fit on isMetrics' window and is validated
  // on oosMetrics' window). See LabWindowMetrics / LabOosMetrics.
  isMetrics: jsonb("is_metrics").$type<LabWindowMetrics>(),
  oosMetrics: jsonb("oos_metrics").$type<LabOosMetrics>(),
});

export const labInsightsReports = pgTable("lab_insights_reports", {
  id: serial("id").primaryKey(),
  strategyId: integer("strategy_id").notNull(),
  reportData: jsonb("report_data").notNull(),
  totalResults: integer("total_results"),
  totalRuns: integer("total_runs"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- QuantumLab Sandbox Agent (Phase A): durable task state. ---
// One row per agent chat/auto task: the agent's small, structured working memory
// — its goal, its plan checklist, which runs it owns, and the leash counters
// (loop_count, spend_estimate_usd). Reconciliation (§7b) treats lab_optimization_runs
// as the source of truth; this table holds ONLY the agent's own intent and
// bookkeeping, never trade or position data. Wallet-scoped on every access (§8).
export const labAgentTasks = pgTable("lab_agent_tasks", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  // active | awaiting_input | paused | completed | stopped | failed
  status: text("status").notNull().default("active"),
  // chat | auto (hands-off mode is gated by an admin whitelist — later phase)
  mode: text("mode").notNull().default("chat"),
  goal: text("goal"),
  plan: jsonb("plan").$type<Record<string, unknown>>(),
  memory: jsonb("memory").$type<Record<string, unknown>>(),
  // The currently-running owned run, if any (one-active-run gate, §7).
  activeRunId: integer("active_run_id"),
  // Denormalized CACHE of this task's owned run ids, self-healed by the reconciler.
  // NOT the source of truth — the reconciler derives owned runs from the run rows
  // themselves (agent_task_id + agent_owned, wallet-scoped). Display/convenience only.
  ownedRunIds: jsonb("owned_run_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  // Auto-loop leash counter (§7).
  loopCount: integer("loop_count").notNull().default(0),
  // Cumulative LLM spend estimate in USD (leash, §7).
  spendEstimateUsd: real("spend_estimate_usd").notNull().default(0),
  stopReason: text("stop_reason"),
  lastReconciledAt: timestamp("last_reconciled_at"),
  // When the task entered awaiting_input — basis for the idle-ONLY pause TTL (§7b).
  awaitingSince: timestamp("awaiting_since"),
  cancelRequestedAt: timestamp("cancel_requested_at"),
  // = LAB_AGENT_TOOLKIT_VERSION at creation; lets a future contract bump migrate forward.
  toolkitVersion: integer("toolkit_version").notNull().default(1),
  // --- Phase C turn-loop orchestration (server/lab-agent/orchestrator.ts). ---
  // The DB is the source of truth so a turn can be safely resumed after a crash
  // or reconnect. turn_state: ready | running_turn | waiting_for_tool.
  turnState: text("turn_state").notNull().default("ready"),
  // Single-flight CAS lease: the turn runner that wins the CAS owns the task; a
  // second concurrent runner loses and no-ops. Expiry lets a crashed turn reclaim.
  turnLease: text("turn_lease"),
  turnLeaseExpiresAt: timestamp("turn_lease_expires_at"),
  // When the current turn_state was entered — basis for a stuck-turn watchdog.
  turnStateChangedAt: timestamp("turn_state_changed_at"),
  // Monotonic step counter; feeds the per-step idempotency key derivation so a
  // resumed turn can never re-enqueue a tool it already ran.
  stepIndex: integer("step_index").notNull().default(0),
  // Two-phase record of the in-flight async tool step: persisted as
  // {phase:'executing',…} BEFORE the write tool is called, so crash recovery
  // replays the STORED tool (not the brain), then flipped to {phase:'waiting',…}
  // with the queued runId. Null when no async step is pending.
  currentStep: jsonb("current_step").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lab_agent_tasks_wallet_status").on(table.walletAddress, table.status),
]);

// A chip the assistant can attach to a message (§11 option bubbles). `navigate`
// switches a QuantumLab tab client-side; `send` posts a predefined follow-up;
// `reconnect` re-signs the wallet in place to reload the session UMK (needs neither
// message nor tab) — used when a saved key is present but the idle session can't
// unlock it.
export const agentSuggestedActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["send", "navigate", "reconnect"]),
  message: z.string().optional(),
  tab: z.string().optional(),
});
export type AgentSuggestedAction = z.infer<typeof agentSuggestedActionSchema>;

// Chat transcript for a Lab Assistant task (Phase B). Wallet-scoped through the
// owning lab_agent_tasks row on every access (§8) — never by task id alone.
export const labAgentMessages = pgTable("lab_agent_messages", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull(),
  // user | agent | tool
  role: text("role").notNull(),
  content: text("content").notNull(),
  // Server-authored option bubbles ([] for plain replies / user messages).
  suggestedActions: jsonb("suggested_actions").$type<AgentSuggestedAction[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lab_agent_messages_task_created").on(table.taskId, table.createdAt, table.id),
]);

export const insertLabAgentMessageSchema = createInsertSchema(labAgentMessages).omit({ id: true, createdAt: true });
export type LabAgentMessage = typeof labAgentMessages.$inferSelect;
export type InsertLabAgentMessage = z.infer<typeof insertLabAgentMessageSchema>;

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

// HERMES_EXIT_PLAN Phase 3b: on-chain Pyth price snapshots (26h ring).
// Append-only observational table — no foreign keys, no money-path reads.
export const oraclePriceSnapshots = pgTable("oracle_price_snapshots", {
  id: serial("id").primaryKey(),
  feedId: text("feed_id").notNull(),
  symbol: text("symbol").notNull(),
  priceUsd: real("price_usd").notNull(),
  publishTimeSec: integer("publish_time_sec").notNull(),
  takenAt: timestamp("taken_at").notNull().defaultNow(),
  source: text("source").notNull().default("onchain"),
}, (table) => [
  index("idx_oracle_snapshots_feed_taken").on(table.feedId, table.takenAt),
]);

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

export const insertLabAgentTaskSchema = createInsertSchema(labAgentTasks).omit({ id: true, createdAt: true, updatedAt: true });
export type LabAgentTask = typeof labAgentTasks.$inferSelect;
export type InsertLabAgentTask = z.infer<typeof insertLabAgentTaskSchema>;

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
  // Validity (Task 188): out-of-sample holdout fraction (0..0.9). The optimizer
  // searches/selects on the in-sample head slice and validates on the OOS tail.
  // 0/undefined disables the split (legacy full-window behavior). Drives resume
  // window selection via the run's config snapshot.
  outOfSampleFraction?: number;
  // Fidelity (Task 188): per-side slippage as a fraction of notional (same units
  // as commission). Charged round-trip at close. Undefined → engine default (0).
  slippage?: number;
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

// Validity (Task 188): trade-level metrics for an in-sample or out-of-sample
// partition. maxDrawdownPercent here is APPROXIMATE — computed from the per-trade
// equity path (close-to-close on trade boundaries), NOT intrabar, because the
// partition is derived by splitting the full run's trade list by entry time and
// has no intrabar equity to walk. Net profit IS exact: sizing is fixed-notional
// (engine charges qty*positionSize; equity does not compound), so summing
// pnlDollar / initialCapital matches the engine's netProfitPercent semantics.
export interface LabWindowMetrics {
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  totalTrades: number;
  sharpeRatio: number;
}

// Out-of-sample partition. `sufficient` is false when the OOS window had too few
// bars or trades to conclude anything — surfaced as "insufficient" rather than a
// misleading number (the optimizer never optimized on this window).
export interface LabOosMetrics extends LabWindowMetrics {
  sufficient: boolean;
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
  // Validity (Task 188): in-sample vs out-of-sample partition. Populated only
  // when the run used a holdout (oosFraction > 0) and the combo produced trades;
  // legacy / holdout-disabled runs leave them undefined.
  is?: LabWindowMetrics;
  oos?: LabOosMetrics;
  // Fidelity (Task 188): per-combo engine self-consistency (compiled vs
  // interpreter), aggregated to run level for display. Pine strategies only.
  parity?: { match: boolean; diffs: string[] };
}

export interface LabCheckpoint {
  completedCombos: string[];
  configSnapshot: LabOptimizationConfig;
  // Per-combo terminal disposition reported by the worker. Lets run
  // finalization distinguish a legitimately empty combo (no candle data, or
  // no parameter set met the trade filters) from a genuine missing/lost
  // combo. Persisted in the checkpoint so it survives resume.
  comboDispositions?: Record<string, { status: "ok" | "no-trades" | "data-unavailable"; reason?: string }>;
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

export const LAB_AVAILABLE_TIMEFRAMES = ["1m", "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "12h", "1d"] as const;

export const insertLabStrategyBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  pineScript: z.string().min(1),
  parsedInputs: z.any(),
  groups: z.any().optional(),
  strategySettings: z.any().optional(),
});

export const updateLabStrategyBodySchema = insertLabStrategyBodySchema.partial();

// AI Trader (Agentic Trader plan, docs/AGENTIC_TRADER_PLAN.md §7 — single source
// of truth for both tables below). WO-2: schema + storage only; no routes/
// executor/monitor wiring yet.
export const aiTraderBots = pgTable("ai_trader_bots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull(),
  protocol: text("protocol").notNull(),
  protocolSubaccountId: text("protocol_subaccount_id"),
  // WO-7.1 go-live: the bot's OWN venue subaccount key (V3 ciphertext, AAD-bound
  // to walletAddress + this row's id — same encryptBotSubaccountKeyV3 envelope as
  // trading_bots). Live trades are signed with THIS key (each Pacifica subaccount
  // is its own account); the unsigned `subaccount_id` body field is never relied on.
  botSubaccountKeyEncryptedV3: text("bot_subaccount_key_encrypted_v3"),
  // HD derivation metadata (seed-fallback recoverability, mirrors trading_bots).
  derivationIndex: integer("derivation_index"),
  derivationPathVersion: integer("derivation_path_version"),
  market: text("market").notNull(),
  timeframe: text("timeframe").notNull(),              // '15m'|'1h'|'4h'|'1d'
  mode: text("mode").notNull().default("suggest"),      // 'suggest' | 'auto'
  riskProfile: text("risk_profile").notNull().default("guarded"), // 'guarded' | 'degen' (§5a)
  paperMode: boolean("paper_mode").notNull().default(true),       // flips false only via go-live (§2e gate)
  autoNext: boolean("auto_next").notNull().default(false),
  model: text("model").notNull().default("anthropic/claude-opus-4.8"),
  allocatedUsdc: decimal("allocated_usdc", { precision: 20, scale: 2 }).notNull(),
  maxLeverage: integer("max_leverage").notNull().default(3),
  // Exit management seam — 'static' (exchange-native setTpSl bracket, MVP) or a
  // stop personality from INTELLIGENT_STOPS_PLAN.md once the Watchdog ships
  // (e.g. 'breakeven_ladder', 'atr_trail'). The executor branches on this; the
  // native bracket ALWAYS exists as the safety net either way (G10 invariant).
  stopPolicy: text("stop_policy").notNull().default("static"),
  // risk-based-sizing-spec Phase A: optional confidence-scaled fixed-fractional
  // sizing. 'discretionary' (default) keeps the model-picked sizePct path;
  // 'risk_based' replaces ONLY the G5 margin derivation in guardrails.ts —
  // each trade risks riskPct% of min(allocation, live equity)×0.95, sized off
  // the actual stop distance, leverage auto-minimized. Off for existing bots.
  // Deliberately OUTSIDE the policyHmac envelope (like paperMode): worst-case
  // notional ≤ base × Lmax ≤ allocatedUsdc × maxLeverage, the sealed cap.
  sizingMode: text("sizing_mode").notNull().default("discretionary"), // 'discretionary' | 'risk_based'
  riskMinPct: decimal("risk_min_pct", { precision: 5, scale: 2 }).notNull().default("0.50"),
  riskMaxPct: decimal("risk_max_pct", { precision: 5, scale: 2 }).notNull().default("1.50"),
  // Flash-only (idle-funds Vault parking; Pacifica excluded — $10 min deposit/
  // withdrawal + $1 withdrawal fee kills yield). Default false; UI shows the
  // toggle only when the selected protocol supports parking.
  parkWhenIdle: boolean("park_when_idle").notNull().default(false),
  // Paper graduation (§2e). Bot-type-agnostic shape so the evaluator can later
  // wrap regular tradingBots (Phase 4 platform rollout).
  graduationState: text("graduation_state").notNull().default("in_trial"),
  // 'in_trial' | 'graduated' | 'failed' | 'waived'  (waived = admin/founder override)
  graduationCriteria: jsonb("graduation_criteria").notNull(),
  // { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 } — floors enforced server-side
  trialStartedAt: timestamp("trial_started_at").defaultNow(),
  graduatedAt: timestamp("graduated_at"),
  policyHmac: text("policy_hmac").notNull(),
  status: text("status").notNull().default("idle"),
  // 'idle'|'analyzing'|'proposed'|'executing'|'open'|'paused'|'stopped'
  // 'executing' is a transient crash-safety state (external audit, Qwen #1): set BEFORE the
  // entry order is sent, cleared to 'open' only after the bracket is verified. Startup
  // reconciliation treats any 'executing'/'analyzing'/'proposed' bot as potentially holding
  // a live position and checks the exchange (WO-6 step 5).
  pauseReason: text("pause_reason"),
  dailyRealizedPnl: decimal("daily_realized_pnl", { precision: 20, scale: 2 }).default("0"),
  consecutiveLosses: integer("consecutive_losses").notNull().default(0),
  // Reflection-playbook (reflection-playbook-spec.md Phase A — accumulate-only).
  // Injection into context-builder is gated behind the calibration precondition
  // and the structure-bricks keep-gate review; context-builder must NOT be touched
  // until both gates clear. Plain-text entries written by the model, rendered
  // verbatim. Managed server-side only; never client-set at bot creation.
  playbook: jsonb("playbook"),
  playbookVersion: integer("playbook_version").notNull().default(0),
  playbookUpdatedAt: timestamp("playbook_updated_at"),
  // WO-B: 'fixed' (existing behaviour) or 'scanner' (the bot picks from the
  // shortlist each 15m boundary). Default 'fixed' so all existing bots are
  // byte-identical to today. Scanner bots keep market/timeframe NOT NULL:
  // creation uses placeholder SOL-PERP/15m; each pick WRITES the chosen
  // values before the decision runs so all downstream readers work unmodified.
  marketSource: text("market_source").notNull().default("fixed"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_ai_trader_bots_wallet").on(table.walletAddress),
  index("idx_ai_trader_bots_status").on(table.status),
]);

export const aiTraderDecisions = pgTable("ai_trader_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  botId: varchar("bot_id").references(() => aiTraderBots.id, { onDelete: 'cascade' }),
  // Full audit trail: what the AI saw, said, and what actually happened
  contextDigest: jsonb("context_digest"),               // compact snapshot of inputs (not full candles)
  rawDecision: jsonb("raw_decision").notNull(),          // as returned by the model
  clampedDecision: jsonb("clamped_decision"),            // after guardrails (null if rejected)
  guardrailViolations: jsonb("guardrail_violations"),    // which G-rules fired
  outcome: text("outcome"),
  // 'executed'|'user_skipped'|'rejected_guardrails'|'flat'|'aborted_malformed'|'aborted_stale'|'aborted_funding'|'expired'
  // Execution + result (filled in over the trade's life)
  entryPrice: decimal("entry_price", { precision: 20, scale: 8 }),
  exitPrice: decimal("exit_price", { precision: 20, scale: 8 }),
  exitReason: text("exit_reason"),                       // 'sl'|'tp'|'ai_close'|'user_close'|'circuit_breaker'|'liquidation'
  realizedPnl: decimal("realized_pnl", { precision: 20, scale: 2 }),
  feesPaid: decimal("fees_paid", { precision: 20, scale: 6 }),
  llmCostUsd: decimal("llm_cost_usd", { precision: 10, scale: 6 }),
  llmLatencyMs: integer("llm_latency_ms"),
  modelUsed: text("model_used"),
  decidedAt: timestamp("decided_at").defaultNow(),
  closedAt: timestamp("closed_at"),
}, (table) => [
  index("idx_ai_trader_decisions_bot_decided").on(table.botId, table.decidedAt.desc()),
]);

export const insertAiTraderBotSchema = createInsertSchema(aiTraderBots).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  trialStartedAt: true, // server-set at creation (§2e trial start)
  graduatedAt: true,    // server-set on graduation, never client-set
}).superRefine((b, ctx) => {
  // risk-based-sizing-spec Phase A: 0.1 <= riskMinPct <= riskMaxPct <= 3.0.
  // Decimal columns are strings in drizzle-zod, so validate numerically here.
  if (b.sizingMode !== undefined && b.sizingMode !== "discretionary" && b.sizingMode !== "risk_based") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sizingMode"],
      message: "sizingMode must be 'discretionary' or 'risk_based'",
    });
  }
  const min = b.riskMinPct !== undefined ? Number(b.riskMinPct) : undefined;
  const max = b.riskMaxPct !== undefined ? Number(b.riskMaxPct) : undefined;
  if (min !== undefined && (!Number.isFinite(min) || min < 0.1 || min > 3.0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["riskMinPct"],
      message: "riskMinPct must be a number between 0.1 and 3.0",
    });
  }
  if (max !== undefined && (!Number.isFinite(max) || max < 0.1 || max > 3.0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["riskMaxPct"],
      message: "riskMaxPct must be a number between 0.1 and 3.0",
    });
  }
  if (min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["riskMinPct"],
      message: "riskMinPct must be <= riskMaxPct",
    });
  }
});
export type AiTraderBot = typeof aiTraderBots.$inferSelect;
export type InsertAiTraderBot = z.infer<typeof insertAiTraderBotSchema>;

export const insertAiTraderDecisionSchema = createInsertSchema(aiTraderDecisions).omit({
  id: true,
  decidedAt: true,
});
export type AiTraderDecision = typeof aiTraderDecisions.$inferSelect;
export type InsertAiTraderDecision = z.infer<typeof insertAiTraderDecisionSchema>;

// COT-A: CFTC Bitcoin Legacy futures-only COT positioning cache.
// One row per weekly CFTC release. Single global BTC signal serving the whole fleet.
// Phase B: the context-builder will inject: cotSignal: { state, commIndex, dumbIndex, reportDate }
// from the latest snapshot into each decision's contextDigest.
export const cotSnapshots = pgTable("cot_snapshots", {
  id: serial("id").primaryKey(),
  reportDate: text("report_date").notNull().unique(),        // YYYY-MM-DD (stored as text; DDL uses date)
  commercialNet: integer("commercial_net").notNull(),        // comm long - comm short (smart money net)
  noncommNet: integer("noncomm_net").notNull(),              // non-commercial net
  nonreptNet: integer("nonrept_net").notNull(),              // non-reportable net
  dumbNet: integer("dumb_net").notNull(),                    // noncomm + nonrept combined (dumb money net)
  commIndex: decimal("comm_index", { precision: 6, scale: 2 }),    // smart line (0–100), null if window < 120
  noncommIndex: decimal("noncomm_index", { precision: 6, scale: 2 }), // for transparency
  nonreptIndex: decimal("nonrept_index", { precision: 6, scale: 2 }), // for transparency
  dumbIndex: decimal("dumb_index", { precision: 6, scale: 2 }),    // dumb line (0–100), null if window < 120
  state: text("state").notNull().default("insufficient_data"),
  // 'bullish_flip' | 'bearish_flip' | 'neutral' | 'insufficient_data'
  weeksInWindow: integer("weeks_in_window").notNull().default(0),  // < 120 → indices are null
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
}, (table) => [
  index("idx_cot_snapshots_report_date").on(table.reportDate),
]);
export type CotSnapshotRow = typeof cotSnapshots.$inferSelect;

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
  outOfSampleFraction: z.number().min(0).max(0.9).optional(),
  slippage: z.number().min(0).optional(),
});
