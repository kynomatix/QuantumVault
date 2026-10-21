import {describe,it,expect} from 'vitest';
import {calculateCycleGrid} from '../../server/grid-bot/cycle-engine';
import {fixedReplay} from '../../scripts/research/grid-backtest-r2/fixed-replay.mjs';
import {sizingReplay,equityCrossing} from '../../scripts/research/grid-sizing-stops/replay.mjs';
import {replayStrategy} from '../../scripts/research/grid-sizing-stops/strategy.mjs';
import {weightedTailMean,weightedLowerTails} from '../../scripts/research/grid-sizing-stops/tail-statistics.mjs';
const market={symbol:'EXAMPLE',tick:'0.01',lot:'0.001',minimumQuote:'10',maximumQuote:'10000000',minimumPrice:'0.01',maximumPrice:'1000000'};
function plan(side='long',scale='flat',investment='1000',leverage='1'){
 const result=calculateCycleGrid({side,lower:'80',upper:'120',start:'100',intervals:10,entryScale:scale,profitScale:scale,seed:true,leverage,
  tick:market.tick,lot:market.lot,minimumQuote:'10',maximumQuote:market.maximumQuote,transferFloor:'0',investmentStep:'0.01',investment,effectiveMakerCostRate:'0.00115',policyVersion:'2.2.0',behaviourMode:'step_back',sizingVersion:'lean-1',safetyEnvelopePrice:side==='long'?'120':'130'} as any);
 if(!result.ok)throw Error(result.issues.map(x=>x.reason).join(';'));
 return result.plan;
}
function fixturePolicy(side='long',leverage='1',investment='1000'){
 const p=plan(side,'flat',investment,leverage);
 return {direction:side,totalInvestment:investment,leverage:Number(leverage),lowerPrice:'80',upperPrice:'120',startPrice:'100',gridCount:10,seedAtCreation:true,stopLossPrice:side==='long'?'70':'130',safetyEnvelopePrice:side==='long'?'120':'130',sizingVersion:'lean-1',policyVersion:'2.2.0',runtimePolicyVersion:'2.2.0',feePolicyVersion:'1.0.0',gridPolicyExtension:p.gridPolicyExtension,
 levels:p.lines.map(l=>{const closing=side==='long'?Number(l.price)>100:Number(l.price)<100;return {ordinal:l.ordinal+1,price:l.price,size:l.quantity,reduceOnly:closing,side:side==='long'?(closing?'sell':'buy'):(closing?'buy':'sell')};})};
}
function input(side='long',leverage='1'){
 const policy=fixturePolicy(side,leverage);
 const candles=[{time:0,open:100,high:100,low:100,close:100},{time:3600000,open:100,high:105,low:95,close:101},{time:7200000,open:101,high:110,low:90,close:100}];
 return {candles,market,timeframe:'1h',start:1,end:3,policy,path:'OHLC',markPath:'OHLC',markBars:candles,fundingEvents:[[],[],[]],maxLeverage:50,makerRate:.00115,takerRate:.0014,stopMode:'touch',moveMode:'fixed'};
}
describe('research sizing and stop accounting',()=>{
 it('retains liquidated tail mass and uses fractional boundary weights',()=>{
  expect(weightedTailMean([-1,-.5,0,.2],[1,1,1,1],.01)).toBe(-1);
  expect(weightedTailMean([-1,-.5,0,.2],[1,1,1,1],.375)).toBeCloseTo(-1.25/1.5,12);
  expect(weightedTailMean([-1,-.5,0,.2],[0,2,1,1],.5)).toBe(-.5);
  expect(Number.isNaN(weightedTailMean([-1,0],[0,0],.05))).toBe(true);
  const returns=Array.from({length:150},(_,i)=>-1+i/100);
  for(const weights of [returns.map(()=>1),returns.map((_,i)=>i%7),returns.map((_,i)=>i<100?0:3)]){
   const fast=weightedLowerTails(returns,weights);expect(fast[0]).toBeCloseTo(weightedTailMean(returns,weights,.01),12);expect(fast[1]).toBeCloseTo(weightedTailMean(returns,weights,.05),12);
  }
 });
 it('uses further and near product weights on both sides with the ten-unit floor',()=>{
  for(const side of ['long','short'])for(const scale of ['ascending','descending']){const p=plan(side,scale,'200');
   for(const c of p.cycles.filter(c=>c.recycles!==false))expect(Number(c.quantity)*Number(c.openingPrice)).toBeGreaterThanOrEqual(10-1e-8);
   for(const anchor of ['opening','closing']){const cs=p.cycles.filter(c=>c.anchor===anchor).sort((a,b)=>Math.abs(Number(b[anchor==='opening'?'openingPrice':'closingPrice'])-100)-Math.abs(Number(a[anchor==='opening'?'openingPrice':'closingPrice'])-100));
    const notionals=cs.map(c=>Number(c.quantity)*Number(c[anchor==='opening'?'openingPrice':'closingPrice']));
    expect(scale==='ascending'?notionals[0]>=notionals.at(-1)!:notionals[0]<=notionals.at(-1)!).toBe(true);
   }
  }
 });
 it('agrees with round two for an unchanged shipped-stop path',()=>{for(const side of ['long','short']){const i=input(side),a=fixedReplay(i),b=sizingReplay(i);for(const k of ['netReturn','fees','fillCount','maxDrawdown','funding','protectiveStop'])expect(b[k]).toBeCloseTo(a[k],10);}});
 it('charges terminal taker fees and adverse slippage at trade price',()=>{const i=input();i.markBars=i.candles.map(b=>({...b,close:102}));const a=sizingReplay(i),b=sizingReplay({...i,closeAtHorizon:true});const price=100*.9995;
  expect(b.position).toBe(0);expect(b.finalEquity).toBeCloseTo(a.cash+a.position*price-a.position*price*.0014,9);expect(b.fees).toBeGreaterThan(a.fees);
 });
 it('retains a stopped loss throughout the remaining underwater horizon',()=>{const i=input();i.candles[1]={time:3600000,open:100,high:100,low:60,close:65};i.markBars=i.candles;
  const r=sizingReplay({...i,closeAtHorizon:true});expect(r.protectiveStop).toBe(1);expect(r.hourlyEquities).toHaveLength(2);expect(r.hourlyEquities.every(x=>x<1000)).toBe(true);
 });
 it('no-stop disables touch and close stops while retaining liquidation',()=>{const i=input('long','3');i.candles[1]={time:3600000,open:100,high:100,low:1,close:1};i.markBars=i.candles;
  const r=sizingReplay({...i,stopMode:'none',closeAtHorizon:true});expect(r.liquidated).toBe(true);expect(r.protectiveStop).toBe(0);expect(r.netReturn).toBeLessThan(-.5);
 });
 it('disaster loss triggers on mark equity including accumulated costs',()=>{const i=input();i.candles[1]={time:3600000,open:100,high:100,low:50,close:60};i.markBars=i.candles;
  const r=sizingReplay({...i,stopMode:'none',equityFloor:900,closeAtHorizon:true});expect(r.protectiveStop).toBe(1);expect(r.liquidated).toBe(false);expect(r.finalEquity).toBeLessThanOrEqual(900);expect(r.finalEquity).toBeGreaterThan(895);
 });
 it('solves both long and short loss crossings and immediate gaps',()=>{expect(equityCrossing(0,10,900,100,80)).toBe(.5);expect(equityCrossing(2000,-10,900,100,120)).toBe(.5);expect(equityCrossing(0,10,900,80,70)).toBe(0);expect(equityCrossing(1000,0,900,100,80)).toBe(null);});
 it('waits a complete bar, caps relaunches, and accumulates every leg cost',()=>{
  const i=input();i.candles=Array.from({length:8},(_,k)=>({time:k*3600000,open:100,high:101,low:k%2===1?60:99,close:100}));i.markBars=i.candles;i.end=8;i.fundingEvents=i.candles.map(()=>[]);
  const first=sizingReplay({...i,closeAtHorizon:true}),starts:number[]=[],cash:number[]=[];
  const r=replayStrategy({...i,closeAtHorizon:true},'reenter2',({nextIndex,cash:balance})=>{starts.push(nextIndex);cash.push(balance);return fixturePolicy('long','1',String(Math.floor(balance*100)/100));});
  expect(starts).toEqual([3,5]);expect(r.reentries).toBe(2);expect(r.protectiveStop).toBe(3);expect(r.fees).toBeGreaterThan(first.fees);expect(r.finalEquity).toBeLessThan(first.finalEquity);expect(cash[1]).toBeLessThan(cash[0]);expect(r.underwaterDays).toBe(7/24);
 });
 it('never relaunches at the horizon and retains rejected relaunch cash',()=>{
  const i=input();i.candles[1]={time:3600000,open:100,high:100,low:60,close:100};i.markBars=i.candles;
  let calls=0;const r=replayStrategy({...i,closeAtHorizon:true},'reenter3',()=>{calls++;throw Error('EXAMPLE rejection');});expect(calls).toBe(0);expect(r.reentries).toBe(0);
  i.candles.push({time:10800000,open:100,high:100,low:100,close:100});i.end=4;
  const rejected=replayStrategy({...i,closeAtHorizon:true},'reenter3',()=>{throw Error('EXAMPLE rejection');});expect(rejected.reentryRejected).toBe('EXAMPLE rejection');expect(rejected.finalEquity).toBe(r.finalEquity);
 });
});
