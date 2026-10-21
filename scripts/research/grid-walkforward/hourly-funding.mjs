export const HOUR=3600000;
// Coverage labels only. Replay uses the original timestamp and actual rate.
export function hourlyFundingCoverage(events){
 const slots=new Map(),invalid=[];
 for(const e of events){const slot=Math.round(e.time/HOUR)*HOUR;if(!Number.isSafeInteger(e.time)||!Number.isFinite(e.rate)||!Number.isFinite(e.oraclePrice)||e.oraclePrice<=0||Math.abs(e.time-slot)>60000){invalid.push(e.time);continue;}const values=slots.get(slot)??[];if(!values.some(v=>v.time===e.time&&v.rate===e.rate&&v.oraclePrice===e.oraclePrice))values.push(e);slots.set(slot,values);}
 return {slots,invalid};
}
export function completeHourlyWeek(coverage,start,end){
 // Funding at start can precede the seed; end can follow the terminal close.
 // Verify both neighboring scheduled boundaries; apply only actual in-window events.
 for(let t=start;t<=end;t+=HOUR)if(coverage.slots.get(t)?.length!==1)return false;
 return !coverage.invalid.some(t=>t>=start-HOUR&&t<=end+HOUR);
}
