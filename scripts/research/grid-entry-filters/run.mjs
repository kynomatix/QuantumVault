import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {qualifyRangingMarket} from '../../../server/grid-planner/scanner.ts';
import {plannerRegime} from '../../../server/grid-planner/regime.ts';
import {trailDataHold} from '../../../server/grid-bot/trail-policy.ts';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {loadData,windows,sha256} from '../grid-backtest-r2/data.mjs';
import {publicData} from '../grid-backtest-r2/public-data.mjs';
import {fixedReplay} from '../grid-backtest-r2/fixed-replay.mjs';
import {projection} from '../grid-backtest-r2/projection.mjs';
import {proxyCalendar} from '../grid-finder/core.mjs';
import {DAY,SETTINGS,chooseSignal,features,evaluateRules,memberships,selectDevelopment} from './core.mjs';
const [root,period]=process.argv.slice(2), started=Date.now();
if (!root || !['development','evaluation','proxy'].includes(period)) throw Error('Usage: root development|evaluation|proxy');
const prior='C:/Apps/Replit/conductor-worktrees/grid-backtest-r2-20261020-handback/evidence/r2-20261020T062012Z';
const registration=path.resolve('scripts/research/grid-entry-filters/PREREGISTRATION.md');
const preregistrationCommitHash=fs.readFileSync(path.join(root,'preregistration-commit-hash.txt'),'utf8').trim();
if (!/^[a-f0-9]{40}$/.test(preregistrationCommitHash)) throw Error('Preregistration commit hash missing');
const lockPath=path.join(root,'development-lock.json');
if (period !== 'development' && !fs.existsSync(lockPath)) throw Error('Development must be locked first');
const frozenRegistration=JSON.parse(fs.readFileSync(path.join(root,'registration.json'),'utf8'));
if (frozenRegistration.sha256 !== sha256(fs.readFileSync(registration)) || frozenRegistration.commitHash !== preregistrationCommitHash)
 throw Error('Registration changed after commit');
if (period !== 'development') {
 const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
 if(lock.preregistrationSha256 !== frozenRegistration.sha256)throw Error('Lock registration mismatch');
}
const data=loadData();
if (period === 'proxy') data.datasets=data.datasets.filter(d => ['BTC','ETH','SOL'].includes(d.symbol)).map(d => {
  const frozen=data.all.find(x => x.symbol === d.symbol && x.timeframe === d.timeframe && x.venue === 'okx');
  const bars=frozen.bars, indices=new Map(bars.map((b,i) => [b.time,i]));
  const dataHolds=bars.map((b,i) => trailDataHold(bars.slice(Math.max(0,i-100),i),d.timeframe,b.time));
  return {...d,bars,indices,dataHolds,directStart:Infinity};
});
const publicFacts=publicData(prior,data);
const selections=new Map(), selectionRows=[];
function selectionAt(symbol,launchAt) {
 const key=`${symbol}|${launchAt}`;
 if (!selections.has(key)) {
  const series=data.all.filter(x=>x.symbol===symbol&&x.timeframe==='1h');
  const chosen=chooseSignal(series,launchAt,h=>{
   const regime=plannerRegime(symbol+'-PERP','1h',h,launchAt);
   const measured=qualifyRangingMarket(symbol+'-PERP',symbol,'1h',h,launchAt,launchAt);
   return {state:measured.state,adx:regime.state==='available'?regime.adx:null};
  });
  const f=chosen?features(chosen.history,chosen):null, rules=evaluateRules(f);
  const row={period,launchAt,symbol,venue:chosen?.venue??null,measurable:!!f,
   firstCandleAt:chosen?.history[0].time??null,latestFinalizedTime:chosen?.history.at(-1).time??null,
   features:f,rules,arms:memberships(rules,!!f)};
  selections.set(key,row);selectionRows.push(row);
 }
 return selections.get(key);
}
const out=path.join(root,`runs-${period}.jsonl`),fd=fs.openSync(out,'wx'), dev=[];
let attempted=0,admitted=0;
const rejectionCounts={};
for (const d of data.datasets) {
  const geometryCache=new Map(), policyCache=new Map();
  const calendar=period === 'proxy' ? proxyCalendar(d.duration,d.indices,d.bars) : windows(d,period);
  for (const w of calendar) {
    const selection=selectionAt(d.symbol,w.launchAt);
    if (!selection) throw Error('Execution market absent from point-in-time universe');
    const arms=selection.arms;
    let dataReason=w.reason;
    if (!dataReason && d.dataHolds[w.start]) dataReason=d.dataHolds[w.start];
    if (!dataReason && (w.end-w.start !== w.horizonDays*DAY/d.duration ||
        d.bars.slice(w.start,w.end).some((b,i) => b.time !== w.launchAt+i*d.duration))) dataReason='gapped execution horizon';
    if (!dataReason && d.markBars.slice(w.start,w.end).some(b => !b)) dataReason='missing actual Pacifica mark candle';
    if (!dataReason && d.fundingCoverage.slice(w.start,w.end).some(x => !x)) dataReason='incomplete settled funding coverage';
    for (const window of ['week','month']) {
    const gkey=w.launchAt+'|'+window;
    if (!geometryCache.has(gkey)) geometryCache.set(gkey,
      w.start < 1 ? {ok:false,reason:'missing launch history'} : await geometryAt(d.bars,d.timeframe,w.start,d.market,window));
    const g=geometryCache.get(gkey);
    for (const s of SETTINGS) for (const direction of ['long','short']) {
      const pkey=[w.launchAt,window,s.id,direction].join('|');
      if (!policyCache.has(pkey)) {
        let policy=null, reason=g.ok ? null : g.reason, clearance=null;
        if (!reason) try {
          policy=makeTrailGrid({market:d.market,direction,mode:'step_back',seed:true,geometry:g.geometry,intervals:10,
            economics:{investment:'1000.00',leverage:s.leverage,makerRate:String(s.makerRate),takerRate:String(s.takerRate)}},
            String(d.bars[w.start-1].close));
          clearance=projection(policy,d.market,d.maxLeverage,s.makerRate,s.takerRate,w.launchAt);
          if (clearance.state !== 'available') reason=clearance.reason;
        } catch(error) { reason=error.message; }
        policyCache.set(pkey,{policy,reason,clearance});
      }
      const p=policyCache.get(pkey);
      for (const pathName of ['OHLC','OLHC']) for (const markPath of ['OHLC','OLHC']) {
        let reason=dataReason ?? p.reason, result=null;
        if (!reason) {
          const r=fixedReplay({candles:d.bars,dataHolds:d.dataHolds,market:d.market,timeframe:d.timeframe,
            start:w.start,end:w.end,policy:p.policy,path:pathName,markPath,markBars:d.markBars,
            fundingEvents:d.fundingEvents,maxLeverage:d.maxLeverage,makerRate:s.makerRate,takerRate:s.takerRate,
            moveMode:'fixed',stopMode:'touch'});
          reason=r.unavailable;
          if (!reason) result={netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,protectiveStop:r.protectiveStop,
            liquidated:r.liquidated,seedHold:r.seedHold,fees:r.fees,funding:r.funding,fillCount:r.fillCount};
          if (result && ![result.netReturn,result.maxDrawdown,result.fees,result.funding].every(Number.isFinite))
            throw Error('Nonfinite admitted result');
        }
        const row={period,window,setting:s.id,builderRate:s.builderRate,leverage:s.leverage,market:d.symbol,
          timeframe:d.timeframe,launchAt:w.launchAt,horizonDays:w.horizonDays,year:w.year,regime:w.regime,source:w.source,
          direction,path:pathName,markPath,selectionState:selection.measurable ? 'available' : 'unavailable',adx:selection.features?.adx??null,arms,
          admitted:!reason,reason:reason ?? null,...result};
        attempted++; if (row.admitted) admitted++; else rejectionCounts[reason]=(rejectionCounts[reason] ?? 0)+1;
        fs.writeSync(fd,JSON.stringify(row)+'\n');
        if (period === 'development') dev.push(row);
      }
    }
  }
  }
  console.log(`${period} ${d.symbol} ${d.timeframe}: admitted ${admitted}; attempted ${attempted}`);
}
fs.closeSync(fd);
fs.writeFileSync(path.join(root,`selections-${period}.json`),JSON.stringify(selectionRows)+'\n',{flag:'wx'});
if (period === 'development') fs.writeFileSync(lockPath,JSON.stringify({createdAt:new Date().toISOString(),
  preregistrationCommitHash,preregistrationSha256:sha256(fs.readFileSync(registration)),...selectDevelopment(dev)},null,2)+'\n',{flag:'wx'});
const method={period,preregistrationCommitHash,preregistrationSha256:sha256(fs.readFileSync(registration)),
  developmentLockSha256:sha256(fs.readFileSync(lockPath)),runsSha256:sha256(fs.readFileSync(out)),
  selectionSha256:sha256(fs.readFileSync(path.join(root,`selections-${period}.json`))),bindings:data.bindings,publicFacts,
  attempted,admitted,rejectionCounts,settings:SETTINGS,host:os.hostname(),workers:1,freeGB:os.freemem()/2**30,
  seconds:(Date.now()-started)/1000,completedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,`complete-${period}.json`),JSON.stringify(method,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.resolve(root,'../../RESUME.md'),`# Entry-filter research checkpoint\n\nCompleted ${period}: ${admitted} unique ADMITTED simulations; ${attempted-admitted} rejected. One worker; all frozen input SHA-256 bindings verified. Development lock written before confirmation. Evidence: ${root}\n\nNext: ${period === 'development' ? 'evaluation, then proxy' : period === 'evaluation' ? 'proxy' : 'report, review scan, delivery bundle'}.\n`);
console.log(JSON.stringify({period,admitted,attempted,seconds:method.seconds,selection:period === 'development' ? JSON.parse(fs.readFileSync(lockPath,'utf8')).selected : 'already locked'}));
