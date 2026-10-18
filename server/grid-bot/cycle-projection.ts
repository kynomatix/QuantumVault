import Decimal from 'decimal.js';
import type {GridCycleOrderView} from '../../shared/grid-surface';
import {executableCycleQuantity,type ReplayedGridCycle,type CycleProgress} from './cycle-replay';
const D=Decimal.clone({precision:200});
/** Display only; quantities come from the same replay as admission. */
export function projectCycleOrders(cycles:ReplayedGridCycle[],progress:CycleProgress[],direction:'long'|'short',
  lot:string,minimumQuote:string,mark:string,entriesAllowed:boolean):GridCycleOrderView[]{
  return cycles.flatMap(c=>['closing','opening'].map<GridCycleOrderView>(raw=>{
    const leg=raw as 'closing'|'opening',closing=leg==='closing',live=closing?c.liveClosing:c.liveOpening;
    const price=closing?c.cycle.closingPrice:c.cycle.openingPrice;
    const side=direction==='long'?(closing?'sell':'buy'):(closing?'buy':'sell');
    const available=closing?c.availableEntryLots.reduce((sum,l)=>sum.plus(l.size),new D(0)).toFixed():c.openingCredit;
    const executable=executableCycleQuantity(c,leg,lot,minimumQuote);
    const size=live.length?(closing?c.closingCommitments:c.openingCommitments):executable;
    const state:GridCycleOrderView['state']=live.length?(live.every(id=>progress.some(p=>p.operationId===id&&p.state==='live'))?'working':'pending confirmation')
      :!closing&&!entriesAllowed?'paused':new D(available).isZero()?'waiting for fills':new D(executable).isZero()?'waiting for minimum'
      :(side==='buy'?new D(price).gte(mark):new D(price).lte(mark))?'waiting for price':'queued';
    return {ownerOrdinal:c.cycle.ownerOrdinal,leg,price,side,size,state};
  }));
}
