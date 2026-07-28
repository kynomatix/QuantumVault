/**
 * Real-PostgreSQL proof for WO-R1's short reset critical section. Skips when
 * DATABASE_URL is absent. Fixture rows use a unique wallet and are deleted in
 * finally/afterAll; no production wallet is read or mutated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import pg from "pg";

const hasDb = !!process.env.DATABASE_URL;
const TIMEOUT = 30_000;

describe.skipIf(!hasDb)("Reset Agent Wallet atomic finalizer (real DB)", () => {
  let pool: pg.Pool;
  let storage: any;
  const walletsToDelete: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    pool.on("error", () => {});
    const mod = await import("../../server/storage");
    storage = new mod.DatabaseStorage();
  });

  afterAll(async () => {
    for (const wallet of walletsToDelete) {
      await pool.query("DELETE FROM wallets WHERE address = $1", [wallet]).catch(() => {});
    }
    await pool?.end();
  });

  async function seed(suffix: string) {
    const wallet = `wo-r1-reset-${Date.now()}-${suffix}`;
    const oldKey = `old-agent-${suffix}`;
    walletsToDelete.push(wallet);
    await pool.query(
      `INSERT INTO wallets
         (address, agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words)
       VALUES ($1, $2, $3, $4)`,
      [wallet, oldKey, `old-v3-${suffix}`, `old-mnemonic-${suffix}`],
    );
    await pool.query(
      `INSERT INTO trading_bots
         (wallet_address, name, market, webhook_secret, drift_subaccount_id, active_protocol)
       VALUES ($1, $2, 'SOL-PERP', $3, 7, 'drift')`,
      [wallet, `reset-test-${suffix}`, `reset-secret-${Date.now()}-${suffix}`],
    );
    return { wallet, oldKey };
  }

  it("pins the distinct non-blocking advisory-lock namespace", () => {
    const src = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf8");
    expect(src).toMatch(/AGENT_WALLET_RESET_LOCK_NAMESPACE\s*=\s*927412/);
    expect(src).toMatch(/pg_try_advisory_xact_lock/);
  });

  it("commits mnemonic + public key + V3 key and bot clearing as one generation", async () => {
    const { wallet, oldKey } = await seed("atomic");

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "new-mnemonic-atomic",
      newAgentPublicKey: "new-agent-atomic",
      newAgentPrivateKeyEncryptedV3: "new-v3-atomic",
    });

    expect(outcome).toEqual({ outcome: "committed", clearedBotCount: 1 });
    const row = await pool.query(
      `SELECT agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words
         FROM wallets WHERE address = $1`,
      [wallet],
    );
    expect(row.rows[0]).toEqual({
      agent_public_key: "new-agent-atomic",
      agent_private_key_encrypted_v3: "new-v3-atomic",
      encrypted_mnemonic_words: "new-mnemonic-atomic",
    });
    const bot = await pool.query("SELECT drift_subaccount_id FROM trading_bots WHERE wallet_address = $1", [wallet]);
    expect(bot.rows[0].drift_subaccount_id).toBeNull();
  }, TIMEOUT);

  it("an entry-key CAS loser cannot overwrite the installed generation", async () => {
    const { wallet, oldKey } = await seed("cas");
    const first = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "winner-mnemonic",
      newAgentPublicKey: "winner-agent",
      newAgentPrivateKeyEncryptedV3: "winner-v3",
    });
    expect(first.outcome).toBe("committed");

    const loser = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "loser-mnemonic",
      newAgentPublicKey: "loser-agent",
      newAgentPrivateKeyEncryptedV3: "loser-v3",
    });
    expect(loser).toEqual({ outcome: "lost_race", keyChanged: true });

    const row = await pool.query(
      `SELECT agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words
         FROM wallets WHERE address = $1`,
      [wallet],
    );
    expect(row.rows[0]).toEqual({
      agent_public_key: "winner-agent",
      agent_private_key_encrypted_v3: "winner-v3",
      encrypted_mnemonic_words: "winner-mnemonic",
    });
  }, TIMEOUT);

  it("rechecks non-terminal vault operations inside the lock before the guarded update", async () => {
    const { wallet, oldKey } = await seed("blocker");
    await pool.query(
      `INSERT INTO borrow_operations (wallet_address, operation_type, status, step)
       VALUES ($1, 'future_money_op', 'pending', 'in_flight')`,
      [wallet],
    );

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "must-not-land-mnemonic",
      newAgentPublicKey: "must-not-land-agent",
      newAgentPrivateKeyEncryptedV3: "must-not-land-v3",
    });
    expect(outcome).toEqual({ outcome: "blocked", reason: "active_vault_state" });

    const row = await pool.query(
      `SELECT agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words
         FROM wallets WHERE address = $1`,
      [wallet],
    );
    expect(row.rows[0]).toEqual({
      agent_public_key: oldKey,
      agent_private_key_encrypted_v3: "old-v3-blocker",
      encrypted_mnemonic_words: "old-mnemonic-blocker",
    });
    const bot = await pool.query("SELECT drift_subaccount_id FROM trading_bots WHERE wallet_address = $1", [wallet]);
    expect(bot.rows[0].drift_subaccount_id).toBe(7);
  }, TIMEOUT);

  it("two overlapping finalizers install exactly one complete generation", async () => {
    const { wallet, oldKey } = await seed("overlap");
    const attempt = (name: string) => storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: `${name}-mnemonic`,
      newAgentPublicKey: `${name}-agent`,
      newAgentPrivateKeyEncryptedV3: `${name}-v3`,
    });

    const outcomes = await Promise.all([attempt("a"), attempt("b")]);
    expect(outcomes.filter((o) => o.outcome === "committed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "busy" || o.outcome === "lost_race")).toHaveLength(1);

    const row = await pool.query(
      `SELECT agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words
         FROM wallets WHERE address = $1`,
      [wallet],
    );
    const prefix = String(row.rows[0].agent_public_key).split("-")[0];
    expect(["a", "b"]).toContain(prefix);
    expect(row.rows[0].agent_private_key_encrypted_v3).toBe(`${prefix}-v3`);
    expect(row.rows[0].encrypted_mnemonic_words).toBe(`${prefix}-mnemonic`);
  }, TIMEOUT);

  it("different wallets do not globally serialize", async () => {
    const left = await seed("left");
    const right = await seed("right");
    const run = (p: { wallet: string; oldKey: string }, name: string) => storage.finalizeAgentWalletReset({
      walletAddress: p.wallet,
      observedAgentPublicKey: p.oldKey,
      encryptedMnemonicWords: `${name}-mnemonic`,
      newAgentPublicKey: `${name}-agent`,
      newAgentPrivateKeyEncryptedV3: `${name}-v3`,
    });

    const outcomes = await Promise.all([run(left, "left"), run(right, "right")]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["committed", "committed"]);
  }, TIMEOUT);
});
