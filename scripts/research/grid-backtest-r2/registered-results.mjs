// Aggregate the immutable original runs under the preregistered population.
// No replay, reselection, result editing or rejected-run performance admission.
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {Stats} from './stats.mjs';
import {inRegisteredPopulation} from './registered-population.mjs';
const root=process.argv[2];
for(const [phase,baseline] of [['phase-b','week-1-repeat_all-touch'],['phase-c-lines','lines-week-10-1000']]){
 const stats=new Stats(),excluded=new Map(),sourceSummary=JSON.parse(fs.readFileSync(path.join(root,phase+'-summary.json'),'utf8'));
 for(const period of ['development','evaluation','proxy']){
  let key=null,rows=[];
  const flush=()=>{
   if(!rows.length)return;
   const bases=new Map(rows.filter(r=>r.setting===baseline).map(r=>[[r.direction,r.path].join('|'),r]));
   for(const r of rows)stats.pair(r,bases.get([r.direction,r.path].join('|')));
  };
  for await(const line of createInterface({input:fs.createReadStream(path.join(root,`${phase}-${period}.jsonl`)),crlfDelay:Infinity})){
   const r=JSON.parse(line);
   if(!inRegisteredPopulation(r)){
    const k=[r.period,r.market,r.setting,r.admitted?'admitted':'rejected'].join('|');
    excluded.set(k,(excluded.get(k)??0)+1);continue;
   }
   const next=[r.market,r.timeframe,r.launchAt,r.horizonDays].join('|');
   if(next!==key){flush();rows=[];key=next;}rows.push(r);
   stats.record(r);
   if(phase==='phase-b'&&r.admitted){
    for(const [dimension,value] of [['all','all'],['regime',r.regime],['year',r.year],['market',r.market],['path',r.path],['timeframe',r.timeframe],['source',r.source],['direction',r.direction],['horizon',r.horizonDays]]){
     const a=stats.groups.get([r.period,r.setting,dimension,value].join('|'));
     for(const k of ['follow3','follow7','back3','back7','heldProfit','heldKnown'])a[k]=(a[k]??0)+Number(r[k]??0);
    }
   }
  }
  flush();
 }
 const view={...sourceSummary,...stats.json(),registrationExclusions:[...excluded].map(([key,count])=>({key,count})),method:'Original raw outputs retained. HYPE/ZEC proxy rows excluded as preregistered; direct periods and development selections unchanged. Side/horizon summaries included. Original planner diagnostic categories retained for provenance; use independently corrected categories.'};
 fs.writeFileSync(path.join(root,phase+'-registered-summary.json'),JSON.stringify(view,null,2)+'\n',{flag:'wx'});
 console.log(`${phase}: registered population ${stats.admitted}/${stats.total}, ${excluded.size} exclusion groups`);
}
