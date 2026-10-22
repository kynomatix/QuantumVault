import {describe,it,expect} from 'vitest';
import Decimal from 'decimal.js';
import {calculateGrid,minimumInvestment} from '../../server/grid-bot/engine';
import type {GridInput} from '../../server/grid-bot/engine-types';
import {canonicalGridPolicy,computeGridPolicyHmac,verifyGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {retainedGridPolicy} from '../../server/grid-bot/retained-policy';
import {projectGridStop} from '../../server/grid-bot/stop-clearance';
import {authoritativeGridPreview} from '../../server/grid-bot/draft-service';
import {previewGrid} from '../../server/grid-planner/preview';
import {cyclePolicy} from './cycle-fixtures';
import {authority,clock,intent,umk} from './draft-fixtures';
const input:GridInput={policyVersion:'2.0.0',side:'long',lower:'90',upper:'110',start:'100',intervals:20,investment:'1000',leverage:'1',seed:true,
  entryScale:'flat',profitScale:'flat',tick:'0.01',lot:'0.000001',minimumQuote:'1',investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:'0'};
function plan(extra:Partial<GridInput>={}){const r=calculateGrid({...input,...extra});if(!r.ok)throw Error(r.issues[0].reason);return r.plan;}
describe('signed lean sizing for new drafts only',()=>{
  it.each([true,false])('reproduces the 20 percent / 20 grid comparison, seed=%s',seed=>{
    const old=plan({seed}),next=plan({seed,sizingVersion:'lean-1',safetyEnvelopePrice:'110'});
    // The plan's analytical values also undergo the existing one-cent anchor search and lot flooring.
    expect(old.lines[0].quantity).toBe('0.503099');
    expect(next.lines[0].quantity).toBe(seed?'0.558055':'0.953661');
    expect(new Decimal(next.capacityNotional!).lte(1000)).toBe(true);
    const entries=next.cycles!.filter(c=>c.anchor==='opening').reduce((s,c)=>s.plus(c.quantity),new Decimal(0));
    if(!seed)expect(entries.mul(110).lte(1000)).toBe(true);
    expect(new Decimal(next.seedQuantity).mul(110).lte(1000)).toBe(true);
    expect(new Decimal(next.lines[0].quantity).div(old.lines[0].quantity).minus(1).mul(100).toFixed(2)).toBe(seed?'10.92':'89.56');
  });
  it.each(['long','short'] as const)('searches the new minimum without discarding endpoint maxima for %s',side=>{
    const extra={sizingVersion:'lean-1' as const,safetyEnvelopePrice:side==='long'?'110':'120',side,seed:false};
    const min=minimumInvestment({...input,...extra});expect(min.ok).toBe(true);if(!min.ok)return;
    expect(calculateGrid({...input,...extra,investment:min.investment}).ok).toBe(true);
    expect(calculateGrid({...input,...extra,investment:new Decimal(min.investment).minus('.01').toFixed(2)}).ok).toBe(false);
    expect(calculateGrid({...input,...extra,maximumQuote:'1'}).ok).toBe(false);
    expect(calculateGrid({...input,...extra,safetyEnvelopePrice:'100'}).ok).toBe(false);
  });
  it('bounds short planning at the adverse stop envelope and liquidation at reachable pool quantity',()=>{
    const p=plan({side:'short',sizingVersion:'lean-1',safetyEnvelopePrice:'120'});
    expect(p.cycles!.reduce((s,c)=>s.plus(c.quantity),new Decimal(0)).mul(120).lte(1000)).toBe(true);
    const deferred=plan({seed:false,sizingVersion:'lean-1',safetyEnvelopePrice:'110'});
    const result=projectGridStop({plan:deferred,funding:'1000',stop:'80',tick:'0.01',maxLeverage:'10',makerRate:'0',takerRate:'0',observedAt:1,expiresAt:100},2);
    expect(result.state).toBe('available');if(result.state!=='available')return;
    const Exact=Decimal.clone({precision:200});
    expect(new Exact(result.projection.size).mul(110).gte(1000)).toBe(true);
    expect(new Decimal(result.projection.size).lt(deferred.cycles!.reduce((s,c)=>s.plus(c.quantity),new Decimal(0)))).toBe(true);
  });
  it('signs and reconstructs the marker without changing unmarked canonical bytes',()=>{
    const old=cyclePolicy(),before=canonicalGridPolicy(old),oldHmac=computeGridPolicyHmac(old,umk());
    const p={...old,sizingVersion:'lean-1' as const,safetyEnvelopePrice:'120.00000000'},signed=computeGridPolicyHmac(p,umk());
    expect(signed.ok&&oldHmac.ok&&signed.digest!==oldHmac.digest).toBe(true);if(!signed.ok)return;
    expect(verifyGridPolicyHmac(old,umk(),signed.digest).ok).toBe(false);
    expect(verifyGridPolicyHmac({...p,safetyEnvelopePrice:'121.00000000'},umk(),signed.digest).ok).toBe(false);
    expect(canonicalGridPolicy(old)).toBe(before);
    expect(canonicalGridPolicy({...old,safetyEnvelopePrice:'120.00000000'})).toBeNull();
    const raw=Object.fromEntries(Object.entries(p).filter(([k])=>!['levels','sizingVersion','safetyEnvelopePrice'].includes(k)).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v]));
    raw.authority_snapshot={gridSizing:{sizingVersion:p.sizingVersion,safetyEnvelopePrice:p.safetyEnvelopePrice}};
    const restored=retainedGridPolicy(raw,p.levels.map(l=>({...l,reduce_only:l.reduceOnly})));
    expect(canonicalGridPolicy(restored)).toBe(canonicalGridPolicy(p));
    expect(verifyGridPolicyHmac(restored,umk(),signed.digest).ok).toBe(true);
  });
  it.each([true,false])('matches planner and authoritative sizes under the same fee assumption, seed=%s',async seed=>{
    const a=authority(),fee=seed?'0.0002':'0.0001';
    const requested={...intent,seedAtCreation:seed,gridCount:20,totalInvestment:'1000'};
    // A hypothetical planner has no account quote: use the authoritative maximum opening rate as its assumption.
    const draft=await authoritativeGridPreview('EXAMPLE',requested,'EXAMPLE_REVISION',{now:()=>clock,observe:async()=>a,umk:async()=>umk(),storage:{} as any});
    const query={market:requested.market,side:requested.direction,lower:requested.lowerPrice,upper:requested.upperPrice,stop:requested.stopPrice,intervals:20,
      entryScale:'flat' as const,profitScale:'flat' as const,seed,leverage:'1',investment:'1000',fee};
    const planner=previewGrid(query as any,a.market,clock);
    expect(draft.state).toBe('ready');expect(draft.plan?.sizingVersion).toBe('lean-1');
    expect(planner.requestedPlan?.lines).toEqual(draft.plan?.lines);
    expect(planner.minimum.state==='available'&&planner.minimum.value).toBe(draft.minimum);
  });
});
