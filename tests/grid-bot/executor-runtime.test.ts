import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {gridExecutorRuntime} from '../../server/grid-bot/executor-runtime';
import {GridLaunchTransientError,requestDigest,type ExactGridRequest,type DurableGridOperation,type GridClaim} from '../../server/grid-bot/launch-storage';
import type {GridSendResult,GridSettlementOutcome} from '../../server/grid-bot/execution-failure';
import type {GridMonitorStorage} from '../../server/grid-bot/monitor-storage';
import type {GridMonitorReads} from '../../server/grid-bot/monitor-reads';
import type {GridLaunchReads} from '../../server/grid-bot/launch-reads';
import type {GridObservation,ReconciliationOperation} from '../../server/grid-bot/reconciliation';
import type {GridVenueOrder} from '../../server/grid-bot/order-identity';
import type {LaunchFacts} from '../../server/grid-bot/provision';
import type {GridResumeRisk} from '../../server/grid-bot/lifecycle-service';
import {gridWalletEntryGate} from '../../server/grid-bot/runtime-policy';
import {launchAuthorityFixture,retainedFixture,clock,umk} from './launch-authority-fixtures';

const hooks=vi.hoisted(()=>({collect:vi.fn(),observe:vi.fn(),unlock:vi.fn(),durable:vi.fn(),send:vi.fn(),recover:vi.fn(),reserve:vi.fn(),secret:vi.fn(),
  lifecycleTick:vi.fn(),lifecycleState:vi.fn(),confirmCreated:vi.fn(),confirmReused:vi.fn()}));
vi.mock('../../server/grid-bot/service',()=>({durableGridUmk:hooks.durable}));
vi.mock('../../server/grid-bot/launch-authority',async (importOriginal)=>({...await importOriginal<typeof import('../../server/grid-bot/launch-authority')>(),
  productionGridLaunchAuthority:()=>({collect:hooks.collect,observe:hooks.observe}),unlockGridLaunchAgent:hooks.unlock,gridProductionResume:vi.fn()}));
vi.mock('../../server/grid-bot/lifecycle-runtime',()=>({gridLifecycleRuntime:()=>({service:{tick:hooks.lifecycleTick},lifecycle:{state:hooks.lifecycleState}})}));
vi.mock('../../server/grid-bot/custody',async (importOriginal)=>({...await importOriginal<typeof import('../../server/grid-bot/custody')>(),
  GridCustody:class {recover=hooks.recover;reserve=hooks.reserve;withSecret=hooks.secret;confirmCreated=hooks.confirmCreated;confirmReused=hooks.confirmReused;}}));
vi.mock('../../server/grid-bot/execution',async (importOriginal)=>({...await importOriginal<typeof import('../../server/grid-bot/execution')>(),
  GridPacificaSender:class {send=hooks.send;}}));

beforeEach(()=>{vi.resetAllMocks();vi.spyOn(Date,'now').mockReturnValue(clock);});
afterEach(()=>vi.restoreAllMocks());

async function fixture(){
  const source=launchAuthorityFixture(),retained=retainedFixture(source),account=source.account;
  const facts=await source.authority.observe(account.wallet,source.policy,account,umk());
  const bot={...retained.bot,status:'canary',created_at:new Date(clock-10000)},levels=retained.levels.map(l=>({...l,id:'EXAMPLE_LEVEL_'+l.ordinal,
    size:l.size,exact_size:l.size,placement_attempt:0,status:'pending',venue_order_id:null as string|null}));
  const operations:ReconciliationOperation[]=[],journal:string[]=[],keys:{cleanup:ReturnType<typeof vi.fn>}[]=[],agents:{cleanup:ReturnType<typeof vi.fn>;current:ReturnType<typeof vi.fn>;signingKey:Uint8Array}[]=[];
  const observation:GridObservation={account:account.account,symbol:'BTC',observedAt:clock,orders:[],trades:[],position:{direction:'long',size:'0'},inventoryComplete:true,
    history:{from:clock-10000,through:clock,publicationLagMs:0,inclusive:true,source:'EXAMPLE_HISTORY'},mark:{price:'100',observedAt:clock}};
  const risk:GridResumeRisk={account:account.account,symbol:'BTC',positionSize:'0',liquidationPrice:null,observedAt:clock,source:'EXAMPLE_RISK'};
  const state={epoch:'7',entries:true,complete:true,planningEntries:true,generation:'1',created:true,agentVersion:1,agentCurrent:true,afterAgent:true,
    afterPrepare:undefined as ((r:ExactGridRequest)=>void)|undefined,afterPlan:undefined as (()=>void)|undefined};
  const planning={observation,levels,fills:[] as {tradeId:string;operationId:string;orderId:string;levelId:string|null;time:number;leg:'entry'|'exit';size:string;price:string;fee:string}[],
    reserved:[],entriesAllowed:true,authority:{monitorBootId:'EXAMPLE_BOOT',monitorGeneration:'1',lifecycleEpoch:'7'}};
  const map=new Map<string,ReconciliationOperation>();
  const ledger={read:vi.fn(async(_bot:string,key:string)=>map.get(key)??null),
    prepare:vi.fn(async(key:string,r:ExactGridRequest,_claim:GridClaim)=>{journal.push('prepare:'+r.kind);
      const op:ReconciliationOperation={id:'EXAMPLE_OPERATION_'+operations.length,state:'prepared',submitted_at:null,exact_request:structuredClone(r),exact_request_digest:requestDigest(r),
        failure_classification:null,level_id:typeof r.authority.levelId==='string'?r.authority.levelId:null,venue_order_id:null};
      map.set(key,op);operations.push(op);state.afterPrepare?.(op.exact_request);return op;}),
    submit:vi.fn(async(op:DurableGridOperation)=>{journal.push('submit:'+op.exact_request.kind);op.state='submitted';op.submitted_at=new Date(clock);return true;}),
    settle:vi.fn(async(op:DurableGridOperation,outcome:GridSettlementOutcome)=>{journal.push('settle:'+op.exact_request.kind);
      const retained=operations.find(o=>o.id===op.id)??op;retained.state=outcome.state;retained.failure_classification=outcome.reason;}),
    expirePrepared:vi.fn(async(op:DurableGridOperation)=>{journal.push('expire:'+op.exact_request.kind);
      if(op.state!=='prepared'||op.submitted_at!==null||op.exact_request.timestamp+op.exact_request.expiryMs>clock)return false;
      op.state='failed';op.failure_classification='policy';return true;}),
    transaction:vi.fn(async<T>(work:(c:{query:(sql:string)=>Promise<{rows:typeof bot[];rowCount:number}>})=>Promise<T>)=>work({query:async()=>({rows:[bot],rowCount:1})})),
    pilotExposure:vi.fn(async()=>({limitUsd:'250',exposureUsd:'0'})),markCanary:vi.fn(async()=>{bot.status='canary';})};
  const storage={launch:ledger,snapshot:vi.fn(async()=>({bot,levels,operations})),assertLease:vi.fn(async()=>({...bot,db_now:new Date(clock)})),
    block:vi.fn(async()=>{}),reconcile:vi.fn(async()=>({entriesAllowed:state.entries,reconciliationComplete:state.complete,reasons:state.entries?[]:['sol_entry_gate']})),
    planningState:vi.fn(async()=>{const result={...planning,entriesAllowed:state.planningEntries,authority:{...planning.authority,monitorGeneration:state.generation}};state.afterPlan?.();return result;}),
    authorizeProvisioning:vi.fn(async()=>{}),provisioningDenied:vi.fn(async()=>{}),release:vi.fn(async()=>{})};
  const reads={observe:vi.fn(async()=>observation)};
  const emptyAccount={account:account.account,updated_at:clock,balance:'0',available_to_withdraw:'0',account_equity:'0',available_to_spend:'0',pending_balance:'0',pending_interest:'0',
    spot_collateral:'0',spot_market_value:'0',total_margin_used:'0',positions_count:0,orders_count:0,stop_orders_count:0,spot_balances:[]};
  const json={subaccounts:vi.fn(async()=>({success:true,error:null,data:{subaccounts:state.created?[{address:account.account}]:[]}})),
    json:vi.fn(async(_master:string,path:string)=>({success:true,error:null,data:path==='/account/settings'?{margin_settings:[{symbol:'BTC',isolated:false,leverage:source.policy.leverage}]}:emptyAccount}))};
  hooks.collect.mockImplementation(async()=>({facts,risk}));
  hooks.observe.mockImplementation(async(_wallet:string,_policy:unknown,a:typeof account|null)=>source.authority.observe(account.wallet,source.policy,a,umk()));
  hooks.recover.mockResolvedValue(account);hooks.reserve.mockResolvedValue(account);
  hooks.durable.mockImplementation(async()=>{const key={umk:umk(),cleanup:vi.fn()};keys.push(key);return key;});
  hooks.unlock.mockImplementation(async()=>{let calls=0;const signingKey=new Uint8Array(80).fill(7).subarray(8,72);
    const agent={masterAccount:account.masterAccount,umkVersion:state.agentVersion,signingKey,
      current:vi.fn(async()=>++calls===1?state.agentCurrent:state.afterAgent),cleanup:vi.fn(()=>{signingKey.fill(0);})};agents.push(agent);return agent;});
  const subSecret=Buffer.alloc(64,8);
  hooks.secret.mockImplementation(async(_a:unknown,_umk:Buffer,work:(material:Buffer)=>Promise<unknown>)=>work(subSecret));
  const order=(r:ExactGridRequest,status:GridVenueOrder['status']='open'):GridVenueOrder=>({orderId:'EXAMPLE_ORDER',clientOrderId:String(r.data.client_order_id),symbol:'BTC',
    side:r.data.side==='bid'?'long':'short',reduceOnly:r.data.reduce_only===true,orderType:r.kind==='seed'?'market':'limit',price:String(r.data.price??'100'),amount:String(r.data.amount),
    filledAmount:status==='filled'?String(r.data.amount):'0',cancelledAmount:'0',status,createdAt:r.timestamp,updatedAt:clock,reason:null});
  hooks.send.mockImplementation(async(r:ExactGridRequest):Promise<GridSendResult>=>{journal.push('send:'+r.kind);
    if(r.kind==='create')state.created=true;
    if(r.kind==='limit'||r.kind==='seed')observation.orders=[order(r)];
    if(r.kind==='cancel')observation.orders=observation.orders.map(o=>o.orderId===r.data.order_id?{...o,status:'cancelled',cancelledAmount:o.amount}:o);
    return {rateLimited:false,...(r.kind==='fund'?{terminalTransferDigest:requestDigest(r)}:{})};});
  const claim={id:account.botId,account:account.account,masterAccount:account.masterAccount,leaseToken:account.leaseToken},signal=new AbortController().signal;
  hooks.lifecycleTick.mockImplementation(async()=>{journal.push('lifecycle');return 'idle';});
  hooks.lifecycleState.mockImplementation(async()=>({bot,life:bot.status==='provisioning'?null:{epoch:state.epoch}}));
  // Concrete storage classes own private members; this facade implements only the runtime's I/O surface.
  const runtime=gridExecutorRuntime(storage as unknown as GridMonitorStorage,reads as unknown as GridMonitorReads,json as unknown as GridLaunchReads);
  return {source,account,facts,bot,levels,operations,journal,keys,agents,observation,risk,state,planning,map,ledger,storage,reads,json,order,subSecret,claim,signal,runtime,
    tick:()=>runtime.tick(claim,signal),provision:()=>{bot.status='provisioning';return runtime.tick(claim,signal);}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

describe('C6 production runtime final send authority',()=>{
  it.each(['active','canary','provisioning'])('allows the %s status at the final gate',async status=>{
    const f=await fixture();f.state.afterPrepare=()=>{f.bot.status=status;};await f.tick();expect(hooks.send).toHaveBeenCalledOnce();
    expect(f.journal).toContain('submit:limit');expect(f.journal.indexOf('prepare:limit')).toBeLessThan(f.journal.indexOf('submit:limit'));
    expect(f.journal.indexOf('submit:limit')).toBeLessThan(f.journal.indexOf('send:limit'));
  });
  const denials:[string,(f:Fixture,r:ExactGridRequest)=>void][]=[
    ...['draft','paused','pausing','stopping','stopped','resuming','reconciling','range_exhausted'].map(status=>[status,(f:Fixture)=>{f.bot.status=status;}] as [string,(f:Fixture,r:ExactGridRequest)=>void]),
    ['Stop epoch changes after prepare',f=>{f.state.epoch='8';}],
    ['policy signature changes',f=>{f.bot.policy_hmac='EXAMPLE_CHANGED';}],
    ['request policy binding',(_f,r)=>{r.authority.policyHmac='EXAMPLE_CHANGED';}],
    ['account identity',(_f,r)=>{r.account='EXAMPLE_OTHER';}],['master identity',(_f,r)=>{r.masterAccount='EXAMPLE_OTHER';}],
    ['missing facts',(_f,r)=>{delete r.authority.facts;}],
    ['market identity',(_f,r)=>{(r.authority.facts as LaunchFacts).market='ETH-PERP';}],
    ['facts master identity',(_f,r)=>{(r.authority.facts as LaunchFacts).masterAccount='EXAMPLE_OTHER';}],
    ['facts account identity',(_f,r)=>{(r.authority.facts as LaunchFacts).account='EXAMPLE_OTHER';}],
    ['future facts',(_f,r)=>{(r.authority.facts as LaunchFacts).observedAt=clock+1;}],
    ['stale facts boundary',(_f,r)=>{(r.authority.facts as LaunchFacts).observedAt=clock-5000;}],
    ['expired facts boundary',(_f,r)=>{(r.authority.facts as LaunchFacts).expiresAt=clock;}],
    ['generation wallet binding',(_f,r)=>{(r.authority.facts as LaunchFacts).agentGeneration.wallet='EXAMPLE_OTHER';}],
    ['generation master binding',(_f,r)=>{(r.authority.facts as LaunchFacts).agentGeneration.masterAccount='EXAMPLE_OTHER';}],
    ['invalid generation version',(_f,r)=>{(r.authority.facts as LaunchFacts).agentGeneration.umkVersion=0;}],
    ['missing generation',(_f,r)=>{Reflect.deleteProperty((r.authority.facts as LaunchFacts),'agentGeneration');}],
    ['margin account identity',(_f,r)=>{(r.authority.facts as LaunchFacts).margin.account='EXAMPLE_OTHER';}],
    ['margin symbol identity',(_f,r)=>{(r.authority.facts as LaunchFacts).margin.symbol='ETH';}],
    ['margin observation stale',(_f,r)=>{(r.authority.facts as LaunchFacts).margin.observedAt=clock-5000;}],
    ['margin account stale',(_f,r)=>{(r.authority.facts as LaunchFacts).margin.accountUpdatedAt=clock-5000;}],
    ['margin future',(_f,r)=>{(r.authority.facts as LaunchFacts).margin.observedAt=clock+1;}],
    ['leverage mismatch',(_f,r)=>{(r.authority.facts as LaunchFacts).margin.leverage='3';}],
    ['missing level authority',(_f,r)=>{delete r.authority.prepared;}],
    ['changed level payload',(_f,r)=>{r.data.amount='99';}],
    ['price below current bounds',(_f,r)=>{(r.authority.facts as LaunchFacts).minimumPrice='1000';}],
    ['price above current bounds',(_f,r)=>{(r.authority.facts as LaunchFacts).maximumPrice='1';}],
    ['notional below current bounds',(_f,r)=>{(r.authority.facts as LaunchFacts).minimumQuote='1000';}],
    ['notional above current bounds',(_f,r)=>{(r.authority.facts as LaunchFacts).maximumQuote='0.01';}],
  ];
  it.each(denials)('denies %s immediately before submit',async(_name,change)=>{
    const f=await fixture();f.state.afterPrepare=r=>change(f,r);await f.tick();
    expect(f.ledger.prepare).toHaveBeenCalledOnce();expect(f.ledger.submit).not.toHaveBeenCalled();expect(hooks.send).not.toHaveBeenCalled();
  });
});

describe('C6 runtime signing and provisioning',()=>{
  it('expires an unsent create, observes signed absence and provisions exactly once on a fresh key',async()=>{
    const f=await fixture();f.state.created=false;
    const request:ExactGridRequest={kind:'create',botId:f.claim.id,account:f.claim.account,masterAccount:f.claim.masterAccount,path:'/account/subaccount/create',
      operationType:'subaccount_confirm',timestamp:clock-6000,expiryMs:5000,data:{},authority:{facts:{...f.facts,observedAt:clock-6000,expiresAt:clock-1000}}};
    const op:ReconciliationOperation={id:'EXAMPLE_EXPIRED_CREATE',state:'prepared',submitted_at:null,failure_classification:null,exact_request:request,
      exact_request_digest:requestDigest(request),level_id:null,venue_order_id:null};
    const retainedDigest=op.exact_request_digest;f.operations.push(op);f.map.set(`grid:${f.claim.id}:launch:create`,op);
    await f.provision();await f.tick();
    expect(op).toMatchObject({state:'failed',submitted_at:null,exact_request_digest:retainedDigest,exact_request:request});
    expect(hooks.observe.mock.calls[0][2]).toBeNull();expect(f.storage.authorizeProvisioning).toHaveBeenCalledOnce();
    expect(hooks.send.mock.calls.map(call=>(call[0] as ExactGridRequest).kind)).toEqual(['create','fund','leverage','limit','limit']);
    // The second tick may roll one new level, but must never repeat provisioning.
    expect(f.map.get(`grid:${f.claim.id}:launch:create:retry:${op.id}`)?.state).toBe('confirmed');
    expect(f.journal[0]).toBe('expire:create');expect(f.ledger.markCanary).toHaveBeenCalledOnce();
  });
  it('scopes master signing to create/fund and checks/cleans each durable generation',async()=>{
    const f=await fixture();f.state.created=false;await f.provision();
    expect(hooks.send.mock.calls.map(call=>(call[0] as ExactGridRequest).kind)).toEqual(['create','fund','leverage','limit']);
    for(const [r,sub,master,lease] of hooks.send.mock.calls as [ExactGridRequest,Buffer,Uint8Array|undefined,string][]){
      expect(sub).toBe(f.subSecret);expect(lease).toBe(f.account.leaseToken);
      if(['create','fund'].includes(r.kind))expect(Buffer.isBuffer(master)).toBe(true);else expect(master).toBeUndefined();
    }
    expect(f.agents.every(a=>a.current.mock.calls.length===2&&a.cleanup.mock.calls.length===1)).toBe(true);
    expect(f.keys.every(k=>k.cleanup.mock.calls.length===1)).toBe(true);
    expect(f.storage.authorizeProvisioning).toHaveBeenCalledOnce();
    expect(hooks.lifecycleTick.mock.calls.length).toBeGreaterThan(1);expect(f.storage.reconcile.mock.calls.length).toBeGreaterThan(1);
  });
  it('uses the storage-advanced first-level attempt after an unsent expiry',async()=>{
    const f=await fixture();f.state.created=false;for(const level of f.levels)level.placement_attempt=1;
    await f.provision();const entry=hooks.send.mock.calls.map(call=>call[0] as ExactGridRequest).find(r=>r.kind==='limit');
    expect(entry?.authority.levelAttempt).toBe(1);expect(f.bot.status).toBe('canary');expect(f.ledger.markCanary).toHaveBeenCalledOnce();
  });
  it.each([['create','success'],['create','failure'],['fund','success'],['fund','failure']] as const)(
    'zeroes the shared %s signing bytes after send %s',async(kind,outcome)=>{
      const f=await fixture();f.state.created=false;const originalSend=hooks.send.getMockImplementation()!;
      const sent:{key:Buffer|undefined;agent:Fixture['agents'][number];live:boolean;cleanups:number}[]=[];
      hooks.send.mockImplementation(async(r:ExactGridRequest,_sub:Buffer,master:Buffer|undefined):Promise<GridSendResult>=>{
        if(r.kind===kind){const agent=f.agents[f.agents.length-1];
          sent.push({key:master,agent,live:master?.every((byte)=>byte===7)??false,cleanups:agent.cleanup.mock.calls.length});
          if(outcome==='failure')throw Error('EXAMPLE transport lost');
        }
        return originalSend(r);
      });
      await f.provision();expect(sent).toHaveLength(1);const {key,agent,live,cleanups}=sent[0];
      expect(Buffer.isBuffer(key)).toBe(true);expect(agent.signingKey.byteOffset).toBe(8);
      expect(key!.buffer).toBe(agent.signingKey.buffer);expect(key!.byteOffset).toBe(agent.signingKey.byteOffset);
      expect(key!.byteLength).toBe(agent.signingKey.byteLength);expect(live).toBe(true);expect(cleanups).toBe(0);
      expect(agent.cleanup).toHaveBeenCalledOnce();expect(agent.signingKey.every((byte)=>byte===0)).toBe(true);
      expect(key!.every((byte)=>byte===0)).toBe(true);
      expect(f.operations.find(op=>op.exact_request.kind===kind)?.state).toBe(outcome==='success'?'confirmed':'unconfirmed');
    });
  it.each(['version','before','after','master','unlock throws','send throws'] as const)('cleans signing scope on %s generation failure',async defect=>{
    const f=await fixture();if(defect==='version')f.state.agentVersion=2;if(defect==='before')f.state.agentCurrent=false;if(defect==='after')f.state.afterAgent=false;
    const wrongMasterCleanup=vi.fn();
    if(defect==='master')hooks.unlock.mockResolvedValue({masterAccount:'EXAMPLE_OTHER',umkVersion:1,signingKey:Buffer.alloc(64,7),current:vi.fn(async()=>true),cleanup:wrongMasterCleanup});
    if(defect==='unlock throws')hooks.unlock.mockRejectedValue(Error('EXAMPLE unlock failed'));
    if(defect==='send throws')hooks.send.mockRejectedValue(Error('EXAMPLE transport lost'));
    await f.tick();expect(f.keys.every(k=>k.cleanup.mock.calls.length===1)).toBe(true);expect(f.agents.every(a=>a.cleanup.mock.calls.length===1)).toBe(true);
    if(['version','before','master','unlock throws'].includes(defect))expect(hooks.send).not.toHaveBeenCalled();else expect(hooks.send).toHaveBeenCalledOnce();
    expect(f.operations[0].state).toBe(defect==='after'?'confirmed':'unconfirmed');
    if(defect==='master')expect(wrongMasterCleanup).toHaveBeenCalledOnce();
  });
  it.each(['stop','reconciliation'] as const)('beforeStep stops progression on %s',async denial=>{
    const f=await fixture();f.state.created=false;
    hooks.send.mockImplementation(async(r:ExactGridRequest)=>{if(r.kind==='create'){f.state.created=true;if(denial==='stop')f.bot.status='stopping';else f.state.entries=false;}return {rateLimited:false};});
    await f.provision();expect(hooks.send.mock.calls.map(call=>(call[0] as ExactGridRequest).kind)).toEqual(['create']);
    expect(f.ledger.markCanary).not.toHaveBeenCalled();
  });
  it('surfaces a terminal provisioning denial while retaining custody',async()=>{
    const f=await fixture();f.state.created=false;
    hooks.send.mockImplementation(async(r:ExactGridRequest)=>({rateLimited:false,terminalFailure:{requestDigest:requestDigest(r),classification:'authentication'}}));
    await f.provision();expect(f.storage.provisioningDenied).toHaveBeenCalledWith(f.claim,expect.stringContaining('custody remains retained'));
    expect(f.bot.status).toBe('provisioning');expect(f.ledger.markCanary).not.toHaveBeenCalled();
  });
});

describe('C6 runtime recovery and rolling',()=>{
  it('expires prepared operations before settlement, retains filled limit risk, and never infers a transfer',async()=>{
    const f=await fixture();await f.tick();const limit=f.operations[0];limit.state='unconfirmed';
    f.observation.orders=[f.order(limit.exact_request,'filled')];
    const create:ExactGridRequest={...limit.exact_request,kind:'create',path:'/account/subaccount/create',operationType:'subaccount_confirm',timestamp:clock-6000,data:{}};
    const expired:ReconciliationOperation={...limit,id:'EXAMPLE_EXPIRED',state:'prepared',submitted_at:null,exact_request:create,exact_request_digest:requestDigest(create)};
    const fund:ExactGridRequest={...create,kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',data:{to_account:f.account.account,amount:'100'}};
    const pending:ReconciliationOperation={...expired,id:'EXAMPLE_FUND',state:'unconfirmed',submitted_at:new Date(clock-6000),exact_request:fund,exact_request_digest:requestDigest(fund)};
    f.operations.splice(0,f.operations.length,expired,limit,pending);f.journal.length=0;f.ledger.settle.mockClear();hooks.send.mockClear();
    hooks.lifecycleTick.mockImplementation(async()=>{f.journal.push('lifecycle');return 'stopped';});await f.tick();
    expect(f.journal).toEqual(['expire:create','settle:limit','lifecycle']);expect(hooks.send).not.toHaveBeenCalled();
    expect(f.ledger.settle).toHaveBeenCalledWith(limit,expect.objectContaining({state:'confirmed',releaseSlot:false}),f.account.leaseToken);
    expect(pending.state).toBe('unconfirmed');
  });
  it('rejects a corrupt prepared digest before expiry or lifecycle work',async()=>{
    const f=await fixture();await f.tick();f.operations[0].state='prepared';f.operations[0].exact_request_digest='EXAMPLE_CHANGED';
    f.ledger.expirePrepared.mockClear();hooks.lifecycleTick.mockClear();await expect(f.tick()).rejects.toThrow('prepared identity');
    expect(f.ledger.expirePrepared).not.toHaveBeenCalled();expect(hooks.lifecycleTick).not.toHaveBeenCalled();
  });
  it('executes only one planned action in a generation',async()=>{
    const f=await fixture();await f.tick();expect(hooks.send).toHaveBeenCalledOnce();expect(f.operations).toHaveLength(1);
    expect(f.ledger.prepare.mock.calls[0][2]).toMatchObject({credits:'10',slots:1});
  });
  it('rejects a generation changed between planning and execution',async()=>{
    const f=await fixture();let reads=0;f.state.afterPlan=()=>{if(++reads===2)f.state.generation='2';};
    await expect(f.tick()).rejects.toBeInstanceOf(GridLaunchTransientError);expect(f.ledger.prepare).not.toHaveBeenCalled();expect(hooks.send).not.toHaveBeenCalled();
  });
  it('reconstructs a cancel solely from its exact owned source',async()=>{
    const f=await fixture();await f.tick();const original=f.operations[0],request=original.exact_request;
    original.venue_order_id='EXAMPLE_ORDER';f.state.entries=false;f.state.planningEntries=false;hooks.send.mockClear();await f.tick();
    expect(hooks.send).toHaveBeenCalledOnce();const cancel=hooks.send.mock.calls[0][0] as ExactGridRequest;
    expect(cancel).toMatchObject({kind:'cancel',data:{symbol:'BTC',order_id:'EXAMPLE_ORDER'},authority:{levelId:original.level_id,originalRequest:request}});
    expect(f.ledger.prepare.mock.calls.at(-1)?.[2]).toMatchObject({slots:0,canaryIncrement:'0'});
  });
  it.each([false,true])('SOL entry denial with complete reconciliation keeps backed reductions (backing=%s)',async backing=>{
    const f=await fixture();expect(gridWalletEntryGate('0').entryAllowed).toBe(false);
    f.state.entries=false;f.state.planningEntries=true; // Even a later permissive plan cannot erase this tick's monitor decision.
    if(backing){const source=f.levels.find(l=>!l.reduce_only);if(!source)throw Error('EXAMPLE entry source missing');source.status='filled';
      f.observation.position!.size='0.1';f.risk.positionSize='0.1';f.risk.liquidationPrice='1';
      f.planning.fills.push({tradeId:'EXAMPLE_TRADE',operationId:'EXAMPLE_ENTRY',orderId:'EXAMPLE_ORDER',levelId:source.id,time:clock-1000,leg:'entry',size:'0.1',price:source.price,fee:'0'});}
    await f.tick();
    if(backing){expect(hooks.send).toHaveBeenCalledOnce();expect(hooks.send.mock.calls[0][0]).toMatchObject({kind:'limit',data:{reduce_only:true}});
      expect(f.ledger.prepare.mock.calls[0][2].canaryIncrement).toBe('0');}
    else {expect(hooks.send).not.toHaveBeenCalled();expect(f.ledger.prepare).not.toHaveBeenCalled();}
  });
});
