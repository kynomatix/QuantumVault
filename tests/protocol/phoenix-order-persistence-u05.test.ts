import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PhoenixOrderStore } from '../../server/protocol/phoenix/order-store';
import { PhoenixOperationStore, type PhoenixIntent } from '../../server/protocol/phoenix/operation-store';
import { admitPhoenixOrder } from '../../server/protocol/phoenix/order-contract';
import { signOrderTransaction } from '../../server/protocol/phoenix/order-builder';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { authority, identity, intent, key, lifetime, now, pin } from '../helpers/phoenix-orders';

const { manifest, phoenix } = phoenixMigrationFixture();
const migration = manifest.find(m => m.id === '187-phoenix-order-intents')!;
const schemaName = `phoenix_u05_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool, bootstrap: pg.Pool, orders: PhoenixOrderStore, funding: PhoenixOperationStore;
const admission = () => admitPhoenixOrder(intent(), authority(), now);
const operation = (requestKey = 'EXAMPLE-funding', kind: PhoenixIntent['kind'] = 'deposit'): PhoenixIntent => ({
  botId: intent().botId, ownerWallet: intent().ownerWallet, requestKey, kind, identity,
  mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint, destination: identity.traderAccountAddress,
  amountBaseUnits: kind === 'register' ? '0' : '1000000', feeBaseUnits: '0',
});
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('Requires FRACTAL qvtest');
  bootstrap = new pg.Pool({ connectionString: url }); await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 10 });
  orders = new PhoenixOrderStore(pool); funding = new PhoenixOperationStore(pool);
  await pool.query(`CREATE TABLE wallets (address text PRIMARY KEY, next_bot_derivation_index integer NOT NULL DEFAULT 1);
    CREATE TABLE trading_bots (id varchar PRIMARY KEY, wallet_address text NOT NULL REFERENCES wallets(address),
      active_protocol text NOT NULL, protocol_subaccount_id text, derivation_index integer, derivation_path_version integer,
      bot_subaccount_key_encrypted text, bot_subaccount_key_encrypted_v3 text,
      CONSTRAINT trading_bots_active_protocol_check CHECK (active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));`);
  await pool.query(phoenix.sql); await pool.query(migration.sql);
}, 30000);
afterAll(async () => {
  await pool?.end();
  if (bootstrap) { await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await bootstrap.end(); }
});
beforeEach(async () => {
  await pool.query('TRUNCATE phoenix_order_intents,phoenix_operation_attempts,phoenix_operations,trading_bots,wallets');
  await pool.query('INSERT INTO wallets(address) VALUES ($1)', [intent().ownerWallet]);
  await pool.query(`INSERT INTO trading_bots (id,wallet_address,active_protocol,protocol_subaccount_id,derivation_index,
    derivation_path_version,phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,
    phoenix_portfolio_index,phoenix_subaccount_index) VALUES ($1,$2,'phoenix',$3,1,1,$4,$3,$5,$6,0,0)`,
    [intent().botId, intent().ownerWallet, identity.traderAccountAddress, identity.authorityWalletAddress, identity.network, identity.programAddress]);
  const registered = await funding.prepare(operation('EXAMPLE-register', 'register'));
  await pool.query("UPDATE phoenix_operations SET state='completed' WHERE id=$1", [registered.operation.id]);
});

describe('Phoenix order durable authority in isolated PostgreSQL', () => {
  it('appends an idempotent migration with every readiness postcondition satisfied', async () => {
    expect(manifest).toHaveLength(190); expect(migration).toBe(manifest[187]);
    const first = await orders.prepare(intent(), admission());
    await pool.query(migration.sql); await pool.query(migration.sql);
    expect(await orders.read(intent(), first.record.id)).toEqual(first.record);
    const query = (sql: string, values?: readonly unknown[]) => pool.query(sql.replaceAll("'public'", `'${schemaName}'`),
      values?.map(v => typeof v === 'string' ? v.replace(/^public\./, `${schemaName}.`) : v));
    const result = await probeSchemaMigrationManifest(query, [phoenix, migration]);
    expect(result.unavailableCapabilities, JSON.stringify(result)).toEqual([]);
    await pool.query('DROP INDEX phoenix_order_signature_unique');
    expect((await probeSchemaMigrationManifest(query, [migration])).unavailableCapabilities).toContain('phoenix');
    await pool.query(migration.sql);
  });
  it('gives concurrent duplicate deliveries one durable intent and enforces replay payload identity', async () => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () => orders.prepare(intent(), admission())));
    expect(attempts.filter(a => a.created)).toHaveLength(1);
    expect(new Set(attempts.map(a => a.record.id)).size).toBe(1);
    await expect(orders.find(intent({ baseUnits: '3' }))).rejects.toThrow('replay');
    await expect(orders.read(intent({ ownerWallet: 'EXAMPLE-intruder' }), attempts[0].record.id)).rejects.toThrow('owned');
  });
  it('rejects reordered sequences after restart, including distinct request keys', async () => {
    const newest = intent({ sequence: '20' }); const first = await orders.prepare(newest, admitPhoenixOrder(newest, authority(), now));
    await orders.change(first.record, 'rejected');
    orders = new PhoenixOrderStore(pool);
    await expect(orders.prepare(intent({ requestKey: 'EXAMPLE-old', sequence: '19' }), admission())).rejects.toThrow('Reordered');
    await expect(orders.prepare(intent({ requestKey: 'EXAMPLE-same-sequence', sequence: '20' }), admission())).rejects.toThrow('Reordered');
    expect((await orders.prepare(intent({ requestKey: 'EXAMPLE-new', sequence: '21' }), admission())).created).toBe(true);
  });
  it('allows only one active entry or close and rejects stale state transitions', async () => {
    const first = await orders.prepare(intent(), admission());
    await expect(orders.prepare(intent({ requestKey: 'EXAMPLE-close', sequence: '2', action: 'close', side: 'sell' }), admission())).rejects.toThrow();
    const signing = await orders.change(first.record, 'signing');
    await expect(orders.change(first.record, 'rejected')).rejects.toThrow('Stale');
    await expect(orders.change(signing, 'submission_pending')).rejects.toThrow('signature');
    await orders.change(signing, 'unknown');
    await expect(orders.prepare(intent({ requestKey: 'EXAMPLE-retry', sequence: '3' }), admission())).rejects.toThrow();
  });
  it('serializes independent funding and order claims in either direction', async () => {
    const candidates = await Promise.allSettled([orders.prepare(intent(), admission()), funding.prepare(operation())]);
    expect(candidates.filter(c => c.status === 'fulfilled')).toHaveLength(1);
    expect(candidates.filter(c => c.status === 'rejected')).toHaveLength(1);
    // Explicitly exercise the funding-first direction as well.
    await pool.query('DELETE FROM phoenix_order_intents');
    await pool.query("UPDATE phoenix_operations SET state='failed' WHERE kind <> 'register'");
    await funding.prepare(operation('EXAMPLE-funding-next'));
    await expect(orders.prepare(intent(), admission())).rejects.toThrow('unresolved');
  });
  it('permits only bounded linked U04 funding and blocks park while the entry owns the bot', async () => {
    const a = authority(); a.entry!.freeMarginMicros = '0'; a.entry!.fundableMicros = '200000000';
    const first = await orders.prepare(intent(), admitPhoenixOrder(intent(), a, now));
    const claim = await orders.change(first.record, 'funding');
    const linked: PhoenixIntent = { ...operation(), executionOrderId: claim.id,
      funding: { leg: 'deposit', sourceWallet: identity.authorityWalletAddress, grossBaseUnits: '1000000',
        minimumBaseUnits: '1', maxGasLamports: '10000', quoteSource: 'EXAMPLE-source', quoteReference: 'EXAMPLE-quote', quoteExpiresAt: now + 30000 } };
    await expect(funding.prepare({ ...linked, executionOrderId: 'EXAMPLE-other' })).rejects.toThrow('excludes');
    await expect(funding.prepare(operation('EXAMPLE-park', 'withdraw'))).rejects.toThrow('excludes');
    const funded = await funding.prepare(linked);
    await expect(orders.change(claim, 'signing')).rejects.toThrow('settle');
    await pool.query("UPDATE phoenix_operations SET state='completed' WHERE id=$1", [funded.operation.id]);
    await expect(funding.prepare({ ...linked, requestKey: 'EXAMPLE-over-budget', amountBaseUnits: '151606050',
      funding: { ...linked.funding!, grossBaseUnits: '151606050' } })).rejects.toThrow('budget');
    expect((await orders.change(claim, 'signing')).state).toBe('signing');
  });
  it('persists immutable globally unique signatures before submission and survives repository restart', async () => {
    const first = await orders.prepare(intent(), admission());
    const signing = await orders.change(first.record, 'signing');
    const { transaction: _syntheticTransaction, ...attempt } = signOrderTransaction(intent(), admission(), pin, lifetime, key.secretKey, now);
    const pending = await orders.change(signing, 'submission_pending', { attempt });
    orders = new PhoenixOrderStore(pool);
    expect((await orders.read(intent(), pending.id)).data.attempt).toEqual(attempt);
    await expect(orders.change(pending, 'accepted', { attempt: { ...attempt, transactionHash: 'EXAMPLE-changed' } })).rejects.toThrow('Immutable');
    const settled = await orders.change(pending, 'settled', { fills: [], remainingLots: '200' });
    const next = intent({ requestKey: 'EXAMPLE-next', sequence: '2' });
    const second = await orders.prepare(next, admission());
    const nextSigning = await orders.change(second.record, 'signing');
    await expect(orders.change(nextSigning, 'submission_pending', { attempt })).rejects.toThrow('phoenix_order_signature_unique');
    expect((await orders.read(intent(), settled.id)).data.attempt).toEqual(attempt);
  });
});
