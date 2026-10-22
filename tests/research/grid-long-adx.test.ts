import {describe,it,expect} from 'vitest';
import {indicators,averageAdx,squeezeAt,adxRanks,pickerMembership,correlation,spearman} from '../../scripts/research/grid-long-adx/core.mjs';
import {DAY} from '../../scripts/research/grid-ranging-pairs/core.mjs';
import {compare as fastCompare,absolute as fastAbsolute} from '../../scripts/research/grid-long-adx/fast-stats.mjs';
import {compare as originalCompare,absolute as originalAbsolute} from '../../scripts/research/grid-ranging-pairs/analysis-core.mjs';
const start=Date.UTC(2022,0,1);
const bars=(count=800,fn=(i:number)=>100+i)=>Array.from({length:count},(_,i)=>({time:start+i*DAY,close:fn(i),high:fn(i)+1,low:fn(i)-1}));
describe('long ADX and squeeze preregistered signals',()=>{
 it('seeds ADX on transition 27 and gives 100 for one-way movement',()=>{const x=indicators(bars());expect(x.get(start+26*DAY).adx).toBeNull();expect(x.get(start+27*DAY).adx).toBe(100);expect(averageAdx(x,Date.UTC(2023,6,1),6)).toBe(100);});
 it('uses zero for no directional movement and resets after a gap',()=>{const a=bars(100,()=>100);expect(indicators(a).get(start+27*DAY).adx).toBe(0);a.splice(50,1);const x=indicators(a);expect(x.get(start+77*DAY).adx).toBeNull();expect(x.get(start+78*DAY).adx).toBe(0);});
 it('does not count equal opposing movements as directional strength',()=>{const a=bars(100,()=>100).map((r,i)=>({...r,high:101+i,low:99-i}));expect(indicators(a).get(start+99*DAY).adx).toBe(0);});
 it('uses population standard deviation and normalized twenty-day width',()=>{const x=indicators(bars(20));const expected=4*Math.sqrt((20**2-1)/12)/109.5;expect(x.get(start+19*DAY).bandwidth).toBeCloseTo(expected,12);expect(x.get(start+18*DAY).bandwidth).toBeNull();});
 it('requires complete calendar windows rather than available-day averages',()=>{const x=indicators(bars());x.delete(Date.UTC(2023,3,1));expect(averageAdx(x,Date.UTC(2023,6,1),6)).toBeNull();expect(squeezeAt(x,Date.UTC(2023,6,1)).available).toBe(false);});
 it('excludes the unfinished launch day and all later data',()=>{const a=bars(),launch=Date.UTC(2023,6,1)+8*3600000,before=squeezeAt(indicators(a),launch);for(const r of a)if(r.time>=Math.floor(launch/DAY)*DAY){r.close*=10;r.high=r.close+1;r.low=r.close-1;}expect(squeezeAt(indicators(a),launch)).toEqual(before);});
 it('excludes current bandwidth from the prior year and uses strict bottom quintile',()=>{const at=Date.UTC(2023,0,1),x=new Map();for(let i=1;i<=365;i++)x.set(at-i*DAY,{bandwidth:i<=73?0:2});x.set(at,{bandwidth:1});const s=squeezeAt(x,at+DAY);expect(s.percentile).toBe(.2);expect(s.squeezed).toBe(false);x.set(at-DAY,{bandwidth:2});expect(squeezeAt(x,at+DAY).squeezed).toBe(true);});
 it('ranks available scores into floor-terciles with ASCII ties',()=>{const r=adxRanks(['D','B','E','A','C','F'].map(symbol=>({symbol,p2:symbol==='F'?null:10})),'p2');expect(r.ranging).toEqual(['A']);expect(r.trending).toEqual(['E']);expect(r.all).toHaveLength(5);});
 it('makes conjunction and missing state explicit without replacing selections',()=>{const s={all:['A','B'],trending:['B'],p1:{ranging:['A'],trending:['B']},p2:{ranging:['A'],trending:['B']}};expect(pickerMembership(s,{available:true,squeezed:false},'A')).toMatchObject({P1:true,P2:true,P3:true,P4:true});expect(pickerMembership(s,{available:false},'A')).toMatchObject({P2:true,P3:false,P4:false,all:true});});
 it('handles correlation ties and constant variables',()=>{expect(correlation([[1,2],[2,4],[3,6]])).toBeCloseTo(1);expect(spearman([[1,4],[1,4],[2,2],[3,1]])).toBeCloseTo(-1);expect(correlation([[1,2],[1,4]])).toBeNull();});
});
describe('unchanged estimators with shared seeded resamples',()=>{
 const row=(i:number,symbol:string)=>({symbol,week:i*7*DAY,launchAt:i*7*DAY,quarter:i<5?0:1,horizonDays:14,window:'week',arm:'flat_flat',leverage:1,builderRate:0,direction:'long',netReturn:Math.sin(i+symbol.length),maxDrawdown:i/100,protectiveStop:i%2,liquidated:i%3===0,underwaterDays:i,seedHold:false});
 const left=[0,1,3,4,8,9].flatMap(i=>[row(i,'A'),row(i,'BBB')]),right=[0,1,2,3,4,8,9].map(i=>row(i,'CC'));
 function equivalent(a:any,b:any){if(typeof a==='number'){expect(a).toBeCloseTo(b,12);return;}if(a===null||typeof a!=='object'){expect(a).toEqual(b);return;}expect(Object.keys(a)).toEqual(Object.keys(b));for(const k of Object.keys(a))equivalent(a[k],b[k]);}
 it('matches all inherited absolute metrics and 10000-draw one/four-week intervals',()=>equivalent(fastAbsolute(left),originalAbsolute(left)));
 it('matches paired contrasts, empty weeks, quartiles and tails',()=>equivalent(fastCompare(left,right),originalCompare(left,right)));
 it('preserves unavailable populations',()=>equivalent(fastCompare([],right),originalCompare([],right)));
});
