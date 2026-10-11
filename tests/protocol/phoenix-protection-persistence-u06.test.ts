import { planProtection, type ProtectionProgress } from '../../server/protocol/phoenix/protection-contract';
import { signProtectionTransaction } from '../../server/protocol/phoenix/protection-builder';
import { request, snapshot, leg } from '../helpers/phoenix-protection';
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
const orderMigration = manifest.find(m => m.id === '187-phoenix-order-intents')!;
const migration = manifest.find(m => m.id === '188-phoenix-protection-safety')!;
const schemaName = `phoenix_u06_${randomUUID().replaceAll('-', '')}`;
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
  await pool.query(phoenix.sql); await pool.query(orderMigration.sql); await pool.query(migration.sql);
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

const protective = (patch: Parameters<typeof request>[0] = {}): PhoenixIntent => ({ ...operation('EXAMPLE-protect'), kind: 'protection',
  amountBaseUnits: '0', protection: planProtection(request(patch), snapshot(), now), requestKey: request(patch).requestKey });

describe('U06 durable protection and independent safety admission', () => {
  it('applies migration 188 twice without replacing healthy constraints/indexes and satisfies final readiness', async () => {
    expect(manifest).toHaveLength(189); expect(migration).toBe(manifest[188]);
    const objects = () => pool.query(`SELECT oid::text FROM pg_constraint WHERE conrelid='phoenix_operations'::regclass
      UNION ALL SELECT oid::text FROM pg_class WHERE relname IN ('phoenix_operations_active_unique','phoenix_protection_replace_unique')
      AND relnamespace=current_schema()::regnamespace ORDER BY 1`);
    const before = (await objects()).rows;
    await pool.query(phoenix.sql); await pool.query(orderMigration.sql); await pool.query(migration.sql); await pool.query(migration.sql);
    expect((await objects()).rows).toEqual(before);
    const query = (sql: string, values?: readonly unknown[]) => pool.query(sql.replaceAll("'public'", `'${schemaName}'`),
      values?.map(v => typeof v === 'string' ? v.replace(/^public\./, `${schemaName}.`) : v));
    const result = await probeSchemaMigrationManifest(query, [phoenix, orderMigration, migration]);
    expect(result.unavailableCapabilities, JSON.stringify(result)).toEqual([]);
    await pool.query('DROP INDEX phoenix_protection_replace_unique');
    expect((await probeSchemaMigrationManifest(query, [migration])).unavailableCapabilities).toContain('phoenix');
    await pool.query(migration.sql);
  });
  it('serializes replacements but always admits a separate cancellation and revokes older placement attempts', async () => {
    const first = (await funding.prepare(protective())).operation;
    await expect(funding.prepare(protective({ requestKey: 'EXAMPLE-other' }))).rejects.toThrow();
    const cancel = await funding.prepare(protective({ action: 'cancel', requestKey: 'EXAMPLE-cancel' }));
    expect(cancel.created).toBe(true);
    const signed = signProtectionTransaction(request(), pin, first.intent.protection!.commands[0], lifetime, key.secretKey);
    await expect(funding.recordAttempt(first.bot_id, first.intent.ownerWallet, first.id, first.revision, signed)).rejects.toThrow('revoked');
  });
  it('blocks new entries for unresolved protection but admits and signs a reduce-only close', async () => {
    await funding.prepare(protective());
    await expect(orders.prepare(intent(), admission())).rejects.toThrow('unresolved');
    const i = intent({ action: 'close', side: 'sell', protection: undefined });
    const a = authority(); delete a.protection; a.entry = null; a.position.side = 'long'; a.position.baseLots = '200';
    const close = await orders.prepare(i, admitPhoenixOrder(i, a, now));
    expect((await orders.change(close.record, 'signing')).state).toBe('signing');
  });
  it('leaves withdrawal admission available with unresolved protection', async () => {
    await funding.prepare(protective());
    expect((await funding.prepare(operation('EXAMPLE-withdraw', 'withdraw'))).created).toBe(true);
  });
  it('preserves before/after and surviving stop loss across restart and forbids payload drift', async () => {
    const first = (await funding.prepare(protective())).operation;
    const signed = signProtectionTransaction(request(), pin, first.intent.protection!.commands[0], lifetime, key.secretKey);
    await funding.recordAttempt(first.bot_id, first.intent.ownerWallet, first.id, first.revision, signed);
    const pending = (await funding.read(first.bot_id, first.intent.ownerWallet, first.id)).operation;
    const after = snapshot(); after.legs = [leg()]; after.slot = '101';
    const progress: ProtectionProgress = { step: 1, before: snapshot(), after, remainingLegs: after.legs, protected: false, allOrdersCancelled: false };
    const next = await funding.observe(first.bot_id, first.intent.ownerWallet, first.id, pending.revision, 'prepared',
      { source: 'EXAMPLE-chain', reference: 'EXAMPLE-receipt', attemptOutcome: 'confirmed', protection: progress });
    expect(next.state).toBe('prepared');
    const failed = await funding.observe(first.bot_id, first.intent.ownerWallet, first.id, next.revision, 'failed',
      { source: 'EXAMPLE-chain', reference: 'EXAMPLE-state', protection: { ...progress, reason: 'TP refused' } });
    const restarted = new PhoenixOperationStore(pool);
    expect((await restarted.findProtection(request()))!.observation).toEqual(failed.observation);
    await expect(restarted.findProtection(request({ action: 'cancel' }))).rejects.toThrow('replay');
    await expect(restarted.read(first.bot_id, 'EXAMPLE-intruder', first.id)).rejects.toThrow('owned');
  });
  it('keeps an unconfirmed placement visible to a cancellation proof after restart', async () => {
    const first = (await funding.prepare(protective())).operation;
    const signed = signProtectionTransaction(request(), pin, first.intent.protection!.commands[0], lifetime, key.secretKey);
    await funding.recordAttempt(first.bot_id, first.intent.ownerWallet, first.id, first.revision, signed);
    const cancel = (await funding.prepare(protective({ action: 'cancel', requestKey: 'EXAMPLE-cancel' }))).operation;
    expect(await new PhoenixOperationStore(pool).protectionInFlight(first.bot_id, first.intent.ownerWallet, cancel.id)).toBe(true);
    expect((await funding.read(first.bot_id, first.intent.ownerWallet, first.id)).attempt!.signature).toBe(signed.signature);
  });
  it('does not accept tampered commands or mismatched bot identity in protection terms', async () => {
    const i = protective(); i.protection!.commands = [];
    await expect(funding.prepare(i)).rejects.toThrow('terms');
    const j = protective(); j.protection!.request.botId = 'EXAMPLE-other';
    await expect(funding.prepare(j)).rejects.toThrow('terms');
  });
});
