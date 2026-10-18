import {requestDigest as cycleRequestDigest} from './request-digest';
export {requestDigest as cycleRequestDigest} from './request-digest';
import Decimal from 'decimal.js';
import type {GridPolicy} from './policy-hmac';
import {canonicalGridPolicy} from './policy-hmac';
import {retainedGridCycles} from './cycle-policy';
import {gridClientOrderId} from './order-identity';
import type {ExactGridRequest} from './launch-storage';
import type {GridObservation, ReconciliationOperation} from './reconciliation';
import {replayGridCycles, type CycleReplayInput, type CycleOperation, type CycleInventoryAllocation} from './cycle-replay';

const D=Decimal.clone({precision:200});
export type CycleOperationRow=ReconciliationOperation & {type?:string;submitted_at?:Date|string|null;terminal_at?:Date|string|null};
export interface CycleLevelRow {id:string;ordinal:number;placement_attempt:number}
export interface CycleStoredFill {account:string;trade_id:string;operation_id:string;venue_time:string|number;size:string;price:string;leg:'entry'|'exit'}
export interface CycleAllocationRow {operation_id:string;account:string;trade_id:string;size:string}
export interface CycleMonitorOrder {operation_id:string;order_id:string;status:string;filled:string;remaining:string;observed_at:string|number}
export interface CycleNoLand {requestDigest:string;at:number}
export interface CycleTerminalProof {requestDigest:string;orderId:string;filledSize:string;terminalAt:number;historyThrough:number;observedAt:number}

/** Decode only immutable request authority. A row's original side/status is never a cycle leg. */
export function cycleOperation(policy:GridPolicy,account:string,levels:CycleLevelRow[],id:string,r:ExactGridRequest):CycleOperation {
  if(r.botId!==policy.id||r.account!==account||r.data.symbol!==policy.market.replace(/-PERP$/,'')
    ||!['seed','limit','close'].includes(r.kind)||typeof r.data.reduce_only!=='boolean'
    ||typeof r.data.amount!=='string'||!Number.isSafeInteger(r.timestamp))throw Error('Cycle operation identity changed');
  const reduceOnly=r.data.reduce_only,leg=reduceOnly?'closing':'opening';
  const side=policy.direction==='long'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell');
  if(r.data.side!==(side==='buy'?'bid':'ask'))throw Error('Cycle operation side changed');
  let ordinal:number|null=null;
  if(r.kind==='limit'){
    const a=r.authority.cycle as {ownerOrdinal:number;leg:string}|undefined;
    const row=levels.find(l=>l.id===r.authority.levelId),cycle=retainedGridCycles(policy)?.find(c=>c.ownerOrdinal===a?.ownerOrdinal);
    if(!a||!row||!cycle||row.ordinal!==cycle.ownerOrdinal+1||a.leg!==leg
      ||!Number.isSafeInteger(r.authority.levelAttempt)||(r.authority.levelAttempt as number)<0
      ||r.data.client_order_id!==gridClientOrderId({botId:policy.id,level:row.ordinal,attempt:r.authority.levelAttempt as number,leg:reduceOnly?'profit':'entry'})
      ||typeof r.data.price!=='string'||!new D(r.data.price).eq(reduceOnly?cycle.closingPrice:cycle.openingPrice)
      ||canonicalGridPolicy(r.authority.policy as GridPolicy)!==canonicalGridPolicy(policy))throw Error('Signed cycle authority changed');
    ordinal=cycle.ownerOrdinal;
  }
  return {id,botId:policy.id,account,kind:r.kind as CycleOperation['kind'],cycleOrdinal:ordinal,leg,side,reduceOnly,
    price:r.kind==='limit'?String(r.data.price):null,size:r.data.amount,preparedAt:r.timestamp,
    ...(r.kind==='limit'&&!reduceOnly?{initialCredit:r.authority.initialCredit as string,recycleAllocations:r.authority.recycleAllocations as CycleOperation['recycleAllocations']}:{})};
}

export function cycleRequestAllocations(op:CycleOperation,r:ExactGridRequest):CycleInventoryAllocation[]{
  if(op.leg!=='closing')return [];
  if(op.kind==='limit'){
    if(!Array.isArray(r.authority.fillAllocations))throw Error('Cycle exit allocations unavailable');
    return r.authority.fillAllocations.map((a:any)=>({operationId:op.id,cycleOrdinal:op.cycleOrdinal!,tradeId:a.tradeId,size:a.size}));
  }
  if(!Array.isArray(r.authority.cycleAllocations))throw Error('Stop cycle allocations unavailable');
  return r.authority.cycleAllocations.map((a:any)=>({...a,operationId:op.id}));
}

/** Validate prices before the economic ledger sees either a new or a retained fill. */
export function validateCycleFillPrices(policy:GridPolicy,operations:ReconciliationOperation[],fills:{operationId:string;price:string;leg:string}[]){
  const cycles=retainedGridCycles(policy);if(!cycles)throw Error('Cycle policy unavailable');
  for(const fill of fills){const op=operations.find(o=>o.id===fill.operationId),r=op?.exact_request;
    if(!r||typeof r.data.reduce_only!=='boolean'||fill.leg!==(r.data.reduce_only?'exit':'entry')
      ||r.data.side!==(policy.direction==='long'?(r.data.reduce_only?'ask':'bid'):(r.data.reduce_only?'bid':'ask'))
      ||cycleRequestDigest(r)!==op!.exact_request_digest)throw Error('Cycle economic fill identity changed');
    if(r.kind!=='limit')continue;
    const c=cycles.find(c=>c.ownerOrdinal===(r.authority.cycle as any)?.ownerOrdinal);
    if(!c||(r.authority.cycle as any)?.leg!==(r.data.reduce_only?'closing':'opening')
      ||canonicalGridPolicy(r.authority.policy as GridPolicy)!==canonicalGridPolicy(policy))throw Error('Cycle economic fill owner unavailable');
    const endpoint=r.data.reduce_only===true?c.closingPrice:c.openingPrice,price=new D(fill.price);
    if(!price.isFinite()||!price.gt(0)||!new D(String(r.data.price)).eq(endpoint)
      ||(r.data.side==='bid'?price.gt(endpoint):price.lt(endpoint)))throw Error('Cycle fill violates signed endpoint');
  }
}

/** Complete database closure, supplied by one locked transaction; no inferred row-pointer fills. */
export function normalizeCycleHistory(input:{policy:GridPolicy;account:string;levels:CycleLevelRow[];operations:CycleOperationRow[];
  fills:CycleStoredFill[];allocations:CycleAllocationRow[];orders:CycleMonitorOrder[];observation:GridObservation;
  historyComplete:boolean;now:number;noLand:Record<string,CycleNoLand>;terminals?:Record<string,CycleTerminalProof>;unusedSeedProof?:CycleReplayInput['unusedSeedProof']}){
  const {policy,account,observation:o}=input;
  if(!o.inventoryComplete||o.account!==account||o.symbol!==policy.market.replace(/-PERP$/,'')
    ||!o.position||!new D(o.position.size).isZero()&&o.position.direction!==policy.direction)throw Error('Complete cycle account inventory unavailable');
  const normalized:CycleReplayInput={policy,account,historyComplete:input.historyComplete,operations:[],fills:[],progress:[],allocations:[],
    ...(input.unusedSeedProof?{unusedSeedProof:input.unusedSeedProof}:{})};
  for(const row of input.operations){const r=row.exact_request;
    if(!r){if(['seed_position','place_level_order','close_position'].includes(row.type??''))throw Error('Missing cycle request authority');continue;}
    if(!['limit','seed','close'].includes(r.kind))continue;
    if(r.botId!==policy.id||r.account!==account||cycleRequestDigest(r)!==row.exact_request_digest)throw Error('Corrupt cycle operation history');
    const op=cycleOperation(policy,account,input.levels,row.id,r);normalized.operations.push(op);
    if(r.kind==='limit'&&row.level_id!==r.authority.levelId)throw Error('Cycle owner row changed');
    const allocations=cycleRequestAllocations(op,r);normalized.allocations.push(...allocations);
    const totals=new Map<string,Decimal>();for(const a of allocations)totals.set(a.tradeId,(totals.get(a.tradeId)??new D(0)).plus(a.size));
    const stored=input.allocations.filter(a=>a.operation_id===op.id);
    if(stored.length!==totals.size||stored.some(a=>a.account!==account||!totals.get(a.trade_id)?.eq(a.size)))throw Error('Durable cycle allocations differ from immutable request');
    const progress=input.orders.find(p=>p.operation_id===op.id);
    const venue=o.orders.find(v=>v.orderId===row.venue_order_id||v.clientOrderId!==null&&v.clientOrderId===r.data.client_order_id);
    const absent=input.noLand[row.id],unsent=row.state==='failed'&&row.failure_classification==='policy'&&row.submitted_at===null;
    if(unsent||absent){
      const at=unsent?new Date(row.terminal_at!).getTime():absent.at;
      if(!Number.isSafeInteger(at)||at>input.now||at<r.timestamp||!unsent&&absent.requestDigest!==row.exact_request_digest
        ||venue||input.fills.some(f=>f.operation_id===op.id))throw Error('Conflicting cycle no-land proof');
      normalized.progress.push({operationId:op.id,state:'terminal',filledSize:'0',terminalAt:at,historyThrough:at,observedAt:at});
    }else if(venue&&progress){
      if(progress.order_id!==venue.orderId||progress.status!==venue.status||!new D(progress.filled).eq(venue.filledAmount)
        ||Number(progress.observed_at)!==o.observedAt)throw Error('Cycle progress differs from complete inventory');
      const terminal=['filled','cancelled','rejected'].includes(venue.status);
      const proof=input.terminals?.[op.id];
      if(proof&&(!terminal||proof.requestDigest!==row.exact_request_digest||proof.orderId!==venue.orderId
        ||!new D(proof.filledSize).eq(venue.filledAmount)||proof.terminalAt!==venue.updatedAt
        ||!Number.isSafeInteger(proof.observedAt)||proof.observedAt>o.observedAt||proof.observedAt<proof.historyThrough
        ||!Number.isSafeInteger(proof.historyThrough)||proof.historyThrough<proof.terminalAt
        ||!o.history||proof.historyThrough>o.history.through))throw Error('Conflicting durable cycle terminal proof');
      normalized.progress.push({operationId:op.id,state:terminal?'terminal':'live',filledSize:venue.filledAmount,
        remainingSize:new D(venue.amount).minus(venue.filledAmount).minus(venue.cancelledAmount??'0').toFixed(),
        observedAt:proof?.observedAt??o.observedAt,...(terminal?{terminalAt:venue.updatedAt,historyThrough:proof?.historyThrough??o.history?.through}:{})});
    }else normalized.progress.push({operationId:op.id,state:'unknown',observedAt:r.timestamp});
  }
  normalized.fills=input.fills.map(f=>({account:f.account,tradeId:f.trade_id,operationId:f.operation_id,time:Number(f.venue_time),size:f.size,price:f.price,leg:f.leg}));
  if(input.allocations.some(a=>!normalized.operations.some(op=>op.id===a.operation_id)))throw Error('Unowned cycle allocation');
  const replay=replayGridCycles(normalized);if(!replay.ok)throw Error(replay.reason);
  if(!o.position||!replay.cycles.reduce((sum,c)=>sum.plus(c.held),new D(0)).eq(o.position.size))throw Error('Cycle inventory does not equal full account position');
  return {input:normalized,cycles:replay.cycles};
}
