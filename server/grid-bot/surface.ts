import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import type {GridBotSurface,GridBotSummary} from '../../shared/grid-surface';
import type {StoredBot} from './storage';
import {GRID_CAPS} from './grid-caps';
import {gridRuntimeGates} from './service';
import {gridStartRequestSchema} from '../../shared/grid-start';
import {GRID_HISTORY_PUBLICATION_LAG_MS} from './history-safety';
import {gridPnl,orderedGridFills,type GridEconomicFill} from './pnl';
/** Reconstruct terminal display facts from the complete ledger, never the 100 chart markers. */
export function gridEndedRun(direction:'long'|'short',fills:GridEconomicFill[]){
  try {
    const ordered=orderedGridFills(fills),final=gridPnl(direction,ordered,null);
    if(!ordered.length||final.quantity!=='0')return null;
    const lastOpen=gridPnl(direction,ordered.slice(0,-1),null);
    return {realised:final.realised,finalBreakeven:lastOpen.botBreakeven};
  } catch { return null; }
}
export function gridBotSummary(bot:StoredBot):GridBotSummary{
  return {id:bot.id,name:bot.name,market:bot.market,direction:bot.direction,status:bot.status,lowerPrice:bot.lowerPrice,
    upperPrice:bot.upperPrice,totalInvestment:bot.totalInvestment,stopLossPrice:bot.stopLossPrice,gridCount:bot.gridCount,
    chartTimeframe:bot.chartTimeframe,updatedAt:bot.updatedAt.toISOString(),createIntent:bot.createIntent as GridBotSummary['createIntent'],
    ...(bot.gridPolicyExtension?{behaviourMode:bot.gridPolicyExtension.mode,onceOnlyPrices:bot.gridPolicyExtension.boundaryPrices}:{}),
    seedAtCreation:bot.seedAtCreation,leverage:bot.leverage,...(isGridCyclePolicyVersion(bot.policyVersion)?{policyVersion:bot.policyVersion}:{})};
}
/** Presentation only. A stale ledger snapshot never becomes a current financial fact. */
export function gridSurface(snapshot:any,monitor:any,life:any,events:{pending:number;uncertain:number},now=Date.now()):GridBotSurface{
  const o=monitor?.observation,at=monitor?.reconciled_at?new Date(monitor.reconciled_at).getTime():NaN;
  const fresh=Number.isFinite(at)&&at<=now&&now-at<=15000&&o?.inventoryComplete===true
    &&Number.isSafeInteger(o.observedAt)&&o.observedAt<=now&&now-o.observedAt<=15000;
  const pnl=monitor?.pnl,decimal=(x:unknown)=>typeof x==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(x)?x:null;
  const residualAt=snapshot.bot.residualObservedAt?new Date(snapshot.bot.residualObservedAt).getTime():NaN;
  const residualFresh=snapshot.bot.status==='stopped'||residualAt<=now&&now-residualAt<=15000;
  const gates=gridRuntimeGates();
  const retained=gridStartRequestSchema.safeParse({draftRevision:snapshot.bot.draftRevision,serverIntentDigest:snapshot.bot.serverIntentDigest});
  const timestamp=(value:unknown)=>{const at=value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(at)&&at<=now?new Date(at).toISOString():null;};
  const returnedAt=timestamp(snapshot.returnedFunds?.terminal_at);
  const fee=o?.qualification,feeRate=decimal(fee?.feeRate);
  const feeFresh=fresh&&Number.isSafeInteger(fee?.observedAt)&&fee.observedAt<=now&&now-fee.observedAt<=5000;
  const h=o?.history;
  const inferred=fresh&&now-o.observedAt<=5000&&h?.source==='pacifica_full_replay_stable_last_id'&&h.inclusive===true
    &&typeof h.lastId==='string'&&h.publicationLagMs===GRID_HISTORY_PUBLICATION_LAG_MS
    &&Number.isSafeInteger(h.from)&&h.from>=0&&Number.isSafeInteger(h.through)&&h.from<=h.through
    &&h.through<=now-GRID_HISTORY_PUBLICATION_LAG_MS&&now-h.through<=5000+GRID_HISTORY_PUBLICATION_LAG_MS;
  const reasons:string[]=Array.isArray(monitor?.blocked_reasons)?monitor.blocked_reasons.filter((x:unknown):x is string=>typeof x==='string'):[];
  if(!fresh)reasons.push('Current exchange authority is unavailable or out of date.');
  if(!inferred)reasons.push('Current safe history window is unavailable.');
  if(!gates.workerRunning)reasons.push('Grid worker is off or unavailable.');
  const a=snapshot.autoPreference;
  // Missing preference means ON; only a persisted completed-band arm can resume.
  const projection=snapshot.cycleProjection;
  const cycleProjection=fresh&&projection&&String(projection.generation)===String(monitor?.generation)&&projection.observedAt===o.observedAt
    &&Array.isArray(projection.orders)?{observedAt:new Date(projection.observedAt).toISOString(),orders:projection.orders.map((order:any)=>
      snapshot.bot.status==='stopped'?{...order,state:'stopped'}:order.leg==='opening'&&order.recycles!==false&&!['provisioning','canary','active'].includes(snapshot.bot.status)&&!['working','pending confirmation'].includes(order.state)?{...order,state:'paused'}:order)}:null;
  return {...(isGridCyclePolicyVersion(snapshot.bot.policyVersion)?{cycleProjection}:{}),autoResume:{enabled:a?.enabled??true,generation:String(a?.generation??'0'),cycle:String(a?.cycle??'0'),attempts:a?.attempts??0,armed:!!a?.armed_cycle,heldReason:a?.held_reason??null,heldSince:a?.updated_at?new Date(a.updated_at).toISOString():null,band:null,available:false},bot:gridBotSummary(snapshot.bot),levels:snapshot.levels,operations:snapshot.operations.map((x:any)=>({id:x.id,type:x.type,state:x.state})),
    lifecycle:{action:life?.action??null,state:life?.state??null,blocker:life?.blocker??null},
    pnl:{realised:decimal(pnl?.realised),unrealised:fresh?decimal(pnl?.unrealised):null,total:fresh?decimal(pnl?.total):null,fees:decimal(pnl?.fees),averageEntry:fresh?decimal(pnl?.averageEntry):null,breakeven:fresh?decimal(pnl?.breakeven):null,
      botBreakeven:fresh?decimal(pnl?.botBreakeven):null,profitCoversPosition:fresh&&pnl?.profitCoversPosition===true},
    fills:(snapshot.fills??[]).map((f:any)=>({tradeId:f.trade_id,time:Number(f.venue_time),leg:f.leg,size:f.size,price:f.price})).reverse(),
    cycles:Number.isSafeInteger(pnl?.cycles)&&pnl.cycles>=0?pnl.cycles:null,
    qualification:{firstConfirmedAt:timestamp(snapshot.bot.canaryStartedAt),cleanSince:timestamp(snapshot.bot.canaryCleanSince),
      cleanTicks:Number.isSafeInteger(snapshot.bot.canaryCleanTicks)&&snapshot.bot.canaryCleanTicks>=0?snapshot.bot.canaryCleanTicks:null,promotedAt:timestamp(snapshot.bot.canaryPromotedAt)},
    position:fresh&&o.position&&decimal(o.position.size)!==null?o.position:null,
    mark:fresh&&o.mark&&o.mark.observedAt<=now&&now-o.mark.observedAt<=15000?decimal(o.mark.price):null,
    observedAt:fresh?new Date(o.observedAt).toISOString():null,residual:residualFresh?decimal(snapshot.bot.residualUsdc):null,
    stopFee:feeFresh&&feeRate!==null&&!feeRate.startsWith('-')&&Number(feeRate)<1?{rate:feeRate,observedAt:new Date(fee.observedAt).toISOString()}:null,
    endedRun:snapshot.bot.status==='stopped'&&snapshot.runFills?gridEndedRun(snapshot.bot.direction,snapshot.runFills):null,
    sweep:snapshot.bot.status==='stopped'?'Confirmed terminal':snapshot.operations.some((x:any)=>x.type==='sweep_subaccount')?'Sweep unconfirmed':snapshot.bot.status==='stopping'?'Awaiting venue settlement':'Not terminal',
    returnedFunds:{amount:returnedAt?decimal(snapshot.returnedFunds?.amount):null,confirmedAt:returnedAt},
    capacity:{ordinaryWindow:GRID_CAPS.ordinaryRestingPerBot,reservedSlots:GRID_CAPS.sharedProtectionReserve,liveOrders:fresh?o.orders.filter((x:any)=>['open','partially_filled'].includes(x.status)).length:null,venueMaximum:null},
    authorities:{safeWindow:inferred,safeWindowState:inferred?'inferred':'unavailable',resume:gates.workerRunning,
      lostSweepLookup:false,breaker:'retained_terminal_failures'},entriesBlockedReasons:reasons,
    startDraft:retained.success?retained.data:null,
    notifications:events,draftEnabled:gates.draftEnabled,startConfigured:gates.startConfigured,workerEnabled:gates.workerEnabled,workerRunning:gates.workerRunning,startEnabled:gates.startEnabled};
}
