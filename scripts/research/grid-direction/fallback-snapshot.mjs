import {mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const [out]=process.argv.slice(2);mkdirSync(out);
const sha=b=>createHash('sha256').update(b).digest('hex'),day=86400000;
const datasets=[],attempts=[];
async function get(url,body){const r=await fetch(url,{signal:AbortSignal.timeout(20000),...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const text=await r.text();appendFileSync(join(out,'responses.jsonl'),JSON.stringify({url,body,retrievedAt:new Date().toISOString(),status:r.status,response:text})+'\n');if(!r.ok)return [];return JSON.parse(text);}
for(const [tf,start,end] of [['1d','2024-10-01','2026-01-05'],['1h','2025-10-26','2025-11-17'],['4h','2025-10-26','2025-11-17']]){
  const rows=[],ms={'1d':day,'1h':3600000,'4h':14400000}[tf];
  for(let from=Date.parse(start);from<Date.parse(end);from+=1000*ms){
    const to=Math.min(Date.parse(end),from+1000*ms);
    const q=new URLSearchParams({contract:'ZEC_USDT',interval:tf,from:String(from/1000),to:String(to/1000-1)});
    const raw=await get('https://api.gateio.ws/api/v4/futures/usdt/candlesticks?'+q);
    if(Array.isArray(raw))for(const r of raw){const row=[r.t*1000,+r.o,+r.h,+r.l,+r.c,+r.v];if(row.every(Number.isFinite)&&row.slice(1,5).every(x=>x>0)&&row[3]<=Math.min(row[1],row[4])&&row[2]>=Math.max(row[1],row[4])&&row[0]>=from&&row[0]<to)rows.push(row);}
  }
  rows.sort((a,b)=>a[0]-b[0]);const file=`ZEC-gate-${tf}.json`,bytes=JSON.stringify({rows});writeFileSync(join(out,file),bytes);datasets.push({file,symbol:'ZEC',timeframe:tf,source:'gate',venue:'gate',basis:'perp',rows:rows.length,sha256:sha(bytes)});
}
for(const timeframe of ['1h','4h']){
  const raw=await get('https://api.hyperliquid.xyz/info',{type:'candleSnapshot',req:{coin:'ZEC',interval:timeframe,startTime:Date.parse('2025-10-25'),endTime:Date.parse('2025-11-17')}});
  const ms=timeframe==='1h'?3600000:14400000;
  const rows=Array.isArray(raw)?raw.filter(r=>r.s==='ZEC'&&r.i===timeframe&&r.T===r.t+ms-1).map(r=>[r.t,+r.o,+r.h,+r.l,+r.c,+r.v]).sort((a,b)=>a[0]-b[0]):[];
  const file=`ZEC-hyperliquid-${timeframe}.json`,bytes=JSON.stringify({rows});writeFileSync(join(out,file),bytes);datasets.push({file,symbol:'ZEC',timeframe,source:'hyperliquid',venue:'hyperliquid',basis:'perp',rows:rows.length,sha256:sha(bytes)});
}
const raw=[];

const manifest={datasets,attempts,rawResponsesSha256:sha(readFileSync(join(out,'responses.jsonl'))),createdAt:new Date().toISOString()};writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));writeFileSync(join(out,'manifest-sha256.json'),JSON.stringify({manifestSha256:sha(readFileSync(join(out,'manifest.json')))}));console.log(JSON.stringify({datasets:datasets.map(x=>({file:x.file,rows:x.rows})),attempts}));