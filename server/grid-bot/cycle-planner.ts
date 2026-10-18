import Decimal from 'decimal.js';
import {executableCycleQuantity,type CyclePortion,type ReplayedGridCycle} from './cycle-replay';
import {gridWindow,type WindowLevel,type WindowOrder,windowLevelKey} from './window';
import type {CycleCapacity} from './cycle-capacity';
const D=Decimal.clone({precision:200});
export function cyclePortions(lots:CyclePortion[],amount:string):CyclePortion[]{
  let remaining=new D(amount);const result:CyclePortion[]=[];
  for(const lot of lots){const size=D.min(remaining,lot.size);if(size.gt(0))result.push({tradeId:lot.tradeId,size:size.toFixed()});remaining=remaining.minus(size);}
  if(!remaining.eq(0))throw Error('Cycle source quantity unavailable');return result;
}
export function cycleOpeningSources(c:ReplayedGridCycle,amount:string){
  const initial=D.min(amount,c.initialCredit);
  return {initialCredit:initial.toFixed(),recycleAllocations:cyclePortions(c.recycleCredits,new D(amount).minus(initial).toFixed())};
}
/** Both legs have separate working identities, even when endpoints overlap another owner's cycle. */
export function planCycleWindow(input:{cycles:ReplayedGridCycle[];direction:'long'|'short';levels:{id:string;ordinal:number;attempt:number}[];
  owned:WindowOrder[];positionSize:string|null;bookPrice:string;lot:string;minimumQuote:string;freeSlots:number;
  inventoryComplete:boolean;entriesAllowed:boolean;canaryRemaining:string;pool?:CycleCapacity}){
  const levels:WindowLevel[]=[],allocations:Record<string,CyclePortion[]>={};
  for(const c of input.cycles){const row=input.levels.find(l=>l.ordinal===c.cycle.ownerOrdinal+1);if(!row)throw Error('Cycle owner missing');
    for(const leg of ['closing','opening'] as const){
      const reduceOnly=leg==='closing',price=reduceOnly?c.cycle.closingPrice:c.cycle.openingPrice;
      const side=input.direction==='long'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell');
      const working=input.owned.find(o=>o.levelId===row.id&&o.cycleLeg===leg);
      const live=reduceOnly?c.liveClosing:c.liveOpening;
      if(working&&live.length!==1)throw Error('Cycle live inventory unavailable');
      // A terminal venue order can still reserve its leg until history is complete.
      // Its exact fills may fund the other leg while executableCycleQuantity keeps this one off.
      const available=executableCycleQuantity(c,leg,input.lot,input.minimumQuote);
      const passive=side==='buy'?new D(price).lt(input.bookPrice):new D(price).gt(input.bookPrice);
      const size=working?.remaining??(passive?available:'0');
      const level:WindowLevel={...row,price,size,side,reduceOnly,cycle:{ownerOrdinal:c.cycle.ownerOrdinal,leg},
        ...(!reduceOnly&&!working?cycleOpeningSources(c,size):{})};
      levels.push(level);
      if(reduceOnly&&!working)allocations[windowLevelKey(level)]=cyclePortions(c.availableEntryLots,size);
    }
  }
  return {levels,allocations,chunks:gridWindow({...input,levels})};
}
