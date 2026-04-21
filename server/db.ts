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
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("[DB Pool] Idle client error (suppressed crash):", err.message);
});

export const db = drizzle(pool, { schema });

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
    ];
    for (const sql of migrations) {
      await client.query(sql);
    }
    console.log("[DB] Schema check complete");
  } catch (err: any) {
    console.warn("[DB] Schema check warning:", err.message);
  } finally {
    client.release();
  }
}
