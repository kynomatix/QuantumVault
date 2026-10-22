// Pure research estimators. No product imports, I/O or outcome access.
export const ARMS=['M0','M1','M2','M3','M4','M5'];
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
const ascii=(a,b)=>a<b?-1:a>b?1:0;
export function logReturns(closes){
 if(closes.length<2||closes.some(x=>!Number.isFinite(x)||x<=0))return null;
 return closes.slice(1).map((x,i)=>Math.log(x/closes[i]));
}
export function varianceRatio(returns,q){
 const n=returns.length;if(n<=q||q<2||!Number.isInteger(q)||returns.some(x=>!Number.isFinite(x)))return null;
 const mu=avg(returns),e=returns.map(x=>x-mu),ss=e.reduce((s,x)=>s+x*x,0);if(!(ss>0))return null;
 const single=ss/(n-1),normalizer=q*(n-q+1)*(1-q/n);
 let overlapping=0,rolling=0;for(let t=0;t<n;t++){rolling+=e[t];if(t>=q)rolling-=e[t-q];if(t>=q-1)overlapping+=rolling*rolling;}
 const vr=overlapping/normalizer/single;let variance=0;
 for(let j=1;j<q;j++){let products=0;for(let t=j;t<n;t++)products+=e[t]**2*e[t-j]**2;variance+=(2*(q-j)/q)**2*products/ss**2;}
 const se=Math.sqrt(variance);if(!(se>0)||!Number.isFinite(vr))return null;
 return {q,n,vr,se,z:(vr-1)/se,upper:vr+1.959963984540054*se};
}
export function dfa(returns,scales){
 if(returns.length<32||returns.some(x=>!Number.isFinite(x)))return null;
 const mu=avg(returns);let running=0;const profile=returns.map(x=>running+=x-mu),points=[];
 for(const size of scales){if(size<4||size>returns.length/4||!Number.isInteger(size))continue;const count=Math.floor(profile.length/size);let squares=0,observations=0;
  const xm=(size-1)/2,xx=size*(size*size-1)/12;
  for(const reverse of [false,true])for(let box=0;box<count;box++){
   const start=reverse?profile.length-(box+1)*size:box*size,window=profile.slice(start,start+size),ym=avg(window);
   const slope=window.reduce((s,y,i)=>s+(i-xm)*(y-ym),0)/xx;
   for(let i=0;i<size;i++){squares+=(window[i]-ym-slope*(i-xm))**2;observations++;}
  }
  const fluctuation=Math.sqrt(squares/observations);if(!(fluctuation>0))return null;points.push({size,fluctuation});
 }
 if(points.length<3)return null;
 const xs=points.map(x=>Math.log(x.size)),ys=points.map(x=>Math.log(x.fluctuation)),xm=avg(xs),ym=avg(ys);
 const h=xs.reduce((s,x,i)=>s+(x-xm)*(ys[i]-ym),0)/xs.reduce((s,x)=>s+(x-xm)**2,0);
 return Number.isFinite(h)?{h,points}:null;
}
export function edgeRejections(bars,{lookback=168,assessment=168,reversalBars=6,inset=.1}={}){
 if(bars.length<lookback+assessment)return null;
 let upperCount=0,lowerCount=0,upperUntil=-1,lowerUntil=-1;
 for(let i=bars.length-assessment;i+reversalBars<bars.length;i++){
  const past=bars.slice(i-lookback,i),upper=past.reduce((a,b)=>Math.max(a,b.high),-Infinity),lower=past.reduce((a,b)=>Math.min(a,b.low),Infinity),width=upper-lower;
  if(!(width>0))continue;const after=bars.slice(i+1,i+reversalBars+1);
  if(i>upperUntil&&bars[i].high>=upper){upperUntil=i+reversalBars;if(after.some(b=>b.close<=upper-inset*width&&b.close>=lower))upperCount++;}
  if(i>lowerUntil&&bars[i].low<=lower){lowerUntil=i+reversalBars;if(after.some(b=>b.close>=lower+inset*width&&b.close<=upper))lowerCount++;}
 }
 return {upperCount,lowerCount,count:upperCount+lowerCount,perDay:(upperCount+lowerCount)/(assessment/24)};
}
export function travelScore(bars,geometry){
 const window=bars.slice(-169);if(window.length!==169)return null;const reference=window.at(-1).close,spacing=(Number(geometry.upper)-Number(geometry.lower))/10;
 const longDistance=reference-Number(geometry.longStop),shortDistance=Number(geometry.shortStop)-reference;
 if(!(spacing>0&&longDistance>0&&shortDistance>0))return null;
 const dailyTravel=window.slice(1).reduce((s,b,i)=>s+Math.abs(b.close-window[i].close),0)/7;
 const oneWayCrossings=dailyTravel/spacing,roundTrips=oneWayCrossings/2,stopFraction=(longDistance+shortDistance)/2/reference;
 return {spacing,dailyTravel,oneWayCrossings,roundTrips,stopFraction,score:roundTrips/stopFraction};
}
export function features(bars,launchAt,geometry){
 const history=bars.filter(b=>b.time+3600000<=launchAt).slice(-721);
 if(history.length!==721||history.at(-1).time+3600000!==launchAt||history.some((b,i)=>i&&b.time!==history[i-1].time+3600000))return {available:false,reason:'missing 30-day hourly history'};
 const returns=logReturns(history.map(b=>b.close));if(!returns)return {available:false,reason:'invalid hourly close'};
 const vr=[4,12].map(q=>varianceRatio(returns.slice(-336),q)),hurst14=dfa(returns.slice(-336),[8,16,32,64]),hurst30=dfa(returns,[8,16,32,64,128]),edge=edgeRejections(history),travel=travelScore(history,geometry);
 if(vr.some(v=>!v)||!hurst14||!hurst30||!edge||!travel)return {available:false,reason:'degenerate estimator or invalid stop distance'};
 return {available:true,vr,hurst14,hurst30,edge,travel,scores:{M1:Math.max(...vr.map(v=>v.upper)),M2:(hurst14.h+hurst30.h)/2,M3:-edge.perDay,M4:-travel.score},qualifies:{M1:vr.every(v=>v.upper<1),M2:hurst14.h<.5&&hurst30.h<.5}};
}
export function percentileRanks(rows,field){
 const sorted=rows.slice().sort((a,b)=>a.scores[field]-b.scores[field]||ascii(a.symbol,b.symbol)),ranks=new Map();
 for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length&&sorted[j].scores[field]===sorted[i].scores[field])j++;for(let k=i;k<j;k++)ranks.set(sorted[k].symbol,sorted.length>1?(i+j-1)/2/(sorted.length-1):0);i=j;}return ranks;
}
export function select(rows){
 const eligible=rows.filter(r=>r.available&&r.squeeze.available&&!r.squeeze.squeezed),quota=Math.floor(eligible.length/3);
 const percentiles=['M1','M2','M3','M4'].map(f=>percentileRanks(eligible,f));
 const combined=new Map(eligible.map(r=>[r.symbol,avg(percentiles.map(p=>p.get(r.symbol)))]));
 const scored=eligible.map(r=>({...r,scores:{...r.scores,M0:r.finder.adx??Infinity,M5:combined.get(r.symbol)}}));
 const groups={ALL:eligible.map(r=>r.symbol)},qualified={};
 for(const arm of ARMS){const pool=scored.filter(r=>arm==='M0'?r.finder.state==='ranging':arm==='M1'||arm==='M2'?r.qualifies[arm]:true).sort((a,b)=>a.scores[arm]-b.scores[arm]||ascii(a.symbol,b.symbol));qualified[arm]=pool.length;groups[arm]=pool.slice(0,quota).map(r=>r.symbol);}
 return {eligible:eligible.length,quota,qualified,groups,combined:Object.fromEntries(combined)};
}
export function pairedDirections(rows){
 const groups=new Map();for(const r of rows){const key=[r.symbol,r.launchAt,r.leverage].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 return [...groups.values()].filter(g=>g.length===2&&new Set(g.map(r=>r.direction)).size===2).flat();
}
