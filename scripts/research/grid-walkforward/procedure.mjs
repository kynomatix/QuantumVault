// Pure, research-only procedure. No transport, database, signing or order calls.
export const HOUR=3600000, WEEK=168*HOUR, BEGIN=Date.UTC(2022,2,1), FIRST=Date.UTC(2023,2,1), END=Date.UTC(2026,9,19);
export const MENU=['week','month'].flatMap(window=>[6,10,14,20].flatMap(lines=>[1,1.5].flatMap(stop=>['step_back','repeat_all'].flatMap(mode=>['long','short','sign30'].flatMap(side=>['none','R1','ATR','finder'].map(filter=>({id:[window,lines,stop,mode,side,filter].join('|'),window,lines,stop,mode,side,filter})))))));
export const DEFAULT_ID='week|10|1|step_back|long|none', REPEAT_ID='week|10|1|repeat_all|long|none';
export const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
export function median(a){const b=[...a].sort((x,y)=>x-y),n=b.length;if(!n)throw Error('Empty score');return (b[Math.floor((n-1)/2)]+b[Math.floor(n/2)])/2;}
export function selectionDates(){const dates=[];for(let y=2023;y<=2026;y++)for(const m of [2,5,8,11]){const t=Date.UTC(y,m,1);if(t<END)dates.push(t);}return dates;}
export function trainStart(t){const d=new Date(t);return Date.UTC(d.getUTCFullYear()-1,d.getUTCMonth(),1);}
export function weekCalendar(){const a=[];for(let t=Date.UTC(2022,2,7);t+WEEK<=END;t+=WEEK)a.push(t);return a;}
export function rankOptions(weekly,at){
 const training=weekly.filter(w=>w.time>=trainStart(at)&&w.time+WEEK<=at);
 if(!training.length)throw Error('Empty training window');
 const ranking=MENU.map((o,i)=>({id:o.id,index:i,score:median(training.map(w=>w.returns[i])),stopRate:mean(training.map(w=>w.stops[i]))}));
 ranking.sort((a,b)=>b.score-a.score||a.stopRate-b.stopRate||(a.id<b.id?-1:a.id>b.id?1:0));
 return {at,trainingStart:training[0].time,latestOutcomeAt:training.at(-1).time+WEEK,trainingWeeks:training.length,ranking};
}
export function drawdown(returns){let equity=1,peak=1,dd=0;for(const r of returns){if(!Number.isFinite(r)||r < -1)throw Error('Invalid return');equity*=1+r;peak=Math.max(peak,equity);dd=Math.max(dd,1-equity/peak);}return {return:equity-1,drawdown:dd};}
export function bootstrap(delta,{draws=10000,block=1,seed=20261021}={}){
 if(!delta.length)throw Error('Empty bootstrap');let state=seed>>>0;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;},samples=[];
 for(let i=0;i<draws;i++){let total=0,n=0;while(n<delta.length){const start=Math.floor(random()*delta.length);for(let j=0;j<block&&n<delta.length;j++,n++)total+=delta[(start+j)%delta.length];}samples.push(total/delta.length);}
 samples.sort((a,b)=>a-b);return {weeks:delta.length,mean:mean(delta),lower:samples[Math.floor(.025*draws)],upper:samples[Math.ceil(.975*draws)-1],draws,block,seed};
}
export function closeWeek(result,takerRate,investment=1000){
 // Replay marks inventory at the last close. A fresh weekly bot must pay to exit it.
 const position=result.position,sign=Math.sign(position),price=result.finalMark*(1-sign*.0005);
 const exitCost=Math.abs(position)*(result.finalMark*.0005+price*takerRate);
 const equity=result.finalEquity-exitCost;
 if(!Number.isFinite(equity)||equity<0)throw Error('Invalid closing equity');
 return {...result,netReturn:equity/investment-1,exitCost,fees:result.fees+Math.abs(position)*price*takerRate};
}
