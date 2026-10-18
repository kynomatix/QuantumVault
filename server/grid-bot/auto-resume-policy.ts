import Decimal from 'decimal.js';
const D=Decimal.clone({precision:200});
export const GRID_AUTO_RESUME_REASONS=['waiting_for_inner_band','range_unavailable','reconciliation_required','operation_pending','market_data_unavailable','resume_authority_unavailable','risk_pause','stop_clearance_unavailable','policy_changed','execution_revoked','retry_limit','preference_off'] as const;
export type GridAutoResumeReason=typeof GRID_AUTO_RESUME_REASONS[number];
/** The buffer is a fraction of each boundary price, rounded strictly inward. */
export function gridAutoResumeBand(lower:string,upper:string,tick:string){
  try{
    if(![lower,upper,tick].every(v=>typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)))return null;
    const l=new D(lower),u=new D(upper),t=new D(tick);
    if(!l.gt(0)||!u.gt(l)||!t.gt(0))return null;
    const innerLower=l.mul('1.02').div(t).ceil().mul(t),innerUpper=u.mul('0.98').div(t).floor().mul(t);
    if(!innerLower.gt(l)||!innerUpper.lt(u)||!innerLower.lt(innerUpper))return null;
    return {lower:innerLower.toFixed(),upper:innerUpper.toFixed(),tick:t.toFixed()};
  }catch{return null;}
}
export function gridInsideAutoResumeBand(mark:string,band:ReturnType<typeof gridAutoResumeBand>){
  try{return !!band&&new D(mark).isFinite()&&new D(mark).gte(band.lower)&&new D(mark).lte(band.upper);}catch{return false;}
}
export function gridAutoResumeRetry(attempts:number,first:number|null,next:number|null,now:number){
  if(first!==null&&now-first>=120000)return 'expired';
  if(attempts>=3)return 'exhausted';
  if(next!==null&&now<next)return 'waiting';
  return 'ready';
}
