// Public-only historical snapshot. No application bootstrap, database, keys or npm install.
// node scripts/grid-trail-data.mjs <new-output-directory> [end-ISO]
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [destination,endText='2026-10-19T00:00:00Z',reuse] = process.argv.slice(2);
if (!destination) throw Error('A new output directory is required');
await mkdir(destination); // Never overwrite an existing snapshot.
const end = Date.parse(endText), base = 'https://api.pacifica.fi/api/v1/';
if (!Number.isSafeInteger(end) || end > Date.now()) throw Error('Invalid end');
async function get(path) {
  // Pace requests, including empty pre-listing pages, to respect public rate limits.
  await new Promise(resolve => setTimeout(resolve,5500));
  let response = await fetch(base+path,{signal:AbortSignal.timeout(30_000)});
  if(response.status===429){
    // One bounded server cooldown; no status polling or unbounded retry loop.
    await new Promise(resolve=>setTimeout(resolve,60000));
    response=await fetch(base+path,{signal:AbortSignal.timeout(30_000)});
  }
  if (!response.ok) throw Error(`Public endpoint ${path}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.success !== true || !Array.isArray(body.data)) throw Error('Invalid public response');
  return body.data;
}
const info = await get('info'), prices = await get('info/prices');
const alts = prices.filter(p => !['BTC','ETH','SOL'].includes(p.symbol))
  .sort((a,b) => Number(b.volume_24h)-Number(a.volume_24h)).slice(0,2).map(p => p.symbol);
const symbols = ['BTC','ETH','SOL',...alts];
const manifest = {schemaVersion:1,retrievedAt:new Date().toISOString(),end:endText,
  selection:'BTC/ETH/SOL plus top two other markets by current public 24h quote volume (survivorship bias)',
  endpoints:[base+'info',base+'info/prices',base+'kline'],symbols,markets:info.filter(m => symbols.includes(m.symbol)),
  liquidity:prices.filter(m => symbols.includes(m.symbol)),datasets:[]};
await writeFile(join(destination,'market-snapshot.json'),JSON.stringify(manifest,null,2));
const reused=reuse?JSON.parse(await readFile(join(reuse,'manifest.json'),'utf8')):null;
for (const symbol of symbols) for (const [timeframe,duration] of [['15m',900_000],['1h',3_600_000],['4h',14_400_000]]) {
  const cached=reused?.end===endText&&reused.datasets.find(d=>d.symbol===symbol&&d.timeframe===timeframe);
  if(cached){
    const bytes=await readFile(join(reuse,cached.file));
    if(createHash('sha256').update(bytes).digest('hex')!==cached.sha256)throw Error('Cached dataset digest changed');
    await writeFile(join(destination,cached.file),bytes);manifest.datasets.push(cached);
    await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2));continue;
  }
  const market = info.find(m => m.symbol === symbol);
  if (!Number.isSafeInteger(market?.created_at)) throw Error('No listing timestamp');
  // Include pre-listing time to establish the left coverage boundary empirically.
  const start = Math.floor((market.created_at-30*86_400_000)/duration)*duration;
  const rows = [], pages = [], rejected=[];
  for (let cursor=start; cursor<end;) {
    const until = Math.min(end,cursor+4000*duration);
    const path = 'kline?'+new URLSearchParams({symbol,interval:timeframe,start_time:String(cursor),end_time:String(until-1),limit:'4000'});
    const page = await get(path);
    if (page.length > 4000) throw Error('Oversized page');
    for (const r of page) {
      if (r.s !== symbol || r.i !== timeframe || !Number.isSafeInteger(r.t) || r.t < cursor || r.t >= until || r.t % duration
        || ![r.t+duration,r.t+duration-1].includes(r.T)
        || !['o','h','l','c','v'].every(k => typeof r[k] === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(r[k]))) throw Error('Invalid native candle');
      const row=[r.t,Number(r.o),Number(r.h),Number(r.l),Number(r.c),Number(r.v)];
      if(!row.slice(1).every(Number.isFinite)||row.slice(1,5).some(v=>v<=0)||row[5]<0||row[3]>Math.min(row[1],row[4])||row[2]<Math.max(row[1],row[4]))rejected.push(row);
      else rows.push(row);
    }
    pages.push({start:cursor,end:until,bars:page.length}); cursor=until;
  }
  rows.sort((a,b) => a[0]-b[0]);
  const gaps=[];
  rows.forEach((r,i) => {
    if (i && r[0] <= rows[i-1][0] || r[0]+duration>end || !r.slice(1).every(Number.isFinite)
      || r.slice(1,5).some(v=>v<=0) || r[5]<0 || r[3]>Math.min(r[1],r[4]) || r[2]<Math.max(r[1],r[4])) throw Error('Invalid OHLC sequence');
    if (i && r[0] !== rows[i-1][0]+duration) gaps.push({after:rows[i-1][0],before:r[0],missing:(r[0]-rows[i-1][0])/duration-1});
  });
  const file=`${symbol}-${timeframe}.json`,bytes=JSON.stringify({symbol,timeframe,source:'pacifica',basis:'perp',columns:['time','open','high','low','close','volume'],rows});
  await writeFile(join(destination,file),bytes);
  await writeFile(join(destination,`${symbol}-${timeframe}-rejected.json`),JSON.stringify(rejected));
  manifest.datasets.push({file,symbol,timeframe,bars:rows.length,first:rows[0]?.[0]??null,last:rows.at(-1)?.[0]??null,
    bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex'),rejectedBars:rejected.length,gaps,pages});
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(`${symbol} ${timeframe}: ${rows.length} bars, ${gaps.length} gaps`);
}
