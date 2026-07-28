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
      await pool.query("DELETE FROM borrow_operations WHERE wallet_address = $1", [wallet]).catch(() => {});
      await pool.query("DELETE FROM borrow_positions WHERE wallet_address = $1", [wallet]).catch(() => {});
      await pool.query("DELETE FROM orphaned_subaccounts WHERE wallet_address = $1", [wallet]).catch(() => {});
      await pool.query("DELETE FROM protocol_subaccounts WHERE wallet_address = $1", [wallet]).catch(() => {});
      await pool.query("DELETE FROM ai_trader_bots WHERE wallet_address = $1", [wallet]).catch(() => {});
      await pool.query("DELETE FROM trading_bots WHERE wallet_address = $1", [wallet]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE address = $1", [wallet]).catch(() => {});
    }
    await pool?.end();
  });

  async function seed(suffix: string) {
    const wallet = `wo-r1-reset-${Date.now()}-${suffix}`;
    const oldKey = "11111111111111111111111111111111";
    walletsToDelete.push(wallet);
    await pool.query(
      `INSERT INTO wallets
         (address, agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words)
       VALUES ($1, $2, $3, $4)`,
      [wallet, oldKey, `old-v3-${suffix}`, `old-mnemonic-${suffix}`],
    );
    await pool.query(
      `INSERT INTO trading_bots
         (wallet_address, name, market, webhook_secret, drift_subaccount_id,
          active_protocol, subaccount_auth_mode, subaccount_status)
       VALUES ($1, $2, 'SOL-PERP', $3, NULL, 'drift', 'main_plus_id', 'none')`,
      [wallet, `reset-test-${suffix}`, `reset-secret-${Date.now()}-${suffix}`],
    );
    return { wallet, oldKey };
  }

  it("pins the distinct non-blocking advisory-lock namespace", () => {
    const src = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf8");
    expect(src).toMatch(/AGENT_WALLET_RESET_LOCK_NAMESPACE\s*=\s*927412/);
    expect(src).toMatch(/pg_try_advisory_xact_lock/);
  });

  it("commits mnemonic + public key + V3 key as one generation", async () => {
    const { wallet, oldKey } = await seed("atomic");

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "new-mnemonic-atomic",
      newAgentPublicKey: "new-agent-atomic",
      newAgentPrivateKeyEncryptedV3: "new-v3-atomic",
    });

    expect(outcome).toEqual({ outcome: "committed", clearedBotCount: 0 });
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
    await pool.query("UPDATE trading_bots SET drift_subaccount_id = 7 WHERE wallet_address = $1", [wallet]);
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

  it("returns busy while another connection holds the wallet reset lock, then commits after release", async () => {
    const { wallet, oldKey } = await seed("held-lock");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(927412, hashtext($1))", [wallet]);

      const busy = await storage.finalizeAgentWalletReset({
        walletAddress: wallet,
        observedAgentPublicKey: oldKey,
        encryptedMnemonicWords: "must-not-land-mnemonic",
        newAgentPublicKey: "must-not-land-agent",
        newAgentPrivateKeyEncryptedV3: "must-not-land-v3",
      });
      expect(busy).toEqual({ outcome: "busy" });

      const unchanged = await pool.query(
        "SELECT agent_public_key FROM wallets WHERE address = $1",
        [wallet],
      );
      expect(unchanged.rows[0].agent_public_key).toBe(oldKey);
      await holder.query("ROLLBACK");

      const committed = await storage.finalizeAgentWalletReset({
        walletAddress: wallet,
        observedAgentPublicKey: oldKey,
        encryptedMnemonicWords: "after-release-mnemonic",
        newAgentPublicKey: "after-release-agent",
        newAgentPrivateKeyEncryptedV3: "after-release-v3",
      });
      expect(committed.outcome).toBe("committed");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  }, TIMEOUT);

  it.each([
    {
      label: "trading_bots",
      reason: "agent_authority_custody",
      arrange: async (wallet: string, _oldKey: string) => pool.query(
        "UPDATE trading_bots SET drift_subaccount_id = 0 WHERE wallet_address = $1",
        [wallet],
      ),
    },
    {
      label: "ai_trader_bots",
      reason: "agent_authority_custody",
      arrange: async (wallet: string, _oldKey: string) => pool.query(
        `INSERT INTO ai_trader_bots
           (wallet_address, protocol, protocol_subaccount_id,
            bot_subaccount_key_encrypted_v3, market, timeframe, allocated_usdc)
         VALUES ($1, 'pacifica', 'ai-keyed', 'ai-v3', 'SOL-PERP', '1h', '10')`,
        [wallet],
      ),
    },
    {
      label: "protocol_subaccounts",
      reason: "custody_transition_in_flight",
      arrange: async (wallet: string, oldKey: string) => pool.query(
        `INSERT INTO protocol_subaccounts
           (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
            subaccount_key_encrypted_v3, aad_version, claim_token, claimed_at)
         VALUES ($1, 'flash', $2, 'reserving', $3, 'pooled-v3', 2, 'claim-token', NOW())`,
        [wallet, `flash-reserving-${wallet}`, oldKey],
      ),
    },
    {
      label: "orphaned_subaccounts",
      reason: "agent_authority_custody",
      arrange: async (wallet: string, oldKey: string) => pool.query(
        `INSERT INTO orphaned_subaccounts
           (wallet_address, agent_public_key, drift_subaccount_id, reason)
         VALUES ($1, $2, 9, 'fixture')`,
        [wallet, oldKey],
      ),
    },
  ])("transaction-bound $label custody blocks reset", async ({ label, reason, arrange }) => {
    const { wallet, oldKey } = await seed(`custody-${label}`);
    await arrange(wallet, oldKey);

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "must-not-land-mnemonic",
      newAgentPublicKey: "must-not-land-agent",
      newAgentPrivateKeyEncryptedV3: "must-not-land-v3",
    });

    expect(outcome).toEqual({ outcome: "blocked", reason });
    const unchanged = await pool.query("SELECT agent_public_key FROM wallets WHERE address = $1", [wallet]);
    expect(unchanged.rows[0].agent_public_key).toBe(oldKey);
  }, TIMEOUT);

  it("successful reset deletes only verified-empty spares from the retiring generation", async () => {
    const { wallet, oldKey } = await seed("spare-cleanup");
    const otherKey = "So11111111111111111111111111111111111111112";
    const oldSpare = `old-safe-spare-${wallet}`;
    const otherSpare = `other-safe-spare-${wallet}`;
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
          subaccount_key_encrypted_v3, aad_version, released_at, last_verified_empty_at)
       VALUES
         ($1, 'pacifica', $2, 'spare', $3, 'old-pooled', 2, NOW(), NOW()),
         ($1, 'pacifica', $4, 'spare', $5, 'other-pooled', 2, NOW(), NOW())`,
      [wallet, oldSpare, oldKey, otherSpare, otherKey],
    );

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "new-mnemonic",
      newAgentPublicKey: "new-agent",
      newAgentPrivateKeyEncryptedV3: "new-v3",
    });
    expect(outcome.outcome).toBe("committed");
    const rows = await pool.query(
      "SELECT protocol_subaccount_id FROM protocol_subaccounts WHERE wallet_address = $1 ORDER BY protocol_subaccount_id",
      [wallet],
    );
    expect(rows.rows.map((r) => r.protocol_subaccount_id)).toEqual([otherSpare]);
  }, TIMEOUT);

  it("ignores nullable unlinked protocol scaffolding but retains the audit row", async () => {
    const { wallet, oldKey } = await seed("unlinked-scaffolding");
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key)
       VALUES ($1, 'pacifica', NULL, 'legacy_scaffold', NULL)`,
      [wallet],
    );

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "new-mnemonic-scaffold",
      newAgentPublicKey: "new-agent-scaffold",
      newAgentPrivateKeyEncryptedV3: "new-v3-scaffold",
    });

    expect(outcome).toEqual({ outcome: "committed", clearedBotCount: 0 });
    const retained = await pool.query(
      "SELECT protocol_subaccount_id, agent_public_key, status FROM protocol_subaccounts WHERE wallet_address = $1",
      [wallet],
    );
    expect(retained.rows).toEqual([{
      protocol_subaccount_id: null,
      agent_public_key: null,
      status: "legacy_scaffold",
    }]);
  }, TIMEOUT);

  it("blocks reset while an independently keyed external account remains linked", async () => {
    const { wallet, oldKey } = await seed("external-link-preserved");
    const externalId = `external-${wallet}`;
    await pool.query(
      `INSERT INTO trading_bots
         (wallet_address, name, market, webhook_secret, drift_subaccount_id,
          protocol_subaccount_id, active_protocol, subaccount_auth_mode,
          subaccount_status, bot_subaccount_key_encrypted_v3)
       VALUES ($1, 'external bot', 'SOL-PERP', $2, 0, $3,
               'pacifica', 'external_key', 'active', 'bot-v3')`,
      [wallet, `external-secret-${wallet}`, externalId],
    );
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
          subaccount_key_encrypted_v3, aad_version)
       VALUES ($1, 'pacifica', $2, 'active', $3, 'pooled-v3', 2)`,
      [wallet, externalId, oldKey],
    );

    const outcome = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "new-mnemonic",
      newAgentPublicKey: "new-agent",
      newAgentPrivateKeyEncryptedV3: "new-v3",
    });

    expect(outcome).toEqual({ outcome: "blocked", reason: "agent_authority_custody" });
    const linked = await pool.query(
      "SELECT drift_subaccount_id, protocol_subaccount_id FROM trading_bots WHERE wallet_address = $1 AND protocol_subaccount_id = $2",
      [wallet, externalId],
    );
    expect(linked.rows[0]).toEqual({ drift_subaccount_id: 0, protocol_subaccount_id: externalId });
    const unchangedWallet = await pool.query(
      "SELECT agent_public_key, agent_private_key_encrypted_v3, encrypted_mnemonic_words FROM wallets WHERE address = $1",
      [wallet],
    );
    expect(unchangedWallet.rows[0]).toEqual({
      agent_public_key: oldKey,
      agent_private_key_encrypted_v3: "old-v3-external-link-preserved",
      encrypted_mnemonic_words: "old-mnemonic-external-link-preserved",
    });
  }, TIMEOUT);

  it("retry-exhausted matching orphan blocks while another generation does not", async () => {
    const matching = await seed("orphan-matching");
    await pool.query(
      "INSERT INTO orphaned_subaccounts (wallet_address, agent_public_key, drift_subaccount_id, retry_count) VALUES ($1, $2, 12, 500)",
      [matching.wallet, matching.oldKey],
    );
    expect((await storage.finalizeAgentWalletReset({
      walletAddress: matching.wallet,
      observedAgentPublicKey: matching.oldKey,
      encryptedMnemonicWords: "x",
      newAgentPublicKey: "y",
      newAgentPrivateKeyEncryptedV3: "z",
    })).outcome).toBe("blocked");

    const different = await seed("orphan-different");
    await pool.query(
      "INSERT INTO orphaned_subaccounts (wallet_address, agent_public_key, drift_subaccount_id) VALUES ($1, $2, 13)",
      [different.wallet, "So11111111111111111111111111111111111111112"],
    );
    expect((await storage.finalizeAgentWalletReset({
      walletAddress: different.wallet,
      observedAgentPublicKey: different.oldKey,
      encryptedMnemonicWords: "new-mnemonic",
      newAgentPublicKey: "new-agent",
      newAgentPrivateKeyEncryptedV3: "new-v3",
    })).outcome).toBe("committed");
  }, TIMEOUT);

  it("stale prepare and spare claim are rejected after reset changes the generation", async () => {
    const { wallet, oldKey } = await seed("stale-writer");
    const reset = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "new-mnemonic",
      newAgentPublicKey: "new-agent",
      newAgentPrivateKeyEncryptedV3: "new-v3",
    });
    expect(reset.outcome).toBe("committed");

    const prepare = await storage.prepareExternalSubaccountReservation({
      walletAddress: wallet,
      protocol: "flash",
      protocolSubaccountId: "stale-flash-wallet",
      observedAgentPublicKey: oldKey,
      claimToken: "stale-prepare-token",
      subaccountKeyEncryptedV3: "pooled-key",
      aadVersion: 2,
      derivationIndex: 1,
      derivationPathVersion: 1,
    });
    expect(prepare).toEqual({ outcome: "stale_generation" });

    const claim = await storage.claimSpareSubaccount({
      walletAddress: wallet,
      protocol: "pacifica",
      agentPublicKey: oldKey,
      claimToken: "stale-claim-token",
    });
    expect(claim).toEqual({ outcome: "stale_generation" });
  }, TIMEOUT);

  it("claims a verified spare once and returns a discriminated empty-pool result thereafter", async () => {
    const { wallet, oldKey } = await seed("claim-spare");
    const spareId = `claimable-spare-${wallet}`;
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
          subaccount_key_encrypted_v3, aad_version, released_at, last_verified_empty_at)
       VALUES ($1, 'pacifica', $2, 'spare', $3, 'pooled-v3', 2, NOW(), NOW())`,
      [wallet, spareId, oldKey],
    );

    const claimed = await storage.claimSpareSubaccount({
      walletAddress: wallet,
      protocol: "pacifica",
      agentPublicKey: oldKey,
      claimToken: "claim-once",
    });
    expect(claimed).toMatchObject({
      outcome: "claimed",
      spare: { protocolSubaccountId: spareId, claimToken: "claim-once", status: "reserving" },
    });

    const none = await storage.claimSpareSubaccount({
      walletAddress: wallet,
      protocol: "pacifica",
      agentPublicKey: oldKey,
      claimToken: "claim-twice",
    });
    expect(none).toEqual({ outcome: "none" });
  }, TIMEOUT);

  it("adopts an exact already-finalized reservation idempotently but rejects a sibling owner", async () => {
    const { wallet, oldKey } = await seed("finalize-idempotent");
    const botRow = await pool.query(
      "SELECT id FROM trading_bots WHERE wallet_address = $1 LIMIT 1",
      [wallet],
    );
    const botId = botRow.rows[0].id as string;
    const subaccountId = `finalize-idempotent-${wallet}`;
    await pool.query(
      `UPDATE trading_bots
          SET protocol_subaccount_id = $2,
              active_protocol = 'pacifica',
              subaccount_auth_mode = 'external_key',
              subaccount_status = 'pending',
              bot_subaccount_key_encrypted_v3 = 'bot-v3'
        WHERE id = $1`,
      [botId, subaccountId],
    );
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
          subaccount_key_encrypted_v3, aad_version, claim_token, claimed_at)
       VALUES ($1, 'pacifica', $2, 'reserving', $3, 'pooled-v3', 2, 'finalize-token', NOW())`,
      [wallet, subaccountId, oldKey],
    );

    const first = await storage.finalizeReusedSubaccount({
      protocol: "pacifica",
      protocolSubaccountId: subaccountId,
      claimToken: "finalize-token",
      botId,
      terminalSubaccountStatus: "active",
    });
    const retry = await storage.finalizeReusedSubaccount({
      protocol: "pacifica",
      protocolSubaccountId: subaccountId,
      claimToken: "finalize-token",
      botId,
      terminalSubaccountStatus: "error",
    });
    const sibling = await storage.finalizeReusedSubaccount({
      protocol: "pacifica",
      protocolSubaccountId: subaccountId,
      claimToken: "finalize-token",
      botId: "00000000-0000-0000-0000-000000000000",
      terminalSubaccountStatus: "active",
    });

    expect(first).toBe(true);
    expect(retry).toBe(true);
    expect(sibling).toBe(false);
    const row = await pool.query(
      "SELECT status, bot_id, claim_token FROM protocol_subaccounts WHERE protocol = 'pacifica' AND protocol_subaccount_id = $1",
      [subaccountId],
    );
    expect(row.rows[0]).toEqual({ status: "active", bot_id: botId, claim_token: null });
    const owner = await pool.query(
      "SELECT subaccount_status FROM trading_bots WHERE id = $1",
      [botId],
    );
    expect(owner.rows[0].subaccount_status).toBe("active");
  }, TIMEOUT);

  it("a prepared reservation blocks reset until its lease is reconciled", async () => {
    const { wallet, oldKey } = await seed("prepare-first");
    const preparedId = `prepared-flash-wallet-${wallet}`;
    const prepared = await storage.prepareExternalSubaccountReservation({
      walletAddress: wallet,
      protocol: "flash",
      protocolSubaccountId: preparedId,
      observedAgentPublicKey: oldKey,
      claimToken: "prepared-token",
      subaccountKeyEncryptedV3: "pooled-key",
      aadVersion: 2,
      derivationIndex: 2,
      derivationPathVersion: 1,
    });
    expect(prepared).toEqual({ outcome: "prepared" });

    const reset = await storage.finalizeAgentWalletReset({
      walletAddress: wallet,
      observedAgentPublicKey: oldKey,
      encryptedMnemonicWords: "must-not-land",
      newAgentPublicKey: "must-not-land",
      newAgentPrivateKeyEncryptedV3: "must-not-land",
    });
    expect(reset).toEqual({ outcome: "blocked", reason: "custody_transition_in_flight" });
  }, TIMEOUT);

  it("atomically flips a keyed AI bot live and removes its exact reservation", async () => {
    const { wallet, oldKey } = await seed("ai-finalize");
    const botId = `ai-finalize-${wallet}`;
    const subaccountId = `ai-finalize-sub-${wallet}`;
    await pool.query(
      `INSERT INTO ai_trader_bots
         (id, wallet_address, protocol, protocol_subaccount_id,
          bot_subaccount_key_encrypted_v3, market, timeframe, allocated_usdc, paper_mode)
       VALUES ($1, $2, 'pacifica', $3, 'bot-v3', 'SOL-PERP', '1h', '10', TRUE)`,
      [botId, wallet, subaccountId],
    );
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
          subaccount_key_encrypted_v3, aad_version, claim_token, claimed_at)
       VALUES ($1, 'pacifica', $2, 'reserving', $3, 'pooled-v3', 2, 'ai-finalize-token', NOW())`,
      [wallet, subaccountId, oldKey],
    );

    const finalized = await storage.finalizeAiTraderGoLiveReservation({
      botId,
      walletAddress: wallet,
      protocol: "pacifica",
      protocolSubaccountId: subaccountId,
      claimToken: "ai-finalize-token",
    });
    expect(finalized?.paperMode).toBe(false);
    const marker = await pool.query(
      "SELECT 1 FROM protocol_subaccounts WHERE wallet_address = $1 AND protocol_subaccount_id = $2",
      [wallet, subaccountId],
    );
    expect(marker.rowCount).toBe(0);
  }, TIMEOUT);

  it("rolls back reservation deletion when the AI finalizer cannot prove a keyed paper row", async () => {
    const { wallet, oldKey } = await seed("ai-finalize-rollback");
    const botId = `ai-finalize-rollback-${wallet}`;
    const subaccountId = `ai-finalize-rollback-sub-${wallet}`;
    await pool.query(
      `INSERT INTO ai_trader_bots
         (id, wallet_address, protocol, protocol_subaccount_id,
          market, timeframe, allocated_usdc, paper_mode)
       VALUES ($1, $2, 'pacifica', $3, 'SOL-PERP', '1h', '10', TRUE)`,
      [botId, wallet, subaccountId],
    );
    await pool.query(
      `INSERT INTO protocol_subaccounts
         (wallet_address, protocol, protocol_subaccount_id, status, agent_public_key,
          subaccount_key_encrypted_v3, aad_version, claim_token, claimed_at)
       VALUES ($1, 'pacifica', $2, 'reserving', $3, 'pooled-v3', 2, 'ai-rollback-token', NOW())`,
      [wallet, subaccountId, oldKey],
    );

    await expect(storage.finalizeAiTraderGoLiveReservation({
      botId,
      walletAddress: wallet,
      protocol: "pacifica",
      protocolSubaccountId: subaccountId,
      claimToken: "ai-rollback-token",
    })).rejects.toThrow(/durably keyed/i);

    const marker = await pool.query(
      "SELECT status, claim_token FROM protocol_subaccounts WHERE wallet_address = $1 AND protocol_subaccount_id = $2",
      [wallet, subaccountId],
    );
    expect(marker.rows[0]).toEqual({ status: "reserving", claim_token: "ai-rollback-token" });
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
