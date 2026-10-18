import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:200});
import {GRID_CAPS} from './grid-caps';
import {gridPlacementBudget} from '../../shared/grid-capacity';
export interface WindowLevel {id:string;ordinal:number;price:string;size:string;reduceOnly:boolean;side:'buy'|'sell';attempt:number;cycle?:{ownerOrdinal:number;leg:'opening'|'closing'};initialCredit?:string;recycleAllocations?:{tradeId:string;size:string}[]}
export interface WindowOrder {levelId:string;orderId:string;clientOrderId:string;remaining:string;reduceOnly:boolean;cycleLeg?:'opening'|'closing'}
export const windowLevelKey=(l:Pick<WindowLevel,'id'|'cycle'>)=>l.cycle?`${l.id}:${l.cycle.leg}`:l.id;
const orderKey=(o:WindowOrder)=>o.cycleLeg?`${o.levelId}:${o.cycleLeg}`:o.levelId;
export type WindowAction={kind:'cancel';order:WindowOrder}|{kind:'place';level:WindowLevel};
/** Pure planning. Unknown inventory/position denies; only exact bot-owned orders can be cancelled. */
export function gridWindow(input:{levels:WindowLevel[];owned:WindowOrder[];positionSize:string|null;bookPrice:string;freeSlots:number;inventoryComplete:boolean;entriesAllowed:boolean;canaryRemaining:string;pool?:{envelope:string;remaining:string;breached:boolean}}):WindowAction[][]{
  if(!input.inventoryComplete || input.positionSize===null || !Number.isSafeInteger(input.freeSlots) || input.freeSlots<0)throw Error('Grid inventory unavailable');
  const price=new Decimal(input.bookPrice),position=new Decimal(input.positionSize),budget=new Decimal(input.canaryRemaining);
  if(!price.gt(0)||!position.gte(0)||!budget.gte(0))throw Error('Grid window authority unavailable');
  if(new Set(input.levels.map(windowLevelKey)).size!==input.levels.length || new Set(input.owned.map(orderKey)).size!==input.owned.length
    || input.owned.some(o=>!input.levels.some(l=>windowLevelKey(l)===orderKey(o) && l.reduceOnly===o.reduceOnly)))throw Error('Grid ownership inventory mismatch');
  const distance=(a:WindowLevel,b:WindowLevel)=>new Decimal(a.price).minus(price).abs().cmp(new Decimal(b.price).minus(price).abs())||a.ordinal-b.ordinal;
  const exits=input.levels.filter(l=>l.reduceOnly&&new Decimal(l.size).gt(0)).sort(distance);
  const entries=input.levels.filter(l=>!l.reduceOnly&&new Decimal(l.size).gt(0)).sort(distance);
  let backing=position;const desired:WindowLevel[]=[];
  for(const l of exits){const owned=input.owned.find(o=>orderKey(o)===windowLevelKey(l)),amount=new Decimal(owned?.remaining??l.size);
    if(!amount.gte(0)||amount.gt(l.size)||amount.gt(backing))throw Error('Profit exits exceed confirmed position backing');
    backing=backing.minus(amount);desired.push(l);
  }
  if(desired.length>GRID_CAPS.ordinaryRestingPerBot)throw Error('Backed exits exceed ordinary Grid slot cap');
  let remaining=budget;
  let poolRemaining=new Decimal(input.pool?.remaining??'0');
  if(input.entriesAllowed)for(const l of entries){if(desired.length>=GRID_CAPS.ordinaryRestingPerBot)break;
    const already=input.owned.some(o=>orderKey(o)===windowLevelKey(l)),notional=new Decimal(l.price).mul(l.size);
    const reservation=new Decimal(input.pool?.envelope??l.price).mul(l.size);
    if(!already && (notional.gt(remaining) || input.pool && (input.pool.breached || reservation.gt(poolRemaining))))continue;
    desired.push(l);if(!already){remaining=remaining.minus(notional);if(input.pool)poolRemaining=poolRemaining.minus(reservation);}
  }
  const keep=new Set(desired.map(windowLevelKey));
  // Cancels must settle on venue before this plan can be recalculated for placements.
  const cancels=input.owned.filter(o=>!o.reduceOnly&&!keep.has(orderKey(o))).map(order=>({kind:'cancel' as const,order}));
  const actions:WindowAction[]=cancels.length?cancels:[];
  if(!cancels.length){let free=gridPlacementBudget(input.owned.length,input.freeSlots);
    for(const level of desired){if(free<=0)break;if(input.owned.some(o=>orderKey(o)===windowLevelKey(level)))continue;
      actions.push({kind:'place',level});free--;
    }
  }
  const chunks:WindowAction[][]=[];
  // 10 is transport chunking only. It never limits the total resting window to 10.
  for(let i=0;i<actions.length;i+=GRID_CAPS.transportBatchActions)chunks.push(actions.slice(i,i+GRID_CAPS.transportBatchActions));
  return chunks;
}
