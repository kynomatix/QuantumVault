// Single-worker offline evaluation. No production bootstrap, DB, or network.
import {writeFileSync,appendFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {freemem} from 'node:os';
import {loadData,readLines,prior,sha256} from './io.mjs';
import {signalAt,classifySignals,DAY,duration} from './core.mjs';
import {aggregateStructureWeeks,computeWeeklyStructure} from '../../../server/grid-planner/weekly-structure.ts';
import {runTrailBacktest,makeTrailGrid,TRAIL_EXPERIMENT} from '../../../server/grid-bot/trail-backtest.ts';
import {rollingWindows,plannerLaunchGeometry} from '../../../server/grid-bot/trail-rolling.ts';
const [evidence,phase,marketFilter='',output='evaluation-v3']=process.argv.slice(2),started=Date.now(),out=join(evidence,output,phase+(marketFilter?'-'+marketFilter:''));
mkdirSync(join(evidence,output),{recursive:true});
if(!['pacifica','2022','2023','2024','2025'].includes(phase))throw Error('Phase required');
mkdirSync(out);const data=loadData(evidence),signals=new Map(),rejected=[],equivalence=[],counts={read:0,runs:0,minFreeGiB:freemem()/1024**3};
function getSignal(row){const key=[row.market,row.timeframe,row.launchAt].join('|');let s=signals.get(key);if(!s){s=signalAt({...row,sources:data.sources(row.market,row.timeframe),macroSources:data.macroSources,aggregateStructureWeeks,computeWeeklyStructure});signals.set(key,s);appendFileSync(join(out,'signals.jsonl'),JSON.stringify(s)+'\n');}return s;}
function record(row){const s=getSignal(row),compact={period:row.period,market:row.market,timeframe:row.timeframe,launchAt:row.launchAt,endAt:row.endAt,horizonDays:row.horizonDays,direction:row.direction,seed:row.seed,mode:row.mode,path:row.path,netReturn:row.netReturn,maxDrawdown:row.maxDrawdown,stopped:row.stopped,fees:row.fees,missingMs:row.missingMs,macroRegime:s.macro.regime,availableSignals:s.views.filter(v=>!v.unavailable).length,classes:classifySignals(s.views,row.direction)};appendFileSync(join(out,'runs.jsonl'),JSON.stringify(compact)+'\n');counts.runs++;}
if(phase==='pacifica'){
  const done=new Set();
  await readLines(join(prior,'runs.jsonl'),row=>{
    counts.read++;if(row.variant!=='a')return;
    if(!['1h','4h'].includes(row.timeframe)||!['OHLC','OLHC'].includes(row.path))throw Error('Unexpected prior axis');
    const key=[row.market,row.timeframe,row.path].join('|');
    if(!done.has(key)){
      const d=data.pacifica.find(d=>d.symbol===row.market&&d.timeframe===row.timeframe),start=d.bars.findIndex(b=>b.time===row.launchAt),end=d.bars.findIndex(b=>b.time===row.endAt-duration(row.timeframe))+1;
      const g=plannerLaunchGeometry(d.bars,row.timeframe,start,data.metadata(row.market).tick);if(!g.ok)throw Error('Prior geometry unavailable');
      const result=runTrailBacktest({...row,...g,candles:d.bars,market:data.metadata(row.market),start,end});
      for(const field of ['netReturn','maxDrawdown','stopped','fees','fillCount'])if(result[field]!==row[field])throw Error(`Prior replay mismatch ${key}/${field}`);
      equivalence.push({key,launchAt:row.launchAt,fields:['netReturn','maxDrawdown','stopped','fees','fillCount'],exact:true});done.add(key);
    }
    record(row);
  });
  if(counts.read!==134640||counts.runs!==26928||equivalence.length!==20)throw Error('Prior evidence cardinality mismatch');
}else{
  for(const market of (marketFilter?[marketFilter]:['BTC','ETH','SOL']))for(const timeframe of ['1h','4h']){
    const bars=data.sources(market,timeframe)[0].bars,metadata=data.metadata(market);
    const stop=data.pacifica.find(d=>d.symbol===market&&d.timeframe===timeframe).bars[0].time;
    for(const horizonDays of [14,30])for(const w of rollingWindows(bars,timeframe,Date.parse('2022-01-02T00:00:00Z'),stop,horizonDays)){
      if(new Date(w.launchAt).getUTCFullYear()!==Number(phase))continue;
      counts.minFreeGiB=Math.min(counts.minFreeGiB,freemem()/1024**3);
      if(w.hold){rejected.push({market,timeframe,horizonDays,...w});continue;}
      const g=plannerLaunchGeometry(bars,timeframe,w.start,metadata.tick);if(!g.ok){rejected.push({market,timeframe,horizonDays,...w,hold:g.reason});continue;}
      for(const direction of ['long','short'])for(const seed of [false,true])for(const mode of ['repeat_all','step_back','step_back_edge']){
        const input={...w,...g,market:metadata,timeframe,candles:bars,direction,seed,mode,variant:'a'};
        try{makeTrailGrid(input,String(bars[w.start-1].close));}catch(e){rejected.push({market,timeframe,horizonDays,launchAt:w.launchAt,direction,seed,mode,reason:e.message});continue;}
        for(const path of ['OHLC','OLHC']){const result=runTrailBacktest({...input,path});record({...result,market,timeframe,period:'proxy',horizonDays,launchAt:w.launchAt,endAt:w.endAt});}
      }
    }
    console.log(`${phase} ${market} ${timeframe} complete; cumulative ${counts.runs} runs`);
  }
}
const hashes=Object.fromEntries(['core.mjs','io.mjs','evaluate.mjs','loader.mjs','proxy-policy.mjs'].map(f=>[f,sha256(readFileSync(new URL(f,import.meta.url)))]));
writeFileSync(join(out,'run-record.json'),JSON.stringify({phase,startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString(),seconds:(Date.now()-started)/1000,workerCount:1,...counts,uniqueLaunches:signals.size,economics:TRAIL_EXPERIMENT,priorManifestSha256:data.priorManifestSha256,snapshotManifestSha256:data.snapshot.manifestSha256,fallbackManifestSha256:data.fallback.manifestSha256,runtimeFileSha256:hashes,equivalence,rejected},null,2));
console.log(`${phase}: ${counts.runs} runs, ${signals.size} launches, ${rejected.length} holds, ${((Date.now()-started)/1000).toFixed(1)} seconds`);