import {sizingReplay} from './replay.mjs';
const metrics=r=>({netReturn:r.finalEquity/1000-1,maxDrawdown:r.maxDrawdown,fees:r.fees,fillCount:r.fillCount,protectiveStop:r.protectiveStop,
 liquidated:r.liquidated,seedHold:r.seedHold,funding:r.funding,underwaterDays:r.hourlyEquities.filter(x=>x<1000).length/24,
 underwaterAtHorizon:r.finalEquity<1000,finalEquity:r.finalEquity,reentries:0});
export function replayStrategy(input,variant,makeNext){
 let r=sizingReplay(input);if(r.unavailable)throw Error(r.unavailable);
 if(!variant.startsWith('reenter'))return metrics(r);
 const limit=Number(variant.slice(7)),series=r.hourlyEquities.slice(),out=metrics(r),p=input.policy,bars=input.candles;let peak=1000,dd=r.maxDrawdown;
 for(let n=0;n<limit&&r.protectiveStop&&!r.liquidated;n++){
  // A full completed bar after the stop bar must close strictly inside the frozen range.
  let j=r.stopSnapshot.index+1;
  while(j<input.end-1&&!(bars[j].close>Number(p.lowerPrice)&&bars[j].close<Number(p.upperPrice)))j++;
  if(j>=input.end-1||r.cash<10)break;
  let next;
  try{next=makeNext({reference:String(bars[j].close),cash:r.cash,nextIndex:j+1});}
  catch(e){out.reentryRejected=e.message;break;}
  const rr=sizingReplay({...input,start:j+1,policy:next,initialCash:r.cash,peak:r.peak,maxDrawdown:r.maxDrawdown});
  if(rr.unavailable)throw Error(rr.unavailable);
  for(let k=0;k<rr.hourlyEquities.length;k++)series[j+1-input.start+k]=rr.hourlyEquities[k];
  out.reentries++;out.fees+=rr.fees;out.fillCount+=rr.fillCount;out.funding+=rr.funding;out.protectiveStop+=rr.protectiveStop;
  out.liquidated||=rr.liquidated;out.seedHold||=rr.seedHold;dd=Math.max(dd,rr.maxDrawdown);r=rr;
 }
 for(const equity of series){peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak);}
 return {...out,netReturn:r.finalEquity/1000-1,finalEquity:r.finalEquity,maxDrawdown:dd,
  underwaterDays:series.filter(x=>x<1000).length/24,underwaterAtHorizon:r.finalEquity<1000};
}
