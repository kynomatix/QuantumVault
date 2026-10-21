// Mechanical research-only extension of the inherited round-2 replay. Fail closed on drift.
import fs from 'node:fs';
const original=new URL('../grid-backtest-r2/fixed-replay.mjs',import.meta.url);
let s=fs.readFileSync(original,'utf8');
function replace(a,b){if(s.split(a).length!==2)throw Error('Replay extension boundary changed: '+a);s=s.replace(a,b);}
replace("from './movement.mjs'","from '../grid-backtest-r2/movement.mjs'");
replace("from './risk.mjs'","from '../grid-backtest-r2/risk.mjs'");
replace('export function fixedReplay(input){','export function sizingReplay(input){');
replace('let cash=equity0,positionUnits=0','let cash=input.initialCash??equity0,positionUnits=0');
replace('peak=equity0,maxDrawdown=0','peak=input.peak??equity0,maxDrawdown=input.maxDrawdown??0');
replace('const executions=input.executions?[]:null;','const executions=input.executions?[]:null; const hourlyEquities=[]; let lastIndex=start-1;');
replace('const bar=bars[i],prev=bars[i-1],now=bar.time;','lastIndex=i; const bar=bars[i],prev=bars[i-1],now=bar.time;');
replace('if(crossing!==null){',`const floorAt=input.equityFloor==null?null:equityCrossing(cash,sign*positionUnits*lot,input.equityFloor,fromMark,endMark);
     if(floorAt!==null&&(crossing===null||floorAt<crossing)){
      const at=cursor+(event.at-cursor)*floorAt; currentMark=mf+(mt-mf)*at;
      stop(tf+(tt-tf)*at,Math.round(fromTime+(toTime-fromTime)*at),i); break;
     }
     if(crossing!==null){`);
replace('mark(mb.close);if(stopped)break;','hourlyEquities.push(mark(mb.close));if(stopped)break;');
replace("if(stopMode!=='touch'&&(long?bar.close<=stopPrice:bar.close>=stopPrice)","if(['1h-close','4h-close'].includes(stopMode)&&(long?bar.close<=stopPrice:bar.close>=stopPrice)");
replace("if(stopMode!=='touch'&&stopHit(bar.close)","if(['1h-close','4h-close'].includes(stopMode)&&stopHit(bar.close)");
replace('const finalPrice=input.markBars?.[end-1]?.close??bars[end-1].close,finalEquity=mark(finalPrice);',`const finalPrice=input.markBars?.[end-1]?.close??bars[end-1].close;
 if(input.closeAtHorizon&&!stopped&&positionUnits)execute('close',true,positionUnits,bars[end-1].close*(1-sign*slippage),bars[end-1].time+duration);
 const finalEquity=mark(finalPrice);
 // One observation per completed hour; stopped cash remains underwater through horizon.
 while(hourlyEquities.length<end-start)hourlyEquities.push(finalEquity);
 hourlyEquities[hourlyEquities.length-1]=finalEquity;`);
replace('finalEquity,cash,position:', 'hourlyEquities,lastIndex,peak,finalEquity,cash,position:');
s += `\nexport function equityCrossing(cash,signedQuantity,floor,from,to){
 const margin=p=>cash+signedQuantity*p-floor;
 if(margin(from)<=0)return 0;
 if(margin(to)>0||signedQuantity===0)return null;
 return Math.max(0,Math.min(1,margin(from)/(margin(from)-margin(to))));
}\n`;
fs.writeFileSync(new URL('./replay.mjs',import.meta.url),s);
console.log('Generated research replay extension from pinned source.');
