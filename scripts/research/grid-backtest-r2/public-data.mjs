import fs from 'node:fs';
import path from 'node:path';
import {read,sha256} from './data.mjs';
const HOUR=3600000;
const lower=(rows,time)=>{let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if(rows[m].time<time)lo=m+1;else hi=m;}return lo;};
export function publicData(root,data){
 const directory=fs.readFileSync(path.join(root,'public-history-path.txt'),'utf8').trim(),manifest=read(path.join(directory,'manifest.json'));
 if(sha256(fs.readFileSync(path.join(directory,'manifest.json')))!==read(path.join(directory,'manifest-sha256.json')).manifestSha256)throw Error('Public manifest SHA-256 mismatch');
 const info=read(path.join(root,'node-public-info.json')).data,maps=new Map(),bindings=[];
 for(const d of manifest.datasets){
  const file=path.join(directory,d.file),bytes=fs.readFileSync(file);if(sha256(bytes)!==d.sha256)throw Error('Public dataset SHA-256 mismatch');
  maps.set([d.kind,d.symbol,d.timeframe??''].join('|'),JSON.parse(bytes).rows);bindings.push({file,sha256:d.sha256});
 }
 let proxy=new Map();
 const op=path.join(root,'okx-funding-path.txt');
 if(fs.existsSync(op)){
  const od=fs.readFileSync(op,'utf8').trim(),m=read(path.join(od,'manifest.json'));
  if(sha256(fs.readFileSync(path.join(od,'manifest.json')))!==read(path.join(od,'manifest-sha256.json')).manifestSha256)throw Error('OKX funding manifest mismatch');
  for(const d of m.datasets){const file=path.join(od,d.file),bytes=fs.readFileSync(file);if(sha256(bytes)!==d.sha256)throw Error('OKX funding dataset mismatch');proxy.set(d.symbol,JSON.parse(bytes).rows);bindings.push({file,sha256:d.sha256});}
 }
 for(const d of data.datasets){
  const marks=new Map((maps.get(['mark',d.symbol,d.timeframe].join('|'))??[]).map(([time,open,high,low,close,volume])=>[time,{time,open,high,low,close,volume}]));
  d.markBars=d.bars.map(b=>b.time<d.directStart?b:marks.get(b.time)??null);
  d.maxLeverage=Number(info.find(m=>m.symbol===d.symbol).max_leverage);
  const direct=maps.get(['settled-funding',d.symbol,''].join('|'))??[],prior=proxy.get(d.symbol)??[];
  const events=[...prior.filter(f=>f.time<d.directStart).map(f=>({...f,source:'okx_proxy'})),...direct.filter(f=>f.time>=d.directStart).map(f=>({...f,source:'pacifica'}))].sort((a,b)=>a.time-b.time);
  d.fundingEvents=d.bars.map(()=>[]);d.fundingCoverage=d.bars.map(()=>false);
  const byHour=new Map(events.map(f=>[Math.floor(f.time/HOUR)*HOUR,f]));
  for(let i=0;i<d.bars.length;i++){
   const b=d.bars[i];let complete=true;
   if(b.time>=d.directStart){
    for(let t=b.time;t<b.time+d.duration;t+=HOUR){const f=byHour.get(t);if(!f||f.source!=='pacifica')complete=false;else d.fundingEvents[i].push(f);}
   }else{
    // Historical schedule may shorten from 8h. Require archive observations on both
    // sides with at most an 8h gap; never manufacture missing funding payments.
    const before=lower(events,b.time+1)-1;
    const after=lower(events,b.time+d.duration);
    complete=before>=0&&after<events.length;
    if(complete){
     for(let j=before+1;j<=after;j++)if(events[j].time-events[j-1].time>8*HOUR)complete=false;
     d.fundingEvents[i]=events.slice(before,after+1).filter(f=>f.time>=b.time&&f.time<b.time+d.duration);
    }
   }
   d.fundingCoverage[i]=complete;
  }
 }
 return {bindings,method:'Direct settled Pacifica payments at observed timestamps and oracle prices. Older periods use labelled actual OKX payments, max-8h archive continuity, with traded-price interpolation for settlement notional. Direct historical market leverage schedules unavailable; current frozen metadata used as a declared scenario.'};
}
