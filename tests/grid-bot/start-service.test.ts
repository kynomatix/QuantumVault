import {afterEach,describe,expect,it,vi} from 'vitest';
import {startRetainedGrid,type GridStartDraft,type GridStartDeps} from '../../server/grid-bot/start-service';
import {GridProvision,type GridProvisionDeps} from '../../server/grid-bot/provision';
import {launchAuthorityFixture,clock,umk} from './launch-authority-fixtures';
import {policy} from './draft-fixtures';
const expected={draftRevision:'EXAMPLE_REVISION',serverIntentDigest:'A'.repeat(64)};
const signal=()=>new AbortController().signal;
function fixture(){
  let current:GridStartDraft={...expected,status:'draft',policy:policy(),policyHmac:'EXAMPLE'};
  const provision=vi.fn(async()=>{current={...current,status:'provisioning'};return {state:'pending' as const};});
  const deps:GridStartDeps={read:vi.fn(async wallet=>wallet==='EXAMPLE_OWNER'?{...current}:null),provision};
  const start=(owner='EXAMPLE_OWNER',identity=expected)=>startRetainedGrid(owner,current.policy.id,identity,signal(),deps);
  return {start,deps,provision,get current(){return current;},set current(value:GridStartDraft){current=value;}};
}
afterEach(()=>vi.restoreAllMocks());
describe('C7 retained Start admission',()=>{
  it('repeats the same identity without repeating financial admission',async()=>{const f=fixture();const first=await f.start();expect(await f.start()).toMatchObject({launchId:first.launchId,state:'pending'});expect(f.provision).toHaveBeenCalledOnce();});
  it('recovers a lost reply after durable admission without replay',async()=>{const f=fixture();f.provision.mockImplementationOnce(async()=>{f.current={...f.current,status:'provisioning'};throw Error('EXAMPLE lost reply');});const first=await f.start();expect(await f.start()).toMatchObject({launchId:first.launchId});expect(f.provision).toHaveBeenCalledOnce();});
  it('concurrent Starts rely on the custody CAS, retaining its winning launch identity',async()=>{
    const f=fixture();let admitted=0;let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    f.provision.mockImplementation(async()=>{if(f.current.status!=='draft')throw Error('EXAMPLE custody CAS lost');admitted++;f.current={...f.current,status:'provisioning'};await blocked;return {state:'pending'};});
    const first=f.start(),second=f.start();release();const results=await Promise.all([first,second]);expect(admitted).toBe(1);expect(results.map(x=>x.launchId)).toEqual([f.current.policy.id,f.current.policy.id]);
  });
  it('refuses unauthorized, stale confirmation and changed intent before provisioning',async()=>{
    const f=fixture();await expect(f.start('EXAMPLE_OTHER')).rejects.toMatchObject({code:'not_found'});
    await expect(f.start('EXAMPLE_OWNER',{...expected,draftRevision:'EXAMPLE_OLD'})).rejects.toMatchObject({code:'conflict'});
    f.current={...f.current,serverIntentDigest:'B'.repeat(64)};await expect(f.start()).rejects.toMatchObject({code:'conflict'});expect(f.provision).not.toHaveBeenCalled();
  });
  it.each(['stopping','stopped','pausing','paused'])('Start never supersedes retained %s',async status=>{const f=fixture();f.current={...f.current,status};expect(await f.start()).toMatchObject({launchId:f.current.policy.id,reason:expect.stringContaining(status)});expect(f.provision).not.toHaveBeenCalled();});
  it('an aborted request cannot begin financial admission',async()=>{const f=fixture(),abort=new AbortController();abort.abort();await expect(startRetainedGrid('EXAMPLE_OWNER',f.current.policy.id,expected,abort.signal,f.deps)).rejects.toThrow();expect(f.provision).not.toHaveBeenCalled();});
  it.each(['changed signed policy','expired launch facts'])('retains C6 refusal for %s, with no reservation or send',async defect=>{
    vi.spyOn(Date,'now').mockReturnValue(clock);const f=launchAuthorityFixture(),reserve=vi.fn(),run=vi.fn(),key=umk();
    const observe=vi.fn(async()=>{const facts=await f.authority.observe(f.account.wallet,f.policy,null,key);return defect==='expired launch facts'?{...facts,expiresAt:clock-1}:facts;});
    const deps:GridProvisionDeps={now:()=>clock,durableUmk:async()=>({umk:key,cleanup:()=>key.fill(0)}),observe,
      custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},execution:{run},existing:async()=>null,verifyEmpty:vi.fn(),markCanary:vi.fn()};
    const retained:GridStartDraft={...expected,status:'draft',policy:defect==='changed signed policy'?{...f.policy,totalInvestment:'101.00'}:f.policy,policyHmac:f.policyHash};
    const provision=new GridProvision(deps);
    const result=await startRetainedGrid(f.account.wallet,f.policy.id,expected,signal(),{read:async()=>retained,provision:(wallet,draft)=>provision.start({wallet,policy:draft.policy,policyHmac:draft.policyHmac})});
    expect(result.state).toBe('denied');expect(reserve).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();expect(key.every(x=>x===0)).toBe(true);
  });
});
