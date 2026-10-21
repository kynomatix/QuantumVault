import fs from 'node:fs';
import {inventory,loadMarket,calendar,HB,sha256} from './data.mjs';
const inv=inventory(),results=[];
for(const cohort of ['development','okx'])for(const symbol of cohort==='okx'?inv.admission.results.filter(x=>x.admitted).map(x=>x.symbol):['BTC','ETH','SOL','HYPE','ZEC']){
 const d=loadMarket(inv,cohort,symbol),admitted=calendar(d,cohort).filter(w=>!w.reason);
 if(cohort==='development')admitted.push(...calendar(d,'evaluation').filter(w=>!w.reason));
 const indices=new Set();for(const w of admitted)for(let i=w.start;i<w.end;i++)indices.add(i);
 let invalid=0;for(const i of indices){const m=d.marks[i];
  if(!m||m.time!==d.bars[i].time||!['open','high','low','close'].every(k=>Number.isFinite(m[k])&&m[k]>0)||m.high<Math.max(m.open,m.close)||m.low>Math.min(m.open,m.close))invalid++;
 }
 results.push({cohort:cohort==='development'?'pacifica':cohort,symbol,admittedCalendarHorizons:admitted.length,uniqueExecutionHours:indices.size,invalidMarkHours:invalid});
}
const output={purpose:'Read-only input integrity audit, not a product test',results,totalInvalidMarkHours:results.reduce((n,r)=>n+r.invalidMarkHours,0),completedAt:new Date().toISOString()};
if(output.totalInvalidMarkHours)throw Error('Malformed mark OHLC in admitted execution data');
fs.writeFileSync(HB+'/INPUT-AUDIT.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({markets:results.length,invalidMarkHours:output.totalInvalidMarkHours,reportSha256:sha256(fs.readFileSync(HB+'/INPUT-AUDIT.json'))}));
