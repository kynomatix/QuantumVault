import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Decimal from 'decimal.js';
import bs58 from 'bs58';
import {gridExecutorRuntime} from '../../server/grid-bot/executor-runtime';
import {GridProvision} from '../../server/grid-bot/provision';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,requestDigest,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {GridMonitorStorage} from '../../server/grid-bot/monitor-storage';
import {GridMonitorReads} from '../../server/grid-bot/monitor-reads';
import {GridCustody} from '../../server/grid-bot/custody';
import {calculateGrid} from '../../server/grid-bot/engine';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {readCycleState} from '../../server/grid-bot/cycle-storage';
import {gridDraftRevision} from '../../client/src/lib/grid-draft-view';
import {launchAuthorityFixture,umk} from './launch-authority-fixtures';
import {intent} from './draft-fixtures';
import {marginTestReading} from './margin-fixture';

// Replace only external authority/key/RPC/POST boundaries.
// Runtime composition, provisioning, custody, reads, monitor, ledger, replay and fences are real.
const hooks=vi.hoisted(()=>({collect:vi.fn(),observe:vi.fn(),unlock:vi.fn(),send:vi.fn()}));
vi.mock('../../server/grid-bot/service',async original=>({...await original<typeof import('../../server/grid-bot/service')>(),durableGridUmk:async()=>({umk:Buffer.alloc(32,7),cleanup:()=>{}})}));
vi.mock('../../server/grid-bot/launch-authority',async original=>({...await original<typeof import('../../server/grid-bot/launch-authority')>(),
  productionGridLaunchAuthority:()=>({collect:hooks.collect,observe:hooks.observe}),unlockGridLaunchAgent:hooks.unlock}));
vi.mock('../../server/grid-bot/sol-authority',()=>({createGridSolReader:()=>async()=>({balance:'0.1',observedAt:Date.now()})}));
vi.mock('../../server/grid-bot/execution',async original=>({...await original<typeof import('../../server/grid-bot/execution')>(),GridPacificaSender:class{send=hooks.send;}}));

const migrations=['0004_grid_bot_drafts.sql','0005_grid_launch.sql','0006_grid_monitor.sql','0007_grid_lifecycle.sql','0011_grid_auto_resume.sql'];
const schema='grid_cycle_runtime_'+randomUUID().replaceAll('-',''),wallet=bs58.encode(Buffer.alloc(32,3));
let admin:Pool,pool:Pool,launch:GridLaunchStorage,storage:GridMonitorStorage;
beforeAll(async()=>{
  const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL isolated qvtest schema required');
  admin=new Pool({connectionString:url,max:1});await admin.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString:url,max:5,options:'-c search_path='+schema});
  await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,agent_public_key text);
    CREATE TABLE protocol_subaccounts(id serial PRIMARY KEY,wallet_address text,bot_id text,protocol text,protocol_subaccount_id text UNIQUE,status text,agent_public_key text,subaccount_key_encrypted_v3 text,aad_version integer,claim_token text,claimed_at timestamptz,confirmed_at timestamptz,derivation_index integer,last_verified_empty_at timestamptz,released_at timestamptz);`);
  for(const name of migrations)await pool.query(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  launch=new GridLaunchStorage(pool,async()=>{},async r=>({...marginTestReading(r),leverage:'2',feeRate:'0'}));storage=new GridMonitorStorage(launch);
},30000);
afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30000);
beforeEach(async()=>{vi.resetAllMocks();await pool.query('TRUNCATE grid_bots,protocol_subaccounts,wallets,grid_master_quota,grid_wallet_safety CASCADE');await pool.query('INSERT INTO wallets VALUES($1,$2)',[wallet,'EXAMPLE_MASTER']);});
afterEach(()=>vi.restoreAllMocks());

async function fixture(seed:boolean){
  const source=launchAuthorityFixture(seed),p=source.policy;
  const calc=calculateGrid({policyVersion:'2.0.0',side:'long',lower:p.lowerPrice,upper:p.upperPrice,start:p.startPrice,intervals:p.gridCount,
    investment:p.totalInvestment,leverage:String(p.leverage),seed,entryScale:'flat',profitScale:'flat',tick:'0.01',lot:'0.001',minimumQuote:'1',investmentStep:'0.01',transferFloor:'1',effectiveMakerCostRate:'0'});
  if(!calc.ok)throw Error('EXAMPLE geometry');
  const policy={...p,policyVersion:'2.0.0',runtimePolicyVersion:'2.0.0',levels:calc.plan.lines.map(l=>({ordinal:l.ordinal+1,
    price:new Decimal(l.price).toFixed(8),size:new Decimal(l.quantity).toFixed(8),side:l.role==='seed_exit'?'sell' as const:'buy' as const,reduceOnly:l.role==='seed_exit'}))};
  const signature=computeGridPolicyHmac(policy,umk());if(!signature.ok)throw Error('EXAMPLE signature');
  const {levels,...snapshot}=policy;
  const draft:DraftRecord={...snapshot,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:requestDigest({fixture:'EXAMPLE'}).toUpperCase(),draftRevision:gridDraftRevision(intent),createIntent:intent,
    authoritySnapshot:{state:'EXAMPLE'},policyHmac:signature.digest,name:'Cycle activation',rangeSource:'manual',chartTimeframe:'1h'};
  await new GridStorage(pool,async()=>{}).createDraftWithLevels(draft,levels);
  const account=await new GridCustody(launch).reserve({botId:policy.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:signature.digest},umk());
  const claim={id:policy.id,account:account.account,masterAccount:account.masterAccount,leaseToken:account.leaseToken};
  const orders:Record<string,any>[]=[],trades:Record<string,any>[]=[],sent:ExactGridRequest[]=[];
  let created=false;
  const refresh=()=>{
    const now=Date.now();source.raw.master.updated_at=now;source.raw.sub.updated_at=now;source.raw.sub.account=account.account;source.raw.book.t=now;
    source.raw.inventory={subaccounts:created?[{address:account.account}]:[]};
    source.raw.positions=trades.length?[{symbol:'BTC',side:'bid',amount:calc.plan.seedQuantity,liquidation_price:'1',updated_at:now}]:[];
    source.raw.orders=orders.filter(o=>o.order_status==='open');
    for(const row of source.raw.settings.margin_settings)row.updated_at=now;
    source.raw.sub.positions_count=source.raw.positions.length;source.raw.sub.orders_count=source.raw.orders.length;
  };
  source.deps.sol=async()=>({balance:'0.1',observedAt:Date.now()});
  // The fixture authority reads the same retained v2 policy and current account facts.
  hooks.observe.mockImplementation(async(...args:Parameters<typeof source.authority.observe>)=>{refresh();return source.authority.observe(...args);});
  hooks.collect.mockImplementation(async(...args:Parameters<typeof source.authority.collect>)=>{refresh();return source.authority.collect(...args);});
  hooks.unlock.mockImplementation(async()=>({masterAccount:account.masterAccount,umkVersion:1,signingKey:Buffer.alloc(64,7),cleanup:()=>{},current:async()=>true}));
  const wrap=(data:unknown)=>({success:true,error:null,data,has_more:false,last_order_id:{BTC:'100'}});
  const json={subaccounts:async()=>wrap({subaccounts:created?[{address:account.account}]:[]}),json:async(_master:string,path:string)=>{
    refresh();
    if(path==='/orders'||path==='/orders/history')return wrap(path==='/orders'?orders.filter(o=>o.order_status==='open'):orders);
    if(path==='/trades/history')return wrap(trades);
    if(path==='/positions')return wrap(source.raw.positions);
    if(path==='/info/prices')return wrap([{symbol:'BTC',mark:p.startPrice,timestamp:Date.now()}]);
    if(path==='/info')return wrap(source.raw.info);
    if(path==='/account/settings')return wrap(source.raw.settings);
    if(path==='/account')return wrap({...source.raw.sub,balance:'0',available_to_withdraw:'0',account_equity:'0',available_to_spend:'0',pending_balance:'0',pending_interest:'0',spot_collateral:'0',spot_market_value:'0',total_margin_used:'0',positions_count:trades.length?1:0,orders_count:orders.filter(o=>o.order_status==='open').length,stop_orders_count:0,spot_balances:[]});
    return wrap([]);
  }};
  const reads=new GridMonitorReads(json);
  hooks.send.mockImplementation(async(r:ExactGridRequest,_secret:Buffer,_master:Buffer|undefined,lease:string)=>launch.sendOwned(r,lease,async()=>{
    sent.push(r);
    if(r.kind==='create')created=true;
    if(r.kind==='seed'||r.kind==='limit'){
      const id=String(orders.length+1),filled=r.kind==='seed',now=Date.now();
      orders.push({order_id:id,client_order_id:r.data.client_order_id,symbol:'BTC',side:r.data.side,initial_price:r.data.price??p.startPrice,price:r.data.price??p.startPrice,
        amount:r.data.amount,initial_amount:r.data.amount,filled_amount:filled?r.data.amount:'0',cancelled_amount:'0',reduce_only:r.data.reduce_only,order_type:filled?'market':'limit',
        created_at:r.timestamp,updated_at:now,order_status:filled?'filled':'open'});
      if(filled)trades.push({history_id:'1',order_id:id,client_order_id:r.data.client_order_id,symbol:'BTC',side:'open_long',event_type:'fulfill_taker',cause:'normal',created_at:now,amount:r.data.amount,price:p.startPrice,fee:'0'});
    }
    return {rateLimited:false,...(r.kind==='fund'?{terminalTransferDigest:requestDigest(r)}:{})};
  }));
  const runtime=gridExecutorRuntime(storage,reads,json as any),signal=new AbortController().signal;
  return {policy,account,claim,sent,orders,trades,reads,json,signal,tick:()=>runtime.tick(claim,signal)};
}

describe('production-composed v2 activation with durable PostgreSQL history',()=>{
  it.each([false,true])('provisions seed=%s from newborn history hold through first cycle window to canary',async seed=>{
    const start=vi.spyOn(GridProvision.prototype,'start'),f=await fixture(seed);
    await f.tick();
    expect(start).toHaveBeenCalled();
    expect((await storage.snapshot(f.claim)).bot.status).toBe('provisioning');
    expect(f.sent.map(r=>r.kind)).toEqual(['create']);
    expect((await pool.query('SELECT blocked_reasons FROM grid_monitor_state WHERE bot_id=$1',[f.claim.id])).rows[0].blocked_reasons).toContain('history_safe_through_unavailable');
    // Simulate the scheduled retry after the publication allowance, without weakening the reader.
    await pool.query("UPDATE grid_bots SET created_at=clock_timestamp()-interval '121 seconds' WHERE id=$1",[f.claim.id]);
    for(let i=0;i<4&&(await storage.snapshot(f.claim)).bot.status==='provisioning';i++)await f.tick();
    const state=await storage.snapshot(f.claim);
    expect(state.bot.status).toBe('canary');
    expect(f.sent.filter(r=>r.kind==='seed')).toHaveLength(seed?1:0);
    const limits=f.sent.filter(r=>r.kind==='limit');expect(limits.some(r=>r.data.reduce_only===false)).toBe(true);
    if(seed){expect(limits[0].data.reduce_only).toBe(true);expect(f.sent.findIndex(r=>r.kind==='seed')).toBeLessThan(f.sent.findIndex(r=>r.kind==='limit'));}
    for(const r of f.sent.filter(r=>r.kind==='seed'||r.kind==='limit')){
      expect(r.authority.monitorBootId).toEqual(expect.any(String));expect(Number(r.authority.monitorGeneration)).toBeGreaterThan(0);
    }
    const monitor=(await pool.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[f.claim.id])).rows[0];
    const checkpoint=(await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='canary-clock'",[f.claim.id])).rows[0].evidence.full;
    expect(checkpoint.generation).toBe(String(monitor.generation));expect(Date.now()-checkpoint.completedAt).toBeLessThan(5000);
    expect(monitor.observation.history.publicationLagMs).toBe(120000);
    await launch.transaction(async c=>{await expect(readCycleState(c,state.bot,f.account.account,checkpoint.completedAt+5000)).rejects.toThrow('Durable complete');});
  });
  it.each([undefined,'EXAMPLE_ACCEPTED_ORDER'])('records margin no-land only without an acceptance identity: %s',async orderId=>{
    const f=await fixture(false);await f.tick();
    await pool.query("UPDATE grid_bots SET created_at=clock_timestamp()-interval '121 seconds' WHERE id=$1",[f.claim.id]);
    for(let i=0;i<4&&(await storage.snapshot(f.claim)).bot.status==='provisioning';i++)await f.tick();
    const op=(await storage.snapshot(f.claim)).operations.find(o=>o.exact_request.kind==='limit')!;
    expect(op.state).toBe('confirmed');
    // Isolate settlement of this exact durable request at the submitted boundary.
    await pool.query("UPDATE grid_operations SET state='submitted',terminal_at=NULL,venue_order_id=NULL WHERE id=$1",[op.id]);
    await launch.settle({...op,state:'submitted',venue_order_id:null},{state:'failed',reason:'margin',releaseSlot:true,...(orderId?{orderId}:{})},f.claim.leaseToken);
    const proof=(await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key=$2",[f.claim.id,'cycle-no-land:'+op.id])).rows;
    expect(proof).toHaveLength(orderId?0:1);
    if(!orderId)expect(proof[0].evidence.requestDigest).toBe(op.exact_request_digest);
    expect((await storage.snapshot(f.claim)).bot.pause_reason).toBe('margin');
  });

});
