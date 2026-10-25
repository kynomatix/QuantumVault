/** Display phases never grant authority to drive a request. Unknown phases remain displayable. */
export interface WorkerRescue {
  requestId:string;requestKey:string;botId:string;phase:string;live:boolean;unknownOpen:boolean;
  expiresInSeconds:number;completedSeconds:number|null;stepIdleSeconds:number|null;leaseRemainingSeconds:number|null;
  next:'step'|'wait'|'done';retryAfterSeconds:number;waitSeconds:number;
}
export interface WorkerRescueOffer {botId:string;trigger:string;blockedBy:string|null}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
function number(v:unknown):number {
  if(typeof v!=='number'&&(typeof v!=='string'||!/^(0|[1-9]\d*)(\.\d+)?$/.test(v)))return NaN;
  const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:NaN;
}
export function parseWorkerRescue(value:unknown):WorkerRescue|null {
  if(!value||typeof value!=='object')return null;
  const r=value as WorkerRescue;
  if(!uuid(r.requestId)||!uuid(r.botId)||typeof r.requestKey!=='string'||!/^[0-9a-f]{64}$/.test(r.requestKey)
    ||typeof r.phase!=='string'||!r.phase||typeof r.live!=='boolean'||typeof r.unknownOpen!=='boolean'
    ||!['step','wait','done'].includes(r.next))return null;
  const expiresInSeconds=number(r.expiresInSeconds),retryAfterSeconds=number(r.retryAfterSeconds),waitSeconds=number(r.waitSeconds);
  const ages=[r.completedSeconds,r.stepIdleSeconds,r.leaseRemainingSeconds].map(v=>v===null?null:number(v));
  if(![expiresInSeconds,retryAfterSeconds,waitSeconds,...ages.filter(v=>v!==null)].every(v=>Number.isFinite(v))
    ||expiresInSeconds>600||retryAfterSeconds>10||!Number.isInteger(retryAfterSeconds)
    ||r.live&&(expiresInSeconds<=0||ages[1]===null||ages[2]===null||(ages[2]??0)<=0||r.next==='done')
    ||!r.live&&r.next!=='done'||r.next==='wait'&&retryAfterSeconds<1)return null;
  return {...r,expiresInSeconds,retryAfterSeconds,waitSeconds,completedSeconds:ages[0],stepIdleSeconds:ages[1],leaseRemainingSeconds:ages[2]};
}
export function parseWorkerRescueOffers(value:unknown):WorkerRescueOffer[]|null {
  if(!Array.isArray(value))return null;
  return value.every(r=>r&&uuid(r.botId)&&typeof r.trigger==='string'&&(typeof r.blockedBy==='string'||r.blockedBy===null))?value:null;
}
