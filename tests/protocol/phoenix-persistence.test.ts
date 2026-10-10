import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Keypair } from '@solana/web3.js';
import { PhoenixOperationStore, type PhoenixIntent } from '../../server/protocol/phoenix/operation-store';
import { derivePhoenixIdentity } from '../../server/protocol/phoenix/identity';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';

const { manifest, phoenix } = phoenixMigrationFixture();
const schemaName = `phoenix_u02_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool;
let bootstrap: pg.Pool;
let store: PhoenixOperationStore;
const identity = derivePhoenixIdentity(Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58());
const owner = 'EXAMPLE-owner';
const botId = 'EXAMPLE-bot';
const intent = (kind: PhoenixIntent['kind'] = 'withdraw', requestKey = 'EXAMPLE-request'): PhoenixIntent => ({
  botId, ownerWallet: owner, requestKey, kind, identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
  amountBaseUnits: kind === 'register' ? '0' : '1000000', feeBaseUnits: '0', destination: identity.authorityWalletAddress,
});
const attempt = (number = 1) => ({ signature: String(number).repeat(88), blockhash: '1'.repeat(32),
  transactionHash: number.toString(16).repeat(64), lastValidBlockHeight: '100' });
const evidence = (attemptOutcome?: 'confirmed' | 'failed' | 'expired') => ({ source: 'EXAMPLE-chain-observer', reference: 'EXAMPLE-receipt', attemptOutcome });

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('Phoenix tests require FRACTAL qvtest; refusing any other database');
  bootstrap = new pg.Pool({ connectionString: url });
  await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 10 });
  store = new PhoenixOperationStore(pool);
  // Minimal pre-U02 tables in a new private schema, never public production tables.
  await pool.query(`CREATE TABLE wallets (address text PRIMARY KEY, next_bot_derivation_index integer NOT NULL DEFAULT 1);
    CREATE TABLE trading_bots (id varchar PRIMARY KEY, wallet_address text NOT NULL REFERENCES wallets(address),
      active_protocol text NOT NULL, protocol_subaccount_id text, derivation_index integer, derivation_path_version integer,
      bot_subaccount_key_encrypted text, bot_subaccount_key_encrypted_v3 text,
      CONSTRAINT trading_bots_active_protocol_check CHECK (active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address, derivation_index));`);
  await pool.query(phoenix.sql);
}, 30000);

afterAll(async () => {
  await pool?.end();
  if (bootstrap) {
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await bootstrap.end();
  }
});

beforeEach(async () => {
  await pool.query('TRUNCATE phoenix_operation_attempts, phoenix_operations, trading_bots, wallets');
  await pool.query('INSERT INTO wallets (address) VALUES ($1)', [owner]);
  await pool.query(`INSERT INTO trading_bots (id, wallet_address, active_protocol, protocol_subaccount_id,
    derivation_index, derivation_path_version, phoenix_authority_wallet, phoenix_trader_account,
    phoenix_network, phoenix_program_address, phoenix_portfolio_index, phoenix_subaccount_index)
    VALUES ($1,$2,'phoenix',$3,1,1,$4,$3,$5,$6,0,0)`,
    [botId, owner, identity.traderAccountAddress, identity.authorityWalletAddress, identity.network, identity.programAddress]);
});

describe('Phoenix migration and allocation on isolated PostgreSQL', () => {
  it('is idempotent on legacy and Phoenix rows, including the earlier Flash migration on reboot', async () => {
    await pool.query(`INSERT INTO trading_bots (id,wallet_address,active_protocol,bot_subaccount_key_encrypted)
      VALUES ('EXAMPLE-legacy',$1,'pacifica','EXAMPLE-encrypted')`, [owner]);
    const before = (await pool.query('SELECT * FROM trading_bots ORDER BY id')).rows;
    await pool.query(manifest[76].sql);
    await pool.query(phoenix.sql);
    await pool.query(phoenix.sql);
    expect((await pool.query('SELECT * FROM trading_bots ORDER BY id')).rows).toEqual(before);
  });

  it('proves every Phoenix readiness postcondition against the real catalog', async () => {
    // Catalog helper explicitly probes public; retarget only that namespace for our fixture.
    const query = (sql: string, values?: readonly unknown[]) => pool.query(
      sql.replaceAll("'public'", `'${schemaName}'`),
      values?.map(value => typeof value === 'string' ? value.replace(/^public\./, `${schemaName}.`) : value),
    );
    const snapshot = await probeSchemaMigrationManifest(query, [phoenix]);
    expect(snapshot.unavailableCapabilities).toEqual([]);
  });

  it('rejects invalid venues, incomplete Phoenix identities and legacy retargeting', async () => {
    await expect(pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol) VALUES ('EXAMPLE-invalid',$1,'other')`, [owner])).rejects.toThrow();
    await expect(pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol) VALUES ('EXAMPLE-invalid',$1,'phoenix')`, [owner])).rejects.toThrow();
    await expect(pool.query(`UPDATE trading_bots SET phoenix_trader_account = $1 WHERE id = $2`, [identity.authorityWalletAddress, botId])).rejects.toThrow('immutable');
    await expect(pool.query(`UPDATE trading_bots SET active_protocol = 'pacifica' WHERE id = $1`, [botId])).rejects.toThrow('immutable');
    await pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol) VALUES ('EXAMPLE-old',$1,'pacifica')`, [owner]);
    await expect(pool.query(`UPDATE trading_bots SET active_protocol = 'phoenix' WHERE id = 'EXAMPLE-old'`)).rejects.toThrow('immutable');
  });

  it('keeps the existing allocator monotonic under concurrent allocations and enforces uniqueness', async () => {
    const source = readFileSync(new URL('../../server/storage.ts', import.meta.url), 'utf8');
    const allocatorSql = source.match(/UPDATE wallets\s+SET next_bot_derivation_index = next_bot_derivation_index \+ 1\s+WHERE address = \$\{walletAddress\}\s+RETURNING \(next_bot_derivation_index - 1\) AS allocated/)![0]
      .replace('${walletAddress}', '$1');
    await pool.query('UPDATE wallets SET next_bot_derivation_index = 2 WHERE address = $1', [owner]);
    const allocated = await Promise.all(Array.from({ length: 16 }, () => pool.query(allocatorSql, [owner])));
    expect(allocated.map(result => result.rows[0].allocated).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 2));
    expect((await pool.query(allocatorSql, [owner])).rows[0].allocated).toBe(18);
    await expect(pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol,derivation_index,derivation_path_version)
      VALUES ('EXAMPLE-collision',$1,'pacifica',1,1)`, [owner])).rejects.toThrow();
    // Distinct owner/index cannot claim the same authority or PDA.
    await pool.query(`INSERT INTO wallets(address) VALUES ('EXAMPLE-other-owner')`);
    await expect(pool.query(`INSERT INTO trading_bots SELECT 'EXAMPLE-clone','EXAMPLE-other-owner',active_protocol,
      protocol_subaccount_id,2,derivation_path_version,bot_subaccount_key_encrypted,bot_subaccount_key_encrypted_v3,
      phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,phoenix_portfolio_index,phoenix_subaccount_index
      FROM trading_bots WHERE id = $1`, [botId])).rejects.toThrow();
  });

  it('refuses destructive rollback with Phoenix records and restores the legacy schema when empty', async () => {
    const rollback = readFileSync(new URL('../../migrations/phoenix-u02-rollback.sql', import.meta.url), 'utf8');
    const client = await pool.connect();
    try {
      await expect(client.query(rollback)).rejects.toThrow('rollback refused');
      await client.query('ROLLBACK');
      await client.query('DELETE FROM trading_bots WHERE id = $1', [botId]);
      await client.query(rollback);
      expect((await client.query(`SELECT to_regclass('${schemaName}.phoenix_operations') AS name`)).rows[0].name).toBeNull();
      await client.query(phoenix.sql);
    } finally { client.release(); }
  });
});

describe('Phoenix durable replay and recovery', () => {
  it('serializes duplicate prepare and denies payload changes or a second active operation', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.prepare(intent())));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.operation.id)).size).toBe(1);
    await expect(store.prepare({ ...intent(), feeBaseUnits: '1' })).rejects.toThrow('replay payload mismatch');
    await expect(store.prepare(intent('deposit', 'EXAMPLE-second'))).rejects.toThrow();
  });

  it('rejects owner, venue, PDA, mint and amount mismatches before persistence', async () => {
    for (const changed of [{ ownerWallet: 'EXAMPLE-other' }, { identity: { ...identity, traderAccountAddress: identity.authorityWalletAddress } },
      { identity: { ...identity, venue: 'pacifica' } }, { mint: 'EXAMPLE' }, { amountBaseUnits: '0' }, { amountBaseUnits: '1\n' }]) {
      await expect(store.prepare({ ...intent(), ...changed } as PhoenixIntent)).rejects.toThrow();
    }
    expect((await pool.query('SELECT count(*)::integer AS n FROM phoenix_operations')).rows[0].n).toBe(0);
  });

  it('claims a send once, retains an ambiguous attempt across restart, and rejects stale revisions', async () => {
    const { operation } = await store.prepare(intent());
    const attempts = await Promise.all(Array.from({ length: 6 }, () => store.recordAttempt(botId, owner, operation.id, 0, attempt())));
    expect(attempts.filter(result => result.created)).toHaveLength(1);
    await store.observe(botId, owner, operation.id, 1, 'unknown', evidence());
    const restarted = new PhoenixOperationStore(pool);
    expect((await restarted.recover(botId, owner))[0].state).toBe('unknown');
    await expect(restarted.recordAttempt(botId, owner, operation.id, 2, attempt(2))).rejects.toThrow('stale send');
    await expect(restarted.observe(botId, owner, operation.id, 1, 'completed', evidence('confirmed'))).rejects.toThrow('stale observation');
    await expect(restarted.observe(botId, owner, operation.id, 2, 'completed', evidence())).rejects.toThrow('invalid state');
    expect((await restarted.observe(botId, owner, operation.id, 2, 'completed', evidence('confirmed'))).state).toBe('completed');
    expect((await restarted.prepare(intent())).created).toBe(false);
  });

  it.each(['completed', 'dropped'] as const)('recovers queued -> unknown -> %s without losing the confirmed attempt', async state => {
    const { operation } = await store.prepare(intent());
    await store.recordAttempt(botId, owner, operation.id, 0, attempt());
    await store.observe(botId, owner, operation.id, 1, 'queued', evidence('confirmed'));
    await store.observe(botId, owner, operation.id, 2, 'unknown', evidence());
    const restarted = new PhoenixOperationStore(pool);
    expect((await restarted.observe(botId, owner, operation.id, 3, state, evidence())).state).toBe(state);
    await expect(restarted.observe(botId, owner, operation.id, 4, 'prepared', evidence())).rejects.toThrow();
  });

  it('does not allow deposits into withdrawal queue states', async () => {
    const { operation } = await store.prepare(intent('deposit'));
    await store.recordAttempt(botId, owner, operation.id, 0, attempt());
    await expect(store.observe(botId, owner, operation.id, 1, 'queued', evidence('confirmed'))).rejects.toThrow('invalid state');
  });

  it('requires failed or expired evidence before retry and caps attempts at five', async () => {
    const { operation } = await store.prepare(intent());
    for (let number = 1; number <= 5; number++) {
      await store.recordAttempt(botId, owner, operation.id, (number - 1) * 2, attempt(number));
      await expect(store.observe(botId, owner, operation.id, number * 2 - 1, 'prepared', evidence())).rejects.toThrow();
      await store.observe(botId, owner, operation.id, number * 2 - 1, 'prepared', evidence('expired'));
    }
    await expect(store.recordAttempt(botId, owner, operation.id, 10, attempt(6))).rejects.toThrow('budget exhausted');
  });

  it('binds signatures to exact bytes and permanently deduplicates registration', async () => {
    const { operation } = await store.prepare(intent('register'));
    await store.recordAttempt(botId, owner, operation.id, 0, attempt());
    await expect(store.recordAttempt(botId, owner, operation.id, 1, { ...attempt(), transactionHash: '2'.repeat(64) })).rejects.toThrow('replay mismatch');
    await store.observe(botId, owner, operation.id, 1, 'completed', evidence('confirmed'));
    await expect(store.prepare(intent('register', 'EXAMPLE-new-registration'))).rejects.toThrow();
    const next = (await store.prepare(intent('deposit', 'EXAMPLE-deposit'))).operation;
    await expect(store.recordAttempt(botId, owner, next.id, 0, attempt())).rejects.toThrow('replay mismatch');
    await expect(store.recover(botId, 'EXAMPLE-other-owner')).rejects.toThrow('not owned');
  });

  it('fails closed on persisted intent corruption during recovery', async () => {
    const { operation } = await store.prepare(intent());
    await pool.query("UPDATE phoenix_operations SET intent = jsonb_set(intent, '{ownerWallet}', '\"EXAMPLE-other\"') WHERE id = $1", [operation.id]);
    await expect(store.recover(botId, owner)).rejects.toThrow('persisted intent mismatch');
  });
});
