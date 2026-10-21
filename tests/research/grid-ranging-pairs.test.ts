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
