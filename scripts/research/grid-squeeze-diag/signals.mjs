import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atr} from '../../../server/lab/indicators.ts';
import {plannerRegime} from '../../../server/grid-planner/regime.ts';
import {qualifyRangingMarket} from '../../../server/grid-planner/scanner.ts';
import {closedHistory} from '../grid-finder/core.mjs';
import {HOUR,DAY} from './stats.mjs';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export const ATR_BINS=['compressed','normal','elevated','UNAVAILABLE'];
export const AGE_BINS=['under 7 days','7-14 days','over 14 days','UNAVAILABLE'];
const BASE='C:/Apps/Replit/conductor-worktrees/grid-direction-backtest-20261019-handback/evidence/direction-20261019T095720Z';
const valid=b=>[b.open,b.high,b.low,b.close].every(x=>Number.isFinite(x)&&x>0)&&Number.isFinite(b.volume)&&b.volume>=0&&b.low<=Math.min(b.open,b.close)&&b.high>=Math.max(b.open,b.close);
export function loadSeries(symbol,bindings){
  const series=[];
  for(const folder of ['snapshot','fallback-snapshot-v2']){
    const root=path.join(BASE,folder),mf=path.join(root,'manifest.json'),hf=path.join(root,'manifest-sha256.json'),bytes=fs.readFileSync(mf);
    if(sha256(bytes)!==JSON.parse(fs.readFileSync(hf,'utf8')).manifestSha256)throw Error('Signal manifest SHA-256 mismatch');
    bindings.set(mf,sha256(bytes));bindings.set(hf,sha256(fs.readFileSync(hf)));
    const items=JSON.parse(bytes).datasets.filter(d=>d.symbol===symbol&&d.timeframe==='1h'&&['okx','gate'].includes(d.venue));
    for(const d of items){const file=path.join(root,d.file),raw=fs.readFileSync(file);if(sha256(raw)!==d.sha256)throw Error('Signal candle SHA-256 mismatch');bindings.set(file,d.sha256);
      const provenance={source:d.venue,venue:d.venue,basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'};
      const bars=JSON.parse(raw).rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance}));
      series.push({venue:d.venue,bars,atrCache:new Map()});
    }
  }
  return series;
}
const getHistory=(s,t,n)=>{const h=closedHistory(s.bars,t,HOUR,n);return h&&h.every(valid)?h:null;};
function volatility(s,t){
  if(!s.atrCache.has(t)){const h=getHistory(s,t,100);const a=h?atr(h.map(b=>b.high),h.map(b=>b.low),h.map(b=>b.close),14).at(-1):null;
    s.atrCache.set(t,a!==null&&Number.isFinite(a)&&a>0?{raw:a,normalized:a/h.at(-1).close}:null);}
  return s.atrCache.get(t);
}
const band=p=>p===null?'UNAVAILABLE':p<.2?'compressed':p>.8?'elevated':'normal';
export function measure(series,market,launchAt){
  let chosen=null,history=null,regime=null;
  for(const venue of ['okx','gate']){const s=series.find(x=>x.venue===venue);if(!s)continue;const h=getHistory(s,launchAt,100);if(!h)continue;
    const r=plannerRegime(market+'-PERP','1h',h,launchAt);if(r.state!=='available')continue;chosen=s;history=h;regime=r;break;}
  const qualified=chosen?qualifyRangingMarket(market+'-PERP',market,'1h',history,launchAt,launchAt):{state:'unavailable'};
  const out={market,launchAt,venue:chosen?.venue??null,finderState:qualified.state,adx:regime?.adx??null,
    latestFinalizedTime:history?.at(-1).time??null,atr:null,atrPercentile:null,normalizedAtrPercentile:null,atrBin:'UNAVAILABLE',normalizedAtrBin:'UNAVAILABLE',
    ageDays:null,ageBin:'UNAVAILABLE',bandStatus:'UNAVAILABLE',bandLower:null,bandUpper:null,bandFrozenAt:launchAt-28*DAY,ageCensored:false};
  if(!chosen)return out;
  const current=volatility(chosen,launchAt),prior=Array.from({length:182},(_,i)=>volatility(chosen,launchAt-(i+1)*DAY));
  if(current&&prior.every(Boolean)){const rank=k=>prior.reduce((n,a)=>n+(a[k]<current[k]?1:a[k]===current[k]?.5:0),0)/182;
    out.atr=current.raw;out.atrPercentile=rank('raw');out.normalizedAtrPercentile=rank('normalized');out.atrBin=band(out.atrPercentile);out.normalizedAtrBin=band(out.normalizedAtrPercentile);}
  const aged=getHistory(chosen,launchAt,42*24);
  if(aged){const anchor=aged.slice(0,14*24),validation=aged.slice(14*24);const lower=Math.min(...anchor.map(b=>b.low)),upper=Math.max(...anchor.map(b=>b.high));
    if(upper>lower){let hours=0;for(let i=validation.length-1;i>=0;i--){const c=validation[i].close;if(c<lower||c>upper)break;hours++;}
      out.ageDays=hours/24;out.ageBin=out.ageDays<7?'under 7 days':out.ageDays<=14?'7-14 days':'over 14 days';out.bandStatus=hours?'INSIDE':'OUTSIDE';
      out.bandLower=lower;out.bandUpper=upper;out.ageCensored=hours===28*24;}
  }
  if(out.latestFinalizedTime+HOUR>launchAt)throw Error('Future signal input');return out;
}
