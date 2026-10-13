import {describe,it,expect} from 'vitest';
import {advanceGridCanary,gridCanaryPolicyCurrent,GRID_CANARY_DURATION_MS,type GridCanaryClock} from '../../server/grid-bot/canary-clock';
const start=1000;
function tick(prior:GridCanaryClock|null,time:number,extra:Record<string,any>={}){return advanceGridCanary(prior,{bootId:'EXAMPLE_BOOT',tickId:'EXAMPLE_TICK_'+time,observedAt:time,firstConfirmedAt:start,qualifying:true,generation:String(time),safeThrough:time-120000,...extra});}
function continuous(){let v=tick(null,start);for(let t=start+15000;t<=start+GRID_CANARY_DURATION_MS+120000;t+=15000)v=tick(v,t);return v;}
describe('durable uninterrupted canary clock',()=>{
  const qualification={observedAt:1000,leverage:'2',maxLeverage:'10',feeRate:'0.001',minOrderSize:'10',lotSize:'0.01',tickSize:'1',recycler:true};
  const levels=[{price:'90',exact_size:'1'},{price:'110',exact_size:'0'}];
  it('qualifies immutable virtual levels with current fee, minimum, leverage and recycler clearance',()=>expect(gridCanaryPolicyCurrent(qualification,levels,2,1000)).toBe(true));
  it('checks the lower paired exit minimum for short entries, including equality',()=>{
    const short=[{price:'90',exact_size:'0'},{price:'110',exact_size:'1'}];
    expect(gridCanaryPolicyCurrent({...qualification,minOrderSize:'91'},short,2,1000,'short')).toBe(false);
    expect(gridCanaryPolicyCurrent({...qualification,minOrderSize:'90'},short,2,1000,'short')).toBe(true);
  });
  it('allows a reduce-only seeded exit at the edge without inventing an entry pair',()=>expect(gridCanaryPolicyCurrent(qualification,[{price:'90',exact_size:'1',reduce_only:true},{price:'110',exact_size:'1',reduce_only:true}],2,1000)).toBe(true));
  it.each([{feeRate:'0.1'},{minOrderSize:'91'},{maxLeverage:'1'},{leverage:'3'},{recycler:false},{observedAt:0},{lotSize:'0'},{tickSize:'7'}])('denies invalid current qualification %s',change=>expect(gridCanaryPolicyCurrent({...qualification,...change},levels,2,6000)).toBe(false));
  it('starts with first venue confirmation, not provisioning or process startup',()=>{expect(tick(null,start).cleanSince).toBe(start);expect(tick(null,start+60000).cleanSince).toBe(start+60000);});
  it('requires a full safe-through at the boundary then two subsequent distinct clean ticks',()=>{const v=continuous();expect(v.certifiedSafeThrough).toBe(start+GRID_CANARY_DURATION_MS);expect(v.cleanTicks).toBe(0);const a=tick(v,v.lastObservedAt+15000);expect(a.promoted).toBe(false);expect(tick(a,a.lastObservedAt+15000).promoted).toBe(true);});
  it('cannot certify one millisecond before the boundary',()=>{const v=continuous();const a=tick({...v,certifiedGeneration:null,certifiedTickId:null},v.lastObservedAt+1,{safeThrough:start+GRID_CANARY_DURATION_MS-1});expect(a.certifiedGeneration).toBeNull();});
  it('duplicate and replayed observations cannot advance clean ticks',()=>{const v=continuous();expect(tick(v,v.lastObservedAt)).toEqual(v);expect(tick(v,v.lastObservedAt,{tickId:'EXAMPLE_DIFFERENT'}).cleanSince).toBeNull();});
  it.each(['unresolved','429','breaker','parity','fees','minimums','leverage','recycler'])('resets on nonqualifying %s without changing first-confirmation history',()=>{const v=continuous(),a=tick(v,v.lastObservedAt+15000,{qualifying:false});expect(a.cleanSince).toBeNull();expect(a.firstConfirmedAt).toBe(start);expect(a.cleanTicks).toBe(0);expect(a.certifiedGeneration).toBeNull();});
  it('restart and missed cadence restart the full thirty-minute window',()=>{const v=continuous();expect(tick(v,v.lastObservedAt+15000,{bootId:'EXAMPLE_NEW_BOOT'}).cleanSince).toBe(v.lastObservedAt+15000);expect(tick(v,v.lastObservedAt+30001).cleanSince).toBe(v.lastObservedAt+30001);});
  it('a duplicate failure can reset an already committed qualifying tick',()=>{const v=continuous();expect(tick(v,v.lastObservedAt,{qualifying:false}).cleanSince).toBeNull();});
  it('JSON persistence after crash preserves duplicate protection',()=>{const v=continuous(),saved=JSON.parse(JSON.stringify(v));expect(tick(saved,v.lastObservedAt)).toEqual(v);});
});
