import { describe,it,expect } from 'vitest';
import { gridStopRiskSummary } from '../../server/grid-bot/stop-risk-summary';
import { authoritativeGridPreview, type GridDraftDeps } from '../../server/grid-bot/draft-service';
import { gridCurrentStopRisk, gridDraftRevision } from '../../client/src/lib/grid-draft-view';
import type { GridPlan } from '../../server/grid-bot/engine-types';
import { authority,clock,intent } from './draft-fixtures';
function scenario(short=false,seed=true) {
  const a=authority(),stop=short?'120':'80';
  a.stop={state:'available',liquidation:short?'150':'50',validatedClearance:'1',boundedAdverseExitPrice:stop,observedAt:clock,expiresAt:clock+15_000,source:'EXAMPLE'};
  const p:GridPlan={policyVersion:'2.2.0',behaviourMode:'step_back',side:short?'short':'long',start:'100',seedQuantity:seed?'1':'0',seedPriceBounds:{low:'99.5',high:'100.5'},investment:'1000',leverage:'1',lines:[],allocatedNotional:'1000',unallocatedNotional:'0',feeGate:'evaluated',feeRows:[],cycles:[
    {ownerOrdinal:0,anchor:'opening',openingOrdinal:0,closingOrdinal:1,openingPrice:short?'110':'90',closingPrice:'100',quantity:'2',initialInventory:'0',initialOpeningCredit:'2',enabled:true,recycles:true},
    {ownerOrdinal:1,anchor:'closing',openingOrdinal:1,closingOrdinal:2,openingPrice:short?'90':'110',closingPrice:short?'80':'120',quantity:seed?'1':'0',initialInventory:seed?'1':'0',initialOpeningCredit:'0',enabled:seed,recycles:false},
  ]};
  return {a,p,stop,run:()=>gridStopRiskSummary(p,stop,a,clock,clock+30_000)};
}
describe('read-only stop loss scenario',()=>{
  it.each([false,true])('marks all adverse entries plus one seed, symmetric short=%s',short=>{
    const s=scenario(short),r=s.run();expect(r).toMatchObject({state:'available',inventory:'3',loss:short?'40.69':'40.64',entryFees:short?'0.07385':'0.06615',exitFee:short?'0.108':'0.072',expiresAt:clock+15_000,scenario:'adverse_entries_plus_seed'});
    // The seed owner's paired opening is never counted again, even if moved into the adverse path.
    s.p.cycles![1].openingPrice=short?'105':'95';expect(s.run()).toEqual(r);
  });
  it('supports no seed, and ignores levels beyond the stop',()=>{
    const s=scenario(false,false);expect(s.run()).toMatchObject({state:'available',inventory:'2',loss:'20.09'});
    s.p.cycles!.push({...s.p.cycles![0],ownerOrdinal:2,openingPrice:'70'});expect(s.run()).toMatchObject({state:'available',inventory:'2',loss:'20.09'});
  });
  it.each(['seed mismatch','duplicate owner','missing bounds','stale stop','missing taker','wrong fee identity','wrong stop','legacy','malformed quantity'])( 'returns unavailable for %s',kind=>{
    const s=scenario();
    if(kind==='seed mismatch')s.p.seedQuantity='2';if(kind==='duplicate owner')s.p.cycles!.push(s.p.cycles![0]);
    if(kind==='missing bounds')delete s.p.seedPriceBounds;
    if(kind==='stale stop'&&s.a.stop.state==='available')s.a.stop.expiresAt=clock;
    if(kind==='missing taker')s.a.seedFee=null;
    if(kind==='wrong fee identity')s.a.referenceAccount='REDACTED';
    if(kind==='wrong stop'&&s.a.stop.state==='available')s.a.stop.boundedAdverseExitPrice='79';
    if(kind==='legacy')delete s.p.policyVersion;
    if(kind==='malformed quantity')s.p.cycles![0].quantity='NaN';
    expect(s.run().state).toBe('unavailable');
  });
  it.each(['long','short'] as const)('binds an actual canonical %s preview and expires or changes revision closed',async direction=>{
    const i={...intent,behaviourMode:'step_back' as const,direction,gridCount:10,totalInvestment:'1000',entryScaleType:'ascending' as const,profitScaleType:'descending' as const,stopPrice:direction==='long'?'80':'120'};
    const deps={observe:async()=>authority(),now:()=>clock,cycleV2Creation:true,projectedStop:true} as GridDraftDeps;
    const p={...await authoritativeGridPreview('EXAMPLE',i,gridDraftRevision(i),deps),draftRevision:gridDraftRevision(i),requestId:1};
    expect(p.state).toBe('ready');expect(p.stopRisk.state).toBe('available');expect(gridCurrentStopRisk(p,i,clock)).not.toBeNull();
    expect(gridCurrentStopRisk(p,i,p.expiresAt)).toBeNull();expect(gridCurrentStopRisk(p,{...i,totalInvestment:'1001'},clock)).toBeNull();
    expect(gridCurrentStopRisk({...p,stopRisk:{state:'unavailable',reason:'EXAMPLE'}},i,clock)).toBeNull();
  });
});
