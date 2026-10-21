import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {trailDataHold} from '../../../server/grid-bot/trail-policy.ts';
import {hourlyFundingCoverage,completeHourlyWeek} from '../grid-walkforward/hourly-funding.mjs';
export const HOUR=3600000,DAY=24*HOUR,WEEK=7*DAY,SPLIT=Date.parse('2026-03-01Z'),FINISH=Date.parse('2026-10-19Z');
export const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback';
const PRIOR='C:/Apps/Replit/conductor-worktrees/';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export const bindings=new Map();
function file(p,expected){const b=fs.readFileSync(p),h=sha256(b);if(expected&&h!==expected.toLowerCase())throw Error('Input hash mismatch: '+p);bindings.set(p,{file:p,sha256:h,bytes:b.length});return JSON.parse(b);}
const barsOf=(rows,venue)=>rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:venue,venue,basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
export function inventory(){
 const wf=PRIOR+'grid-walkforward-20261021-handback',cert=fs.readFileSync(path.join(wf,'certified-root-r2.txt'),'utf8').trim();
 const admission=file(path.join(cert,'admission.json'));
 if(admission.admittedMarkets!==12||admission.results.filter(x=>x.admitted).length!==12)throw Error('Expected twelve certified markets');
 const source=fs.readFileSync(path.join(wf,'evidence-root.txt'),'utf8').trim(),instruments=file(path.join(source,'instruments.response')).data;
 const trail=PRIOR+'grid-trail-backtest-20261019-handback/evidence',cfg=file(path.join(trail,'round2-20261019T044511Z/evaluation/configuration.json'));
 const manifest=file(path.join(cfg.sourceDirectory,'manifest.json'),cfg.manifestSha256);
 const r2=PRIOR+'grid-backtest-r2-20261020-handback/evidence/r2-20261020T062012Z',pub=fs.readFileSync(path.join(r2,'public-history-path.txt'),'utf8').trim();
 const pm=file(path.join(pub,'manifest.json'),file(path.join(pub,'manifest-sha256.json')).manifestSha256),info=file(path.join(r2,'node-public-info.json')).data;
 return {wf,admission,instruments,cfg,manifest,pub,pm,info};
}
export function loadMarket(inv,cohort,symbol){
 let market,bars,marks,funding,maxLeverage,first;
 const certified=inv.admission.results.find(x=>x.symbol===symbol&&x.admitted);
 if(cohort==='okx'){
  const inst=inv.instruments.find(x=>x.instId===certified.market);
  if(Number(inst.minSz)!==Number(inst.lotSz)||inst.ctValCcy!==symbol)throw Error('Unsupported OKX contract');
  market={symbol,tick:inst.tickSz,lot:String(Number(inst.ctVal)*Number(inst.lotSz)),minimumQuote:'10',maximumQuote:'1000000000',minimumPrice:inst.tickSz,maximumPrice:'1000000000'};
  bars=barsOf(file(path.join(inv.admission.priceRoot,certified.price.file),certified.price.sha256).rows,'okx');marks=bars;
  funding=file(certified.fundingFile,certified.fundingSha256).rows;maxLeverage=Number(inst.lever);first=Date.parse('2022-03-01Z');
 }else{
  const ds=inv.manifest.datasets.find(x=>x.symbol===symbol&&x.timeframe==='1h'),md=inv.manifest.markets.find(x=>x.symbol===symbol);
  const direct=barsOf(file(path.join(inv.cfg.sourceDirectory,ds.file),ds.sha256).rows,'pacifica');first=direct[0].time;
  const history=certified&&['BTC','ETH','SOL'].includes(symbol)?barsOf(file(path.join(inv.admission.priceRoot,certified.price.file),certified.price.sha256).rows,'okx').filter(b=>b.time<first):[];
  bars=[...history,...direct];market={symbol,tick:md.tick_size,lot:md.lot_size,minimumQuote:String(Math.max(10,Number(md.min_order_size))),maximumQuote:md.max_order_size,minimumPrice:Number(md.min_tick)>0?md.min_tick:md.tick_size,maximumPrice:md.max_tick};
  const m=inv.pm.datasets.find(x=>x.kind==='mark'&&x.symbol===symbol&&x.timeframe==='1h');
  const mm=new Map(barsOf(file(path.join(inv.pub,m.file),m.sha256).rows,'pacifica').map(b=>[b.time,b]));marks=bars.map(b=>mm.get(b.time));
  const f=inv.pm.datasets.find(x=>x.kind==='settled-funding'&&x.symbol===symbol);funding=file(path.join(inv.pub,f.file),f.sha256).rows;
  maxLeverage=Number(inv.info.find(x=>x.symbol===symbol).max_leverage);
 }
 const index=new Map(bars.map((b,i)=>[b.time,i])),fundingEvents=bars.map(()=>[]),fundingHours=new Set();
 for(const f of funding){if(!Number.isSafeInteger(f.time)||!Number.isFinite(f.rate))throw Error('Invalid funding');const t=Math.floor(f.time/HOUR)*HOUR;fundingHours.add(t);const i=index.get(t);if(i!==undefined)fundingEvents[i].push(f);}
 // Certified OKX observed-event schedule is reused, with its raw delayed timestamps.
 const coverage=cohort==='okx'?null:hourlyFundingCoverage(funding);
 const bad=[0];for(let i=0;i<bars.length;i++){const b=bars[i],m=marks[i];const valid=[b.open,b.high,b.low,b.close].every(v=>Number.isFinite(v)&&v>0)&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close);
  const invalid=!valid||!m||![m.open,m.high,m.low,m.close].every(v=>Number.isFinite(v)&&v>0)||(i&&b.time!==bars[i-1].time+HOUR);bad.push(bad.at(-1)+Number(!!invalid));}
 const dataHolds=bars.map((b,i)=>trailDataHold(bars.slice(Math.max(0,i-100),i),'1h',b.time));
 return {market,bars,marks,fundingEvents,maxLeverage,first,index,bad,dataHolds,coverage};
}
export function calendar(d,cohort){
 const from=cohort==='okx'?Date.parse('2022-03-01Z'):cohort==='development'?d.first:Math.max(SPLIT,d.first),through=cohort==='development'?SPLIT:FINISH;
 const anchor=Date.parse('2022-01-03Z'),out=[];
 for(let week=anchor,k=0;week<through;week+=WEEK,k++){
  const slot=k%21,launchAt=week+Math.floor(slot/3)*DAY+(slot%3)*8*HOUR;
  if(launchAt<from)continue;
  for(const horizonDays of [14,30]){const endAt=launchAt+horizonDays*DAY;if(endAt>through)continue;
   const start=d.index.get(launchAt),end=d.index.get(endAt-HOUR);let reason=null;
   if(start===undefined||end===undefined)reason='missing execution boundary';
   else if(start<840||d.bars[start-840].time!==launchAt-840*HOUR)reason='incomplete 35-day prehistory';
   else if(end+1-start!==horizonDays*24||d.bad[end+1]!==d.bad[start])reason='incomplete trade/mark/funding horizon';
   else if(d.coverage&&!completeHourlyWeek(d.coverage,launchAt,endAt))reason='missing or ambiguous observed hourly funding';
   else if(d.dataHolds[start])reason=d.dataHolds[start];
   out.push({launchAt,horizonDays,start,end:end===undefined?undefined:end+1,reason});
  }
 }
 return out;
}
