// One offline simulation worker; no app bootstrap, network, database or production writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {loadData,readLines,prior,sha256} from '../grid-direction/io.mjs';
import {settings,selectDevelopment} from './design.mjs';
import {geometryAt,widerGeometry} from './geometry.mjs';
import {rollingWindows,plannerLaunchGeometry} from '../../../server/grid-bot/trail-rolling.ts';
import {makeTrailGrid,runTrailBacktest,TRAIL_EXPERIMENT} from '../../../server/grid-bot/trail-backtest.ts';

const [evidence,sourceEvidence]=process.argv.slice(2),started=Date.now(),DAY=86400000,split=Date.parse('2026-03-01T00:00:00Z'),finish=Date.parse('2026-10-19T00:00:00Z');
const write=(name,value)=>fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2)+'\n');
if(fs.existsSync(path.join(evidence,'runs-development.jsonl')))throw Error('Fresh evaluation root required');
const commitHash=execFileSync('git',['-C',path.join(evidence,'scratch'),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const prereg=fs.readFileSync(new URL('./PREREGISTRATION.md',import.meta.url));
const committed=execFileSync('git',['-C',path.join(evidence,'scratch'),'show','HEAD:scripts/research/grid-defaults/PREREGISTRATION.md']);
if(prereg.toString().replaceAll('\r\n','\n')!==committed.toString().replaceAll('\r\n','\n'))throw Error('Uncommitted registration');
const data=loadData(sourceEvidence),record={startedAt:new Date(started).toISOString(),host:os.hostname(),node:process.version,workerCount:1,commitHash,
  preregistrationSha256:sha256(prereg),pacificaManifestSha256:data.priorManifestSha256,proxyManifestSha256:data.snapshot.manifestSha256,fallbackManifestSha256:data.fallback.manifestSha256,
  economics:TRAIL_EXPERIMENT,settings,minimumFreeGiB:os.freemem()/1024**3,phases:[],equivalence:[]};
for(const name of ['design.mjs','loader.mjs','geometry.mjs','run.mjs']){record.runtimeFiles??=[];record.runtimeFiles.push({file:name,sha256:sha256(fs.readFileSync(new URL(name,import.meta.url)))});}
write('run-record.json',record);
// Reproduce old engine rows with the adapter's eight-interval fallback, then compare actual planner geometry.
const seen=new Set();
await readLines(path.join(prior,'runs.jsonl'),async row=>{
  const key=[row.market,row.timeframe,row.path].join('|');
  if(row.variant!=='a'||!['1h','4h'].includes(row.timeframe)||!['OHLC','OLHC'].includes(row.path)||seen.has(key))return;
  const d=data.pacifica.find(d=>d.symbol===row.market&&d.timeframe===row.timeframe),start=d.bars.findIndex(b=>b.time===row.launchAt),duration=row.timeframe==='1h'?3600000:14400000;
  const end=d.bars.findIndex(b=>b.time===row.endAt-duration)+1,market=data.metadata(row.market),g=await geometryAt(d.bars,row.timeframe,start,market,'week');
  if(!g.ok)throw Error('Equivalence geometry unavailable');
  const old=plannerLaunchGeometry(d.bars,row.timeframe,start,market.tick);
  for(const k of ['lower','upper','longStop','shortStop'])if(Number(g.geometry[k])!==Number(old.geometry[k]))throw Error('Planner geometry mismatch');
  const result=runTrailBacktest({...row,...g,candles:d.bars,market,start,end});
  for(const field of ['netReturn','maxDrawdown','stopped','fees','fillCount'])if(result[field]!==row[field])throw Error(`Replay equivalence mismatch ${key}/${field}`);
  seen.add(key);record.equivalence.push({key,launchAt:row.launchAt,exact:true});
});
if(seen.size!==20)throw Error('Missing equivalence cells');
write('equivalence.json',record.equivalence);
let selection=null;
for(const period of ['development','evaluation','proxy']){
  const phaseStart=Date.now(),fd=fs.openSync(path.join(evidence,`runs-${period}.jsonl`),'wx'),gd=fs.openSync(path.join(evidence,`geometry-${period}.jsonl`),'wx');
  const devRows=[],counts={period,scheduled:0,admitted:0,rejected:0};
  for(const symbol of period==='proxy'?['BTC','ETH','SOL']:['BTC','ETH','SOL','HYPE','ZEC'])for(const timeframe of ['1h','4h']){
    const pd=data.pacifica.find(d=>d.symbol===symbol&&d.timeframe===timeframe),bars=period==='proxy'?data.sources(symbol,timeframe)[0].bars:pd.bars;
    if(!bars.length)throw Error('Missing frozen dataset');
    const duration=timeframe==='1h'?3600000:14400000,market=data.metadata(symbol);
    if(Number(market.minimumQuote)!==10)throw Error('Frozen minimum differs from registered $10');
    const earliest=bars[0].time+Math.max(100*duration,10.5*DAY),developmentStart=split-Math.floor((split-earliest)/(7*DAY))*7*DAY;
    const from=period==='proxy'?Date.parse('2022-01-02T00:00:00Z'):period==='development'?developmentStart:split;
    const to=period==='proxy'?pd.bars[0].time:period==='development'?split:finish,geometryCache=new Map();
    for(const horizonDays of [14,30])for(const w of rollingWindows(bars,timeframe,from,to,horizonDays)){
      record.minimumFreeGiB=Math.min(record.minimumFreeGiB,os.freemem()/1024**3);
      for(const setting of settings){
        const cacheKey=`${w.launchAt}/${setting.window}`;
        if(!geometryCache.has(cacheKey)){
          const g=w.hold?{ok:false,reason:w.hold}:await geometryAt(bars,timeframe,w.start,market,setting.window);
          geometryCache.set(cacheKey,g);fs.writeSync(gd,JSON.stringify({symbol,timeframe,launchAt:w.launchAt,window:setting.window,...g})+'\n');
        }
        const g=geometryCache.get(cacheKey),geometry=g.ok?widerGeometry(g.geometry,setting.multiplier,market.tick):null;
        for(const direction of ['long','short']){
          const input={...w,geometry,intervals:setting.intervals,market,timeframe,candles:bars,direction,seed:true,mode:setting.mode,variant:'a'};
          let reason=g.ok?null:g.reason,policy=null;
          if(!reason){try{policy=makeTrailGrid(input,String(bars[w.start-1].close));}catch(error){reason=error.message;}}
          if(policy&&policy.gridCount!==setting.intervals)throw Error('Interval adapter not effective');
          if(policy)for(const c of policy.gridPolicyExtension.cycles){if(c.recycles!==false&&Number(c.quantity)*Number(c.openingPrice)<10-1e-8)throw Error('Opening minimum violated');}
          for(const pathName of ['OHLC','OLHC']){
            const row={period,setting:setting.id,market:symbol,timeframe,horizonDays,direction,path:pathName,launchAt:w.launchAt,endAt:w.endAt,
              key:[symbol,timeframe,horizonDays,direction,pathName,w.launchAt].join('|'),admitted:!reason};
            if(reason){row.reason=reason;counts.rejected++;}
            else{
              const r=runTrailBacktest({...input,path:pathName});
              if(r.moves!==0)throw Error('Fixed range moved');
              Object.assign(row,{netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,fees:r.fees,fillCount:r.fillCount,protectiveStop:r.holds.protective_stop?1:0,
                seedHold:!!r.holds.launch_seed_slippage,stopped:r.stopped,missingMs:r.missingMs,openingLiftCount:policy.gridPolicyExtension.openingOrderLift?.count??0});
              counts.admitted++;
            }
            fs.writeSync(fd,JSON.stringify(row)+'\n');counts.scheduled++;if(period==='development')devRows.push(row);
          }
        }
      }
    }
    console.log(`${period} ${symbol} ${timeframe}: ${counts.scheduled} scheduled, ${counts.admitted} admitted`);
  }
  fs.closeSync(fd);fs.closeSync(gd);counts.seconds=(Date.now()-phaseStart)/1000;
  counts.runsSha256=sha256(fs.readFileSync(path.join(evidence,`runs-${period}.jsonl`)));record.phases.push(counts);
  if(period==='development'){
    selection={createdAt:new Date().toISOString(),developmentRunsSha256:counts.runsSha256,...selectDevelopment(devRows)};
    write('development-selection.json',selection);record.selectionSha256=sha256(fs.readFileSync(path.join(evidence,'development-selection.json')));
    console.log(`Development locked: ${selection.selected??'no eligible change'}`);
  }else if(record.selectionSha256!==sha256(fs.readFileSync(path.join(evidence,'development-selection.json'))))throw Error('Selection changed after development');
  write('run-record.json',record);
}
record.completedAt=new Date().toISOString();record.seconds=(Date.now()-started)/1000;write('run-record.json',record);write('COMPLETE.json',{completedAt:record.completedAt,runRecordSha256:sha256(fs.readFileSync(path.join(evidence,'run-record.json')))});
console.log(`Complete: ${record.phases.reduce((s,p)=>s+p.admitted,0)} admitted runs in ${record.seconds.toFixed(1)} seconds`);
