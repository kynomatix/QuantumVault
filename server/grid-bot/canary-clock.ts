import Decimal from 'decimal.js';
import type {GridObservation} from './reconciliation';
const D=Decimal.clone({precision:200});
export const GRID_CANARY_DURATION_MS=30*60_000;
export const GRID_CANARY_MAX_TICK_GAP_MS=30_000;
export interface GridCanaryClock {bootId:string;firstConfirmedAt:number;cleanSince:number|null;lastTickId:string;lastObservedAt:number;certifiedGeneration:string|null;certifiedSafeThrough:number|null;certifiedTickId:string|null;cleanTicks:number;promoted:boolean}
export function advanceGridCanary(prior:GridCanaryClock|null,input:{bootId:string;tickId:string;observedAt:number;firstConfirmedAt:number;qualifying:boolean;generation:string;safeThrough:number|null}):GridCanaryClock{
  // Duplicate delivery is a no-op, including after a crash between COMMIT and acknowledgement.
  if(prior&&prior.bootId===input.bootId&&prior.lastTickId===input.tickId)return input.qualifying?prior:
    {...prior,cleanSince:null,certifiedGeneration:null,certifiedSafeThrough:null,certifiedTickId:null,cleanTicks:0,promoted:false};
  const continuous=prior&&prior.bootId===input.bootId&&prior.firstConfirmedAt===input.firstConfirmedAt
    &&input.observedAt>prior.lastObservedAt&&input.observedAt-prior.lastObservedAt<=GRID_CANARY_MAX_TICK_GAP_MS;
  const valid=input.qualifying&&Number.isSafeInteger(input.firstConfirmedAt)&&input.firstConfirmedAt<=input.observedAt
    &&(!prior||input.observedAt>prior.lastObservedAt);
  const cleanSince=valid?(continuous&&prior.cleanSince!==null?prior.cleanSince:
    !prior&&input.observedAt-input.firstConfirmedAt<=GRID_CANARY_MAX_TICK_GAP_MS?input.firstConfirmedAt:input.observedAt):null;
  const next:GridCanaryClock={bootId:input.bootId,firstConfirmedAt:input.firstConfirmedAt,cleanSince,lastTickId:input.tickId,lastObservedAt:input.observedAt,
    certifiedGeneration:continuous&&valid?prior.certifiedGeneration:null,certifiedSafeThrough:continuous&&valid?prior.certifiedSafeThrough:null,
    certifiedTickId:continuous&&valid?prior.certifiedTickId:null,cleanTicks:continuous&&valid?prior.cleanTicks:0,promoted:false};
  if(cleanSince===null)return next;
  const boundary=cleanSince+GRID_CANARY_DURATION_MS;
  if(input.observedAt<boundary)return next;
  if(next.certifiedGeneration===null&&input.safeThrough!==null&&input.safeThrough>=boundary){
    next.certifiedGeneration=input.generation;next.certifiedSafeThrough=input.safeThrough;next.certifiedTickId=input.tickId;
  }else if(next.certifiedGeneration!==null&&input.tickId!==next.certifiedTickId){next.cleanTicks++;}
  next.promoted=next.cleanTicks>=2;return next;
}
/** Match the planner's strict adjacent-spread fee clearance on immutable levels.
 * The conservative execution/builder ceiling also covers either maker leg. */
export function gridCanaryPolicyCurrent(q:GridObservation['qualification'],levels:{price:string;exact_size:string;reduce_only?:boolean}[],leverage:unknown,now:number,direction:string='long'):boolean{
  try{return !!q&&['long','short'].includes(direction)&&q.recycler&&Number.isSafeInteger(q.observedAt)&&q.observedAt<=now&&now-q.observedAt<=5000
    &&new D(q.leverage).eq(String(leverage))&&new D(q.leverage).gte(1)&&new D(q.maxLeverage).gte(q.leverage)
    &&new D(q.feeRate).gte(0)&&new D(q.feeRate).lt(1)&&[q.tickSize,q.lotSize,q.minOrderSize].every(x=>new D(x).gt(0))
    &&levels.length>=2&&levels.some(l=>new D(l.exact_size).gt(0))&&levels.every((l,i)=>{
      const price=new D(l.price),size=new D(l.exact_size),next=levels[i+1],paired=levels[i+(direction==='long'?1:-1)];
      return price.gt(0)&&size.gte(0)&&price.mod(q.tickSize).isZero()&&size.mod(q.lotSize).isZero()
        &&(size.isZero()||price.mul(size).gte(q.minOrderSize))
        &&(!next||new D(next.price).gt(price)&&new D(next.price).minus(price).gt(new D(q.feeRate).mul(price.plus(next.price))))
        &&(size.isZero()||l.reduce_only===true||!!paired&&new D(paired.price).mul(size).gte(q.minOrderSize));
    });}catch{return false;}
}
