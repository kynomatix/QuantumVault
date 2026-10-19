import {describe,it,expect} from 'vitest';
import {rollingWindows,plannerLaunchGeometry,launchCohort} from '../../server/grid-bot/trail-rolling';
import {runTrailBacktest,makeTrailGrid,type TrailRun} from '../../server/grid-bot/trail-backtest';
import {timeWindowRange} from '../../server/grid-planner/range-facts';
import {moveCandles} from './range-move-fixtures';
import {evaluateRollingWindow} from '../../scripts/grid-trail-rolling-worker.mjs';
const hour=3_600_000,day=24*hour,startTime=Date.parse('2026-01-01T00:00:00Z');
const bars=Array.from({length:70*24},(_,i)=>({...moveCandles()[0],time:startTime+i*hour,
  open:100,high:103,low:97,close:100,volume:1}));
const market={symbol:'BTC',tick:'0.01',lot:'0.001',minimumQuote:'10',maximumQuote:'1000000',minimumPrice:'0.01',maximumPrice:'1000000'};
const geometry={lower:'90.00000000',upper:'110.00000000',longStop:'85.00000000',shortStop:'115.00000000'};
const base:TrailRun={candles:bars,timeframe:'1h',start:300,end:320,market,direction:'long',seed:false,mode:'repeat_all',variant:'a',path:'OHLC',geometry};
describe('weekly launches and fixed horizons',()=>{
  it('keeps worker batches paired and identical to direct replay',()=>{
    const w={start:300,end:320,geometry,period:'evaluation',horizonDays:14,launchAt:bars[300].time,endAt:bars[320].time};
    const batch=evaluateRollingWindow({bars,market,timeframe:'1h'},w);
    expect(batch.rejected).toEqual([]);expect(batch.rows).toHaveLength(120);
    for(let i=0;i<batch.rows.length;i+=2){
      expect(batch.rows[i].path).toBe('OHLC');expect(batch.rows[i+1].path).toBe('OLHC');
      expect(batch.rows[i].variant).toBe(batch.rows[i+1].variant);
    }
    for(const row of batch.rows.filter(r=>r.variant==='d')){
      const result=runTrailBacktest({...base,...row,market,start:w.start,end:w.end,geometry});
      expect(row.netReturn).toBe(result.netReturn);expect(row.holds).toEqual(result.holds);expect(row.moveLog).toEqual(result.moveLog);
    }
  });
  it('keeps full horizons inside each chronological period and retains missing-boundary holds',()=>{
    const from=startTime+14*day,to=startTime+70*day;
    for(const horizon of [14,30]){
      const windows=rollingWindows(bars,'1h',from,to,horizon);
      expect(windows.length).toBe(horizon===14?7:4);
      for(const [i,w] of windows.entries()){
        expect(w.launchAt).toBe(from+i*7*day);expect(w.endAt-w.launchAt).toBe(horizon*day);
        expect(w.endAt).toBeLessThanOrEqual(to);expect(w.end-w.start).toBe(horizon*24);expect(w.hold).toBeNull();
      }
    }
    expect(rollingWindows(bars.filter(b=>b.time!==from),'1h',from,to,14)[0].hold).toBe('missing_boundary');
  });
  it('uses shipped planner history strictly before launch and holds a gap',()=>{
    const g=plannerLaunchGeometry(bars,'1h',300,'0.01');expect(g.ok).toBe(true);
    const direct=timeWindowRange('RESEARCH','1h','week',bars.slice(48,300),bars[300].time);
    expect(direct.state).toBe('available');
    if(g.ok&&direct.state==='available'){
      expect(Number(g.geometry.lower)).toBe(Number(direct.lowerPrice));
      expect(Number(g.geometry.longStop)).toBe(Number(direct.longStop));
      expect(g.historyEnd).toBeLessThan(bars[300].time);
    }
    const changed=structuredClone(bars);for(let i=300;i<changed.length;i++)changed[i].high=999;
    expect(plannerLaunchGeometry(changed,'1h',300,'0.01')).toEqual(g);
    const gapped=bars.filter((_,i)=>i!==250);expect(plannerLaunchGeometry(gapped,'1h',299,'0.01').ok).toBe(false);
  });
  it('applies the declared stop and does not restart a stopped rolling run',()=>{
    expect(makeTrailGrid(base,'100').stopLossPrice).toBe(geometry.longStop);
    const changed=structuredClone(bars);changed[300].low=80;
    const r=runTrailBacktest({...base,candles:changed,seed:true});
    expect(r.holds.protective_stop).toBe(1);expect(r.position).toBe('0');
    expect(r.executions.every(f=>f.time<changed[301].time)).toBe(true);
  });
  it('classifies the same-bar first event by path for both directions, with an explicit residual group',()=>{
    const changed=structuredClone(bars);changed[300]={...changed[300],high:120,low:80};
    for(const direction of ['long','short'] as const){
      const path=direction==='long'?'OHLC':'OLHC',other=path==='OHLC'?'OLHC':'OHLC';
      expect(launchCohort({...base,candles:changed,direction,path},geometry)).toBe('favourable_breakout');
      expect(launchCohort({...base,candles:changed,direction,path:other},geometry)).toBe('adverse_stop_without_breakout');
    }
    expect(launchCohort(base,geometry)).toBe('inside_range');
    changed[300]={...bars[300],low:88};
    expect(launchCohort({...base,candles:changed},geometry)).toBe('adverse_excursion_no_stop');
  });
  it('matches full planning on idle, crossing, moving and stop bars under both orderings',()=>{
    const changed=structuredClone(bars);
    for(let i=300;i<340;i++){
      const price=100+(i-300)*0.8;
      changed[i]={...changed[i],open:price,close:price+0.2,high:price+0.7,low:price-0.7};
    }
    changed[339].low=50;
    for(const direction of ['long','short'] as const)for(const seed of [false,true])for(const path of ['OHLC','OLHC'] as const){
      const input={...base,candles:changed,end:340,variant:'c' as const,direction,seed,path};
      const r=runTrailBacktest(input);expect(r).toEqual(runTrailBacktest({...input,planEveryBar:true}));
      let previousLower=Number(r.initialGeometry.lower),previousStop=Number(r.initialGeometry.stop);
      for(const m of r.moveLog){expect(Number(m.stop)-previousStop).toBeCloseTo(Number(m.lower)-previousLower,8);previousLower=Number(m.lower);previousStop=Number(m.stop);}
      if(direction==='long')expect(r.moves).toBeGreaterThan(0);
    }
  });
});
