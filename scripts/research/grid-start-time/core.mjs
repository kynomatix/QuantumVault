import {createHash} from 'node:crypto';
export const HOUR=3600000, DAY=24*HOUR, SEED='grid-start-time-20261021-v1';
export const PERIODS=['development','evaluation','proxy'];
export const SLOTS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].flatMap((day,d)=>[0,8,16].map(h=>({id:`${day}-${String(h).padStart(2,'0')}`,hour:d*24+h})));
export const SETTINGS=[
  {id:'A_WEEK',window:'week',mode:'step_back',leverage:1},
  {id:'B_REPEAT',window:'week',mode:'repeat_all',leverage:1},
  {id:'A_MONTH',window:'month',mode:'step_back',leverage:1},
  {id:'A_3X',window:'week',mode:'step_back',leverage:3},
].flatMap(s=>[0.001,0].map(builderRate=>({...s,builderRate,makerRate:0.00015+builderRate,takerRate:0.0004+builderRate,config:`${s.id}-b${Math.round(builderRate*100000)}`})));
export const ARMS=['A_WEEK','B_REPEAT','C_R1','A_MONTH','A_3X'];
export function randomHour(anchor) {
  const limit=Math.floor(2**32/168)*168;
  for(let counter=0;;counter++) {
    const x=createHash('sha256').update(`${SEED}|${new Date(anchor).toISOString()}|${counter}`).digest().readUInt32BE(0);
    if(x<limit)return x%168;
  }
}
export function launches(anchor) {
  const hours=new Map(SLOTS.map(s=>[s.hour,[s.id]])),random=randomHour(anchor);
  if(hours.has(random))hours.get(random).push('RANDOM');else hours.set(random,['RANDOM']);
  return [...hours].sort((a,b)=>a[0]-b[0]).map(([hour,slots])=>({anchor,hour,slots,launchAt:anchor+hour*HOUR}));
}
export function offsetWindow(d,w,launch,through) {
  const endAt=launch.launchAt+w.horizonDays*DAY,start=d.indices.get(launch.launchAt),last=d.indices.get(endAt-d.duration);
  return {...w,...launch,endAt,start:start??-1,end:last===undefined?-1:last+1,
    year:new Date(launch.launchAt).getUTCFullYear(),
    reason:endAt>through?'period boundary':start===undefined||last===undefined?'missing_boundary':null};
}
export const scenarioKey=r=>[r.anchor,r.market,r.horizonDays,r.direction,r.path,r.markPath].join('|');
export const physicalKey=r=>[r.launchAt,r.market,r.horizonDays,r.config,r.direction,r.path,r.markPath].join('|');
export const cohortKey=(r,arm=r.arm)=>`${arm}|${r.builderRate}|${scenarioKey(r)}`;
export function armRows(r) {
  return [{...r,arm:r.setting},...(r.setting==='A_WEEK'?[{...r,arm:'C_R1',admitted:r.r1==='pass'&&r.admitted,
    reason:r.r1==='pass'?r.reason:r.r1==='unavailable'?'R1 signal unavailable':'R1 condition not met'}]:[])];
}
export function addAdmissionMask(mask,r) {
  for(const slot of r.slots){
    const index=SLOTS.findIndex(s=>s.id===slot);if(index<0)continue;
    for(const a of armRows(r))if(a.admitted){const k=cohortKey(a);mask.set(k,(mask.get(k)??0)|(1<<index));}
  }
}
export function pairRows(first,second) {
  const left=new Map(first.filter(r=>r.admitted).map(r=>[scenarioKey(r),r])),pairs=[];
  for(const b of second.filter(r=>r.admitted)){
    const a=left.get(scenarioKey(b));if(a)pairs.push({...a,netReturn:a.netReturn-b.netReturn});
  }
  return pairs;
}
export function quantile(values,p) {
  if(!values.length)return null;
  const a=[...values].sort((x,y)=>x-y),index=(a.length-1)*p,lo=Math.floor(index),fraction=index-lo;
  return a[lo]+fraction*(a[Math.min(lo+1,a.length-1)]-a[lo]);
}
export function stats(rows) {
  const a=rows.filter(r=>r.admitted),n=a.length,avg=k=>n?a.reduce((s,r)=>s+Number(r[k]),0)/n:null;
  return {admitted:n,mean:avg('netReturn'),median:quantile(a.map(r=>r.netReturn),.5),
    profitable:n?a.filter(r=>r.netReturn>0).length/n:null,stopRate:avg('protectiveStop'),
    meanDrawdown:avg('maxDrawdown'),worstDrawdown:n?Math.max(...a.map(r=>r.maxDrawdown)):null,
    launches:new Set(a.map(r=>`${r.market}|${r.launchAt}`)).size,weeks:new Set(a.map(r=>r.anchor)).size};
}
export function spread(rows,metric) {
  const values=rows.map(r=>r[metric]).filter(Number.isFinite),sun=rows.find(r=>r.slot==='Sun-00')?.[metric]??null;
  const others=rows.filter(r=>r.slot!=='Sun-00').map(r=>r[metric]).filter(Number.isFinite);
  if(!values.length)return {metric,min:null,max:null,sd:null,sunday:null,sundayRank:null,otherMin:null,otherMax:null,rangeOutlier:null,fenceOutlier:null};
  const mean=values.reduce((s,v)=>s+v,0)/values.length,q1=quantile(others,.25),q3=quantile(others,.75);
  return {metric,min:Math.min(...values),max:Math.max(...values),sd:Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length),
    sunday:sun,sundayRank:sun===null?null:1+values.filter(v=>v>sun).length,availableSlots:values.length,
    otherMin:others.length?Math.min(...others):null,otherMax:others.length?Math.max(...others):null,
    rangeOutlier:sun===null||!others.length?null:sun<Math.min(...others)||sun>Math.max(...others),
    fenceOutlier:sun===null||!others.length?null:sun<q1-1.5*(q3-q1)||sun>q3+1.5*(q3-q1)};
}
