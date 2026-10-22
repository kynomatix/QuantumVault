import {DAY,monthsBefore,mean,rank} from '../grid-ranging-pairs/core.mjs';

// Wilder smoothing starts with 14 transitions and then 14 DX observations.
export function indicators(daily,period=14){
 const out=new Map();let prev=null,n=0,tr=0,plus=0,minus=0,dxs=[],adx=null,closes=[];
 for(const r of daily){
  if(!Number.isFinite(r.close)||r.close<=0||!Number.isFinite(r.high)||!Number.isFinite(r.low)||r.high<r.low)throw Error('Invalid daily bar');
  if(prev&&r.time<=prev.time)throw Error('Unordered daily bars');
  if(!prev||r.time-prev.time!==DAY){n=0;tr=plus=minus=0;dxs=[];adx=null;closes=[];prev=null;}
  closes.push(r.close);if(closes.length>20)closes.shift();
  let bandwidth=null;
  if(closes.length===20){const avg=mean(closes);bandwidth=4*Math.sqrt(mean(closes.map(x=>(x-avg)**2)))/avg;}
  if(prev){
   const up=r.high-prev.high,down=prev.low-r.low;
   const p=up>0&&up>down?up:0,m=down>0&&down>up?down:0;
   const t=Math.max(r.high-r.low,Math.abs(r.high-prev.close),Math.abs(r.low-prev.close));
   n++;if(n<=period){tr+=t;plus+=p;minus+=m;}else{tr=tr-tr/period+t;plus=plus-plus/period+p;minus=minus-minus/period+m;}
   if(n>=period){const pd=tr?100*plus/tr:0,md=tr?100*minus/tr:0,dx=pd+md?100*Math.abs(pd-md)/(pd+md):0;
    if(adx===null){dxs.push(dx);if(dxs.length===period)adx=mean(dxs);}else adx=(adx*(period-1)+dx)/period;
   }
  }
  out.set(r.time,{adx,bandwidth});prev=r;
 }
 return out;
}
export function averageAdx(index,at,months){
 const begin=monthsBefore(at,months),values=[];
 for(let t=begin;t<at;t+=DAY){const value=index.get(t)?.adx;if(value===null||value===undefined)return null;values.push(value);}
 return mean(values);
}
export function squeezeAt(index,launchAt){
 const at=Math.floor(launchAt/DAY)*DAY-DAY,current=index.get(at)?.bandwidth;
 if(current===null||current===undefined)return {available:false,reason:'missing current bandwidth'};
 const begin=monthsBefore(at,12);let below=0,count=0;
 for(let t=begin;t<at;t+=DAY){const v=index.get(t)?.bandwidth;if(v===null||v===undefined)return {available:false,reason:'incomplete 12-month bandwidth history'};count++;if(v<current)below++;}
 const percentile=below/count;return {available:true,at,bandwidth:current,percentile,squeezed:percentile<.2,historyDays:count};
}
export function adxRanks(entries,field){return rank(entries.filter(e=>e[field]!==null).map(e=>({symbol:e.symbol,score:{efficiency:e[field]}})));}
export function pickerMembership(selection,signal,symbol){
 return {P1:selection.p1.ranging.includes(symbol),P2:selection.p2.ranging.includes(symbol),P3:signal.available&&!signal.squeezed,P4:selection.p2.ranging.includes(symbol)&&signal.available&&!signal.squeezed,all:selection.all.includes(symbol),trending:selection.trending.includes(symbol),p1High:selection.p1.trending.includes(symbol),p2High:selection.p2.trending.includes(symbol),squeezed:signal.available&&signal.squeezed};
}
export function correlation(points){
 const n=points.length;if(n<2)return null;const ax=mean(points.map(p=>p[0])),ay=mean(points.map(p=>p[1]));let xx=0,yy=0,xy=0;
 for(const [x,y]of points){xx+=(x-ax)**2;yy+=(y-ay)**2;xy+=(x-ax)*(y-ay);}return xx&&yy?xy/Math.sqrt(xx*yy):null;
}
function ranks(a){const sorted=a.map((x,i)=>({x,i})).sort((a,b)=>a.x-b.x),out=[];for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length&&sorted[j].x===sorted[i].x)j++;for(let k=i;k<j;k++)out[sorted[k].i]=(i+j-1)/2;i=j;}return out;}
export function spearman(points){const x=ranks(points.map(p=>p[0])),y=ranks(points.map(p=>p[1]));return correlation(x.map((v,i)=>[v,y[i]]));}
