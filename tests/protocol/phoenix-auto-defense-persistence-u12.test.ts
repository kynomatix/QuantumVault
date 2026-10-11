import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import pg from 'pg';
import { identity, key, now } from '../helpers/phoenix-orders';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { PhoenixBorrowStore, excludePhoenixBorrow } from '../../server/protocol/phoenix/borrow-store';
import { PhoenixBorrowService, type PhoenixBorrowIO, type LendExecutors } from '../../server/protocol/phoenix/borrow-service';
import { borrowHash, type PhoenixBorrowIntent, type BorrowSnapshot, type BorrowLiquidityPolicy } from '../../server/protocol/phoenix/borrow-contract';
import { phoenixLendLeg } from '../../server/vault/phoenix-lend-context';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { AUTO_TOPUP_COOLDOWN_MS } from '../../server/vault/auto-topup';

const accountKey = Keypair.fromSeed(new Uint8Array(32).fill(8));
const schema = `phoenix_u12_${randomUUID().replaceAll('-','')}`;
let pool: pg.Pool, bootstrap: pg.Pool, store: PhoenixBorrowStore;
const intent = (patch: Partial<PhoenixBorrowIntent> = {}): PhoenixBorrowIntent => ({version:1,botId:'EXAMPLE-bot',ownerWallet:'EXAMPLE-owner',requestKey:'EXAMPLE-request',identity,
  accountAuthority:accountKey.publicKey.toBase58(),action:'grow',collateralMint:'EXAMPLE-collateral',accountLoanId:'EXAMPLE-account-loan',accountVenueId:1,
  botLoanId:'EXAMPLE-bot-loan',botVenueId:2,amountRaw:'100',collateralRaw:'20',targetLtv:0.4,
  consent:{accountCollateral:true,reserve:true,deployBorrowed:true},reserveRaw:'110',measurementHash:null,...patch});
const policy: BorrowLiquidityPolicy = {reviewed:true,maxAgeMs:15000,measurementMaxAgeMs:86400000,maxQueueSeconds:120,maxQueueCostRaw:'20',minimumReserveRaw:'50',reserveBps:1000};
function io(patch: Partial<PhoenixBorrowIO> = {}): PhoenixBorrowIO {
  return {eligible:async()=>true,enabled:()=>true,vault:async()=>({collateralMint:'EXAMPLE-collateral'} as any),
    snapshot:async i => ({observedAt:now,oracleObservedAt:now,reference:'EXAMPLE-live',authority:i.identity.authorityWalletAddress,
      accountAuthority:i.accountAuthority,collateralMint:i.collateralMint,accountLoanId:i.accountLoanId,accountVenueId:i.accountVenueId,
      botLoanId:i.botLoanId,botVenueId:i.botVenueId,debtRaw:'1000',collateralRaw:'2000',walletUsdcRaw:'2000',queuedUsdcRaw:'0',complete:true,
      accountCarveAllowed:true,botHealthAllowed:true,measured:null,queueCostRaw:null,expectedQueueSeconds:null}),
    custody:async (_i,work)=>work({account:new Uint8Array(accountKey.secretKey),bot:new Uint8Array(key.secretKey)}),
    deposit:async()=>{throw new Error('Unexpected deposit');},...patch};
}
beforeAll(async()=>{
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('Requires FRACTAL qvtest');
  bootstrap = new pg.Pool({connectionString:url}); await bootstrap.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
  await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,next_bot_derivation_index integer DEFAULT 1);
    CREATE TABLE trading_bots(id varchar PRIMARY KEY,wallet_address text NOT NULL REFERENCES wallets(address),
      auto_collateral_top_up boolean DEFAULT true,auto_repay_enabled boolean DEFAULT true,active_protocol text NOT NULL,protocol_subaccount_id text,derivation_index integer,derivation_path_version integer,
      bot_subaccount_key_encrypted text,bot_subaccount_key_encrypted_v3 text,subaccount_status text DEFAULT 'active',
      CONSTRAINT trading_bots_active_protocol_check CHECK(active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));`);
  await pool.query(phoenixMigrationFixture().phoenix.sql);
  await pool.query(`CREATE TABLE borrow_positions(id varchar PRIMARY KEY,wallet_address text,trading_bot_id varchar,venue_position_id text,
    collateral_mint text,kind text DEFAULT 'borrow',debt_venue text DEFAULT 'jupiter_lend',status text DEFAULT 'open',
    last_auto_topup_attempt_at timestamp,debt_amount_raw text DEFAULT '1000',collateral_amount_raw text DEFAULT '2000');
    CREATE TABLE borrow_operations(id varchar PRIMARY KEY DEFAULT gen_random_uuid(),wallet_address text,borrow_position_id varchar,
      operation_type text,client_request_id text,status text,step text,metadata jsonb,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
    CREATE UNIQUE INDEX borrow_operations_request_unique ON borrow_operations(wallet_address,client_request_id) WHERE client_request_id IS NOT NULL;`);
  store = new PhoenixBorrowStore(pool);
},30000);
afterAll(async()=>{await pool?.end(); if(bootstrap){await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await bootstrap.end();}});
beforeEach(async()=>{
  await pool.query('TRUNCATE borrow_operations,borrow_positions,phoenix_operation_attempts,phoenix_operations,trading_bots,wallets');
  await pool.query("INSERT INTO wallets(address) VALUES('EXAMPLE-owner')");
  await pool.query(`INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,derivation_index,derivation_path_version,
    phoenix_authority_wallet,phoenix_trader_account,phoenix_network,phoenix_program_address,phoenix_portfolio_index,phoenix_subaccount_index)
    VALUES('EXAMPLE-bot','EXAMPLE-owner','phoenix',$1,1,1,$2,$1,$3,$4,0,0)`,
    [identity.traderAccountAddress,identity.authorityWalletAddress,identity.network,identity.programAddress]);
  await pool.query(`INSERT INTO borrow_positions(id,wallet_address,trading_bot_id,venue_position_id,collateral_mint)
    VALUES('EXAMPLE-account-loan','EXAMPLE-owner',NULL,'1','EXAMPLE-collateral'),('EXAMPLE-bot-loan','EXAMPLE-owner','EXAMPLE-bot','2','EXAMPLE-collateral')`);
});

const automatic = (patch: Partial<PhoenixBorrowIntent> = {}) => intent({action:'repay',collateralRaw:'0',amountRaw:'100',
  consent:{accountCollateral:false,reserve:true,deployBorrowed:false},automation:{kind:'defender',targetFinalDebtRaw:'900'},...patch});

describe('U12 durable automatic money ownership',()=>{
  it('admits one request and one primitive across concurrent ticks and store instances',async()=>{
    const i=automatic();
    const records=await Promise.all(Array.from({length:5},()=>new PhoenixBorrowStore(pool).prepare(i)));
    expect(new Set(records.map(r=>r.id)).size).toBe(1);
    const claims=await Promise.allSettled(Array.from({length:5},()=>new PhoenixBorrowStore(pool).claim(i,'repay',{amount:'100'})));
    expect(claims.filter(c=>c.status==='fulfilled')).toHaveLength(1);
  });
  it('retains the cooldown after completion and permits a later distinct capped attempt',async()=>{
    const i=automatic();await store.prepare(i);await store.claim(i,'repay',{amount:'100'});await store.complete(i,'repay',{success:true});await store.finish(i,true);
    const next=automatic({requestKey:'EXAMPLE-next'});
    await expect(store.prepare(next)).rejects.toThrow('cooldown');
    await pool.query("UPDATE borrow_positions SET last_auto_topup_attempt_at=now()-($1 * interval '1 millisecond')",[AUTO_TOPUP_COOLDOWN_MS+1000]);
    await expect(store.prepare(next)).resolves.toMatchObject({status:'pending'});
  });
  it('rechecks independent opt-ins under the journal lock before preparing and broadcasting',async()=>{
    const i=automatic();await pool.query('UPDATE trading_bots SET auto_repay_enabled=false');
    await expect(store.prepare(i)).rejects.toThrow('opt-in');
    await pool.query('UPDATE trading_bots SET auto_repay_enabled=true,auto_collateral_top_up=false');
    await store.prepare(i);await store.claim(i,'repay',{amount:'100'});
    await pool.query('UPDATE trading_bots SET auto_repay_enabled=false');
    await expect(store.signature(i,'repay','EXAMPLE-synthetic-signature',500)).rejects.toThrow('opt-in');
  });
  it('rejects loop and account loan substitution without spending or stamping cooldown',async()=>{
    const i=automatic();await pool.query("UPDATE borrow_positions SET kind='loop' WHERE id=$1",[i.botLoanId]);
    await expect(store.prepare(i)).rejects.toThrow('identity');
    await pool.query("UPDATE borrow_positions SET kind='borrow',trading_bot_id=NULL WHERE id=$1",[i.botLoanId]);
    await expect(store.prepare(i)).rejects.toThrow('identity');
    expect((await pool.query('SELECT last_auto_topup_attempt_at FROM borrow_positions WHERE id=$1',[i.botLoanId])).rows[0].last_auto_topup_attempt_at).toBeNull();
  });
  it('an ambiguous repayment blocks a new tick even after cooldown; replay cannot double spend',async()=>{
    let calls=0;const i=automatic();
    const service=new PhoenixBorrowService(store,io({authorizeAutomatic:async()=>{}}),policy,()=>now,
      {repayPartialOnExistingBotPosition:async()=>{calls++;throw new Error('EXAMPLE-timeout');}} as any);
    await expect(service.run(i)).rejects.toThrow('timeout');
    await pool.query("UPDATE borrow_positions SET last_auto_topup_attempt_at=now()-interval '1 hour'");
    await expect(service.run(i)).rejects.toThrow('unknown');
    await expect(store.prepare(automatic({requestKey:'EXAMPLE-next'}))).rejects.toThrow('reserved');
    expect(calls).toBe(1);
  });
  it('repayment uses its persisted floor and bot self-funding, and repeats return the receipt',async()=>{
    let calls=0;const i=automatic();
    const service=new PhoenixBorrowService(store,io({enabled:()=>false,authorizeAutomatic:async()=>{}}),policy,()=>now,
      {repayPartialOnExistingBotPosition:async(p:any)=>{calls++;expect(p.amount).toBe(100n);expect(p.targetFinalDebtRaw).toBe(900n);
        expect(p.accountPublicKey).toBe(identity.authorityWalletAddress);expect(p.funderPublicKey).toBe(identity.authorityWalletAddress);
        await p.onBeforeBroadcast({signature:'EXAMPLE-synthetic-signature',lastValidBlockHeight:500});return {success:true};}} as any);
    await expect(service.run(i)).resolves.toMatchObject({status:'completed'});
    await expect(service.run(i)).resolves.toMatchObject({status:'completed'});expect(calls).toBe(1);
  });
  it('blocks a health change at broadcast and keeps the journal recoverable without another send',async()=>{
    let authorizations=0,broadcasts=0;const i=automatic();
    const service=new PhoenixBorrowService(store,io({authorizeAutomatic:async()=>{if(++authorizations>=4) throw new Error('EXAMPLE-stale-health');}}),policy,()=>now,
      {repayPartialOnExistingBotPosition:async(p:any)=>{await p.onBeforeBroadcast({signature:'EXAMPLE-synthetic-signature',lastValidBlockHeight:500});broadcasts++;return {success:true};}} as any);
    await expect(service.run(i)).rejects.toThrow('stale-health');expect(broadcasts).toBe(0);
    expect((await store.read(i)).status).toBe('needs_attention');
  });
  it('refuses account subsidy and silent debt expansion even in an opted-in top-up executor',async()=>{
    const i=automatic({action:'topup',amountRaw:'0',collateralRaw:'20',consent:{accountCollateral:true,reserve:true,deployBorrowed:false},automation:{kind:'defender',targetFinalDebtRaw:null}});
    let sends=0;const borrow=phoenixLendLeg('borrowMoreOnExistingBotPosition',async()=>{sends++;return {success:true};});
    const service=new PhoenixBorrowService(store,io({authorizeAutomatic:async()=>{}}),policy,()=>now,
      {runPerbotCollateralTopUp:async(p:any)=>borrow({botPublicKey:p.botPublicKey})} as any);
    await expect(service.run(i)).rejects.toThrow('cannot borrow');expect(sends).toBe(0);
  });
  it('keeps manual repayment available without the automatic binding or new-borrow gate',async()=>{
    const i=intent({action:'repay',collateralRaw:'0'});
    const service=new PhoenixBorrowService(store,io({enabled:()=>false}),policy,()=>now,
      {repayPartialOnExistingBotPosition:async()=>({success:true})} as any);
    await expect(service.run(i)).resolves.toMatchObject({status:'completed'});
  });
});
