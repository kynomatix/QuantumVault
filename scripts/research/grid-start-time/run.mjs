import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {qualifyRangingMarket} from '../../../server/grid-planner/scanner.ts';
import {plannerRegime} from '../../../server/grid-planner/regime.ts';
import {trailDataHold} from '../../../server/grid-bot/trail-policy.ts';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {loadData,windows,sha256,SPLIT,FINISH} from '../grid-backtest-r2/data.mjs';
import {publicData} from '../grid-backtest-r2/public-data.mjs';
import {fixedReplay} from '../grid-backtest-r2/fixed-replay.mjs';
import {projection} from '../grid-backtest-r2/projection.mjs';
import {proxyCalendar} from '../grid-finder/core.mjs';
import {chooseSignal,features,evaluateRules} from '../grid-entry-filters/core.mjs';
import {DAY,SETTINGS,PERIODS,launches,offsetWindow} from './core.mjs';

const [root,period]=process.argv.slice(2),started=Date.now(),handback=path.resolve(root,'../..');
if(!root||!PERIODS.includes(period))throw Error('Usage: root development|evaluation|proxy');
const registration=fs.readFileSync('scripts/research/grid-start-time/PREREGISTRATION.md');
const frozen=JSON.parse(fs.readFileSync(path.join(root,'registration.json'),'utf8'));
if(sha256(registration)!==frozen.sha256||! /^[a-f0-9]{40}$/.test(frozen.commitHash))throw Error('Registration binding invalid');
const data=loadData();data.datasets=data.datasets.filter(d=>d.timeframe==='1h');
if(period==='proxy')data.datasets=data.datasets.filter(d=>['BTC','ETH','SOL'].includes(d.symbol)).map(d=>{
  const bars=data.all.find(x=>x.symbol===d.symbol&&x.timeframe==='1h'&&x.venue==='okx').bars;
  return {...d,bars,indices:new Map(bars.map((b,i)=>[b.time,i])),
    dataHolds:bars.map((b,i)=>trailDataHold(bars.slice(Math.max(0,i-100),i),'1h',b.time)),directStart:Infinity};
});
const publicFacts=publicData('C:/Apps/Replit/conductor-worktrees/grid-backtest-r2-20261020-handback/evidence/r2-20261020T062012Z',data);
const through=period==='proxy'?Date.parse('2026-01-01T00:00:00Z'):period==='development'?SPLIT:FINISH;
let attempted=0,admitted=0,slotAdmitted=0,r1Admitted=0;const rejectionCounts={},files=[],signals=[];
const checkpoint=detail=>fs.writeFileSync(path.join(handback,'RESUME.md'),`# Start-time checkpoint\n\n${period}: ${detail}. Unique ADMITTED ${admitted}; attempted ${attempted}. One worker.\nEvidence: ${root}\nPreregistration commitHash: ${frozen.commitHash}\nNo selection. Do not overwrite partial raw files; a fresh execution root is required after an interruption.\n`);
for(const d of data.datasets) {
  const file=path.join(root,`runs-${period}-${d.symbol}.jsonl`),fd=fs.openSync(file,'wx');
  const calendar=period==='proxy'?proxyCalendar(d.duration,d.indices,d.bars):windows(d,period);
  const geometryCache=new Map(),policyCache=new Map(),selections=new Map();let written=0;
  const signalAt=launchAt=>{
    if(!selections.has(launchAt)) {
      const chosen=chooseSignal(data.all.filter(x=>x.symbol===d.symbol&&x.timeframe==='1h'),launchAt,h=>{
        const regime=plannerRegime(d.symbol+'-PERP','1h',h,launchAt),m=qualifyRangingMarket(d.symbol+'-PERP',d.symbol,'1h',h,launchAt,launchAt);
        return {state:m.state,adx:regime.state==='available'?regime.adx:null};
      });
      const f=chosen?features(chosen.history,chosen):null,rule=evaluateRules(f).R1_ESTABLISHED;
      const s={launchAt,market:d.symbol,r1:rule.state,measurable:!!f,venue:chosen?.venue??null,
        lowerTouches:f?.lowerTouches??null,upperTouches:f?.upperTouches??null,position:f?.position??null,
        latestFinalizedTime:chosen?.history.at(-1).time??null};
      selections.set(launchAt,s);signals.push(s);
    }
    return selections.get(launchAt);
  };
  for(const base of calendar)for(const launch of launches(base.launchAt)) {
    const w=offsetWindow(d,base,launch,through),signal=signalAt(w.launchAt);
    let dataReason=w.reason;
    if(!dataReason&&d.dataHolds[w.start])dataReason=d.dataHolds[w.start];
    if(!dataReason&&(w.end-w.start!==w.horizonDays*DAY/d.duration||d.bars.slice(w.start,w.end).some((b,i)=>b.time!==w.launchAt+i*d.duration)))dataReason='gapped execution horizon';
    if(!dataReason&&d.markBars.slice(w.start,w.end).some(b=>!b))dataReason='missing actual Pacifica mark candle';
    if(!dataReason&&d.fundingCoverage.slice(w.start,w.end).some(x=>!x))dataReason='incomplete settled funding coverage';
    for(const s of SETTINGS)for(const direction of ['long','short']) {
      const pkey=[w.launchAt,s.config,direction].join('|');
      if(!dataReason&&!policyCache.has(pkey)) {
        const gkey=w.launchAt+'|'+s.window;
        if(!geometryCache.has(gkey))geometryCache.set(gkey,w.start<1?{ok:false,reason:'missing launch history'}:await geometryAt(d.bars,'1h',w.start,d.market,s.window));
        const g=geometryCache.get(gkey);let policy=null,reason=g.ok?null:g.reason;
        if(!reason)try {
          policy=makeTrailGrid({market:d.market,direction,mode:s.mode,seed:true,geometry:g.geometry,intervals:10,
            economics:{investment:'1000.00',leverage:s.leverage,makerRate:String(s.makerRate),takerRate:String(s.takerRate)}},String(d.bars[w.start-1].close));
          const clearance=projection(policy,d.market,d.maxLeverage,s.makerRate,s.takerRate,w.launchAt);
          if(clearance.state!=='available')reason=clearance.reason;
        }catch(error){reason=error.message;}
        policyCache.set(pkey,{policy,reason});
      }
      const p=policyCache.get(pkey);
      for(const pathName of ['OHLC','OLHC'])for(const markPath of ['OHLC','OLHC']) {
        let reason=dataReason??p.reason,result=null;
        if(!reason) {
          const r=fixedReplay({candles:d.bars,dataHolds:d.dataHolds,market:d.market,timeframe:'1h',start:w.start,end:w.end,
            policy:p.policy,path:pathName,markPath,markBars:d.markBars,fundingEvents:d.fundingEvents,maxLeverage:d.maxLeverage,
            makerRate:s.makerRate,takerRate:s.takerRate,moveMode:'fixed',stopMode:'touch'});
          reason=r.unavailable;
          if(!reason)result={netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,protectiveStop:r.protectiveStop,
            liquidated:r.liquidated,seedHold:r.seedHold,fees:r.fees,funding:r.funding,fillCount:r.fillCount};
          if(result&&![result.netReturn,result.maxDrawdown,result.fees,result.funding].every(Number.isFinite))throw Error('Nonfinite admitted output');
        }
        const row={period,anchor:w.anchor,slots:w.slots,launchAt:w.launchAt,year:w.year,market:d.symbol,timeframe:'1h',
          horizonDays:w.horizonDays,window:s.window,setting:s.id,config:s.config,builderRate:s.builderRate,leverage:s.leverage,
          direction,path:pathName,markPath,r1:signal.r1,measurable:signal.measurable,signalVenue:signal.venue,
          admitted:!reason,reason:reason??null,...result};
        attempted++;written++;
        if(row.admitted){admitted++;slotAdmitted+=row.slots.length;if(s.id==='A_WEEK'&&signal.r1==='pass')r1Admitted++;}
        else rejectionCounts[reason]=(rejectionCounts[reason]??0)+1;
        fs.writeSync(fd,JSON.stringify(row)+'\n');
      }
    }
    if(written%3200===0)checkpoint(`${d.symbol}, ${new Date(w.launchAt).toISOString()}`);
  }
  fs.closeSync(fd);files.push({file,sha256:sha256(fs.readFileSync(file)),rows:written});
  checkpoint(`${d.symbol} complete`);
  console.log(JSON.stringify({period,market:d.symbol,admitted,attempted,seconds:(Date.now()-started)/1000}));
}
const signalPath=path.join(root,`signals-${period}.json`);fs.writeFileSync(signalPath,JSON.stringify(signals)+'\n',{flag:'wx'});
const receipt={period,preregistrationCommitHash:frozen.commitHash,preregistrationSha256:frozen.sha256,files,
  signalsSha256:sha256(fs.readFileSync(signalPath)),bindings:data.bindings,publicFacts,attempted,admitted,slotAdmitted,r1Admitted,rejectionCounts,
  host:os.hostname(),workers:1,freeGB:os.freemem()/2**30,seconds:(Date.now()-started)/1000,completedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,`complete-${period}.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
checkpoint('period complete');console.log(JSON.stringify({period,admitted,attempted,seconds:receipt.seconds}));
