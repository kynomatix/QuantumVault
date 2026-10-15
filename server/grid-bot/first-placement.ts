import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:200});
import {requestDigest,type ExactGridRequest,type GridLaunchStorage} from './launch-storage';
import type {GridLaunchReads} from './launch-reads';
import type {GridPolicy} from './policy-hmac';
import {gridFirstPlacementGate} from './runtime-policy';

export interface GridFirstPlacementContext {
  policy:GridPolicy;confirmedAt:number;fundedAt:number;alreadyPlaced:boolean;
}
export interface GridFirstPlacementProof {
  requestDigest:string;context:GridFirstPlacementContext;bookPrice:string|null;observedAt:number|null;readStartedAt:number;
}
export interface GridFirstPlacementBoundary {
  observe(r:ExactGridRequest):Promise<GridFirstPlacementProof|null>;
  valid(proof:GridFirstPlacementProof,r:ExactGridRequest):boolean;
}
export const gridNeedsBook=(r:ExactGridRequest)=>r.kind==='seed'||(r.kind==='limit'&&r.data.reduce_only===false);

/** Shared strict Pacifica book parser; request time cannot refresh an old venue book. */
export function gridBookFact(raw:unknown,symbol:string,readStartedAt:number,now:number):{price:string;observedAt:number}|null{
  try{
    const r=raw as {success?:unknown;error?:unknown;data?:{s?:unknown;t?:unknown;l?:unknown}},d=r?.data;
    if(r.success!==true||r.error!==null||!d||d.s!==symbol||!Number.isSafeInteger(d.t)||!Array.isArray(d.l)||d.l.length!==2)return null;
    const [bids,asks]=d.l as Array<Array<{p?:unknown;a?:unknown}>>;
    const positive=(v:unknown)=>typeof v==='string'&&v.length<=80&&v.trim()===v&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)&&new Decimal(v).gt(0);
    if(!Array.isArray(bids)||!Array.isArray(asks)||!bids.length||!asks.length||![bids[0].p,asks[0].p,bids[0].a,asks[0].a].every(positive))return null;
    const bid=new Decimal(bids[0].p as string),ask=new Decimal(asks[0].p as string),at=Math.min(readStartedAt,d.t as number);
    if(bid.gte(ask)||![now,readStartedAt,d.t].every(Number.isSafeInteger)||readStartedAt>now||(d.t as number)>now||now-at>=5000)return null;
    return {price:bid.plus(ask).div(2).toFixed(),observedAt:at};
  }catch{return null;}
}

/** The read begins only after the retained exact funding and owner-confirmed preview are verified. */
export class GridFirstPlacementAuthority implements GridFirstPlacementBoundary {
  constructor(private storage:Pick<GridLaunchStorage,'firstPlacementContext'>,private reads:Pick<GridLaunchReads,'json'>,private now=Date.now){}
  async observe(r:ExactGridRequest):Promise<GridFirstPlacementProof|null>{
    const context=await this.storage.firstPlacementContext(r);
    if(!context)return null;
    const readStartedAt=this.now();
    if(![context.confirmedAt,context.fundedAt,readStartedAt].every(Number.isSafeInteger)
      ||context.confirmedAt>readStartedAt||context.fundedAt>readStartedAt)return null;
    if(context.alreadyPlaced)return {requestDigest:requestDigest(r),context,bookPrice:null,observedAt:null,readStartedAt};
    const symbol=context.policy.market.replace(/-PERP$/,'');
    const raw=await this.reads.json(r.masterAccount,'/book',{symbol}) as {success?:unknown;error?:unknown;data?:{s?:unknown;t?:unknown;l?:unknown}};
    const d=raw?.data;
    if(raw?.success!==true||raw.error!==null||!d||d.s!==symbol||d.s!==r.data.symbol||!Number.isSafeInteger(d.t)
      ||!Array.isArray(d.l)||d.l.length!==2)return null;
    try {
      const [bids,asks]=d.l as Array<Array<{p?:unknown;a?:unknown}>>;
      if(!Array.isArray(bids)||!Array.isArray(asks)||!bids.length||!asks.length)return null;
      const positive=(v:unknown)=>typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)&&new Decimal(v).gt(0);
      if(![bids[0].p,asks[0].p,bids[0].a,asks[0].a].every(positive))return null;
      const bid=new Decimal(bids[0].p as string),ask=new Decimal(asks[0].p as string);
      if(bid.gte(ask))return null;
      // A stop, ownership change or newly ambiguous operation during the async read invalidates admission.
      const current=await this.storage.firstPlacementContext(r);
      if(!current||requestDigest(current)!==requestDigest(context))return null;
      const proof={requestDigest:requestDigest(r),context,bookPrice:bid.plus(ask).div(2).toFixed(),observedAt:d.t as number,readStartedAt};
      return this.valid(proof,r)?proof:null;
    }catch{return null;}
  }
  /** Synchronous: called after signing and immediately before the sole POST, with no intervening await. */
  valid(proof:GridFirstPlacementProof,r:ExactGridRequest):boolean{
    try {
      const {context:c}=proof,p=c.policy,now=this.now();
      if(proof.requestDigest!==requestDigest(r)||p.id!==r.botId||p.market.replace(/-PERP$/,'')!==r.data.symbol
        ||![now,c.confirmedAt,c.fundedAt,proof.readStartedAt].every(Number.isSafeInteger)
        ||proof.readStartedAt<c.confirmedAt||proof.readStartedAt<c.fundedAt||now<proof.readStartedAt)return false;
      if(c.alreadyPlaced)return true;
      if(proof.observedAt===null||proof.bookPrice===null||proof.observedAt<c.confirmedAt||proof.observedAt<c.fundedAt)return false;
      const book=new Decimal(proof.bookPrice),start=new Decimal(p.startPrice);
      const spacing=Decimal.min(...p.levels.slice(1).map((l,i)=>new Decimal(l.price).minus(p.levels[i].price))).toFixed();
      return gridFirstPlacementGate({confirmedPrice:p.startPrice,bookPrice:proof.bookPrice,smallestSpacingPrice:spacing,
        observedAt:proof.observedAt,source:'/book',identityValid:true,
        sideFlip:p.levels.some(l=>new Decimal(l.price).lt(start)!==new Decimal(l.price).lt(book)
          ||new Decimal(l.price).gt(start)!==new Decimal(l.price).gt(book)),
        rangeValid:book.gte(p.lowerPrice)&&book.lte(p.upperPrice)},now);
    }catch{return false;}
  }
}
