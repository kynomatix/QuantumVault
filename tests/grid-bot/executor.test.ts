import {describe,it,expect,vi} from 'vitest';
import {GridExecutor,type GridExecutorDeps} from '../../server/grid-bot/executor';
const claim={id:'EXAMPLE_BOT',account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',leaseToken:'EXAMPLE_LEASE'};
function fixture(status='canary'){
  const calls:string[]=[],signal=new AbortController(),state={status,complete:true,entries:true};
  const deps:GridExecutorDeps={recover:vi.fn(async()=>{calls.push('recover');}),lifecycle:vi.fn(async()=>{calls.push('lifecycle');return 'idle';}),
    status:async()=>state.status,provision:vi.fn(async()=>{calls.push('provision');}),reconcile:vi.fn(async()=>{calls.push('reconcile');return {entriesAllowed:state.entries,reconciliationComplete:state.complete};}),
    roll:vi.fn(async()=>{calls.push('roll');})};
  return {state,deps,calls,signal,executor:new GridExecutor(deps)};
}
describe('C6 durable executor ordering',()=>{
  it('recovers and gives Stop priority before provisioning',async()=>{const f=fixture('provisioning');await f.executor.tick(claim,f.signal.signal);expect(f.calls).toEqual(['recover','lifecycle','provision']);});
  it('fully reconciles before planning a rolling action',async()=>{const f=fixture();await f.executor.tick(claim,f.signal.signal);expect(f.calls).toEqual(['recover','lifecycle','reconcile','roll']);});
  it('a terminal Stop never provisions, plans or observes another account',async()=>{const f=fixture('stopping');vi.mocked(f.deps.lifecycle).mockResolvedValue('stopped');await f.executor.tick(claim,f.signal.signal);expect(f.deps.roll).not.toHaveBeenCalled();expect(f.deps.reconcile).not.toHaveBeenCalled();expect(f.deps.provision).not.toHaveBeenCalled();});
  it.each(['paused','pausing','stopping','range_exhausted','resuming','reconciling'])('%s receives no entry planning',async status=>{const f=fixture(status);await f.executor.tick(claim,f.signal.signal);expect(f.deps.roll).not.toHaveBeenCalled();expect(f.deps.provision).not.toHaveBeenCalled();});
  it('a concurrent Stop during reconciliation prevents rolling',async()=>{const f=fixture();vi.mocked(f.deps.reconcile).mockImplementation(async()=>{f.state.status='stopping';return {entriesAllowed:true};});await f.executor.tick(claim,f.signal.signal);expect(f.deps.roll).not.toHaveBeenCalled();});
  it('unknown history or transfer authority permits no rolling action',async()=>{const f=fixture();f.state.complete=false;f.state.entries=false;await f.executor.tick(claim,f.signal.signal);expect(f.deps.roll).not.toHaveBeenCalled();});
  it('C2 excess retains planning for reductions after complete reconciliation',async()=>{const f=fixture();f.state.entries=false;await f.executor.tick(claim,f.signal.signal);expect(f.deps.roll).toHaveBeenCalledOnce();});
  it('a failed recovery never falls through to a new send',async()=>{const f=fixture();vi.mocked(f.deps.recover).mockRejectedValue(Error('EXAMPLE retained identity mismatch'));await expect(f.executor.tick(claim,f.signal.signal)).rejects.toThrow('identity');expect(f.deps.lifecycle).not.toHaveBeenCalled();expect(f.deps.roll).not.toHaveBeenCalled();});
  it('abort after recovery prevents lifecycle and new sends',async()=>{const f=fixture();vi.mocked(f.deps.recover).mockImplementation(async()=>{f.signal.abort();});await expect(f.executor.tick(claim,f.signal.signal)).rejects.toThrow();expect(f.deps.lifecycle).not.toHaveBeenCalled();});
});
