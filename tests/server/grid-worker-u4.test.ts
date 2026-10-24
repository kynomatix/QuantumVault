import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {publicSnapshot,healthStatus,snapshotFresh,type StatusMemory} from '../../server/grid-worker/status';
import {statusCache,statusHandler,workerHttp} from '../../server/grid-worker/http';
import {statusPage} from '../../server/grid-worker/status-page';
import {WorkerScheduler} from '../../server/grid-worker/scheduler';
import {MainQuota,mainAllocation,MAIN_AUTOSCALE_INSTANCE_CAP_ASSUMED} from '../../server/grid-worker/main-quota';
import {workerEnvironment} from '../../server/grid-worker/environment';
import {identityMatches} from '../../server/grid-worker/build-identity';
import {inventoryMismatch,reconciliationFresh} from '../../server/grid-worker/reconciliation';
import {OWNER_MASTER_PUBLIC_KEYS} from '../../server/grid-worker/owner-master-keys';
import {guardedWorkerFetch} from '../../server/grid-worker/egress';
import {workerFetch} from '../../server/grid-worker/transport';
import type {WorkerQuota,QuotaPolicy} from '../../server/grid-worker/quota';

const now=1_800_000_000_000;
const digest=createHash('sha256').update('EXAMPLE_U4').digest('hex');
const memory=():StatusMemory=>({standby:false,database:true,inControl:true,test:false,paused:false,critical:false,reconciled:true,
  renewalAt:now,passAt:now,botCheckTimes:[],waiting:0,running:0,commitHash:'EXAMPLE'});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('U4 public liveness',()=>{
  it('uses the oldest substantive evidence and rejects a replayed age of zero',()=>{
    const s=publicSnapshot({...memory(),botCheckTimes:[now-46000]},now);
    expect(s).toMatchObject({state:'offline',ageSeconds:46});expect(healthStatus(s)).toBe(503);
    expect(snapshotFresh({...s,ageSeconds:0,state:'running',reason:'running'},now)).toBe(false);
    expect(publicSnapshot({...memory(),botCheckTimes:[null]},now).state).toBe('offline');
    expect(publicSnapshot({...memory(),passAt:now+1},now).state).toBe('offline');
  });
  it('prioritizes offline, attention, test and running without claiming standby is healthy',()=>{
    for(const [patch,state] of [[{standby:true,critical:true},'offline'],[{critical:true,test:true},'attention'],[{test:true},'test'],[{},'running']] as const)
      expect(publicSnapshot({...memory(),...patch},now).state).toBe(state);
    expect(healthStatus(publicSnapshot({...memory(),critical:true},now))).toBe(503);
    expect(publicSnapshot({...memory(),renewalAt:null},now).snapshotAt).toBeNull();
  });
  it('expires cached bytes within one second without HTTP doing any work',()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const cache=statusCache(memory);
    try{expect(cache.read().status).toBe(200);vi.advanceTimersByTime(46000);expect(cache.read().status).toBe(503);}finally{cache.close();}
  });
  it.each(['/', '/healthz'])('HEAD matches GET status and headers on %s and reads only method/path',path=>{
    const cache=statusCache(()=>({...memory(),standby:true}),()=>now),poll=vi.fn();
    const run=(method:string,url=path)=>{
      const request=new Proxy({method,url},{get(target,key){if(key!=='method'&&key!=='url')throw Error('EXAMPLE_INPUT_READ');return target[key];}});
      const writeHead=vi.fn(),end=vi.fn();statusHandler(cache,poll)(request as IncomingMessage,{writeHead,end} as unknown as ServerResponse);
      return {head:writeHead.mock.calls[0],body:end.mock.calls[0][0]};
    };
    try{const get=run('GET'),head=run('HEAD');expect(head.head).toEqual(get.head);expect(head.body).toBeUndefined();expect(get.head[0]).toBe(path==='/'?200:503);
      for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','CONNECT','TRACE'])expect(run(method).head[0]).toBe(405);
      for(const url of ['/healthz?x=1','/?x=1','/healthz/','/metrics','/%68ealthz'])expect(run('GET',url).head[0]).toBe(404);
      expect(poll).toHaveBeenCalledTimes(path==='/healthz'?1:0);
      expect(get.head[1]['Content-Security-Policy']).toContain("default-src 'none'");
      expect(get.head[1]).toMatchObject({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex'});
    }finally{cache.close();}
  });
  it('caps connections and request time and renders only public values',()=>{
    const cache=statusCache(memory,()=>now),server=workerHttp(cache,()=>{});
    try{expect(server.maxConnections).toBe(32);expect(server.headersTimeout).toBe(5000);expect(server.requestTimeout).toBe(5000);
      const html=statusPage(publicSnapshot(memory(),now),now);expect(html).toContain('content="30"');expect(html).toContain('Grid Worker · QuantumVault');
      expect(html.match(/class="metric"/g)).toHaveLength(4);expect(html).toContain('<table class="metrics" role="presentation"><tbody><tr>');expect(html).not.toMatch(/example|mockup|preview|illustrative/i);expect(html).not.toContain('EXAMPLE');
    }finally{server.close();cache.close();}
  });
});
describe('U4 scheduler',()=>{
  it('serializes passes and admits at most one Start after existing work and reconciliation',async()=>{
    const order:string[]=[];let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
    const work={existing:vi.fn(async()=>{order.push('existing');await blocked;}),lifecycle:vi.fn(async()=>{order.push('lifecycle');}),
      reconcile:vi.fn(async()=>{order.push('reconcile');return true;}),startOne:vi.fn(async()=>{order.push('start');})};
    const scheduler=new WorkerScheduler(work,()=>true),first=scheduler.pass();expect(scheduler.pass()).toBe(first);release();await first;
    expect(order).toEqual(['existing','lifecycle','reconcile','start']);expect(work.startOne).toHaveBeenCalledOnce();await scheduler.stop();
  });
  it('shutdown aborts and drains existing work and closes admission permanently',async()=>{
    let drain!:()=>void;const drained=new Promise<void>(r=>drain=r),start=vi.fn(async()=>{});
    const scheduler=new WorkerScheduler({existing:async signal=>{await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));await drained;},
      lifecycle:async()=>{},reconcile:async()=>true,startOne:start},()=>true);
    const pass=scheduler.pass().catch(()=>{});let stopped=false;const stop=scheduler.stop().catch(()=>{}).then(()=>{stopped=true;});
    await Promise.resolve();expect(stopped).toBe(false);drain();await Promise.all([pass,stop]);await scheduler.pass();expect(start).not.toHaveBeenCalled();
  });
  it('incomplete reconciliation blocks Start',async()=>{
    const start=vi.fn(async()=>{}),scheduler=new WorkerScheduler({existing:async()=>{},lifecycle:async()=>{},reconcile:async()=>false,startOne:start},()=>true);
    await scheduler.pass();expect(start).not.toHaveBeenCalled();await scheduler.stop();
  });
});
describe('U4 MAIN quota allocation',()=>{
  const policy:QuotaPolicy={provider:'pacifica_rest',domain_id:'deployment',window_ms:60000,total_units:'100',worker_limit_units:'60',worker_protective_reserve_units:'10',policy_digest:digest,valid_until:new Date(now+120000)};
  it('documents the cap assumption for one, four and five machines',()=>{
    expect(MAIN_AUTOSCALE_INSTANCE_CAP_ASSUMED).toBe(4);
    for(const machines of [1,4])expect(mainAllocation(100,60)*machines+60).toBeLessThanOrEqual(100);
    expect(mainAllocation(100,60)*5+60).toBeGreaterThan(100);expect(mainAllocation(63,60)).toBe(0);
  });
  it('retains debits across refresh and policy outages, and enforces backoff',()=>{
    const q=new MainQuota();q.install([policy],now);q.debit('pacifica_rest',10,now);
    q.install([],now+1);expect(()=>q.debit('pacifica_rest',1,now+1)).toThrow();q.install([policy],now+2);
    expect(()=>q.debit('pacifica_rest',1,now+2)).toThrow();q.install([policy],now+60001);q.rateLimited('pacifica_rest',now+60001);
    expect(()=>q.debit('pacifica_rest',1,now+60001)).toThrow();
  });
  it('fails closed on stale, absent and below-one policies',()=>{
    const q=new MainQuota();expect(()=>q.debit('pacifica_rest',1,now)).toThrow();q.install([policy],now);
    expect(()=>q.debit('pacifica_rest',1,now+10000)).toThrow();q.install([{...policy,total_units:'63'}],now);expect(()=>q.debit('pacifica_rest',1,now)).toThrow();
  });
});
describe('U4 security and reconciliation boundaries',()=>{
  it('never reads unknown environment values and rejects forbidden names before reading values',()=>{
    const source:Record<string,string>={QV_PROCESS_ROLE:'grid-worker',REPLIT_DEPLOYMENT:'1',DATABASE_URL:'postgres://localhost/qvtest',SERVER_EXECUTION_KEY:digest};
    Object.defineProperty(source,'UNRELATED_SECRET',{enumerable:true,get(){throw Error('EXAMPLE_VALUE_READ');}});
    const log=vi.fn();expect(workerEnvironment(source,log).PORT).toBeUndefined();
    Object.defineProperty(source,'PGSERVICE',{enumerable:true,get(){throw Error('EXAMPLE_VALUE_READ');}});
    expect(()=>workerEnvironment(source,log)).toThrow('GRID_WORKER_SECRET_BOUNDARY');expect(log.mock.calls.flat().join(' ')).not.toContain(digest);
  });
  it('keeps owner keys empty and detects missing, unknown, duplicate and deleted inventory',()=>{
    expect(Object.isFrozen(OWNER_MASTER_PUBLIC_KEYS)).toBe(true);expect(OWNER_MASTER_PUBLIC_KEYS).toEqual([]);
    expect(inventoryMismatch(['EXAMPLE_A'],[])).toBe(true);expect(inventoryMismatch([],['EXAMPLE_A'])).toBe(true);
    expect(inventoryMismatch(['EXAMPLE_A','EXAMPLE_A'],['EXAMPLE_A'])).toBe(true);expect(inventoryMismatch(['EXAMPLE_A'],['EXAMPLE_A'])).toBe(false);
    expect(identityMatches({commit_hash:'EXAMPLE',tree_hash:'EXAMPLE',lockfile_sha256:digest})).toBe(false);
  });
  it('refuses an inexact signed inventory body without egress',async()=>{
    const fetcher=vi.fn<typeof fetch>();await expect(guardedWorkerFetch(fetcher,'https://api.pacifica.fi/api/v1/account/subaccount/list',{kind:'venue',method:'POST'},
      {method:'POST',body:JSON.stringify({account:'EXAMPLE',signature:'EXAMPLE',timestamp:now,expiry_window:1000,extra:true})})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
  it('debits before calls, backs off on 429, and never resends',async()=>{
    const debit=vi.fn(async()=>{}),rateLimited=vi.fn(async()=>{}),fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:429}));
    const run=workerFetch({debit,rateLimited} as unknown as WorkerQuota,fetcher);
    await expect(run('https://api.pacifica.fi/api/v1/info')).rejects.toThrow('GRID_QUOTA_BACKOFF');
    expect(debit.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);expect(rateLimited).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
    debit.mockRejectedValueOnce(Error('EXAMPLE_QUOTA'));await expect(run('https://api.pacifica.fi/api/v1/info')).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
  });
});


import type {PoolClient} from 'pg';
import {releaseTerminalReservation} from '../../server/grid-worker/requests';
import {fencedTransaction} from '../../server/grid-worker/transaction';
import {supersedeStartConsents} from '../../server/grid-worker/consent';
it('U4 local MAIN replacement waits a complete provider window',()=>{
  const q=new MainQuota(true),policy:QuotaPolicy={provider:'rpc_primary',domain_id:'deployment',window_ms:60000,total_units:'100',worker_limit_units:'60',worker_protective_reserve_units:'10',policy_digest:digest,valid_until:new Date(now+120000)};
  q.install([policy],now);expect(()=>q.debit('rpc_primary',1,now)).toThrow();
  q.install([policy],now+60000);expect(()=>q.debit('rpc_primary',1,now+60000)).not.toThrow();
});
it.each([{list:[]},{list:['EXAMPLE_A']},{list:['EXAMPLE_A','EXAMPLE_B']}])('U4 consent supersession binds one JSON list: %j',async ({list})=>{
  const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[],rowCount:0}));await supersedeStartConsents({query} as unknown as PoolClient,'EXAMPLE_OWNER',list,'stop');
  expect(query).toHaveBeenCalled();expect(query.mock.calls[0][1]).toContain(JSON.stringify(list));
});
it('U4 publishes transaction success only after COMMIT and rejects a lost commit response',async()=>{
  let commit!:()=>void,entered!:()=>void;const enteredCommit=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>commit=r);
  const client={processID:123,release:vi.fn(),query:vi.fn(async(text:string)=>{if(text==='COMMIT'){entered();await blocked;}return {rows:[]};})};
  let success=false;const run=fencedTransaction({connect:async()=>client as unknown as PoolClient},async()=>42,{mode:'none',terminate:async()=>{}}).then(v=>{success=true;return v;});
  await enteredCommit;expect(success).toBe(false);commit();expect(await run).toBe(42);
  client.query.mockImplementation(async(text:string)=>{if(text==='COMMIT')throw Error('EXAMPLE_LOST_COMMIT');return {rows:[]};});
  await expect(fencedTransaction({connect:async()=>client as unknown as PoolClient},async()=>42,{mode:'none',terminate:async()=>{}})).rejects.toThrow('EXAMPLE_LOST_COMMIT');
});
it('U4 terminal release needs fresh terminal proof; timeout/restart alone never releases',async()=>{
  const holder={bootId:'EXAMPLE_BOOT',epoch:'1'},request={owner_wallet:'EXAMPLE_OWNER',bot_id:'00000000-0000-4000-8000-000000000004'};
  const terminal={status:'stopped',account:'EXAMPLE_ACCOUNT',master_account:'EXAMPLE_MASTER',released_at:new Date(now),pool_status:'spare',pool_bot:null,
    wallet_address:'EXAMPLE_OWNER',agent_public_key:'EXAMPLE_MASTER',last_verified_empty_at:new Date(now),unresolved:false,claimed:false,
    terminal_proof:{state:'empty',account:'EXAMPLE_ACCOUNT',masterAccount:'EXAMPLE_MASTER',observedAt:now,expiresAt:now+1000},
    observation:{inventoryComplete:true,account:'EXAMPLE_ACCOUNT',orders:[],position:{size:'0'}},reconciled_at:new Date(now)};
  let released=false;
  const query=vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT owner_wallet')||sql.startsWith('SELECT * FROM grid_worker_requests'))return {rows:[request],rowCount:1};
    if(sql.includes('FROM grid_worker_host WHERE'))return {rows:[{execution_mode:'external',holder_live:true,holder_role:'grid-worker',holder_boot_id:holder.bootId,fencing_epoch:'1',db_now:new Date(now)}],rowCount:1};
    if(sql.includes('l.terminal_proof'))return {rows:[terminal],rowCount:1};
    if(sql.startsWith('UPDATE grid_worker_reservations')){released=true;return {rows:[request],rowCount:1};}
    return {rows:[],rowCount:0};
  });
  const c={query} as unknown as PoolClient;
  terminal.unresolved=true;await expect(releaseTerminalReservation(c,'EXAMPLE_REQUEST',holder)).rejects.toThrow();expect(released).toBe(false);
  terminal.unresolved=false;terminal.terminal_proof.observedAt=now-6000;await expect(releaseTerminalReservation(c,'EXAMPLE_REQUEST',holder)).rejects.toThrow();expect(released).toBe(false);
  terminal.terminal_proof.observedAt=now;expect(await releaseTerminalReservation(c,'EXAMPLE_REQUEST',holder)).toMatch(/^[a-f0-9]{64}$/);expect(released).toBe(true);
});

import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {mainMoneySuppressed} from '../../server/grid-worker/main-runtime';
it('U4 MAIN suppression is opt-in and defaults to the legacy behavior',()=>{
  vi.stubEnv('GRID_REMOTE_WORKER_ENABLED',undefined);expect(mainMoneySuppressed()).toBe(false);
  vi.stubEnv('GRID_REMOTE_WORKER_ENABLED','false');expect(mainMoneySuppressed()).toBe(false);
  vi.stubEnv('GRID_REMOTE_WORKER_ENABLED','true');expect(mainMoneySuppressed()).toBe(true);
});
it('U4 stale cursors and partial or foreign observations cannot refresh durable coverage',()=>{
  const account={account:'EXAMPLE_ACCOUNT',master_account:'EXAMPLE_MASTER',bot_id:'EXAMPLE_BOT',wallet_address:'EXAMPLE_OWNER',market:'BTC-PERP',created_at:new Date(now-300000)};
  const observation:GridObservation={account:account.account,symbol:'BTC',observedAt:now,inventoryComplete:true,position:null,orders:[],trades:[],mark:null,
    history:{from:now-300000,through:now-120000,inclusive:true,publicationLagMs:120000,source:'EXAMPLE',lastId:'1'}};
  expect(reconciliationFresh(observation,account,now)).toBe(true);
  expect(reconciliationFresh({...observation,inventoryComplete:false},account,now)).toBe(false);
  expect(reconciliationFresh({...observation,account:'EXAMPLE_FOREIGN'},account,now)).toBe(false);
  expect(reconciliationFresh({...observation,observedAt:now-5000},account,now)).toBe(false);
  expect(reconciliationFresh({...observation,history:{...observation.history!,through:now-125000}},account,now)).toBe(false);
  expect(reconciliationFresh({...observation,history:{...observation.history!,from:now-200000}},account,now)).toBe(false);
});
