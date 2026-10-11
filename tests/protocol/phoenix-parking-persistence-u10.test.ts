import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import bs58 from 'bs58';
import { PhoenixParkingStore } from '../../server/protocol/phoenix/parking-store';
import { PhoenixOrderStore } from '../../server/protocol/phoenix/order-store';
import { PhoenixOperationStore } from '../../server/protocol/phoenix/operation-store';
import { admitPhoenixOrder } from '../../server/protocol/phoenix/order-contract';
import { parkingIntentForOrder } from '../../server/protocol/phoenix/parking-order-funding';
import type { ParkingIntent, ParkingRecord } from '../../server/protocol/phoenix/parking-contract';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { authority, identity, intent, now } from '../helpers/phoenix-orders';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';

const { manifest, phoenix } = phoenixMigrationFixture();
const migration = manifest.find(m => m.id === '190-phoenix-parking')!;
const schemaName = `phoenix_u10_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool, bootstrap: pg.Pool, store: PhoenixParkingStore, orders: PhoenixOrderStore;
const parking = (patch: Partial<ParkingIntent> = {}): ParkingIntent => ({ botId: intent().botId, ownerWallet: intent().ownerWallet,
  identity, requestKey: 'EXAMPLE-park', action: 'idle', destination: 'EXAMPLE-yield', maxUsdc: '100', mode: 'shortfall', ...patch });
const leg = (r: ParkingRecord) => ({ key: `${r.id}:${r.legs.length}`, kind: 'park' as const, amount: '100', asset: 'EXAMPLE-yield' });
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('Requires FRACTAL qvtest');
  bootstrap = new pg.Pool({ connectionString: url }); await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 10 });
  await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,next_bot_derivation_index integer DEFAULT 1);
    CREATE TABLE trading_bots(id varchar PRIMARY KEY,wallet_address text NOT NULL REFERENCES wallets(address),
      active_protocol text NOT NULL,protocol_subaccount_id text,derivation_index integer,derivation_path_version integer,
      bot_subaccount_key_encrypted text,bot_subaccount_key_encrypted_v3 text,subaccount_status text DEFAULT 'active',
      auto_park_idle boolean DEFAULT true,park_destination_asset text DEFAULT 'EXAMPLE-yield',
      CONSTRAINT trading_bots_active_protocol_check CHECK(active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));`);
  await pool.query(phoenix.sql); await pool.query(manifest.find(m => m.id === '187-phoenix-order-intents')!.sql);
  await pool.query(migration.sql);
  store = new PhoenixParkingStore(pool); orders = new PhoenixOrderStore(pool);
}, 30000);
afterAll(async () => { await pool?.end(); if (bootstrap) { await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await bootstrap.end(); } });
beforeEach(async () => {
  await pool.query('TRUNCATE phoenix_parking_intents,phoenix_order_intents,phoenix_operation_attempts,phoenix_operations,trading_bots,wallets');
  await pool.query('INSERT INTO wallets(address) VALUES($1)', [intent().ownerWallet]);
  await pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,derivation_index,
    derivation_path_version,phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,
    phoenix_portfolio_index,phoenix_subaccount_index) VALUES($1,$2,'phoenix',$3,1,1,$4,$3,$5,$6,0,0)`,
    [intent().botId,intent().ownerWallet,identity.traderAccountAddress,identity.authorityWalletAddress,identity.network,identity.programAddress]);
  const registered = await new PhoenixOperationStore(pool).prepare({ botId: intent().botId, ownerWallet: intent().ownerWallet,
    requestKey: 'EXAMPLE-register', kind: 'register', identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
    destination: identity.traderAccountAddress, amountBaseUnits: '0', feeBaseUnits: '0' });
  await pool.query("UPDATE phoenix_operations SET state='completed' WHERE id=$1", [registered.operation.id]);
});
describe('U10 durable serialization and guarded migration', () => {
  it('boots repeatedly and probes its actual schema including partial indexes', async () => {
    const r = await store.prepare(parking());
    await pool.query(migration.sql); await pool.query(migration.sql);
    const result = await probeSchemaMigrationManifest((sql, values) => pool.query(sql.replaceAll("'public'", `'${schemaName}'`),
      values?.map(v => typeof v === 'string' ? v.replace(/^public\./, `${schemaName}.`) : v)), [migration]);
    expect(result.unavailableCapabilities, JSON.stringify(result)).toEqual([]);
    expect((await store.read(parking())).id).toBe(r.id);
  });
  it('deduplicates simultaneous delivery and rejects changed replay amounts', async () => {
    const rows = await Promise.all(Array.from({ length: 6 }, () => store.prepare(parking())));
    expect(new Set(rows.map(r => r.id)).size).toBe(1);
    expect((await new PhoenixParkingStore(pool).prepare(parking())).id).toBe(rows[0].id);
    await expect(store.prepare(parking({ maxUsdc: '101' }))).rejects.toThrow('replay');
    await expect(store.prepare(parking({ requestKey: 'EXAMPLE-second' }))).rejects.toThrow('pending');
  });
  it('entry cancels an unsigned park under the same bot lock', async () => {
    const r = await store.prepare(parking());
    await orders.prepare(intent(), admitPhoenixOrder(intent(), authority(), now));
    expect((await store.read(parking())).state).toBe('cancelled');
    await expect(store.claim(r, leg(r))).rejects.toThrow('Stale');
  });
  it('entry waits once a park leg is claimed, including after restart', async () => {
    let r = await store.prepare(parking()); r = await store.claim(r, leg(r));
    await expect(orders.prepare(intent(), admitPhoenixOrder(intent(), authority(), now))).rejects.toThrow('parking settlement pending');
    await expect(new PhoenixParkingStore(pool).finish(r, 'cancelled')).rejects.toThrow('Unsettled');
  });
  it('serializes close/open against idle and funds only the bound entry budget', async () => {
    const a = authority(); a.entry!.freeMarginMicros = '0'; a.entry!.fundableMicros = '200000000';
    const prepared = await orders.prepare(intent(), admitPhoenixOrder(intent(), a, now));
    await expect(store.prepare(parking())).rejects.toThrow('pending order');
    const order = await orders.change(prepared.record, 'funding');
    const i = parkingIntentForOrder(order, 'shortfall');
    await expect(store.prepare({ ...i, maxUsdc: (BigInt(i.maxUsdc) + 1n).toString(),
      requiredMarginUsdc: (BigInt(i.requiredMarginUsdc!) + 1n).toString() })).rejects.toThrow('entry authority');
    const r = await store.prepare(i);
    await expect(orders.change(order, 'signing')).rejects.toThrow('parking settlement pending');
    await store.finish(r, 'completed');
    expect((await orders.change(order, 'signing')).state).toBe('signing');
  });
  it.each(["auto_park_idle=false", "park_destination_asset='EXAMPLE-other'", "subaccount_status='phoenix_archived'"])(
    'rechecks stored consent on claim: %s', async update => {
      const r = await store.prepare(parking()); await pool.query(`UPDATE trading_bots SET ${update}`);
      await expect(store.claim(r, leg(r))).rejects.toThrow();
    });
  it('allows only one concurrent claim and persists the attempt before send', async () => {
    const r = await store.prepare(parking());
    const claims = await Promise.allSettled([store.claim(r, leg(r)), store.claim(r, leg(r))]);
    expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1);
    const current = await store.read(parking());
    const attempt = { signature: bs58.encode(new Uint8Array(64).fill(9)), lastValidBlockHeight: '500',
      transactionHash: createHash('sha256').update('EXAMPLE-transaction').digest('hex') };
    const recorded = await store.recordVaultAttempt(current, attempt);
    expect((await new PhoenixParkingStore(pool).read(parking())).legs[0].attempt).toEqual(attempt);
    await expect(store.recordVaultAttempt(recorded, attempt)).rejects.toThrow('already claimed');
  });
  it('refuses excess amounts, substituted assets and invalid leg kinds under the lock', async () => {
    const r = await store.prepare(parking());
    for (const invalid of [{ ...leg(r), amount: '101' }, { ...leg(r), asset: 'EXAMPLE-other' },
      { ...leg(r), kind: 'unpark' as const }, { ...leg(r), kind: 'unwrap' as const, asset: null }]) {
      await expect(store.claim(r, invalid)).rejects.toThrow();
    }
    expect((await store.read(parking())).legs).toHaveLength(0);
  });
  it('lets only the exact U04 child through and checks opt-out at preparation', async () => {
    let r = await store.prepare(parking());
    r = await store.claim(r, { ...leg(r), kind: 'withdraw', asset: null });
    const child = { botId: intent().botId, ownerWallet: intent().ownerWallet, requestKey: r.legs[0].leg.key,
      kind: 'withdraw' as const, identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
      destination: identity.authorityWalletAddress, amountBaseUnits: '100', feeBaseUnits: '0', parkingIntentId: r.id,
      funding: { leg: 'withdraw' as const, grossBaseUnits: '100', sourceWallet: identity.authorityWalletAddress,
        minimumBaseUnits: '1', maxGasLamports: '1000', quoteSource: 'EXAMPLE-quote', quoteReference: 'EXAMPLE-ref', quoteExpiresAt: now + 5000 } };
    const funding = new PhoenixOperationStore(pool);
    await expect(funding.prepare({ ...child, amountBaseUnits: '101', funding: { ...child.funding, grossBaseUnits: '101' } })).rejects.toThrow('binding');
    await pool.query('UPDATE trading_bots SET auto_park_idle=false');
    await expect(funding.prepare(child)).rejects.toThrow('opt-out');
    await pool.query('UPDATE trading_bots SET auto_park_idle=true');
    expect((await funding.prepare(child)).created).toBe(true);
  });
  it('keeps partial/dropped outcomes exclusive instead of releasing funds', async () => {
    let r = await store.prepare(parking()); r = await store.claim(r, leg(r));
    r = await store.observe(r, { key: r.legs[0].leg.key, state: 'dropped', spent: '0', received: '0', slot: '100',
      finalized: true, source: 'EXAMPLE-chain', reference: 'EXAMPLE-drop' });
    await store.finish(r, 'attention');
    await expect(orders.prepare(intent(), admitPhoenixOrder(intent(), authority(), now))).rejects.toThrow('pending');
  });
  it('consumes each bounded borrow authorization only once', async () => {
    await pool.query('UPDATE trading_bots SET auto_park_idle=false');
    const i = parking({ action: 'post_borrow', borrowAuthorizationId: 'EXAMPLE-borrow' });
    await store.finish(await store.prepare(i), 'cancelled');
    await expect(store.prepare({ ...i, requestKey: 'EXAMPLE-reuse' })).rejects.toThrow('consumed');
  });
  it('blocks unrelated transfers and rejects account scope or another owner', async () => {
    await store.prepare(parking());
    await expect(new PhoenixOperationStore(pool).prepare({ botId: intent().botId, ownerWallet: intent().ownerWallet,
      requestKey: 'EXAMPLE-transfer', kind: 'deposit', identity, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
      destination: identity.traderAccountAddress, amountBaseUnits: '100', feeBaseUnits: '0' })).rejects.toThrow('parking settlement pending');
    await expect(store.prepare(parking({ botId: 'EXAMPLE-account' }))).rejects.toThrow('not owned');
    await expect(store.prepare(parking({ ownerWallet: 'EXAMPLE-other' }))).rejects.toThrow('not owned');
  });
});
