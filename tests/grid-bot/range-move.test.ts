import {describe,it,expect} from 'vitest';
import {gridRuntimePolicy} from '../../server/grid-bot/runtime-policy';
import {qualifyGridDow,candidateGridEpoch} from '../../server/grid-bot/move-policy';
import {GRID_RANGE_MOVE_ENABLED,epochDigest,validateEpochCarry} from '../../server/grid-bot/epoch-policy';
import {canonicalGridPolicy,computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {replayGridCycles,executableCycleQuantity} from '../../server/grid-bot/cycle-replay';
import {behaviourPolicy} from './behaviour-fixtures';
import {history,operation,fill,terminal} from './cycle-fixtures';
import type {PlannerCandle} from '../../server/grid-planner/types';
import type {LaunchFacts} from '../../server/grid-bot/provision';

const epochId='00000000-0000-4000-8000-000000000011',nextEpochId='00000000-0000-4000-8000-000000000012';
const facts={tick:'0.01',lot:'0.001',minimumQuote:'1',maximumQuote:'10000',minimumPrice:'1',maximumPrice:'10000',bookPrice:'123',maker:{effectiveRate:'0.001'},profit:{effectiveRate:'0.001'}} as LaunchFacts;
const duration=900000,base=1800000000000;
function candles(short=false):PlannerCandle[]{
  const highs=[105,106,114,108,107,110,116,124,118,117,123,132,126,125,124];
  const lows=[99,100,101,96,100,103,105,108,102,108,110,115,117,116,115];
  return highs.map((high,i)=>{const low=lows[i],close=i===14?123:(high+low)/2;
    return {time:base+i*duration,open:short?200-close:close,close:short?200-close:close,high:short?200-low:high,low:short?200-high:low,volume:1,
      provenance:{source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}};
  });
}
function carried(seed=false){
  const p=behaviourPolicy('repeat_all','long',seed),h=history(p);
  if(seed){const op=operation(p,'EXAMPLE_SEED',null,'opening','3',1,'seed');h.operations.push(op);h.fills.push({...fill(op,'EXAMPLE_SEED_TRADE','3',2),fee:'0.3'});h.progress.push(terminal(op,'3',3));}
  const exported=replayGridCycles({...h,exportEpochId:epochId});
  if(!exported.ok||!exported.carry)throw Error(JSON.stringify(exported));
  return {p,h,carry:exported.carry};
}
function candidate(seed=false){const c=carried(seed);return {...c,...candidateGridEpoch({policy:c.p,policyHmac:computeGridPolicyHmac(c.p,Buffer.alloc(32,1)).ok?(computeGridPolicyHmac(c.p,Buffer.alloc(32,1)) as {digest:string}).digest:'EXAMPLE',epochId:nextEpochId,originEpochId:epochId,ordinal:2,carry:c.carry,facts,close:'123',mark:'123'})};}
describe('manual range epoch authority',()=>{
  it('provides distinct retained runtime authority for epoch orders',()=>{expect(gridRuntimePolicy('2.3.0')?.descriptor.version).toBe('2.3.0');expect(gridRuntimePolicy('2.3.0')?.digest).not.toBe(gridRuntimePolicy('2.2.0')?.digest);});
  it('ships with the production feature switch off',()=>expect(GRID_RANGE_MOVE_ENABLED).toBe(false));
  it('requires finalized two-bar-right Dow confirmation above the old edge',()=>{
    const p=behaviourPolicy('repeat_all'),bars=candles(),now=base+bars.length*duration+100;
    expect(qualifyGridDow({policy:p,timeframe:'15m',candles:bars,now,after:base}).confirmedAt).toBe(base+14*duration);
    const forming=structuredClone(bars);forming.at(-1)!.provenance.finality='forming';
    expect(()=>qualifyGridDow({policy:p,timeframe:'15m',candles:forming,now,after:base})).toThrow();
    const broken=structuredClone(bars);broken.at(-1)!.low=90;
    expect(()=>qualifyGridDow({policy:p,timeframe:'15m',candles:broken,now,after:base})).toThrow(/lower low/);
    expect(()=>qualifyGridDow({policy:p,timeframe:'1h',candles:bars,now,after:base})).toThrow();
  });
  it('mirrors the Dow rule for a short bot',()=>{
    const bars=candles(true),p=behaviourPolicy('repeat_all','short');
    expect(qualifyGridDow({policy:p,timeframe:'15m',candles:bars,now:base+bars.length*duration+100,after:base}).close).toBe('77');
  });
  it('rejects a close beyond the edge without a confirmed higher high',()=>{
    const bars=candles();for(let i=0;i<bars.length-2;i++){bars[i].high=Math.min(119,bars[i].high);bars[i].open=bars[i].close=Math.min(bars[i].high,bars[i].close);}
    expect(()=>qualifyGridDow({policy:behaviourPolicy('repeat_all'),timeframe:'15m',candles:bars,now:base+bars.length*duration+100,after:base})).toThrow();
  });
  it('translates geometry and stop one interval while preserving the original policy bytes',()=>{
    const before=canonicalGridPolicy(behaviourPolicy('repeat_all','long',false)),m=candidate();
    expect(m.displacement).toBe('10.00000000');expect(m.policy.lowerPrice).toBe('90.00000000');expect(m.policy.stopLossPrice).toBe('86.00000000');
    expect(m.policy.totalInvestment).toBe(m.p.totalInvestment);expect(m.policy.leverage).toBe(m.p.leverage);expect(canonicalGridPolicy(m.p)).toBe(before);
    expect(canonicalGridPolicy(m.policy)).not.toBeNull();
  });
  it('does not issue initial credit or seed again on the new epoch',()=>{
    const m=candidate(true),replay=replayGridCycles({...history(m.policy),carry:m.carry});expect(replay.ok).toBe(true);
    if(!replay.ok)return;expect(replay.cycles.reduce((n,c)=>n+Number(c.held),0)).toBe(3);expect(replay.cycles.every(c=>c.pendingSeed==='0')).toBe(true);
    const seed=operation(m.policy,'EXAMPLE_RESEED',null,'opening','1',4,'seed');
    expect(replayGridCycles({...history(m.policy),carry:m.carry,operations:[seed]}).ok).toBe(false);
  });
  it('preserves source lineage and consumed credit over successive exports',()=>{
    const m=candidate(true),replay=replayGridCycles({...history(m.policy),carry:m.carry,exportEpochId:nextEpochId});
    expect(replay.ok).toBe(true);if(!replay.ok)return;
    expect(replay.carry!.owners.flatMap(o=>o.sources).map(s=>s.sourceEpochId)).toEqual(m.carry.owners.flatMap(o=>o.sources).map(()=>epochId));
    expect(replay.carry!.owners.map(o=>o.initialRemaining)).toEqual(m.carry.owners.map(o=>o.initialRemaining));
    const tampered=structuredClone(m.carry);tampered.owners[0].initialRemaining='999';
    expect(()=>validateEpochCarry(tampered,m.policy.epochAuthority!)).toThrow();
    expect(epochDigest(m.carry)).toBe(m.policy.epochAuthority!.carryDigest);
  });
  it('holds unconfirmed old orders and preserves their reservation',()=>{
    const {p,h}=carried(false),op=operation(p,'EXAMPLE_UNKNOWN',0,'opening','1',10);op.initialCredit='1';h.operations.push(op);
    expect(replayGridCycles({...h,exportEpochId:epochId}).ok).toBe(false);
  });
  it('rejects a carried lot that would exit below its actual fee-inclusive cost',()=>{
    const {p,carry}=carried(true);for(const source of carry.owners.flatMap(o=>o.sources))source.price='1000';
    expect(()=>candidateGridEpoch({policy:p,policyHmac:'EXAMPLE',epochId:nextEpochId,originEpochId:epochId,ordinal:2,carry,facts,close:'123',mark:'123'})).toThrow(/fee-inclusive cost/);
  });
  it('retains dust without increasing executable quantity',()=>{
    const m=candidate(),replay=replayGridCycles({...history(m.policy),carry:m.carry});expect(replay.ok).toBe(true);
    if(replay.ok)expect(executableCycleQuantity({...replay.cycles[0],openingCredit:'0.0001'},'opening','0.001','1')).toBe('0');
  });
});

it('manual Dow qualification keeps insufficient indicator warm-up informational',()=>{const bars=candles();const p=behaviourPolicy('repeat_all','long',false);expect(qualifyGridDow({policy:p,timeframe:'15m',candles:bars,now:base+bars.length*duration,after:base}).information.state).toBe('unavailable');});
