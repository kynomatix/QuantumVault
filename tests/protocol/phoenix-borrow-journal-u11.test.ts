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

const accountKey = Keypair.fromSeed(new Uint8Array(32).fill(8));
const schema = `phoenix_u11_${randomUUID().replaceAll('-','')}`;
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
      active_protocol text NOT NULL,protocol_subaccount_id text,derivation_index integer,derivation_path_version integer,
      bot_subaccount_key_encrypted text,bot_subaccount_key_encrypted_v3 text,subaccount_status text DEFAULT 'active',
      CONSTRAINT trading_bots_active_protocol_check CHECK(active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address,derivation_index));`);
  await pool.query(phoenixMigrationFixture().phoenix.sql);
  await pool.query(`CREATE TABLE borrow_positions(id varchar PRIMARY KEY,wallet_address text,trading_bot_id varchar,venue_position_id text,
    collateral_mint text,kind text DEFAULT 'borrow',debt_venue text DEFAULT 'jupiter_lend',status text DEFAULT 'open',
    debt_amount_raw text DEFAULT '1000',collateral_amount_raw text DEFAULT '2000');
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

describe('U11 durable lender composition',()=>{
  it('observes a queued deposit child after new borrowing is disabled',async()=>{
    const measured={samples:1,maxSeconds:60,observedAt:now,reference:'EXAMPLE-measured-withdrawal'};
    const i=intent({action:'deploy',measurementHash:borrowHash(measured)}),base=io();let enabled=true,calls=0;
    const source=io({enabled:()=>enabled,snapshot:async(i)=>{
      if(!enabled) throw new Error('New deployment policy must not block observation');
      return {...await base.snapshot(i),measured,expectedQueueSeconds:60,queueCostRaw:'1'};
    },deposit:async()=>({success:++calls>1,finalized:calls>1,operationId:'EXAMPLE-child'})});
    const service=new PhoenixBorrowService(store,source,policy,()=>now);
    expect((await service.run(i)).status).toBe('needs_attention');enabled=false;
    expect((await service.run(i)).status).toBe('completed');expect(calls).toBe(2);
    expect((await service.run(i)).status).toBe('completed');expect(calls).toBe(2);
  });
  it('deduplicates across store instances and binds grow loan identity and amounts',async()=>{
    const i=intent();
    const rows=await Promise.all(Array.from({length:5},()=>new PhoenixBorrowStore(pool).prepare(i)));
    expect(new Set(rows.map(r=>r.id)).size).toBe(1);
    for(const patch of [{botVenueId:3},{botLoanId:'EXAMPLE-other'},{amountRaw:'101'},{accountVenueId:4}])
      await expect(store.prepare({...i,...patch})).rejects.toThrow('replay');
  });
  it('admits exactly one durable primitive claim under concurrent delivery',async()=>{
    const i=intent();await store.prepare(i);
    const results=await Promise.allSettled(Array.from({length:6},()=>new PhoenixBorrowStore(pool).claim(i,'EXAMPLE-leg',{amount:'20'})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await expect(store.prepare(intent({requestKey:'EXAMPLE-second'}))).rejects.toThrow('reserved');
    await expect(store.finish(i,true)).rejects.toThrow('Unreconciled');
  });
  it('requires authoritative reconciliation, retains signature and does not infer absence from a timeout',async()=>{
    const i=intent();await store.prepare(i);await store.claim(i,'EXAMPLE-leg',{amount:'20'});
    await store.signature(i,'EXAMPLE-leg','EXAMPLE-signature',123);
    await expect(store.claim(i,'EXAMPLE-leg',{amount:'20'})).rejects.toThrow('unknown');
    await expect(store.reconcile(i,'EXAMPLE-leg',async()=>null)).rejects.toThrow('unavailable');
    await expect(store.reconcile(i,'EXAMPLE-leg',async()=>({termsHash:'EXAMPLE-wrong',reference:'EXAMPLE-proof',finalized:true,outcome:'absent'}))).rejects.toThrow('unavailable');
    expect((await store.read(i)).metadata.legs['EXAMPLE-leg'].signature).toBe('EXAMPLE-signature');
  });
  it('resumes landed carve then failed borrow without withdrawing or transferring collateral twice',async()=>{
    const i=intent({action:'open',botLoanId:null,botVenueId:null}); let withdraws=0,transfers=0,opens=0,fail=true;
    const withdraw=phoenixLendLeg('executeWithdrawCollateral',async(_p:any)=>{withdraws++;return {success:true};});
    const transfer=phoenixLendLeg('transferTokenToWalletExact',async(_p:any)=>{transfers++;return {success:true};});
    const open=phoenixLendLeg('executeBorrowOpen',async(_p:any)=>{opens++;return fail?{success:false}:{success:true,borrowPositionId:'EXAMPLE-created'};});
    const executors={runPerbotCarveOpen:async(p:any)=>{
      await withdraw({agentPublicKey:p.accountPublicKey,borrowPositionId:p.accountBorrowPositionId,amount:20n});
      await transfer({agentPublicKey:p.accountPublicKey,toWalletAddress:p.botPublicKey,mint:i.collateralMint,amountRaw:20n});
      return open({agentPublicKey:p.botPublicKey,collateralRaw:20n,requestedDebtRaw:100n});
    }} as unknown as LendExecutors;
    const service=new PhoenixBorrowService(store,io(),policy,()=>now,executors);
    await expect(service.run(i)).rejects.toThrow('reconciliation');
    await store.reconcile(i,'executeBorrowOpen:bot',async l=>({termsHash:l.termsHash,reference:'EXAMPLE-finalized-absent',finalized:true,outcome:'absent'}));
    fail=false;
    expect((await new PhoenixBorrowService(new PhoenixBorrowStore(pool),io(),policy,()=>now,executors).run(i)).status).toBe('completed');
    expect({withdraws,transfers,opens}).toEqual({withdraws:1,transfers:1,opens:2});
    await service.run(i);expect(opens).toBe(2);
  });
  it('resumes repaid loan with failed collateral return without repaying twice, even with borrowing disabled',async()=>{
    const i=intent({action:'unwind'});let closes=0,returns=0,fail=true;
    const close=phoenixLendLeg('executeBorrowClose',async(_p:any)=>{closes++;return {success:true,finalized:true};});
    const transfer=phoenixLendLeg('transferTokenToWalletExact',async(_p:any)=>{returns++;return {success:!fail};});
    const executors={runPerbotUnwindClose:async(p:any)=>{
      await close({agentPublicKey:p.botPublicKey,borrowPositionId:p.botBorrowPositionId});
      return transfer({agentPublicKey:p.botPublicKey,toWalletAddress:p.accountPublicKey,mint:i.collateralMint,amountRaw:20n});
    }} as unknown as LendExecutors;
    const service=new PhoenixBorrowService(store,io({enabled:()=>false,eligible:async()=>false}),policy,()=>now,executors);
    await expect(service.run(i)).rejects.toThrow('reconciliation');
    await store.reconcile(i,'transferTokenToWalletExact:bot',async l=>({termsHash:l.termsHash,reference:'EXAMPLE-finalized-absent',finalized:true,outcome:'absent'}));fail=false;
    expect((await service.run(i)).status).toBe('completed');expect(closes).toBe(1);expect(returns).toBe(2);
  });
  it('caps repayment at fresh debt and prevents implicit gas funding from the account',async()=>{
    const i=intent({action:'repay',amountRaw:'5000'});let submitted:any;
    const base=io({enabled:()=>false,eligible:async()=>false});
    const source={...base,snapshot:async(i:PhoenixBorrowIntent)=>({...await base.snapshot(i),debtRaw:'175',walletUsdcRaw:'175'})};
    const executors={repayPartialOnExistingBotPosition:async(p:any)=>{submitted=p;return {success:true,signature:'EXAMPLE-signature'};}} as LendExecutors;
    await new PhoenixBorrowService(store,source,policy,()=>now,executors).run(i);
    expect(submitted.amount).toBe(175n);expect(submitted.targetFinalDebtRaw).toBe(0n);
    expect(submitted.accountPublicKey).toBe(identity.authorityWalletAddress);
    expect(submitted.funderPublicKey).toBe(identity.authorityWalletAddress);
    expect(submitted.botSecretKey.every((b:number)=>b===0)).toBe(true);
  });
  it('refuses queued repayment cash',async()=>{
    let sends=0;const base=io();const i=intent({action:'repay'});
    const executors={repayPartialOnExistingBotPosition:async()=>{sends++;return {success:true};}} as LendExecutors;
    const source={...base,snapshot:async(i:PhoenixBorrowIntent)=>({...await base.snapshot(i),walletUsdcRaw:'0',queuedUsdcRaw:'1000'})};
    await expect(new PhoenixBorrowService(store,source,policy,()=>now,executors).run(i)).rejects.toThrow('Settled');expect(sends).toBe(0);
  });
  it('never invokes custody for a new request with unknown debt',async()=>{
    let custodyCalls=0;const base=io(),i=intent({action:'repay'});
    const source={...base,snapshot:async(i:PhoenixBorrowIntent)=>({...await base.snapshot(i),debtRaw:null}),
      custody:async()=>{custodyCalls++;throw new Error('Unexpected custody');}};
    await expect(new PhoenixBorrowService(store,source,policy,()=>now).run(i)).rejects.toThrow('recoverable');
    expect(custodyCalls).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM borrow_operations')).rows[0].count).toBe(0);
  });
  it('denies account subsidy and rejects the trader PDA as signer',async()=>{
    const i=intent({action:'unwind'});
    const transfer=phoenixLendLeg('transferTokenToWalletExact',async(_p:any)=>{throw new Error('Must not send');});
    const executors={runPerbotUnwindClose:async(p:any)=>transfer({agentPublicKey:p.accountPublicKey,toWalletAddress:p.botPublicKey,
      mint:PHOENIX_PUBLIC_ADDRESSES.usdcMint,amountRaw:1n})} as unknown as LendExecutors;
    await expect(new PhoenixBorrowService(store,io(),policy,()=>now,executors).run(i)).rejects.toThrow('subsidy');
    const bad=io({custody:async(_i,work)=>work({account:new Uint8Array(accountKey.secretKey),bot:new Uint8Array(accountKey.secretKey)})});
    await expect(new PhoenixBorrowService(store,bad,policy,()=>now,executors).run(i)).rejects.toThrow('signer');
  });
  it('blocks foreign owners, foreign loans and archived new risk while keeping repayment admissible',async()=>{
    await expect(store.prepare(intent({ownerWallet:'EXAMPLE-other'}))).rejects.toThrow('owned');
    await pool.query("UPDATE borrow_positions SET trading_bot_id='EXAMPLE-other' WHERE id='EXAMPLE-bot-loan'");
    await expect(store.prepare(intent())).rejects.toThrow('identity');
    await pool.query("UPDATE borrow_positions SET trading_bot_id='EXAMPLE-bot' WHERE id='EXAMPLE-bot-loan'");
    await pool.query("UPDATE trading_bots SET subaccount_status='phoenix_archived'");
    await expect(store.prepare(intent())).rejects.toThrow('recovery-only');
    await expect(store.prepare(intent({action:'repay'}))).resolves.toMatchObject({status:'pending'});
  });
  it('protects liquid reserves from independent deposits/parking but allows margin-only orders after lender settlement',async()=>{
    const c=await pool.connect();try{
      await expect(excludePhoenixBorrow(c,intent().botId)).rejects.toThrow('reserve');
      await expect(excludePhoenixBorrow(c,intent().botId,undefined,false)).resolves.toBeUndefined();
      const i=intent();await store.prepare(i);
      await expect(excludePhoenixBorrow(c,i.botId,undefined,false)).rejects.toThrow('settlement');
    }finally{c.release();}
  });
  it('only authorizes the exact durably claimed debt deployment funding child',async()=>{
    const i=intent({action:'deploy',measurementHash:'EXAMPLE-measurement',collateralRaw:'0'});const r=await store.prepare(i);
    const child={borrowIntentId:r.id,requestKey:`${i.requestKey}:deposit`,amountRaw:i.amountRaw};await store.claim(i,'deposit',child);
    const c=await pool.connect();try{
      await expect(excludePhoenixBorrow(c,i.botId,{...child,borrowReserveRaw:i.reserveRaw,feeBaseUnits:'0',amountBaseUnits:i.amountRaw,kind:'deposit'})).resolves.toBeUndefined();
      await expect(excludePhoenixBorrow(c,i.botId,{...child,borrowReserveRaw:i.reserveRaw,feeBaseUnits:'0',amountBaseUnits:'101',kind:'deposit'})).rejects.toThrow('binding');
      await expect(excludePhoenixBorrow(c,i.botId,{...child,borrowReserveRaw:i.reserveRaw,feeBaseUnits:'0',amountBaseUnits:i.amountRaw,kind:'transfer'})).rejects.toThrow('binding');
    }finally{c.release();}
  });
});
