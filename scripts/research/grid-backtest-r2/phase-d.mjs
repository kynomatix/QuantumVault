import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {loadData,read,sha256} from './data.mjs';
import {signalAt,toBars} from '../grid-direction/core.mjs';
import {aggregateStructureWeeks,computeWeeklyStructure} from '../../../server/grid-planner/weekly-structure.ts';
import {Stats} from './stats.mjs';
const root=process.argv[2],data=loadData(),stats=new Stats(),selected=read(path.join(root,'phase-c-risk-selection.json')).selected,macroSources=[],bindings=[],signals=new Map(),takes=new Map();
const prior='C:/Apps/Replit/conductor-worktrees/grid-direction-backtest-20261019-handback/evidence/direction-20261019T095720Z';
for(const folder of ['snapshot','fallback-snapshot-v2']){
 const dir=path.join(prior,folder),bytes=fs.readFileSync(path.join(dir,'manifest.json'));
 if(sha256(bytes)!==read(path.join(dir,'manifest-sha256.json')).manifestSha256)throw Error('Signal manifest mismatch');
 for(const d of JSON.parse(bytes).datasets.filter(d=>['okx','gate'].includes(d.venue)&&['1d','1w'].includes(d.timeframe))){
  const file=path.join(dir,d.file),bytes=fs.readFileSync(file);if(sha256(bytes)!==d.sha256)throw Error('Signal dataset mismatch');bindings.push({file,sha256:d.sha256});
  const rows=JSON.parse(bytes).rows;
  if(d.timeframe==='1w')macroSources.push({...d,rows});else data.all.push({...d,bars:toBars(rows,d.venue)});
 }
}
const sources=(market,timeframe)=>['pacifica','okx','gate'].map(venue=>({venue,bars:data.all.find(d=>d.venue===venue&&d.symbol===market&&d.timeframe===timeframe)?.bars??[],days:data.all.find(d=>d.venue===venue&&d.symbol===market&&d.timeframe==='1d')?.bars??[]}));
fs.writeFileSync(path.join(root,'phase-d-method.json'),JSON.stringify({selected,bindings,method:'Direction chosen once before launch. Trend is shipped Trend view; majority is strict >50% of available shipped views. Funding direction unavailable without historical fresh /info snapshot; settled payments do not substitute. Neutral/unavailable idle cash. Baseline averages both direction trials on jointly admitted scenarios, not a simultaneous portfolio. Require both sides admitted for like-for-like comparison. Full-size chosen side. Four mark/trade paths.',createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
for(const period of ['development','evaluation','proxy']){
 const fd=fs.openSync(path.join(root,`phase-d-${period}.jsonl`),'wx');let key=null,rows=[];
 const flush=()=>{
  if(!rows.length)return;
  const first=rows[0],sk=[first.market,first.timeframe,first.launchAt].join('|');
  if(!signals.has(sk))signals.set(sk,signalAt({...first,sources:sources(first.market,first.timeframe),macroSources,aggregateStructureWeeks,computeWeeklyStructure}));
  const signal=signals.get(sk),trend=signal.views.find(v=>v.name==='Trend'),available=signal.views.filter(v=>!v.unavailable);
  const majority=['long','short'].find(side=>available.filter(v=>v.direction===side).length>available.length/2)??'neutral';
  for(const pathName of ['OHLC','OLHC'])for(const markPath of ['OHLC','OLHC']){
   const pair=rows.filter(r=>r.path===pathName&&r.markPath===markPath),base={...first,path:pathName,markPath,setting:'unfiltered',admitted:pair.length===2&&pair.every(r=>r.admitted),reason:'not jointly admitted long and short',direction:'averaged'};
   if(base.admitted)base.reason=null;
   if(base.admitted){
    for(const k of ['netReturn','maxDrawdown','fees','fillCount','funding','protectiveStop'])base[k]=pair.reduce((s,r)=>s+r[k],0)/2;
    base.liquidated=pair.some(r=>r.liquidated);
   }
   stats.record(base);stats.pair(base,base);fs.writeSync(fd,JSON.stringify(base)+'\n');
   for(const [setting,side] of [['Trend',trend&&!trend.unavailable?trend.direction:'unavailable'],['majority',majority]]){
    const chosen=pair.find(r=>r.direction===side),row={...base,setting,direction:side,idle:!chosen,signalAudit:signal.inputAudit};
    if(base.admitted){
     for(const k of ['netReturn','maxDrawdown','fees','fillCount','funding','protectiveStop'])row[k]=chosen?.[k]??0;
     row.liquidated=chosen?.liquidated??false;
     const tk=[period,setting].join('|');if(!takes.has(tk))takes.set(tk,{period,setting,n:0,taken:0});takes.get(tk).n++;takes.get(tk).taken+=Number(!!chosen);
    }
    stats.record(row);stats.pair(row,base);fs.writeSync(fd,JSON.stringify(row)+'\n');
   }
  }
 };
 for await(const line of createInterface({input:fs.createReadStream(path.join(root,`phase-c-risk-${period}.jsonl`)),crlfDelay:Infinity})){
  const row=JSON.parse(line);if(row.setting!==selected)continue;
  const next=[row.market,row.timeframe,row.launchAt,row.horizonDays].join('|');
  if(next!==key){flush();rows=[];key=next;}rows.push(row);
 }
 flush();fs.closeSync(fd);
 if(period==='development')fs.writeFileSync(path.join(root,'phase-d-selection.json'),JSON.stringify(stats.select(['unfiltered','Trend','majority'],'unfiltered'),null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(root,'phase-d-summary.json'),JSON.stringify({...stats.json(),takes:[...takes.values()],signals:signals.size},null,2)+'\n');
 fs.writeFileSync(path.join(root,`phase-d-${period}-complete.json`),JSON.stringify({runsSha256:sha256(fs.readFileSync(path.join(root,`phase-d-${period}.jsonl`))),selectionSha256:sha256(fs.readFileSync(path.join(root,'phase-d-selection.json')))},null,2)+'\n');
 console.log(`Direction ${period}: ${stats.admitted}/${stats.total} admitted; ${signals.size} frozen prelaunch signals`);
}
await import('./detail-results.mjs');
