import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {canonicalGridPolicy} from '../../../server/grid-bot/policy-hmac.ts';
import {retainedGridCycles} from '../../../server/grid-bot/cycle-policy.ts';
import {rollingWindows} from '../../../server/grid-bot/trail-rolling.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';

const [out]=process.argv.slice(2),start=Date.now(),DAY=86400000;
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const direction='C:/Apps/Replit/conductor-worktrees/grid-direction-backtest-20261019-handback/evidence/direction-20261019T095720Z';
const prior='C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence/round2-20261019T044511Z/evaluation';
const cfg=read(path.join(prior,'configuration.json')),root=cfg.sourceDirectory,manifestBytes=fs.readFileSync(path.join(root,'manifest.json'));
if(hash(manifestBytes)!==cfg.manifestSha256)throw Error('Pacifica manifest mismatch');
const manifest=JSON.parse(manifestBytes),datasets=[],bindings=[];
const toBars=(rows,venue)=>rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:venue,venue,basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
for(const d of manifest.datasets.filter(d=>['1h','4h'].includes(d.timeframe))){
  const file=path.join(root,d.file),bytes=fs.readFileSync(file);
  if(hash(bytes)!==d.sha256)throw Error('Pacifica data mismatch');
  datasets.push({...d,venue:'pacifica',bars:toBars(JSON.parse(bytes).rows,'pacifica')});bindings.push({file,sha256:d.sha256});
}
for(const name of ['snapshot','fallback-snapshot-v2']){
  const r=path.join(direction,name),mb=fs.readFileSync(path.join(r,'manifest.json')),m=JSON.parse(mb);
  if(hash(mb)!==read(path.join(r,'manifest-sha256.json')).manifestSha256)throw Error('Proxy manifest mismatch');
  if(hash(fs.readFileSync(path.join(r,'responses.jsonl')))!==m.rawResponsesSha256)throw Error('Proxy response mismatch');
  for(const d of m.datasets){
    const file=path.join(r,d.file),bytes=fs.readFileSync(file);
    if(hash(bytes)!==d.sha256)throw Error('Proxy data mismatch');
    if(['okx','gate'].includes(d.venue)&&['1h','4h'].includes(d.timeframe))datasets.push({...d,bars:toBars(JSON.parse(bytes).rows,d.venue)});
    bindings.push({file,sha256:d.sha256});
  }
}
const counts=new Map(),geometryCache=new Map(),split=Date.parse('2026-03-01T00:00:00Z'),finish=Date.parse('2026-10-19T00:00:00Z');
let canonicalFailures=0,endpointAdjustments=0,minimumFreeGiB=os.freemem()/2**30;
const fd=fs.openSync(path.join(out,'admission-runs.jsonl'),'wx');
for(const period of ['development','evaluation','proxy']){
 for(const symbol of period==='proxy'?['BTC','ETH','SOL']:['BTC','ETH','SOL','HYPE','ZEC']){
  for(const timeframe of ['1h','4h']){
   const pd=datasets.find(d=>d.venue==='pacifica'&&d.symbol===symbol&&d.timeframe===timeframe);
   const bars=period==='proxy'?datasets.find(d=>d.venue==='okx'&&d.symbol===symbol&&d.timeframe===timeframe).bars:pd.bars;
   const md=manifest.markets.find(m=>m.symbol===symbol),market={symbol,tick:md.tick_size,lot:md.lot_size,minimumQuote:md.min_order_size,maximumQuote:md.max_order_size,minimumPrice:Number(md.min_tick)>0?md.min_tick:md.tick_size,maximumPrice:md.max_tick};
   const duration=timeframe==='1h'?3600000:14400000,earliest=bars[0].time+Math.max(100*duration,10.5*DAY);
   const from=period==='proxy'?Date.parse('2022-01-02T00:00:00Z'):period==='development'?split-Math.floor((split-earliest)/(7*DAY))*7*DAY:split;
   const to=period==='proxy'?pd.bars[0].time:period==='development'?split:finish;
   for(const horizonDays of [14,30])for(const w of rollingWindows(bars,timeframe,from,to,horizonDays)){
    const gkey=[period,symbol,timeframe,w.launchAt].join('|');
    if(!geometryCache.has(gkey))geometryCache.set(gkey,w.hold?{ok:false,reason:w.hold}:await geometryAt(bars,timeframe,w.start,market,'week'));
    const g=geometryCache.get(gkey);
    for(const mode of ['repeat_all','step_back'])for(const intervals of [6,10,14,20,30,50])for(const side of ['long','short']){
      const key=[period,mode,intervals].join('|');
      const c=counts.get(key)??{period,mode,intervals,scheduled:0,admitted:0,rejections:{},endpointAdjustments:0};counts.set(key,c);
      // Paths share one launch plan. Each path is a scheduled run, matching round 1.
      c.scheduled+=2;let reason=g.ok?null:g.reason,p=null;
      if(!reason)try{p=makeTrailGrid({market,direction:side,seed:true,mode,geometry:g.geometry,intervals},String(bars[w.start-1].close));}catch(e){reason=e.message;}
      if(reason){c.rejections[reason]=(c.rejections[reason]??0)+2;if(reason==='Generated research policy is not canonical')canonicalFailures+=2;}
      else{
        if(!canonicalGridPolicy(p)||p.gridCount!==intervals||p.levels.length!==intervals+1)throw Error('Admission invariant');
        const shift=Number(g.geometry.upper)-Number(p.upperPrice);
        if(shift < -1e-8 || shift > Number(market.tick)+1e-8)throw Error('Unexpected endpoint displacement');
        if(shift>1e-8){c.endpointAdjustments+=2;endpointAdjustments+=2;}
        for(const cycle of retainedGridCycles(p))if(cycle.recycles!==false&&Number(cycle.quantity)*Number(cycle.openingPrice)<10-1e-8)throw Error('Minimum violation');
        c.admitted+=2;
      }
      fs.writeSync(fd,JSON.stringify({period,symbol,timeframe,horizonDays,launchAt:w.launchAt,mode,intervals,side,pathCount:2,admitted:!reason,reason,requestedUpper:g.geometry?.upper,actualUpper:p?.upperPrice})+'\n');
    }
   }
   minimumFreeGiB=Math.min(minimumFreeGiB,os.freemem()/2**30);
  }
 }
}
fs.closeSync(fd);
const result={createdAt:new Date().toISOString(),seconds:(Date.now()-start)/1000,host:os.hostname(),workers:1,minimumFreeGiB,canonicalFailures,endpointAdjustments,bindings,rows:[...counts.values()],runsSha256:hash(fs.readFileSync(path.join(out,'admission-runs.jsonl')))};
fs.writeFileSync(path.join(out,'admission-summary.json'),JSON.stringify(result,null,2)+'\n');
const lines=['# Phase A admission prerequisite','','The research policy now uses the actual planner endpoints. Product canonical validation is unchanged. Counts include both candle paths, as in round 1. No returns were replayed.','','| Period | Mode | Intervals | Admitted / scheduled | Endpoint shifts | Rejections |','|---|---|---:|---:|---:|---|'];
for(const r of result.rows)lines.push(`| ${r.period} | ${r.mode} | ${r.intervals} | ${r.admitted}/${r.scheduled} | ${r.endpointAdjustments} | ${Object.entries(r.rejections).map(([k,v])=>`${k}: ${v}`).join('; ')||'none'} |`);
lines.push('',`Canonical failures: ${canonicalFailures}. Runtime: ${result.seconds.toFixed(1)} seconds; one worker; minimum free memory ${minimumFreeGiB.toFixed(2)} GiB.`);
fs.writeFileSync(path.join(out,'PHASE-A-ADMISSION.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({canonicalFailures,rows:result.rows.length,scheduled:result.rows.reduce((s,r)=>s+r.scheduled,0),admitted:result.rows.reduce((s,r)=>s+r.admitted,0),seconds:result.seconds}));
if(canonicalFailures)throw Error('Precondition failed; do not replay');
