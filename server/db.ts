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
