import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:200});
import {GRID_CAPS} from './grid-caps';
export interface WindowLevel {id:string;ordinal:number;price:string;size:string;reduceOnly:boolean;side:'buy'|'sell';attempt:number}
export interface WindowOrder {levelId:string;orderId:string;clientOrderId:string;remaining:string;reduceOnly:boolean}
export type WindowAction={kind:'cancel';order:WindowOrder}|{kind:'place';level:WindowLevel};
/** Pure planning. Unknown inventory/position denies; only exact bot-owned orders can be cancelled. */
export function gridWindow(input:{levels:WindowLevel[];owned:WindowOrder[];positionSize:string|null;bookPrice:string;freeSlots:number;inventoryComplete:boolean;entriesAllowed:boolean;canaryRemaining:string}):WindowAction[][]{
  if(!input.inventoryComplete || input.positionSize===null || !Number.isSafeInteger(input.freeSlots) || input.freeSlots<0)throw Error('Grid inventory unavailable');
  const price=new Decimal(input.bookPrice),position=new Decimal(input.positionSize),budget=new Decimal(input.canaryRemaining);
  if(!price.gt(0)||!position.gte(0)||!budget.gte(0))throw Error('Grid window authority unavailable');
  if(new Set(input.levels.map(l=>l.id)).size!==input.levels.length || new Set(input.owned.map(o=>o.levelId)).size!==input.owned.length
    || input.owned.some(o=>!input.levels.some(l=>l.id===o.levelId && l.reduceOnly===o.reduceOnly)))throw Error('Grid ownership inventory mismatch');
  const distance=(a:WindowLevel,b:WindowLevel)=>new Decimal(a.price).minus(price).abs().cmp(new Decimal(b.price).minus(price).abs())||a.ordinal-b.ordinal;
  const exits=input.levels.filter(l=>l.reduceOnly&&new Decimal(l.size).gt(0)).sort(distance);
  const entries=input.levels.filter(l=>!l.reduceOnly&&new Decimal(l.size).gt(0)).sort(distance);
  let backing=position;const desired:WindowLevel[]=[];
  for(const l of exits){const owned=input.owned.find(o=>o.levelId===l.id),amount=new Decimal(owned?.remaining??l.size);
    if(!amount.gte(0)||amount.gt(l.size)||amount.gt(backing))throw Error('Profit exits exceed confirmed position backing');
    backing=backing.minus(amount);desired.push(l);
  }
  if(desired.length>20)throw Error('Backed exits exceed ordinary Grid slot cap');
  let remaining=budget;
  if(input.entriesAllowed)for(const l of entries){if(desired.length>=20)break;
    const already=input.owned.some(o=>o.levelId===l.id),notional=new Decimal(l.price).mul(l.size);
    if(!already && notional.gt(remaining))continue;
    desired.push(l);if(!already)remaining=remaining.minus(notional);
  }
  const keep=new Set(desired.map(l=>l.id));
  // Cancels must settle on venue before this plan can be recalculated for placements.
  const cancels=input.owned.filter(o=>!o.reduceOnly&&!keep.has(o.levelId)).map(order=>({kind:'cancel' as const,order}));
  const actions:WindowAction[]=cancels.length?cancels:[];
  if(!cancels.length){let free=Math.min(20-input.owned.length,Math.max(0,input.freeSlots-5));
    for(const level of desired){if(free<=0)break;if(input.owned.some(o=>o.levelId===level.id))continue;
      actions.push({kind:'place',level});free--;
    }
  }
  const chunks:WindowAction[][]=[];
  // 10 is transport chunking only. It never limits the total resting window to 10.
  for(let i=0;i<actions.length;i+=GRID_CAPS.transportBatchActions)chunks.push(actions.slice(i,i+GRID_CAPS.transportBatchActions));
  return chunks;
}
