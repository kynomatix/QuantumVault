import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {trailDataHold} from '../../../server/grid-bot/trail-policy.ts';
import {inRegisteredPopulation} from './registered-population.mjs';
export const DAY=86400000,SPLIT=Date.parse('2026-03-01T00:00:00Z'),FINISH=Date.parse('2026-10-19T00:00:00Z');
export const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export function loadData(){
 const prior='C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence/round2-20261019T044511Z/evaluation';
 const direction='C:/Apps/Replit/conductor-worktrees/grid-direction-backtest-20261019-handback/evidence/direction-20261019T095720Z';
 const cfg=read(path.join(prior,'configuration.json')),root=cfg.sourceDirectory,mb=fs.readFileSync(path.join(root,'manifest.json'));
 if(sha256(mb)!==cfg.manifestSha256)throw Error('Pacifica manifest mismatch');
 const manifest=JSON.parse(mb),all=[],bindings=[];
 const load=(d,r,venue)=>{
  const file=path.join(r,d.file),bytes=fs.readFileSync(file);if(sha256(bytes)!==d.sha256)throw Error('Dataset SHA-256 mismatch');
  bindings.push({file,sha256:d.sha256});
  const bars=JSON.parse(bytes).rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:venue,venue,basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
  for(const b of bars)if(trailDataHold([b],d.timeframe,b.time+(d.timeframe==='1h'?3600000:14400000))!=='warmup'&&venue!=='gate')throw Error('Invalid frozen research candle');
  all.push({...d,venue,bars});
 };
 for(const d of manifest.datasets.filter(d=>['1h','4h'].includes(d.timeframe)))load(d,root,'pacifica');
 for(const name of ['snapshot','fallback-snapshot-v2']){
  const r=path.join(direction,name),bytes=fs.readFileSync(path.join(r,'manifest.json')),m=JSON.parse(bytes);
  if(sha256(bytes)!==read(path.join(r,'manifest-sha256.json')).manifestSha256)throw Error('Proxy manifest mismatch');
  for(const d of m.datasets.filter(d=>['okx','gate'].includes(d.venue)&&['1h','4h'].includes(d.timeframe)))load(d,r,d.venue);
 }
 const datasets=[];
 for(const symbol of ['BTC','ETH','SOL','HYPE','ZEC'])for(const timeframe of ['1h','4h']){
  const pd=all.find(d=>d.venue==='pacifica'&&d.symbol===symbol&&d.timeframe===timeframe),od=all.find(d=>d.venue==='okx'&&d.symbol===symbol&&d.timeframe===timeframe);
  const bars=[...(od?.bars.filter(b=>b.time<pd.bars[0].time)??[]),...pd.bars],duration=timeframe==='1h'?3600000:14400000;
  const md=manifest.markets.find(m=>m.symbol===symbol),market={symbol,tick:md.tick_size,lot:md.lot_size,minimumQuote:md.min_order_size,maximumQuote:md.max_order_size,minimumPrice:Number(md.min_tick)>0?md.min_tick:md.tick_size,maximumPrice:md.max_tick};
  const indices=new Map(bars.map((b,i)=>[b.time,i])),dataHolds=bars.map((b,i)=>trailDataHold(bars.slice(Math.max(0,i-100),i),timeframe,b.time));
  datasets.push({symbol,timeframe,market,bars,indices,duration,dataHolds,directStart:pd.bars[0].time,hasProxy:!!od});
 }
 return {datasets,bindings,all};
}
export function windows(d,period){
 if(!inRegisteredPopulation({period,symbol:d.symbol}))return [];
 const earliest=d.directStart+Math.max(100*d.duration,10.5*DAY);
 const from=period==='proxy'?Date.parse('2022-01-02T00:00:00Z'):period==='development'?SPLIT-Math.floor((SPLIT-earliest)/(7*DAY))*7*DAY:SPLIT;
 const through=period==='evaluation'?FINISH:SPLIT,rows=[];
 if(period==='proxy'&&!d.hasProxy)return rows;
 for(const horizonDays of [14,30])for(let launchAt=from;launchAt+horizonDays*DAY<=through;launchAt+=7*DAY){
  if(period==='proxy'&&launchAt>=d.directStart)break;
  const endAt=launchAt+horizonDays*DAY,start=d.indices.get(launchAt),last=d.indices.get(endAt-d.duration);
  let reason=start===undefined||last===undefined?'missing_boundary':d.dataHolds[start];
  const before=start===undefined?null:d.bars[start-1],old=before?d.indices.get(before.time-30*DAY):undefined;
  const preReturn=old===undefined?null:before.close/d.bars[old].close-1;
  const regime=preReturn===null?'unknown':preReturn>0.1?'trending_up':preReturn< -0.1?'trending_down':'ranging';
  rows.push({horizonDays,launchAt,endAt,start:start??-1,end:last===undefined?-1:last+1,reason,regime,year:new Date(launchAt).getUTCFullYear(),source:launchAt<d.directStart?(endAt>d.directStart?'proxy_to_pacifica':'okx_proxy'):'pacifica'});
 }
 return rows;
}
