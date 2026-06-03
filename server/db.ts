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

      // --- Task 149: per-bot Pacifica enrollment flags ---
      // Phase 4b bots are their own Pacifica main accounts (keypair behind
      // bot_subaccount_key_encrypted_v3, pubkey in protocol_subaccount_id),
      // so enrollment must be tracked per-bot. Mirrors the wallets flags
      // above. Default false → migrated lazily on the bot's next trade.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS pacifica_builder_approved boolean NOT NULL DEFAULT false`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS pacifica_referral_claimed boolean NOT NULL DEFAULT false`,

      // --- Phase 4b (Flash agent-HD wallets): recoverable per-bot wallet indices. ---
      // Additive + idempotent. The allocator lives on `wallets` (burn-on-allocate,
      // never reused). Each agent_hd bot stores its non-secret HD index + path version;
      // legacy random bots leave both NULL. DB-level CHECK/UNIQUE are the real fund-safety
      // enforcement so a manual or buggy write can never commingle two bots on one wallet.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS next_bot_derivation_index integer NOT NULL DEFAULT 1`,
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
