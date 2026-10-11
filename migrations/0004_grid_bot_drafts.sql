DO $$
BEGIN
  -- Catalogue-only repeat boot: complete installations execute no lock-taking DDL.
  IF to_regclass('grid_bots') IS NOT NULL AND to_regclass('grid_levels') IS NOT NULL AND to_regclass('grid_operations') IS NOT NULL AND to_regclass('grid_fills') IS NOT NULL AND to_regclass('grid_bots_wallet_request_unique') IS NOT NULL AND to_regclass('grid_bots_owner_status_idx') IS NOT NULL AND to_regclass('grid_bots_scheduler_idx') IS NOT NULL AND to_regclass('grid_levels_bot_ordinal_unique') IS NOT NULL AND to_regclass('grid_levels_bot_status_idx') IS NOT NULL AND to_regclass('grid_levels_venue_order_idx') IS NOT NULL AND to_regclass('grid_operations_idempotency_unique') IS NOT NULL AND to_regclass('grid_operations_request_unique') IS NOT NULL AND to_regclass('grid_operations_unresolved_idx') IS NOT NULL AND to_regclass('grid_fills_trade_unique') IS NOT NULL AND to_regclass('grid_fills_bot_time_idx') IS NOT NULL AND (SELECT count(*) FROM pg_constraint WHERE conname IN ('grid_bots_protocol_check','grid_bots_server_intent_digest_check','grid_bots_policy_hmac_check','grid_bots_geometry_check','grid_bots_direction_check','grid_bots_scale_check','grid_bots_stop_check','grid_bots_source_check','grid_bots_status_check','grid_bots_live_subaccount_check','grid_bots_lease_check','grid_bots_counts_check','grid_bots_sol_check','grid_bots_residual_check','grid_levels_ordinal_check','grid_levels_geometry_check','grid_levels_status_check','grid_operations_identity_check','grid_operations_type_check','grid_operations_state_check','grid_operations_failure_check','grid_operations_terminal_check','grid_operations_amount_check','grid_operations_trigger_check','grid_operations_notification_check','grid_fills_values_check','grid_bots_wallet_address_fk','grid_bots_protocol_subaccount_id_fk','grid_levels_bot_id_fk','grid_operations_bot_id_fk','grid_operations_level_id_fk','grid_operations_parent_operation_id_fk','grid_fills_bot_id_fk','grid_fills_level_id_fk','grid_bots_terminal_stop_operation_id_fk') AND connamespace = current_schema()::regnamespace) = 35 THEN RETURN; END IF;
  CREATE TABLE IF NOT EXISTS grid_bots (
  id uuid PRIMARY KEY,
  wallet_address text NOT NULL,
  protocol text NOT NULL DEFAULT 'pacifica',
  market text NOT NULL,
  protocol_subaccount_id integer,
  name text NOT NULL DEFAULT 'Grid draft',
  client_request_id uuid NOT NULL,
  server_intent_digest text NOT NULL,
  draft_revision text NOT NULL,
  create_intent jsonb NOT NULL,
  authority_snapshot jsonb NOT NULL,
  upper_price numeric(30,8) NOT NULL,
  lower_price numeric(30,8) NOT NULL,
  start_price numeric(30,8) NOT NULL,
  grid_count integer NOT NULL,
  direction text NOT NULL,
  total_investment numeric(30,2) NOT NULL,
  leverage integer NOT NULL,
  entry_scale_type text NOT NULL,
  profit_scale_type text NOT NULL,
  policy_hmac text NOT NULL,
  policy_version text NOT NULL,
  fee_policy_version text NOT NULL,
  runtime_policy_version text NOT NULL,
  stop_loss_percent numeric(20,4),
  stop_loss_price numeric(30,8),
  seed_at_creation boolean NOT NULL,
  range_source text NOT NULL,
  chart_timeframe text NOT NULL,
  lowest_active_buy_level integer,
  highest_active_sell_level integer,
  status text NOT NULL DEFAULT 'draft',
  pause_reason text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_tick_at timestamptz,
  reconciliation_cursor text,
  last_reconciliation_at timestamptz,
  startup_reconciled_at timestamptz,
  canary_started_at timestamptz,
  canary_clean_since timestamptz,
  canary_promoted_at timestamptz,
  canary_clean_ticks integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  incident_identity text,
  incident_opened_at timestamptz,
  incident_notified_at timestamptz,
  sol_balance numeric(30,9),
  sol_balance_observed_at timestamptz,
  sol_guard_state text NOT NULL DEFAULT 'unknown',
  residual_usdc numeric(30,8),
  residual_observed_at timestamptz,
  total_fees numeric(30,8) NOT NULL DEFAULT 0,
  terminal_stop_operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grid_bots_protocol_check CHECK (protocol = 'pacifica'),
  CONSTRAINT grid_bots_server_intent_digest_check CHECK (server_intent_digest ~ '^[0-9A-F]{64}$'),
  CONSTRAINT grid_bots_policy_hmac_check CHECK (policy_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT grid_bots_geometry_check CHECK (lower_price > 0 AND upper_price > lower_price AND start_price BETWEEN lower_price AND upper_price AND grid_count BETWEEN 1 AND 100 AND total_investment > 0 AND leverage > 0),
  CONSTRAINT grid_bots_direction_check CHECK (direction IN ('long','short')),
  CONSTRAINT grid_bots_scale_check CHECK (entry_scale_type IN ('flat','ascending','descending') AND profit_scale_type IN ('flat','ascending','descending')),
  CONSTRAINT grid_bots_stop_check CHECK ((stop_loss_percent IS NULL AND stop_loss_price IS NULL) OR (stop_loss_percent IS NOT NULL AND stop_loss_price IS NOT NULL AND stop_loss_percent > 0 AND stop_loss_price > 0)),
  CONSTRAINT grid_bots_source_check CHECK (range_source IN ('manual','auto') AND chart_timeframe IN ('15m','1h','4h')),
  CONSTRAINT grid_bots_status_check CHECK (status IN ('draft','provisioning','canary','active','pausing','paused','resuming','reconciling','range_exhausted','stopping','stopped','failed')),
  CONSTRAINT grid_bots_live_subaccount_check CHECK (status IN ('draft','stopped','failed') OR protocol_subaccount_id IS NOT NULL),
  CONSTRAINT grid_bots_lease_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT grid_bots_counts_check CHECK (canary_clean_ticks >= 0 AND consecutive_failures >= 0 AND total_fees >= 0),
  CONSTRAINT grid_bots_sol_check CHECK ((sol_balance IS NULL) = (sol_balance_observed_at IS NULL) AND (sol_balance IS NULL OR sol_balance >= 0) AND sol_guard_state IN ('unknown','healthy','warning','entry_blocked')),
  CONSTRAINT grid_bots_residual_check CHECK ((residual_usdc IS NULL) = (residual_observed_at IS NULL) AND (residual_usdc IS NULL OR residual_usdc >= 0))
);
  CREATE TABLE IF NOT EXISTS grid_levels (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL,
  ordinal integer NOT NULL,
  price numeric(30,8) NOT NULL,
  size numeric(30,8) NOT NULL,
  side text NOT NULL,
  reduce_only boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  venue_order_id text,
  client_order_uuid uuid,
  placement_attempt integer NOT NULL DEFAULT 0,
  cumulative_filled_size numeric(30,8) NOT NULL DEFAULT 0,
  last_filled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grid_levels_ordinal_check CHECK (ordinal BETWEEN 1 AND 101),
  CONSTRAINT grid_levels_geometry_check CHECK (price > 0 AND size >= 0 AND side IN ('buy','sell') AND placement_attempt >= 0 AND cumulative_filled_size BETWEEN 0 AND size),
  CONSTRAINT grid_levels_status_check CHECK (status IN ('pending','submitting','active','partially_filled','filled','cancelling','cancelled','failed'))
);
  CREATE TABLE IF NOT EXISTS grid_operations (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL,
  level_id uuid,
  parent_operation_id uuid,
  idempotency_key text NOT NULL,
  request_identity text NOT NULL,
  type text NOT NULL,
  state text NOT NULL DEFAULT 'prepared',
  attempt integer NOT NULL DEFAULT 1,
  client_order_uuid uuid,
  venue_order_id text,
  transaction_signature text,
  amount_usdc numeric(30,8),
  trigger_price numeric(30,8),
  trigger_pnl numeric(30,8),
  trigger_observed_at timestamptz,
  notification_type text,
  notification_payload jsonb,
  failure_classification text,
  failure_code text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grid_operations_identity_check CHECK (length(btrim(idempotency_key)) > 0 AND length(btrim(request_identity)) > 0 AND attempt > 0),
  CONSTRAINT grid_operations_type_check CHECK (type IN ('provision_subaccount','set_leverage','fund_subaccount','seed_position','place_level_order','cancel_level_order','cancel_all_orders','pause','resume','sync','stop_trigger','close_position','sweep_subaccount','release_subaccount','send_notification')),
  CONSTRAINT grid_operations_state_check CHECK (state IN ('prepared','submitted','unconfirmed','confirmed','failed')),
  CONSTRAINT grid_operations_failure_check CHECK ((failure_classification IS NULL OR failure_classification IN ('expected_rejection','transport','authentication','quota','margin','policy','invariant','venue_rejection','unknown')) AND (state NOT IN ('unconfirmed','failed') OR failure_classification IS NOT NULL) AND (state <> 'confirmed' OR failure_classification IS NULL)),
  CONSTRAINT grid_operations_terminal_check CHECK ((state IN ('confirmed','failed')) = (terminal_at IS NOT NULL) AND (state <> 'submitted' OR submitted_at IS NOT NULL)),
  CONSTRAINT grid_operations_amount_check CHECK (amount_usdc IS NULL OR amount_usdc >= 0),
  CONSTRAINT grid_operations_trigger_check CHECK (type <> 'stop_trigger' OR (trigger_price IS NOT NULL AND trigger_price > 0 AND trigger_pnl IS NOT NULL AND trigger_observed_at IS NOT NULL)),
  CONSTRAINT grid_operations_notification_check CHECK (type <> 'send_notification' OR (notification_type IS NOT NULL AND notification_payload IS NOT NULL))
);
  CREATE TABLE IF NOT EXISTS grid_fills (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL,
  level_id uuid NOT NULL,
  venue_trade_id text NOT NULL,
  venue_order_id text,
  client_order_uuid uuid,
  side text NOT NULL,
  price numeric(30,8) NOT NULL,
  size numeric(30,8) NOT NULL,
  fee numeric(30,8) NOT NULL,
  fee_asset text NOT NULL,
  partial boolean NOT NULL,
  venue_fill_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grid_fills_values_check CHECK (price > 0 AND size > 0 AND fee >= 0 AND length(btrim(venue_trade_id)) > 0 AND length(btrim(fee_asset)) > 0 AND side IN ('buy','sell'))
);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_bots'::regclass AND conname = 'grid_bots_wallet_address_fk') THEN ALTER TABLE grid_bots ADD CONSTRAINT grid_bots_wallet_address_fk FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_bots'::regclass AND conname = 'grid_bots_protocol_subaccount_id_fk') THEN ALTER TABLE grid_bots ADD CONSTRAINT grid_bots_protocol_subaccount_id_fk FOREIGN KEY (protocol_subaccount_id) REFERENCES protocol_subaccounts(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_levels'::regclass AND conname = 'grid_levels_bot_id_fk') THEN ALTER TABLE grid_levels ADD CONSTRAINT grid_levels_bot_id_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_operations'::regclass AND conname = 'grid_operations_bot_id_fk') THEN ALTER TABLE grid_operations ADD CONSTRAINT grid_operations_bot_id_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_operations'::regclass AND conname = 'grid_operations_level_id_fk') THEN ALTER TABLE grid_operations ADD CONSTRAINT grid_operations_level_id_fk FOREIGN KEY (level_id) REFERENCES grid_levels(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_operations'::regclass AND conname = 'grid_operations_parent_operation_id_fk') THEN ALTER TABLE grid_operations ADD CONSTRAINT grid_operations_parent_operation_id_fk FOREIGN KEY (parent_operation_id) REFERENCES grid_operations(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_fills'::regclass AND conname = 'grid_fills_bot_id_fk') THEN ALTER TABLE grid_fills ADD CONSTRAINT grid_fills_bot_id_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_fills'::regclass AND conname = 'grid_fills_level_id_fk') THEN ALTER TABLE grid_fills ADD CONSTRAINT grid_fills_level_id_fk FOREIGN KEY (level_id) REFERENCES grid_levels(id) ON DELETE RESTRICT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grid_bots'::regclass AND conname = 'grid_bots_terminal_stop_operation_id_fk') THEN ALTER TABLE grid_bots ADD CONSTRAINT grid_bots_terminal_stop_operation_id_fk FOREIGN KEY (terminal_stop_operation_id) REFERENCES grid_operations(id) ON DELETE RESTRICT; END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS grid_bots_wallet_request_unique ON grid_bots (wallet_address, client_request_id);
  CREATE INDEX IF NOT EXISTS grid_bots_owner_status_idx ON grid_bots (wallet_address, status);
  CREATE INDEX IF NOT EXISTS grid_bots_scheduler_idx ON grid_bots (status, lease_expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS grid_levels_bot_ordinal_unique ON grid_levels (bot_id, ordinal);
  CREATE INDEX IF NOT EXISTS grid_levels_bot_status_idx ON grid_levels (bot_id, status);
  CREATE INDEX IF NOT EXISTS grid_levels_venue_order_idx ON grid_levels (venue_order_id);
  CREATE UNIQUE INDEX IF NOT EXISTS grid_operations_idempotency_unique ON grid_operations (idempotency_key);
  CREATE UNIQUE INDEX IF NOT EXISTS grid_operations_request_unique ON grid_operations (request_identity);
  CREATE INDEX IF NOT EXISTS grid_operations_unresolved_idx ON grid_operations (bot_id, state, prepared_at);
  CREATE UNIQUE INDEX IF NOT EXISTS grid_fills_trade_unique ON grid_fills (venue_trade_id);
  CREATE INDEX IF NOT EXISTS grid_fills_bot_time_idx ON grid_fills (bot_id, venue_fill_time, venue_trade_id);
END $$;
