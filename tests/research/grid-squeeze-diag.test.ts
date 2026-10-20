import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {DAY,WEEK,weekAt,weekday,hourBucket,accumulator,add,bootstrapDesign,summarize,difference} from '../../scripts/research/grid-squeeze-diag/stats.mjs';
const monday=Date.UTC(2026,0,5);
const row=(week:number,value:number)=>({launchAt:monday+week*WEEK,admitted:true,netReturn:value,protectiveStop:value<0});
it('clusters by actual Monday calendar week rather than the Sunday launch anchor',()=>{
  expect(weekAt(monday-DAY)).toBe(monday-WEEK);expect(weekAt(monday)).toBe(monday);
  expect(weekAt(monday+7*DAY-1)).toBe(monday);expect(weekAt(monday+7*DAY)).toBe(monday+WEEK);
  expect(weekday(monday)).toBe('Mon');expect(hourBucket(monday+8*3600000)).toBe('Europe 08-16');
  expect(hourBucket(monday+16*3600000)).toBe('US 16-24');
});
it('duplicate correlated scenarios do not manufacture narrower bootstrap intervals',()=>{
  const a=accumulator({}),b=accumulator({}),weeks=new Set<number>();
  [-.2,.1,-.04,.25,.02,-.1].forEach((v,w)=>{weeks.add(monday+w*WEEK);add(a,row(w,v),w);for(let i=0;i<10;i++)add(b,row(w,v),w);});
  const d=bootstrapDesign('EXAMPLE',weeks),x=summarize(a,d),y=summarize(b,d);
  expect(y.admitted).toBe(10*x.admitted);expect(y.launches).toBe(x.launches);
  expect(y.mean).toBeCloseTo(x.mean,12);expect(y.lower95).toBeCloseTo(x.lower95,12);expect(y.upper95).toBeCloseTo(x.upper95,12);
});
it('keeps a paired constant shift exact under synchronized calendar resampling',()=>{
  const a=accumulator({}),b=accumulator({}),weeks=new Set<number>();
  [-.2,.1,.4,-.1].forEach((v,w)=>{weeks.add(monday+w*WEEK);add(a,row(w,v+.125),w);add(b,row(w,v),w);});
  const d=bootstrapDesign('EXAMPLE',weeks),result=difference(a,b,d,bootstrapDesign('EXAMPLE',weeks,4));
  expect(result.mean).toBeCloseTo(.125,12);expect(result.lower95).toBeCloseTo(.125,12);expect(result.upper95).toBeCloseTo(.125,12);
  expect(result.block4Lower95).toBeCloseTo(.125,12);
});
it('distinguishes empty and single-week data from an established zero return',()=>{
  const d=bootstrapDesign('EXAMPLE',new Set([monday,monday+WEEK])),a=accumulator({});
  expect(summarize(a,d).mean).toBeNull();add(a,row(0,0),1);const s=summarize(a,d);
  expect(s.mean).toBe(0);expect(s.lower95).toBeNull();expect(s.upper95).toBeNull();expect(s.profitable).toBe(0);
});
it('rejects missing past data without using forming candles or changing signal venue',()=>{
  const code=`import {measure} from './scripts/research/grid-squeeze-diag/signals.mjs';
    const H=3600000,t=Date.UTC(2026,0,5),n=190*24;
    const bars=Array.from({length:n+2},(_,i)=>{const c=100+Math.sin(i/3)*.5;return {time:t+(i-n)*H,open:c,close:c,high:c+1,low:c-1,volume:1,provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}});
    const build=b=>[{venue:'okx',bars:b,atrCache:new Map()}];
    const before=measure(build(bars),'EXAMPLE',t);bars[n].close=999999;bars[n+1].high=999999;
    const after=measure(build(bars),'EXAMPLE',t);
    const gap=measure(build(bars.filter((_,i)=>i!==n-1000)),'EXAMPLE',t);
    if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Future leakage');
    if(before.atrBin==='UNAVAILABLE'||before.ageDays!==28||!before.ageCensored)throw Error('Complete history unavailable');
    if(gap.atrBin!=='UNAVAILABLE'||gap.ageBin!=='UNAVAILABLE'||gap.venue!=='okx')throw Error('History gap bypassed');
    console.log('signal history checks passed');`;
  const out=execFileSync(process.execPath,['--experimental-transform-types','--import','./scripts/research/grid-finder/loader.mjs','--input-type=module','-e',code],{timeout:30000,env:{...process.env,FINDER_INPUT_MAP:''}});
  expect(out.toString()).toContain('signal history checks passed');
});
