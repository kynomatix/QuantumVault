import {GridLifecycleService,type GridLifecycleDeps} from '../../server/grid-bot/lifecycle-service';
import {GridLifecycleStorage} from '../../server/grid-bot/lifecycle-storage';
import {GridNotifications} from '../../server/grid-bot/notifications';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import bs58 from 'bs58';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,requestDigest,gridProvisionAttempt,type ExactGridRequest,type DurableGridOperation} from '../../server/grid-bot/launch-storage';
import type {GridTransferProof} from '../../server/grid-bot/transfer-evidence';
import {GridMonitorStorage,type GridMonitorClaim} from '../../server/grid-bot/monitor-storage';
import {GridMonitorService} from '../../server/grid-bot/monitor-service';
import {GridExecution,reconcileGridLimit} from '../../server/grid-bot/execution';
import {gridOwnedLive} from '../../server/grid-bot/lifecycle-policy';
import type {WindowOrder} from '../../server/grid-bot/window';
import Decimal from 'decimal.js';
import {GridCustody} from '../../server/grid-bot/custody';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {gridDraftRevision} from '../../client/src/lib/grid-draft-view';
import {policy,umk,intent} from './draft-fixtures';
import {marginTestReading} from './margin-fixture';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {gridRuntimeGates} from '../../server/grid-bot/service';
const migrations=['0004_grid_bot_drafts.sql','0005_grid_launch.sql','0006_grid_monitor.sql','0007_grid_lifecycle.sql','0011_grid_auto_resume.sql','0012_grid_range_epochs.sql'].map(p=>readFileSync(new URL('../../migrations/'+p,import.meta.url),'utf8'));
describe('Grid monitor PostgreSQL crash, restart and financial boundaries',()=>{
  let admin:Pool,pool:Pool,launch:GridLaunchStorage,storage:GridMonitorStorage;
  const schema='grid_u5_'+randomUUID().replaceAll('-',''),wallet=bs58.encode(Buffer.alloc(32,3));
  beforeAll(async()=>{const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL isolated qvtest schema required');
    admin=new Pool({connectionString:url,max:1});await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:url,max:5,options:'-c search_path='+schema});
    await pool.query(`CREATE TABLE wallets(address text PRIMARY KEY,agent_public_key text); CREATE TABLE protocol_subaccounts(id serial PRIMARY KEY,wallet_address text,bot_id text,protocol text,protocol_subaccount_id text UNIQUE,status text,agent_public_key text,subaccount_key_encrypted_v3 text,aad_version integer,claim_token text,claimed_at timestamptz,confirmed_at timestamptz,derivation_index integer,last_verified_empty_at timestamptz,released_at timestamptz);`);
    for(const sql of migrations)await pool.query(sql);launch=new GridLaunchStorage(pool,async()=>{},async r=>marginTestReading(r));storage=new GridMonitorStorage(launch);
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30000);
  beforeEach(async()=>{await pool.query('TRUNCATE grid_wallet_safety,grid_monitor_orders,grid_monitor_state,grid_profit_allocations,grid_exact_fills,grid_read_claims,grid_execution_claims,grid_launch_accounts,grid_master_quota,grid_fills,grid_operations,grid_levels,grid_bots,protocol_subaccounts,wallets CASCADE');await pool.query('INSERT INTO wallets VALUES($1,$2)',[wallet,'EXAMPLE_MASTER']);});
  async function reservation(totalInvestment='100.00',epoch=true){const p={...policy(),totalInvestment,...(!epoch?{stopLossPrice:null,stopLossPercent:null}:{})},h=computeGridPolicyHmac(p,umk());if(!h.ok)throw Error();const {levels,...snapshot}=p;
    const bot:DraftRecord={...snapshot,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:'A'.repeat(64),draftRevision:gridDraftRevision(intent),createIntent:intent,authoritySnapshot:{state:'EXAMPLE'},policyHmac:h.digest,name:'Grid draft',rangeSource:'manual',chartTimeframe:'1h'};
    await new GridStorage(pool,async()=>{}).createDraftWithLevels(bot,levels);
    const account=await new GridCustody(launch).reserve({botId:bot.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:bot.policyHmac},umk());
    const claim:GridMonitorClaim={id:bot.id,leaseToken:account.leaseToken,account:account.account,masterAccount:account.masterAccount};
    const level=(await pool.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal LIMIT 1',[bot.id])).rows[0];
    const observe=():GridObservation=>({account:claim.account,symbol:'BTC',observedAt:Date.now(),inventoryComplete:true,history:{from:0,through:Date.now(),inclusive:true,publicationLagMs:0,source:'EXAMPLE_REVIEWED_AUTHORITY'},mark:null,position:{direction:'long',size:'0'},orders:[],trades:[]});
    return {bot,claim,level,observe,account};
  }
  async function fixture(totalInvestment='100.00',epoch=true){const {bot,claim,level}=await reservation(totalInvestment,epoch);
    const now=Date.now(),cloid=randomUUID();
    const request:ExactGridRequest={kind:'limit',botId:bot.id,account:claim.account,masterAccount:claim.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:now,expiryMs:5000,
      data:{symbol:'BTC',client_order_id:cloid,side:'bid',reduce_only:false,amount:'1',price:'90'},authority:{levelId:level.id,levelAttempt:0}};
    const op=await launch.prepare('EXAMPLE_OPERATION',request,{credits:'10',slots:1,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},claim.leaseToken);
    const observe=():GridObservation=>({account:claim.account,symbol:'BTC',observedAt:Date.now(),inventoryComplete:true,history:{from:0,through:Date.now(),inclusive:true,publicationLagMs:0,source:'EXAMPLE_REVIEWED_AUTHORITY'},mark:{price:'90',observedAt:Date.now()},position:{direction:'long',size:'0.98'},
      orders:[{orderId:'10',clientOrderId:cloid,symbol:'BTC',side:'long',price:'90',amount:'1',filledAmount:'0.98',cancelledAmount:'0',reduceOnly:false,orderType:'limit',createdAt:now,updatedAt:now,status:'partially_filled'}],
      trades:[{tradeId:'1',orderId:'10',clientOrderId:cloid,symbol:'BTC',side:'open_long',time:now,size:'0.98',price:'90',fee:'0.000000000000000001'}]});
    return {bot,claim,level,op,request,observe};
  }
  async function landed(totalInvestment='100.00'){const f=await fixture(totalInvestment);expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);await launch.settle(f.op,{state:'confirmed',reason:null,releaseSlot:false,orderId:'10'});return f;}
  it('keeps NULL-epoch legacy levels available to planning and preparation',async()=>{
    const f=await fixture('100.00',false);
    expect((await pool.query('SELECT active_epoch_id FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0].active_epoch_id).toBeNull();
    expect((await pool.query('SELECT epoch_id FROM grid_operations WHERE id=$1',[f.op.id])).rows[0].epoch_id).toBeNull();
    expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);
    await launch.settle(f.op,{state:'confirmed',reason:null,releaseSlot:false,orderId:'10'});
    const bootId=randomUUID();await storage.reconcile(f.claim,bootId,f.observe());
    const state=await storage.planningState(f.claim,bootId);
    expect(state.levels).toHaveLength(f.bot.gridCount+1);
    expect(state.levels.every(l=>l.epoch_id===null)).toBe(true);
    const op=await new GridStorage(pool,async()=>{}).prepareOperation({botId:f.bot.id,levelId:f.level.id,type:'sync',idempotencyKey:'EXAMPLE_NULL_EPOCH',requestIdentity:'EXAMPLE_NULL_EPOCH'});
    expect(op.epochId).toBeNull();
  });
  // Retain a snapshot from a crashed earlier process, without sleeping or bypassing fresh admission.
  async function crashPrepared(key:string,request:ExactGridRequest){const digest=requestDigest(request);
    return (await pool.query(`INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type,exact_request,exact_request_digest,state)
      VALUES($1,$2,$3,$4,$5,$6,$4,'prepared') RETURNING *`,[randomUUID(),request.botId,key,digest,
      request.kind==='create'?'provision_subaccount':'fund_subaccount',request])).rows[0];
  }
  async function unknownFund(){
    const f=await reservation(),now=Date.now(),base=`grid:${f.bot.id}:launch:fund`;
    const r:ExactGridRequest={kind:'fund',botId:f.bot.id,account:f.claim.account,masterAccount:f.claim.masterAccount,
      path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now-6000,expiryMs:5000,
      data:{amount:'100',to_account:f.claim.account,idempotency_key:'EXAMPLE_LOST_FUND_KEY'},authority:{}};
    const prepared=await crashPrepared(base,r);
    await pool.query("UPDATE grid_operations SET state='unconfirmed',failure_classification='unknown',submitted_at=clock_timestamp() WHERE id=$1",[prepared.id]);
    const op=await launch.read(f.bot.id,base);if(!op)throw Error('EXAMPLE retained transfer missing');
    const proof:GridTransferProof={version:1,requestDigest:op.exact_request_digest,state:'not_landed',evidence:{account:r.account,masterAccount:r.masterAccount,complete:true,
      startedAt:now-100,observedAt:now-1,balanceAt:now-1,balance:'0',ownedAccounts:[r.account],subaccountHistory:[],mainHistory:[]}};
    return {...f,op,proof,base,r};
  }
  it('C4 persists one UNKNOWN notice and an immutable absence proof before permitting a replacement',async()=>{
    const f=await unknownFund();await storage.transferUnknown(f.claim,f.op);await storage.transferUnknown(f.claim,f.op);
    expect((await storage.snapshot(f.claim)).bot.status).toBe('paused');
    expect((await pool.query("SELECT count(*) AS n FROM grid_risk_events WHERE kind='transfer_unknown' AND bot_id=$1",[f.bot.id])).rows[0].n).toBe('1');
    await launch.settle(f.op,{state:'failed',reason:'expected_rejection',releaseSlot:true,transferProof:f.proof},f.claim.leaseToken);
    const old=await launch.read(f.bot.id,f.base);expect(old).toMatchObject({state:'failed',failure_classification:'expected_rejection',exact_request:f.r,transfer_recovery:f.proof});
    expect((await storage.snapshot(f.claim)).bot.status).toBe('provisioning');
    expect(await gridProvisionAttempt((key,id)=>launch.read(id,key),f.bot.id,'fund',Date.now())).toEqual({key:f.base+':retry:'+f.op.id,op:null});
    expect((await storage.snapshot(f.claim)).operations.find((o:DurableGridOperation)=>o.id===f.op.id)?.transfer_recovery).toEqual(f.proof);
  });
  it('C4 preserves an owner Pause and Stop while repeatedly notifying UNKNOWN',async()=>{
    const f=await unknownFund();await storage.transferUnknown(f.claim,f.op);
    await pool.query("UPDATE grid_bots SET status='stopping',pause_reason='stop' WHERE id=$1",[f.bot.id]);
    await storage.transferUnknown(f.claim,f.op);expect((await storage.snapshot(f.claim)).bot).toMatchObject({status:'stopping',pause_reason:'stop'});
    await pool.query("UPDATE grid_bots SET status='pausing',pause_reason='pause' WHERE id=$1",[f.bot.id]);
    await storage.transferUnknown(f.claim,f.op);
    await launch.settle(f.op,{state:'failed',reason:'expected_rejection',releaseSlot:true,transferProof:f.proof},f.claim.leaseToken);
    expect((await storage.snapshot(f.claim)).bot).toMatchObject({status:'paused',pause_reason:'pause'});
    await pool.query("UPDATE grid_bots SET status='stopping',pause_reason='stop' WHERE id=$1",[f.bot.id]);
    await storage.transferUnknown(f.claim,f.op);expect((await storage.snapshot(f.claim)).bot).toMatchObject({status:'stopping',pause_reason:'stop'});
  });
  it('C4 rejects missing or stale absence authority without terminalizing the transfer',async()=>{
    const f=await unknownFund();
    await expect(launch.settle(f.op,{state:'failed',reason:'expected_rejection',releaseSlot:true},f.claim.leaseToken)).rejects.toThrow('absence proof');
    f.proof.evidence.startedAt=f.r.timestamp+f.r.expiryMs;
    await expect(launch.settle(f.op,{state:'failed',reason:'expected_rejection',releaseSlot:true,transferProof:f.proof},f.claim.leaseToken)).rejects.toThrow('proof authority');
    expect((await launch.read(f.bot.id,f.base))?.state).toBe('unconfirmed');
  });
  it('C6 authorizes only an untouched signed-absent reservation without inventing monitor authority',async()=>{
    const f=await reservation(),account=await new GridCustody(launch).recover(f.bot.id,wallet,f.claim.leaseToken);
    await pool.query("UPDATE grid_risk_events SET evidence=jsonb_set(evidence,'{reconciliationRequired}','true'::jsonb) WHERE bot_id=$1 AND event_key='worker-ownership'",[f.bot.id]);
    // One clock sample keeps the proof within its maximum 5000 ms validity window.
    const observedAt=Date.now();
    const proof={state:'absent' as const,account:account.account,masterAccount:account.masterAccount,observedAt,expiresAt:observedAt+5000};
    await storage.authorizeProvisioning(f.claim,account,proof);
    expect((await pool.query("SELECT evidence->>'reconciliationRequired' AS required FROM grid_risk_events WHERE bot_id=$1 AND event_key='worker-ownership'",[f.bot.id])).rows[0].required).toBe('false');
    expect((await pool.query('SELECT boot_id FROM grid_monitor_state WHERE bot_id=$1',[f.bot.id])).rows[0]?.boot_id??null).toBeNull();
    await expect(storage.authorizeProvisioning(f.claim,{...account,reused:true},proof)).rejects.toThrow();
    await new GridLifecycleStorage(storage).request(wallet,f.bot.id,randomUUID(),'stop');
    await expect(storage.authorizeProvisioning(f.claim,account,{...proof,observedAt:Date.now()})).rejects.toThrow();
  });
  it('C6 cannot clear takeover recovery after any retained send',async()=>{
    const f=await landed(),account=await new GridCustody(launch).recover(f.bot.id,wallet,f.claim.leaseToken);
    await expect(storage.authorizeProvisioning(f.claim,account,{state:'absent',account:account.account,masterAccount:account.masterAccount,
      observedAt:Date.now(),expiresAt:Date.now()+5000})).rejects.toThrow('Untouched provisioning required');
  });
  it('C6 authorizes signed absence after a prepared create expires, retaining its immutable request',async()=>{
    const f=await reservation(),now=Date.now();
    const request:ExactGridRequest={kind:'create',botId:f.bot.id,account:f.claim.account,masterAccount:f.claim.masterAccount,path:'/account/subaccount/create',
      operationType:'subaccount_confirm',timestamp:now-6000,expiryMs:5000,data:{},authority:{}};
    const op=await crashPrepared(`grid:${f.bot.id}:launch:create`,request);
    expect(await launch.expirePrepared(op,f.claim.leaseToken)).toBe(true);
    await storage.authorizeProvisioning(f.claim,f.account,{state:'absent',account:f.account.account,masterAccount:f.account.masterAccount,observedAt:Date.now(),expiresAt:Date.now()+5000});
    const old=(await pool.query('SELECT state,submitted_at,exact_request,exact_request_digest FROM grid_operations WHERE id=$1',[op.id])).rows[0];
    expect(old).toMatchObject({state:'failed',submitted_at:null,exact_request:request,exact_request_digest:requestDigest(request)});
    expect((await pool.query('SELECT released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0].released_at).toBeNull();
  });
  it('C6 deduplicates terminal provisioning denials into the owner notification outbox',async()=>{
    const f=await reservation();await storage.provisioningDenied(f.claim,'EXAMPLE terminal rejection');await storage.provisioningDenied(f.claim,'EXAMPLE terminal rejection');
    const events=(await pool.query("SELECT kind,evidence FROM grid_risk_events WHERE bot_id=$1 AND kind='provisioning_denied'",[f.bot.id])).rows;
    expect(events).toEqual([{kind:'provisioning_denied',evidence:{reason:'EXAMPLE terminal rejection'}}]);
    expect((await pool.query('SELECT released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0].released_at).toBeNull();
  });
  it('C6 first-placement authority follows terminal funding after an expired unsent fund',async()=>{
    const f=await reservation(),now=Date.now(),p={...policy(),id:f.bot.id};
    const fund:ExactGridRequest={kind:'fund',botId:f.bot.id,account:f.claim.account,masterAccount:f.claim.masterAccount,path:'/account/subaccount/transfer',operationType:'transfer_funds',
      timestamp:now-6000,expiryMs:5000,data:{to_account:f.claim.account,amount:p.totalInvestment},authority:{policyHmac:f.bot.policyHmac}};
    const budget={credits:'10',slots:0 as const,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000};
    const old=await crashPrepared(`grid:${f.bot.id}:launch:fund`,fund);expect(await launch.expirePrepared(old,f.claim.leaseToken)).toBe(true);
    const attempt=await gridProvisionAttempt((key,id)=>launch.read(id,key),f.bot.id,'fund',Date.now());
    const retry=await launch.prepare(attempt.key,{...fund,timestamp:Date.now()},budget,f.claim.leaseToken);
    expect(await launch.submit(retry,f.claim.leaseToken)).toBe(true);await launch.settle(retry,{state:'confirmed',reason:null,releaseSlot:true},f.claim.leaseToken);
    const entry:ExactGridRequest={...fund,kind:'limit',path:'/orders/create',operationType:'create_order',timestamp:Date.now(),data:{symbol:'BTC',reduce_only:false},
      authority:{policy:p,policyHmac:f.bot.policyHmac}};
    expect(await launch.firstPlacementContext(entry)).toMatchObject({policy:p,alreadyPlaced:false});
    expect((await launch.read(f.bot.id,`grid:${f.bot.id}:launch:fund`))?.state).toBe('failed');
  });
  it.each(['0.98','1'])('C6 executes an actual %s entry fill through backed exits and one recycled entry',async initial=>{
    const f=await landed(),o=f.observe(),signal=new AbortController().signal;
    await pool.query("UPDATE grid_bots SET status='canary',sol_balance='0.1',sol_balance_observed_at=clock_timestamp() WHERE id=$1",[f.bot.id]);
    o.orders[0].filledAmount=initial;o.orders[0].status=initial==='1'?'filled':'partially_filled';o.trades[0].size=initial;o.position!.size=initial;
    const monitor=new GridMonitorService({storage,observe:async()=>{o.observedAt=Date.now();o.history!.through=Date.now();return o;}});
    const reconcile=async()=>{expect((await monitor.tick(f.claim,signal)).entriesAllowed).toBe(true);};
    const plan=async()=>{
      const {operations}=await storage.snapshot(f.claim);
      const owned:WindowOrder[]=gridOwnedLive(operations,o).map(({order,operation})=>{
        if(!operation?.level_id||!order.clientOrderId)throw Error('EXAMPLE missing owned order');
        return {levelId:operation.level_id,orderId:order.orderId,clientOrderId:order.clientOrderId,reduceOnly:order.reduceOnly,
          remaining:new Decimal(order.amount).minus(order.filledAmount).minus(order.cancelledAmount??'0').toFixed()};
      });
      return monitor.plan(f.claim,{owned,bookPrice:'100',lot:'0.01',minimumQuote:'1',freeSlots:100,canaryRemaining:'160'});
    };
    let venueId=20;
    const placeExit=async(expected:string)=>{
      const p=await plan(),action=p.chunks.flat()[0];
      if(!action||action.kind!=='place'||!action.level.reduceOnly)throw Error('EXAMPLE expected backed profit');
      expect(action.level.size).toBe(expected);expect(p.chunks.flat()).toHaveLength(1);
      const now=Date.now(),orderId=String(venueId++),cloid=randomUUID(),l=action.level;
      const request:ExactGridRequest={...f.request,timestamp:now,data:{symbol:'BTC',side:'ask',reduce_only:true,tif:'ALO',price:l.price,amount:l.size,client_order_id:cloid},
        authority:{...p.authority,levelId:l.id,levelAttempt:l.attempt,fillAllocations:p.allocations[l.id]}};
      let sends=0;
      const execution=new GridExecution({storage:launch,preflight:async()=>true,send:async()=>{sends++;
        o.orders.push({orderId,clientOrderId:cloid,symbol:'BTC',side:'short',price:l.price,amount:l.size,filledAmount:'0',cancelledAmount:'0',reduceOnly:true,orderType:'limit',status:'open',createdAt:now,updatedAt:now});
        return {rateLimited:false};},reconcile:async op=>reconcileGridLimit(op.exact_request,o.orders)});
      const key=`grid:${f.bot.id}:level:${l.ordinal}:${l.attempt}:profit`,claim={credits:'10',slots:1 as const,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000};
      expect(await execution.run(key,request,claim,f.claim.leaseToken)).toBe('confirmed');
      expect(await execution.run(key,request,claim,f.claim.leaseToken)).toBe('confirmed');expect(sends).toBe(1);
      await reconcile();expect((await plan()).chunks.flat()).toEqual([]);
      return o.orders.find(order=>order.orderId===orderId)!;
    };
    const fillExit=async(order:GridObservation['orders'][number],tradeId:string)=>{
      const now=Date.now();order.status='filled';order.filledAmount=order.amount;order.updatedAt=now;
      o.trades.push({tradeId,orderId:order.orderId,clientOrderId:order.clientOrderId,symbol:'BTC',side:'close_long',time:now,size:order.amount,price:order.price,fee:'0'});
      o.position!.size=new Decimal(o.position!.size).minus(order.amount).toFixed();await reconcile();
    };
    await reconcile();const firstExit=await placeExit(initial);
    if(initial!=='1'){
      const now=Date.now();o.orders[0].filledAmount='1';o.orders[0].status='filled';o.orders[0].updatedAt=now;o.position!.size='1';
      o.trades.push({...o.trades[0],tradeId:'2',time:now,size:'0.02'});await reconcile();
    }
    await fillExit(firstExit,'3');
    if(initial!=='1'){
      expect((await pool.query('SELECT status FROM grid_levels WHERE id=$1',[f.level.id])).rows[0].status).toBe('filled');
      await fillExit(await placeExit('0.02'),'4');
    }
    await reconcile();const next=await plan(),entry=next.chunks.flat()[0];
    expect(next.chunks.flat()).toHaveLength(1);expect(entry).toMatchObject({kind:'place',level:{id:f.level.id,attempt:1,reduceOnly:false}});
    if(entry.kind!=='place')throw Error('EXAMPLE expected recycled entry');expect(new Decimal(entry.level.size).eq(1)).toBe(true);
    expect((await pool.query('SELECT count(*) AS n FROM grid_exact_fills WHERE bot_id=$1',[f.bot.id])).rows[0].n).toBe(initial==='1'?'2':'4');
    expect((await pool.query('SELECT count(*) AS n FROM grid_operations WHERE bot_id=$1',[f.bot.id])).rows[0].n).toBe(initial==='1'?'2':'3');
  });
  it('C2 blocks mark-driven excess while stop close and terminal recovery remain usable',async()=>{
    const f=await landed(),boot=randomUUID(),o=f.observe();o.mark={price:'300',observedAt:Date.now()};
    const result=await storage.reconcile(f.claim,boot,o);expect(result.entriesAllowed).toBe(false);expect(result.reconciliationComplete).toBe(true);expect(result.reasons).toContain('pilot_exposure_limit_exceeded');
    expect((await pool.query('SELECT canary_limit,canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_limit:'100',canary_committed:'90',released_at:null});
    const control=new GridLifecycleStorage(storage);await control.request(wallet,f.bot.id,randomUUID(),'stop');await control.safetyObservation(f.claim,o);
    const life=(await control.state(f.claim)).life,now=Date.now();
    const request:ExactGridRequest={...f.request,kind:'close',path:'/orders/create_market',operationType:'create_market_order',timestamp:now,data:{symbol:'BTC',side:'ask',amount:'0.98',reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()},authority:{lifecycleEpoch:life.epoch}};
    const close=await launch.prepare('EXAMPLE_C2_CLOSE',request,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    expect((await pool.query('SELECT status FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0].status).toBe('stopping');
    expect(await launch.submit(close,f.claim.leaseToken)).toBe(true);await launch.finalMargin(request,f.claim.leaseToken);
    let posts=0;await launch.sendOwned(request,f.claim.leaseToken,async()=>{posts++;});expect(posts).toBe(1);
    await launch.settle(close,{state:'confirmed',reason:null,releaseSlot:true,orderId:'20'});
    const terminal=f.observe();terminal.mark={price:'300',observedAt:Date.now()};terminal.position!.size='0';terminal.orders[0].status='cancelled';terminal.orders[0].cancelledAmount='0.02';
    terminal.orders.push({orderId:'20',clientOrderId:String(request.data.client_order_id),symbol:'BTC',side:'short',price:'300',amount:'0.98',filledAmount:'0.98',cancelledAmount:'0',reduceOnly:true,orderType:'market',createdAt:now,updatedAt:Date.now(),status:'filled'});
    terminal.trades.push({tradeId:'2',orderId:'20',clientOrderId:String(request.data.client_order_id),symbol:'BTC',side:'close_long',time:now,size:'0.98',price:'300',fee:'0'});
    expect((await storage.reconcile(f.claim,boot,terminal)).entriesAllowed).toBe(true);
    expect((await pool.query('SELECT canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_committed:'0',released_at:null});
  });
  it('C2 reconciles an existing reduced allocation against its configured ceiling without a migration',async()=>{
    const f=await landed('1000.00'),o=f.observe();
    await pool.query('UPDATE grid_launch_accounts SET canary_limit=250 WHERE bot_id=$1',[f.bot.id]);
    o.mark={price:'300',observedAt:Date.now()};
    expect((await storage.reconcile(f.claim,randomUUID(),o)).entriesAllowed).toBe(true);
    expect((await pool.query('SELECT canary_limit,canary_committed FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_limit:'1000',canary_committed:'300'});
  });
  it('C2 retains reservations when a filled position cannot be freshly priced',async()=>{
    const f=await landed(),o=f.observe();o.mark=null;
    const result=await storage.reconcile(f.claim,randomUUID(),o);expect(result.entriesAllowed).toBe(false);expect(result.reasons).toContain('pilot_exposure_mark_unavailable');
    expect((await pool.query('SELECT canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_committed:'90',released_at:null});
    o.mark={price:'90',observedAt:Date.now()};o.observedAt=Date.now();
    expect((await storage.reconcile(f.claim,randomUUID(),o)).entriesAllowed).toBe(true);
  });
  it.each(['over_limit','unknown'])('C2 keeps profit-exit planning and send authority when exposure is %s',async exposure=>{
    const f=await landed(),boot=randomUUID(),o=f.observe();o.mark=exposure==='unknown'?null:{price:'300',observedAt:Date.now()};await storage.reconcile(f.claim,boot,o);
    const state=await storage.planningState(f.claim,boot);expect(state.entriesAllowed).toBe(false);
    const level=(await pool.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal DESC LIMIT 1',[f.bot.id])).rows[0],now=Date.now();
    const request:ExactGridRequest={...f.request,timestamp:now,data:{...f.request.data,client_order_id:randomUUID(),side:'ask',reduce_only:true,price:'110',amount:'0.98'},
      authority:{...state.authority,levelId:level.id,levelAttempt:0,fillAllocations:[{tradeId:'1',size:'0.98'}]}};
    const op=await launch.prepare('EXAMPLE_C2_PROFIT_EXIT',request,{credits:'10',slots:1,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);await launch.finalMargin(request,f.claim.leaseToken);
    let posts=0;await launch.sendOwned(request,f.claim.leaseToken,async()=>{posts++;});expect(posts).toBe(1);
    expect((await pool.query('SELECT canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_committed:'90',released_at:null});
  });
  it('C2 revalues filled risk at a new seed worst price before reserving more exposure',async()=>{
    const f=await landed('280.00'),boot=randomUUID();await storage.reconcile(f.claim,boot,f.observe());
    await pool.query("UPDATE grid_bots SET sol_balance='0.1',sol_balance_observed_at=clock_timestamp() WHERE id=$1",[f.bot.id]);
    const state=await storage.planningState(f.claim,boot),now=Date.now(),request:ExactGridRequest={...f.request,kind:'seed',timestamp:now,
      data:{symbol:'BTC',amount:'1.1',side:'bid',reduce_only:false},authority:{...state.authority,seedWorstPrice:'140'}};
    // Old $90 plus new $154 would appear to fit; repricing the filled 0.98 makes $293.
    await expect(launch.prepare('EXAMPLE_C2_REPRICE',request,{credits:'10',slots:0,canaryIncrement:'154',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken)).rejects.toThrow('configured exposure limit');
    expect((await pool.query('SELECT canary_committed FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0].canary_committed).toBe('90');
    expect((await pool.query('SELECT count(*) AS count FROM grid_operations WHERE bot_id=$1',[f.bot.id])).rows[0].count).toBe('1');
  });
  it('commits a typed margin pause and one outbox incident across denial and restart',async()=>{
    const f=await fixture(),denied=new GridLaunchStorage(pool,async()=>{},async()=>null);
    expect(await denied.submit(f.op,f.claim.leaseToken)).toBe(false);expect(await new GridLaunchStorage(pool,async()=>{},async()=>null).submit(f.op,f.claim.leaseToken)).toBe(false);
    const b=(await pool.query('SELECT status,pause_reason FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0];expect(b).toEqual({status:'pausing',pause_reason:'margin'});
    expect((await pool.query("SELECT * FROM grid_risk_events WHERE bot_id=$1 AND kind='margin_pause'",[f.bot.id])).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM grid_control_requests WHERE bot_id=$1 AND action='pause' AND state='pending'",[f.bot.id])).rowCount).toBe(1);
    expect((await pool.query('SELECT state FROM grid_operations WHERE id=$1',[f.op.id])).rows[0].state).toBe('prepared');
  });
  it('refuses new prepare exposure without rolling back its durable pause',async()=>{
    const f=await fixture(),now=Date.now(),denied=new GridLaunchStorage(pool,async()=>{},async()=>null);
    await expect(denied.prepare('EXAMPLE_MARGIN_DENIED',{...f.request,timestamp:now},{credits:'10',slots:1,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken)).rejects.toThrow('margin pause');
    expect((await pool.query('SELECT pause_reason FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0].pause_reason).toBe('margin');expect((await pool.query('SELECT * FROM grid_operations WHERE bot_id=$1',[f.bot.id])).rowCount).toBe(1);
  });
  it('serializes competing attempts against outstanding committed margin and notifies once',async()=>{
    const f=await fixture(),now=Date.now(),limited=new GridLaunchStorage(pool,async()=>{},async r=>({...marginTestReading(r),available:'100'}));
    const admission={credits:'10',slots:1 as const,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000};
    const results=await Promise.allSettled(['EXAMPLE_MARGIN_A','EXAMPLE_MARGIN_B'].map(key=>limited.prepare(key,{...f.request,timestamp:now,data:{...f.request.data,client_order_id:randomUUID()}},admission,f.claim.leaseToken)));
    expect(results.every(x=>x.status==='rejected')).toBe(true);expect((await pool.query('SELECT count(*) AS n FROM grid_operations WHERE bot_id=$1',[f.bot.id])).rows[0].n).toBe('1');
    expect((await pool.query("SELECT count(*) AS n FROM grid_risk_events WHERE bot_id=$1 AND kind='margin_pause'",[f.bot.id])).rows[0].n).toBe('1');
    let calls=0;const notify=new GridNotifications(pool,async()=>{calls++;return 'sent';});expect(await notify.deliverNext()).toBe(true);expect(await new GridNotifications(pool,async()=>{calls++;return 'sent';}).deliverNext()).toBe(false);expect(calls).toBe(1);
  });
  it('re-reads final margin after submit and fences a replacement lease',async()=>{
    const f=await fixture();expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);
    await launch.finalMargin(f.request,f.claim.leaseToken);
    await expect(launch.finalMargin(f.request,randomUUID())).rejects.toThrow('ownership');expect((await pool.query('SELECT status FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0].status).toBe('provisioning');
    await expect(new GridLaunchStorage(pool,async()=>{},async()=>null).finalMargin(f.request,f.claim.leaseToken)).rejects.toThrow('margin authority');
    expect((await pool.query('SELECT pause_reason FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0].pause_reason).toBe('margin');
  });
  it('does not certify a durable per-stream LastID regression masked by a higher order ID',async()=>{
    const f=await landed(),boot=randomUUID(),o=f.observe();o.history={...o.history!,lastId:'100',lastIds:{orders:'100',positions:'90'}};
    expect((await storage.reconcile(f.claim,boot,o)).entriesAllowed).toBe(true);
    o.history.lastIds!.positions='89';o.observedAt=Date.now();expect((await storage.reconcile(f.claim,boot,o)).entriesAllowed).toBe(false);
  });
  it('persists full generation and requires two subsequent lease ticks after certification',async()=>{
    const f=await landed(),first=Date.now()-33*60000;
    await pool.query("UPDATE grid_bots SET status='canary',created_at=$2,canary_started_at=$2,consecutive_failures=0 WHERE id=$1",[f.bot.id,new Date(first)]);
    const boot=randomUUID(),clock={bootId:boot,firstConfirmedAt:first,cleanSince:first,lastTickId:'EXAMPLE_PRIOR',lastObservedAt:Date.now()-15000,certifiedGeneration:null,certifiedSafeThrough:null,certifiedTickId:null,cleanTicks:0,promoted:false};
    await pool.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,'canary-clock','internal_canary_clock',$2,clock_timestamp())",[f.bot.id,{clock,full:null}]);
    const observe=()=>({...f.observe(),history:{from:0,through:Date.now()-120000,inclusive:true as const,publicationLagMs:120000,source:'EXAMPLE_FULL_REPLAY',lastId:'100'},qualification:{observedAt:Date.now(),leverage:String(policy().leverage),maxLeverage:'10',feeRate:'0.001',minOrderSize:'0.00000001',lotSize:'0.00000001',tickSize:'0.00000001',recycler:true}});
    await storage.reconcile(f.claim,boot,observe());
    const read=async()=>(await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='canary-clock'",[f.bot.id])).rows[0].evidence;
    expect((await read()).clock.cleanTicks).toBe(0);expect((await read()).full.generation).toBeTruthy();expect((await read()).full.safeThrough).toBeGreaterThanOrEqual(first+30*60000);
    await new GridMonitorStorage(launch).reconcile(f.claim,boot,observe());expect((await read()).clock.cleanTicks).toBe(0);
    for(let i=1;i<=2;i++){
      f.claim.leaseToken=randomUUID();await pool.query('UPDATE grid_bots SET lease_token=$2 WHERE id=$1',[f.bot.id,f.claim.leaseToken]);
      // Distinct observations are strictly increasing even on fast desktop runs.
      await pool.query("UPDATE grid_risk_events SET evidence=jsonb_set(evidence,'{clock,lastObservedAt}',to_jsonb(($2::bigint))) WHERE bot_id=$1 AND event_key='canary-clock'",[f.bot.id,Date.now()-1]);
      await storage.reconcile(f.claim,boot,observe());expect((await read()).clock.cleanTicks).toBe(i);
    }
    expect((await pool.query('SELECT status FROM grid_bots WHERE id=$1',[f.bot.id])).rows[0].status).toBe('active');
    expect((await pool.query('SELECT canary_limit,canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_limit:'100',canary_committed:'90',released_at:null});
    await pool.query("UPDATE grid_bots SET sol_balance='0.1',sol_balance_observed_at=clock_timestamp() WHERE id=$1",[f.bot.id]);
    const state=await storage.planningState(f.claim,boot),now=Date.now(),extra:ExactGridRequest={...f.request,kind:'seed',timestamp:now,data:{symbol:'BTC',amount:'2',side:'bid',reduce_only:false},authority:{...state.authority,seedWorstPrice:'100'}};
    await expect(launch.prepare('EXAMPLE_C2_PROMOTED_RISK',extra,{credits:'10',slots:0,canaryIncrement:'200',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken)).rejects.toThrow('configured exposure limit');
    await pool.query("UPDATE grid_bots SET status='canary' WHERE id=$1",[f.bot.id]);
    await storage.reconcile(f.claim,randomUUID(),observe());expect((await read()).clock.cleanTicks).toBe(0);expect((await read()).clock.cleanSince).toBeGreaterThan(first);expect((await read()).clock.certifiedGeneration).toBeNull();
    await storage.block(f.claim,'quota_unavailable');expect((await read()).clock).toBeNull();
  });
  it('keeps production Start and worker gates disabled by default',()=>{expect(gridRuntimeGates({})).toMatchObject({startEnabled:false,workerEnabled:false,workerRunning:false});});
  it('admits only an authoritative stop close past an uncertain owned entry cancel',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage),stop=await control.request(wallet,f.bot.id,randomUUID(),'stop');
    await control.safetyObservation(f.claim,f.observe());const life=(await control.state(f.claim)).life,now=Date.now();
    const admission={credits:'10',slots:0 as const,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000};
    const cancel:ExactGridRequest={...f.request,kind:'cancel',path:'/orders/cancel',operationType:'cancel_order',timestamp:now,data:{symbol:'BTC',order_id:'10'},authority:{lifecycleEpoch:life.epoch,controlRequestId:stop.id,levelId:f.level.id,originalRequest:f.request}};
    const cancelOp=await launch.prepare('EXAMPLE_CANCEL',cancel,admission,f.claim.leaseToken);expect(await launch.submit(cancelOp,f.claim.leaseToken)).toBe(true);await launch.settle(cancelOp,{state:'unconfirmed',reason:'unknown',releaseSlot:false},f.claim.leaseToken);
    const close:ExactGridRequest={...cancel,kind:'close',path:'/orders/create_market',operationType:'create_market_order',data:{symbol:'BTC',side:'ask',amount:'0.98',reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()},authority:{lifecycleEpoch:life.epoch,controlRequestId:stop.id}};
    await expect(launch.prepare('EXAMPLE_WRONG_STOP',{...close,authority:{...close.authority,controlRequestId:randomUUID()}},admission,f.claim.leaseToken)).rejects.toThrow('Unresolved');
    await expect(launch.prepare('EXAMPLE_NOT_REDUCING',{...close,data:{...close.data,reduce_only:false}},admission,f.claim.leaseToken)).rejects.toThrow();
    const op=await launch.prepare('EXAMPLE_CLOSE',close,admission,f.claim.leaseToken);expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);await launch.settle(op,{state:'unconfirmed',reason:'unknown',releaseSlot:false},f.claim.leaseToken);
    await expect(launch.prepare('EXAMPLE_CLOSE_REPLAY',{...close,data:{...close.data,client_order_id:randomUUID()}},admission,f.claim.leaseToken)).rejects.toThrow('Unresolved');
    expect((await pool.query('SELECT state FROM grid_operations WHERE id=$1',[cancelOp.id])).rows[0].state).toBe('unconfirmed');
  });
  it('claims owner notification events once across concurrent workers and uncertain delivery restart',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage),requestId=randomUUID();
    await control.request(wallet,f.bot.id,requestId,'pause');await control.request(wallet,f.bot.id,requestId,'pause');let calls=0;
    const send=async(recipient:string)=>{expect(recipient).toBe(wallet);calls++;throw Error('EXAMPLE_ACK_LOST');};
    await Promise.all([new GridNotifications(pool,send).deliverNext(),new GridNotifications(pool,send).deliverNext()]);expect(calls).toBe(1);
    expect(await new GridNotifications(pool,send).deliverNext()).toBe(false);expect(calls).toBe(1);
    const snapshot=await new GridStorage(pool,async()=>{}).getBotSnapshot(wallet,f.bot.id,true);expect(snapshot.surface?.notifications).toEqual({pending:0,uncertain:1});expect(snapshot.surface?.bot.status).toBe('pausing');
    await expect(new GridStorage(pool,async()=>{}).getBotSnapshot('EXAMPLE_OTHER',f.bot.id,true)).rejects.toThrow('not_found');
    await control.complete(f.claim,(await control.state(f.claim)).life.active_request,'paused');
    expect(await new GridNotifications(pool,async()=>{calls++;return 'sent';}).deliverNext()).toBe(true);expect(calls).toBe(2);
    expect((await pool.query("SELECT count(*) AS n FROM grid_risk_events WHERE delivered_at IS NOT NULL AND kind NOT LIKE 'internal_%'")).rows[0].n).toBe('1');
    expect((await storage.snapshot(f.claim)).operations).toHaveLength(1);
  });
  it('repeat boot avoids DDL locks and preserves exact columns',async()=>{const c=await pool.connect();await c.query('BEGIN');await c.query('LOCK TABLE grid_exact_fills IN ACCESS SHARE MODE');try{await pool.query("SET lock_timeout='500ms'");await pool.query(migrations[2]);}finally{await c.query('ROLLBACK');c.release();}
    const source=readFileSync(new URL('../../server/schema-migration-manifest.ts',import.meta.url),'utf8');expect(source.replaceAll('\r\n','\n')).toContain(migrations[2].trim().replaceAll('\r\n','\n'));expect(source).toContain('194-grid-monitor-ledger');
  });
  it('deduplicates across pages, committed retries and concurrent reconcilers exactly once',async()=>{const f=await landed(),boot=randomUUID(),o=f.observe();o.trades.push({...o.trades[0]});
    const results=await Promise.all([storage.reconcile(f.claim,boot,o),storage.reconcile(f.claim,boot,o)]);expect(results.every(r=>r.entriesAllowed)).toBe(true);
    expect((await pool.query('SELECT count(*) AS count FROM grid_exact_fills')).rows[0].count).toBe('1');expect((await storage.pnl(wallet,f.bot.id))?.fees).toBe('0.000000000000000001');expect(results[0].owned[0].remaining).toBe('0.02');
  });
  it('a conflicting replay rolls back cursor and economic state',async()=>{const f=await landed(),boot=randomUUID();await storage.reconcile(f.claim,boot,f.observe());const before=(await pool.query('SELECT generation FROM grid_monitor_state')).rows[0].generation;
    const bad=f.observe();bad.trades[0].fee='1';await expect(storage.reconcile(f.claim,boot,bad)).rejects.toThrow('Conflicting');expect((await pool.query('SELECT generation FROM grid_monitor_state')).rows[0].generation).toBe(before);expect((await storage.pnl(wallet,f.bot.id))?.fees).toBe('0.000000000000000001');
  });
  it('a new process cannot reuse an earlier boot startup authorization',async()=>{const f=await landed();await storage.reconcile(f.claim,randomUUID(),f.observe());await expect(storage.planningState(f.claim,randomUUID())).rejects.toThrow('Startup');});
  it('position mismatch blocks entries and leaves the exact residual',async()=>{const f=await landed(),o=f.observe();o.position!.size='0.5';const r=await storage.reconcile(f.claim,randomUUID(),o);expect(r.entriesAllowed).toBe(false);expect(r.owned[0].remaining).toBe('0.02');expect((await pool.query('SELECT boot_id FROM grid_monitor_state')).rows[0].boot_id).toBeNull();});
  it('unknown history exposes no fabricated zero PnL',async()=>{const f=await landed(),o=f.observe();o.trades=[];o.history=null;await storage.reconcile(f.claim,randomUUID(),o);expect(await storage.pnl(wallet,f.bot.id)).toMatchObject({available:false,label:'PnL excludes funding'});});
  it('owner-only PnL and stale marks fail closed',async()=>{const f=await landed();const o=f.observe();o.mark={price:'100',observedAt:Date.now()};await storage.reconcile(f.claim,randomUUID(),o);expect(await storage.pnl('EXAMPLE_OTHER',f.bot.id)).toBeNull();await pool.query("UPDATE grid_monitor_state SET reconciled_at=clock_timestamp()-interval '1 minute'");expect(await storage.pnl(wallet,f.bot.id)).toMatchObject({unrealised:null,total:null});});
  it('an unavailable position cannot publish marked PnL from a nominal flat ledger',async()=>{const f=await landed(),o=f.observe();o.position=null;o.mark={price:'100',observedAt:Date.now()};await storage.reconcile(f.claim,randomUUID(),o);expect(await storage.pnl(wallet,f.bot.id)).toMatchObject({available:false});});
  it('never adopts an unregistered expired legacy owner',async()=>{const f=await fixture();await pool.query("DELETE FROM grid_risk_events WHERE event_key='worker-ownership'");await pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()-interval '1 second'");expect(await storage.claim()).toBeNull();await expect(storage.reconcile(f.claim,randomUUID(),f.observe())).rejects.toThrow('ownership');});

  async function expireOwner(f:{bot:{id:string}}){
    await pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.bot.id]);
    // Let the real signed window elapse; do not rewrite the retained request to simulate time.
    await new Promise(resolve=>setTimeout(resolve,5100));
  }
  it('recovers a crash after custody reservation without manual lease SQL in the recovery path',async()=>{
    const f=await reservation();
    await pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.bot.id]);
    const next=await storage.claim();expect(next?.id).toBe(f.bot.id);expect(next?.leaseToken).not.toBe(f.claim.leaseToken);
    const recovered=await new GridCustody(launch).recover(f.bot.id,wallet,next!.leaseToken);expect(recovered.account).toBe(f.claim.account);
    expect((await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key=$2",[f.bot.id,'worker-retired:'+f.claim.leaseToken])).rows[0].evidence).toMatchObject({retiredGeneration:f.claim.leaseToken,replacementGeneration:next!.leaseToken,signedWindowsExpired:true});
    await expect(storage.snapshot(f.claim)).rejects.toThrow('ownership');
    const observe=()=>({...f.observe(),orders:[],trades:[],position:{direction:'long' as const,size:'0'}});
    expect((await new GridMonitorService({storage,observe:async()=>observe()}).tick(next!,new AbortController().signal)).entriesAllowed).toBe(true);
  });
  it('recovers a prepared crash, keeps its exact payload, and reconciles before admitting entry',async()=>{
    const f=await fixture();await expireOwner(f);const next=(await storage.claim())!;expect(next.id).toBe(f.bot.id);
    const now=Date.now(),r={...f.request,timestamp:now};
    await expect(launch.prepare('EXAMPLE_RECOVERED_ENTRY',r,{credits:'10',slots:1,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},next.leaseToken)).rejects.toThrow('requires reconciliation');
    const observe=()=>({...f.observe(),orders:[],trades:[],position:{direction:'long' as const,size:'0'}});
    const service=new GridMonitorService({storage,observe:async()=>observe()});expect((await service.tick(next,new AbortController().signal)).entriesAllowed).toBe(true);
    const op=(await launch.read(f.bot.id,'EXAMPLE_OPERATION'))!;expect(op.state).toBe('failed');expect(op.exact_request).toEqual(f.op.exact_request);expect(op.exact_request_digest).toBe(f.op.exact_request_digest);
    expect((await pool.query('SELECT slot_released,settled_at FROM grid_execution_claims WHERE operation_id=$1',[op.id])).rows[0]).toMatchObject({slot_released:true,settled_at:expect.any(Date)});
    expect((await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='worker-ownership'",[f.bot.id])).rows[0].evidence.reconciliationRequired).toBe(false);
    expect((await storage.planningState(next,service.bootId)).authority.monitorBootId).toBe(service.bootId);
  },15000);
  it('recovers a submitted POST by its retained identity without re-preparing or re-sending it',async()=>{
    const f=await fixture();expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);await expireOwner(f);const next=(await storage.claim())!;
    expect((await pool.query('SELECT canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_committed:'90',released_at:null});
    expect((await pool.query('SELECT canary_increment,slot_released,settled_at FROM grid_execution_claims WHERE operation_id=$1',[f.op.id])).rows[0]).toEqual({canary_increment:'90',slot_released:false,settled_at:null});
    const service=new GridMonitorService({storage,observe:async()=>f.observe()});expect((await service.tick(next,new AbortController().signal)).entriesAllowed).toBe(true);
    const op=(await launch.read(f.bot.id,'EXAMPLE_OPERATION'))!;expect(op.state).toBe('confirmed');expect(op.exact_request).toEqual(f.op.exact_request);expect(op.exact_request_digest).toBe(f.op.exact_request_digest);
    expect((await pool.query('SELECT count(*) AS n FROM grid_operations WHERE bot_id=$1',[f.bot.id])).rows[0].n).toBe('1');
    expect((await pool.query('SELECT canary_committed,released_at FROM grid_launch_accounts WHERE bot_id=$1',[f.bot.id])).rows[0]).toEqual({canary_committed:'90',released_at:null});
    expect(await launch.submit(f.op,next.leaseToken)).toBe(false);
    let posts=0;await expect(launch.sendOwned(f.request,next.leaseToken,async()=>{posts++;})).rejects.toThrow('ownership');expect(posts).toBe(0);
  },15000);
  it('does not overlap a stalled POST and fences the old owner after its sender transaction retires',async()=>{
    const f=await fixture();expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);
    let start!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;}),hold=new Promise<void>(resolve=>{finish=resolve;});
    await pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[f.bot.id]);
    const sending=launch.sendOwned(f.request,f.claim.leaseToken,async()=>{start();await hold;return 'EXAMPLE_POST_COMPLETED';});await started;
    try{await new Promise(resolve=>setTimeout(resolve,5100));expect(await storage.claim()).toBeNull();}finally{finish();}
    expect(await sending).toBe('EXAMPLE_POST_COMPLETED');const next=(await storage.claim())!;expect(next.leaseToken).not.toBe(f.claim.leaseToken);
    await expect(launch.settle(f.op,{state:'confirmed',reason:null,releaseSlot:false},f.claim.leaseToken)).rejects.toThrow('ownership');
    await expect(launch.sendOwned({...f.request,timestamp:Date.now()},f.claim.leaseToken,async()=>{throw Error('old sender entered');})).rejects.toThrow('ownership');
    await expect(launch.prepare('EXAMPLE_OLD_GENERATION',{...f.request,timestamp:Date.now()},{credits:'10',slots:1,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:Date.now(),expiresAt:Date.now()+5000},f.claim.leaseToken)).rejects.toThrow('ownership');
    await storage.release(f.claim);expect((await storage.snapshot(next)).bot.lease_token).toBe(next.leaseToken);
  },15000);

  it.each(['fund','sweep'] as const)('takeover retains an unknown %s and restores latched Stop reductions without replay',async kind=>{
    const f=await reservation();
    const now=Date.now(),transfer:ExactGridRequest={botId:f.bot.id,account:f.claim.account,masterAccount:f.claim.masterAccount,timestamp:now,expiryMs:5000,kind,path:'/account/subaccount/transfer',operationType:'transfer_funds',data:{to_account:kind==='fund'?f.claim.account:f.claim.masterAccount,amount:'1'},authority:{}};
    const life=new GridLifecycleStorage(storage);
    let op:Awaited<ReturnType<typeof launch.prepare>>;
    if(kind==='fund')op=await launch.prepare('EXAMPLE_UNKNOWN_TRANSFER',transfer,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    else {
      // A lost terminal sweep is already retained; the test fixture models its prior valid admission.
      const id=randomUUID(),digest=requestDigest(transfer);
      op=(await pool.query("INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type,exact_request,exact_request_digest,state,submitted_at) VALUES($1,$2,'EXAMPLE_UNKNOWN_TRANSFER',$3,'sweep_subaccount',$4,$3,'submitted',clock_timestamp()) RETURNING *",[id,f.bot.id,digest,transfer])).rows[0];
    }
    if(kind==='fund')expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);
    const control=await life.request(wallet,f.bot.id,'EXAMPLE_LATCHED_STOP','stop');await expireOwner(f);const next=(await storage.claim())!;
    expect((await life.state(next)).life.active_request).toBe(control.id);
    let posts=0,settlements=0,recycles=0;
    const observation=()=>({...f.observe(),orders:[],trades:[],position:{direction:'long' as const,size:'0.98'}});
    const deps:GridLifecycleDeps={storage:life,observe:async()=>observation(),sol:async()=>({balance:'0.1',observedAt:Date.now()}),recover:async()=>({state:'unknown'}),
      send:async(claim,r)=>launch.sendOwned(r,claim.leaseToken,async()=>{posts++;expect(r.kind).toBe('close');return {rateLimited:false};}),resume:async()=>null,settlement:async()=>{settlements++;return null;},recycle:async()=>{recycles++;}};
    expect(await new GridLifecycleService(deps).tick(next,new AbortController().signal)).toBe('pending');expect(posts).toBe(1);
    expect((await launch.read(f.bot.id,'EXAMPLE_UNKNOWN_TRANSFER'))!.exact_request).toEqual(op.exact_request);
    expect((await pool.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='worker-ownership'",[f.bot.id])).rows[0].evidence.reconciliationRequired).toBe(true);
    const close=(await pool.query("SELECT * FROM grid_operations WHERE bot_id=$1 AND type='close_position'",[f.bot.id])).rows[0];
    await launch.settle(close,{state:'confirmed',reason:null,releaseSlot:true},next.leaseToken);
    deps.observe=async()=>({...observation(),position:{direction:'long',size:'0'}});
    expect(await new GridLifecycleService(deps).tick(next,new AbortController().signal)).toBe('transfer_outcome_unknown');
    expect(posts).toBe(1);expect(settlements).toBe(0);expect(recycles).toBe(0);expect((await launch.read(f.bot.id,'EXAMPLE_UNKNOWN_TRANSFER'))!.state).toBe('submitted');
  },15000);
  it('claims a released generation once across workers',async()=>{const f=await landed();await storage.release(f.claim);await pool.query('UPDATE grid_bots SET last_tick_at=NULL');const result=await Promise.all([storage.claim(),storage.claim()]);expect(result.filter(Boolean)).toHaveLength(1);});
  it('recovers an expired provably unsent preparation, releases claims and advances its attempt once',async()=>{const f=await fixture();f.op.exact_request.timestamp-=10000;f.op.exact_request_digest=requestDigest(f.op.exact_request);
    await pool.query('UPDATE grid_operations SET exact_request=$2,exact_request_digest=$3 WHERE id=$1',[f.op.id,f.op.exact_request,f.op.exact_request_digest]);
    expect(await launch.expirePrepared(f.op,f.claim.leaseToken)).toBe(true);expect(await launch.expirePrepared(f.op,f.claim.leaseToken)).toBe(false);expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(false);
    expect((await pool.query('SELECT status,placement_attempt FROM grid_levels WHERE id=$1',[f.level.id])).rows[0]).toEqual({status:'pending',placement_attempt:1});expect((await pool.query('SELECT canary_committed FROM grid_launch_accounts')).rows[0].canary_committed).toBe('0');
    expect((await pool.query('SELECT slot_released FROM grid_execution_claims')).rows[0].slot_released).toBe(true);
  });
  it('crash after submit permission but before or after send cannot grant a second send',async()=>{const f=await fixture();expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(false);expect(await launch.expirePrepared(f.op,f.claim.leaseToken)).toBe(false);
    const service=new GridMonitorService({storage,observe:async()=>f.observe()});const r=await service.tick(f.claim,new AbortController().signal);expect(r.entriesAllowed).toBe(true);
    expect((await pool.query('SELECT state FROM grid_operations')).rows[0].state).toBe('confirmed');expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(false);
    await service.tick(f.claim,new AbortController().signal);expect((await pool.query('SELECT count(*) AS n FROM grid_exact_fills')).rows[0].n).toBe('1');
  });
  it('opaque orphan orders keep startup blocked and cannot create operations',async()=>{const f=await landed(),o=f.observe();o.orders.push({...o.orders[0],orderId:'99',clientOrderId:randomUUID()});const service=new GridMonitorService({storage,observe:async()=>o});expect((await service.tick(f.claim,new AbortController().signal)).entriesAllowed).toBe(false);expect((await pool.query('SELECT count(*) AS n FROM grid_operations')).rows[0].n).toBe('1');});
  it('recovers an attributable seed after send without replaying it or inventing a level',async()=>{
    const f=await fixture();f.op.exact_request={...f.op.exact_request,kind:'seed',path:'/orders/create_market',operationType:'create_market_order',data:{...f.op.exact_request.data,slippage_percent:'0.5'},authority:{...f.op.exact_request.authority,seedWorstPrice:'100'}};f.op.exact_request_digest=requestDigest(f.op.exact_request);
    await pool.query("UPDATE grid_operations SET exact_request=$2,exact_request_digest=$3,level_id=NULL,type='seed_position' WHERE id=$1",[f.op.id,f.op.exact_request,f.op.exact_request_digest]);
    expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);const o=f.observe();o.orders[0].orderType='market';o.orders[0].status='filled';o.orders[0].filledAmount='1';o.trades[0].size='1';o.position!.size='1';
    const service=new GridMonitorService({storage,observe:async()=>o});expect((await service.tick(f.claim,new AbortController().signal)).entriesAllowed).toBe(true);expect((await pool.query('SELECT level_id FROM grid_exact_fills')).rows[0].level_id).toBeNull();expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(false);
  });
  it('settlement recovery cannot mutate after lease ownership is lost',async()=>{const f=await fixture();await launch.submit(f.op,f.claim.leaseToken);await pool.query('UPDATE grid_bots SET lease_token=$1',[randomUUID()]);await expect(launch.settle(f.op,{state:'confirmed',reason:null,releaseSlot:false,orderId:'10'},f.claim.leaseToken)).rejects.toThrow('ownership');expect((await pool.query('SELECT state FROM grid_operations')).rows[0].state).toBe('submitted');});
  it('reserves profit backing atomically and retains it across uncertain sends',async()=>{const f=await landed(),boot=randomUUID();await storage.reconcile(f.claim,boot,f.observe());
    const state=await storage.planningState(f.claim,boot),level=(await pool.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal DESC LIMIT 1',[f.bot.id])).rows[0],now=Date.now();
    const request:ExactGridRequest={...f.request,timestamp:now,data:{...f.request.data,client_order_id:randomUUID(),side:'ask',reduce_only:true,price:'110',amount:'0.98'},
      authority:{...state.authority,levelId:level.id,levelAttempt:0,fillAllocations:[{tradeId:'1',size:'0.98'}]}};
    const claim={credits:'10',slots:1 as const,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000};
    const results=await Promise.allSettled([launch.prepare('EXAMPLE_PROFIT_A',request,claim,f.claim.leaseToken),launch.prepare('EXAMPLE_PROFIT_B',request,claim,f.claim.leaseToken)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const op=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof launch.prepare>>>).value;
    expect((await pool.query('SELECT size,released_at FROM grid_profit_allocations')).rows).toEqual([{size:'0.98',released_at:null}]);
    expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);await launch.settle(op,{state:'unconfirmed',reason:'transport',releaseSlot:false});
    expect((await storage.planningState(f.claim,boot)).reserved).toEqual([{tradeId:'1',size:'0.98'}]);
  });
  it('a reconciliation generation change fences previously prepared sends',async()=>{const f=await landed(),boot=randomUUID();await storage.reconcile(f.claim,boot,f.observe());
    await storage.block(f.claim,'ownership_recheck');const old={...f.op,exact_request:{...f.op.exact_request,authority:{...f.op.exact_request.authority,monitorBootId:boot,monitorGeneration:'1'}}};old.exact_request_digest=requestDigest(old.exact_request);
    expect(await launch.submit(old,f.claim.leaseToken)).toBe(false);
  });
  it('terminal order progress releases its slot without padding partials',async()=>{const f=await landed(),o=f.observe();o.orders[0].status='filled';o.orders[0].filledAmount='1';o.trades[0].size='1';o.position!.size='1';await storage.reconcile(f.claim,randomUUID(),o);
    expect((await pool.query('SELECT filled,remaining,status FROM grid_monitor_orders')).rows[0]).toEqual({filled:'1',remaining:'0',status:'filled'});expect((await pool.query('SELECT slot_released FROM grid_execution_claims')).rows[0].slot_released).toBe(true);
  });
  it('cancelled partial entries retain their exact replacement residual and reject a live regression',async()=>{
    const f=await landed(),boot=randomUUID(),o=f.observe();o.orders[0].status='cancelled';o.orders[0].cancelledAmount='0.02';
    await storage.reconcile(f.claim,boot,o);const state=await storage.planningState(f.claim,boot);
    expect(state.levels.find(l=>l.id===f.level.id)).toMatchObject({status:'cancelled',exact_size:'0.02',placement_attempt:1});
    await expect(storage.reconcile(f.claim,boot,f.observe())).rejects.toThrow('Regressing');
  });
  async function profitFixture(){
    const f=await landed(),boot=randomUUID(),o=f.observe();o.orders[0].status='filled';o.orders[0].filledAmount='1';o.trades[0].size='1';o.position!.size='1';
    await storage.reconcile(f.claim,boot,o);const state=await storage.planningState(f.claim,boot);
    const level=(await pool.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal DESC LIMIT 1',[f.bot.id])).rows[0],now=Date.now();
    const request:ExactGridRequest={...f.request,timestamp:now,data:{...f.request.data,client_order_id:randomUUID(),side:'ask',reduce_only:true,price:'110',amount:'1'},authority:{...state.authority,levelId:level.id,levelAttempt:0,fillAllocations:[{tradeId:'1',size:'1'}]}};
    const op=await launch.prepare('EXAMPLE_PROFIT',request,{credits:'10',slots:1,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);await launch.settle(op,{state:'confirmed',reason:null,releaseSlot:false,orderId:'11'});
    o.orders.push({...o.orders[0],orderId:'11',clientOrderId:String(request.data.client_order_id),side:'short',reduceOnly:true,price:'110',filledAmount:'0.4',cancelledAmount:'0.6',status:'cancelled',createdAt:now,updatedAt:now});
    o.trades.push({...o.trades[0],tradeId:'2',orderId:'11',clientOrderId:String(request.data.client_order_id),side:'close_long',time:now,size:'0.4',price:'110'});
    o.position!.size='0.6';o.observedAt=Date.now();o.history!.through=Date.now();return {f,boot,o};
  }
  it('terminal partial profits release only unused backing and never re-arm a still-open entry lot',async()=>{
    const {f,boot,o}=await profitFixture();await storage.reconcile(f.claim,boot,o);await storage.reconcile(f.claim,boot,o);
    expect((await pool.query('SELECT size,released_size,settled_at IS NOT NULL AS settled FROM grid_profit_allocations')).rows[0]).toEqual({size:'1',released_size:'0.6',settled:true});
    expect((await storage.planningState(f.claim,boot)).reserved).toEqual([{tradeId:'1',size:'0.4'}]);
    expect((await pool.query('SELECT status FROM grid_levels WHERE id=$1',[f.level.id])).rows[0].status).toBe('filled');
  });
  it('a fully settled profit re-arms its source entry once, with a new attempt',async()=>{
    const {f,boot,o}=await profitFixture();o.orders[1].status='filled';o.orders[1].filledAmount='1';o.orders[1].cancelledAmount='0';o.trades[1].size='1';o.position!.size='0';
    await storage.reconcile(f.claim,boot,o);await storage.reconcile(f.claim,boot,o);
    expect((await pool.query('SELECT status,placement_attempt,client_order_uuid,venue_order_id FROM grid_levels WHERE id=$1',[f.level.id])).rows[0]).toEqual({status:'pending',placement_attempt:1,client_order_uuid:null,venue_order_id:null});
  });
  it('lifecycle migration repeat boot is catalog-only and embedded exactly',async()=>{
    const c=await pool.connect();await c.query('BEGIN');await c.query('LOCK TABLE grid_control_requests IN ACCESS SHARE MODE');
    try{await pool.query("SET lock_timeout='500ms'");await pool.query(migrations[3]);}finally{await c.query('ROLLBACK');c.release();}
    expect(readFileSync(new URL('../../server/schema-migration-manifest.ts',import.meta.url),'utf8').replaceAll('\r\n','\n')).toContain(migrations[3].trim().replaceAll('\r\n','\n'));
  });
  it('owner control is scoped, concurrent-idempotent, and fences already prepared entries',async()=>{
    const f=await fixture(),control=new GridLifecycleStorage(storage),key=randomUUID();
    await expect(control.request('EXAMPLE_OTHER',f.bot.id,key,'stop')).rejects.toThrow('not_found');
    const replies=await Promise.all([control.request(wallet,f.bot.id,key,'pause'),control.request(wallet,f.bot.id,key,'pause')]);
    expect(replies[0].id).toBe(replies[1].id);expect((await pool.query('SELECT count(*) AS n FROM grid_control_requests')).rows[0].n).toBe('1');
    expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(false);
    await expect(control.request(wallet,f.bot.id,key,'stop')).rejects.toThrow('conflict');
    expect((await control.state(f.claim)).bot.status).toBe('pausing');
  });
  it('stale workers cannot latch a risk control or publish SOL facts',async()=>{
    const f=await fixture(),control=new GridLifecycleStorage(storage);await pool.query('UPDATE grid_bots SET lease_token=$1',[randomUUID()]);
    await expect(control.request(wallet,f.bot.id,randomUUID(),'stop',{price:'80'},'risk',f.claim)).rejects.toThrow();
    await expect(control.sol(f.claim,{balance:'1',observedAt:Date.now()})).rejects.toThrow();expect((await pool.query('SELECT count(*) AS n FROM grid_control_requests')).rows[0].n).toBe('0');
  });
  it('stop supersedes pause durably and cannot be resumed out of stopping',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage),pause=await control.request(wallet,f.bot.id,randomUUID(),'pause');
    const stop=await control.request(wallet,f.bot.id,randomUUID(),'stop',{price:'80'},'risk',f.claim);
    // Safety revocation fences any automatic authority before the Stop request advances its epoch.
    expect((await control.state(f.claim)).life).toMatchObject({epoch:'3',active_request:stop.id});
    expect((await pool.query('SELECT state FROM grid_control_requests WHERE id=$1',[pause.id])).rows[0].state).toBe('superseded');
    expect((await pool.query('SELECT evidence FROM grid_risk_events WHERE event_key=$1',[stop.id])).rows[0].evidence).toEqual({price:'80'});
    await expect(control.request(wallet,f.bot.id,randomUUID(),'resume')).rejects.toThrow('conflict');
    await expect(control.complete(f.claim,pause.id,'paused')).rejects.toThrow('conflict');
  });
  it('SOL warnings deduplicate by transition and unknown remains unknown',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage);
    await control.sol(f.claim,{balance:'0.05',observedAt:Date.now()});await control.sol(f.claim,{balance:'0.05',observedAt:Date.now()});
    expect((await pool.query("SELECT count(*) AS n FROM grid_risk_events WHERE kind LIKE 'sol_%'")).rows[0].n).toBe('1');
    await control.sol(f.claim,null);expect((await control.state(f.claim)).bot).toMatchObject({sol_balance:null,sol_guard_state:'unknown'});
  });
  it('pause completion cannot terminalize a stop or bypass an uncertain operation',async()=>{
    const f=await fixture(),control=new GridLifecycleStorage(storage),pause=await control.request(wallet,f.bot.id,randomUUID(),'pause');
    await expect(control.complete(f.claim,pause.id,'paused')).rejects.toThrow('conflict');
    const stop=await control.request(wallet,f.bot.id,randomUUID(),'stop');await expect(control.complete(f.claim,stop.id,'paused')).rejects.toThrow('invariant');
    await expect(new GridStorage(pool,async()=>{}).finalizeTerminalStop(f.bot.id,f.claim.leaseToken,f.op.id,'0',new Date())).rejects.toThrow();
  });
  it('pause completion and resume never reuse startup authority',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage),pause=await control.request(wallet,f.bot.id,randomUUID(),'pause');
    await control.complete(f.claim,pause.id,'paused');const resume=await control.request(wallet,f.bot.id,randomUUID(),'resume');
    await expect(control.complete(f.claim,resume.id,'canary')).rejects.toThrow('invariant');
    await storage.reconcile(f.claim,randomUUID(),f.observe());await control.sol(f.claim,{balance:'0',observedAt:Date.now()});
    await expect(control.complete(f.claim,resume.id,'canary')).rejects.toThrow('invariant');
  });
  it('unknown SOL and missing marks deny entries even with a clean fill ledger',async()=>{
    const f=await landed(),o=f.observe();o.orders[0].status='cancelled';o.orders[0].cancelledAmount='0.02';
    const boot=randomUUID();await storage.reconcile(f.claim,boot,o);const state=await storage.planningState(f.claim,boot),now=Date.now();
    const r={...f.request,timestamp:now,data:{...f.request.data,amount:'0.02',client_order_id:randomUUID()},authority:{...state.authority,levelId:f.level.id,levelAttempt:1}};
    await expect(launch.prepare('EXAMPLE_DENIED',r,{credits:'10',slots:1,canaryIncrement:'1.8',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken)).rejects.toThrow('risk gate');
  });
  it('reduce-only close stays usable under entry denial, and stale submit is fenced',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage);await control.request(wallet,f.bot.id,randomUUID(),'stop');await control.safetyObservation(f.claim,f.observe());
    const life=(await control.state(f.claim)).life,now=Date.now();
    const r:ExactGridRequest={...f.request,kind:'close',path:'/orders/create_market',operationType:'create_market_order',timestamp:now,data:{symbol:'BTC',side:'ask',amount:'0.98',reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()},authority:{lifecycleEpoch:life.epoch}};
    await pool.query('UPDATE grid_bots SET consecutive_failures=5,sol_balance=NULL');
    const op=await launch.prepare('EXAMPLE_CLOSE',r,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    await pool.query("UPDATE grid_monitor_state SET reconciled_at=clock_timestamp()-interval '10 seconds'");expect(await launch.submit(op,f.claim.leaseToken)).toBe(false);
    await control.safetyObservation(f.claim,f.observe());expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);
  });
  it('sweep cannot use a boolean settlement flag or a mismatched balance as authority',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage);await control.request(wallet,f.bot.id,randomUUID(),'stop');
    const o=f.observe();o.orders[0].status='cancelled';o.orders[0].filledAmount='0';o.orders[0].cancelledAmount='1';o.trades=[];o.position!.size='0';await storage.reconcile(f.claim,randomUUID(),o);
    const now=Date.now(),life=(await control.state(f.claim)).life;
    const r:ExactGridRequest={...f.request,kind:'sweep',timestamp:now,path:'/account/subaccount/transfer',operationType:'transfer_funds',data:{to_account:f.claim.masterAccount,amount:'2'},authority:{lifecycleEpoch:life.epoch,settlementComplete:true}};
    const admission={credits:'10',slots:0 as const,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000};
    await expect(launch.prepare('EXAMPLE_SWEEP',r,admission,f.claim.leaseToken)).rejects.toThrow('authority');
    r.authority.settlement={account:f.claim.account,masterAccount:f.claim.masterAccount,balance:'1',withdrawable:'1',settlementComplete:true,source:'EXAMPLE',observedAt:now,recycler:{reuse:true,recycle:true,deployment:'EXAMPLE',expectedDeployment:'EXAMPLE',checkedAt:now}};
    await expect(launch.prepare('EXAMPLE_SWEEP',r,admission,f.claim.leaseToken)).rejects.toThrow('authority');
  });
  it('terminal zero proof releases custody and completes stop atomically once',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage),stop=await control.request(wallet,f.bot.id,randomUUID(),'stop');
    const o=f.observe();o.orders[0].status='cancelled';o.orders[0].filledAmount='0';o.orders[0].cancelledAmount='1';o.trades=[];o.position!.size='0';await storage.reconcile(f.claim,randomUUID(),o);
    const custody=new GridCustody(launch),identity=await custody.recover(f.bot.id,wallet,f.claim.leaseToken),now=Date.now();
    const proof={account:f.claim.account,masterAccount:f.claim.masterAccount,balance:'0',withdrawable:'0',settlementComplete:true as const,source:'EXAMPLE_FULL_ACCOUNT',observedAt:now,recycler:{reuse:true,recycle:true,deployment:'EXAMPLE',expectedDeployment:'EXAMPLE',checkedAt:now}};
    await expect(custody.recycleStopped(identity,umk(),stop.id,{...proof,balance:'0.01'})).rejects.toThrow('proof');
    await custody.recycleStopped(identity,umk(),stop.id,proof);
    expect((await pool.query('SELECT status,residual_usdc FROM grid_bots')).rows[0]).toMatchObject({status:'stopped'});
    expect((await pool.query('SELECT status FROM protocol_subaccounts')).rows[0].status).toBe('spare');
    expect((await control.request(wallet,f.bot.id,randomUUID(),'stop')).id).toBe(stop.id);
    await expect(custody.recycleStopped(identity,umk(),stop.id,proof)).rejects.toThrow();
  });

  it('deduplicates coalesced request keys even after completion',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage),first=randomUUID(),alias=randomUUID();const a=await control.request(wallet,f.bot.id,first,'pause');expect((await control.request(wallet,f.bot.id,alias,'pause')).id).toBe(a.id);
    await control.complete(f.claim,a.id,'paused');expect((await control.request(wallet,f.bot.id,alias,'pause')).id).toBe(a.id);await expect(control.request(wallet,f.bot.id,alias,'stop')).rejects.toThrow('conflict');
  });
  it('stop market close fills are owned once without profit-allocation reservations',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage);await control.request(wallet,f.bot.id,randomUUID(),'stop');await control.safetyObservation(f.claim,f.observe());const now=Date.now(),life=(await control.state(f.claim)).life;
    const r:ExactGridRequest={...f.request,kind:'close',path:'/orders/create_market',operationType:'create_market_order',timestamp:now,data:{symbol:'BTC',side:'ask',amount:'0.98',reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()},authority:{lifecycleEpoch:life.epoch}};
    const op=await launch.prepare('EXAMPLE_STOP_CLOSE',r,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);expect(await launch.submit(op,f.claim.leaseToken)).toBe(true);await launch.settle(op,{state:'confirmed',reason:null,releaseSlot:true,orderId:'11',orderStatus:'filled'},f.claim.leaseToken);
    const o=f.observe();o.position!.size='0';o.orders.push({orderId:'11',clientOrderId:String(r.data.client_order_id),symbol:'BTC',side:'short',price:'80',amount:'0.98',filledAmount:'0.98',cancelledAmount:'0',reduceOnly:true,orderType:'market',createdAt:now,updatedAt:now,status:'filled'});o.trades.push({tradeId:'2',orderId:'11',clientOrderId:String(r.data.client_order_id),symbol:'BTC',side:'close_long',time:now,size:'0.98',price:'80',fee:'0.01'});
    await storage.reconcile(f.claim,randomUUID(),o);await storage.reconcile(f.claim,randomUUID(),o);expect((await pool.query('SELECT count(*) AS n FROM grid_exact_fills')).rows[0].n).toBe('2');expect((await pool.query('SELECT blocked_reasons FROM grid_monitor_state')).rows[0].blocked_reasons).toEqual([]);
  });


 it('generic rejection blocks entries without counting a qualifying breaker failure',async()=>{const f=await fixture();await launch.submit(f.op,f.claim.leaseToken);await launch.settle(f.op,{state:'failed',reason:'venue_rejection',releaseSlot:true},f.claim.leaseToken);const b=(await storage.snapshot(f.claim)).bot;expect(b.consecutive_failures).toBe(0);expect(b.pause_reason).toBe('venue_rejection');expect(b.status).toBe('pausing');});
 it.each(['authentication','quota','transport'] as const)('monitor recovery retains terminal %s once across repeated ticks',async failureClass=>{
    const f=await landed(),now=Date.now();
    const r:ExactGridRequest={...f.request,kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now,data:{to_account:f.claim.account,amount:'1'},authority:{}};
    const op=await launch.prepare('EXAMPLE_RECOVERY',r,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    await launch.submit(op,f.claim.leaseToken);await launch.settle(op,{state:'unconfirmed',reason:'unknown',releaseSlot:false});
    let recoveries=0;
    const service=new GridMonitorService({storage,observe:async()=>f.observe(),recover:async retained=>{recoveries++;return {state:'rejected',requestDigest:retained.exact_request_digest!,failureClass,releaseSlot:false};}});
    await service.tick(f.claim,new AbortController().signal);await new GridMonitorService({storage,observe:async()=>f.observe()}).tick(f.claim,new AbortController().signal);
    expect(recoveries).toBe(1);expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(1);
    expect((await pool.query('SELECT slot_released FROM grid_execution_claims WHERE operation_id=$1',[op.id])).rows[0].slot_released).toBe(true);
    expect((await launch.read(f.bot.id,'EXAMPLE_RECOVERY'))?.failure_classification).toBe(failureClass);
  });
 it('qualified terminal failure crosses the breaker exactly once',async()=>{const f=await fixture();await pool.query('UPDATE grid_bots SET consecutive_failures=4');await launch.submit(f.op,f.claim.leaseToken);await launch.settle(f.op,{state:'failed',reason:'authentication',releaseSlot:true,terminalFailure:{requestDigest:f.op.exact_request_digest,classification:'authentication'}},f.claim.leaseToken);expect((await storage.snapshot(f.claim)).bot).toMatchObject({consecutive_failures:5,status:'pausing',pause_reason:'circuit_breaker'});await expect(launch.settle(f.op,{state:'failed',reason:'authentication',releaseSlot:true,terminalFailure:{requestDigest:f.op.exact_request_digest,classification:'authentication'}},f.claim.leaseToken)).rejects.toThrow();expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(5);});
 it('requires full authoritative health and a terminal success after the latest failure to reset',async()=>{
    const f=await landed(),o=f.observe(),now=Date.now();
    const r:ExactGridRequest={...f.request,kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now,data:{to_account:f.claim.account,amount:'1'},authority:{}};
    const failed=await launch.prepare('EXAMPLE_FAILURE',r,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},f.claim.leaseToken);
    await launch.submit(failed,f.claim.leaseToken);
    await launch.settle(failed,{state:'failed',reason:'transport',releaseSlot:true,terminalFailure:{classification:'transport',requestDigest:failed.exact_request_digest}});
    await pool.query("UPDATE grid_operations SET terminal_at=clock_timestamp()-interval '1 second' WHERE id=$1",[failed.id]);
    o.orders[0].status='filled';o.orders[0].filledAmount='1';o.orders[0].updatedAt=Date.now();o.trades[0].size='1';o.position!.size='1';o.observedAt=Date.now();
    await storage.reconcile(f.claim,randomUUID(),o);
    expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(1); // Parity alone is insufficient.
    await pool.query("UPDATE grid_bots SET created_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[f.bot.id]);
    o.history={from:0,through:Date.now()-120000,inclusive:true,publicationLagMs:120000,source:'EXAMPLE_FULL_REPLAY',lastId:'100'};
    o.qualification={observedAt:Date.now(),leverage:String(policy().leverage),maxLeverage:'10',feeRate:'0.001',minOrderSize:'0.00000001',lotSize:'0.00000001',tickSize:'0.00000001',recycler:true};
    await pool.query("UPDATE grid_master_quota SET backoff_until=clock_timestamp()+interval '60 seconds'");
    await storage.reconcile(f.claim,randomUUID(),o);expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(1);
    await pool.query("UPDATE grid_master_quota SET backoff_until=clock_timestamp()-interval '1 second'");
    await storage.reconcile(f.claim,randomUUID(),o);expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(0);
    await pool.query('UPDATE grid_bots SET consecutive_failures=2');
    await pool.query("UPDATE grid_operations SET terminal_at=clock_timestamp()+interval '1 second' WHERE id=$1",[failed.id]);
    await storage.reconcile(f.claim,randomUUID(),o);expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(2);
  });
 it('wallet SOL incident survives another storage instance and closes on health',async()=>{const f=await landed(),a=new GridLifecycleStorage(storage),b=new GridLifecycleStorage(storage);await a.sol(f.claim,{balance:'0.049999999',observedAt:Date.now()});await b.sol(f.claim,{balance:'0.049999999',observedAt:Date.now()});expect((await pool.query("SELECT count(*) AS n FROM grid_risk_events WHERE kind LIKE 'sol_%'")).rows[0].n).toBe('1');expect((await pool.query('SELECT * FROM grid_wallet_safety')).rows[0]).toMatchObject({execution_wallet:'EXAMPLE_MASTER',balance_lamports:'49999999',guard_state:'entry_blocked',policy_version:'1.0.0'});await b.sol(f.claim,{balance:'0.05',observedAt:Date.now()});await a.sol(f.claim,{balance:'0.049999999',observedAt:Date.now()});expect((await pool.query("SELECT count(*) AS n FROM grid_risk_events WHERE kind LIKE 'sol_%'")).rows[0].n).toBe('2');await b.sol(f.claim,{balance:'0.1',observedAt:Date.now()});expect((await pool.query('SELECT incident_id FROM grid_wallet_safety')).rows[0].incident_id).toBeNull();});
});
