import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {quarterAt} from '../grid-ranging-pairs/core.mjs';import {marketSpec} from '../grid-ranging-pairs/design.mjs';
import {indicators,squeezeAt} from '../grid-long-adx/core.mjs';import {geometryAt} from '../grid-defaults/geometry.mjs';
import {qualifyRangingMarket} from '../../../server/grid-planner/scanner.ts';import {features,select} from './core.mjs';
const hb=path.resolve('../grid-ranging-finder-20261023-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const markets=read(root+'/markets.json'),selections=read(root+'/selections.json'),launches=read(root+'/launches.json'),all=[],counts={ineligible:0,squeezed:0,squeezeUnavailable:0,featureUnavailable:0,measured:0,reasons:{}};
const bound=(file,sha256)=>{const bytes=fs.readFileSync(file);if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('Frozen data changed');return JSON.parse(bytes);};
for(const m of markets){
 const daily=bound(m.dailyFile,m.dailySha256).rows,dailyIndex=indicators(daily),{market}=marketSpec(m.candidate);
 const bars=bound(m.priceFile,m.priceSha256).rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}})),index=new Map(bars.map((b,i)=>[b.time,i]));
 for(const w of launches){if(!selections.find(s=>s.universe==='A+B'&&s.at===quarterAt(w.launchAt)).groups.all.includes(m.symbol)){counts.ineligible++;continue;}
  const squeeze=squeezeAt(dailyIndex,w.launchAt),start=index.get(w.launchAt),base={symbol:m.symbol,universe:m.universe,...w,quarter:quarterAt(w.launchAt),squeeze};
  if(!squeeze.available||squeeze.squeezed){counts[squeeze.available?'squeezed':'squeezeUnavailable']++;all.push({...base,available:false,reason:squeeze.available?'squeezed':'unavailable squeeze'});continue;}
  const g=start===undefined?{ok:false,reason:'missing launch boundary'}:await geometryAt(bars,'1h',start,market,'week');
  const feature=g.ok?features(bars.slice(Math.max(0,start-721),start),w.launchAt,g.geometry):{available:false,reason:g.reason};
  if(!feature.available){counts.featureUnavailable++;counts.reasons[feature.reason]=(counts.reasons[feature.reason]??0)+1;all.push({...base,...feature});continue;}
  const found=qualifyRangingMarket(m.symbol+'-PERP',m.symbol,'1h',bars.slice(start-100,start),w.launchAt,w.launchAt);
  const finder={state:found.state,adx:found.candidate?.adx??null};counts.measured++;all.push({...base,...feature,finder,geometry:g.geometry});
 }
 console.log(JSON.stringify({symbol:m.symbol,phase:'signals',workers:1,freeMemoryGB:Number((os.freemem()/1024**3).toFixed(2))}));
}
const membership=[];for(const universe of ['A','A+B'])for(const w of launches){const rows=all.filter(r=>r.launchAt===w.launchAt&&(universe==='A+B'||r.universe==='A'));membership.push({universe,...w,...select(rows)});}
for(const [name,value]of Object.entries({'signals.json':all,'membership.json':membership,'signal-counts.json':counts}))fs.writeFileSync(root+'/'+name,JSON.stringify(value)+'\n',{flag:'wx'});
fs.writeFileSync(hb+'/RESUME.md','Launch-time scores and memberships frozen before reading inherited outcomes. Study: '+root+'\n');console.log(JSON.stringify({phase:'signals-complete',counts}));
