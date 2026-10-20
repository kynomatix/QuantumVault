import fs from 'node:fs';
import {ClosePairDetail} from './close-pair-detail.mjs';
import {inRegisteredPopulation} from './registered-population.mjs';
import {heldEquity} from './held-equity.mjs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt,widerGeometry} from '../grid-defaults/geometry.mjs';
import {fixedReplay} from './fixed-replay.mjs';
import {loadData,read,sha256} from './data.mjs';
import {publicData} from './public-data.mjs';
const root=process.argv[2],started=Date.now(),data=loadData(),publicFacts=publicData(root,data),groups=new Map(),markGroups=new Map();
const settings=read(path.join(root,'phase-b-method.json')).settings;
fs.writeFileSync(path.join(root,'phase-b-mark-held-method.json'),JSON.stringify({publicFacts,createdAt:new Date().toISOString(),
 held:'Replays the identical admitted traded-price strategy with actual funding, then freezes pre-stop cash/inventory and charges observed future funding through original horizon plus hypothetical market exit. Missing payment coverage gives unknown. No liquidation is imposed in this descriptive 1x held counterfactual.',
 mark:'Same trade candles and fees; touch trigger and equity marks replaced with actual Pacifica mark candles. Both mark paths crossed with both trade paths. No old-proxy mark is substituted in this comparison. Exact intrabar synchronization unavailable.'},null,2)+'\n',{flag:'wx'});
function group(map,row){
 const out=[];
 for(const [dimension,value] of [['all','all'],['regime',row.regime],['year',row.year],['market',row.market]]){
  const key=[row.period,row.setting,dimension,value].join('|');
  if(!map.has(key))map.set(key,{period:row.period,setting:row.setting,dimension,value,n:0,unknown:0,profitable:0,heldReturn:0,tradeStops:0,markStops:0,tradeOnlyStops:0,markOnlyStops:0,delta:0,drawdownDelta:0,touchHunts:0,huntsAvoided:0});
  out.push(map.get(key));
 }
 return out;
}
const closeDetail=new ClosePairDetail();
for(const period of ['development','evaluation','proxy']){
 const fd=fs.openSync(path.join(root,`phase-b-mark-held-${period}.jsonl`),'wx');
 let lastDataset=null,gs=new Map(),ps=new Map(),count=0;
 for await(const line of createInterface({input:fs.createReadStream(path.join(root,`phase-b-${period}.jsonl`)),crlfDelay:Infinity})){
  const row=JSON.parse(line),s=settings.find(s=>s.id===row.setting);
  if(!inRegisteredPopulation(row))continue;
  closeDetail.record(row,s);if(!row.admitted)continue;
  const direct=row.source==='pacifica';
  if(!row.protectiveStop&&(!direct||s.stopMode!=='touch'))continue;
  const d=data.datasets.find(d=>d.symbol===row.market&&d.timeframe===row.timeframe),key=d.symbol+d.timeframe;
  if(key!==lastDataset){gs.clear();ps.clear();lastDataset=key;}
  const start=d.indices.get(row.launchAt),end=d.indices.get(row.endAt-d.duration)+1;
  const gkey=[row.launchAt,s.window,s.multiplier].join('|'),pk=[gkey,s.mode,row.direction].join('|');
  if(!gs.has(gkey)){const g=await geometryAt(d.bars,d.timeframe,start,d.market,s.window);if(!g.ok)throw Error('Admitted geometry no longer available');gs.set(gkey,widerGeometry(g.geometry,s.multiplier,d.market.tick));}
  if(!ps.has(pk))ps.set(pk,makeTrailGrid({market:d.market,direction:row.direction,seed:true,mode:s.mode,geometry:gs.get(gkey),intervals:10},String(d.bars[start-1].close)));
  const input={candles:d.bars,dataHolds:d.dataHolds,market:d.market,policy:ps.get(pk),start,end,timeframe:d.timeframe,path:row.path,stopMode:s.stopMode};
  const output={period,setting:s.id,market:row.market,timeframe:row.timeframe,launchAt:row.launchAt,horizonDays:row.horizonDays,direction:row.direction,path:row.path,regime:row.regime,year:row.year};
  if(row.protectiveStop){
   const buckets=group(groups,row);
   if(d.fundingCoverage.slice(start,end).some(x=>!x)){buckets.forEach(a=>a.unknown++);output.heldKnown=false;}
   else{
    const r=fixedReplay({...input,fundingEvents:d.fundingEvents}),stop=r.stopSnapshot;
    if(!stop)throw Error('Funding-only replay changed stop outcome');
    let futureFunding=0;
    for(let i=stop.index;i<end;i++)for(const f of d.fundingEvents[i])if(f.time>stop.time){
     const bar=d.bars[i],nodes=row.path==='OHLC'?[bar.open,bar.high,bar.low,bar.close]:[bar.open,bar.low,bar.high,bar.close];
     const at=Math.max(0,Math.min(3,(f.time-bar.time)/d.duration*3)),segment=Math.min(2,Math.floor(at));
     const proxyPrice=nodes[segment]+(nodes[segment+1]-nodes[segment])*(at-segment);
     futureFunding+=stop.position*(f.oraclePrice??proxyPrice)*f.rate;
    }
    const exit=d.bars[end-1].close,heldReturn=heldEquity({cash:stop.cash,position:stop.position,exitPrice:exit,futureFunding})/1000-1;
    output.heldKnown=true;output.fundedHeldReturn=heldReturn;output.fundingBeforeStop=r.funding;output.fundingAfterStop=futureFunding;
    for(const a of buckets){a.n++;a.profitable+=Number(heldReturn>0);a.heldReturn+=heldReturn;}
   }
  }
  if(direct&&s.stopMode==='touch'){
   const buckets=group(markGroups,row);
   if(d.markBars.slice(start,end).some(b=>!b)){buckets.forEach(a=>a.unknown+=2);output.markUnknown=true;}
   else{
    output.markScenarios=[];
    for(const markPath of ['OHLC','OLHC']){
     const r=fixedReplay({...input,markBars:d.markBars,markPath});
     output.markScenarios.push({markPath,netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,stop:r.protectiveStop,stopAt:r.stopSnapshot?.time??null});
     for(const a of buckets){
      a.n++;a.tradeStops+=row.protectiveStop;a.markStops+=r.protectiveStop;a.tradeOnlyStops+=Number(row.protectiveStop&&!r.protectiveStop);
      a.markOnlyStops+=Number(!row.protectiveStop&&r.protectiveStop);a.delta+=r.netReturn-row.netReturn;a.drawdownDelta+=r.maxDrawdown-row.maxDrawdown;
      if(row.follow7&&row.back7){a.touchHunts++;a.huntsAvoided+=Number(!r.stopSnapshot||r.stopSnapshot.time>=row.returnAt);}
     }
    }
   }
  }
  fs.writeSync(fd,JSON.stringify(output)+'\n');count++;
 }
 fs.closeSync(fd);
 fs.writeFileSync(path.join(root,'phase-b-close-pair-detail.json'),JSON.stringify({method:'Same-return-candle stop order is uncertain. Certain hunt avoidance excludes that candle; original candle-open estimate is retained separately. Extra breakdown loss is final net-equity difference, including any remaining inventory. No selection use.',rows:closeDetail.rows()},null,2)+'\n');
 fs.writeFileSync(path.join(root,'phase-b-mark-held-summary.json'),JSON.stringify({held:[...groups.values()],mark:[...markGroups.values()],seconds:(Date.now()-started)/1000},null,2)+'\n');
 fs.writeFileSync(path.join(root,`phase-b-mark-held-${period}-complete.json`),JSON.stringify({rows:count,runsSha256:sha256(fs.readFileSync(path.join(root,`phase-b-mark-held-${period}.jsonl`)))},null,2)+'\n');
 console.log(`Funded held/mark ${period}: ${count} replay rows`);
}
