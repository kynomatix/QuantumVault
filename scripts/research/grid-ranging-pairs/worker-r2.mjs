import fs from 'node:fs';import os from 'node:os';
import {HB,ROOT,read,bound,hash,END,HOUR} from './io.mjs';
import {calendar,quarterAt} from './core.mjs';
import {ARMS,marketSpec,worstPath} from './design.mjs';
import {trailDataHold} from '../../../server/grid-bot/trail-policy.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {sizingPolicy} from '../grid-sizing-1b/arms.mjs';
import {projection} from '../grid-backtest-r2/projection.mjs';
import {replayStrategy} from '../grid-sizing-stops/strategy.mjs';
const symbol=process.argv[2],root=fs.readFileSync(HB+'/study-r2-root.txt','utf8').trim(),reg=read(root+'/registration.json');
for(const f of reg.sources)if(hash(fs.readFileSync(f.file))!==f.sha256)throw Error('Source drift: '+f.file);
const frozen=bound(reg.frozenFile,reg.frozenSha256);for(const f of frozen.files)if(hash(fs.readFileSync(f.file))!==f.sha256)throw Error('Frozen input drift');
const s=read(ROOT+'/coverage.json').find(x=>x.symbol===symbol&&x.passed),c=read(ROOT+'/candidate-universe.json').find(x=>x.symbol===symbol);if(!s||!c)throw Error('Uncertified market');
const {market,maxLeverage}=marketSpec(c),bars=bound(s.priceFile,s.priceSha256).rows.filter(x=>x[0]<END).map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
const index=new Map(bars.map((x,i)=>[x.time,i])),fundingEvents=bars.map(()=>[]);for(const f of bound(s.fundingFile,s.fundingSha256).rows){const i=index.get(Math.floor(f.time/HOUR)*HOUR);if(i!==undefined)fundingEvents[i].push(f);}
const dataHolds=bars.map((b,i)=>trailDataHold(bars.slice(Math.max(0,i-100),i),'1h',b.time));
const selected=bound(root+'/selections.json',reg.selectionsSha256).filter(x=>x.universe==='A+B');
const counts={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0,noLaunch:0,reasons:{}},out=root+'/'+symbol+'.jsonl',fd=fs.openSync(out,'wx'),started=Date.now(),geo=new Map(),plans=new Map();
for(const w of calendar(Date.UTC(2023,2,1),END)){
 const quarter=quarterAt(w.launchAt);if(!selected.find(x=>x.at===quarter)?.groups.all.includes(symbol)){counts.noLaunch++;continue;}
 const start=index.get(w.launchAt),last=index.get(w.launchAt+w.horizonDays*24*HOUR-HOUR),end=last===undefined?undefined:last+1;
 let unavailable=start===undefined||end===undefined?'missing execution boundary':start<840||bars[start-840].time!==w.launchAt-840*HOUR?'incomplete 35-day prehistory':dataHolds[start]??null;
 if(!unavailable&&(end-start!==w.horizonDays*24||bars.slice(start,end).some((b,i)=>b.time!==w.launchAt+i*HOUR)))unavailable='incomplete execution horizon';
 for(const window of ['week','month'])for(const builderRate of [0,.001])for(const leverage of [1,3])for(const direction of ['long','short'])for(const arm of ARMS){
  let reason=unavailable,record;const gkey=w.launchAt+'|'+window,pkey=[gkey,builderRate,leverage,direction,arm].join('|'),makerRate=.00015+builderRate,takerRate=.0004+builderRate;
  if(!reason&&leverage>maxLeverage)reason='leverage exceeds current market ceiling';
  if(!reason){if(!geo.has(gkey))geo.set(gkey,await geometryAt(bars,'1h',start,market,window));const g=geo.get(gkey);if(!g.ok)reason=g.reason;else{if(!plans.has(pkey)){try{const p=sizingPolicy({market,direction,geometry:g.geometry,reference:String(bars[start-1].close),leverage,makerRate,arm});const clear=projection(p.policy,market,maxLeverage,makerRate,takerRate,w.launchAt);plans.set(pkey,{...p,reason:clear.state==='available'?null:clear.reason});}catch(e){plans.set(pkey,{reason:e.message});}}record=plans.get(pkey);reason=record.reason;}}
  const pair=[];
  for(const path of ['OHLC','OLHC']){
   const result=reason?null:replayStrategy({candles:bars,dataHolds,market,timeframe:'1h',start,end,policy:record.policy,path,markPath:path,markBars:bars,fundingEvents,maxLeverage,makerRate,takerRate,moveMode:'fixed',stopMode:'touch',closeAtHorizon:true},'shipped');
   const row={symbol,universe:s.universe,quarter,week:w.week,launchAt:w.launchAt,horizonDays:w.horizonDays,slot:w.slot,window,builderRate,leverage,direction,arm,path,admitted:!reason,reason:reason??null,...result};counts.attempted++;if(reason){counts.rejected++;counts.reasons[reason]=(counts.reasons[reason]??0)+1;}else{counts.admittedUniqueNew++;pair.push(row);}fs.writeSync(fd,JSON.stringify(row)+'\n');
  }
  if(pair.length){const worst=worstPath(pair);fs.writeSync(fd,JSON.stringify({...worst,derived:true,sourcePath:worst.path,path:'worst'})+'\n');counts.derivedRows++;}
 }
 fs.writeFileSync(root+'/'+symbol+'-checkpoint.json',JSON.stringify({symbol,launchAt:w.launchAt,counts})+'\n');
}
fs.closeSync(fd);fs.writeFileSync(root+'/'+symbol+'-complete.json',JSON.stringify({symbol,counts,output:out,outputSha256:hash(fs.readFileSync(out)),elapsedSeconds:(Date.now()-started)/1000,host:os.hostname(),completedAt:new Date().toISOString()})+'\n',{flag:'wx'});console.log(JSON.stringify({symbol,counts}));