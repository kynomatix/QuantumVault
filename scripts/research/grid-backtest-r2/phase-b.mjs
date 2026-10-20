import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt,widerGeometry} from '../grid-defaults/geometry.mjs';
import {fixedReplay} from './fixed-replay.mjs';
import {loadData,windows,read,sha256,DAY} from './data.mjs';
const out=process.argv[2],start=Date.now();
if(read(path.join(out,'admission-summary.json')).canonicalFailures!==0)throw Error('Admission prerequisite failed');
const data=loadData(),summaries=new Map(),comparisons=new Map(),rejects=new Map(),geometryCache=new Map(),policies=new Map();
const baseline='week-1-repeat_all-touch',settings=[];
for(const window of ['day','week','month'])for(const multiplier of [1,1.5,2])for(const mode of ['repeat_all','step_back'])for(const stopMode of ['touch','1h-close','4h-close'])settings.push({id:`${window}-${multiplier}-${mode}-${stopMode}`,window,multiplier,mode,stopMode});
const add=(map,key,seed)=>{if(!map.has(key))map.set(key,seed);return map.get(key);};
function accumulate(row){
 for(const [dimension,value] of [['all','all'],['regime',row.regime],['year',row.year],['market',row.market],['timeframe',row.timeframe],['source',row.source],['direction',row.direction],['horizon',row.horizonDays],['path',row.path]]){
  const key=[row.period,row.setting,dimension,value].join('|'),a=add(summaries,key,{period:row.period,setting:row.setting,dimension,value,n:0,netReturn:0,maxDrawdown:0,worstDrawdown:0,fees:0,fillCount:0,stops:0,seedHolds:0,follow3:0,follow7:0,back3:0,back7:0,heldProfit:0,heldKnown:0});
  a.n++;for(const k of ['netReturn','maxDrawdown','fees','fillCount'])a[k]+=row[k];
  a.worstDrawdown=Math.max(a.worstDrawdown,row.maxDrawdown);a.stops+=row.protectiveStop;a.seedHolds+=Number(row.seedHold);
  for(const k of ['follow3','follow7','back3','back7','heldProfit','heldKnown'])a[k]+=Number(row[k]??0);
 }
}
function paired(row,base){
 const key=[row.period,row.setting,row.path].join('|');
 const a=add(comparisons,key,{period:row.period,setting:row.setting,path:row.path,scheduled:0,admitted:0,baseAdmitted:0,paired:0,delta:0,drawdownDelta:0,regimes:{},markets:{}});
 a.scheduled++;a.admitted+=Number(row.admitted);a.baseAdmitted+=Number(base.admitted);
 if(!row.admitted||!base.admitted)return;
 a.paired++;a.delta+=row.netReturn-base.netReturn;a.drawdownDelta+=row.maxDrawdown-base.maxDrawdown;
 for(const [field,k] of [['regimes',row.regime],['markets',row.market]]){
  const b=a[field][k]??={n:0,delta:0};b.n++;b.delta+=row.netReturn-base.netReturn;
 }
}
function hunt(r,d,w,g){
 if(!r.stopSnapshot)return {};
 const s=r.stopSnapshot,after=d.bars.slice(s.index+1),inRange=b=>b.low<=Number(g.upper)&&b.high>=Number(g.lower);
 const output={heldKnown:true,heldProfit:s.cash+s.position*d.bars[w.end-1].close-Math.abs(s.position)*d.bars[w.end-1].close*0.0019>1000};
 // A traded-price touch in the remainder of the stopping candle is deliberately excluded.
 for(const days of [3,7]){
  const until=d.bars[s.index].time+days*DAY,follow=after.filter(b=>b.time<until);
  const complete=follow.length===days*DAY/d.duration-1&&follow.every((b,i)=>b.time===d.bars[s.index].time+(i+1)*d.duration);
  output['follow'+days]=complete;output['back'+days]=complete&&follow.some(inRange);
  if(days===7&&complete)output.returnAt=follow.find(inRange)?.time??null;
 }
 return output;
}
function select(period){
 const candidates=settings.filter(s=>s.id!==baseline).map(s=>{
  const paths=['OHLC','OLHC'].map(p=>comparisons.get([period,s.id,p].join('|'))).filter(Boolean);
  const pass=paths.length===2&&paths.every(a=>a.paired>0&&a.admitted>=a.baseAdmitted&&a.delta>0&&a.drawdownDelta<=0&&['trending_up','trending_down','ranging'].filter(k=>a.regimes[k]?.delta>0).length>=2&&Object.values(a.markets).filter(m=>m.delta>0).length>Object.keys(a.markets).length/2);
  return {setting:s.id,pass,meanDelta:paths.reduce((v,a)=>v+a.delta/a.paired,0)/paths.length,meanDrawdownDelta:paths.reduce((v,a)=>v+a.drawdownDelta/a.paired,0)/paths.length,paths};
 }).sort((a,b)=>b.meanDelta-a.meanDelta||a.meanDrawdownDelta-b.meanDrawdownDelta||a.setting.localeCompare(b.setting));
 return {createdAt:new Date().toISOString(),selected:candidates.find(c=>c.pass)?.setting??baseline,candidates};
}
const closePairs=new Map();let locked=null,total=0,admitted=0;
fs.writeFileSync(path.join(out,'phase-b-method.json'),JSON.stringify({createdAt:new Date().toISOString(),baseline,settings,oneHourClose:'Runs on the 1h strategy only; no hourly close is inferred from 4h OHLC. 4h strategy cells are explicitly uncomputed.',heldProfit:'Frozen inventory/cash before stop, marked at scheduled horizon less taker/slippage; funding excluded consistently with the round-1 base model. Funding-inclusive claims are reserved for Phase C leverage.',bindings:data.bindings},null,2)+'\n',{flag:'wx'});
for(const period of ['development','evaluation','proxy']){
 const fd=fs.openSync(path.join(out,`phase-b-${period}.jsonl`),'wx');
 for(const d of data.datasets){
  for(const w of windows(d,period)){
   const scenario=new Map();
   for(const setting of settings){
    const gkey=[d.symbol,d.timeframe,w.launchAt,setting.window].join('|');
    if(!geometryCache.has(gkey))geometryCache.set(gkey,w.start<0?{ok:false,reason:'missing_launch'}:await geometryAt(d.bars,d.timeframe,w.start,d.market,setting.window));
    const g=geometryCache.get(gkey),geometry=g.ok?widerGeometry(g.geometry,setting.multiplier,d.market.tick):null;
    for(const direction of ['long','short']){
     const pkey=[gkey,setting.multiplier,setting.mode,direction].join('|');
     if(!policies.has(pkey)){
      let policy=null,reason=g.ok?null:g.reason;
      if(!reason)try{policy=makeTrailGrid({market:d.market,direction,seed:true,mode:setting.mode,geometry,intervals:10},String(d.bars[w.start-1].close));}catch(e){reason=e.message;}
      policies.set(pkey,{policy,reason});
     }
     let {policy,reason}=policies.get(pkey);
     reason=w.reason??reason;
     if(setting.stopMode==='1h-close'&&d.timeframe==='4h')reason='uncomputed: 1h close on 4h strategy';
     for(const pathName of ['OHLC','OLHC']){
      const row={period,setting:setting.id,market:d.symbol,timeframe:d.timeframe,direction,path:pathName,...w,admitted:!reason};
      delete row.start;delete row.end;
      total++;
      if(reason){row.reason=reason;const key=[period,setting.id,reason].join('|');rejects.set(key,(rejects.get(key)??0)+1);}
      else{
       const r=fixedReplay({candles:d.bars,dataHolds:d.dataHolds,policy,market:d.market,start:w.start,end:w.end,path:pathName,timeframe:d.timeframe,stopMode:setting.stopMode});
       if(r.unavailable){
        row.admitted=false;row.reason=r.unavailable;const key=[period,setting.id,r.unavailable].join('|');rejects.set(key,(rejects.get(key)??0)+1);
       }else{
        Object.assign(row,{netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,fees:r.fees,fillCount:r.fillCount,protectiveStop:r.protectiveStop,seedHold:r.seedHold,unfilledCloseStop:r.unfilledCloseStop,stopAt:r.stopSnapshot?.time??null,stopSnapshot:r.stopSnapshot,finalMark:r.finalMark,...hunt(r,d,w,geometry)});
        admitted++;accumulate(row);
       }
      }
      fs.writeSync(fd,JSON.stringify(row)+'\n');scenario.set([setting.id,direction,pathName].join('|'),row);
     }
    }
   }
   for(const direction of ['long','short'])for(const pathName of ['OHLC','OLHC']){
    const base=scenario.get([baseline,direction,pathName].join('|'));
    for(const setting of settings)paired(scenario.get([setting.id,direction,pathName].join('|')),base);
    for(const setting of settings.filter(s=>s.stopMode!=='touch')){
     const r=scenario.get([setting.id,direction,pathName].join('|')),touch=scenario.get([`${setting.window}-${setting.multiplier}-${setting.mode}-touch`,direction,pathName].join('|'));
     if(!r.admitted||!touch.admitted)continue;
     const key=[period,setting.id].join('|'),a=add(closePairs,key,{period,setting:setting.id,n:0,delta:0,touchHunts:0,huntsAvoided:0,breakdowns:0,extraLoss:0,worstExtraLoss:0});
     a.n++;a.delta+=r.netReturn-touch.netReturn;
     if(touch.follow7&&touch.back7){a.touchHunts++;if(!r.stopAt||r.stopAt>=touch.returnAt)a.huntsAvoided++;}
     if(touch.protectiveStop&&touch.follow7&&!touch.back7){a.breakdowns++;const loss=Math.max(0,touch.netReturn-r.netReturn);a.extraLoss+=loss;a.worstExtraLoss=Math.max(a.worstExtraLoss,loss);}
    }
   }
  }
  geometryCache.clear();policies.clear();
  console.log(`Phase B ${period} ${d.symbol} ${d.timeframe}: ${total} scheduled, ${admitted} admitted`);
 }
 fs.closeSync(fd);
 if(period==='development'){locked=select(period);fs.writeFileSync(path.join(out,'phase-b-selection.json'),JSON.stringify(locked,null,2)+'\n',{flag:'wx'});}
 fs.writeFileSync(path.join(out,`phase-b-${period}-complete.json`),JSON.stringify({period,completedAt:new Date().toISOString(),runsSha256:sha256(fs.readFileSync(path.join(out,`phase-b-${period}.jsonl`))),selectionSha256:sha256(fs.readFileSync(path.join(out,'phase-b-selection.json')))},null,2)+'\n');
 fs.writeFileSync(path.join(out,'phase-b-summary.json'),JSON.stringify({summaries:[...summaries.values()],comparisons:[...comparisons.values()],closePairs:[...closePairs.values()],rejections:[...rejects].map(([key,count])=>({key,count})),total,admitted,seconds:(Date.now()-start)/1000,host:os.hostname(),workers:1},null,2)+'\n');
}
console.log(`Phase B complete: ${admitted}/${total} admitted; ${(Date.now()-start)/1000}s`);
