import Decimal from 'decimal.js';
import {pairGridFills,type GridFillAllocation} from './reconciliation';
import {orderedGridFills,type GridEconomicFill} from './pnl';
import {gridWindow,type WindowLevel,type WindowOrder} from './window';
const D=Decimal.clone({precision:200});
export interface GridRebalanceLevel extends WindowLevel {status:string}
/** Build adjacent profit orders from actual entry trades, including level-less seed trades. */
export function planGridRebalance(input:{direction:'long'|'short';levels:GridRebalanceLevel[];fills:GridEconomicFill[];
  reserved:GridFillAllocation[];owned:WindowOrder[];positionSize:string|null;bookPrice:string;lot:string;minimumQuote:string;
  freeSlots:number;inventoryComplete:boolean;entriesAllowed:boolean;canaryRemaining:string}){
  if(input.positionSize===null||!new D(input.lot).gt(0)||!new D(input.minimumQuote).gte(0))throw Error('Pairing authority unavailable');
  const fills=orderedGridFills(input.fills),allocations=new Map<string,GridFillAllocation[]>(),reserved=[...input.reserved];
  const ownedByLevel=new Map(input.owned.map(o=>[o.levelId,o]));
  let backing=new D(input.positionSize).minus(input.owned.filter(o=>o.reduceOnly).reduce((a,o)=>a.plus(o.remaining),new D(0)));
  if(backing.lt(0))throw Error('Live exits exceed position');
  const desired:WindowLevel[]=input.levels.filter(l=>ownedByLevel.has(l.id)).map(l=>{const owned=ownedByLevel.get(l.id)!;return {...l,size:D.max(l.size,owned.remaining).toFixed(),reduceOnly:owned.reduceOnly};});
  const candidates=input.levels.filter(l=>!ownedByLevel.has(l.id)&&['pending','cancelled','filled'].includes(l.status)).sort((a,b)=>new D(a.price).minus(input.bookPrice).abs().cmp(new D(b.price).minus(input.bookPrice).abs())||a.ordinal-b.ordinal);
  for(const level of candidates){
    const source=input.levels.find(l=>l.ordinal===level.ordinal+(input.direction==='long'?-1:1));
    const eligible=fills.filter(f=>f.leg==='entry'&&(f.levelId===source?.id||(f.levelId===null&&level.reduceOnly)));
    const ids=new Set(eligible.map(f=>f.tradeId));
    const available=eligible.reduce((q,f)=>q.plus(f.size),new D(0));
    const paired=pairGridFills(eligible,reserved.filter(a=>ids.has(a.tradeId)),available.toFixed(),input.lot,backing.toFixed());
    const size=paired.reduce((q,a)=>q.plus(a.size),new D(0));
    if(size.gt(0)&&size.mul(level.price).gte(input.minimumQuote)){
      desired.push({...level,size:size.toFixed(),reduceOnly:true,side:input.direction==='long'?'sell':'buy'});
      allocations.set(level.id,paired);reserved.push(...paired);backing=backing.minus(size);
    }
  }
  // A filled entry is not recreated merely because its order disappeared. A new cycle needs explicit settled backing.
  for(const level of candidates)if(!allocations.has(level.id)&&!level.reduceOnly&&['pending','cancelled'].includes(level.status)
    &&(level.side==='buy'?new D(level.price).lt(input.bookPrice):new D(level.price).gt(input.bookPrice)))desired.push(level);
  const chunks=gridWindow({...input,levels:desired});
  return {chunks,allocations:Object.fromEntries(allocations)};
}
