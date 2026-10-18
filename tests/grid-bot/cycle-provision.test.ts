import { afterEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { calculateGrid } from '../../server/grid-bot/engine';
import { computeGridPolicyHmac } from '../../server/grid-bot/policy-hmac';
import { GridProvision, preflightGridLaunch, preflightGridResume } from '../../server/grid-bot/provision';
import { launchAuthorityFixture, clock, umk } from './launch-authority-fixtures';
import { cyclePolicy } from './cycle-fixtures';

function fixture() {
  const f=launchAuthorityFixture(),p=f.policy;
  const result=calculateGrid({policyVersion:'2.0.0',side:'long',lower:p.lowerPrice,upper:p.upperPrice,start:p.startPrice,intervals:p.gridCount,
    investment:p.totalInvestment,leverage:String(p.leverage),seed:false,entryScale:'flat',profitScale:'flat',tick:'0.01',lot:'0.001',
    minimumQuote:'1',investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:'0'});
  if(!result.ok)throw Error('EXAMPLE v2 geometry');
  f.policy={...p,policyVersion:'2.0.0',runtimePolicyVersion:'2.0.0',levels:result.plan.lines.map(l=>({ordinal:l.ordinal+1,
    price:new Decimal(l.price).toFixed(8),size:new Decimal(l.quantity).toFixed(8),side:l.role==='seed_exit'?'sell':'buy',reduceOnly:l.role==='seed_exit'}))};
  const signature=computeGridPolicyHmac(f.policy,umk());if(!signature.ok)throw Error('EXAMPLE signature');f.policyHash=signature.digest;
  return f;
}
afterEach(()=>vi.restoreAllMocks());
describe('v2 launch/resume validation before Stage B',()=>{
  it('recomputes signed future capacity at launch and holds changed minimums and endpoints',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(clock);const f=fixture();
    const {facts}=await f.authority.collect(f.account.wallet,f.policy,f.account,umk(),new AbortController().signal);
    const result=preflightGridLaunch(f.policy,f.policyHash,umk(),facts,clock,true);
    expect(result.ok).toBe(true);if(result.ok)expect(result.plan.policyVersion).toBe('2.0.0');
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),{...facts,minimumQuote:'50'},clock,true).ok).toBe(false);
    expect(preflightGridLaunch(f.policy,f.policyHash,umk(),{...facts,maximumQuote:'1'},clock,true).ok).toBe(false);
    const changed={...f.policy,levels:f.policy.levels.map((l,i)=>i===0?{...l,size:'0.00100000'}:l)};
    const signature=computeGridPolicyHmac(changed,umk());expect(signature.ok).toBe(true);
    if(signature.ok)expect(preflightGridLaunch(changed,signature.digest,umk(),facts,clock,true).ok).toBe(false);
  });
  it('validates retained resume constraints but never runs the legacy rebalance path for v2',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(clock);const f=fixture();
    const {facts}=await f.authority.collect(f.account.wallet,f.policy,f.account,umk(),new AbortController().signal);
    const input={} as Parameters<typeof preflightGridResume>[5];
    const result=preflightGridResume(f.policy,f.policyHash,umk(),facts,clock,input);
    expect(result).toEqual({ok:false,reason:'Grid cycle Resume requires Stage B replay and lifecycle integration.'});
    const changed=preflightGridResume(f.policy,f.policyHash,umk(),{...facts,lot:'0.3'},clock,input);
    expect(changed.ok).toBe(false);if(!changed.ok)expect(changed.reason).toContain('lot or quote');
  });
  it('denies v2 provisioning before custody, recovery, observation or execution and cleans its key',async()=>{
    const policy=cyclePolicy(),signature=computeGridPolicyHmac(policy,umk());if(!signature.ok)throw Error('EXAMPLE');
    const forbidden=vi.fn(async()=>{throw Error('EXAMPLE unexpected Stage A execution');}),cleanup=vi.fn();
    const provision=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup}),observe:forbidden,
      custody:{reserve:forbidden,confirmCreated:forbidden,confirmReused:forbidden},verifyEmpty:forbidden,execution:{run:forbidden},existing:forbidden,markCanary:forbidden});
    expect(await provision.start({wallet:'EXAMPLE',policy,policyHmac:signature.digest})).toEqual({state:'denied',reason:'Grid cycle provisioning requires Stage B execution integration.'});
    expect(forbidden).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledOnce();
  });
});
