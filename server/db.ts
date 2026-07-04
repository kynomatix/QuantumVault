import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const poolSize = parseInt(process.env.DB_POOL_SIZE || "12", 10);
const connTimeoutMs = parseInt(process.env.DB_CONN_TIMEOUT_MS || "10000", 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolSize,
  connectionTimeoutMillis: connTimeoutMs,
  idleTimeoutMillis: 120_000,
});

pool.on("error", (err) => {
  console.error("[DB Pool] Idle client error (suppressed crash):", err.message);
});

setInterval(() => {
  console.log(`[DB Pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount} max=${poolSize}`);
}, 30_000);

export const db = drizzle(pool, { schema });

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function ensureSchema() {
  const client = await pool.connect();
  try {
    const migrations = [
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS queue_order integer`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS config_snapshot jsonb`,
      `CREATE TABLE IF NOT EXISTS platform_cumulative_stats (
        id text PRIMARY KEY DEFAULT 'singleton',
        cumulative_volume numeric(20,2) NOT NULL DEFAULT 0,
        cumulative_trades integer NOT NULL DEFAULT 0,
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lab_opt_runs_user_status ON lab_optimization_runs (user_id, status, id)`,
      `CREATE INDEX IF NOT EXISTS idx_lab_opt_results_run_id ON lab_optimization_results (run_id)`,

      // --- Phase 7 / Item 12g: per-bot subaccount auth mode (Drift-blocker). ---
      // Idempotent: safe to run on fresh DB, partially-migrated DB, or fully-migrated DB.
      // Backfill rule (one-time historical reconstruction): a bot with a stored
      // subaccount keypair (bot_subaccount_key_encrypted IS NOT NULL) was using
      // external_key auth (Pacifica-style); everything else used main_plus_id (Drift-style).
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS subaccount_auth_mode text`,
      `UPDATE trading_bots SET subaccount_auth_mode = 'external_key'
         WHERE subaccount_auth_mode IS NULL AND bot_subaccount_key_encrypted IS NOT NULL`,
      `UPDATE trading_bots SET subaccount_auth_mode = 'main_plus_id'
         WHERE subaccount_auth_mode IS NULL`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_subaccount_auth_mode_check
           CHECK (subaccount_auth_mode IN ('external_key', 'main_plus_id'));
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_external_key_invariant
           CHECK (
             NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active')
             OR (protocol_subaccount_id IS NOT NULL AND bot_subaccount_key_encrypted IS NOT NULL)
           );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `ALTER TABLE trading_bots ALTER COLUMN subaccount_auth_mode SET NOT NULL`,

      // --- Phase 4b (Task 99): per-bot subaccount key V3 encryption column. ---
      // Idempotent. Adds the v3 column and relaxes the external-key invariant
      // so it accepts either the legacy or v3 ciphertext. Login backfills any
      // legacy-only rows on the owner's next sign-in.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS bot_subaccount_key_encrypted_v3 text`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots DROP CONSTRAINT IF EXISTS trading_bots_external_key_invariant;
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_external_key_invariant
           CHECK (
             NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active')
             OR (
               protocol_subaccount_id IS NOT NULL
               AND (bot_subaccount_key_encrypted IS NOT NULL OR bot_subaccount_key_encrypted_v3 IS NOT NULL)
             )
           );
       END $$`,

      // --- Phase 7 / Group D item 18: formalize active_protocol allowed values. ---
      // Idempotent: safe to run on fresh DB, partially-migrated DB, or fully-migrated DB.
      // Backfill rule (one-time historical reconstruction): the only NULL rows in
      // production today are the dormant pre-adapter Drift bots described in item 12d
      // (legacy bots with no Pacifica subaccount and no migrated collateral; they
      // cannot be re-pointed to Pacifica). They are by definition Drift. New bots
      // always set active_protocol explicitly at creation (item 18 fixed the four
      // insert sites in routes.ts). After backfill, the column is constrained to
      // ('pacifica', 'drift') and made NOT NULL — this lets `getAdapterForBot()`
      // drop its warn-logging null fallback (removed in the item-18 closeout commit).
      //
      // ATOMICITY: the three steps (UPDATE → ADD CONSTRAINT → SET NOT NULL) are
      // wrapped in a single PL/pgSQL DO block so they execute in one transaction.
      // Without this, a concurrent writer (e.g. an old instance during rolling
      // deploy) could insert a NULL row between the UPDATE and the SET NOT NULL,
      // causing the latter to fail and leaving the schema partially tightened.
      // The inner BEGIN/EXCEPTION handles the duplicate-constraint case on re-run.
      `DO $$ BEGIN
         UPDATE trading_bots SET active_protocol = 'drift' WHERE active_protocol IS NULL;
         BEGIN
           ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_active_protocol_check
             CHECK (active_protocol IN ('pacifica', 'drift'));
         EXCEPTION WHEN duplicate_object THEN NULL; END;
         ALTER TABLE trading_bots ALTER COLUMN active_protocol SET NOT NULL;
       END $$`,

      // --- Clone the two native-engine community strategies (SBR v1 and
      // Adaptive Regime V3.8) from the BuhE wallet to the AqTT wallet.
      // Idempotent: NOT EXISTS guard means re-running is a no-op once the
      // AqTT-owned copies are present. Copies share Pine source, parsed
      // inputs, groups, and strategy_settings (including nativeEngine=true),
      // so the AqTT copies route through the same native engine path as
      // the originals.
      // --- MLM referral chain & rewards (Task 70) ---
      `CREATE TABLE IF NOT EXISTS referral_links (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        descendant_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        ancestor_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        level integer NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT referral_links_descendant_level_unique UNIQUE (descendant_wallet, level),
        CONSTRAINT referral_links_no_self CHECK (descendant_wallet <> ancestor_wallet),
        CONSTRAINT referral_links_level_range CHECK (level BETWEEN 1 AND 3)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_referral_links_ancestor ON referral_links (ancestor_wallet)`,
      `CREATE INDEX IF NOT EXISTS idx_referral_links_descendant ON referral_links (descendant_wallet)`,
      `CREATE TABLE IF NOT EXISTS referral_reward_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type text NOT NULL,
        source_id text NOT NULL,
        earner_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        referee_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        level integer NOT NULL,
        amount_usdc numeric(20, 6) NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT referral_reward_events_unique UNIQUE (source_type, source_id, earner_wallet, level),
        CONSTRAINT referral_reward_events_level_range CHECK (level BETWEEN 1 AND 3),
        CONSTRAINT referral_reward_events_status_valid CHECK (status IN ('pending','confirmed','paid','failed'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_referral_reward_events_earner ON referral_reward_events (earner_wallet)`,
      `DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'referral_reward_events_status_valid'
        ) THEN
          ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_status_valid
            CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'));
        ELSE
          ALTER TABLE referral_reward_events
            DROP CONSTRAINT referral_reward_events_status_valid;
          ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_status_valid
            CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'));
        END IF;
      END $$;`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS funding_wallet text`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS transfer_signature text`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS last_error text`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS last_attempt_at timestamp`,
      `CREATE INDEX IF NOT EXISTS idx_referral_reward_events_status_created ON referral_reward_events (status, created_at)`,
      // Backfill: existing wallets.referred_by -> referral_links level 1 (and L2/L3 if resolvable),
      // skipping rows that already exist. Idempotent.
      `INSERT INTO referral_links (descendant_wallet, ancestor_wallet, level)
       SELECT w.address, w.referred_by, 1
         FROM wallets w
        WHERE w.referred_by IS NOT NULL
          AND w.referred_by <> w.address
          AND EXISTS (SELECT 1 FROM wallets a WHERE a.address = w.referred_by)
       ON CONFLICT (descendant_wallet, level) DO NOTHING`,
      `INSERT INTO referral_links (descendant_wallet, ancestor_wallet, level)
       SELECT w.address, w2.referred_by, 2
         FROM wallets w
         JOIN wallets w2 ON w2.address = w.referred_by
        WHERE w2.referred_by IS NOT NULL
          AND w2.referred_by <> w.address
          AND EXISTS (SELECT 1 FROM wallets a WHERE a.address = w2.referred_by)
       ON CONFLICT (descendant_wallet, level) DO NOTHING`,
      `INSERT INTO referral_links (descendant_wallet, ancestor_wallet, level)
       SELECT w.address, w3.referred_by, 3
         FROM wallets w
         JOIN wallets w2 ON w2.address = w.referred_by
         JOIN wallets w3 ON w3.address = w2.referred_by
        WHERE w3.referred_by IS NOT NULL
          AND w3.referred_by <> w.address
          AND EXISTS (SELECT 1 FROM wallets a WHERE a.address = w3.referred_by)
       ON CONFLICT (descendant_wallet, level) DO NOTHING`,

      // --- Task 119: portfolio P&L correctness ---
      // Add on-chain block time to equity_events so the reconciler can
      // attribute late-discovered deposits to when they actually happened.
      `ALTER TABLE equity_events ADD COLUMN IF NOT EXISTS tx_block_time timestamp`,
      // Add trading-P&L fields to portfolio_daily_snapshots. All columns are
      // additive with safe defaults so this migration is reversible and
      // backwards-compatible with the existing reader.
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_external_deposits numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_external_withdrawals numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_internal_transfers numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_trading_pnl numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS net_external_flow numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS pnl_percent numeric(12,6) NOT NULL DEFAULT 0`,

      // --- Task 129: Telegram daily summary opt-in toggle + idempotency marker ---
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS daily_summary_enabled boolean NOT NULL DEFAULT false`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS daily_summary_last_sent_date text`,

      // --- Task 143: Pacifica Builder Code & Referral idempotency flags ---
      // Idempotent ALTERs. Default false so existing rows are migrated lazily on
      // the next trade (the adapter's ensurePacificaEnrollment hook fires).
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pacifica_builder_approved boolean NOT NULL DEFAULT false`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pacifica_referral_claimed boolean NOT NULL DEFAULT false`,

      // --- Task 201: hands-off auto-mode admin whitelist (additive, idempotent). ---
      // Default false → every wallet starts in watched mode; an admin flips it on.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS hands_off_approved boolean NOT NULL DEFAULT false`,

      // --- Task 149: per-bot Pacifica enrollment flags ---
      // Phase 4b bots are their own Pacifica main accounts (keypair behind
      // bot_subaccount_key_encrypted_v3, pubkey in protocol_subaccount_id),
      // so enrollment must be tracked per-bot. Mirrors the wallets flags
      // above. Default false → migrated lazily on the bot's next trade.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS pacifica_builder_approved boolean NOT NULL DEFAULT false`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS pacifica_referral_claimed boolean NOT NULL DEFAULT false`,

      // Auto-repark idle funds (Task: per-bot persistent setting + server-managed
      // debounce deadline). Additive + idempotent. auto_park_idle defaults OFF;
      // auto_park_due_at is set when a position fully closes and cleared on open,
      // then consumed by the periodic repark scanner. See server/vault/auto-repark.ts.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_park_idle boolean NOT NULL DEFAULT false`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_park_due_at timestamp`,

      // Per-bot park DESTINATION (Task: persisted picker + migrate-on-save). Additive +
      // idempotent. NULL = legacy inference. When set on a Flash bot the auto-repark
      // executor treats it as authoritative and migrates parked funds into it.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS park_destination_asset text`,
      // On-open unpark mode (Flash vaults). Defaults TRUE = all-out (safest): existing
      // auto-park bots become full-buffer-on-open automatically. Additive + idempotent.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS vault_all_out boolean NOT NULL DEFAULT true`,

      // Defend-the-loan auto collateral top-up (Task: opt-in per-bot setting). Additive +
      // idempotent. Defaults OFF → the scanner never tops up a loan the user didn't opt in.
      // See server/vault/jupiter-lend-perbot-carve.ts (runPerbotCollateralTopUp).
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_collateral_top_up boolean NOT NULL DEFAULT false`,

      // Defend-the-loan auto repay (opt-in per-bot setting). Additive + idempotent.
      // Defaults OFF → the scanner never repays a loan the user didn't opt in.
      // See server/vault/auto-topup.ts (decideAutoRepay).
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_repay_enabled boolean NOT NULL DEFAULT false`,

      // --- Phase 4b (Flash agent-HD wallets): recoverable per-bot wallet indices. ---
      // Additive + idempotent. The allocator lives on `wallets` (burn-on-allocate,
      // never reused). Each agent_hd bot stores its non-secret HD index + path version;
      // legacy random bots leave both NULL. DB-level CHECK/UNIQUE are the real fund-safety
      // enforcement so a manual or buggy write can never commingle two bots on one wallet.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS next_bot_derivation_index integer NOT NULL DEFAULT 1`,
      // Orphan slots verified empty (swept or live-bot drift) — excluded from the
      // stranded-funds indicator so the recovery button clears once nothing remains.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS recovered_orphan_indices integer[] NOT NULL DEFAULT '{}'`,

      // QuantumLab AI Strategy Creator (Task 187): BYO OpenRouter key, V3-encrypted
      // (UMK-wrapped only, interactive-only). Additive + idempotent. Plaintext is
      // never stored; only the ciphertext, a display-only last4, provider, and mtime.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_encrypted text`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_last4 text`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_provider text`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_updated_at timestamp`,

      // Vaults Phase 0a: account-level manual park/unpark settings. Additive + idempotent.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS vault_enabled boolean NOT NULL DEFAULT false`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS vault_default_asset text`,

      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS derivation_index integer`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS derivation_path_version integer`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_derivation_index_positive
           CHECK (derivation_index IS NULL OR derivation_index >= 1);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_derivation_dual_model
           CHECK (
             (derivation_index IS NULL AND derivation_path_version IS NULL)
             OR (derivation_index IS NOT NULL AND derivation_path_version IS NOT NULL)
           );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_wallet_derivation_index_unique
           UNIQUE (wallet_address, derivation_index);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

      // --- HD-derivation metadata on the spare pool (Pacifica agent_hd reuse). ---
      // When a Pacifica bot is deleted its subaccount is swept-empty and pooled as a
      // spare. On reuse the new bot MUST inherit the spare's ORIGINAL derivation index
      // so the seed fallback re-derives the SAME pubkey (else pubkey-mismatch →
      // fail-closed → the reused slot silently loses recoverability). Additive +
      // idempotent. Legacy random-key spares carry NULL/NULL → blob-only, as before.
      `ALTER TABLE protocol_subaccounts ADD COLUMN IF NOT EXISTS derivation_index integer`,
      `ALTER TABLE protocol_subaccounts ADD COLUMN IF NOT EXISTS derivation_path_version integer`,
      `DO $$ BEGIN
         ALTER TABLE protocol_subaccounts ADD CONSTRAINT protocol_subaccounts_derivation_index_positive
           CHECK (derivation_index IS NULL OR derivation_index >= 1);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE protocol_subaccounts ADD CONSTRAINT protocol_subaccounts_derivation_dual_model
           CHECK (
             (derivation_index IS NULL AND derivation_path_version IS NULL)
             OR (derivation_index IS NOT NULL AND derivation_path_version IS NOT NULL)
           );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

      `INSERT INTO lab_strategies (user_id, name, description, pine_script, parsed_inputs, groups, strategy_settings)
       SELECT 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
              src.name, src.description, src.pine_script, src.parsed_inputs, src.groups, src.strategy_settings
         FROM lab_strategies src
        WHERE src.user_id = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41'
          AND src.name IN ('SBR v1 – Structure Break & Retest', 'Adaptive Regime V3.8')
          AND NOT EXISTS (
            SELECT 1 FROM lab_strategies dest
             WHERE dest.user_id = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'
               AND dest.name = src.name
          )`,

      // --- Flash Trade adapter Phase 1: expand active_protocol CHECK to include 'flash'. ---
      // The original constraint (added in Group D item 18) only allowed ('pacifica', 'drift').
      // Drop-and-recreate is required because PostgreSQL does not support ALTER CONSTRAINT for
      // CHECK constraints. Idempotent: the DO block re-drops before adding, so re-running
      // against an already-migrated DB is safe and produces the final desired constraint.
      // No data backfill needed — no 'flash' rows exist yet; the constraint is broadened,
      // not narrowed, so existing rows are unaffected.
      `DO $$ BEGIN
         ALTER TABLE trading_bots DROP CONSTRAINT IF EXISTS trading_bots_active_protocol_check;
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_active_protocol_check
           CHECK (active_protocol IN ('pacifica', 'drift', 'flash'));
       END $$`,

      // --- bot_trades protocol label honesty. ---
      // The column originally defaulted to 'pacifica', so any insert that
      // omitted `protocol` was silently mislabeled as Pacifica regardless of
      // the actual venue (Flash/Drift). createBotTrade() now stamps the real
      // protocol from the owning bot, so drop the misleading default — a
      // genuinely unknown protocol should read NULL, never a wrong venue.
      // Idempotent: DROP DEFAULT is a no-op once the default is already gone.
      `ALTER TABLE bot_trades ALTER COLUMN protocol DROP DEFAULT`,

      // --- Task 188: QuantumLab backtest accuracy foundation. ---
      // Validity (out-of-sample holdout) + fidelity (slippage friction + engine
      // self-consistency check). All columns nullable / backward-compatible:
      // legacy runs read NULL (holdout disabled, no friction record, no parity),
      // and legacy result rows read NULL is/oos metrics. Each statement is
      // additive ADD COLUMN IF NOT EXISTS — idempotent, never drops anything.
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS oos_fraction real`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS slippage real`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS parity_match boolean`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS parity_diffs jsonb`,
      `ALTER TABLE lab_optimization_results ADD COLUMN IF NOT EXISTS is_metrics jsonb`,
      `ALTER TABLE lab_optimization_results ADD COLUMN IF NOT EXISTS oos_metrics jsonb`,

      // --- QuantumLab Sandbox Agent (Phase A): agent task state + run idempotency. ---
      // Additive + idempotent. lab_agent_tasks is the agent's durable working
      // memory (goal / plan / owned runs / leash counters). The agent_* columns on
      // lab_optimization_runs link a run to its owning task and make a resumed task
      // safe to retry: the partial UNIQUE index maps each
      // (user_id, agent_task_id, agent_idempotency_key) to ONE run, so a reconnect
      // can never double-queue on the single shared worker. Runs are the source of
      // truth; every non-agent (manual/UI) run leaves all agent_* columns NULL/false.
      `CREATE TABLE IF NOT EXISTS lab_agent_tasks (
        id serial PRIMARY KEY,
        wallet_address text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        mode text NOT NULL DEFAULT 'chat',
        goal text,
        plan jsonb,
        memory jsonb,
        active_run_id integer,
        owned_run_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        loop_count integer NOT NULL DEFAULT 0,
        spend_estimate_usd real NOT NULL DEFAULT 0,
        stop_reason text,
        last_reconciled_at timestamp,
        awaiting_since timestamp,
        cancel_requested_at timestamp,
        toolkit_version integer NOT NULL DEFAULT 1,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lab_agent_tasks_wallet_status ON lab_agent_tasks (wallet_address, status)`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_task_id integer`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_idempotency_key text`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_correlation_id text`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_owned boolean NOT NULL DEFAULT false`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_opt_runs_agent_idem
         ON lab_optimization_runs (user_id, agent_task_id, agent_idempotency_key)
         WHERE agent_idempotency_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_lab_opt_runs_agent_task
         ON lab_optimization_runs (agent_task_id)
         WHERE agent_task_id IS NOT NULL`,

      // --- QuantumLab Sandbox Agent (Phase B): chat transcript. ---
      // Additive + idempotent. Wallet-scoping is enforced in the storage layer
      // through the owning lab_agent_tasks row, never by task_id alone. The CHECK
      // lives INSIDE the CREATE so it ships atomically with a brand-new table and
      // never runs as a standalone ADD CONSTRAINT (which throws 42P07 on re-run
      // and would silently skip later migrations — see the per-statement note below).
      `CREATE TABLE IF NOT EXISTS lab_agent_messages (
        id serial PRIMARY KEY,
        task_id integer NOT NULL,
        role text NOT NULL CHECK (role IN ('user','agent','tool')),
        content text NOT NULL,
        suggested_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lab_agent_messages_task_created ON lab_agent_messages (task_id, created_at, id)`,

      // --- QuantumLab Sandbox Agent (Phase C): turn-loop orchestration state. ---
      // Additive + idempotent. The DB is the source of truth for the turn loop so a
      // turn can be resumed crash-safely; see server/lab-agent/orchestrator.ts.
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_state text NOT NULL DEFAULT 'ready'`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_lease text`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_lease_expires_at timestamp`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_state_changed_at timestamp`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS current_step jsonb`,

      // --- Phase 0a Vaults: per-wallet parked yield-asset positions. ---
      // Cost-basis accounting cache; on-chain token balance is display truth.
      // One row per (wallet, asset). Idempotent: safe on fresh / migrated DBs.
      `CREATE TABLE IF NOT EXISTS vault_positions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        asset_key text NOT NULL,
        mint text NOT NULL,
        token_amount_raw text NOT NULL DEFAULT '0',
        usdc_cost_basis numeric(20, 6) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'active',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT vault_positions_wallet_asset_unique UNIQUE (wallet_address, asset_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_vault_positions_wallet ON vault_positions (wallet_address)`,

      // --- Phase 4 Vaults: per-bot scoping for vault_positions. ---
      // trading_bot_id NULL = account-level vault (main agent wallet); non-null =
      // a specific bot's own per-bot wallet (Flash independent_trader). Additive +
      // idempotent. ORDER MATTERS: create the new partial unique indexes BEFORE
      // dropping the old blanket unique constraint, so uniqueness is never briefly
      // unenforced if a later statement fails. Plain column (no FK): on-chain is
      // truth, so an orphan cost-basis row after a bot delete is benign clutter.
      `ALTER TABLE vault_positions ADD COLUMN IF NOT EXISTS trading_bot_id varchar`,
      `CREATE UNIQUE INDEX IF NOT EXISTS vault_positions_account_unique ON vault_positions (wallet_address, asset_key) WHERE trading_bot_id IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS vault_positions_bot_unique ON vault_positions (wallet_address, trading_bot_id, asset_key) WHERE trading_bot_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_vault_positions_bot ON vault_positions (trading_bot_id) WHERE trading_bot_id IS NOT NULL`,
      `ALTER TABLE vault_positions DROP CONSTRAINT IF EXISTS vault_positions_wallet_asset_unique`,

      // --- Phase 1 Vaults: yield-oracle realized-APY price snapshots. ---
      // Display-only series; the yield oracle annualizes the movement of each
      // asset's on-chain price over time. One row per (asset, sample). Additive +
      // idempotent. Compound index serves the per-asset trailing-window scan.
      `CREATE TABLE IF NOT EXISTS yield_price_snapshots (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_key text NOT NULL,
        price_usdc_per_token numeric(30, 12) NOT NULL,
        as_of timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_yield_price_snapshots_asset_time ON yield_price_snapshots (asset_key, as_of)`,

      // --- Vaults: external (DeFiLlama) realized-APY cache. ---
      // One upserted row per asset_key holding the last-good REAL APY from the
      // external yield index, so a cold process / restart serves a measured number
      // immediately and the UI never regresses to an estimate during a brief upstream
      // outage. Display-only (no money). Additive + idempotent.
      `CREATE TABLE IF NOT EXISTS yield_apy_cache (
        asset_key text PRIMARY KEY,
        apy numeric(10, 4),
        apy_base numeric(10, 4),
        apy_reward numeric(10, 4),
        apy_mean_30d numeric(10, 4),
        source text NOT NULL,
        pool_id text,
        as_of timestamp NOT NULL DEFAULT now()
      )`,

      // --- SOL Loop Vault P3: hourly rate telemetry (allocation-tick input). ---
      // Rates are FRACTIONS (0.08 = 8%), nullable per-field (partial upstream
      // outage still records readable fields; policy fails closed on null at
      // read time). Telemetry/policy input only — money paths re-read live.
      // Bounded retention (pruned by the sampler). Additive + idempotent.
      `CREATE TABLE IF NOT EXISTS loop_rate_samples (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        vault_id integer NOT NULL,
        symbol text NOT NULL,
        staking_apy numeric(12, 8),
        staking_apy_mean_30d numeric(12, 8),
        borrow_apr numeric(12, 8),
        withdraw_utilization numeric(8, 6),
        net_carry_2x numeric(12, 8),
        liquidation_threshold numeric(8, 6),
        as_of timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_loop_rate_samples_vault_time ON loop_rate_samples (vault_id, as_of)`,
      // Dynamic-leverage input: vault LT sampled into the rate row (additive;
      // pre-migration rows stay null → consumers fail closed, self-heals on
      // the next hourly sample).
      `ALTER TABLE loop_rate_samples ADD COLUMN IF NOT EXISTS liquidation_threshold numeric(8, 6)`,

      // --- Vaults borrow engine (Phase A scaffold): debt LEDGER. ---
      // Empty + additive; NO writers wired yet (Phase A = spec & hard gates, no
      // money moves). One row per isolated borrow position. Scope mirrors
      // vault_positions / server/vault/scope.ts: trading_bot_id NULL = account
      // level (agent-main wallet pledges to Jupiter Lend/Fluid); non-null = a
      // bot's own per-bot wallet (Flash). MONEY-SAFETY: debt is a LIABILITY — it
      // is NEVER folded into equity_events / sumNetDepositedFromEvents (that
      // would fabricate PnL); displayed equity = assets − debt. Health is read
      // AUTHORITATIVELY on-chain (REST = cross-check only); health_as_of is the
      // ORACLE publish time, never the pool liquidity lastUpdateTimestamp. The
      // active-position uniqueness model is deferred to the build phase (no
      // writers exist to constrain yet); only non-unique scope indexes here.
      // Policy-neutral columns only: hard max-LTV cap and fee/monetization model
      // are PENDING owner decisions and live in config/policy, not this schema.
      `CREATE TABLE IF NOT EXISTS borrow_positions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        trading_bot_id varchar,
        debt_venue text NOT NULL,
        venue_vault_id text,
        venue_position_id text,
        collateral_asset_key text NOT NULL,
        collateral_mint text NOT NULL,
        collateral_amount_raw text NOT NULL DEFAULT '0',
        debt_asset_key text NOT NULL DEFAULT 'usdc',
        debt_mint text NOT NULL,
        debt_amount_raw text NOT NULL DEFAULT '0',
        attributed_bot_id varchar,
        status text NOT NULL DEFAULT 'pending',
        health_snapshot jsonb,
        health_as_of timestamp,
        health_source text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_positions_wallet ON borrow_positions (wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_positions_bot ON borrow_positions (trading_bot_id) WHERE trading_bot_id IS NOT NULL`,
      // Additive: persist the venue's position id (Jupiter Lend NFT) for repay/
      // close/monitor. Idempotent for DBs created before this column existed.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS venue_position_id text`,
      // Additive (FC-2): durable borrow-health alert state so band-crossing
      // Telegram alerts survive restarts, never repeat for the same band, and
      // only reset downward after anti-flap hysteresis. Mirrors schema.ts.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_observed_health_band text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS health_band_changed_at timestamp`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_health_alert_band text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_health_alert_at timestamp`,
      // Additive: auto collateral top-up ("defend the loan") throttle timestamp.
      // The autonomous scanner claims a position by stamping this, so a loan that
      // stays urgent can't re-fire (top-up OR alert) within the cooldown window.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_auto_topup_attempt_at timestamp`,
      // Additive (SOL Loop Vault P2): position-family discriminator. 'borrow' =
      // the shipped LST→stable engine; 'loop' = leveraged LST→WSOL staking loop.
      // Existing rows are borrow rows, so the default backfills correctly.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'borrow'`,
      // Additive (SOL Loop Vault P3): policy brain state on kind='loop' rows.
      // 'levered' (has debt, safety-tick eligible) | 'holding' (zero debt, HF
      // null — excluded from keeper decideDeleverage). Null on borrow rows.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS policy_state text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS policy_reason text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS policy_state_changed_at timestamp`,
      // Additive (SOL Loop Vault P3): safety-tick action throttle on loop rows.
      // The reflex claims a position by stamping this atomically, so an unhealthy
      // loop is handed to the executor at most once per cooldown window.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_policy_action_at timestamp`,

      // --- SOL Loop Vault P3: append-only policy decision journal. ---
      // One row per tick evaluation (including outcome 'none') so hysteresis is
      // DB-derived and the observation gate is one SQL pass. Never a money gate.
      `CREATE TABLE IF NOT EXISTS loop_policy_decisions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        borrow_position_id varchar,
        vault_id integer NOT NULL,
        tick text NOT NULL,
        action text NOT NULL,
        fraction numeric(8, 6),
        reason text NOT NULL,
        details jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_loop_policy_decisions_vault_time ON loop_policy_decisions (vault_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_loop_policy_decisions_wallet ON loop_policy_decisions (wallet_address)`,

      // --- SOL Loop Vault P3 (T106): tick heartbeats for the observation gate. ---
      // One row per completed safety/allocation pass; lets the admin status
      // route measure tick coverage even with zero loop positions. Pruned.
      `CREATE TABLE IF NOT EXISTS loop_tick_heartbeats (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tick text NOT NULL,
        evaluated integer NOT NULL DEFAULT 0,
        acted integer NOT NULL DEFAULT 0,
        failed integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_loop_tick_heartbeats_tick_time ON loop_tick_heartbeats (tick, created_at)`,

      // --- Vaults borrow engine (Phase A scaffold): money-op AUDIT log. ---
      // Append-only record of every multi-hop borrow/repay/carry operation, so
      // the (future) money state machine is resumable + idempotent: DB-unique
      // operation id + per-step on-chain tx signatures + status/step, mirroring
      // the audited park/unpark safety model. Empty + additive; no writers yet.
      `CREATE TABLE IF NOT EXISTS borrow_operations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        borrow_position_id varchar,
        operation_type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        step text,
        tx_signatures jsonb NOT NULL DEFAULT '[]',
        error text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_operations_wallet ON borrow_operations (wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_operations_position ON borrow_operations (borrow_position_id) WHERE borrow_position_id IS NOT NULL`,
      // Additive (resumable + idempotent multi-hop repays): caller idempotency
      // key + resume-context metadata + immutable result payload. Idempotent for
      // DBs created before these columns existed. Each ALTER is its own statement
      // so a re-run that no-ops one never skips a later migration.
      `ALTER TABLE borrow_operations ADD COLUMN IF NOT EXISTS client_request_id text`,
      `ALTER TABLE borrow_operations ADD COLUMN IF NOT EXISTS metadata jsonb`,
      `ALTER TABLE borrow_operations ADD COLUMN IF NOT EXISTS result jsonb`,
      // UNIQUE per (wallet, client_request_id) so a retried logical op reuses its
      // row instead of double-executing. Partial: only enforced on non-null keys.
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_borrow_operations_client_req ON borrow_operations (wallet_address, client_request_id) WHERE client_request_id IS NOT NULL`,

      // --- Fixed Yield vault: PT holdings bought on a fixed-rate venue. ---
      // One row per open PT position (Exponent first). On-chain PT balance is
      // the display truth; this row is cost-basis + maturity bookkeeping. Ops
      // audit through borrow_operations (fy_deposit / fy_exit / fy_redeem).
      `CREATE TABLE IF NOT EXISTS fy_positions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        venue text NOT NULL DEFAULT 'exponent',
        market_address text NOT NULL,
        venue_vault_address text,
        pt_mint text NOT NULL,
        pt_decimals integer NOT NULL DEFAULT 9,
        underlying_mint text NOT NULL,
        underlying_symbol text NOT NULL,
        pt_amount_raw text NOT NULL DEFAULT '0',
        cost_basis_usdc numeric(20, 6) NOT NULL DEFAULT '0',
        implied_apy_at_entry numeric(10, 6),
        maturity_at timestamp NOT NULL,
        status text NOT NULL DEFAULT 'active',
        notified_maturity_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_fy_positions_wallet ON fy_positions (wallet_address)`,
    ];
    // Fault-isolate EACH migration. These statements are written to be
    // idempotent, but some still throw on re-run with an error their inner
    // guard doesn't trap: e.g. `ADD CONSTRAINT ... UNIQUE` raises
    // duplicate_table (42P07, "relation ... already exists") when its backing
    // index already exists, while the DO/EXCEPTION block only catches
    // duplicate_object (42710). Running the whole list under a single
    // try/catch meant one such throw aborted the loop and SILENTLY SKIPPED
    // every later migration — this is exactly how the Flash active_protocol
    // constraint (the last item) never reached production. Per-statement
    // isolation guarantees every migration is attempted on every boot.
    let skipped = 0;
    for (const sql of migrations) {
      try {
        await client.query(sql);
      } catch (err: any) {
        skipped++;
        const firstLine = sql.trim().split("\n")[0].slice(0, 120);
        console.warn(`[DB] Schema migration skipped (${err.code || "error"}): ${firstLine} — ${err.message}`);
      }
    }
    if (skipped === 0) {
      console.log("[DB] Schema check complete");
    } else {
      console.warn(`[DB] Schema check complete with ${skipped} skipped statement(s) (see warnings above)`);
    }
  } catch (err: any) {
    console.warn("[DB] Schema check warning:", err.message);
  } finally {
    client.release();
  }
}

/**
 * V3 Phase 0 startup health-check.
 *
 * Once any wallet row has been re-keyed to umk_version >= 3, the server MUST
 * have a valid UMK_STORAGE_SECRET configured or those users will be unable to
 * decrypt their UMK at all. Fail fast at startup rather than at first login.
 *
 * On a fresh DB (no v3 rows yet) the check is a no-op so the very first deploy
 * of Phase 0 doesn't refuse to boot before any user has signed in.
 */
export async function checkUmkStorageSecretHealth(): Promise<void> {
  // Strict, shared validator — matches the runtime v3 storage-key derivation
  // exactly (regex + hex decode + 32-byte length check). Never accept a
  // weaker definition of "configured" here than the crypto code uses.
  const { isUmkStorageSecretValid } = await import('./session-v3');
  const { storage } = await import('./storage');
  const secretOk = isUmkStorageSecretValid();

  // Fail-CLOSED. If the DB lookup can't be completed we cannot prove the
  // safety invariant (no v3 rows without a valid secret), so we refuse to
  // boot rather than risk silently locking re-keyed users out of their UMK.
  // The previous fail-open path was a high-severity gap flagged in review.
  // Delegated to the IStorage method so the check and any future
  // operator-facing surface (e.g. /admin/umk-status) cannot drift apart.
  let hasV3: boolean;
  try {
    hasV3 = await storage.hasAnyUmkV3OrAbove();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      '[Startup] FATAL: UMK health check could not query wallets table: ' +
      msg +
      '. Refusing to boot - cannot prove UMK_STORAGE_SECRET safety invariant.'
    );
  }

  if (hasV3 && !secretOk) {
    throw new Error(
      '[Startup] FATAL: UMK_STORAGE_SECRET is missing or malformed but at least one wallet ' +
      'has umk_version >= 3. Refusing to boot - users would lose UMK access. ' +
      'Set UMK_STORAGE_SECRET to the original 64-hex value used at re-keying.'
    );
  }

  if (secretOk) {
    console.log(`[Startup] UMK_STORAGE_SECRET configured (v3 rows present: ${hasV3 ? 'yes' : 'no'})`);
  } else {
    console.warn('[Startup] UMK_STORAGE_SECRET not configured. Safe for now (no v3 rows), but Phase 0 will require it once any wallet signs in.');
  }
}

/**
 * V3 Phase 1 startup config summary.
 *
 * One-shot INFO log summarizing the encryption-key configuration surface so
 * operators can spot config drift between dev / staging / prod at a glance.
 * Reports presence (never values) of the three security env vars and the
 * presence of every V3-related wallet column. Prints once per boot, right
 * after the UMK health check.
 *
 * Intentionally read-only and side-effect-free beyond the log line.
 */
export async function logSecurityConfigSummary(): Promise<void> {
  const envPresence = {
    AGENT_ENCRYPTION_KEY: Boolean(process.env.AGENT_ENCRYPTION_KEY),
    UMK_STORAGE_SECRET: Boolean(process.env.UMK_STORAGE_SECRET),
    SERVER_EXECUTION_KEY: Boolean(process.env.SERVER_EXECUTION_KEY),
  };

  // Inspect the live `wallets` schema rather than trusting the ORM definition,
  // so a column that was dropped/renamed in production but still referenced
  // in code is surfaced loudly here at boot.
  const client = await pool.connect();
  let columns: string[] = [];
  try {
    const result = await client.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'wallets'
         AND column_name IN (
           'agent_private_key_encrypted',
           'agent_private_key_encrypted_v3',
           'encrypted_user_master_key',
           'encrypted_mnemonic_words',
           'umk_encrypted_for_execution',
           'umk_version',
           'user_salt',
           'execution_enabled'
         )
    `);
    columns = result.rows.map(r => r.column_name).sort();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Startup][SecurityConfig] Could not inspect wallets schema: ' + msg);
  } finally {
    client.release();
  }

  console.log(
    '[Startup][SecurityConfig] envVars=' + JSON.stringify(envPresence) +
    ' walletColumns=' + JSON.stringify(columns)
  );
}
