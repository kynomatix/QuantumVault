CREATE TABLE "auth_nonces" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_nonces_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
CREATE TABLE "bot_positions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_bot_id" varchar NOT NULL,
	"wallet_address" text NOT NULL,
	"market" text NOT NULL,
	"base_size" numeric(20, 8) DEFAULT '0' NOT NULL,
	"avg_entry_price" numeric(20, 6) DEFAULT '0' NOT NULL,
	"cost_basis" numeric(20, 6) DEFAULT '0' NOT NULL,
	"realized_pnl" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_fees" numeric(20, 6) DEFAULT '0' NOT NULL,
	"last_trade_id" varchar,
	"last_trade_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bot_positions_bot_market_unique" UNIQUE("trading_bot_id","market")
);
--> statement-breakpoint
CREATE TABLE "bot_subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"published_bot_id" varchar NOT NULL,
	"subscriber_wallet_address" text NOT NULL,
	"subscriber_bot_id" varchar,
	"capital_invested" numeric(20, 2) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"subscribed_at" timestamp DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp,
	CONSTRAINT "bot_subscriptions_unique" UNIQUE("published_bot_id","subscriber_wallet_address")
);
--> statement-breakpoint
CREATE TABLE "bot_trades" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_bot_id" varchar NOT NULL,
	"wallet_address" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric(20, 8) NOT NULL,
	"price" numeric(20, 6) NOT NULL,
	"fee" numeric(20, 6) DEFAULT '0',
	"pnl" numeric(20, 2),
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_signature" text,
	"webhook_payload" jsonb,
	"error_message" text,
	"executed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"market" text NOT NULL,
	"apr" numeric(10, 2) NOT NULL,
	"subscribers" integer DEFAULT 0 NOT NULL,
	"creator_username" text NOT NULL,
	"rating" numeric(3, 1) NOT NULL,
	"min_deposit" integer NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"trading_bot_id" varchar,
	"event_type" text NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"asset_type" text DEFAULT 'USDC' NOT NULL,
	"tx_signature" text,
	"balance_after" numeric(20, 6),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_stats" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"total_volume" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_pnl" numeric(20, 2) DEFAULT '0' NOT NULL,
	"win_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"total_trades" integer DEFAULT 0 NOT NULL,
	"rank" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orphaned_subaccounts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"agent_public_key" text NOT NULL,
	"agent_private_key_encrypted" text NOT NULL,
	"drift_subaccount_id" integer NOT NULL,
	"reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pnl_snapshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_bot_id" varchar NOT NULL,
	"snapshot_date" timestamp NOT NULL,
	"equity" numeric(20, 6) NOT NULL,
	"realized_pnl" numeric(20, 6) DEFAULT '0' NOT NULL,
	"unrealized_pnl" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_deposited" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pnl_snapshots_bot_date_unique" UNIQUE("trading_bot_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"total_value" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unrealized_pnl" numeric(20, 2) DEFAULT '0' NOT NULL,
	"realized_pnl" numeric(20, 2) DEFAULT '0' NOT NULL,
	"sol_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"usdc_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric(20, 8) NOT NULL,
	"entry_price" numeric(20, 2) NOT NULL,
	"current_price" numeric(20, 2) NOT NULL,
	"pnl" numeric(20, 2) NOT NULL,
	"pnl_percent" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_bots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_bot_id" varchar NOT NULL,
	"creator_wallet_address" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"market" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"total_capital_invested" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_trades" integer DEFAULT 0 NOT NULL,
	"winning_trades" integer DEFAULT 0 NOT NULL,
	"pnl_percent_7d" numeric(10, 4),
	"pnl_percent_30d" numeric(10, 4),
	"pnl_percent_90d" numeric(10, 4),
	"pnl_percent_all_time" numeric(10, 4),
	"published_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "published_bots_trading_bot_id_unique" UNIQUE("trading_bot_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"bot_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"subscribed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric(20, 8) NOT NULL,
	"price" numeric(20, 2) NOT NULL,
	"total" numeric(20, 2) NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_bots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"name" text NOT NULL,
	"market" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"webhook_url" text,
	"drift_subaccount_id" integer,
	"agent_public_key" text,
	"agent_private_key_encrypted" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"bot_type" text DEFAULT 'signal' NOT NULL,
	"side" text DEFAULT 'both' NOT NULL,
	"total_investment" numeric(20, 2) DEFAULT '100' NOT NULL,
	"max_position_size" numeric(20, 2),
	"leverage" integer DEFAULT 1 NOT NULL,
	"profit_reinvest" boolean DEFAULT false NOT NULL,
	"auto_withdraw_threshold" numeric(20, 2),
	"signal_config" jsonb,
	"risk_config" jsonb,
	"stats" jsonb DEFAULT '{"totalTrades":0,"winningTrades":0,"losingTrades":0,"totalPnl":0,"totalVolume":0}'::jsonb,
	"source_published_bot_id" varchar,
	"allowed_markets" text[],
	"max_position_notional_usd" numeric(20, 2),
	"max_leverage_limit" integer,
	"max_slippage_bps" integer DEFAULT 50,
	"daily_loss_limit_usd" numeric(20, 2),
	"daily_loss_used_usd" numeric(20, 2) DEFAULT '0',
	"policy_hmac" text,
	"policy_version" integer DEFAULT 1,
	"kill_switch_triggered" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"display_name" text,
	"referral_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"x_username" text,
	"referral_code" text,
	"referred_by" text,
	"drift_subaccount" integer DEFAULT 0,
	"default_leverage" integer DEFAULT 3,
	"slippage_bps" integer DEFAULT 50,
	"agent_public_key" text,
	"agent_private_key_encrypted" text,
	"user_webhook_secret" text,
	"notifications_enabled" boolean DEFAULT false,
	"notify_trade_executed" boolean DEFAULT true,
	"notify_trade_failed" boolean DEFAULT true,
	"notify_position_closed" boolean DEFAULT true,
	"telegram_connected" boolean DEFAULT false,
	"dialect_address" text,
	"dialect_bearer_token" text,
	"user_salt" text,
	"encrypted_user_master_key" text,
	"umk_version" integer DEFAULT 1,
	"agent_mnemonic_encrypted" text,
	"execution_umk_encrypted" text,
	"execution_expires_at" timestamp,
	"execution_enabled" boolean DEFAULT false,
	"emergency_stop_triggered" boolean DEFAULT false,
	"emergency_stop_at" timestamp,
	"emergency_stop_by" text,
	"mnemonic_reveal_count" integer DEFAULT 0,
	"mnemonic_last_reveal_at" timestamp,
	"security_version" integer DEFAULT 3,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "webhook_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trading_bot_id" varchar,
	"payload" jsonb NOT NULL,
	"headers" jsonb,
	"ip_address" text,
	"processed" boolean DEFAULT false NOT NULL,
	"signal_hash" text,
	"trade_executed" boolean DEFAULT false NOT NULL,
	"error_message" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_logs_signal_hash_unique" UNIQUE("signal_hash")
);
--> statement-breakpoint
ALTER TABLE "bot_positions" ADD CONSTRAINT "bot_positions_trading_bot_id_trading_bots_id_fk" FOREIGN KEY ("trading_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_positions" ADD CONSTRAINT "bot_positions_wallet_address_wallets_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscriptions" ADD CONSTRAINT "bot_subscriptions_published_bot_id_published_bots_id_fk" FOREIGN KEY ("published_bot_id") REFERENCES "public"."published_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscriptions" ADD CONSTRAINT "bot_subscriptions_subscriber_wallet_address_wallets_address_fk" FOREIGN KEY ("subscriber_wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscriptions" ADD CONSTRAINT "bot_subscriptions_subscriber_bot_id_trading_bots_id_fk" FOREIGN KEY ("subscriber_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_trades" ADD CONSTRAINT "bot_trades_trading_bot_id_trading_bots_id_fk" FOREIGN KEY ("trading_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_trades" ADD CONSTRAINT "bot_trades_wallet_address_wallets_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_events" ADD CONSTRAINT "equity_events_wallet_address_wallets_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_events" ADD CONSTRAINT "equity_events_trading_bot_id_trading_bots_id_fk" FOREIGN KEY ("trading_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_stats" ADD CONSTRAINT "leaderboard_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphaned_subaccounts" ADD CONSTRAINT "orphaned_subaccounts_wallet_address_wallets_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pnl_snapshots" ADD CONSTRAINT "pnl_snapshots_trading_bot_id_trading_bots_id_fk" FOREIGN KEY ("trading_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_bots" ADD CONSTRAINT "published_bots_trading_bot_id_trading_bots_id_fk" FOREIGN KEY ("trading_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_bots" ADD CONSTRAINT "published_bots_creator_wallet_address_wallets_address_fk" FOREIGN KEY ("creator_wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD CONSTRAINT "trading_bots_wallet_address_wallets_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."wallets"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_trading_bot_id_trading_bots_id_fk" FOREIGN KEY ("trading_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE set null ON UPDATE no action;