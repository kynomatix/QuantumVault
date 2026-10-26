import bs58 from 'bs58';
import {MAIN_QUOTA_GUARD_LOCK_NAMESPACE} from '../../server/wallet-lock-constants';
import nacl from 'tweetnacl';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomInt,randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {MainQuotaGuard,installMainQuotaGuard} from '../../server/grid-worker/main-quota-guard';
import {MainQuota,mainAllocation,mainQuota} from '../../server/grid-worker/main-quota';
import {WorkerQuota,type QuotaPolicy} from '../../server/grid-worker/quota';
import {workerFetch} from '../../server/grid-worker/transport';
import {GridLaunchReads} from '../../server/grid-bot/launch-reads';
import {PacificaTransportAuthority} from '../../server/protocol/pacifica/pacifica-transport';
import {ObservedPacificaQuota} from '../../server/protocol/pacifica/pacifica-observed-quota';
import {beforeMainRequest,installRequestBudget,withinRequestBurst,consumeRequestBurst,assertRequestBurstCurrent} from '../../server/grid-worker/request-budget';
import {installMainQuotaAccounts} from '../../server/grid-worker/main-quota-scope';
import {GridLaunchAuthority} from '../../server/grid-bot/launch-authority-core';
import {launchAuthorityFixture,clock,umk} from '../grid-bot/launch-authority-fixtures';
import {providerRequestCost,providerCredits,latchProviderEndpoint} from '../../server/grid-bot/provider-request-cost';

vi.mock('../../server/grid-worker/owner-master-keys',()=>({OWNER_MASTER_PUBLIC_KEYS:['EXAMPLE_MASTER']}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();installMainQuotaAccounts([]);});
const schema='u7c_'+randomUUID().replaceAll('-',''),namespace=randomInt(1000000,2000000000);
let admin:Pool,pool:Pool;
const guards:MainQuotaGuard[]=[];
const policy:QuotaPolicy={provider:'pacifica_rest',domain_id:'deployment',window_ms:60000,total_units:'1000',worker_limit_units:'500',worker_protective_reserve_units:'120',policy_digest:createHash('sha256').update('EXAMPLE_POLICY').digest('hex'),valid_until:new Date(Date.now()+3600000)};
beforeAll(async()=>{
  const connectionString=process.env.DATABASE_URL;
  if(!connectionString||new URL(connectionString).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
  admin=new Pool({connectionString,max:2});await admin.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString,max:8,options:'-c search_path='+schema+',public,pg_catalog',query_timeout:2000});
  pool.on('connect',c=>{c.on('error',()=>{});c.query=new Proxy(c.query,{apply(fn,self,args){
    if(Array.isArray(args[1]))args[1]=args[1].map((v:unknown)=>v===MAIN_QUOTA_GUARD_LOCK_NAMESPACE?namespace:v);
    return Reflect.apply(fn,self,args);
  }});});pool.on('error',()=>{});
  const migration=readFileSync('migrations/grid_worker_v3_owner.sql','utf8');
  for(const table of ['grid_worker_quota_policy','grid_worker_quota_windows']){
    const sql=migration.match(new RegExp('CREATE TABLE '+table+' \\([\\s\\S]*?\\n\\);'))?.[0];
    if(!sql)throw Error('Canonical quota table fixture missing');await pool.query(sql);
  }
  await pool.query(`INSERT INTO grid_worker_quota_policy(provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,valid_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,Object.values(policy));
},30000);
afterAll(async()=>{for(const g of guards)g.close();await pool?.end();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}});
function guard(now:()=>number){const g=new MainQuotaGuard(pool,now);guards.push(g);return g;}
it('real session boot conflict, loss, reconnect and exact 65-second quarantine including in-flight predecessor',async()=>{
  let now=0;const a=guard(()=>now),b=guard(()=>now);
  await a.refresh();await expect(b.refresh()).rejects.toThrow();
  now=64999;await expect(a.beforeSend()).rejects.toThrow();
  now=65000;const predecessor=await a.beforeSend();predecessor();
  let finish!:(r:Response)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  const fetcher=workerFetch({debit:async()=>{},rateLimited:async()=>{},beforeSend:()=>a.beforeSend()},()=>new Promise(resolve=>{finish=resolve;started();}));
  const inFlight=fetcher('https://api.pacifica.fi/api/v1/account');await began;
  const row=(await admin.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=1 AND granted",[namespace])).rows[0];
  expect(row).toBeTruthy();await admin.query('SELECT pg_terminate_backend($1)',[row.pid]);
  await expect(a.beforeSend()).rejects.toThrow();a.close();
  await b.refresh();expect(()=>predecessor()).toThrow();finish(new Response('{}'));await inFlight;
  now=129999;await expect(b.beforeSend()).rejects.toThrow();
  now=130000;(await b.beforeSend())();
  b.close();await a.refresh();await expect(a.beforeSend()).rejects.toThrow();
  now=195000;(await a.beforeSend())();a.close();
});
it('real PostgreSQL serializes whole bursts and release restores only unused capacity',async()=>{
  await pool.query('DELETE FROM grid_worker_quota_windows');
  const q=new WorkerQuota(pool,async pid=>{await admin.query('SELECT pg_terminate_backend($1)',[pid]);});
  const raced=await Promise.allSettled([q.reserve('pacifica_rest',330),q.reserve('pacifica_rest',330)]);
  expect(raced.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const winner=raced.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{release():Promise<void>}>;
  await winner.value.release();await winner.value.release();
  expect(Number((await pool.query('SELECT sum(worker_used_units) AS used FROM grid_worker_quota_windows')).rows[0].used)).toBe(0);
  const transport=new PacificaTransportAuthority(undefined,'EXAMPLE_BURST',Date.now,true),wire=vi.fn().mockResolvedValue(new Response('{}'));
  const fetcher=workerFetch(q,wire,transport),ledger={claimRead:vi.fn().mockRejectedValue(Error('EXAMPLE_LEDGER_REFUSAL')),recordRateLimit:vi.fn()};
  const reads=new GridLaunchReads(transport,ledger,'0.5',fetcher),url='https://api.pacifica.fi/api/v1/account?account=EXAMPLE_MASTER';
  await expect(reads.burst('EXAMPLE_MASTER',[{method:'GET',url}],()=>reads.json('EXAMPLE_MASTER','/account',{account:'EXAMPLE_MASTER'}))).rejects.toThrow('EXAMPLE_LEDGER_REFUSAL');
  expect(wire).not.toHaveBeenCalled();expect(Number((await pool.query('SELECT sum(worker_used_units) AS used FROM grid_worker_quota_windows')).rows[0].used)).toBe(0);
  ledger.claimRead.mockResolvedValue('EXAMPLE_CLAIM');
  await reads.json('EXAMPLE_MASTER','/account',{account:'EXAMPLE_MASTER'});
  expect(wire).toHaveBeenCalledTimes(1);expect(ledger.claimRead).toHaveBeenLastCalledWith('EXAMPLE_MASTER','3','100','0.5');
  expect(Number((await pool.query('SELECT sum(worker_used_units) AS used FROM grid_worker_quota_windows')).rows[0].used)).toBe(30);
});
it('classifier and ledger share exact units, unknowns remain conservative, RPC allocation unchanged',()=>{
  expect(providerCredits(330)).toBe('33');expect(providerCredits(300)).toBe('30');
  expect(providerRequestCost('POST','/account/subaccount/list')).toBe(120);
  expect(providerRequestCost('POST','/account/subaccount/transfer')).toBe(30);
  expect(providerRequestCost('GET','/EXAMPLE_UNKNOWN')).toBe(120);
  expect(mainAllocation(1000,500)).toBe(500);expect(()=>new MainQuota(false,2)).toThrow('GRID_MAIN_INSTANCE_CAP_INVALID');
  const q=new MainQuota();q.install([{...policy,provider:'rpc_backup'}],0);q.debit('rpc_backup',125,0);expect(()=>q.debit('rpc_backup',1,0)).toThrow();
});
it('headers keep the minimum unexpired observation minus reservations despite resets, errors and malformed responses',()=>{
  let now=0;const q=new ObservedPacificaQuota('EXAMPLE',()=>now);
  q.observe({quota:1000,remaining:100,resetSeconds:50});now=1000;
  q.observe({quota:1000,remaining:900,resetSeconds:1});q.observe(null);
  expect(q.snapshot().remainingDeciCredits).toBe(100);
  q.reserve('EXAMPLE_RESERVATION',30,'risk-reduction');now=3000;
  expect(q.snapshot().remainingDeciCredits).toBe(70);
  q.observe({quota:1000,remaining:950,resetSeconds:60});expect(q.snapshot().remainingDeciCredits).toBe(70);
  now=50000;expect(q.snapshot().remainingDeciCredits).toBe(920);
});
it('keyless error headers self-correct only serialized same-window positive deltas; concurrent and reset pairs do not latch',async()=>{
  let now=0;const t=new PacificaTransportAuthority(undefined,'EXAMPLE_LATCH',()=>now,true),warn=vi.fn().mockResolvedValue(undefined);t.onCostLatch(warn);
  const response=(r:number,seconds:number)=>new Response('{}',{status:400,headers:{ratelimit:`"credits";r=${r};t=${seconds}`,'ratelimit-policy':'"credits";q=1000;w=60'}});
  const send=async(path:string,r:number,seconds:number)=>t.request('https://api.pacifica.fi/api/v1'+path,{method:'GET'},async()=>response(r,seconds));
  await send('/info/prices',900,60);now=1000;await send('/info/prices',850,59);
  expect(providerRequestCost('GET','/info/prices')).toBe(120);expect(warn).toHaveBeenCalledWith('/info/prices');
  expect(t.quota.snapshot().remainingDeciCredits).toBe(790);
  now=2000;await send('/book',950,60);expect(providerRequestCost('GET','/book')).toBe(30);
  let finish!:(r:Response)=>void;
  const pending=t.request('https://api.pacifica.fi/api/v1/book',{method:'GET'},()=>new Promise(resolve=>{finish=resolve;}));
  await send('/book',800,58);finish(response(700,57));await pending;
  expect(providerRequestCost('GET','/book')).toBe(30);
});

it.each([false,true])('real burst reservation covers distinct or deduplicated master/target before wire (same=%s)',async same=>{
  await pool.query('DELETE FROM grid_worker_quota_windows');
  const q=new WorkerQuota(pool,async()=>{}),f=launchAuthorityFixture();vi.spyOn(Date,'now').mockReturnValue(clock);
  const pair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),master=bs58.encode(pair.publicKey);
  f.account.masterAccount=master;f.raw.master.account=master;
  f.deps.unlock=async()=>({masterAccount:master,umkVersion:1,signingKey:pair.secretKey,cleanup:()=>pair.secretKey.fill(0),current:f.current});
  const transport=new PacificaTransportAuthority(undefined,'EXAMPLE_WHOLE_BURST',Date.now,true);
  const rawJson=f.deps.reads.json,wire=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    expect(Number((await pool.query('SELECT sum(worker_used_units) AS used FROM grid_worker_quota_windows')).rows[0].used)).toBe(same?300:330);
    const u=new URL(String(input));const data=init?.method==='POST'?await f.deps.reads.subaccounts('EXAMPLE_MASTER',new Uint8Array()):await rawJson('EXAMPLE_MASTER',u.pathname.replace('/api/v1',''),{...Object.fromEntries(u.searchParams),...(u.searchParams.get('account')===master?{account:'EXAMPLE_MASTER'}:{})});
    return new Response(JSON.stringify(data));
  });
  const ledger={claimRead:vi.fn().mockResolvedValue('EXAMPLE_CLAIM'),recordRateLimit:vi.fn()};
  const reads=new GridLaunchReads(transport,ledger,'0.5',workerFetch(q,wire,transport));
  const deps={...f.deps,reads:{...f.deps.reads,burst:reads.burst.bind(reads),json:reads.json.bind(reads),subaccounts:reads.subaccounts.bind(reads)}};
  await new GridLaunchAuthority(deps).observe(f.account.wallet,f.policy,same?null:f.account,umk());
  expect(wire).toHaveBeenCalledTimes(same?7:8);expect(ledger.claimRead).toHaveBeenCalledOnce();
  expect(ledger.claimRead).toHaveBeenCalledWith(master,same?'30':'33','100','0.5');
});
it('protective wrapped, alternative and default MAIN boundaries debit exactly once under the real lock',async()=>{
  let now=0;const g=guard(()=>now);await g.refresh();now=65000;installMainQuotaGuard(g);
  vi.stubEnv('GRID_REMOTE_WORKER_ENABLED','true');vi.stubEnv('QV_PROCESS_ROLE','main');
  const debit=vi.spyOn(mainQuota,'debit').mockImplementation(()=>{}),raw=vi.fn(async()=>new Response('{}'));
  const url='https://api.pacifica.fi/api/v1/orders/cancel',init={method:'POST',body:JSON.stringify({account:'EXAMPLE_MASTER'})};
  const wrapped=workerFetch({debit:async(p,u)=>mainQuota.debit(p,u),rateLimited:async()=>{},beforeSend:()=>g.beforeSend()},raw);
  await beforeMainRequest(wrapped,url,init,'EXAMPLE_MASTER');await wrapped(url,init);
  expect(debit).toHaveBeenCalledTimes(1);expect(debit).toHaveBeenLastCalledWith('pacifica_rest',30);
  for(const fetcher of [raw,fetch]){debit.mockClear();(await beforeMainRequest(fetcher,url,init,'EXAMPLE_MASTER'))();expect(debit).toHaveBeenCalledExactlyOnceWith('pacifica_rest',30);}
  g.close();
});
it('database failure refuses MAIN before a wire send',async()=>{
  const g=new MainQuotaGuard({connect:async()=>{throw Error('EXAMPLE_DB_DOWN');}} as any);
  const wire=vi.fn(),fetcher=workerFetch({debit:async()=>{},rateLimited:async()=>{},beforeSend:()=>g.beforeSend()},wire);
  await expect(fetcher('https://api.pacifica.fi/api/v1/account')).rejects.toThrow('EXAMPLE_DB_DOWN');expect(wire).not.toHaveBeenCalled();
});

it('a latch during the ledger claim cannot spend a previously cheaper burst',async()=>{
  const raw=vi.fn(async()=>new Response('{}')),transport=new PacificaTransportAuthority(undefined,'EXAMPLE_RACE',Date.now,true);
  const release=vi.fn(async()=>{});installRequestBudget(raw,{reserve:async()=>({release}),beforeSend:async()=>()=>{}});
  const reads=new GridLaunchReads(transport,{claimRead:async()=>{latchProviderEndpoint('/orders/edit');return randomUUID();},recordRateLimit:vi.fn()},'0.5',raw);
  const url='https://api.pacifica.fi/api/v1/orders/edit';
  await expect(reads.burst('EXAMPLE_MASTER',[{method:'POST',url}],async()=>{consumeRequestBurst(raw,'POST',url);})).rejects.toThrow('GRID_BURST_COST_CHANGED');
  expect(raw).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
});
it('an observation arriving while the limiter reserves can refuse and release before a ledger claim',async()=>{
  const raw=vi.fn(),transport=new PacificaTransportAuthority(undefined,'EXAMPLE_OBSERVATION_RACE',Date.now,true),release=vi.fn(async()=>{}),claimRead=vi.fn();
  installRequestBudget(raw,{reserve:async()=>{transport.quota.observe({quota:1000,remaining:1,resetSeconds:60});return {release};},beforeSend:async()=>()=>{}});
  const reads=new GridLaunchReads(transport,{claimRead,recordRateLimit:vi.fn()},'0.5',raw);
  await expect(reads.json('EXAMPLE_MASTER','/book',{})).rejects.toThrow('Waiting for venue request budget.');
  expect(release).toHaveBeenCalledOnce();expect(claimRead).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();
});
it('burst permits expire before a late wire callback',async()=>{
  let now=0;vi.spyOn(Date,'now').mockImplementation(()=>now);const raw=vi.fn();
  await withinRequestBurst(raw,[{method:'GET',url:'/book'}],async()=>{
    expect(consumeRequestBurst(raw,'GET','/book')).toBe(true);now=5000;expect(assertRequestBurstCurrent).toThrow('GRID_BURST_EXPIRED');
  });
});
it('the complete collection deadline rejects a hanging observation',async()=>{
  vi.useFakeTimers();try{
    vi.setSystemTime(clock);const f=launchAuthorityFixture();f.deps.reads.json=async()=>new Promise(()=>{});
    const pending=expect(new GridLaunchAuthority(f.deps).observe(f.account.wallet,f.policy,f.account,umk())).rejects.toThrow('Fresh Grid launch observations unavailable.');
    await vi.advanceTimersByTimeAsync(5000);await pending;expect(f.cleanup).toHaveBeenCalledOnce();
  }finally{vi.useRealTimers();}
});
it('retains lower error headers when recording a cost warning fails and blocks further sends',async()=>{
  let now=0;const transport=new PacificaTransportAuthority(undefined,'EXAMPLE_WARNING_FAILURE',()=>now,true);
  transport.onCostLatch(async()=>{throw Error('EXAMPLE_WARNING_STORE_DOWN');});
  const response=(remaining:number)=>new Response('{}',{status:400,headers:{ratelimit:`"credits";r=${remaining};t=60`,'ratelimit-policy':'"credits";q=1000;w=60'}});
  const raw=vi.fn(async()=>response(900)),url='https://api.pacifica.fi/api/v1/account';
  await transport.request(url,{method:'GET'},raw);now=1;raw.mockResolvedValueOnce(response(850));
  await expect(transport.request(url,{method:'GET'},raw)).rejects.toThrow('EXAMPLE_WARNING_STORE_DOWN');
  expect(transport.quota.snapshot().remainingDeciCredits).toBe(790);
  await expect(transport.request(url,{method:'GET'},raw)).rejects.toThrow('EXAMPLE_WARNING_STORE_DOWN');
  expect(raw).toHaveBeenCalledTimes(2);
});
