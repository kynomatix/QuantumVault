import type {PoolClient} from 'pg';
import Decimal from 'decimal.js';
import {canonicalGridPolicy,verifyGridPolicyHmac} from './policy-hmac';
import {retainedGridPolicy} from './retained-policy';
import {cycleOperation,cycleRequestAllocations,cycleRequestDigest,normalizeCycleHistory} from './cycle-history';
import {validateCycleSourceCredit,type CycleReplayInput} from './cycle-replay';
import {reconcileGridObservation} from './reconciliation';
import type {ExactGridRequest} from './launch-storage';
import {validateRetainedGridCycles} from './cycle-validation';
import {projectCycleOrders} from './cycle-projection';
import {gridResumeClearance} from './resume-clearance';
import {cycleCapacity,requireCycleCapacity} from './cycle-capacity';

const D=Decimal.clone({precision:200});
/** Caller holds the bot lock (master -> bot -> levels for admission). No partial-history API. */
export async function readCycleState(c:PoolClient,bot:Record<string,any>,account:string,now:number){
  if(bot.policy_version!=='2.0.0')throw Error('Cycle adapter requires retained v2 policy');
  const levels=(await c.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal',[bot.id])).rows;
  const policy=retainedGridPolicy(bot,levels);
  const state=(await c.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[bot.id])).rows[0];
  const events=(await c.query("SELECT event_key,evidence FROM grid_risk_events WHERE bot_id=$1 AND (event_key IN ('canary-clock','cycle-unused-seed') OR event_key LIKE 'cycle-no-land:%' OR event_key LIKE 'cycle-terminal:%')",[bot.id])).rows;
  const full=events.find(e=>e.event_key==='canary-clock')?.evidence?.full;
  if(!state?.boot_id||!full||String(full.generation)!==String(state.generation)||Number(full.safeThrough)!==Number(state.safe_through)
    ||!Number.isSafeInteger(full.completedAt)||full.completedAt>now||now-full.completedAt>=5000
    ||now-new Date(state.reconciled_at).getTime()>=5000||new Date(state.reconciled_at).getTime()>now
    ||!state.observation?.history||Number(state.safe_through)!==state.observation.history.through)throw Error('Durable complete cycle history unavailable');
  const operations=(await c.query('SELECT * FROM grid_operations WHERE bot_id=$1 ORDER BY created_at,id',[bot.id])).rows;
  const fills=(await c.query('SELECT * FROM grid_exact_fills WHERE bot_id=$1 ORDER BY venue_time,trade_id',[bot.id])).rows;
  const orders=(await c.query('SELECT p.* FROM grid_monitor_orders p JOIN grid_operations o ON o.id=p.operation_id WHERE o.bot_id=$1',[bot.id])).rows;
  const allocations=(await c.query('SELECT a.* FROM grid_profit_allocations a JOIN grid_operations o ON o.id=a.operation_id WHERE o.bot_id=$1',[bot.id])).rows;
  const prior=fills.map(f=>({tradeId:f.trade_id,operationId:f.operation_id,orderId:f.order_id,levelId:f.level_id,time:Number(f.venue_time),leg:f.leg,size:f.size,price:f.price,fee:f.fee}));
  // Re-check complete account inventory, including unowned orders/trades and exact position parity.
  // A just-prepared operation is a reservation; it does not invalidate the preceding full scan.
  const checked=reconcileGridObservation({account,symbol:policy.market.replace(/-PERP$/,''),direction:policy.direction,
    start:new Date(bot.created_at).getTime(),now,operations,prior,observation:state.observation,cyclePolicy:policy});
  if(fills.some(f=>!state.observation.trades.some((t:any)=>t.tradeId===f.trade_id)))throw Error('Full cycle replay omitted retained fills');
  if(checked.reasons.some(r=>r!=='unresolved_operation')||checked.fills.length!==fills.length)throw Error('Cycle account history is incomplete');
  const noLand=Object.fromEntries(events.filter(e=>e.event_key.startsWith('cycle-no-land:')).map(e=>[e.event_key.slice('cycle-no-land:'.length),e.evidence]));
  const terminals=Object.fromEntries(events.filter(e=>e.event_key.startsWith('cycle-terminal:')).map(e=>[e.event_key.slice('cycle-terminal:'.length),e.evidence]));
  const unusedSeedProof=events.find(e=>e.event_key==='cycle-unused-seed')?.evidence as CycleReplayInput['unusedSeedProof'];
  const history=normalizeCycleHistory({policy,account,levels,operations,fills,orders,allocations,observation:state.observation,
    historyComplete:true,now,noLand,terminals,unusedSeedProof});
  return {...history,policy,levels,state,completeUntil:full.completedAt+5000,operationRows:operations};
}

/** All three admission boundaries call this with retained database version selection. */
export async function validateLockedCycleRequest(c:PoolClient,bot:Record<string,any>,r:ExactGridRequest,now:number,candidateId?:string){
  if(bot.policy_version!=='2.0.0'||!['limit','seed','close'].includes(r.kind))return null;
  const history=await readCycleState(c,bot,r.account,now);
  const deadlines=[history.completeUntil,history.state.observation.observedAt+5000,new Date(history.state.reconciled_at).getTime()+5000];
  if(r.kind!=='close'){
    if(r.authority.policyHmac!==bot.policy_hmac||canonicalGridPolicy(r.authority.policy as any)!==canonicalGridPolicy(history.policy))throw Error('Cycle signed policy changed');
    const {durableGridUmk}=await import('./service'),key=await durableGridUmk(bot.wallet_address);
    if(!key)throw Error('Cycle signing authority unavailable');
    try{if(!verifyGridPolicyHmac(history.policy,key.umk,bot.policy_hmac).ok)throw Error('Cycle signed policy invalid');}finally{key.cleanup();}
    const facts=r.authority.facts as any;
    const limits=facts&&validateRetainedGridCycles(history.policy,{...facts,openingFeeRate:facts.maker?.effectiveRate,closingFeeRate:facts.profit?.effectiveRate});
    if(!limits?.ok||facts.observedAt>now||facts.expiresAt<=now||now-facts.observedAt>=5000)throw Error('Cycle current market limits unavailable');
    deadlines.push(facts.observedAt+5000,facts.expiresAt);
    if(r.kind==='limit'){
      const amount=new D(String(r.data.amount));
      if(!amount.gt(0)||!amount.mod(facts.lot).isZero()||!r.data.reduce_only&&amount.mul(String(r.data.price)).lt(facts.minimumQuote))throw Error('Cycle order violates current limits');
    }
    if(r.data.reduce_only===false){
      if(!['provisioning','canary','active'].includes(bot.status)||history.state.blocked_reasons.length
        ||history.state.boot_id!==r.authority.monitorBootId||String(history.state.generation)!==String(r.authority.monitorGeneration))throw Error('Cycle entries are latched off');
      if(r.kind==='limit')deadlines.push(Number((r.authority.cycleRisk as any)?.observedAt)+5000);
      if(r.kind==='limit'&&!gridResumeClearance(r.authority.cycleRisk as any,history.state.observation,history.policy,facts.tick,now))throw Error('Cycle opening requires current liquidation clearance');
    }
  }
  const candidate=candidateId?cycleOperation(history.policy,r.account,history.levels,candidateId,r):undefined;
  if(r.data.reduce_only===false && history.policy.sizingVersion) {
    const capacity=cycleCapacity(history.input,history.state.observation.mark?.price,candidate);
    requireCycleCapacity(capacity);
  }
  if(candidateId){
    const op=cycleOperation(history.policy,r.account,history.levels,candidateId,r);
    const result=validateCycleSourceCredit(history.input,op,cycleRequestAllocations(op,r));
    if(!result.ok)throw Error(result.reason);
  }else if(!history.operationRows.some(op=>op.exact_request_digest===cycleRequestDigest(r)&&['prepared','submitted','unconfirmed','confirmed'].includes(op.state)))throw Error('Cycle send lacks durable reservation');
  return Math.min(...deadlines);
}

/** Release unused seed only after the entire retained attempt set is terminal. Never overwrite a decision. */
export async function recordCycleReplay(c:PoolClient,bot:Record<string,any>,account:string,now:number){
  // Freeze the first complete terminal observation; refreshes cannot move credit issuance into the future.
  const state=(await c.query('SELECT observation FROM grid_monitor_state WHERE bot_id=$1',[bot.id])).rows[0];
  const operations=(await c.query('SELECT * FROM grid_operations WHERE bot_id=$1',[bot.id])).rows;
  const o=state?.observation;
  for(const op of operations){
    if(!['seed','limit','close'].includes(op.exact_request?.kind))continue;
    const venue=o?.orders.find((v:any)=>op.venue_order_id===v.orderId||v.clientOrderId!==null&&op.exact_request.data.client_order_id===v.clientOrderId);
    if(!venue||!['filled','cancelled','rejected'].includes(venue.status)||!o.history||o.history.through<venue.updatedAt)continue;
    await c.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,$2,'internal_cycle_terminal',$3,clock_timestamp()) ON CONFLICT DO NOTHING",
      [bot.id,`cycle-terminal:${op.id}`,{requestDigest:op.exact_request_digest,orderId:venue.orderId,filledSize:venue.filledAmount,terminalAt:venue.updatedAt,historyThrough:o.history.through,observedAt:o.observedAt}]);
  }
  let history=await readCycleState(c,bot,account,now);
  const seed=history.input.operations.filter(o=>o.kind==='seed');
  const seedCompleted=seed.some(seed=>history.operationRows.some(op=>op.id===seed.id&&op.state==='confirmed'));
  if(!history.input.unusedSeedProof&&history.policy.seedAtCreation&&seedCompleted&&['provisioning','canary','active'].includes(bot.status)){
    const proof=history.input.progress.filter(p=>seed.some(o=>o.id===p.operationId));
    if(proof.length===seed.length&&proof.every(p=>p.state==='terminal'&&p.historyThrough!==undefined&&p.terminalAt!==undefined&&p.historyThrough>=p.terminalAt)){
      const release={operationIds:seed.map(o=>o.id),historyThrough:Math.max(...proof.map(p=>p.historyThrough!)),entriesAllowed:true};
      await c.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,'cycle-unused-seed','internal_cycle_seed_release',$2,clock_timestamp()) ON CONFLICT DO NOTHING",[bot.id,release]);
      history=await readCycleState(c,bot,account,now);
    }
  }
  let projectedOrders:ReturnType<typeof projectCycleOrders>|null=null;
  const observation=history.state.observation;
  if(observation.qualification&&observation.mark)try{
    projectedOrders=projectCycleOrders(history.cycles,history.input.progress,history.policy.direction,
      observation.qualification.lotSize,observation.qualification.minOrderSize,observation.mark.price,
      !history.state.blocked_reasons.length&&['provisioning','canary','active'].includes(bot.status),cycleCapacity(history.input,observation.mark.price));
  }catch{/* Display unavailable; the economic replay remains authoritative. */}
  await c.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,'cycle-projection','internal_cycle_projection',$2,clock_timestamp()) ON CONFLICT(bot_id,event_key) DO UPDATE SET evidence=EXCLUDED.evidence,delivered_at=EXCLUDED.delivered_at",
    [bot.id,{generation:String(history.state.generation),observedAt:history.state.observation.observedAt,orders:projectedOrders}]);
  return history;
}

export function cycleCloseAllocations(history:Awaited<ReturnType<typeof readCycleState>>,amount:string){
  let remaining=new D(amount);const allocations:{cycleOrdinal:number;tradeId:string;size:string}[]=[];
  const lots=history.cycles.flatMap(state=>state.availableEntryLots.map(lot=>({...lot,cycleOrdinal:state.cycle.ownerOrdinal,
    time:history.input.fills.find(fill=>fill.tradeId===lot.tradeId)!.time})))
    .sort((a,b)=>a.time-b.time||(a.tradeId<b.tradeId?-1:a.tradeId>b.tradeId?1:0)||a.cycleOrdinal-b.cycleOrdinal);
  for(const lot of lots){const q=D.min(remaining,lot.size);
    if(q.gt(0))allocations.push({cycleOrdinal:lot.cycleOrdinal,tradeId:lot.tradeId,size:q.toFixed()});remaining=remaining.minus(q);}
  if(!remaining.eq(0))throw Error('Stop inventory is still reserved or unknown');return allocations;
}
