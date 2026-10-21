import {describe,it,expect} from 'vitest';
import {scores,rank,calendar,quarterAt,lowerTail,bootstrap,requestFileName,DAY} from '../../scripts/research/grid-ranging-pairs/core.mjs';
const at=Date.UTC(2024,2,1),start=Date.UTC(2022,0,1);
const daily=(f:(n:number)=>number)=>Array.from({length:(at-start)/DAY+10},(_,i)=>{const close=f(i);return {time:start+i*DAY,open:close,high:close+1,low:close-1,close};});
describe('ranging pair point-in-time definitions',()=>{
 it('distinguishes monotone movement from oscillation without reading future closes',()=>{const rising=daily(i=>100+i),osc=daily(i=>100+i%2);expect(scores(rising,at,12)!.efficiency).toBe(1);expect(scores(osc,at,12)!.efficiency).toBeLessThan(.01);const before=scores(osc,at,12);for(const r of osc)if(r.time>=at)r.close=1e9;expect(scores(osc,at,12)).toEqual(before);});
 it('rejects a missing day and insufficient moving-mean warmup',()=>{const a=daily(i=>100+i%3);a.splice(a.findIndex(x=>x.time===at-10*DAY),1);expect(scores(a,at,12)).toBeNull();expect(scores(daily(i=>100+i%3).filter(x=>x.time>=Date.UTC(2023,2,1)),at,12)).toBeNull();});
 it('freezes disjoint floor-terciles and resolves tied ER by symbol',()=>{const r=rank(['D','B','E','A','C'].map(symbol=>({symbol,score:{efficiency:0}})));expect(r.ranging).toEqual(['A']);expect(r.trending).toEqual(['E']);expect(r.all).toEqual(['A','B','C','D','E']);expect(rank([]).trending).toEqual([]);});
 it('uses the most recent quarterly launch decision',()=>{expect(quarterAt(Date.UTC(2023,1,28))).toBeNull();expect(quarterAt(Date.UTC(2023,5,1))).toBe(Date.UTC(2023,5,1));expect(quarterAt(Date.UTC(2023,4,31))).toBe(Date.UTC(2023,2,1));});
 it('rotates one launch per week through all 21 slots and requires full horizons',()=>{const a=calendar(Date.UTC(2022,0,3),Date.UTC(2022,7,1));const first=a.filter(x=>x.horizonDays===14).slice(0,21);expect(new Set(first.map(x=>x.slot)).size).toBe(21);expect(new Set(first.map(x=>x.week)).size).toBe(21);expect(a.every(x=>x.launchAt+x.horizonDays*DAY<=Date.UTC(2022,7,1))).toBe(true);});
 it('uses fractional tail mass and reproducible paired-difference intervals',()=>{expect(lowerTail([-10,0,10],.5)).toBeCloseTo(-20/3);expect(bootstrap([2,2,2],{draws:100})).toMatchObject({mean:2,low:2,high:2});expect(bootstrap([-1,2,3],{draws:100,block:4})).toEqual(bootstrap([-1,2,3],{draws:100,block:4}));});
 it('gives restarted captures distinct raw paths',()=>{expect(requestFileName('example-a',1)).not.toBe(requestFileName('example-b',1));expect(()=>requestFileName('../example',1)).toThrow();});
});

import {marketSpec,worstPath,selections} from '../../scripts/research/grid-ranging-pairs/design.mjs';
import {weekly,mutualConfigurations,sizingDifferences,weightedTail,intervals} from '../../scripts/research/grid-ranging-pairs/analysis-core.mjs';
const row=(x:any={})=>({symbol:'A',week:0,launchAt:0,quarter:0,horizonDays:14,window:'week',arm:'flat_flat',leverage:1,builderRate:0,direction:'long',netReturn:0,maxDrawdown:0,protectiveStop:0,liquidated:false,underwaterDays:0,seedHold:false,...x});
describe('ranging replay and aggregation contract',()=>{
 it('carries every metric from the lower-return path',()=>{const a={admitted:true,path:'OHLC',netReturn:1,maxDrawdown:.9},b={admitted:true,path:'OLHC',netReturn:-1,maxDrawdown:.1};expect(worstPath([a,b])).toBe(b);expect(()=>worstPath([a])).toThrow();});
 it('applies Pacifica constraints and the ten dollar floor to A',()=>{expect(marketSpec({symbol:'EXAMPLE',universe:'A',pacifica:{tick_size:'.01',lot_size:'.1',min_order_size:'5',max_order_size:'1000',min_tick:'0',max_tick:'100',max_leverage:3}})).toMatchObject({market:{tick:'.01',lot:'.1',minimumQuote:'10',minimumPrice:'.01'},maxLeverage:3});});
 it('weights configurations within pair, then pairs, then weeks',()=>{const rows=[row({netReturn:2}),row({netReturn:4}),row({symbol:'B',netReturn:9})];expect(weekly(rows).get(0)![0]).toBe(6);});
 it('matches actual configuration admissions rather than just matching a week',()=>{const [a,b]=mutualConfigurations([row(),row({direction:'short'})],[row({symbol:'B',direction:'short'})]);expect(a).toHaveLength(1);expect(b).toHaveLength(1);expect(a[0].direction).toBe('short');});
 it('requires mutual sizing admission within the same pair/configuration',()=>{const rows=[row({netReturn:1}),row({arm:'further_near',netReturn:4}),row({symbol:'B',arm:'further_near',netReturn:10})];expect(sizingDifferences(rows).map(x=>x.netReturn)).toEqual([3]);});
 it('preserves equal pair weights in the fractional lower tail',()=>{expect(weightedTail([row({netReturn:-10}),row({netReturn:-10}),row({symbol:'B',netReturn:10})],.75)).toBeCloseTo(-10/3);});
 it('retains empty calendar weeks in circular block resampling',()=>{const w=weekly([row({netReturn:2}),row({week:2*7*DAY,netReturn:2})]);const ci=intervals(w,4);expect(ci.calendarWeeks).toBe(3);expect(ci.metrics.netReturn).toEqual({mean:2,low:2,high:2});expect(ci.draws).toBe(10000);});
 it('does not select pairs without a complete point-in-time score',()=>{const m=[{symbol:'EXAMPLE',universe:'A',begin:at,daily:daily(i=>100+i%2).slice(-10)}];expect(selections(m).every(s=>s.groups.all.length===0)).toBe(true);});
});