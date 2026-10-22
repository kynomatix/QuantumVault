// Same inherited estimator and seeded draws. Share resamples across contrasts;
// linear differences commute with resampling (floating-point tolerance 1e-12).
import {createHash} from 'node:crypto';
import {WEEK,mean} from '../grid-ranging-pairs/core.mjs';
import {METRICS,weekly,mutualConfigurations,weightedTail} from '../grid-ranging-pairs/analysis-core.mjs';
const designs=new Map(),samples=new Map();
function design(begin,end,block){
 const key=[begin,end,block].join('|');if(designs.has(key))return designs.get(key);
 const n=Math.round((end-begin)/WEEK)+1,draws=10000,weights=new Uint16Array(n*draws);let state=20261021>>>0;
 const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
 for(let b=0;b<draws;b++){let k=0;while(k<n){const start=Math.floor(random()*n);for(let j=0;j<block&&k<n;j++,k++)weights[b*n+(start+j)%n]++;}}
 const d={begin,n,draws,weights,block};if(designs.size>=16)designs.delete(designs.keys().next().value);designs.set(key,d);return d;
}
function sample(weeks,block){
 const key=createHash('sha256').update(JSON.stringify([block,[...weeks]])).digest('hex');if(samples.has(key))return samples.get(key);
 const ordered=[...weeks.keys()].sort((a,b)=>a-b),d=design(ordered[0],ordered.at(-1),block),entries=[...weeks].map(([w,v])=>[Math.round((w-d.begin)/WEEK),v]);
 const distributions=METRICS.map(()=>new Float64Array(d.draws));let used=0;
 for(let b=0;b<d.draws;b++){
  let mass=0,s0=0,s1=0,s2=0,s3=0,s4=0,s5=0,s6=0,offset=b*d.n;
  for(let e=0;e<entries.length;e++){const weight=d.weights[offset+entries[e][0]];if(!weight)continue;const v=entries[e][1];mass+=weight;s0+=weight*v[0];s1+=weight*v[1];s2+=weight*v[2];s3+=weight*v[3];s4+=weight*v[4];s5+=weight*v[5];s6+=weight*v[6];}
  if(mass){distributions[0][used]=s0/mass;distributions[1][used]=s1/mass;distributions[2][used]=s2/mass;distributions[3][used]=s3/mass;distributions[4][used]=s4/mass;distributions[5][used]=s5/mass;distributions[6][used]=s6/mass;used++;}
 }
 const out={weeks:weeks.size,calendarWeeks:d.n,draws:d.draws,block,emptyDraws:d.draws-used,used,distributions,means:METRICS.map((_,j)=>mean(entries.map(x=>x[1][j])))};
 if(samples.size>=64)samples.delete(samples.keys().next().value);samples.set(key,out);return out;
}
function summarize(s){return {weeks:s.weeks,calendarWeeks:s.calendarWeeks,draws:s.draws,block:s.block,emptyDraws:s.emptyDraws,metrics:Object.fromEntries(METRICS.map((k,j)=>{const a=s.distributions[j].slice(0,s.used).sort();return[k,{mean:s.means[j],low:a[Math.floor(a.length*.025)]??null,high:a[Math.ceil(a.length*.975)-1]??null}];}))};}
const empty=()=>({weeks:0,metrics:Object.fromEntries(METRICS.map(k=>[k,{mean:null,low:null,high:null}]))});
export function intervals(weeks,block=1){return weeks.size?summarize(sample(weeks,block)):empty();}
function difference(wa,wb,block){
 if(!wa.size)return empty();if(wa.size!==wb.size||[...wa.keys()].some(w=>!wb.has(w)))throw Error('Unmatched bootstrap weeks');
 const a=sample(wa,block),b=sample(wb,block);if(a.used!==b.used)throw Error('Different bootstrap mass');
 const distributions=METRICS.map((_,j)=>{const values=new Float64Array(a.used);for(let k=0;k<a.used;k++)values[k]=a.distributions[j][k]-b.distributions[j][k];return values;});
 const means=METRICS.map((_,j)=>mean([...wa].map(([w,v])=>v[j]-wb.get(w)[j])));
 return summarize({...a,distributions,means});
}
export function absolute(rows){const w=weekly(rows);return {rows:rows.length,pairs:new Set(rows.map(r=>r.symbol)).size,one:intervals(w),four:intervals(w,4),worst5:weightedTail(rows),worstDrawdown:rows.length?rows.reduce((v,r)=>Math.max(v,r.maxDrawdown),0):null,liquidationCount:rows.filter(r=>r.liquidated).length,stopCount:rows.filter(r=>r.protectiveStop).length};}
export function compare(left,right){
 const [a,b]=mutualConfigurations(left,right),wa=weekly(a),wb=weekly(b),quarters=new Map();
 for(const [w,v]of wa){const q=a.find(r=>r.week===w)?.quarter;if(!quarters.has(q))quarters.set(q,[]);quarters.get(q).push(v[0]-wb.get(w)[0]);}
 const quarterMeans=[...quarters].map(([quarter,values])=>({quarter,mean:mean(values)}));
 return {leftRows:a.length,rightRows:b.length,one:difference(wa,wb,1),four:difference(wa,wb,4),quarters:quarterMeans,quarterWins:quarterMeans.filter(x=>x.mean>0).length,quarterCount:quarterMeans.length,leftWorst5:weightedTail(a),rightWorst5:weightedTail(b),leftWorstDrawdown:a.length?a.reduce((v,r)=>Math.max(v,r.maxDrawdown),0):null,rightWorstDrawdown:b.length?b.reduce((v,r)=>Math.max(v,r.maxDrawdown),0):null};
}
