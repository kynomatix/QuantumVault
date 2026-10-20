import fs from 'node:fs';
import path from 'node:path';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {loadData,read,windows} from './data.mjs';
import {rejectionKind} from './rejection-kind.mjs';
const root=process.argv[2];
if(!fs.existsSync(path.join(root,'phase-c-lines-registered-summary.json')))await import('./registered-results.mjs');
const source=read(path.join(root,'phase-c-lines-registered-summary.json')),method=read(path.join(root,'phase-c-lines-method.json')),data=loadData(),minimum=new Map(),raw=new Map();
// Correct categories directly from immutable exact-reason counts. Old category fields are retained.
for(const r of source.rejections){
 const [period,setting,...parts]=r.key.split('|'),reason=parts.join('|'),key=[period,setting].join('|');
 if(!raw.has(key))raw.set(key,{fee:0,minimum:0,other:0});
 raw.get(key)[rejectionKind(reason)??'other']+=r.count;
}
// An investment-only planner diagnostic, once per unique launch/direction/window/count/equity.
// It does not admit performance or replace any product fee gate.
for(const period of ['development','evaluation','proxy']){
 for(const d of data.datasets){
  const gs=new Map(),ps=new Map();
  for(const w of windows(d,period)){
   if(w.reason)continue;
   for(const s of method.settings.filter(s=>s.family==='lines')){
    const gk=[w.launchAt,s.window].join('|');
    if(!gs.has(gk))gs.set(gk,await geometryAt(d.bars,d.timeframe,w.start,d.market,s.window));
    const g=gs.get(gk);if(!g.ok)continue;
    for(const direction of ['long','short']){
     const pk=[gk,s.intervals,s.investment,direction].join('|');
     if(!ps.has(pk)){
      let reason=null,minStepFeeRatio=null;
      try{
       const p=makeTrailGrid({market:d.market,geometry:g.geometry,direction,seed:true,mode:'step_back',intervals:s.intervals,economics:{investment:s.investment.toFixed(2),leverage:1,makerRate:'0',takerRate:'0.0014'}},String(d.bars[w.start-1].close));
       minStepFeeRatio=Math.min(...p.levels.slice(1).map((l,i)=>(Number(l.price)-Number(p.levels[i].price))/(0.00115*(Number(l.price)+Number(p.levels[i].price)))));
      }catch(e){reason=e.message;}
      ps.set(pk,{reason,minStepFeeRatio});
     }
     const key=[period,s.window,s.intervals,s.investment].join('|');
     if(!minimum.has(key))minimum.set(key,{period,window:s.window,intervals:s.intervals,investment:s.investment,attempts:0,rejected:0,minimumRejected:0,otherRejected:0,reasons:{},minStepFeeRatio:null});
     const a=minimum.get(key),{reason,minStepFeeRatio}=ps.get(pk);a.attempts+=2;
     if(minStepFeeRatio!==null)a.minStepFeeRatio=Math.min(a.minStepFeeRatio??Infinity,minStepFeeRatio);
     if(reason){a.rejected+=2;a[rejectionKind(reason)==='minimum'?'minimumRejected':'otherRejected']+=2;a.reasons[reason]=(a.reasons[reason]??0)+2;}
    }
   }
  }
  console.log(`Minimum-only audit ${period} ${d.symbol} ${d.timeframe}`);
 }
 fs.writeFileSync(path.join(root,'phase-c-lines-diagnostics-corrected.json'),JSON.stringify({correction:'Original classifier did not recognize exact fee-clearance/cycle-minima messages; performance unchanged. Correct fee/min counts use original rejection inventory. Minimum-only counts use actual planner with zero maker analytical override, excluded from performance.',diagnostics:method.settings.flatMap(s=>['development','evaluation','proxy'].map(period=>({period,setting:s.id,...(raw.get([period,s.id].join('|'))??{fee:0,minimum:0,other:0}),minimumOnly:minimum.get([period,s.window,s.intervals,s.investment].join('|'))??null})))},null,2)+'\n');
}
