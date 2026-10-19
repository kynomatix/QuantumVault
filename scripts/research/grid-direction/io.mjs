import {readFileSync,createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {toBars,DAY} from './core.mjs';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export const prior='C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence/round2-20261019T044511Z/evaluation';
export function readSnapshot(root){
  const bytes=readFileSync(join(root,'manifest.json')),manifest=JSON.parse(bytes),datasets=[];
  const pin=JSON.parse(readFileSync(join(root,'manifest-sha256.json'),'utf8'));if(sha256(bytes)!==pin.manifestSha256)throw Error('Manifest mismatch');
  for(const d of manifest.datasets){const bytes=readFileSync(join(root,d.file));if(sha256(bytes)!==d.sha256)throw Error('Snapshot mismatch: '+d.file);datasets.push({...d,rows:JSON.parse(bytes).rows});}
  if(manifest.rawResponsesSha256!==sha256(readFileSync(join(root,'responses.jsonl'))))throw Error('Raw response mismatch');
  return {manifest,datasets,manifestSha256:sha256(bytes)};
}
export function loadData(evidence){
  const snapshot=readSnapshot(join(evidence,'snapshot')),fallback=readSnapshot(join(evidence,'fallback-snapshot-v2'));
  const configuration=JSON.parse(readFileSync(join(prior,'configuration.json'))),root=configuration.sourceDirectory,mb=readFileSync(join(root,'manifest.json'));
  if(sha256(mb)!==configuration.manifestSha256)throw Error('Prior manifest mismatch');
  const manifest=JSON.parse(mb),pacifica=[];
  for(const d of manifest.datasets.filter(d=>['1h','4h'].includes(d.timeframe))){const bytes=readFileSync(join(root,d.file));if(sha256(bytes)!==d.sha256)throw Error('Pacifica mismatch');pacifica.push({...d,bars:toBars(JSON.parse(bytes).rows,'pacifica')});}
  const datasets=[...snapshot.datasets,...fallback.datasets].filter(d=>d.timeframe!=='1w').map(d=>({...d,bars:toBars(d.rows,d.venue)}));
  function dailyFrom4h(symbol){const rows=pacifica.find(d=>d.symbol===symbol&&d.timeframe==='4h').bars,groups=new Map();for(const b of rows){const t=Math.floor(b.time/DAY)*DAY;const a=groups.get(t)??[];a.push(b);groups.set(t,a);}return [...groups].filter(([t,a])=>a.length===6&&a.every((b,i)=>b.time===t+i*14400000)).map(([time,a])=>({...a[0],time,open:a[0].open,high:Math.max(...a.map(b=>b.high)),low:Math.min(...a.map(b=>b.low)),close:a.at(-1).close,volume:a.reduce((s,b)=>s+b.volume,0)}));}
  const days=new Map(manifest.markets.map(m=>[m.symbol,dailyFrom4h(m.symbol)]));
  const sources=(market,timeframe)=>['okx','gate','hyperliquid','pacifica'].map(venue=>({venue,days:venue==='pacifica'?days.get(market):datasets.find(d=>d.symbol===market&&d.venue===venue&&d.timeframe==='1d')?.bars??[],bars:venue==='pacifica'?pacifica.find(d=>d.symbol===market&&d.timeframe===timeframe)?.bars??[]:datasets.find(d=>d.symbol===market&&d.venue===venue&&d.timeframe===timeframe)?.bars??[]}));
  const metadata=symbol=>{const m=manifest.markets.find(m=>m.symbol===symbol);return {symbol,tick:m.tick_size,lot:m.lot_size,minimumQuote:m.min_order_size,maximumQuote:m.max_order_size,minimumPrice:Number(m.min_tick)>0?m.min_tick:m.tick_size,maximumPrice:m.max_tick};};
  return {snapshot,fallback,pacifica,metadata,sources,macroSources:snapshot.datasets.filter(d=>d.timeframe==='1w'),configuration,priorManifestSha256:sha256(mb),priorRoot:root};
}
export async function readLines(file,fn){for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){if(line)await fn(JSON.parse(line));}}