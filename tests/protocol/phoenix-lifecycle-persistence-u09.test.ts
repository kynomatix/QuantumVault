import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { PhoenixLifecycleStore } from '../../server/protocol/phoenix/lifecycle';
import { PhoenixProvisioningStore, type PhoenixCreationRequest } from '../../server/protocol/phoenix/provisioning-store';
import { PhoenixOperationStore, type PhoenixIntent } from '../../server/protocol/phoenix/operation-store';
import { PhoenixOrderStore } from '../../server/protocol/phoenix/order-store';
import { admitPhoenixOrder } from '../../server/protocol/phoenix/order-contract';
import { signOrderTransaction } from '../../server/protocol/phoenix/order-builder';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { authority, identity, intent, key, lifetime, now, pin } from '../helpers/phoenix-orders';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';

const schemaName = `phoenix_u09_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool, bootstrap: pg.Pool, lifecycle: PhoenixLifecycleStore, operations: PhoenixOperationStore,
  orders: PhoenixOrderStore, allocation: PhoenixProvisioningStore;
const baseRequest = (): PhoenixCreationRequest => ({ ownerWallet: intent().ownerWallet, requestId: 'EXAMPLE-create',
  name: 'EXAMPLE-name', market: 'SOL', maxPositions: 32, maxCostLamports: '20000', consumer: { kind: 'marketplace',
    sourcePublishedBotId: 'EXAMPLE-published', initialFundingBaseUnits: '10000000' } });
const derive = async (_r: PhoenixCreationRequest, index: number) => ({ authority: Keypair.fromSeed(new Uint8Array(32).fill(index + 20)).publicKey.toBase58(),
  encryptedKey: 'EXAMPLE-ciphertext', policyHmac: 'EXAMPLE-policy-hmac' });
const fundingIntent = (kind: PhoenixIntent['kind'] = 'deposit'): PhoenixIntent => ({ botId: intent().botId,
  ownerWallet: intent().ownerWallet, requestKey: `EXAMPLE-${kind}`, kind, identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
  destination: identity.traderAccountAddress, amountBaseUnits: kind === 'register' ? '0' : '1000000', feeBaseUnits: '0' });
const attempt = () => ({ signature: bs58.encode(new Uint8Array(64).fill(8)), blockhash: key.publicKey.toBase58(),
  lastValidBlockHeight: '200', transactionHash: createHash('sha256').update('EXAMPLE-transaction').digest('hex') });
const stop = (action: 'pause' | 'archive' | 'unsubscribe' = 'archive') => lifecycle.stop(intent().botId, intent().ownerWallet, action);
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('Requires FRACTAL qvtest');
  bootstrap = new pg.Pool({ connectionString: url }); await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 10 });
  await pool.query(`CREATE TABLE wallets (address text PRIMARY KEY, next_bot_derivation_index integer NOT NULL DEFAULT 2);
    CREATE TABLE trading_bots (id varchar PRIMARY KEY, wallet_address text NOT NULL REFERENCES wallets(address),
      name text, market text, webhook_secret text, is_active boolean DEFAULT true, execution_active boolean DEFAULT true,
      auto_park_due_at timestamptz DEFAULT now(), total_investment numeric, leverage integer, max_position_size numeric,
      subaccount_auth_mode text, subaccount_status text DEFAULT 'active', policy_hmac text, updated_at timestamptz,
      source_published_bot_id text, active_protocol text NOT NULL, protocol_subaccount_id text, derivation_index integer,
      derivation_path_version integer, bot_subaccount_key_encrypted text, bot_subaccount_key_encrypted_v3 text,
      CONSTRAINT trading_bots_active_protocol_check CHECK (active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));
    CREATE TABLE published_bots(id text PRIMARY KEY,trading_bot_id text,is_active boolean DEFAULT true,
      subscriber_count integer DEFAULT 0,total_capital_invested numeric DEFAULT 0);
    CREATE TABLE bot_subscriptions(id text DEFAULT gen_random_uuid()::text,published_bot_id text,
      subscriber_wallet_address text,subscriber_bot_id text,capital_invested numeric,status text,
      UNIQUE(published_bot_id,subscriber_wallet_address));
    CREATE TABLE trade_retry_queue(id text DEFAULT gen_random_uuid()::text,bot_id text,status text,last_error text);`);
  const { phoenix, manifest } = phoenixMigrationFixture();
  await pool.query(phoenix.sql); await pool.query(manifest.find(m => m.id === '187-phoenix-order-intents')!.sql);
  lifecycle = new PhoenixLifecycleStore(pool); operations = new PhoenixOperationStore(pool);
  orders = new PhoenixOrderStore(pool); allocation = new PhoenixProvisioningStore(pool);
}, 30000);
afterAll(async () => { await pool?.end(); if (bootstrap) { await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await bootstrap.end(); } });
beforeEach(async () => {
  await pool.query('TRUNCATE phoenix_order_intents,phoenix_operation_attempts,phoenix_operations,bot_subscriptions,published_bots,trade_retry_queue,trading_bots,wallets');
  await pool.query('INSERT INTO wallets(address) VALUES ($1)', [intent().ownerWallet]);
  await pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,derivation_index,
    derivation_path_version,phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,
    phoenix_portfolio_index,phoenix_subaccount_index,bot_subaccount_key_encrypted_v3)
    VALUES ($1,$2,'phoenix',$3,1,1,$4,$3,$5,$6,0,0,'EXAMPLE-ciphertext')`,
    [intent().botId,intent().ownerWallet,identity.traderAccountAddress,identity.authorityWalletAddress,identity.network,identity.programAddress]);
  const registered = await operations.prepare(fundingIntent('register'));
  await pool.query("UPDATE phoenix_operations SET state='completed' WHERE id=$1", [registered.operation.id]);
  await pool.query("INSERT INTO published_bots(id,trading_bot_id) VALUES ('EXAMPLE-published',$1)", [intent().botId]);
});

describe('U09 durable consumer and lifecycle authority', () => {
  it('allocates one linked Phoenix subscriber across concurrent delivery and restart', async () => {
    const result = await Promise.all(Array.from({ length: 5 }, () => allocation.allocateAndDerive(baseRequest(), derive)));
    expect(new Set(result.map(r => r.id)).size).toBe(1);
    expect((await new PhoenixProvisioningStore(pool).allocateAndDerive(baseRequest(), derive)).id).toBe(result[0].id);
    const { rows: [subscription] } = await pool.query('SELECT * FROM bot_subscriptions');
    expect(subscription).toMatchObject({ subscriber_bot_id: result[0].bot_id, status: 'paused', capital_invested: '10.0000000000000000' });
    const { rows: [bot] } = await pool.query('SELECT * FROM trading_bots WHERE id=$1', [result[0].bot_id]);
    expect(bot).toMatchObject({ active_protocol: 'phoenix', is_active: false, source_published_bot_id: 'EXAMPLE-published' });
    expect((await pool.query('SELECT subscriber_count FROM published_bots')).rows[0].subscriber_count).toBe(1);
  });
  it('binds consumer kind, budget and source immutably across JSONB replay', async () => {
    await allocation.allocateAndDerive(baseRequest(), derive);
    for (const consumer of [undefined, { ...baseRequest().consumer!, initialFundingBaseUnits: '20000000' },
      { ...baseRequest().consumer!, sourcePublishedBotId: 'EXAMPLE-other' }, { kind: 'lab' as const, initialFundingBaseUnits: '10000000' }]) {
      await expect(allocation.allocateAndDerive({ ...baseRequest(), consumer }, derive)).rejects.toThrow('replay mismatch');
    }
  });
  it('refuses a second copy identity and rolls back failed derivation without a subscription', async () => {
    await expect(allocation.allocateAndDerive(baseRequest(), async () => { throw new Error('EXAMPLE-key-failure'); })).rejects.toThrow();
    expect((await pool.query('SELECT * FROM bot_subscriptions')).rows).toHaveLength(0);
    await allocation.allocateAndDerive(baseRequest(), derive);
    await expect(allocation.allocateAndDerive({ ...baseRequest(), requestId: 'EXAMPLE-second' }, derive)).rejects.toThrow('recovery identity');
  });
  it('refuses archived creators and never substitutes another venue', async () => {
    await stop(); await expect(allocation.allocateAndDerive(baseRequest(), derive)).rejects.toThrow('creator unavailable');
    expect((await pool.query('SELECT * FROM bot_subscriptions')).rows).toHaveLength(0);
  });
  it.each(['pause','archive','unsubscribe'] as const)('%s retains keys, capital and liabilities while draining unsigned risk', async action => {
    await pool.query("INSERT INTO bot_subscriptions VALUES ('EXAMPLE-link','EXAMPLE-published',$1,$2,25,'active')", [intent().ownerWallet,intent().botId]);
    await pool.query("INSERT INTO trade_retry_queue(bot_id,status) VALUES ($1,'pending')", [intent().botId]);
    const order = await orders.prepare(intent(), admitPhoenixOrder(intent(), authority(), now));
    const result = await stop(action);
    expect(result).toMatchObject({ hardDeleteAllowed: false, recoveryRetained: true, settlement: 'unverified' });
    expect(result.emptiness.empty).toBe(false);
    expect((await pool.query('SELECT * FROM trading_bots WHERE id=$1',[intent().botId])).rows[0]).toMatchObject({
      is_active: false, execution_active: false, auto_park_due_at: null, bot_subaccount_key_encrypted_v3: 'EXAMPLE-ciphertext',
      phoenix_trader_account: identity.traderAccountAddress });
    expect((await pool.query('SELECT * FROM bot_subscriptions')).rows[0]).toMatchObject({ capital_invested: '25', status: 'paused' });
    expect((await pool.query('SELECT status FROM trade_retry_queue')).rows[0].status).toBe('failed');
    expect((await orders.read(intent(), order.record.id)).state).toBe('rejected');
    await expect(orders.prepare(intent({ requestKey: 'EXAMPLE-late', sequence: '2' }), admitPhoenixOrder(intent(), authority(), now))).rejects.toThrow('recovery-only');
    await expect(operations.prepare(fundingIntent())).rejects.toThrow('recovery-only');
  });
  it('retains a submitted order and permits reconciliation after archive', async () => {
    const prepared = await orders.prepare(intent(), admitPhoenixOrder(intent(), authority(), now));
    const signing = await orders.change(prepared.record, 'signing');
    const { transaction: _syntheticTransaction, ...signed } = signOrderTransaction(intent(), admitPhoenixOrder(intent(), authority(), now), pin, lifetime, key.secretKey, now);
    const pending = await orders.change(signing, 'submission_pending', { attempt: signed });
    expect((await stop()).pendingOperations).toBe(1);
    expect((await orders.read(intent(), pending.id)).state).toBe('submission_pending');
    expect((await orders.change(pending, 'unknown')).state).toBe('unknown');
  });
  it('blocks a previously prepared funding send claim after archive, preserving the journal', async () => {
    const prepared = await operations.prepare(fundingIntent()); await stop();
    await expect(operations.recordAttempt(intent().botId,intent().ownerWallet,prepared.operation.id,prepared.operation.revision,attempt())).rejects.toThrow('recovery-only');
    expect((await operations.read(intent().botId,intent().ownerWallet,prepared.operation.id)).operation.state).toBe('prepared');
  });
  it('serializes archive against a simultaneous funding send claim without losing ambiguity', async () => {
    const prepared = await operations.prepare(fundingIntent());
    const [claim] = await Promise.allSettled([operations.recordAttempt(intent().botId,intent().ownerWallet,prepared.operation.id,prepared.operation.revision,attempt()), stop()]);
    const read = await operations.read(intent().botId,intent().ownerWallet,prepared.operation.id);
    expect(read.operation.state).toBe(claim.status === 'fulfilled' ? 'submission_pending' : 'prepared');
    if (claim.status === 'fulfilled') expect(read.attempt).toEqual(attempt());
    else expect(read.attempt).toBeUndefined();
    expect((await stop()).pendingOperations).toBe(1);
  });
  it('does not revive an archived registration on confirmed replay or later pause', async () => {
    await stop(); await stop('pause');
    const registered = (await operations.read(intent().botId,intent().ownerWallet,
      (await pool.query("SELECT id FROM phoenix_operations WHERE kind='register'")).rows[0].id)).operation;
    await allocation.persistConfirmed(registered);
    expect((await pool.query('SELECT subaccount_status FROM trading_bots WHERE id=$1',[intent().botId])).rows[0].subaccount_status).toBe('phoenix_archived');
  });
  it('refuses an unowned lifecycle request without mutations', async () => {
    await expect(lifecycle.stop(intent().botId,'EXAMPLE-intruder','archive')).rejects.toThrow('not owned');
    expect((await pool.query('SELECT is_active FROM trading_bots WHERE id=$1',[intent().botId])).rows[0].is_active).toBe(true);
  });
});
