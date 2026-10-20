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
import {DAY,SETTINGS,closedHistory,rankSelections,armMembership,proxyCalendar,selectDevelopment} from './core.mjs';
const [root,period]=process.argv.slice(2), started=Date.now();
if (!root || !['development','evaluation','proxy'].includes(period)) throw Error('Usage: root development|evaluation|proxy');
const prior='C:/Apps/Replit/conductor-worktrees/grid-backtest-r2-20261020-handback/evidence/r2-20261020T062012Z';
const registration=path.resolve('scripts/research/grid-finder/PREREGISTRATION.md');
const preregistrationCommitHash=fs.readFileSync(path.join(root,'preregistration-commit-hash.txt'),'utf8').trim();
if (!/^[a-f0-9]{40}$/.test(preregistrationCommitHash)) throw Error('Preregistration commit hash missing');
const lockPath=path.join(root,'development-lock.json');
if (period !== 'development' && !fs.existsSync(lockPath)) throw Error('Development must be locked first');
const data=loadData();
if (period === 'proxy') data.datasets=data.datasets.filter(d => ['BTC','ETH','SOL'].includes(d.symbol)).map(d => {
  const frozen=data.all.find(x => x.symbol === d.symbol && x.timeframe === d.timeframe && x.venue === 'okx');
  const bars=frozen.bars, indices=new Map(bars.map((b,i) => [b.time,i]));
  const dataHolds=bars.map((b,i) => trailDataHold(bars.slice(Math.max(0,i-100),i),d.timeframe,b.time));
  return {...d,bars,indices,dataHolds,directStart:Infinity};
});
const publicFacts=publicData(prior,data);
const selections=new Map(), selectionRows=[];
function selectionAt(timeframe,launchAt) {
  const key=`${timeframe}|${launchAt}`;
  if (!selections.has(key)) {
    const universe=data.datasets.filter(d => d.timeframe === timeframe &&
      (period === 'proxy' || launchAt>=d.directStart));
    const rows=universe.map(d => {
      let chosen=null, candles=null, regime=null;
      for (const venue of ['okx','gate']) {
        const series=data.all.find(x => x.symbol === d.symbol && x.timeframe === timeframe && x.venue === venue);
        const history=series ? closedHistory(series.bars,launchAt,d.duration) : null;
        if (!history) continue;
        const fact=plannerRegime(d.symbol+'-PERP',timeframe,history,launchAt);
        if (fact.state !== 'available') continue;
        chosen=venue; candles=history; regime=fact; break;
      }
      const measured=candles ? qualifyRangingMarket(d.symbol+'-PERP',d.symbol,timeframe,candles,launchAt,launchAt) : {state:'unavailable'};
      return {period,timeframe,launchAt,symbol:d.symbol,state:measured.state,adx:regime?.adx ?? null,
        adxLabel:regime?.label ?? null,venue:chosen,firstCandleAt:candles?.[0].time ?? null,
        latestFinalizedTime:candles?.at(-1).time ?? null,lowerPrice:measured.candidate?.lowerPrice ?? null,
        upperPrice:measured.candidate?.upperPrice ?? null,
        reason:measured.state === 'unavailable' ? (candles ? 'structural range unavailable' : 'no complete authorized finder history') : null};
    });
    const ranked=rankSelections(rows);
    selections.set(key,ranked); selectionRows.push(...ranked);
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
    const selection=selectionAt(d.timeframe,w.launchAt).find(r => r.symbol === d.symbol);
    if (!selection) throw Error('Execution market absent from point-in-time universe');
    const arms=armMembership(selection);
    let dataReason=w.reason;
    if (!dataReason && d.dataHolds[w.start]) dataReason=d.dataHolds[w.start];
    if (!dataReason && (w.end-w.start !== w.horizonDays*DAY/d.duration ||
        d.bars.slice(w.start,w.end).some((b,i) => b.time !== w.launchAt+i*d.duration))) dataReason='gapped execution horizon';
    if (!dataReason && d.markBars.slice(w.start,w.end).some(b => !b)) dataReason='missing actual Pacifica mark candle';
    if (!dataReason && d.fundingCoverage.slice(w.start,w.end).some(x => !x)) dataReason='incomplete settled funding coverage';
    if (!geometryCache.has(w.launchAt)) geometryCache.set(w.launchAt,
      w.start < 1 ? {ok:false,reason:'missing launch history'} : await geometryAt(d.bars,d.timeframe,w.start,d.market,'week'));
    const g=geometryCache.get(w.launchAt);
    for (const s of SETTINGS) for (const direction of ['long','short']) {
      const pkey=[w.launchAt,s.id,direction].join('|');
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
        const row={period,setting:s.id,builderRate:s.builderRate,leverage:s.leverage,market:d.symbol,
          timeframe:d.timeframe,launchAt:w.launchAt,horizonDays:w.horizonDays,year:w.year,regime:w.regime,source:w.source,
          direction,path:pathName,markPath,selectionState:selection.state,adx:selection.adx,rank:selection.rank,arms,
          admitted:!reason,reason:reason ?? null,...result};
        attempted++; if (row.admitted) admitted++; else rejectionCounts[reason]=(rejectionCounts[reason] ?? 0)+1;
        fs.writeSync(fd,JSON.stringify(row)+'\n');
        if (period === 'development') dev.push(row);
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
fs.writeFileSync(path.resolve(root,'../../RESUME.md'),`# Finder research checkpoint\n\nCompleted ${period}: ${admitted} unique ADMITTED simulations; ${attempted-admitted} rejected. One worker; all frozen input SHA-256 bindings verified. Development lock written before confirmation. Evidence: ${root}\n\nNext: ${period === 'development' ? 'evaluation, then proxy' : period === 'evaluation' ? 'proxy' : 'report, review scan, delivery bundle'}.\n`);
console.log(JSON.stringify({period,admitted,attempted,seconds:method.seconds,selection:period === 'development' ? JSON.parse(fs.readFileSync(lockPath,'utf8')).selected : 'already locked'}));
