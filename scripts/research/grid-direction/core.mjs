import {computeBtcDirection} from '../../../server/grid-planner/direction.ts';
import {validateCandles} from '../../../server/grid-planner/chart.ts';
import {plannerRegime} from '../../../server/grid-planner/regime.ts';
import {gridSignalViews} from '../../../client/src/lib/grid-signals-view.ts';
import {btcUtcWeekStart,BTC_TREND_WEEK_MS as WEEK} from '../../../shared/grid-direction.ts';
import {gridHistoryWindow} from '../../../shared/grid-lookback.ts';
export const DAY=86400000;
export const duration=tf=>({'1h':3600000,'4h':14400000,'1d':DAY}[tf]);
export function toBars(rows,venue){return rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:venue,venue,basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));}
export function closedWindow(bars,now,ms,count){
  // Time-based window mirrors the public pool request; gaps cannot pull older bars in.
  let lo=0,hi=bars.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid].time+ms<=now)lo=mid+1;else hi=mid;}
  return bars.slice(Math.max(0,lo-count),lo).filter(b=>b.time>=now-count*ms);
}
export function classifySignals(views,side){
  const relative=d=>d==='neutral'?'neutral/mixed':d===side?'aligned':'against';
  const individual=Object.fromEntries(views.map(v=>[v.name,v.unavailable?'unavailable':relative(v.direction)]));
  const available=views.filter(v=>!v.unavailable),long=available.filter(v=>v.direction==='long').length,short=available.filter(v=>v.direction==='short').length;
  const all=!available.length?'unavailable':long===available.length?relative('long'):short===available.length?relative('short'):'neutral/mixed';
  const majority=!available.length?'unavailable':long>available.length/2?relative('long'):short>available.length/2?relative('short'):'neutral/mixed';
  return {...individual,'All available agree':all,'Majority agree':majority};
}
export function signalAt({market,timeframe,launchAt,sources,macroSources,aggregateStructureWeeks,computeWeeklyStructure}){
  const completed=btcUtcWeekStart(launchAt),poolCount=gridHistoryWindow(timeframe,'week').chartBars,count=Math.min(200,poolCount);
  let macro=computeBtcDirection([],launchAt),weekly={state:'unavailable',reason:'No complete weekly source window.'},trend={state:'unavailable',reason:'No fresh direct perpetual history.'};
  const attempts=[];
  for(const source of macroSources){
    const raw=source.rows.filter(r=>r[0]+WEEK<=launchAt).slice(-50).map(([weekStart,close])=>({market:'BTC',weekStart,close:String(close),source:source.source,basis:source.basis,aggregation:'native',finalized:true,fetchedAt:weekStart+WEEK}));
    const candidate=computeBtcDirection(raw,launchAt);attempts.push({kind:'Macro',source:source.source,state:candidate.regime});
    if(candidate.regime!=='unavailable'){macro=candidate;break;}macro=candidate;
  }
  let weeklySource=null,trendSource=null,weeklyInput=[],trendInput=[];
  for(const source of sources){
    const days=closedWindow(source.days??[],completed,DAY,364);
    const weeks=aggregateStructureWeeks(days,launchAt);
    // Match the transport selection: complete >=7-week history wins even if swings are neutral/missing.
    if(weeks.length>=7&&weeks.at(-1).time+WEEK===completed){weekly=computeWeeklyStructure(market,weeks,launchAt);weeklySource=source.venue;weeklyInput=weeks;break;}
  }
  let selected=[];
  for(const source of sources){
    const bars=closedWindow(source.bars??[],launchAt,duration(timeframe),poolCount);
    const valid=validateCandles(bars,launchAt)&&bars.every((c,i)=>c.provenance.source===source.venue&&c.time%duration(timeframe)===0&&c.time+duration(timeframe)<=launchAt&&Number.isFinite(c.volume)&&c.volume>=0&&(!i||c.time===bars[i-1].time+duration(timeframe)))&&bars.at(-1)?.time+duration(timeframe)===launchAt;
    attempts.push({kind:'Trend pool',source:source.venue,valid,bars:bars.length,requestedBars:poolCount});
    if(valid&&bars.length>selected.length){selected=bars;trendSource=source.venue;}
    if(valid&&bars.length===poolCount){selected=bars;trendSource=source.venue;break;}
  }
  trendInput=selected.slice(-200);trend=plannerRegime(market,timeframe,trendInput,launchAt);
  const funding={state:'unavailable',reason:'No archived Pacifica /info quote with point-in-time freshness; current quotes and proxy funding are not substituted.'};
  const views=gridSignalViews(macro,{market,serverNow:launchAt,weekly,funding},market,timeframe,trend);
  const inputAudit={latestMacroClose:macro.regime==='unavailable'?null:macro.asOf,latestWeeklyClose:weeklyInput.at(-1)?.time+WEEK||null,latestTrendClose:trendInput.at(-1)?.time+duration(timeframe)||null,
    weeklySource,trendSource,trendBars:trendInput.length,requestedTrendBars:count,requestedPoolBars:poolCount,reconstructedAvailability:true};
  if(Object.entries(inputAudit).some(([k,v])=>k.startsWith('latest')&&v!==null&&v>launchAt))throw Error('Look-ahead input');
  return {market,timeframe,launchAt,macro,weekly,trend,funding,views:views.map(({name,direction,unavailable})=>({name,direction,unavailable})),inputAudit,attempts};
}
export function metrics(rows){
  if(!rows.length)return {runs:0,launches:0,meanReturn:null,medianReturn:null,profitableShare:null,stopRate:null,meanDrawdown:null,worstDrawdown:null};
  const r=rows.map(x=>x.netReturn).sort((a,b)=>a-b),mid=Math.floor(r.length/2);
  return {runs:rows.length,launches:new Set(rows.map(x=>[x.market,x.timeframe,x.launchAt].join('|'))).size,meanReturn:r.reduce((a,b)=>a+b,0)/r.length,
    medianReturn:r.length%2?r[mid]:(r[mid-1]+r[mid])/2,profitableShare:r.filter(x=>x>0).length/r.length,stopRate:rows.filter(x=>x.stopped).length/r.length,
    meanDrawdown:rows.reduce((a,b)=>a+b.maxDrawdown,0)/r.length,worstDrawdown:Math.max(...rows.map(x=>x.maxDrawdown))};
}