import Decimal from 'decimal.js';
import type { GridCycle } from './engine-types';
import { canonicalGridPolicy, type GridPolicy } from './policy-hmac';
import { retainedGridCycles } from './cycle-policy';

const D = Decimal.clone({ precision: 200, rounding: Decimal.ROUND_DOWN, toExpNeg: -200, toExpPos: 200 });
export interface CyclePortion { tradeId: string; size: string }
/** Normalized immutable request authority. Stage B must read it under the bot lock. */
export interface CycleOperation {
  id: string; botId: string; account: string; kind: 'limit' | 'seed' | 'close';
  cycleOrdinal: number | null; leg: 'opening' | 'closing'; side: 'buy' | 'sell'; reduceOnly: boolean;
  price: string | null; size: string; preparedAt: number;
  initialCredit?: string; recycleAllocations?: CyclePortion[];
}
export interface CycleFill {
  tradeId: string; operationId: string; account: string; time: number; size: string; price: string; leg: 'entry' | 'exit';
}
/** Terminal release requires exact fills and history safely through the final order update. */
export interface CycleProgress {
  operationId: string; observedAt: number; state: 'unknown' | 'live' | 'terminal';
  filledSize?: string; remainingSize?: string; terminalAt?: number; historyThrough?: number;
}
export interface CycleInventoryAllocation extends CyclePortion { operationId: string; cycleOrdinal: number }
export interface CycleReplayInput {
  policy: GridPolicy; account: string; historyComplete: boolean;
  operations: CycleOperation[]; fills: CycleFill[]; progress: CycleProgress[]; allocations: CycleInventoryAllocation[];
  /** Complete seed operation set and durable release decision, proved terminal before issuing unused quota.
   * entriesAllowed records permission at release; later pauses must not erase already issued credit.
   * Current lifecycle permission is a separate Stage B admission gate. */
  unusedSeedProof?: { operationIds: string[]; historyThrough: number; entriesAllowed: boolean };
}
export interface ReplayedGridCycle {
  cycle: GridCycle; held: string; openingCommitments: string; closingCommitments: string;
  pendingSeed: string; initialCredit: string; recycleCredits: CyclePortion[]; openingCredit: string;
  availableEntryLots: CyclePortion[]; liveOpening: string[]; liveClosing: string[];
}
export type CycleReplayResult = { ok: true; cycles: ReplayedGridCycle[] }
  | { ok: false; reason: string };

const number = (s: unknown, positive = false): Decimal => {
  if (typeof s !== 'string' || s.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) throw Error('Invalid exact cycle quantity');
  const n = new D(s); if (positive && !n.gt(0)) throw Error('Nonpositive cycle quantity'); return n;
};
const timestamp = (n: number) => Number.isSafeInteger(n) && n >= 0;
const identity = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stable = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
function unique<T>(rows: T[], key: (r: T) => string): T[] {
  const map = new Map<string, T>();
  for (const r of rows) { const k = key(r), old = map.get(k); if (old && stable(old) !== stable(r)) throw Error('Conflicting duplicate cycle evidence'); map.set(k, r); }
  return [...map.values()];
}
const sourceKey = (ordinal: number, tradeId: string) => JSON.stringify([ordinal, tradeId]);
interface Source { cycle: number; tradeId: string; operationId: string; time: number; size: Decimal; retained: Decimal; consumed: Decimal }
interface OperationState { op: CycleOperation; filled: Decimal; retained: Decimal; terminal: boolean }

/** No IO, row-status transitions, inferred fills, rounding up, cross-cycle credit or economic P&L. */
export function replayGridCycles(input: CycleReplayInput): CycleReplayResult {
  try {
    const descriptors = retainedGridCycles(input.policy);
    if (!input.historyComplete || !identity(input.account) || !canonicalGridPolicy(input.policy) || !descriptors) throw Error('Complete signed cycle history is required');
    const cycles = new Map(descriptors.map(c => [c.ownerOrdinal, c]));
    const operations = unique(input.operations, o => o.id).sort((a,b)=>a.preparedAt-b.preparedAt || compareId(a.id,b.id));
    const ops = new Map(operations.map(o => [o.id, o]));
    const fills = unique(input.fills, f => f.tradeId).sort((a,b)=>a.time-b.time || compareId(a.tradeId,b.tradeId));
    const trades = new Map(fills.map(f => [f.tradeId,f]));
    const allocations = unique(input.allocations, a => stable([a.operationId,a.cycleOrdinal,a.tradeId]));
    const progress = new Map<string, CycleProgress>();
    for (const p of unique(input.progress, p=>stable([p.operationId,p.observedAt]))) {
      if (!ops.has(p.operationId) || !timestamp(p.observedAt) || !['unknown','live','terminal'].includes(p.state)) throw Error('Unowned or invalid order progress');
      const old=progress.get(p.operationId);
      if(old?.observedAt===p.observedAt && stable(old)!==stable(p)) throw Error('Conflicting order progress');
      if(!old || p.observedAt>old.observedAt) progress.set(p.operationId,p);
    }
    const filled = new Map<string,Decimal>();
    for (const f of fills) {
      const op=ops.get(f.operationId);
      if (!identity(f.tradeId) || f.account!==input.account || !op || !timestamp(f.time) || f.time<op.preparedAt
        || f.leg!==(op.reduceOnly?'exit':'entry')) throw Error('Fill does not belong to its immutable operation');
      const q=number(f.size,true); number(f.price,true);
      filled.set(op.id,(filled.get(op.id)??new D(0)).plus(q));
    }
    const states = new Map<string,OperationState>();
    for (const op of operations) {
      const q=number(op.size,true), actual=filled.get(op.id)??new D(0), cycle=op.cycleOrdinal===null?null:cycles.get(op.cycleOrdinal);
      if (!identity(op.id) || op.botId!==input.policy.id || op.account!==input.account || !timestamp(op.preparedAt)
        || !['limit','seed','close'].includes(op.kind) || !['opening','closing'].includes(op.leg)
        || op.reduceOnly!==(op.leg==='closing') || op.side!==(input.policy.direction==='long'?(op.reduceOnly?'sell':'buy'):(op.reduceOnly?'buy':'sell'))
        || actual.gt(q)) throw Error('Invalid cycle operation identity or quantity');
      if (op.kind==='limit') {
        if (!cycle || !number(op.price,true).eq(op.leg==='opening'?cycle.openingPrice:cycle.closingPrice) || q.gt(cycle.quantity)) throw Error('Operation changed its signed endpoint or quota');
      } else if (op.cycleOrdinal!==null || op.kind==='seed' && (op.leg!=='opening' || !input.policy.seedAtCreation)
        || op.kind==='close' && op.leg!=='closing') throw Error('Invalid seed or noncyclic reduction');
      if (op.kind!=='limit' || op.leg!=='opening') {
        if (op.initialCredit!==undefined || op.recycleAllocations!==undefined) throw Error('Only cycle openings consume opening credit');
      }
      const p=progress.get(op.id);
      if (p && p.observedAt<op.preparedAt) throw Error('Order progress predates its request');
      let retained=q, terminal=false;
      if (p && p.state!=='unknown') {
        if (!number(p.filledSize).eq(actual) || fills.some(f=>f.operationId===op.id && f.time>p.observedAt)) throw Error('Exact fill history disagrees with order progress');
        if (p.state==='live') {
          retained=actual.plus(number(p.remainingSize));
          if (retained.gt(q)) throw Error('Order residual exceeds request');
        } else {
          terminal=timestamp(p.terminalAt!) && timestamp(p.historyThrough!) && p.historyThrough!>=p.terminalAt!
            && p.historyThrough!<=p.observedAt && p.terminalAt!>=op.preparedAt
            && fills.filter(f=>f.operationId===op.id).every(f=>f.time<=p.terminalAt!);
          // A terminal label alone releases nothing; uncertainty retains every requested source.
          if(terminal) retained=actual;
        }
      }
      states.set(op.id,{op,filled:actual,retained,terminal});
    }
    const inventory = new Map<string,Source>(), recycle = new Map<string,Source>();
    const addSource = (map:Map<string,Source>,cycle:number,f:CycleFill,size:Decimal) => {
      const key=sourceKey(cycle,f.tradeId); if(map.has(key))throw Error('Duplicate source partition');
      map.set(key,{cycle,tradeId:f.tradeId,operationId:f.operationId,time:f.time,size,retained:new D(0),consumed:new D(0)});
    };
    const seedCycles=descriptors.filter(c=>new D(c.initialInventory).gt(0));
    const seedAssigned=new Map(seedCycles.map(c=>[c.ownerOrdinal,new D(0)]));
    for (const f of fills) {
      const op=ops.get(f.operationId)!;
      if (op.kind==='seed') {
        let remaining=number(f.size,true);
        for (const c of seedCycles) {
          const used=seedAssigned.get(c.ownerOrdinal)!, part=D.min(remaining,new D(c.quantity).minus(used));
          if(part.gt(0)){addSource(inventory,c.ownerOrdinal,f,part);seedAssigned.set(c.ownerOrdinal,used.plus(part));remaining=remaining.minus(part);}
        }
        if(!remaining.eq(0))throw Error('Actual seed exceeds signed quotas');
      } else if(op.kind==='limit') addSource(op.leg==='opening'?inventory:recycle,op.cycleOrdinal!,f,number(f.size,true));
      // A stop/manual/sweep close can consume inventory but never issues recycle credit.
    }
    const seedStates=[...states.values()].filter(s=>s.op.kind==='seed');
    const seedQuota=seedCycles.reduce((s,c)=>s.plus(c.quantity),new D(0));
    if(seedStates.reduce((s,o)=>s.plus(o.retained),new D(0)).gt(seedQuota))throw Error('Seed requests exceed signed capacity');
    let releaseUnused=false, unusedAvailableAt=0;
    if(input.unusedSeedProof){const proof=input.unusedSeedProof;
      if(!timestamp(proof.historyThrough) || new Set(proof.operationIds).size!==proof.operationIds.length
        || stable([...proof.operationIds].sort())!==stable(seedStates.map(s=>s.op.id).sort())
        || seedStates.some(s=>!s.terminal || progress.get(s.op.id)!.historyThrough!>proof.historyThrough))throw Error('Unused seed lacks complete terminal proof');
      releaseUnused=proof.entriesAllowed===true;
      unusedAvailableAt=Math.max(proof.historyThrough,...seedStates.map(s=>progress.get(s.op.id)!.observedAt));
    }
    const initial=new Map(descriptors.map(c=>[c.ownerOrdinal,{
      issued:new D(c.initialOpeningCredit).plus(releaseUnused?new D(c.initialInventory).minus(seedAssigned.get(c.ownerOrdinal)??0):0),retained:new D(0)
    }]));
    const dependencies=new Map(operations.map(o=>[o.id,new Set<string>()]));
    const reserve = (s:Source,op:CycleOperation,retained:Decimal,consumed:Decimal) => {
      if(s.time>op.preparedAt || s.operationId===op.id)throw Error('Source was not available when request was prepared');
      dependencies.get(op.id)!.add(s.operationId);
      s.retained=s.retained.plus(retained);s.consumed=s.consumed.plus(consumed);
      if(s.retained.gt(s.size) || s.consumed.gt(s.retained))throw Error('Source credit is spent more than once');
    };
    for(const state of states.values()){
      const {op}=state;
      let retained=state.retained, consumed=state.filled;
      if(op.kind==='limit' && op.leg==='opening'){
        const portions=op.recycleAllocations??[], initialSize=number(op.initialCredit??'0');
        if(new Set(portions.map(p=>p.tradeId)).size!==portions.length || !initialSize.plus(portions.reduce((s,p)=>s.plus(number(p.size,true)),new D(0))).eq(op.size))throw Error('Opening source quantities do not equal request');
        // Immutable source order: initial issuance first, then the request's exact recycle portions.
        const issued=initial.get(op.cycleOrdinal!)!, initialRetained=D.min(retained,initialSize), initialConsumed=D.min(consumed,initialSize);
        if(initialSize.gt(issued.issued) || initialSize.gt(0) && new D(cycles.get(op.cycleOrdinal!)!.initialInventory).gt(0)
          && (!releaseUnused || op.preparedAt<unusedAvailableAt))throw Error('Initial issuance was not available when request was prepared');
        issued.retained=issued.retained.plus(initialRetained);
        if(issued.retained.gt(issued.issued))throw Error('Initial issuance is spent more than once');
        retained=retained.minus(initialRetained);consumed=consumed.minus(initialConsumed);
        for(const p of portions){const s=recycle.get(sourceKey(op.cycleOrdinal!,p.tradeId)),q=number(p.size,true);
          if(!s || q.gt(s.size))throw Error('Opening source is not an actual closing fill of this cycle');
          const reserved=D.min(retained,q),used=D.min(consumed,q);reserve(s,op,reserved,used);retained=retained.minus(reserved);consumed=consumed.minus(used);
        }
      } else if(op.leg==='closing'){
        const portions=allocations.filter(a=>a.operationId===op.id).sort((a,b)=>(trades.get(a.tradeId)?.time??0)-(trades.get(b.tradeId)?.time??0) || compareId(a.tradeId,b.tradeId) || a.cycleOrdinal-b.cycleOrdinal);
        if(!portions.reduce((s,p)=>s.plus(number(p.size,true)),new D(0)).eq(op.size))throw Error('Closing request lacks exact entry allocations');
        for(const p of portions){const s=inventory.get(sourceKey(p.cycleOrdinal,p.tradeId)),q=number(p.size,true);
          if(!s || q.gt(s.size) || op.kind==='limit' && op.cycleOrdinal!==p.cycleOrdinal)throw Error('Closing source belongs to another cycle or is not an entry fill');
          const reserved=D.min(retained,q),used=D.min(consumed,q);reserve(s,op,reserved,used);retained=retained.minus(reserved);consumed=consumed.minus(used);
        }
      }
    }
    if(allocations.some(a=>!states.has(a.operationId) || states.get(a.operationId)!.op.leg!=='closing'))throw Error('Unowned inventory allocation');
    // Equal timestamps cannot make a mutually dependent group of fabricated sources valid.
    const visiting=new Set<string>(),visited=new Set<string>();
    const visit=(id:string)=>{if(visiting.has(id))throw Error('Cyclic source dependency');if(visited.has(id))return;
      visiting.add(id);for(const source of dependencies.get(id)!)visit(source);visiting.delete(id);visited.add(id);};
    for(const op of operations)visit(op.id);
    const result:ReplayedGridCycle[]=[];
    for(const c of descriptors){
      const sources=[...inventory.values()].filter(s=>s.cycle===c.ownerOrdinal), exits=[...recycle.values()].filter(s=>s.cycle===c.ownerOrdinal);
      const owned=[...states.values()].filter(s=>s.op.kind==='limit' && s.op.cycleOrdinal===c.ownerOrdinal);
      const opening=owned.filter(s=>s.op.leg==='opening'), closing=owned.filter(s=>s.op.leg==='closing');
      const liveOpening=opening.filter(s=>!s.terminal).map(s=>s.op.id),liveClosing=closing.filter(s=>!s.terminal).map(s=>s.op.id);
      if(liveOpening.length>1 || liveClosing.length>1)throw Error('More than one nonterminal order for a cycle leg');
      const held=sources.reduce((sum,s)=>sum.plus(s.size).minus(s.consumed),new D(0));
      const openingCommitments=opening.reduce((sum,s)=>sum.plus(s.retained).minus(s.filled),new D(0));
      const closingCommitments=sources.reduce((sum,s)=>sum.plus(s.retained).minus(s.consumed),new D(0));
      const pendingSeed=releaseUnused?new D(0):new D(c.initialInventory).minus(seedAssigned.get(c.ownerOrdinal)??0);
      if(held.lt(0) || held.plus(openingCommitments).plus(pendingSeed).gt(c.quantity) || closingCommitments.gt(held))throw Error('Cycle circulating capacity exceeded');
      const initialCredit=initial.get(c.ownerOrdinal)!.issued.minus(initial.get(c.ownerOrdinal)!.retained);
      const portions=(sources:Source[])=>sources.filter(s=>s.size.gt(s.retained)).sort((a,b)=>a.time-b.time || compareId(a.tradeId,b.tradeId)).map(s=>({tradeId:s.tradeId,size:s.size.minus(s.retained).toFixed()}));
      const recycleCredits=portions(exits);
      result.push({cycle:c,held:held.toFixed(),openingCommitments:openingCommitments.toFixed(),closingCommitments:closingCommitments.toFixed(),pendingSeed:pendingSeed.toFixed(),
        initialCredit:initialCredit.toFixed(),recycleCredits,openingCredit:recycleCredits.reduce((s,p)=>s.plus(p.size),initialCredit).toFixed(),
        availableEntryLots:portions(sources),liveOpening,liveClosing});
    }
    return {ok:true,cycles:result};
  } catch(error) {return {ok:false,reason:error instanceof Error?error.message:'Invalid cycle history'};}
}

/** Call with a locked fresh snapshot; success is not a lease, lifecycle or send authorization. */
export function validateCycleSourceCredit(input: CycleReplayInput, candidate: CycleOperation, allocations: CycleInventoryAllocation[] = []): CycleReplayResult {
  if(input.operations.some(o=>o.id===candidate.id))return {ok:false,reason:'Candidate must have a fresh operation identity'};
  if(input.fills.some(f=>f.time>candidate.preparedAt) || input.progress.some(p=>p.observedAt>candidate.preparedAt)
    || input.operations.some(o=>o.preparedAt>candidate.preparedAt)
    || input.unusedSeedProof && input.unusedSeedProof.historyThrough>candidate.preparedAt)
    return {ok:false,reason:'Candidate predates its source authority snapshot'};
  return replayGridCycles({...input,operations:[...input.operations,candidate],allocations:[...input.allocations,...allocations]});
}

/** Dust remains credited. Only openings have a quote minimum; never top up a partial fill. */
export function executableCycleQuantity(state: ReplayedGridCycle, leg: 'opening'|'closing', lot: string, minimumQuote: string): string {
  const step=number(lot,true), minimum=number(minimumQuote,true);
  if((leg==='opening'?state.liveOpening:state.liveClosing).length)return '0';
  const available=leg==='opening'?number(state.openingCredit):state.availableEntryLots.reduce((s,p)=>s.plus(p.size),new D(0));
  const q=available.div(step).floor().mul(step);
  return leg==='opening' && q.mul(state.cycle.openingPrice).lt(minimum)?'0':q.toFixed();
}
