import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
vi.mock('../../server/grid-worker/owner-master-keys',()=>({OWNER_MASTER_PUBLIC_KEYS:['EXAMPLE_MASTER']}));
import {installMainQuotaAccounts,mainGridQuotaAccount} from '../../server/grid-worker/main-quota-scope';
import {debitMainRequest,MainQuota,mainAllocation,mainQuota} from '../../server/grid-worker/main-quota';
import {PacificaTransportAuthority} from '../../server/protocol/pacifica/pacifica-transport';
import {canonicalQuotaPolicy,quotaPolicyDigest,validateQuotaPolicies} from '../../server/grid-worker/quota-policy';
import type {QuotaPolicy} from '../../server/grid-worker/quota';
const digest=createHash('sha256').update('EXAMPLE_POLICY').digest('hex');
const policy=(provider:QuotaPolicy['provider']='pacifica_rest'):QuotaPolicy=>({provider,domain_id:'deployment',window_ms:60000,total_units:'1000',worker_limit_units:'500',worker_protective_reserve_units:'120',policy_digest:digest,valid_until:new Date(1000000)});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();installMainQuotaAccounts([]);});
it('never debits or refuses unrelated MAIN REST, RPC or WS even at boot with its flag true',()=>{
  vi.stubEnv('GRID_REMOTE_WORKER_ENABLED','true');vi.stubEnv('QV_PROCESS_ROLE','main');
  const debit=vi.spyOn(mainQuota,'debit').mockImplementation(()=>{throw Error('EXAMPLE_BOOT_REFUSAL');});
  const t=new PacificaTransportAuthority(undefined);
  installMainQuotaAccounts([{account:'EXAMPLE_CHILD',master_account:'EXAMPLE_MASTER'},{account:'EXAMPLE_FOREIGN_CHILD',master_account:'EXAMPLE_OTHER'}]);
  for(const account of ['EXAMPLE_SIGNAL','EXAMPLE_AI','EXAMPLE_OTHER','EXAMPLE_FOREIGN_CHILD']){
    expect(debitMainRequest('https://api.pacifica.fi/api/v1/account?account='+account,{})).toBe(false);
    expect(debitMainRequest('https://api.pacifica.fi/api/v1/orders/create',{body:JSON.stringify({account})})).toBe(false);
    expect(()=>t.websocketOptions('wss://ws.pacifica.fi/ws',account)).not.toThrow();
  }
  expect(debitMainRequest('https://api.mainnet-beta.solana.com/',{body:JSON.stringify({method:'getBalance',params:['EXAMPLE_MASTER']})})).toBe(false);
  expect(debit).not.toHaveBeenCalled();
  for(const account of ['EXAMPLE_MASTER','EXAMPLE_CHILD']){
    expect(mainGridQuotaAccount(account)).toBe(true);
    expect(()=>debitMainRequest('https://api.pacifica.fi/api/v1/account?account='+account,{})).toThrow('EXAMPLE_BOOT_REFUSAL');
    expect(()=>t.websocketOptions('wss://ws.pacifica.fi/ws',account)).toThrow('GRID_MAIN_WS_QUOTA_UNAVAILABLE');
  }
});
it('bounds one and four MAIN instances; a fifth violates the declared cap',()=>{
  const p=policy(),per=mainAllocation(1000,500);
  expect(per).toBe(125);expect(per+500).toBeLessThanOrEqual(1000);expect(4*per+500).toBe(1000);expect(5*per+500).toBeGreaterThan(1000);
  for(let i=0;i<4;i++){const q=new MainQuota();q.install([p],0);q.debit('pacifica_rest',125,0);expect(()=>q.debit('pacifica_rest',1,0)).toThrow();}
});
it('policy replacement never refunds local debit or backoff',()=>{
  const q=new MainQuota();q.install([policy()],0);q.debit('pacifica_rest',120,0);q.install([{...policy(),policy_digest:createHash('sha256').update('EXAMPLE_REPLACEMENT').digest('hex')}],1);
  expect(()=>q.debit('pacifica_rest',6,1)).toThrow();q.rateLimited('pacifica_rest',1);q.install([policy()],2);expect(()=>q.debit('pacifica_rest',1,2)).toThrow();
});
it('canonical policies require both providers, integer budgets, exact digest and <=90 days',()=>{
  const policies=[policy(),policy('rpc_backup')].map(p=>({...p,policy_digest:quotaPolicyDigest(p)}));
  expect(()=>validateQuotaPolicies(policies,0)).not.toThrow();
  expect(JSON.parse(canonicalQuotaPolicy(policies[0])).total_units).toBe('1000');
  for(const change of [{total_units:'1000.0'},{worker_protective_reserve_units:'0'},{domain_id:'EXAMPLE_OTHER'},{valid_until:new Date(91*86400000)},{policy_digest:digest}])expect(()=>validateQuotaPolicies([{...policies[0],...change},policies[1]],0)).toThrow();
});
it('no-key launch permission is explicit and cannot accept an invalid key',()=>{
  expect(new PacificaTransportAuthority(undefined).gridReady).toBe(false);
  expect(new PacificaTransportAuthority(undefined,'EXAMPLE',Date.now,true).gridReady).toBe(true);
  expect(new PacificaTransportAuthority('EXAMPLE_INVALID','EXAMPLE',Date.now,true).gridReady).toBe(false);
});

it('real adapter transport never applies grid boot refusal to signal, AI or other accounts',async()=>{
  vi.stubEnv('GRID_REMOTE_WORKER_ENABLED','true');vi.stubEnv('QV_PROCESS_ROLE','main');
  const debit=vi.spyOn(mainQuota,'debit').mockImplementation(()=>{throw Error('EXAMPLE_BOOT_REFUSAL');});
  const raw=new Response('{}'),fetcher=vi.fn().mockResolvedValue(raw);vi.stubGlobal('fetch',fetcher);
  try{const {PacificaAdapter}=await import('../../server/protocol/pacifica/pacifica-adapter');const adapter=new PacificaAdapter();
    for(const account of ['EXAMPLE_SIGNAL','EXAMPLE_AI','EXAMPLE_OTHER']){
      expect(await (adapter as any).fetchBounded('https://api.pacifica.fi/api/v1/account?account='+account,{method:'GET'},500,1000,'EXAMPLE')).toBe(raw);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);expect(debit).not.toHaveBeenCalled();
    await expect((adapter as any).fetchBounded('https://api.pacifica.fi/api/v1/account?account=EXAMPLE_MASTER',{method:'GET'},500,1000,'EXAMPLE')).rejects.toThrow('EXAMPLE_BOOT_REFUSAL');
  }finally{vi.unstubAllGlobals();}
});

it('inspects MAIN capacity without spending and retains cold-start quarantine, backoff and competing usage',()=>{
  const p={...policy(),total_units:'2500'},q=new MainQuota(true);q.install([p],0);
  expect(q.inspect('pacifica_rest',360,1)).toBe(false);q.install([p],60001);
  expect(q.inspect('pacifica_rest',360,60001)).toBe(true);expect(q.inspect('pacifica_rest',360,60001)).toBe(true);
  q.debit('pacifica_rest',120,60001);expect(q.inspect('pacifica_rest',360,60002)).toBe(true);
  q.debit('pacifica_rest',120,60002);expect(q.inspect('pacifica_rest',360,60003)).toBe(false);
  q.rateLimited('pacifica_rest',60003);expect(q.inspect('pacifica_rest',1,60004)).toBe(false);
  const filled=new MainQuota();filled.install([policy()],0);expect(mainAllocation(1000,500)).toBe(125);expect(filled.inspect('pacifica_rest',360,0)).toBe(false);
});
