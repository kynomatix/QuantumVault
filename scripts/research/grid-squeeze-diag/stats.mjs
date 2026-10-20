import {createHash} from 'node:crypto';
export const HOUR=3600000, DAY=24*HOUR, WEEK=7*DAY;
export const BOOTSTRAP_SEED='grid-squeeze-diag-20261021-bootstrap-v1';
export const REPLICATES=5000;
export const weekAt=t=>Math.floor((t-4*DAY)/WEEK)*WEEK+4*DAY;
export const weekday=t=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(t).getUTCDay()];
export const hourBucket=t=>['Asia 00-08','Europe 08-16','US 16-24'][Math.floor(new Date(t).getUTCHours()/8)];
export const percentile=(a,p)=>{if(!a.length)return null;const x=(a.length-1)*p,i=Math.floor(x);return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*(x-i);};
function random(seed){let s=createHash('sha256').update(seed).digest().readUInt32LE(0);return ()=>{s=(s+0x6D2B79F5)>>>0;let x=s;x=Math.imul(x^(x>>>15),x|1);x^=x+Math.imul(x^(x>>>7),x|61);return ((x^(x>>>14))>>>0)/4294967296;};}
export function bootstrapDesign(period,weeks,block=1){
  const ordered=[...weeks].sort((a,b)=>a-b),n=ordered.length,rand=random(`${BOOTSTRAP_SEED}|${period}|block${block}`);
  const weights=new Uint16Array(REPLICATES*n);
  for(let b=0;b<REPLICATES;b++)for(let used=0;used<n;){const start=Math.floor(rand()*n);for(let j=0;j<block&&used<n;j++,used++)weights[b*n+(start+j)%n]++;}
  return {weeks:ordered,index:new Map(ordered.map((w,i)=>[w,i])),weights,n,block};
}
export function accumulator(meta){return {meta,attempted:0,selected:new Set(),launches:new Set(),stopLaunches:new Set(),returns:[],sum:0,stops:0,profitable:0,weekly:new Map()};}
export function add(a,r,launchId,value=r.netReturn){
  a.attempted++;a.selected.add(launchId);if(!r.admitted)return;
  if(!Number.isFinite(value))throw Error('Nonfinite outcome');
  a.launches.add(launchId);a.returns.push(value);a.sum+=value;a.stops+=Number(r.protectiveStop);a.profitable+=Number(value>0);
  if(r.protectiveStop)a.stopLaunches.add(launchId);
  const w=weekAt(r.launchAt),v=a.weekly.get(w)??[0,0,0];v[0]++;v[1]+=value;v[2]+=Number(r.protectiveStop);a.weekly.set(w,v);
}
export function draws(a,d,field=1){
  const out=new Float64Array(REPLICATES).fill(NaN),active=[...a.weekly].map(([w,v])=>[d.index.get(w),v[0],v[field]]);
  if(active.length<2)return out;
  for(let b=0;b<REPLICATES;b++){let count=0,sum=0;const offset=b*d.n;for(const [i,n,v] of active){const m=d.weights[offset+i];count+=m*n;sum+=m*v;}if(count)out[b]=sum/count;}
  return out;
}
export function interval(values){const a=Array.from(values).filter(Number.isFinite).sort((a,b)=>a-b);return {lower95:percentile(a,.025),upper95:percentile(a,.975),validReplicates:a.length};}
export function summarize(a,d,d4=null){
  const n=a.returns.length,sorted=a.returns.sort((a,b)=>a-b),ci=interval(draws(a,d));
  return {...a.meta,attempted:a.attempted,selectedLaunches:a.selected.size,admitted:n,launches:a.launches.size,weeks:a.weekly.size,
    stopped:a.stops,stoppedLaunches:a.stopLaunches.size,stopRate:n?a.stops/n:null,mean:n?a.sum/n:null,...ci,
    median:percentile(sorted,.5),profitable:n?a.profitable/n:null,
    ...(d4?Object.fromEntries(Object.entries(interval(draws(a,d4))).map(([k,v])=>['block4'+k[0].toUpperCase()+k.slice(1),v])):{})};
}
export function difference(a,b,d,d4=null){
  const n=a.returns.length,m=b.returns.length;
  const diff=(field,design)=>{const x=draws(a,design,field),y=draws(b,design,field);return interval(x.map((v,i)=>v-y[i]));};
  return {finderN:n,blindN:m,mean:n&&m?a.sum/n-b.sum/m:null,...diff(1,d),stopDifference:n&&m?a.stops/n-b.stops/m:null,
    ...Object.fromEntries(Object.entries(diff(2,d)).map(([k,v])=>['stop'+k[0].toUpperCase()+k.slice(1),v])),
    ...(d4?Object.fromEntries(Object.entries(diff(1,d4)).map(([k,v])=>['block4'+k[0].toUpperCase()+k.slice(1),v])):{})};
}
