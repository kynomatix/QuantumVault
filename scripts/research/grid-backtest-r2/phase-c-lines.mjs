import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {fixedReplay} from './fixed-replay.mjs';
import {Stats} from './stats.mjs';
import {loadData,windows,read,sha256} from './data.mjs';
const root=process.argv[2],started=Date.now(),data=loadData(),stats=new Stats(),settings=[],diagnostics=new Map();
if(read(path.join(root,'admission-summary.json')).canonicalFailures!==0)throw Error('Admission prerequisite');
for(const window of ['week','month'])for(const intervals of [6,10,14,20,30,50])for(const investment of [1000,500,250])
 settings.push({id:`lines-${window}-${intervals}-${investment}`,family:'lines',window,intervals,investment,makerRate:0.00115,takerRate:0.0014});
for(const window of ['week','month'])for(const intervals of [10,20,30,50])for(const tier of ['tier1','vip1'])for(const builder of [0,0.0002,0.0005,0.001])
 settings.push({id:`fees-${window}-${intervals}-${tier}-${builder}`,family:'fees',window,intervals,investment:1000,makerRate:(tier==='tier1'?0.00015:0)+builder,takerRate:(tier==='tier1'?0.0004:0.0003)+builder,tier,builder});
const baseline='lines-week-10-1000';
fs.writeFileSync(path.join(root,'phase-c-lines-method.json'),JSON.stringify({createdAt:new Date().toISOString(),settings,baseline,workerCount:1,bindings:data.bindings,feeDiagnostic:'Zero-maker analytical planner only; excluded from admitted performance',stop:'Shipped and round-one winning stop are identical, deduplicated.'},null,2)+'\n',{flag:'wx'});
for(const period of ['development','evaluation','proxy']){
 const fd=fs.openSync(path.join(root,`phase-c-lines-${period}.jsonl`),'wx');
 for(const d of data.datasets){
  const gs=new Map(),ps=new Map();
  for(const w of windows(d,period)){
   const scenario=new Map();
   for(const s of settings){
    const gkey=[w.launchAt,s.window].join('|');
    if(!gs.has(gkey))gs.set(gkey,w.start<0?{ok:false,reason:'missing launch'}:await geometryAt(d.bars,d.timeframe,w.start,d.market,s.window));
    const g=gs.get(gkey);
    for(const direction of ['long','short']){
     const pkey=[w.launchAt,s.id,direction].join('|');
     if(!ps.has(pkey)){
      let policy=null,reason=g.ok?null:g.reason,minimumOnlyReason=null,minimumRatio=null;
      const input={market:d.market,geometry:g.geometry,direction,seed:true,mode:'step_back',intervals:s.intervals,economics:{investment:s.investment.toFixed(2),makerRate:String(s.makerRate),takerRate:String(s.takerRate),leverage:1}};
      if(!reason){
       try{policy=makeTrailGrid(input,String(d.bars[w.start-1].close));}catch(e){reason=e.message;}
       // This counterfactual diagnoses minimum-order rejection independently of the fee gate.
       try{
        const diagnostic=makeTrailGrid({...input,economics:{...input.economics,makerRate:'0'}},String(d.bars[w.start-1].close));
        const levels=diagnostic.levels;minimumRatio=Math.min(...levels.slice(1).map((l,i)=>(Number(l.price)-Number(levels[i].price))/(s.makerRate*(Number(l.price)+Number(levels[i].price)))));
       }catch(e){minimumOnlyReason=e.message;}
      }
      ps.set(pkey,{policy,reason,minimumOnlyReason,minimumRatio});
     }
     const p=ps.get(pkey),reason=w.reason??p.reason;
     for(const pathName of ['OHLC','OLHC']){
      const row={period,setting:s.id,family:s.family,market:d.symbol,timeframe:d.timeframe,direction,path:pathName,...w,admitted:!reason};delete row.start;delete row.end;
      if(reason)row.reason=reason;
      else {
       const r=fixedReplay({candles:d.bars,dataHolds:d.dataHolds,market:d.market,policy:p.policy,start:w.start,end:w.end,path:pathName,timeframe:d.timeframe,makerRate:s.makerRate,takerRate:s.takerRate});
       Object.assign(row,{netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,fees:r.fees,fillCount:r.fillCount,protectiveStop:r.protectiveStop,seedHold:r.seedHold});
      }
      stats.record(row);fs.writeSync(fd,JSON.stringify(row)+'\n');scenario.set([s.id,direction,pathName].join('|'),row);
      const key=[period,s.id].join('|');if(!diagnostics.has(key))diagnostics.set(key,{period,setting:s.id,scheduled:0,plannerAttempted:0,feeRejected:0,minimumRejectedAfterFees:0,minimumOnlyRejected:0,ratioKnown:0,ratioTotal:0,minimumRatio:null});
      const a=diagnostics.get(key);a.scheduled++;
      if(!w.reason&&g.ok){
       a.plannerAttempted++;a.feeRejected+=Number(/fee|profit/i.test(p.reason??''));a.minimumRejectedAfterFees+=Number(/minimum|too small|at least/i.test(p.reason??'')&&!/fee|profit/i.test(p.reason??''));
       a.minimumOnlyRejected+=Number(/minimum|too small|at least/i.test(p.minimumOnlyReason??''));
       if(Number.isFinite(p.minimumRatio)){a.ratioKnown++;a.ratioTotal+=p.minimumRatio;a.minimumRatio=Math.min(a.minimumRatio??Infinity,p.minimumRatio);}
      }
     }
    }
   }
   for(const direction of ['long','short'])for(const p of ['OHLC','OLHC']){
    const b=scenario.get([baseline,direction,p].join('|'));for(const s of settings)stats.pair(scenario.get([s.id,direction,p].join('|')),b);
   }
  }
  console.log(`Phase C lines/fees ${period} ${d.symbol} ${d.timeframe}: ${stats.admitted}/${stats.total} admitted`);
 }
 fs.closeSync(fd);
 if(period==='development')fs.writeFileSync(path.join(root,'phase-c-lines-selection.json'),JSON.stringify({lines:stats.select(settings.filter(s=>s.family==='lines'&&s.investment===1000).map(s=>s.id),baseline),fees:stats.select(settings.filter(s=>s.family==='fees').map(s=>s.id),baseline)},null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(root,`phase-c-lines-${period}-complete.json`),JSON.stringify({completedAt:new Date().toISOString(),runsSha256:sha256(fs.readFileSync(path.join(root,`phase-c-lines-${period}.jsonl`))),selectionSha256:sha256(fs.readFileSync(path.join(root,'phase-c-lines-selection.json')))},null,2)+'\n');
 fs.writeFileSync(path.join(root,'phase-c-lines-summary.json'),JSON.stringify({...stats.json(),diagnostics:[...diagnostics.values()],seconds:(Date.now()-started)/1000,host:os.hostname()},null,2)+'\n');
}
