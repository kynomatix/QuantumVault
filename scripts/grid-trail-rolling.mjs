// Plain Node 24: --experimental-transform-types --import ./scripts/grid-trail-loader.mjs
// This offline evaluation never imports application bootstrap or contacts a database.
import {readFileSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {runTrailBacktest,makeTrailGrid,TRAIL_EXPERIMENT,trailDuration} from '../server/grid-bot/trail-backtest.ts';
import {TRAIL_ROLLING,rollingWindows,plannerLaunchGeometry} from '../server/grid-bot/trail-rolling.ts';
import {GRID_TRAIL_POLICY} from '../server/grid-bot/trail-policy.ts';

const [source,out,flag]=process.argv.slice(2);
if(!source||!out||flag&&!['--pilot-only','--omit-15m'].includes(flag))throw Error('snapshot, NEW output directory, optional --pilot-only or --omit-15m required');
mkdirSync(out);
const started=Date.now(),hash=b=>createHash('sha256').update(b).digest('hex');
const manifestBytes=readFileSync(join(source,'manifest.json')),manifest=JSON.parse(manifestBytes);
const split=Date.parse(TRAIL_ROLLING.split),finish=Date.parse(TRAIL_ROLLING.endExclusive),day=86_400_000;
const configuration={rolling:TRAIL_ROLLING,policy:GRID_TRAIL_POLICY,
  economics:{investment:TRAIL_EXPERIMENT.investment,leverage:TRAIL_EXPERIMENT.leverage,intervals:TRAIL_EXPERIMENT.intervals,
    makerRate:TRAIL_EXPERIMENT.makerRate,takerRate:TRAIL_EXPERIMENT.takerRate,marketSlippage:TRAIL_EXPERIMENT.marketSlippage,fundingIncluded:false},
  geometry:'Shipped timeWindowRange, week; PlannerRangeFacts tick rounding; pre-launch chart history only',
  referenceCohorts:'First favourable wick breakout versus initial protective stop under the named ordering; treatment-independent; stop-first terminates reference run',
  manifestSha256:hash(manifestBytes),sourceDirectory:source,createdAt:new Date().toISOString()};
writeFileSync(join(out,'configuration.json'),JSON.stringify(configuration,null,2));
const datasets=[],coverage=[],launchHolds=[];
for(const dataset of manifest.datasets){
  const bytes=readFileSync(join(source,dataset.file));if(hash(bytes)!==dataset.sha256)throw Error('Candle checksum mismatch');
  const raw=JSON.parse(bytes),bars=raw.rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,
    provenance:{source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
  const native=manifest.markets.find(m=>m.symbol===dataset.symbol),timeframe=dataset.timeframe;
  const market={symbol:dataset.symbol,tick:native.tick_size,lot:native.lot_size,minimumQuote:native.min_order_size,
    maximumQuote:native.max_order_size,minimumPrice:Number(native.min_tick)>0?native.min_tick:native.tick_size,maximumPrice:native.max_tick};
  // Same UTC weekly calendar in both periods; first development launch has at least
  // 100 closed bars and 1.5 weeks of planner history, regardless of the market's listing date.
  const earliest=bars[0].time+Math.max(100*trailDuration(timeframe),10.5*day);
  const developmentStart=split-Math.floor((split-earliest)/(7*day))*7*day;
  const windows=[];
  for(const [period,from,to] of [['development',developmentStart,split],['evaluation',split,finish]]){
    for(const horizonDays of TRAIL_ROLLING.horizonsDays)for(const w of rollingWindows(bars,timeframe,from,to,horizonDays)){
      const item={period,horizonDays,...w};
      if(w.hold){launchHolds.push({market:market.symbol,timeframe,...item});continue;}
      const g=plannerLaunchGeometry(bars,timeframe,w.start,market.tick);
      if(!g.ok){launchHolds.push({market:market.symbol,timeframe,...item,hold:g.reason});continue;}
      windows.push({...item,...g});
    }
  }
  datasets.push({bars,market,timeframe,windows});
  coverage.push({market:market.symbol,timeframe,first:bars[0].time,last:bars.at(-1).time,bars:bars.length,
    missingBars:dataset.gaps.reduce((s,g)=>s+g.missing,0),developmentStart,launchHorizonCells:windows.length});
}
if(datasets.length!==15||new Set(datasets.map(d=>d.market.symbol)).size!==5)throw Error('Expected five markets and three timeframes');
const combinations=function*(){for(const direction of ['long','short'])for(const seed of [false,true])for(const mode of ['repeat_all','step_back','step_back_edge'])yield {direction,seed,mode};};
const variants=['a','b','c','d','e'],paths=['OHLC','OLHC'];
const rejected=[],pilot=[];
// Timing only, development data only, all mode/seed/direction/arm/path combinations.
// Parameters are already frozen above; this selects computational coverage, never thresholds.
for(const timeframe of ['15m','1h','4h']){
  const d=datasets.find(d=>d.timeframe===timeframe&&d.market.symbol==='BTC');
  const w=d.windows.find(w=>w.period==='development'&&w.horizonDays===30);
  if(!w)throw Error('Missing runtime pilot window');
  const t=Date.now();let runs=0;
  for(const combo of combinations()){
    const input={...d,...w,...combo,variant:'a',path:'OHLC'};
    try{makeTrailGrid(input,String(d.bars[w.start-1].close));}catch{continue;}
    for(const variant of variants)for(const path of paths){runTrailBacktest({...input,candles:d.bars,variant,path});runs++;}
  }
  const elapsedSeconds=(Date.now()-t)/1000;
  const projectedSeconds=elapsedSeconds*datasets.filter(x=>x.timeframe===timeframe).reduce((s,d)=>s+d.windows.reduce((n,w)=>n+w.horizonDays/30,0),0);
  pilot.push({timeframe,runs,elapsedSeconds,projectedSeconds,launchAt:w.launchAt,period:'development'});
  writeFileSync(join(out,'runtime-pilot.json'),JSON.stringify(pilot,null,2));
  console.log(`Runtime pilot ${timeframe}: ${runs} runs in ${elapsedSeconds.toFixed(1)} seconds; projection ${(projectedSeconds/60).toFixed(1)} minutes`);
}
if(flag==='--pilot-only')process.exit(0);
const projectedAll=pilot.reduce((s,p)=>s+p.projectedSeconds,0),omit15m=flag==='--omit-15m'||projectedAll>90*60;
const selected=datasets.filter(d=>!omit15m||d.timeframe!=='15m');
const workerCount=2;
writeFileSync(join(out,'runtime-selection.json'),JSON.stringify({omit15m,projectedAllSeconds:projectedAll,
  workerCount,selectedSerialProjectionSeconds:pilot.filter(p=>!omit15m||p.timeframe!=='15m').reduce((s,p)=>s+p.projectedSeconds,0),
  selectedProjectionSeconds:pilot.filter(p=>!omit15m||p.timeframe!=='15m').reduce((s,p)=>s+p.projectedSeconds,0)/workerCount,
  reason:omit15m?'Drop 15m first to keep the rolling evaluation light':'All timeframes fit the timing estimate'},null,2));
const aggregations=new Map();let completedRuns=0;
function accumulate(row,ordering,group){
  const key=[row.period,row.variant,ordering,group].join('|');
  let a=aggregations.get(key);
  if(!a){a={period:row.period,variant:row.variant,ordering,group,n:0,returns:[],returnSum:0,drawdownSum:0,worstDrawdown:0,
    moves:0,feesSum:0,fills:0,activeMs:0,outMs:0,stopped:0,profitable:0,holds:{}};aggregations.set(key,a);}
  a.n++;a.returns.push(row.netReturn);a.returnSum+=row.netReturn;a.drawdownSum+=row.maxDrawdown;a.worstDrawdown=Math.max(a.worstDrawdown,row.maxDrawdown);
  a.moves+=row.moves;a.feesSum+=row.fees;a.fills+=row.fillCount;a.activeMs+=row.activeMs;a.outMs+=row.outMs;
  a.stopped+=Number(row.stopped);a.profitable+=Number(row.netReturn>0);
  for(const [reason,count] of Object.entries(row.holds))a.holds[reason]=(a.holds[reason]??0)+count;
}
function record(row,ordering,bounds=false){
  accumulate(row,ordering,'overall');
  for(const field of ['horizonDays','market','timeframe','direction','seed','mode'])accumulate(row,ordering,`${field}=${row[field]}`);
  accumulate(row,ordering,`cell=${row.market}/${row.timeframe}/${row.horizonDays}d`);
  // Per-run return extrema can choose different paths across arms. Conditional
  // comparisons therefore use the two common explicit paths, never selected extrema.
  if(!bounds){accumulate(row,ordering,`cohort=${row.cohort}`);accumulate(row,ordering,`horizonCohort=${row.horizonDays}/${row.cohort}`);}
}
let nextDataset=0;
await Promise.all(Array.from({length:workerCount},async()=>{
  while(nextDataset<selected.length){
    const d=selected[nextDataset++];
    await new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./grid-trail-rolling-worker.mjs',import.meta.url),{workerData:d});
      worker.on('error',reject);
      worker.on('message',({rows,rejected:invalid})=>{
        rejected.push(...invalid);
        for(let i=0;i<rows.length;i+=2){
          const pair=rows.slice(i,i+2);
          if(pair[0].path!=='OHLC'||pair[1].path!=='OLHC'||pair[0].variant!==pair[1].variant)throw Error('Unpaired worker result');
          for(const row of pair)record(row,row.path);
          pair.sort((a,b)=>a.netReturn-b.netReturn);record(pair[0],'pessimistic',true);record(pair[1],'optimistic',true);
        }
        if(rows.length)appendFileSync(join(out,'runs.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
        completedRuns+=rows.length;
      });
      worker.on('exit',code=>code===0?resolve():reject(Error('Worker exit '+code)));
    });
    console.log(`${d.market.symbol} ${d.timeframe}: dataset completed`);
  }
}));
const summary=[...aggregations.values()].map(a=>{
  a.returns.sort((x,y)=>x-y);const mid=Math.floor(a.n/2),median=a.n%2?a.returns[mid]:(a.returns[mid-1]+a.returns[mid])/2;
  const {returns,returnSum,drawdownSum,feesSum,...rest}=a;
  return {...rest,netReturn:returnSum/a.n,medianReturn:median,profitableShare:a.profitable/a.n,meanDrawdown:drawdownSum/a.n,
    fees:feesSum/a.n,outPercent:a.activeMs?a.outMs/a.activeMs:0,meanMoves:a.moves/a.n};
});
writeFileSync(join(out,'launch-holds.json'),JSON.stringify(launchHolds,null,2));
writeFileSync(join(out,'launch-rejections.json'),JSON.stringify(rejected,null,2));
writeFileSync(join(out,'summary.json'),JSON.stringify({configuration,coverage,omittedTimeframes:omit15m?['15m']:[],completedRuns,
  launchHolds:launchHolds.filter(h=>!omit15m||h.timeframe!=='15m').length,rejectedCombinations:rejected.length,summary,elapsedSeconds:(Date.now()-started)/1000},null,2));
console.log(`Finished ${completedRuns} rolling runs in ${((Date.now()-started)/60000).toFixed(1)} minutes`);
