import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {bootstrapDesign,weekAt,WEEK,REPLICATES,percentile} from '../grid-squeeze-diag/stats.mjs';
import {weightedTailMean,weightedLowerTails} from './tail-statistics.mjs';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback';
const phase=process.argv[2];
if(!['phase1','phase2'].includes(phase))throw Error('phase required');
const root=fs.readFileSync(path.join(HB,phase+'-root.txt'),'utf8').trim();
const symbols={development:['BTC','ETH','SOL','HYPE','ZEC'],evaluation:['BTC','ETH','SOL','HYPE','ZEC'],okx:['BTC','ETH','SOL','NEAR','XRP','DOGE','UNI','FIL','BAT','BCH','AAVE','ADA']};
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const rows=[],receipts=[],rejections={},rejectedByArm={},timing=new Set();
const rawGroups=new Map();
const selectedArm=phase==='phase2'?read(path.join(HB,'phase1-selection.json')).selected:null;
const tally={attempted:0,admittedUniqueNew:0,derivedRows:0,rejected:0};
async function ingest(dir,baselineOnly=false){
 for(const [cohort,markets]of Object.entries(symbols))for(const market of markets){
  const receipt=read(path.join(dir,`${cohort}-${market}-complete.json`));
  if(hash(fs.readFileSync(receipt.output))!==receipt.outputSha256)throw Error('Output hash mismatch');
  if(!baselineOnly){receipts.push({file:path.join(dir,`${cohort}-${market}-complete.json`),sha256:hash(fs.readFileSync(path.join(dir,`${cohort}-${market}-complete.json`)))});for(const k of Object.keys(tally))tally[k]+=receipt.counts[k];for(const [k,v]of Object.entries(receipt.counts.reasons))rejections[k]=(rejections[k]??0)+v;}
  for await(const line of readline.createInterface({input:fs.createReadStream(receipt.output),crlfDelay:Infinity})){
   const r=JSON.parse(line);if(baselineOnly&&!['flat_flat',selectedArm].includes(r.arm))continue;
   if(r.admitted&&r.derived){rows.push(r);timing.add(new Date(r.launchAt).getUTCDay()+'|'+new Date(r.launchAt).getUTCHours());}
   if(r.admitted&&!r.derived){const fields=['cohort','builderRate','leverage','arm','variant','path','markPath'],key=fields.map(k=>r[k]).join('|');
    const g=rawGroups.get(key)??{meta:Object.fromEntries(fields.map(k=>[k,r[k]])),n:0,liquidations:0,seedHolds:0,stops:0,underwaterAtHorizon:0,weekly:new Map()};
    g.n++;g.liquidations+=Number(r.liquidated);g.seedHolds+=Number(r.seedHold);g.stops+=Number(r.protectiveStop>0);g.underwaterAtHorizon+=Number(r.underwaterAtHorizon);
    const week=weekAt(r.launchAt),v=g.weekly.get(week)??[0,0];v[0]++;v[1]+=r.netReturn;g.weekly.set(week,v);rawGroups.set(key,g);
   }
   if(!baselineOnly&&!r.admitted){const k=[cohort,r.arm,r.reason].join('|');rejectedByArm[k]=(rejectedByArm[k]??0)+1;}
  }
 }
}
await ingest(root);if(phase==='phase2')await ingest(fs.readFileSync(path.join(HB,'phase1-root.txt'),'utf8').trim(),true);
const designs=new Map();
for(const cohort of Object.keys(symbols)){
 const ts=rows.filter(r=>r.cohort===cohort).map(r=>weekAt(r.launchAt)),weeks=[];
 const first=ts.reduce((a,b)=>Math.min(a,b),Infinity),last=ts.reduce((a,b)=>Math.max(a,b),-Infinity);
 for(let w=first;w<=last;w+=WEEK)weeks.push(w);
 for(const block of [1,4])designs.set(cohort+'|'+block,bootstrapDesign('sizing-stops|'+cohort,weeks,block));
}
const metricNames=['meanReturn','meanDrawdown','meanFills','meanFees','meanFunding','profitableShare','stopRate','liquidationRate','below20Share','below50Share','meanUnderwaterDays','underwaterAtHorizonShare','meanLiftedOrders','meanReentries'];
function values(r){return [r.netReturn,r.maxDrawdown,r.fillCount,r.fees,r.funding,Number(r.netReturn>0),Number(r.protectiveStop>0),Number(r.liquidated),Number(r.netReturn<-.2),Number(r.netReturn<-.5),r.underwaterDays,Number(r.underwaterAtHorizon),r.liftCount,r.reentries];}
function interval(draws,alpha=.05){const a=Array.from(draws).filter(Number.isFinite).sort((a,b)=>a-b);return {lower:percentile(a,alpha/2),upper:percentile(a,1-alpha/2),validReplicates:a.length};}
function meanDraws(rs,cohort,block=1,paired=false){
 const d=designs.get(cohort+'|'+block),weekly=new Map(),sums=new Float64Array(metricNames.length);
 for(const r of rs){const vs=paired?r.delta:values(r),i=d.index.get(weekAt(r.launchAt)),v=weekly.get(i)??new Float64Array(metricNames.length+1);v[0]++;for(let k=0;k<vs.length;k++){v[k+1]+=vs[k];sums[k]+=vs[k];}weekly.set(i,v);}
 const active=[...weekly],draws=metricNames.map(()=>new Float64Array(REPLICATES).fill(NaN));
 for(let b=0;b<REPLICATES;b++){let n=0;const v=new Float64Array(metricNames.length),offset=b*d.n;for(const [i,w]of active){const weight=d.weights[offset+i];n+=weight*w[0];for(let k=0;k<v.length;k++)v[k]+=weight*w[k+1];}if(n)for(let k=0;k<v.length;k++)draws[k][b]=v[k]/n;}
 return {means:Array.from(sums,x=>x/rs.length),draws,weeks:weekly.size};
}
function tailMean(sorted,fraction,weights=null){return weightedTailMean(sorted.map(r=>r.netReturn),weights??new Float64Array(sorted.length).fill(1),fraction);}
function tails(rs,cohort,block=1){const d=designs.get(cohort+'|'+block),s=[...rs].sort((a,b)=>a.netReturn-b.netReturn),idx=s.map(r=>d.index.get(weekAt(r.launchAt))),one=new Float64Array(REPLICATES),five=new Float64Array(REPLICATES),returns=s.map(r=>r.netReturn),weights=new Uint16Array(s.length);
 for(let b=0;b<REPLICATES;b++){const offset=b*d.n;for(let i=0;i<idx.length;i++)weights[i]=d.weights[offset+idx[i]];
  [one[b],five[b]]=weightedLowerTails(returns,weights);
 }
 return {one:{mean:tailMean(s,.01),...interval(one)},five:{mean:tailMean(s,.05),...interval(five)},draws:[one,five],q01:percentile(s.map(r=>r.netReturn),.01),q05:percentile(s.map(r=>r.netReturn),.05)};
}
function groups(rs,fields){const map=new Map();for(const r of rs){const key=fields.map(k=>r[k]).join('|');if(!map.has(key))map.set(key,{meta:Object.fromEntries(fields.map(k=>[k,r[k]])),rows:[]});map.get(key).rows.push(r);}return [...map.values()];}
function summarize(g,withTails=false){const a=meanDraws(g.rows,g.meta.cohort);const out={...g.meta,n:g.rows.length,weeks:a.weeks,metrics:Object.fromEntries(metricNames.map((k,i)=>[k,{mean:a.means[i],...interval(a.draws[i])}])),median:percentile(g.rows.map(r=>r.netReturn).sort((a,b)=>a-b),.5),worstReturn:Math.min(...g.rows.map(r=>r.netReturn)),worstDrawdown:Math.max(...g.rows.map(r=>r.maxDrawdown)),liquidations:g.rows.filter(r=>r.liquidated).length,seedHolds:g.rows.filter(r=>r.seedHold).length,reentryRejections:g.rows.filter(r=>r.reentryRejected).length};
 if(withTails){const t=tails(g.rows,g.meta.cohort);out.tail1=t.one;out.tail5=t.five;out.q01=t.q01;out.q05=t.q05;}return out;
}
const common=['cohort','builderRate','leverage','arm','variant'];
const pooled=groups(rows,common).map(g=>summarize(g,phase==='phase2'));
const detailed=groups(rows,[...common,'horizonDays','window','direction']).map(g=>summarize(g,phase==='phase2'));
const key=r=>[r.cohort,r.market,r.launchAt,r.horizonDays,r.window,r.builderRate,r.leverage,r.direction].join('|');
const baseline=new Map(rows.filter(r=>r.variant==='shipped'&&r.arm==='flat_flat').map(r=>[key(r),r]));
const compareBase=r=>phase==='phase1'?baseline.get(key(r)):rowsByShipped.get(key(r)+'|'+r.arm);
const rowsByShipped=new Map(rows.filter(r=>r.variant==='shipped').map(r=>[key(r)+'|'+r.arm,r]));
const comparisons=[];
for(const g of groups(rows.filter(r=>phase==='phase1'?r.arm!=='flat_flat':r.variant!=='shipped'),common)){
 const pairs=g.rows.map(r=>({r,b:compareBase(r)})).filter(x=>x.b),paired=pairs.map(({r,b})=>({...r,delta:values(r).map((x,i)=>x-values(b)[i])}));
 if(!paired.length)continue;const a=meanDraws(paired,g.meta.cohort,1,true),b4=meanDraws(paired,g.meta.cohort,4,true);
 const out={...g.meta,n:paired.length,weeks:a.weeks,armAdmission:g.rows.length,baselineAdmission:rows.filter(r=>r.cohort===g.meta.cohort&&r.builderRate===g.meta.builderRate&&r.leverage===g.meta.leverage&&r.variant==='shipped'&&r.arm===(phase==='phase1'?'flat_flat':g.meta.arm)).length,
  metrics:Object.fromEntries(metricNames.map((k,i)=>[k,{mean:a.means[i],...interval(a.draws[i])}])),returnBlock4:interval(b4.draws[0]),returnMultiplicity:interval(a.draws[0],phase==='phase1'?.0125:.05/28),returnBlock4Multiplicity:interval(b4.draws[0],phase==='phase1'?.0125:.05/28)};
 if(phase==='phase2'){
  const t=tails(pairs.map(p=>p.r),g.meta.cohort),b=tails(pairs.map(p=>p.b),g.meta.cohort),t4=tails(pairs.map(p=>p.r),g.meta.cohort,4),b44=tails(pairs.map(p=>p.b),g.meta.cohort,4);
  for(const [i,name]of ['tail1','tail5'].entries()){out[name]={mean:t[i?'five':'one'].mean-b[i?'five':'one'].mean,...interval(t.draws[i].map((x,j)=>x-b.draws[i][j])),block4:interval(t4.draws[i].map((x,j)=>x-b44.draws[i][j]))};}
 }
 comparisons.push(out);
}
let selection;
if(phase==='phase1'){
 const candidates=comparisons.filter(r=>r.cohort==='development'&&r.builderRate===.001&&r.leverage===1).map(r=>({...r,passes:r.weeks>=20&&r.n>=50&&r.armAdmission>=r.baselineAdmission&&r.returnMultiplicity.lower>0&&r.returnBlock4Multiplicity.lower>0&&r.metrics.meanDrawdown.mean<=0}));
 candidates.sort((a,b)=>b.metrics.meanReturn.mean-a.metrics.meanReturn.mean||['further_further','further_flat','flat_further','near_near'].indexOf(a.arm)-['further_further','further_flat','flat_further','near_near'].indexOf(b.arm));
 const selected=candidates.find(r=>r.passes)?.arm??null;
 selection={selected,candidates,confirmed:selected?['evaluation','okx'].every(c=>{const r=comparisons.find(r=>r.cohort===c&&r.builderRate===.001&&r.leverage===1&&r.arm===selected);return r&&r.metrics.meanReturn.lower>0&&r.returnBlock4.lower>0&&r.metrics.meanDrawdown.mean<=0;}):false,selectedAt:new Date().toISOString()};
 fs.writeFileSync(path.join(HB,'phase1-selection.json'),JSON.stringify(selection,null,2)+'\n',{flag:'wx'});
}
const pathSensitivity=[...rawGroups.values()].map(g=>{const d=designs.get(g.meta.cohort+'|1'),active=[...g.weekly].map(([w,v])=>[d.index.get(w),...v]),draws=new Float64Array(REPLICATES).fill(NaN);
 for(let b=0;b<REPLICATES;b++){let n=0,sum=0;for(const [i,count,value]of active){const w=d.weights[b*d.n+i];n+=w*count;sum+=w*value;}if(n)draws[b]=sum/n;}
 return {...g.meta,n:g.n,weeks:g.weekly.size,liquidations:g.liquidations,seedHolds:g.seedHolds,stops:g.stops,underwaterAtHorizon:g.underwaterAtHorizon,meanReturn:{mean:active.reduce((s,v)=>s+v[2],0)/g.n,...interval(draws)}};
});
const summary={phase,root,tally,rejections,rejectedByArm,timingSlots:[...timing].sort(),receipts,pooled,detailed,comparisons,pathSensitivity,selection,completedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
const flatten=r=>{const o={...r};delete o.metrics;for(const [k,v]of Object.entries(r.metrics??{}))for(const [x,y]of Object.entries(v))o[k+'_'+x]=y;for(const k of Object.keys(o))if(typeof o[k]==='object')o[k]=JSON.stringify(o[k]);return o;};
for(const [name,rs]of [['pooled',pooled],['detailed',detailed],['matched',comparisons],['path-sensitivity',pathSensitivity]]){const data=rs.map(flatten),keys=[...new Set(data.flatMap(Object.keys))],quote=x=>'"'+String(x??'').replaceAll('"','""')+'"';fs.writeFileSync(path.join(root,name+'.csv'),[keys.map(quote).join(','),...data.map(r=>keys.map(k=>quote(r[k])).join(','))].join('\n')+'\n');}
console.log(JSON.stringify({phase,...tally,pooledCells:pooled.length,detailedCells:detailed.length,selected:selection?.selected,confirmed:selection?.confirmed}));
