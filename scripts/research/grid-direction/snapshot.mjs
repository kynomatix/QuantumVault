// Public historical observations only. A fresh output directory is mandatory.
import {mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const [out]=process.argv.slice(2);
if(!out)throw Error('New snapshot directory required');
mkdirSync(out);
const end=Date.parse('2026-10-19T00:00:00Z'),day=86400000,week=7*day;
const digest=b=>createHash('sha256').update(b).digest('hex');
const manifest={schemaVersion:1,createdAt:new Date().toISOString(),end,sourceOrder:['okx-index','gate-spot','kraken-spot','coinbase-spot','pacifica-mark','hyperliquid-perp','pacifica-perp','okx-perp'],datasets:[],requests:0,errors:[]};
async function get(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)}),body=await response.text();
  appendFileSync(join(out,'responses.jsonl'),JSON.stringify({url,retrievedAt:new Date().toISOString(),status:response.status,body})+'\n');
  manifest.requests++;
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  return JSON.parse(body);
}
function save(key,rows,metadata){
  rows.sort((a,b)=>a[0]-b[0]);const unique=[];
  for(const row of rows){
    if(unique.at(-1)?.[0]===row[0]){if(JSON.stringify(unique.at(-1))!==JSON.stringify(row))throw Error(`Conflicting duplicate ${key}`);}
    else unique.push(row);
  }
  const file=key+'.json',bytes=JSON.stringify({rows:unique});writeFileSync(join(out,file),bytes,{flag:'wx'});
  manifest.datasets.push({file,...metadata,rows:unique.length,first:unique[0]?.[0],last:unique.at(-1)?.[0],sha256:digest(bytes)});
  console.log(`${key}: ${unique.length} observations`);
}
async function okx(symbol,timeframe,start,index=false){
  const interval={'1h':'1H','4h':'4H','1d':'1Dutc','1w':'1Wutc'}[timeframe],duration={'1h':3600000,'4h':14400000,'1d':day,'1w':week}[timeframe];
  let cursor=end;const rows=[],invalid=[];
  for(let page=0;page<1000&&cursor>start;page++){
    const q=new URLSearchParams({instId:index?'BTC-USDT':symbol+'-USDT-SWAP',bar:interval,limit:index?'100':'300',after:String(cursor)});
    const payload=await get('https://www.okx.com/api/v5/market/'+(index?'history-index-candles':'history-candles')+'?'+q);
    if(payload.code!=='0'||!Array.isArray(payload.data))throw Error(`Invalid OKX response ${payload.code}`);
    if(!payload.data.length)break;
    const oldest=Math.min(...payload.data.map(r=>Number(r[0])));if(oldest>=cursor)throw Error('Nonadvancing historical cursor');
    for(const r of payload.data){
      const t=Number(r[0]);if(t<start||t+duration>end)continue;
      if(index){if(r[5]==='1'&&Number(r[4])>0)rows.push([t,r[4]]);else invalid.push(t);continue;}
      const row=[t,...r.slice(1,5).map(Number),Number(r[5])];
      if(r[8]!=='1'||row.some(v=>!Number.isFinite(v))||row.slice(1,5).some(v=>v<=0)||row[5]<0||row[3]>Math.min(row[1],row[4])||row[2]<Math.max(row[1],row[4])||t%duration!==0)invalid.push(t);
      else rows.push(row);
    }
    cursor=oldest;
  }
  save(index?'macro-okx-index':`${symbol}-${timeframe}`,rows,{symbol,timeframe,source:index?'okx-index':'okx',venue:'okx',basis:index?'index':'perp',duration,invalid});
}
try{
  await okx('BTC','1w',Date.parse('2020-01-06T00:00:00Z'),true);
  const gate=[];
  for(let from=Date.parse('2020-01-06T00:00:00Z');from<Date.parse('2022-08-01T00:00:00Z');from+=50*week){
    const to=Math.min(from+50*week,Date.parse('2022-08-01T00:00:00Z'));
    const q=new URLSearchParams({currency_pair:'BTC_USDT',interval:'1w',from:String(from/1000),to:String(to/1000-1)});
    const rows=await get('https://api.gateio.ws/api/v4/spot/candlesticks?'+q);if(!Array.isArray(rows))throw Error('Invalid Gate spot response');
    for(const r of rows)if((r[7]===true||r[7]==='true')&&Number(r[2])>0)gate.push([Number(r[0])*1000,r[2]]);
  }
  save('macro-gate-spot',gate,{symbol:'BTC',timeframe:'1w',source:'gate-spot',venue:'gate',basis:'spot',duration:week});
  for(const symbol of ['BTC','ETH','SOL','HYPE','ZEC']){
    await okx(symbol,'1d',Date.parse('2020-01-01T00:00:00Z'));
    const start=Date.parse(['BTC','ETH','SOL'].includes(symbol)?'2021-12-01T00:00:00Z':symbol==='HYPE'?'2025-06-01T00:00:00Z':'2025-10-01T00:00:00Z');
    for(const timeframe of ['1h','4h'])await okx(symbol,timeframe,start);
  }
}catch(e){manifest.errors.push({message:e.message});process.exitCode=1;}
manifest.rawResponsesSha256=digest(readFileSync(join(out,'responses.jsonl')));manifest.completedAt=new Date().toISOString();
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
writeFileSync(join(out,'manifest-sha256.json'),JSON.stringify({manifestSha256:digest(readFileSync(join(out,'manifest.json')))}),{flag:'wx'});
console.log(`Snapshot complete: ${manifest.requests} requests; ${manifest.errors.length} errors`);