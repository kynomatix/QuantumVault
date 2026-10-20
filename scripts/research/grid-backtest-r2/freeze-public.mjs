import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
const root=process.argv[2],out=path.join(root,'public-history-'+new Date().toISOString().replace(/\D/g,'')),end=Date.parse('2026-10-19T00:00:00Z'),HOUR=3600000;
fs.mkdirSync(out); // Fresh artifact root; never overwrite earlier responses.
const manifest={startedAt:new Date().toISOString(),host:os.hostname(),requests:[],datasets:[],errors:[]},cache=new Map();
const hash=b=>createHash('sha256').update(b).digest('hex');
const checkpoint=()=>fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
for(const dir of fs.readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()&&d.name.startsWith('public-history')&&path.join(root,d.name)!==out)){
 const file=path.join(root,dir.name,'manifest.json');if(!fs.existsSync(file))continue;
 for(const r of JSON.parse(fs.readFileSync(file,'utf8')).requests.filter(r=>r.status===200)){
  const originalPath=path.join(root,dir.name,r.file),bytes=fs.readFileSync(originalPath);
  if(hash(bytes)!==r.sha256)throw Error('Cached response digest changed');
  if(!cache.has(r.url))cache.set(r.url,{bytes,originalPath,sha256:r.sha256});
 }
}
async function get(url,name){
 if(cache.has(url)){
  const c=cache.get(url);fs.writeFileSync(path.join(out,name),c.bytes,{flag:'wx'});
  manifest.requests.push({url,file:name,status:200,sha256:c.sha256,cachedFrom:c.originalPath});checkpoint();
  return JSON.parse(c.bytes);
 }
 // Pace actual data requests; this is acquisition throttling, not status polling.
 await setTimeout(4500);
 const startedAt=new Date().toISOString(),r=await fetch(url,{signal:AbortSignal.timeout(30000)}),text=await r.text();
 fs.writeFileSync(path.join(out,name),text,{flag:'wx'});
 manifest.requests.push({url,file:name,startedAt,status:r.status,sha256:hash(text)});checkpoint();
 if(r.status===429)throw Error('RATE_LIMIT_STOP');
 if(!r.ok)throw Error(`HTTP ${r.status}`);const j=JSON.parse(text);if(j.success!==true)throw Error(`API unsuccessful: ${j.error}`);return j;
}
const markets=JSON.parse(fs.readFileSync(path.join(root,'node-public-info.json'),'utf8')).data;
for(const symbol of ['BTC','ETH','SOL','HYPE','ZEC']){
 const md=markets.find(m=>m.symbol===symbol);
 for(const timeframe of ['1h','4h']){
  const duration=timeframe==='1h'?HOUR:4*HOUR,from=Math.floor(md.created_at/duration)*duration,rows=new Map();
  try{
   for(let t=from;t<end;t+=400*duration){
    const through=Math.min(t+400*duration,end);
    const j=await get(`https://api.pacifica.fi/api/v1/kline/mark?symbol=${symbol}&interval=${timeframe}&start_time=${t}&end_time=${through}`,`mark-${symbol}-${timeframe}-${t}.json`);
    for(const b of j.data){
     if(b.t<t||b.t>=through)continue;
     const row=[b.t,...['o','h','l','c','v'].map(k=>Number(b[k]))];
     if(!Number.isSafeInteger(row[0])||row[0]%duration||!row.slice(1).every(Number.isFinite)||row.slice(1,5).some(x=>x<=0)||row[5]<0||row[3]>Math.min(row[1],row[4])||row[2]<Math.max(row[1],row[4])){manifest.errors.push({symbol,timeframe,time:b.t,reason:'invalid mark candle excluded'});continue;}
     rows.set(row[0],row);
    }
   }
   const values=[...rows.values()].sort((a,b)=>a[0]-b[0]),file=`mark-${symbol}-${timeframe}.json`,bytes=JSON.stringify({symbol,timeframe,rows:values});
   fs.writeFileSync(path.join(out,file),bytes,{flag:'wx'});
   manifest.datasets.push({kind:'mark',symbol,timeframe,file,sha256:hash(bytes),count:values.length,from:values[0]?.[0],through:values.at(-1)?.[0],gaps:values.slice(1).filter((b,i)=>b[0]!==values[i][0]+duration).length});
   console.log(`${symbol} ${timeframe} mark: ${values.length} bars`);
  }catch(e){manifest.errors.push({symbol,timeframe,error:e.message});checkpoint();if(e.message==='RATE_LIMIT_STOP')throw e;console.log(`${symbol} ${timeframe} mark failed: ${e.message}`);}
  checkpoint();
 }
 const rates=new Map();let cursor=null,page=0,done=false;
 try{
  while(!done){
   const j=await get(`https://api.pacifica.fi/api/v1/funding_rate/history?symbol=${symbol}&limit=4000${cursor?'&cursor='+encodeURIComponent(cursor):''}`,`funding-${symbol}-${page++}.json`);
   for(const f of j.data){
    if(!Number.isSafeInteger(f.created_at)||!Number.isFinite(Number(f.funding_rate))||!(Number(f.oracle_price)>0))throw Error('Malformed settled funding record');
    if(f.created_at<end)rates.set(f.created_at,{time:f.created_at,rate:Number(f.funding_rate),oraclePrice:Number(f.oracle_price)});
   }
   done=!j.has_more||!j.data.length;if(!done&&(!j.next_cursor||j.next_cursor===cursor))throw Error('Funding cursor failed to advance');cursor=j.next_cursor;
   if(page>30)throw Error('Unexpected funding pagination count');
  }
  const rows=[...rates.values()].sort((a,b)=>a.time-b.time),file=`funding-${symbol}.json`,bytes=JSON.stringify({symbol,rows});
  fs.writeFileSync(path.join(out,file),bytes,{flag:'wx'});
  manifest.datasets.push({kind:'settled-funding',symbol,file,sha256:hash(bytes),count:rows.length,from:rows[0]?.time,through:rows.at(-1)?.time,completePagination:done});
  console.log(`${symbol} funding: ${rows.length} settlements`);
 }catch(e){manifest.errors.push({symbol,kind:'settled-funding',error:e.message});checkpoint();if(e.message==='RATE_LIMIT_STOP')throw e;console.log(`${symbol} funding failed: ${e.message}`);}
 checkpoint();
}
manifest.completedAt=new Date().toISOString();checkpoint();
fs.writeFileSync(path.join(out,'manifest-sha256.json'),JSON.stringify({manifestSha256:hash(fs.readFileSync(path.join(out,'manifest.json')))},null,2)+'\n');
fs.writeFileSync(path.join(root,'public-history-path.txt'),out+'\n');
console.log(`Public history complete: ${manifest.datasets.length} datasets; ${manifest.errors.length} errors`);
