import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { carryFixture } from '../helpers/phoenix-carry';
import { identity, intent } from '../helpers/phoenix-orders';
import { PhoenixParkingStore, assertParkingFundingChild } from '../../server/protocol/phoenix/parking-store';
import { PhoenixBorrowStore } from '../../server/protocol/phoenix/borrow-store';
import { PhoenixOperationStore, phoenixIntentHash } from '../../server/protocol/phoenix/operation-store';
import { carryRepayIntent } from '../../server/protocol/phoenix/carry-contract';
import type { ParkingRecord } from '../../server/protocol/phoenix/parking-contract';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';

const schema=`phoenix_u13_${randomUUID().replaceAll('-','')}`;
const closeId=randomUUID();
let pool:pg.Pool,bootstrap:pg.Pool,store:PhoenixParkingStore,loans:PhoenixBorrowStore;
const carry=()=>{const i=carryFixture().i;i.carry!.closeOrderId=closeId;i.carry!.expiresAt=Date.now()+60000;return i;};
const park=(r:ParkingRecord)=>({key:`${r.id}:${r.legs.length}`,kind:'park' as const,amount:'40000000',asset:'EXAMPLE-yield'});
const repay=(r:ParkingRecord)=>({key:`${r.id}:${r.legs.length}`,kind:'repay' as const,amount:'30000000',asset:null,targetFinalDebtRaw:'60000000'});
beforeAll(async()=>{
  const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw new Error('Requires FRACTAL qvtest');
  bootstrap=new pg.Pool({connectionString:url});await bootstrap.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
  await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,next_bot_derivation_index integer DEFAULT 1);
    CREATE TABLE trading_bots(id varchar PRIMARY KEY,wallet_address text NOT NULL REFERENCES wallets(address),
      active_protocol text NOT NULL,protocol_subaccount_id text,derivation_index integer,derivation_path_version integer,
      bot_subaccount_key_encrypted text,bot_subaccount_key_encrypted_v3 text,subaccount_status text DEFAULT 'active',
      auto_park_idle boolean DEFAULT true,park_destination_asset text DEFAULT 'EXAMPLE-yield',
      auto_repay_enabled boolean DEFAULT true,auto_collateral_top_up boolean DEFAULT false,
      CONSTRAINT trading_bots_active_protocol_check CHECK(active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));`);
  const {phoenix,manifest}=phoenixMigrationFixture();await pool.query(phoenix.sql);
  await pool.query(manifest.find(m=>m.id==='187-phoenix-order-intents')!.sql);
  await pool.query(manifest.find(m=>m.id==='190-phoenix-parking')!.sql);
  await pool.query(`CREATE TABLE borrow_positions(id varchar PRIMARY KEY,wallet_address text,trading_bot_id varchar,venue_position_id text,
    collateral_mint text,kind text DEFAULT 'borrow',debt_venue text DEFAULT 'jupiter_lend',status text DEFAULT 'open',
    last_auto_topup_attempt_at timestamp,debt_amount_raw text DEFAULT '90000000',collateral_amount_raw text DEFAULT '100000000');
    CREATE TABLE borrow_operations(id varchar PRIMARY KEY DEFAULT gen_random_uuid(),wallet_address text,borrow_position_id varchar,
      operation_type text,client_request_id text,status text,step text,metadata jsonb,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
    CREATE UNIQUE INDEX borrow_operations_request_unique ON borrow_operations(wallet_address,client_request_id) WHERE client_request_id IS NOT NULL;`);
  store=new PhoenixParkingStore(pool);loans=new PhoenixBorrowStore(pool);
},30000);
afterAll(async()=>{await pool?.end();if(bootstrap){await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await bootstrap.end();}});
beforeEach(async()=>{
  await pool.query('TRUNCATE borrow_operations,borrow_positions,phoenix_parking_intents,phoenix_order_intents,phoenix_operation_attempts,phoenix_operations,trading_bots,wallets');
  await pool.query("INSERT INTO wallets(address) VALUES('EXAMPLE-owner')");
  await pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,derivation_index,derivation_path_version,
    phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,phoenix_portfolio_index,phoenix_subaccount_index)
    VALUES('EXAMPLE-bot','EXAMPLE-owner','phoenix',$1,1,1,$2,$1,$3,$4,0,0)`,
    [identity.traderAccountAddress,identity.authorityWalletAddress,identity.network,identity.programAddress]);
  const registered=await new PhoenixOperationStore(pool).prepare({botId:'EXAMPLE-bot',ownerWallet:'EXAMPLE-owner',
    requestKey:'EXAMPLE-register',kind:'register',identity,mint:PHOENIX_PUBLIC_ADDRESSES.usdcMint,
    destination:identity.traderAccountAddress,amountBaseUnits:'0',feeBaseUnits:'0'});
  await pool.query("UPDATE phoenix_operations SET state='completed' WHERE id=$1",[registered.operation.id]);
  const close=intent({action:'close'});
  await pool.query(`INSERT INTO phoenix_order_intents(id,bot_id,request_key,sequence,intent,intent_hash,state,data)
    VALUES($4,'EXAMPLE-bot','EXAMPLE-close',1,$1,$2,'settled',$3)`,[close,phoenixIntentHash(close as any),
      {remainingPositionLots:'0',positionEpoch:'EXAMPLE-position-epoch',outcomeSource:'EXAMPLE-finalized-chain',outcomeReference:'EXAMPLE-fill'},closeId]);
  await pool.query(`INSERT INTO borrow_positions(id,wallet_address,trading_bot_id,venue_position_id,collateral_mint)
    VALUES('EXAMPLE-account-loan','EXAMPLE-owner',NULL,'1','EXAMPLE-collateral'),('EXAMPLE-bot-loan','EXAMPLE-owner','EXAMPLE-bot','2','EXAMPLE-collateral')`);
});
describe('U13 durable money ownership in isolated Postgres',()=>{
  it('replays one intent across workers, preserves JSONB hashes, and admits only one spend claim',async()=>{
    const i=carry();const rs=await Promise.all(Array.from({length:5},()=>new PhoenixParkingStore(pool).prepare(i)));
    expect(new Set(rs.map(r=>r.id)).size).toBe(1);
    const claimed=await Promise.allSettled(rs.map(r=>store.claim(r,park(r))));
    expect(claimed.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await new PhoenixParkingStore(pool).read(i)).legs).toHaveLength(1);
    await expect(store.prepare({...i,maxUsdc:'40000001'})).rejects.toThrow('replay');
  });
  it.each(['partial','missing_evidence','wrong_epoch','later_order'])('rejects %s close authority under the bot lock',async defect=>{
    if(defect==='partial')await pool.query(`UPDATE phoenix_order_intents SET data=jsonb_set(data,'{remainingPositionLots}','"1"')`);
    if(defect==='missing_evidence')await pool.query("UPDATE phoenix_order_intents SET data=data-'outcomeSource'");
    if(defect==='wrong_epoch')await pool.query(`UPDATE phoenix_order_intents SET data=jsonb_set(data,'{positionEpoch}','"EXAMPLE-other"')`);
    if(defect==='later_order')await pool.query(`INSERT INTO phoenix_order_intents(bot_id,request_key,sequence,intent,intent_hash,state,data)
      SELECT bot_id,'EXAMPLE-later',2,jsonb_set(intent,'{sequence}','"2"'),intent_hash,'settled',data FROM phoenix_order_intents`);
    await expect(store.prepare(carry())).rejects.toThrow();
  });
  it('consumes each close once even with a new request key after completion',async()=>{
    const i=carry(),r=await store.prepare(i);await store.finish(r,'completed');
    await expect(store.prepare({...i,requestKey:'EXAMPLE-new-request'})).rejects.toThrow('consumed');
  });
  it.each(["auto_park_idle=false","park_destination_asset='EXAMPLE-other'"])(
    'rechecks persisted consent: %s',async update=>{
      const i=carry(),r=await store.prepare(i);await pool.query(`UPDATE trading_bots SET ${update}`);
      await expect(store.claim(r,park(r))).rejects.toThrow();
    });
  it('permits only the exact repayment child through its own parking reservation',async()=>{
    const i=carry();let r=await store.prepare(i);r=await store.claim(r,repay(r));const child=carryRepayIntent(r,r.legs[0].leg);
    await expect(loans.prepare({...child,amountRaw:'30000001'})).rejects.toThrow('binding');
    await expect(loans.prepare({...child,automation:{...child.automation!,parkingIntentId:randomUUID()}})).rejects.toThrow('binding');
    const results=await Promise.all(Array.from({length:4},()=>new PhoenixBorrowStore(pool).prepare(child)));
    expect(new Set(results.map(r=>r.id)).size).toBe(1);
    await loans.claim(child,'repay',{amount:'30000000'});
    await pool.query('UPDATE trading_bots SET auto_repay_enabled=false');
    await expect(loans.signature(child,'repay','EXAMPLE-synthetic-signature',500)).rejects.toThrow('consent');
    await expect(store.finish(r,'completed')).rejects.toThrow('Unsettled');
  });
  it('does not let ordinary parking spend the existing debt reserve',async()=>{
    const i=carry();delete i.carry;i.action='idle';
    await expect(store.prepare(i)).rejects.toThrow('reserve protected');
  });
  it('cannot disguise a carry withdrawal as an ordinary U04 child without fresh authorization',async()=>{
    const i=carry();let r=await store.prepare(i);
    r=await store.claim(r,{key:`${r.id}:0`,kind:'withdraw',amount:'40000000',asset:null});
    const child:any={botId:i.botId,ownerWallet:i.ownerWallet,identity,parkingIntentId:r.id,requestKey:r.legs[0].leg.key,
      funding:{leg:'withdraw',grossBaseUnits:'40000000'}};
    const c=await pool.connect();try {
      await expect(assertParkingFundingChild(c,child)).rejects.toThrow('binding');
      child.carryIntentId=r.id;await assertParkingFundingChild(c,child);
      await pool.query('UPDATE trading_bots SET auto_park_idle=false');
      await expect(assertParkingFundingChild(c,child)).rejects.toThrow('consent');
    }finally{c.release();}
  });
  it('forbids unpark and a second spend even after measured settlement',async()=>{
    const i=carry();let r=await store.prepare(i);
    await expect(store.claim(r,{...park(r),kind:'unpark'})).rejects.toThrow('exceeds');
    r=await store.claim(r,park(r));r=await store.observe(r,{key:r.legs[0].leg.key,state:'settled',spent:'40000000',received:'39000000',
      finalized:true,slot:'100',source:'EXAMPLE-chain',reference:'EXAMPLE-park'});
    await expect(store.claim(r,repay(r))).rejects.toThrow('exceeds');
    await store.finish(r,'completed');expect((await store.read(i)).state).toBe('completed');
  });
});
