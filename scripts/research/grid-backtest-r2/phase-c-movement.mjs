import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {fixedReplay} from './fixed-replay.mjs';
import {Stats} from './stats.mjs';
import {loadData,windows,sha256} from './data.mjs';
const root=process.argv[2],started=Date.now(),data=loadData(),stats=new Stats(),settings=[],holds=new Map();
for(const window of ['week','month'])for(const moveMode of ['fixed','confirmed','retest'])settings.push({id:`${window}-${moveMode}`,window,moveMode});
const baseline='week-fixed';
fs.writeFileSync(path.join(root,'phase-c-movement-method.json'),JSON.stringify({settings,baseline,bindings:data.bindings,variant:'trail-research-1 d unchanged',proxyAdapter:'Research-only native OKX perpetual source acceptance; no provenance relabelling; same Dow/ADX/DI/ATR/caps/carry math.',createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
for(const period of ['development','evaluation','proxy']){
 const fd=fs.openSync(path.join(root,`phase-c-movement-${period}.jsonl`),'wx');
 for(const d of data.datasets){
  const gs=new Map(),ps=new Map(),moveDecisionCache=new Map();
  for(const w of windows(d,period)){
   const scenario=new Map();
   for(const s of settings){
    const key=[w.launchAt,s.window].join('|');
    if(!gs.has(key))gs.set(key,w.start<0?{ok:false,reason:'missing launch'}:await geometryAt(d.bars,d.timeframe,w.start,d.market,s.window));
    const g=gs.get(key);
    for(const direction of ['long','short']){
     const pk=key+'|'+direction;
     if(!ps.has(pk)){let policy=null,reason=g.ok?null:g.reason;try{if(!reason)policy=makeTrailGrid({market:d.market,geometry:g.geometry,direction,seed:true,mode:'step_back',intervals:10},String(d.bars[w.start-1].close));}catch(e){reason=e.message;}ps.set(pk,{policy,reason});}
     const p=ps.get(pk);
     for(const pathName of ['OHLC','OLHC']){
      const row={period,setting:s.id,market:d.symbol,timeframe:d.timeframe,launchAt:w.launchAt,horizonDays:w.horizonDays,regime:w.regime,year:w.year,source:w.source,direction,path:pathName,admitted:!w.reason&&!p.reason,reason:w.reason??p.reason};
      if(row.admitted){
       const r=fixedReplay({candles:d.bars,dataHolds:d.dataHolds,market:d.market,timeframe:d.timeframe,start:w.start,end:w.end,policy:p.policy,path:pathName,moveMode:s.moveMode,moveDecisionCache});
       Object.assign(row,{netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,fees:r.fees,fillCount:r.fillCount,protectiveStop:r.protectiveStop,moves:r.moves,moveLog:r.moveLog,seedHold:r.seedHold});
       for(const [reason,count] of Object.entries(r.moveHolds)){const k=[period,s.id,reason].join('|');holds.set(k,(holds.get(k)??0)+count);}
      }
      stats.record(row);scenario.set([s.id,direction,pathName].join('|'),row);fs.writeSync(fd,JSON.stringify(row)+'\n');
     }
    }
   }
   for(const direction of ['long','short'])for(const p of ['OHLC','OLHC'])for(const s of settings)stats.pair(scenario.get([s.id,direction,p].join('|')),scenario.get([baseline,direction,p].join('|')));
  }
  console.log(`Movement ${period} ${d.symbol} ${d.timeframe}: ${stats.admitted}/${stats.total} admitted`);
 }
 fs.closeSync(fd);
 if(period==='development')fs.writeFileSync(path.join(root,'phase-c-movement-selection.json'),JSON.stringify(stats.select(settings.map(s=>s.id),baseline),null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(root,'phase-c-movement-summary.json'),JSON.stringify({...stats.json(),moveHolds:[...holds].map(([key,count])=>({key,count})),seconds:(Date.now()-started)/1000,host:os.hostname(),workers:1},null,2)+'\n');
 fs.writeFileSync(path.join(root,`phase-c-movement-${period}-complete.json`),JSON.stringify({runsSha256:sha256(fs.readFileSync(path.join(root,`phase-c-movement-${period}.jsonl`))),selectionSha256:sha256(fs.readFileSync(path.join(root,'phase-c-movement-selection.json')))},null,2)+'\n');
}
