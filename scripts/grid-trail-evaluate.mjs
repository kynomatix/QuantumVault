// Plain Node 24 entry: node --experimental-transform-types --import <extension-resolution-hook> scripts/grid-trail-evaluate.mjs <snapshot> <NEW output>
// In a normal dependency-equipped checkout the hook only resolves extensionless TS imports.
import {readFile,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runTrailBacktest,TRAIL_EXPERIMENT} from '../server/grid-bot/trail-backtest.ts';
import {GRID_TRAIL_POLICY} from '../server/grid-bot/trail-policy.ts';
const [source,out]=process.argv.slice(2);
if(!source||!out)throw Error('snapshot and new output directory required');
await mkdir(out);
const manifestBytes=await readFile(join(source,'manifest.json')),manifest=JSON.parse(manifestBytes);
if(manifest.datasets.length!==15)throw Error('All five markets and three timeframes are required');
const configuration={experiment:TRAIL_EXPERIMENT,policy:GRID_TRAIL_POLICY,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex')};
await writeFile(join(out,'configuration.json'),JSON.stringify(configuration,null,2));
const rows=[],coverage=[],started=Date.now();
for(const dataset of manifest.datasets){
  const bytes=await readFile(join(source,dataset.file));
  if(createHash('sha256').update(bytes).digest('hex')!==dataset.sha256)throw Error('Candle checksum mismatch');
  const raw=JSON.parse(bytes),bars=raw.rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,
    provenance:{source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
  const native=manifest.markets.find(m=>m.symbol===dataset.symbol);
  const market={symbol:dataset.symbol,tick:native.tick_size,lot:native.lot_size,minimumQuote:native.min_order_size,
    maximumQuote:native.max_order_size,minimumPrice:Number(native.min_tick)>0?native.min_tick:native.tick_size,maximumPrice:native.max_tick};
  const split=bars.findIndex(b=>b.time>=Date.parse(TRAIL_EXPERIMENT.split));
  if(split<GRID_TRAIL_POLICY.indicatorBars+1)throw Error('Insufficient chronological development history');
  coverage.push({market:dataset.symbol,timeframe:dataset.timeframe,bars:bars.length,first:new Date(bars[0].time).toISOString(),last:new Date(bars.at(-1).time).toISOString(),
    missingBars:dataset.gaps.reduce((s,g)=>s+g.missing,0),developmentBars:split-100,evaluationBars:bars.length-split});
  for(const [period,start,end] of [['development',100,split],['evaluation',split,bars.length]]){
    for(const direction of ['long','short'])for(const seed of [false,true])for(const mode of ['repeat_all','step_back','step_back_edge'])for(const variant of ['a','b','c','d','e'])for(const path of ['OHLC','OLHC']){
      const result=runTrailBacktest({candles:bars,timeframe:dataset.timeframe,start,end,market,direction,seed,mode,variant,path});
      const {finalPolicy,ledger,cycleState,executions,...metrics}=result;
      const row={market:market.symbol,timeframe:dataset.timeframe,period,...metrics};
      rows.push(row);await appendFile(join(out,'runs.jsonl'),JSON.stringify(row)+'\n');
    }
  }
  console.log(`${dataset.symbol} ${dataset.timeframe}: completed ${rows.length} runs`);
}
function aggregate(group){
  const sum=k=>group.reduce((s,r)=>s+r[k],0),holds={};
  for(const r of group)for(const [reason,count] of Object.entries(r.holds))holds[reason]=(holds[reason]??0)+count;
  return {n:group.length,netReturn:sum('netReturn')/group.length,meanDrawdown:sum('maxDrawdown')/group.length,worstDrawdown:Math.max(...group.map(r=>r.maxDrawdown)),
    moves:sum('moves'),fees:sum('fees')/group.length,fills:sum('fillCount'),outPercent:sum('activeMs')?sum('outMs')/sum('activeMs'):0,
    stopped:group.filter(r=>r.stopped).length,holds};
}
const summary=[];
for(const period of ['development','evaluation'])for(const variant of ['a','b','c','d','e']){
  const group=rows.filter(r=>r.period===period&&r.variant===variant);
  for(const path of ['OHLC','OLHC'])summary.push({period,variant,ordering:path,...aggregate(group.filter(r=>r.path===path))});
  const pessimistic=[],optimistic=[];
  for(let i=0;i<group.length;i+=2){const pair=group.slice(i,i+2).sort((a,b)=>a.netReturn-b.netReturn);pessimistic.push(pair[0]);optimistic.push(pair[1]);}
  summary.push({period,variant,ordering:'pessimistic',...aggregate(pessimistic)},{period,variant,ordering:'optimistic',...aggregate(optimistic)});
}
const strata=[];
for(const field of ['market','timeframe','direction','seed','mode'])for(const value of [...new Set(rows.map(r=>r[field]))])for(const variant of ['a','b','c','d','e'])for(const path of ['OHLC','OLHC']){
  strata.push({field,value,variant,path,...aggregate(rows.filter(r=>r.period==='evaluation'&&r[field]===value&&r.variant===variant&&r.path===path))});
}
await writeFile(join(out,'summary.json'),JSON.stringify({configuration,coverage,summary,strata,elapsedSeconds:(Date.now()-started)/1000},null,2));
console.log(`Finished ${rows.length} runs; summary.json written`);
