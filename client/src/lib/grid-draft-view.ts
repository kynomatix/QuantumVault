import Decimal from 'decimal.js';
import type { GridIntent,GridCreateRequest } from '../../../shared/grid-draft';
import type { authoritativeGridPreview } from '../../../server/grid-bot/draft-service';
export type GridDraftPreview = Awaited<ReturnType<typeof authoritativeGridPreview>> & { requestId:number; draftRevision:string };
const D=Decimal.clone({precision:100,toExpNeg:-100,toExpPos:100});
export const GRID_PREVIEW_DEBOUNCE_MS=350;
export const gridDraftRevision=(intent:GridIntent)=>JSON.stringify(intent);
const decimal=(v:unknown)=>typeof v==='string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && v.length<=80?new D(v):null;
export function gridFunds(investment:string,agent:string|null,vault:string|null) {
  const i=decimal(investment),a=decimal(agent),v=decimal(vault);
  if(!i || !i.gt(0) || !a || !v) return {state:'unavailable' as const,available:null,shortfall:null};
  const available=a.plus(v),shortfall=D.max(0,i.minus(available)).toDecimalPlaces(2,D.ROUND_CEIL);
  return {state:'available' as const,available:available.toFixed(2),shortfall:shortfall.toFixed(2)};
}
export function gridWidth(lower:string,upper:string,width:string) {
  const l=decimal(lower),u=decimal(upper),w=decimal(width);
  if(!l || !u || !w || !l.gt(0) || !l.lt(u) || !w.gt(0) || !w.lt(100)) return null;
  return gridWidthAtMidpoint(l.plus(u).div(2).toFixed(),width);
}
export function gridWidthAtMidpoint(midpoint:string,width:string) {
  const m=decimal(midpoint),w=decimal(width);
  if(!m || !m.gt(0) || !w || !w.gt(0) || !w.lt(100)) return null;
  const fraction=w.div(100);
  return {lowerPrice:m.mul(new D(1).minus(fraction)).toDecimalPlaces(8).toFixed(),upperPrice:m.mul(new D(1).plus(fraction)).toDecimalPlaces(8).toFixed()};
}
export function readableGridNumber(v:string|null,maximumDecimals=8) {
  if(v===null || !decimal(v)) return 'Unknown';
  const [whole,fraction='']=new D(v).toDecimalPlaces(maximumDecimals).toFixed().split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');
}
export function readableGridPercent(value:string|null) {
  if(value===null || value.length>80 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))return 'Unknown';
  return new D(value).mul(100).toDecimalPlaces(6).toFixed()+'%';
}
/** Correlation and create identity survive retries. Deposit confirmation only invalidates evidence. */
export class GridDraftSession {
  sequence=0;revision='';open=false;creating=false;clientRequestId:string|null=null;preview:GridDraftPreview|null=null;
  private saved=new Set<string>();
  edit(revision:string){if(this.revision!==revision){this.revision=revision;this.clientRequestId=null;}this.preview=null;this.sequence++;}
  close(){this.open=false;this.preview=null;this.sequence++;}
  request(){this.preview=null;return ++this.sequence;}
  accept(value:unknown,id:number,revision:string,now:number):value is GridDraftPreview {
    const p=value as GridDraftPreview;
    if(!this.open || id!==this.sequence || revision!==this.revision || !p || p.schemaVersion!==1 || p.requestId!==id
      || p.draftRevision!==revision || p.policy?.policyVersion!=='1.0.0' || p.policy.feePolicyVersion!=='1.0.0' || p.policy.runtimePolicyVersion!=='1.0.0'
      || !['ready','unavailable'].includes(p.state) || !Array.isArray(p.reasons) || !p.reasons.every(r=>typeof r==='string')
      || p.state==='ready' && (!Number.isSafeInteger(p.expiresAt) || p.expiresAt<=now || !/^[0-9A-F]{64}$/.test(p.serverIntentDigest??'')
        || !p.plan || !Array.isArray(p.plan.lines) || !Array.isArray(p.levels) || p.levels.length!==p.plan.lines.length
        || !p.levels.every((l,i)=>l.ordinal===i+1 && decimal(l.price)?.gt(0) && decimal(l.size) && ['buy','sell'].includes(l.side) && typeof l.reduceOnly==='boolean'))) return false;
    this.preview=p;return true;
  }
  beginCreate(now:number,uuid:()=>string){if(this.creating || !this.preview || this.preview.state!=='ready' || this.preview.expiresAt<=now)return null;
    this.clientRequestId??=uuid();if(this.saved.has(this.clientRequestId))return null;this.creating=true;return this.clientRequestId;}
  finishCreate(success:boolean){this.creating=false;if(!success || !this.clientRequestId || this.saved.has(this.clientRequestId))return false;this.saved.add(this.clientRequestId);return true;}
  depositConfirmed(){this.preview=null;this.sequence++;}
}

/** Recover a lost create response by its owner-scoped identity; never send a second create automatically. */
export async function submitGridDraftRequest(request:GridCreateRequest,send:(path:string,options?:RequestInit)=>Promise<{bot:Record<string,unknown>;result?:string}>) {
  try {return await send('/api/grid-bots',{method:'POST',body:JSON.stringify(request)});}
  catch (error) {
    try {
      const recovered=await send('/api/grid-bots/by-client-request/'+request.clientRequestId);
      const b=recovered.bot;
      if(b.clientRequestId===request.clientRequestId && b.draftRevision===request.draftRevision && b.serverIntentDigest===request.serverIntentDigest) return recovered;
    } catch { /* Preserve the original failure when recovery cannot confirm the draft. */ }
    throw error;
  }
}
