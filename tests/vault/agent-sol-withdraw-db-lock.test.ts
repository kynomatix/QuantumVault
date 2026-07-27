/**
 * tests/vault/agent-sol-withdraw-db-lock.test.ts — WO2B2B (matrix #13)
 *
 * REAL-DATABASE advisory-lock semantics for the withdrawal write-ahead:
 * pg_advisory_xact_lock(927411, hashtext(wallet)) taken by the precommit and
 * finalize transactions must be mutually exclusive per wallet, independent
 * across wallets, and released exactly at transaction end.
 *
 * Runs only when DATABASE_URL is present (skipped otherwise). Uses two
 * separate single-connection pools so the two sides are guaranteed distinct
 * backends. Deliberately does NOT import server code — the namespace parity
 * with server/storage.ts is pinned by a source-text check here and by the
 * exported-constant assertion in agent-sol-withdraw-storage.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import pg from "pg";

const NS = 927411; // AGENT_SOL_WITHDRAW_LOCK_NAMESPACE
const IT_TIMEOUT = 20_000;

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("agent-sol-withdraw advisory lock (real DB)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;

  beforeAll(() => {
    poolA = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    poolB = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    // Every pg.Pool needs an error handler or an idle-connection error kills the process.
    poolA.on("error", () => {});
    poolB.on("error", () => {});
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
  });

  /** Try to take the xact lock on `pool` in a throwaway transaction; returns the boolean. */
  async function tryLockOnce(pool: pg.Pool, wallet: string): Promise<boolean> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query("SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS got", [
        NS,
        wallet,
      ]);
      return r.rows[0].got === true;
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  }

  it(
    "namespace parity: server/storage.ts pins AGENT_SOL_WITHDRAW_LOCK_NAMESPACE = 927411",
    () => {
      const src = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf-8");
      expect(src).toMatch(/AGENT_SOL_WITHDRAW_LOCK_NAMESPACE\s*=\s*927411/);
    },
    IT_TIMEOUT
  );

  it(
    "same wallet is mutually exclusive while the holder's transaction is open, free after ROLLBACK",
    async () => {
      const wallet = `lock-test-wallet-${Date.now()}-a`;
      const holder = await poolA.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NS, wallet]);

        expect(await tryLockOnce(poolB, wallet)).toBe(false);

        await holder.query("ROLLBACK");

        expect(await tryLockOnce(poolB, wallet)).toBe(true);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    },
    IT_TIMEOUT
  );

  it(
    "different wallets never contend (hashtext keying is per-wallet)",
    async () => {
      const wallet1 = `lock-test-wallet-${Date.now()}-b1`;
      const wallet2 = `lock-test-wallet-${Date.now()}-b2`;
      const holder = await poolA.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NS, wallet1]);

        expect(await tryLockOnce(poolB, wallet2)).toBe(true);
        // …while the SAME wallet still blocks, in the same held window.
        expect(await tryLockOnce(poolB, wallet1)).toBe(false);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    },
    IT_TIMEOUT
  );

  it(
    "the BLOCKING variant (used by precommit/finalize) waits and acquires exactly when the holder commits",
    async () => {
      const wallet = `lock-test-wallet-${Date.now()}-c`;
      const holder = await poolA.connect();
      const waiterConn = await poolB.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NS, wallet]);

        await waiterConn.query("BEGIN");
        let waiterDone = false;
        const waiter = waiterConn
          .query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [NS, wallet])
          .then(() => {
            waiterDone = true;
          });

        // The waiter must still be parked while the holder's tx is open.
        await new Promise((r) => setTimeout(r, 400));
        expect(waiterDone).toBe(false);

        await holder.query("COMMIT");
        await waiter; // resolves only once the lock transfers
        expect(waiterDone).toBe(true);
      } finally {
        await waiterConn.query("ROLLBACK").catch(() => {});
        waiterConn.release();
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    },
    IT_TIMEOUT
  );
});
