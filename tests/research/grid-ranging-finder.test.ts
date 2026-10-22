import {describe,it,expect} from 'vitest';
import {varianceRatio,dfa,edgeRejections,travelScore,features,select,percentileRanks,pairedDirections} from '../../scripts/research/grid-ranging-finder/core.mjs';
import {compare,bh} from '../../scripts/research/grid-multi-timeframe/stats.mjs';
describe('preregistered ranging finder research',()=>{
 it('matches an independently expanded heteroskedastic variance-ratio calculation',()=>{
  const r=Array.from({length:336},(_,i)=>Math.sin(i*1.73)*.01+Math.cos(i*.71)*.004),n=r.length,q=4,mu=r.reduce((a,b)=>a+b)/n,e=r.map(x=>x-mu),ss=e.reduce((a,b)=>a+b*b,0);
  let sums=0,theta=0;for(let t=q-1;t<n;t++)sums+=e.slice(t-q+1,t+1).reduce((a,b)=>a+b,0)**2;
  for(let j=1;j<q;j++){let d=0;for(let t=j;t<n;t++)d+=e[t]**2*e[t-j]**2;theta+=4*(1-j/q)**2*d/ss**2;}
  const v=varianceRatio(r,q);expect(v.vr).toBeCloseTo(sums/(q*(n-q+1)*(1-q/n))/(ss/(n-1)),12);expect(v.se).toBeCloseTo(Math.sqrt(theta),12);expect(v.upper).toBeCloseTo(v.vr+1.959963984540054*v.se,12);
  expect(varianceRatio(Array(336).fill(0),4)).toBeNull();
 });
 it('distinguishes alternating antipersistence from persistent blocks with DFA',()=>{
  const anti=Array.from({length:720},(_,i)=>(i%2?1:-1)+.02*Math.sin(i*1.41));
  const persistent=Array.from({length:720},(_,i)=>Math.sin(i/40));
  expect(dfa(anti,[8,16,32,64,128]).h).toBeLessThan(.5);expect(dfa(persistent,[8,16,32,64,128]).h).toBeGreaterThan(.5);
 });
 it('counts a completed rejection and excludes unfinished reversal windows',()=>{
  const bars=Array.from({length:16},(_,i)=>({high:9,low:i*.01,close:5}));bars[0].high=10;bars[8].high=11;bars[8].close=10;bars[9].close=8;bars[15].high=12;bars[15].close=10;
  const x=edgeRejections(bars,{lookback:8,assessment:8,reversalBars:2,inset:.1});expect(x.upperCount).toBe(1);expect(x.lowerCount).toBe(0);
 });
 it('converts two line crossings to one round trip and normalizes stop distance',()=>{
  const bars=Array.from({length:169},(_,i)=>({close:100+(i%2)}));const v=travelScore(bars,{upper:110,lower:90,longStop:80,shortStop:120});expect(v.spacing).toBe(2);expect(v.dailyTravel).toBe(24);expect(v.roundTrips).toBe(6);expect(v.score).toBe(30);
 });
 it('uses only fully closed hourly bars and rejects a gap',()=>{
  const bars=Array.from({length:721},(_,i)=>({time:i*3600000,close:100+Math.sin(i*.73)+Math.sin(i*.17),high:103,low:97})),at=721*3600000,g={upper:110,lower:90,longStop:80,shortStop:120};
  const before=features(bars,at,g);expect(before.available).toBe(true);expect(features([...bars,{time:at,close:999,high:999,low:1}],at,g)).toEqual(before);expect(features(bars.filter((_,i)=>i!==50),at,g).available).toBe(false);
 });
 it('keeps hard qualification and squeeze exclusions without filling vacancies',()=>{
  const rows=Array.from({length:9},(_,i)=>({symbol:String.fromCharCode(65+i),available:true,squeeze:{available:true,squeezed:false},finder:{state:i===0?'ranging':'trending',adx:15+i},scores:{M1:i,M2:i,M3:i,M4:i},qualifies:{M1:i===0,M2:i<2}}));
  const x=select(rows);expect(x.quota).toBe(3);expect(x.groups.M0).toEqual(['A']);expect(x.groups.M1).toEqual(['A']);expect(x.groups.M2).toEqual(['A','B']);expect(x.groups.M5).toEqual(['A','B','C']);rows[0].squeeze.squeezed=true;expect(select(rows).groups.M1).toEqual([]);
 });
 it('assigns midranks to equal scores and deterministic ASCII ties',()=>{
  const rows=['B','A','C'].map((symbol,i)=>({symbol,scores:{M1:i<2?1:2}}));const r=percentileRanks(rows,'M1');expect(r.get('A')).toBe(.25);expect(r.get('B')).toBe(.25);expect(r.get('C')).toBe(1);
 });
 it('retains only paired directions',()=>{expect(pairedDirections([{symbol:'A',launchAt:1,leverage:1,direction:'long'},{symbol:'A',launchAt:1,leverage:1,direction:'short'},{symbol:'B',launchAt:1,leverage:1,direction:'long'}])).toHaveLength(2);});
 it('compares common weeks with equal week weights and reports quarters',()=>{
  const row=(week,netReturn)=>({symbol:'A',week,launchAt:week,quarter:1,leverage:1,horizonDays:14,netReturn,protectiveStop:false,liquidated:false,underwaterDays:1,maxDrawdown:.1,seedHold:0});
  const c=compare([row(0,.1),row(604800000,.3),row(1209600000,999)],[row(0,0),row(6048000000,999),row(604800000,0)]);expect(c.one.mean).toBeCloseTo(.2);expect(c.one.weeks).toBe(2);expect(c.quarterWins).toBe(1);expect(c.one.low).toBeGreaterThan(0);
  const q=bh([{p:.01},{p:.04},{p:.2}]);[.03,.06,.2].forEach((expected,i)=>expect(q[i].q).toBeCloseTo(expected,12));
 });
});
