import type {GridBotSurface,GridBotSummary} from '../../shared/grid-surface';
import type {StoredBot} from './storage';
import {GRID_CAPS} from './grid-caps';
export function gridBotSummary(bot:StoredBot):GridBotSummary{
  return {id:bot.id,name:bot.name,market:bot.market,direction:bot.direction,status:bot.status,lowerPrice:bot.lowerPrice,
    upperPrice:bot.upperPrice,totalInvestment:bot.totalInvestment,stopLossPrice:bot.stopLossPrice,gridCount:bot.gridCount,
    chartTimeframe:bot.chartTimeframe,updatedAt:bot.updatedAt.toISOString(),createIntent:bot.createIntent as GridBotSummary['createIntent']};
}
/** Presentation only. A stale ledger snapshot never becomes a current financial fact. */
export function gridSurface(snapshot:any,monitor:any,life:any,events:{pending:number;uncertain:number},now=Date.now()):GridBotSurface{
  const o=monitor?.observation,at=monitor?.reconciled_at?new Date(monitor.reconciled_at).getTime():NaN;
  const fresh=Number.isFinite(at)&&at<=now&&now-at<=15000&&o?.inventoryComplete===true
    &&Number.isSafeInteger(o.observedAt)&&o.observedAt<=now&&now-o.observedAt<=15000;
  const pnl=monitor?.pnl,decimal=(x:unknown)=>typeof x==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(x)?x:null;
  const residualAt=snapshot.bot.residualObservedAt?new Date(snapshot.bot.residualObservedAt).getTime():NaN;
  const residualFresh=snapshot.bot.status==='stopped'||residualAt<=now&&now-residualAt<=15000;
  return {bot:gridBotSummary(snapshot.bot),levels:snapshot.levels,operations:snapshot.operations.map((x:any)=>({id:x.id,type:x.type,state:x.state})),
    lifecycle:{action:life?.action??null,state:life?.state??null,blocker:life?.blocker??null},
    pnl:{realised:decimal(pnl?.realised),unrealised:fresh?decimal(pnl?.unrealised):null,total:fresh?decimal(pnl?.total):null,fees:decimal(pnl?.fees),averageEntry:fresh?decimal(pnl?.averageEntry):null,breakeven:fresh?decimal(pnl?.breakeven):null},
    fills:(snapshot.fills??[]).map((f:any)=>({tradeId:f.trade_id,time:Number(f.venue_time),leg:f.leg,size:f.size,price:f.price})).reverse(),
    cycles:Number.isSafeInteger(pnl?.cycles)&&pnl.cycles>=0?pnl.cycles:null,
    position:fresh&&o.position&&decimal(o.position.size)!==null?o.position:null,
    mark:fresh&&o.mark&&o.mark.observedAt<=now&&now-o.mark.observedAt<=15000?decimal(o.mark.price):null,
    observedAt:fresh?new Date(o.observedAt).toISOString():null,residual:residualFresh?decimal(snapshot.bot.residualUsdc):null,
    sweep:snapshot.bot.status==='stopped'?'Confirmed terminal':snapshot.operations.some((x:any)=>x.type==='sweep_subaccount')?'Sweep unconfirmed':snapshot.bot.status==='stopping'?'Awaiting venue settlement':'Not terminal',
    capacity:{ordinaryWindow:GRID_CAPS.ordinaryRestingPerBot,reservedSlots:GRID_CAPS.sharedProtectionReserve,liveOrders:fresh?o.orders.filter((x:any)=>['open','partially_filled'].includes(x.status)).length:null,venueMaximum:null},
    authorities:{safeWindow:false,resume:false,lostSweepLookup:false,breaker:'not_monitored_by_venue_error_class'},notifications:events,workerEnabled:false,startEnabled:false};
}
