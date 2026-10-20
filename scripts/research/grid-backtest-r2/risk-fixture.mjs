import fs from 'node:fs';
import os from 'node:os';
import {makeTrailGrid,runTrailBacktest} from '../../../server/grid-bot/trail-backtest.ts';
import {calculateCycleGrid} from '../../../server/grid-bot/cycle-engine.ts';
const market={symbol:'BTC',tick:'0.01',lot:'0.001',minimumQuote:'10',maximumQuote:'5000000',minimumPrice:'0.01',maximumPrice:'1000000'};
if(os.freemem()<1.8*1024**3)throw Error('Low memory: no second worker');
const geometry={lower:'100.00000000',upper:'124.00000000',longStop:'75.00000000',shortStop:'149.00000000'};
const provenance={source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'};
const cases=[];
for(const direction of ['long','short'])for(const leverage of [1,3,5,10]){
 const economics={investment:'1000.00',leverage,makerRate:'0.00115',takerRate:'0.0014'};
 const input={market,geometry,economics,direction,seed:true,mode:'step_back',intervals:10,variant:'a',timeframe:'1h',start:100,end:130,path:'OHLC'};
 const bars=Array.from({length:130},(_,i)=>{const price=112+(i<100?0:Math.sin((i-100)*0.6)*9);return {time:Date.UTC(2026,0,1)+i*3600000,open:price,high:price+2,low:price-2,close:price,volume:1,provenance};});
 const policy=makeTrailGrid(input,'112'),envelope=direction==='long'?geometry.upper:geometry.shortStop;
 const plan=calculateCycleGrid({side:direction,lower:geometry.lower,upper:geometry.upper,start:'112',intervals:10,entryScale:'flat',profitScale:'flat',seed:true,leverage:String(leverage),tick:market.tick,lot:market.lot,minimumQuote:'10',maximumQuote:market.maximumQuote,investmentStep:'0.01',transferFloor:'0',investment:'1000.00',effectiveMakerCostRate:economics.makerRate,policyVersion:'2.2.0',behaviourMode:'step_back',sizingVersion:'lean-1',safetyEnvelopePrice:envelope});
 if(!plan.ok)throw Error('Fixture planner failed');
 const r=runTrailBacktest({...input,candles:bars});
 cases.push({policy,plan:plan.plan,bars,market,leverage,expected:{netReturn:r.netReturn,fees:r.fees,fillCount:r.fillCount}});
}
fs.writeFileSync('tests/research/fixtures/grid-backtest-r2-risk.json',JSON.stringify({cases})+'\n',{flag:'wx'});
console.log(`Reference economic fixtures: ${cases.length}; freeGB=${(os.freemem()/1024**3).toFixed(2)}`);
