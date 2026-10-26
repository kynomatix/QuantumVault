import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {MainQuotaGuard} from '../../server/grid-worker/main-quota-guard';
import {MAIN_QUOTA_GUARD_LOCK_NAMESPACE} from '../../server/wallet-lock-constants';

it('MAIN owns a dedicated namespace distinct from every other exported lock namespace',()=>{
  // Read declarations so checking storage and journal constants cannot start their pools.
  const sources=['server/wallet-lock-constants.ts','server/storage.ts','server/ai-trader/execution-journal.ts'];
  const namespaces=sources.flatMap(path=>Array.from(readFileSync(path,'utf8').matchAll(/export const (\w*LOCK_NAMESPACE)\s*=\s*(\d+)/g),m=>({name:m[1],value:Number(m[2])})));
  expect(MAIN_QUOTA_GUARD_LOCK_NAMESPACE).toBe(927416);
  expect(namespaces.map(n=>n.name)).toEqual(expect.arrayContaining([
    'MAIN_QUOTA_GUARD_LOCK_NAMESPACE','AGENT_WALLET_RESET_LOCK_NAMESPACE','AGENT_SOL_WITHDRAW_LOCK_NAMESPACE',
    'AI_TRADER_EXECUTION_JOURNAL_LOCK_NAMESPACE','AI_TRADER_EXECUTION_JOURNAL_EPOCH_LOCK_NAMESPACE',
  ]));
  for(const {name,value} of namespaces)if(name!=='MAIN_QUOTA_GUARD_LOCK_NAMESPACE')expect(value,name).not.toBe(MAIN_QUOTA_GUARD_LOCK_NAMESPACE);
  expect(MAIN_QUOTA_GUARD_LOCK_NAMESPACE).not.toBe(927415); // Reserved close-intent namespace.
});

it('acquisition and ownership check use the same two-int lock with id 1',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{held:true}]}),release=vi.fn();
  const client={query,release,on:vi.fn()};
  const guard=new MainQuotaGuard({connect:async()=>client} as any);
  try {
    await guard.refresh();
    expect(query).toHaveBeenNthCalledWith(1,'SELECT pg_try_advisory_lock($1,$2) AS held',[MAIN_QUOTA_GUARD_LOCK_NAMESPACE,1]);
    expect(query).toHaveBeenNthCalledWith(2,expect.stringContaining('classid=$1::oid AND objid=$2::oid AND objsubid=2'),[MAIN_QUOTA_GUARD_LOCK_NAMESPACE,1]);
  } finally {guard.close();}
  expect(release).toHaveBeenCalledWith(true);
});
