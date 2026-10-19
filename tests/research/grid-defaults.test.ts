import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {BASELINE,settings,parameterizeIntervals,compare,selectDevelopment} from '../../scripts/research/grid-defaults/design.mjs';
import {geometryAt,widerGeometry} from '../../scripts/research/grid-defaults/geometry.mjs';
import {plannerLaunchGeometry} from '../../server/grid-bot/trail-rolling';

const market={symbol:'EXAMPLE',tick:'0.01',lot:'0.01',minimumQuote:'10',maximumQuote:'1000000',minimumPrice:'0.01',maximumPrice:'1000000'};
const bars=Array.from({length:1200},(_,i)=>({time:Date.UTC(2025,0,1)+i*3600000,open:100,high:102+(i%7),low:95-(i%5),close:100,volume:10,
  provenance:{source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
const rows=(mean:number,dd:number,stop:number,admitted=true)=>['OHLC','OLHC'].map(path=>({key:path,path,admitted,netReturn:mean,maxDrawdown:dd,protectiveStop:stop,fees:1,fillCount:2}));
describe('Grid defaults preregistered research',()=>{
  it('enumerates exactly the registered 38 unique seeded-mode settings',()=>{
    expect(settings).toHaveLength(38);expect(new Set(settings.map(s=>s.id)).size).toBe(38);
    expect(settings.filter(s=>s.mode==='step_back')).toHaveLength(19);
    expect(settings.find(s=>s.id===BASELINE)).toMatchObject({window:'week',multiplier:1,intervals:10,mode:'repeat_all'});
  });
  it('changes exactly two interval reads and fails closed on source drift',()=>{
    const source=readFileSync('server/grid-bot/trail-backtest.ts','utf8'),adapted=parameterizeIntervals(source);
    expect(adapted.replaceAll('(input.intervals??e.intervals)','e.intervals')).toBe(source);
    expect(adapted.match(/input.intervals/g)).toHaveLength(2);
    expect(()=>parameterizeIntervals(source.replace('intervals:e.intervals,','intervals:10,'))).toThrow();
  });
  it('calls the product planner with no future candle dependence and matches old week geometry',async()=>{
    const result=await geometryAt(bars,'1h',1100,market,'week');expect(result.ok).toBe(true);
    expect(result.geometry).toEqual(plannerLaunchGeometry(bars as any,'1h',1100,market.tick).geometry);
    const changed=bars.map((b,i)=>i>=1100?{...b,high:10000,close:5000}:b);
    expect(await geometryAt(changed,'1h',1100,market,'week')).toEqual(result);
    expect(result.historyEnd+3600000).toBe(bars[1100].time);
  });
  it('widens only stops and rounds away from the range',()=>{
    const g={lower:'90.00000000',upper:'110.00000000',longStop:'89.99000000',shortStop:'110.01000000'};
    expect(widerGeometry(g,1,'0.01')).toEqual(g);
    expect(widerGeometry(g,1.5,'0.01')).toEqual({...g,longStop:'89.98000000',shortStop:'110.02000000'});
    expect(()=>widerGeometry(g,0,'0.01')).toThrow();
  });
  it('requires return, drawdown, stops, both paths and coverage together',()=>{
    expect(compare(rows(0.02,0.02,0),rows(0.01,0.03,1)).passes).toBe(true);
    expect(compare(rows(0.02,0.04,0),rows(0.01,0.03,1)).passes).toBe(false);
    expect(compare(rows(0.02,0.02,1),rows(0.01,0.03,0)).passes).toBe(false);
    expect(compare(rows(0.02,0.02,0,false),rows(-0.01,0.03,1)).passes).toBe(false);
    const oneBad=rows(0.02,0.02,0);oneBad[1].netReturn=-0.02;
    expect(compare(oneBad,rows(0.01,0.03,1)).passes).toBe(false);
    expect(()=>compare(rows(0.02,0.02,0),rows(0.01,0.03,1).slice(0,1))).toThrow();
  });
  it('selects no change when no registered candidate dominates',()=>{
    const all=settings.flatMap(s=>rows(0,0.02,0).map(r=>({...r,setting:s.id})));
    expect(selectDevelopment(all).selected).toBeNull();
  });
  it('breaks exact return ties using risk pooled across both paths',()=>{
    const all=settings.flatMap(s=>rows(0,0.1,1).map(r=>({...r,setting:s.id})));
    for(const r of all){
      if(r.setting==='day-1-10-repeat_all')Object.assign(r,{netReturn:0.01,maxDrawdown:r.path==='OHLC'?0.01:0.03,protectiveStop:0});
      if(r.setting==='week-1.5-10-repeat_all')Object.assign(r,{netReturn:0.01,maxDrawdown:r.path==='OHLC'?0.015:0.02,protectiveStop:0});
    }
    expect(selectDevelopment(all).selected).toBe('week-1.5-10-repeat_all');
  });
});
