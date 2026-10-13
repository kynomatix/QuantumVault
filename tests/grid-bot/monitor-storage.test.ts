import {GridLifecycleStorage} from '../../server/grid-bot/lifecycle-storage';
import {GridNotifications} from '../../server/grid-bot/notifications';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import bs58 from 'bs58';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,requestDigest,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {GridMonitorStorage,type GridMonitorClaim} from '../../server/grid-bot/monitor-storage';
import {GridMonitorService} from '../../server/grid-bot/monitor-service';
import {GridCustody} from '../../server/grid-bot/custody';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {gridDraftRevision} from '../../client/src/lib/grid-draft-view';
import {policy,umk,intent} from './draft-fixtures';
import {marginTestReading} from './margin-fixture';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {GRID_START_ROUTE_ENABLED,GRID_WORKER_ENABLED} from '../../server/grid-bot/service';
const migrations=['0004_grid_bot_drafts.sql','0005_grid_launch.sql','0006_grid_monitor.sql','0007_grid_lifecycle.sql'].map(p=>readFileSync(new URL('../../migrations/'+p,import.meta.url),'utf8'));
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
  async function fixture(){const p=policy(),h=computeGridPolicyHmac(p,umk());if(!h.ok)throw Error();const {levels,...snapshot}=p;
    const bot:DraftRecord={...snapshot,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:'A'.repeat(64),draftRevision:gridDraftRevision(intent),createIntent:intent,authoritySnapshot:{state:'EXAMPLE'},policyHmac:h.digest,name:'Grid draft',rangeSource:'manual',chartTimeframe:'1h'};
    await new GridStorage(pool,async()=>{}).createDraftWithLevels(bot,levels);
    const account=await new GridCustody(launch).reserve({botId:bot.id,wallet,masterAccount:'EXAMPLE_MASTER',policyHmac:bot.policyHmac,canaryLimit:'250'},umk());
    const claim:GridMonitorClaim={id:bot.id,leaseToken:account.leaseToken,account:account.account,masterAccount:account.masterAccount};
    const level=(await pool.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal LIMIT 1',[bot.id])).rows[0];
    const now=Date.now(),cloid=randomUUID();
    const request:ExactGridRequest={kind:'limit',botId:bot.id,account:account.account,masterAccount:account.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:now,expiryMs:5000,
      data:{symbol:'BTC',client_order_id:cloid,side:'bid',reduce_only:false,amount:'1',price:'90'},authority:{levelId:level.id,levelAttempt:0}};
    const op=await launch.prepare('EXAMPLE_OPERATION',request,{credits:'10',slots:1,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000},claim.leaseToken);
    const observe=():GridObservation=>({account:claim.account,symbol:'BTC',observedAt:Date.now(),inventoryComplete:true,history:{from:0,through:Date.now(),inclusive:true,publicationLagMs:0,source:'EXAMPLE_REVIEWED_AUTHORITY'},mark:null,position:{direction:'long',size:'0.98'},
      orders:[{orderId:'10',clientOrderId:cloid,symbol:'BTC',side:'long',price:'90',amount:'1',filledAmount:'0.98',cancelledAmount:'0',reduceOnly:false,orderType:'limit',createdAt:now,updatedAt:now,status:'partially_filled'}],
      trades:[{tradeId:'1',orderId:'10',clientOrderId:cloid,symbol:'BTC',side:'open_long',time:now,size:'0.98',price:'90',fee:'0.000000000000000001'}]});
    return {bot,claim,level,op,request,observe};
  }
  async function landed(){const f=await fixture();expect(await launch.submit(f.op,f.claim.leaseToken)).toBe(true);await launch.settle(f.op,{state:'confirmed',reason:null,releaseSlot:false,orderId:'10'});return f;}
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
    await pool.query("UPDATE grid_bots SET status='canary' WHERE id=$1",[f.bot.id]);
    await storage.reconcile(f.claim,randomUUID(),observe());expect((await read()).clock.cleanTicks).toBe(0);expect((await read()).clock.cleanSince).toBeGreaterThan(first);expect((await read()).clock.certifiedGeneration).toBeNull();
    await storage.block(f.claim,'quota_unavailable');expect((await read()).clock).toBeNull();
  });
  it('keeps production start and worker gates disabled',()=>{expect(GRID_START_ROUTE_ENABLED).toBe(false);expect(GRID_WORKER_ENABLED).toBe(false);});
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
    expect((await pool.query('SELECT count(*) AS n FROM grid_risk_events WHERE delivered_at IS NOT NULL')).rows[0].n).toBe('1');
    expect((await storage.snapshot(f.claim)).operations).toHaveLength(1);
  });
  it('repeat boot avoids DDL locks and preserves exact columns',async()=>{const c=await pool.connect();await c.query('BEGIN');await c.query('LOCK TABLE grid_exact_fills IN ACCESS SHARE MODE');try{await pool.query("SET lock_timeout='500ms'");await pool.query(migrations[2]);}finally{await c.query('ROLLBACK');c.release();}
    const source=readFileSync(new URL('../../server/db.ts',import.meta.url),'utf8');expect(source.replaceAll('\r\n','\n')).toContain(migrations[2].trim().replaceAll('\r\n','\n'));expect(source).toContain('194-grid-monitor-ledger');
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
  it('never steals an expired lease from an uncertain old worker',async()=>{const f=await fixture();await pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()-interval '1 second'");expect(await storage.claim()).toBeNull();await expect(storage.reconcile(f.claim,randomUUID(),f.observe())).rejects.toThrow('ownership');});
  it('claims only unowned bots and excludes the same bot across workers',async()=>{const f=await fixture();await storage.release(f.claim);await pool.query('UPDATE grid_bots SET last_tick_at=NULL');const result=await Promise.all([storage.claim(),storage.claim()]);expect(result.filter(Boolean)).toHaveLength(1);});
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
    expect(readFileSync(new URL('../../server/db.ts',import.meta.url),'utf8').replaceAll('\r\n','\n')).toContain(migrations[3].trim().replaceAll('\r\n','\n'));
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
    expect((await control.state(f.claim)).life).toMatchObject({epoch:'2',active_request:stop.id});
    expect((await pool.query('SELECT state FROM grid_control_requests WHERE id=$1',[pause.id])).rows[0].state).toBe('superseded');
    expect((await pool.query('SELECT evidence FROM grid_risk_events WHERE event_key=$1',[stop.id])).rows[0].evidence).toEqual({price:'80'});
    await expect(control.request(wallet,f.bot.id,randomUUID(),'resume')).rejects.toThrow('conflict');
    await expect(control.complete(f.claim,pause.id,'paused')).rejects.toThrow('conflict');
  });
  it('SOL warnings deduplicate by transition and unknown remains unknown',async()=>{
    const f=await landed(),control=new GridLifecycleStorage(storage);
    await control.sol(f.claim,{balance:'0.05',observedAt:Date.now()});await control.sol(f.claim,{balance:'0.05',observedAt:Date.now()});
    expect((await pool.query('SELECT count(*) AS n FROM grid_risk_events')).rows[0].n).toBe('1');
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
 it('qualified terminal failure crosses the breaker exactly once',async()=>{const f=await fixture();await pool.query('UPDATE grid_bots SET consecutive_failures=4');await launch.submit(f.op,f.claim.leaseToken);await launch.settle(f.op,{state:'failed',reason:'authentication',releaseSlot:true},f.claim.leaseToken);expect((await storage.snapshot(f.claim)).bot).toMatchObject({consecutive_failures:5,status:'pausing',pause_reason:'circuit_breaker'});await expect(launch.settle(f.op,{state:'failed',reason:'authentication',releaseSlot:true},f.claim.leaseToken)).rejects.toThrow();expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(5);});
 it('a newly proved healthy terminal fill resets the breaker but replay does not',async()=>{const f=await landed(),o=f.observe();o.orders[0].status='filled';o.orders[0].filledAmount='1';o.trades[0].size='1';o.position!.size='1';await pool.query('UPDATE grid_bots SET consecutive_failures=4');await storage.reconcile(f.claim,randomUUID(),o);expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(0);await pool.query('UPDATE grid_bots SET consecutive_failures=2');await storage.reconcile(f.claim,randomUUID(),o);expect((await storage.snapshot(f.claim)).bot.consecutive_failures).toBe(2);});
 it('wallet SOL incident survives another storage instance and closes on health',async()=>{const f=await landed(),a=new GridLifecycleStorage(storage),b=new GridLifecycleStorage(storage);await a.sol(f.claim,{balance:'0.049999999',observedAt:Date.now()});await b.sol(f.claim,{balance:'0.049999999',observedAt:Date.now()});expect((await pool.query('SELECT count(*) AS n FROM grid_risk_events')).rows[0].n).toBe('1');expect((await pool.query('SELECT * FROM grid_wallet_safety')).rows[0]).toMatchObject({execution_wallet:'EXAMPLE_MASTER',balance_lamports:'49999999',guard_state:'entry_blocked',policy_version:'1.0.0'});await b.sol(f.claim,{balance:'0.05',observedAt:Date.now()});await a.sol(f.claim,{balance:'0.049999999',observedAt:Date.now()});expect((await pool.query('SELECT count(*) AS n FROM grid_risk_events')).rows[0].n).toBe('2');await b.sol(f.claim,{balance:'0.1',observedAt:Date.now()});expect((await pool.query('SELECT incident_id FROM grid_wallet_safety')).rows[0].incident_id).toBeNull();});
});
