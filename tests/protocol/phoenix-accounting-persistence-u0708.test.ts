import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PhoenixAccountingStore } from '../../server/protocol/phoenix/accounting-store';
import { PhoenixAccountingService } from '../../server/protocol/phoenix/accounting-service';
import { PhoenixOperationStore } from '../../server/protocol/phoenix/operation-store';
import { orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { event, page, snapshot, target, identity, now, origin } from '../helpers/phoenix-accounting';

const { manifest }=phoenixMigrationFixture();
const migrations=manifest.slice(186), migration=manifest[189];
const schemaName=`phoenix_u0708_${randomUUID().replaceAll('-','')}`;
let pool:pg.Pool, bootstrap:pg.Pool, store:PhoenixAccountingStore;
const fills=[event(1,'0','2'),event(2,'2','0',{grossPnlMicros:'100'})];
const service=()=>new PhoenixAccountingService(store,{snapshot:async()=>snapshot(),history:async()=>page(fills)},()=>now);
beforeAll(async()=>{
  const url=process.env.DATABASE_URL;
  if (!url || new URL(url).pathname!=='/qvtest') throw new Error('Requires FRACTAL qvtest');
  bootstrap=new pg.Pool({connectionString:url}); await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool=new pg.Pool({connectionString:url,options:`-c search_path=${schemaName}`,max:10});
  await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,next_bot_derivation_index integer NOT NULL DEFAULT 1);
    CREATE TABLE trading_bots(id varchar PRIMARY KEY,wallet_address text NOT NULL REFERENCES wallets(address),
      active_protocol text NOT NULL,protocol_subaccount_id text,derivation_index integer,derivation_path_version integer,
      bot_subaccount_key_encrypted text,bot_subaccount_key_encrypted_v3 text,
      CONSTRAINT trading_bots_active_protocol_check CHECK(active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));
    CREATE TABLE published_bots(id text PRIMARY KEY,creator_wallet_address text);
    CREATE TABLE bot_subscriptions(id text PRIMARY KEY,published_bot_id text,subscriber_bot_id text,subscriber_wallet_address text);`);
  for(const m of migrations) await pool.query(m.sql);
  store=new PhoenixAccountingStore(pool,()=>now);
},30000);
afterAll(async()=>{await pool?.end(); if(bootstrap){await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);await bootstrap.end();}});
beforeEach(async()=>{
  await pool.query('TRUNCATE phoenix_accounting_state,phoenix_accounting_events,phoenix_position_epochs,phoenix_equity_snapshots,phoenix_order_intents,phoenix_operation_attempts,phoenix_operations,trading_bots,wallets,bot_subscriptions,published_bots');
  await pool.query('INSERT INTO wallets(address) VALUES($1)',[target.ownerWallet]);
  await pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,derivation_index,derivation_path_version,
    phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,phoenix_portfolio_index,phoenix_subaccount_index)
    VALUES($1,$2,'phoenix',$3,1,1,$4,$3,$5,$6,0,0)`,[target.botId,target.ownerWallet,identity.traderAccountAddress,identity.authorityWalletAddress,identity.network,identity.programAddress]);
  const op=(await new PhoenixOperationStore(pool).prepare({botId:target.botId,ownerWallet:target.ownerWallet,requestKey:'EXAMPLE-register',kind:'register',identity,
    mint:PHOENIX_PUBLIC_ADDRESSES.usdcMint,amountBaseUnits:'0',feeBaseUnits:'0',destination:identity.traderAccountAddress})).operation;
  await pool.query("UPDATE phoenix_operations SET state='completed' WHERE id=$1",[op.id]);
  await pool.query(`INSERT INTO phoenix_operation_attempts(operation_id,attempt_number,signature,blockhash,last_valid_block_height,transaction_hash,state)
    VALUES($1,1,$2,$3,100,$4,'confirmed')`,[op.id,origin.registrationSignature,'EXAMPLE-blockhash'.padEnd(32,'X'),orderIntentHash('EXAMPLE-transaction')]);
});
describe('Phoenix atomic durable settlement',()=>{
  it('migration 189 repeats without replacing tables/constraints and meets readiness',async()=>{
    expect(manifest).toHaveLength(191); expect(migration.id).toBe('189-phoenix-accounting');
    const objects=()=>pool.query(`SELECT oid::text FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY oid`);
    const before=(await objects()).rows;
    for(const m of migrations) await pool.query(m.sql);
    await pool.query(migration.sql); expect((await objects()).rows).toEqual(before);
    const result=await probeSchemaMigrationManifest((sql,values)=>pool.query(sql.replaceAll("'public'",`'${schemaName}'`),
      values?.map(v=>typeof v==='string'?v.replace(/^public\./,`${schemaName}.`):v)),migrations);
    expect(result.unavailableCapabilities,JSON.stringify(result)).toEqual([]);
  });
  it('restarts with exactly one epoch and equity snapshot, and never settles ambiguous orders',async()=>{
    const intent={market:'SOL'};
    await pool.query(`INSERT INTO phoenix_order_intents(bot_id,request_key,sequence,intent,intent_hash,state,data)
      VALUES($1,'EXAMPLE-order',1,$2,$3,'unknown',$4)`,[target.botId,intent,orderIntentHash(intent),{attempt:{signature:fills[1].signature},fills:[{fillId:fills[1].fillId}]}]);
    expect((await service().reconcile(target)).synced).toBe(true);
    const first=(await pool.query('SELECT revision,state,data FROM phoenix_order_intents')).rows;
    store=new PhoenixAccountingStore(pool,()=>now); expect((await service().reconcile(target)).synced).toBe(true);
    expect((await pool.query('SELECT revision,state,data FROM phoenix_order_intents')).rows).toEqual(first);
    expect(first[0].state).toBe('unknown'); expect(first[0].data.accountingEventIds).toEqual([fills[1].id]);
    expect((await pool.query('SELECT * FROM phoenix_position_epochs')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM phoenix_equity_snapshots')).rows).toHaveLength(1);
    expect((await store.read(target)).epochs[0].netPnlMicros).toBe('80');
  });
  it('rolls back the entire checkpoint on receipt/history mismatch',async()=>{
    const intent={market:'SOL'};
    await pool.query(`INSERT INTO phoenix_order_intents(bot_id,request_key,sequence,intent,intent_hash,state,data)
      VALUES($1,'EXAMPLE-order',1,$2,$3,'unknown',$4)`,[target.botId,intent,orderIntentHash(intent),{attempt:{signature:fills[1].signature},fills:[{fillId:'EXAMPLE-missing'}]}]);
    expect((await service().reconcile(target)).synced).toBe(false);
    expect((await store.read(target)).events).toHaveLength(0); expect((await pool.query('SELECT * FROM phoenix_equity_snapshots')).rows).toHaveLength(0);
  });
  it('binds creator provenance to the subscriber bot and payer and retains original binding',async()=>{
    await pool.query("INSERT INTO published_bots VALUES('EXAMPLE-published','EXAMPLE-creator')");
    await pool.query("INSERT INTO bot_subscriptions VALUES('EXAMPLE-subscription','EXAMPLE-published',$1,$2)",[target.botId,target.ownerWallet]);
    expect((await service().reconcile(target)).synced).toBe(true);
    await pool.query("UPDATE published_bots SET creator_wallet_address='EXAMPLE-changed'");
    expect((await service().reconcile(target)).synced).toBe(true);
    const p=(await pool.query('SELECT payout_provenance FROM phoenix_position_epochs')).rows[0].payout_provenance;
    expect(p).toMatchObject({payerWallet:target.ownerWallet,payableMicros:null,state:'disabled_prerequisite',subscription:{creatorWallet:'EXAMPLE-creator'}});
  });
  it('rejects subscriber/payer mismatch without any money record',async()=>{
    await pool.query("INSERT INTO published_bots VALUES('EXAMPLE-published','EXAMPLE-creator')");
    await pool.query("INSERT INTO bot_subscriptions VALUES('EXAMPLE-subscription','EXAMPLE-published',$1,'EXAMPLE-wrong')",[target.botId]);
    expect((await service().reconcile(target)).synced).toBe(false); expect((await store.read(target)).events).toHaveLength(0);
  });
  it('serializes racing checkpoints and rejects cross-owner access',async()=>{
    const results=await Promise.all([service().reconcile(target),service().reconcile(target)]);
    expect(results.some(r=>r.synced)).toBe(true); expect((await store.read(target)).status).toBe('complete');
    expect((await pool.query('SELECT * FROM phoenix_position_epochs')).rows).toHaveLength(1);
    await expect(store.read({...target,ownerWallet:'EXAMPLE-wrong'})).rejects.toThrow('owner mismatch');
  });
  it('requires confirmed registration and cannot accept forged derived epochs',async()=>{
    await service().reconcile(target); const state=await store.read(target);
    const forged=structuredClone(state); forged.revision++; forged.epochs[0].netPnlMicros='999';
    await expect(store.commit(target,state.revision,forged)).rejects.toThrow('Invalid derived epochs');
    await pool.query("UPDATE phoenix_operation_attempts SET state='submission_pending'");
    expect((await service().reconcile(target)).synced).toBe(false); expect((await store.read(target)).epochs[0].netPnlMicros).toBe('80');
  });
  it('keeps queued withdrawal separate from position close and refuses guessed transit value',async()=>{
    const op=(await new PhoenixOperationStore(pool).prepare({botId:target.botId,ownerWallet:target.ownerWallet,requestKey:'EXAMPLE-withdraw',kind:'withdraw',identity,
      mint:PHOENIX_PUBLIC_ADDRESSES.usdcMint,amountBaseUnits:'100',feeBaseUnits:'0',destination:identity.authorityWalletAddress})).operation;
    await pool.query("UPDATE phoenix_operations SET state='queued' WHERE id=$1",[op.id]);
    const io={snapshot:async()=>snapshot({}, {inTransit:[{operationId:op.id,reference:'EXAMPLE-pending',valueMicros:null}]}),history:async()=>page(fills)};
    expect((await new PhoenixAccountingService(store,io,()=>now).reconcile(target)).synced).toBe(true);
    expect((await pool.query('SELECT state FROM phoenix_operations WHERE id=$1',[op.id])).rows[0].state).toBe('queued');
    const state=await store.read(target); state.revision++; state.snapshot!.inTransit[0].valueMicros='100';
    await expect(store.commit(target,state.revision-1,state)).rejects.toThrow('Unproven in-transit');
  });
});
