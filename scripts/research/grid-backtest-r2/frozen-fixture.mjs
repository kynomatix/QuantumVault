import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
const base='C:/Apps/Replit/conductor-worktrees',prior=base+'/grid-defaults-backtest-20261020-handback/evidence/defaults-20261019T214700Z';
const root=base+'/grid-trail-backtest-20261019-handback/evidence/candles-validated-20261019',manifest=JSON.parse(fs.readFileSync(root+'/manifest.json','utf8'));
const chosen=new Map(),geometries=new Map();
for await(const line of readline.createInterface({input:fs.createReadStream(prior+'/runs-development.jsonl'),crlfDelay:Infinity})){
 const r=JSON.parse(line);if(!r.admitted||!['week-1-10-repeat_all','week-1-10-step_back'].includes(r.setting))continue;
 const key=[r.market,r.timeframe,r.direction,r.path,r.setting].join('|');if(!chosen.has(key))chosen.set(key,r);
 if(chosen.size===80)break;
}
for await(const line of readline.createInterface({input:fs.createReadStream(prior+'/geometry-development.jsonl'),crlfDelay:Infinity})){
 const g=JSON.parse(line);if(g.window==='week'&&g.ok)geometries.set([g.symbol,g.timeframe,g.launchAt].join('|'),g.geometry);
}
const sets=new Map(),cases=[];
for(const r of chosen.values()){
 const ds=manifest.datasets.find(d=>d.symbol===r.market&&d.timeframe===r.timeframe),bytes=fs.readFileSync(path.join(root,ds.file));
 if(createHash('sha256').update(bytes).digest('hex')!==ds.sha256)throw Error('Fixture source mismatch');
 const rows=JSON.parse(bytes).rows,idx=rows.findIndex(b=>b[0]===r.launchAt),duration=r.timeframe==='1h'?3600000:14400000;
 const end=rows.findIndex(b=>b[0]===r.endAt-duration)+1,key=[r.market,r.timeframe,r.launchAt,r.endAt].join('|');
 if(!sets.has(key))sets.set(key,{sourceSha256:ds.sha256,rows:rows.slice(idx-100,end)});
 const md=manifest.markets.find(m=>m.symbol===r.market);
 const geometry=geometries.get([r.market,r.timeframe,r.launchAt].join('|')),market={symbol:r.market,tick:md.tick_size,lot:md.lot_size,minimumQuote:md.min_order_size,maximumQuote:md.max_order_size,minimumPrice:Number(md.min_tick)>0?md.min_tick:md.tick_size,maximumPrice:md.max_tick};
 const policy=makeTrailGrid({market,geometry,direction:r.direction,seed:true,mode:r.setting.endsWith('step_back')?'step_back':'repeat_all',intervals:10},String(rows[idx-1][4]));
 cases.push({key,expected:r,geometry,market,policy});
}
const target=new URL('../../../tests/research/fixtures/grid-backtest-r2.json',import.meta.url);fs.mkdirSync(new URL('.',target),{recursive:true});fs.writeFileSync(target,JSON.stringify({sets:Object.fromEntries(sets),cases})+'\n');
console.log(`Frozen research fixture: ${cases.length} cases, ${sets.size} candle slices, ${fs.statSync(target).size} bytes`);
