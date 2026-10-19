import {describe,it,expect} from 'vitest';
import Decimal from 'decimal.js';
import {runTrailBacktest,TRAIL_EXPERIMENT,type TrailRun} from '../../server/grid-bot/trail-backtest';
import {moveCandles,moveBase,moveDuration} from './range-move-fixtures';
const D=Decimal.clone({precision:80});
const candles=Array.from({length:180},(_,i)=>{const close=100+Math.sin(i/4)*4;return {...moveCandles()[0],time:moveBase+i*moveDuration,open:100+Math.sin((i-1)/4)*4,close,high:105,low:95};});
const base:TrailRun={candles,timeframe:'15m',start:100,end:180,market:{symbol:'BTC',tick:'0.01',lot:'0.001',minimumQuote:'10',maximumQuote:'1000000',minimumPrice:'0.01',maximumPrice:'1000000'},direction:'long',seed:false,mode:'repeat_all',variant:'d',path:'OHLC'};
describe('shipped-cycle historical replay',()=>{
  for(const direction of ['long','short'] as const)for(const seed of [false,true])for(const mode of ['repeat_all','step_back','step_back_edge'] as const){
    it(`conserves cash, inventory and fees: ${direction}/${seed}/${mode}`,()=>{
      const result=runTrailBacktest({...base,direction,seed,mode});
      expect(result.fillCount).toBeGreaterThan(0);
      expect(result.cycleState.reduce((s,c)=>s.plus(c.held),new Decimal(0)).eq(new Decimal(result.position).abs())).toBe(true);
      expect(new D(result.cash).plus(new D(result.position).mul(result.finalMark)).eq(result.finalEquity)).toBe(true);
      const fees=result.executions.reduce((sum,f)=>sum.plus(new Decimal(f.price).mul(f.size).mul(f.kind==='limit'?TRAIL_EXPERIMENT.makerRate:TRAIL_EXPERIMENT.takerRate)),new Decimal(0));
      expect(fees.toNumber()).toBeCloseTo(result.fees,10);
      if(!seed)expect(result.executions.some(f=>f.kind==='seed')).toBe(false);
      for(const c of result.cycleState.filter(c=>c.cycle.recycles===false))expect(c.openingCredit).toBe('0');
    });
  }
  it('is deterministic for both orderings and all five arms',()=>{
    for(const variant of ['a','b','c','d','e'] as const)for(const path of ['OHLC','OLHC'] as const){
      const run={...base,variant,path,end:125};expect(runTrailBacktest(run)).toEqual(runTrailBacktest(run));
    }
  });
  it('does not consult future candles or fill on missing/warm-up bars',()=>{
    const before=runTrailBacktest({...base,end:120}),changed=structuredClone(candles);
    for(let i=120;i<changed.length;i++)changed[i].close=99999;
    expect(runTrailBacktest({...base,candles:changed,end:120})).toEqual(before);
    const gapped=candles.filter((_,i)=>i!==110),result=runTrailBacktest({...base,candles:gapped,end:gapped.length});
    expect(result.holds.gap).toBeGreaterThan(0);
    expect(result.executions.filter(f=>f.side==='buy').every(f=>f.time<gapped[110].time)).toBe(true);
  });
  it('moves only next bar, carries sources without a new seed, and preserves one-shot credits',()=>{
    const trending=Array.from({length:180},(_,i)=>{const price=100+Math.max(0,i-100)*0.3;return {...candles[0],time:moveBase+i*moveDuration,open:price,close:price+0.1,high:price+0.2,low:price-0.1};});
    const result=runTrailBacktest({...base,candles:trending,variant:'c',seed:true,mode:'step_back_edge'});
    expect(result.moves).toBeGreaterThan(0);
    expect(result.executions.filter(f=>f.kind==='seed')).toHaveLength(1);
    expect(result.finalPolicy.epochAuthority).toBeDefined();
    for(const move of result.moveLog){expect(move.activatedAt).toBe(move.decisionAt+1);expect(move.decisionAt%moveDuration).toBe(0);}
    expect(result.ledger.moves.length).toBeLessThanOrEqual(10);
    expect(Number(result.finalPolicy.lowerPrice)-Number(result.ledger.originalLower)).toBeLessThanOrEqual(Number(result.ledger.originalUpper)-Number(result.ledger.originalLower));
    for(const c of result.cycleState.filter(c=>c.cycle.recycles===false))expect(c.openingCredit).toBe('0');
  });
  it('orders a protective stop and touched limits along each explicit path',()=>{
    const data=structuredClone(candles);data[100]={...data[100],high:120,low:70,close:100};
    const a=runTrailBacktest({...base,candles:data,seed:true,path:'OHLC'}),b=runTrailBacktest({...base,candles:data,seed:true,path:'OLHC'});
    expect(a.stopped&&b.stopped).toBe(true);expect(a.position).toBe('0');expect(b.position).toBe('0');
    expect(a.netReturn).not.toBe(b.netReturn);
  });
});
