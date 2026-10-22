import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {quarterAt,DAY} from '../grid-ranging-pairs/core.mjs';import {marketSpec,worstPath} from '../grid-ranging-pairs/design.mjs';
import {trailDataHold} from '../../../server/grid-bot/trail-policy.ts';import {geometryAt} from '../grid-defaults/geometry.mjs';
import {sizingPolicy} from '../grid-sizing-1b/arms.mjs';import {projection} from '../grid-backtest-r2/projection.mjs';import {sizingReplay} from '../grid-sizing-stops/replay.mjs';
import {GEOMETRIES,replayMetrics} from './core.mjs';
const hb=path.resolve('../grid-multi-timeframe-20261022-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),symbol=process.argv[2];
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const bound=(file,sha256)=>{const b=fs.readFileSync(file);if(hash(b)!==sha256)throw Error('Bound input changed: '+file);return JSON.parse(b);};
const m=read(root+'/markets.json').find(x=>x.symbol===symbol),cert=read(root+'/candles15m/certification.json').find(x=>x.symbol===symbol),drop15m=read(root+'/candles15m/complete.json').drop15m;
const {market,maxLeverage}=marketSpec(m.candidate),selected=read(root+'/selections.json').filter(s=>s.universe==='A+B'),launches=read(root+'/launches.json');
const funding=bound(m.fundingFile,m.fundingSha256).rows,sets=new Map(),counts={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0,ineligibleLaunches:0,reasons:{}},fd=fs.openSync(root+'/'+symbol+'.jsonl','wx');
for(const timeframe of ['1h',...(!drop15m&&cert.passed?['15m']:[])]){
 const duration=timeframe==='1h'?3600000:900000,raw=timeframe==='1h'?bound(m.priceFile,m.priceSha256).rows:bound(cert.file,cert.sha256).rows;
 const bars=raw.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}})),index=new Map(bars.map((x,i)=>[x.time,i])),fundingEvents=bars.map(()=>[]);
 for(const f of funding){const i=index.get(Math.floor(f.time/duration)*duration);if(i!==undefined)fundingEvents[i].push(f);}
 const dataHolds=bars.map((b,i)=>trailDataHold(bars.slice(Math.max(0,i-100),i),timeframe,b.time));sets.set(timeframe,{bars,index,fundingEvents,dataHolds});
}
for(const w of launches){const quarter=quarterAt(w.launchAt);if(!selected.find(s=>s.at===quarter).groups.all.includes(symbol)){counts.ineligibleLaunches++;continue;}
 for(const geometry of GEOMETRIES){if(!sets.has(geometry.timeframe))continue;const {bars,index,fundingEvents,dataHolds}=sets.get(geometry.timeframe),start=index.get(w.launchAt),end=index.get(w.launchAt+geometry.horizonDays*DAY-geometry.duration)+1;
  let unavailable=start===undefined||!Number.isFinite(end)?'missing execution boundary':dataHolds[start]??null;
  if(!unavailable&&(end-start!==geometry.horizonDays*DAY/geometry.duration||bars.slice(start,end).some((b,i)=>b.time!==w.launchAt+i*geometry.duration)))unavailable='incomplete execution horizon';
  const g=unavailable?null:await geometryAt(bars,geometry.timeframe,start,market,geometry.period);if(g&&!g.ok)unavailable=g.reason;
  for(const builderRate of [0,.001])for(const leverage of [1,3])for(const direction of ['long','short'])for(const arm of ['flat_flat','further_near']){
   let reason=unavailable,record;const makerRate=.00015+builderRate,takerRate=.0004+builderRate;
   if(!reason&&leverage>maxLeverage)reason='leverage exceeds market ceiling';
   if(!reason){try{record=sizingPolicy({market,direction,geometry:g.geometry,reference:String(bars[start-1].close),leverage,makerRate,arm});const clear=projection(record.policy,market,maxLeverage,makerRate,takerRate,w.launchAt);if(clear.state!=='available')reason=clear.reason;}catch(e){reason=e.message;}}
   const pair=[];for(const ordering of ['OHLC','OLHC']){
    const result=reason?null:replayMetrics(sizingReplay({candles:bars,dataHolds,market,timeframe:geometry.timeframe,start,end,policy:record.policy,path:ordering,markPath:ordering,markBars:bars,fundingEvents,maxLeverage,makerRate,takerRate,moveMode:'fixed',stopMode:'touch',closeAtHorizon:true}),geometry.duration);
    const row={symbol,universe:m.universe,quarter,week:w.week,launchAt:w.launchAt,horizonDays:geometry.horizonDays,geometry:geometry.id,builderRate,leverage,direction,arm,path:ordering,admitted:!reason,reason:reason??null,...result};counts.attempted++;
    if(reason){counts.rejected++;counts.reasons[reason]=(counts.reasons[reason]??0)+1;}else{counts.admittedUniqueNew++;pair.push(row);}fs.writeSync(fd,JSON.stringify(row)+'\n');
   }
   if(pair.length){const worst=worstPath(pair);fs.writeSync(fd,JSON.stringify({...worst,path:'worst',sourcePath:worst.path,derived:true})+'\n');counts.derivedRows++;}
  }
 }
}
fs.closeSync(fd);const output=root+'/'+symbol+'.jsonl';fs.writeFileSync(root+'/'+symbol+'-complete.json',JSON.stringify({symbol,counts,output,outputSha256:hash(fs.readFileSync(output)),host:os.hostname(),completedAt:new Date().toISOString()})+'\n',{flag:'wx'});console.log(JSON.stringify({symbol,counts}));
