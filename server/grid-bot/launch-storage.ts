import type {GridSettlementOutcome} from './execution-failure';
import {createHash,randomUUID} from 'node:crypto';
import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:200});
import type {Pool,PoolClient} from 'pg';
import {requireSchemaCapabilityReady} from '../schema-readiness';
import {gridEntrySafety,freshGridFact,gridUnresolvedStopReduction} from './lifecycle-policy';
import {gridWorkerFence,gridWorkerEntryBlocked} from './worker-ownership';
import {gridRecyclerGate,gridPilotLimit} from './runtime-policy';
import {gridPilotExposure} from './pilot-exposure';
import type {GridObservation} from './reconciliation';
import type {GridEconomicFill} from './pnl';
import {canonicalGridPolicy,type GridPolicy} from './policy-hmac';
import type {GridFirstPlacementContext} from './first-placement';
import {gridAddsExposure,gridMarginAllowed,gridRequiredMargin,readGridMargin,GridMarginDenied,type GridMarginReading} from './margin';
import {gridClaimPlacementBudget} from './slot-budget';
export const canonicalRequest=(x:unknown):string=>JSON.stringify(x,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const requestDigest=(x:unknown)=>createHash('sha256').update(canonicalRequest(x)).digest('hex');
export interface ExactGridRequest {
  kind:'create'|'fund'|'leverage'|'seed'|'limit'|'cancel'|'close'|'sweep'; botId:string; account:string; masterAccount:string;
  path:string; operationType:string; timestamp:number; expiryMs:number; data:Record<string,unknown>;
  authority:Record<string,unknown>;
}
export interface GridClaim {
  credits:string; slots:0|1; canaryIncrement:string; observedCredits:string; availableSlots:number;
  observedAt:number; expiresAt:number;
}
export interface DurableGridOperation {id:string;state:string;exact_request:ExactGridRequest;exact_request_digest:string;failure_classification:string|null}
const typeFor={create:'provision_subaccount',fund:'fund_subaccount',leverage:'set_leverage',seed:'seed_position',limit:'place_level_order',cancel:'cancel_level_order',close:'close_position',sweep:'sweep_subaccount'};
const reduction=(r:ExactGridRequest)=>['cancel','close','sweep'].includes(r.kind)||r.kind==='limit'&&r.data.reduce_only===true;
const liveStates=['provisioning','canary','active','pausing','paused','resuming','reconciling','range_exhausted','stopping'];
function reductionAuthority(r:ExactGridRequest,monitor:any,now:number){
  if(r.kind==='limit'&&r.data.reduce_only===true&&monitor)return monitor.fresh&&freshGridFact(monitor.observation?.observedAt,now)
    &&String(monitor.generation)===String(r.authority.monitorGeneration)&&monitor.observation.account===r.account;
  if(!['close','sweep'].includes(r.kind))return true;
  const o=monitor?.observation,p=o?.position;
  if(!monitor?.fresh||!o.inventoryComplete||!freshGridFact(o.observedAt,now)||o.account!==r.account||!p)return false;
  if(r.kind==='close')return o.symbol===r.data.symbol&&new Decimal(p.size).gt(0)&&new Decimal(String(r.data.amount)).gt(0)
    &&new Decimal(String(r.data.amount)).lte(p.size)&&r.data.reduce_only===true&&r.data.side===(p.direction==='long'?'ask':'bid');
  const proof=r.authority.settlement as any;
  return !monitor.blocked_reasons.length&&new Decimal(p.size).isZero()&&!o.orders.some((x:{status:string})=>['open','partially_filled'].includes(x.status))
    &&r.data.to_account===r.masterAccount&&proof?.account===r.account&&proof.masterAccount===r.masterAccount&&proof.settlementComplete===true
    &&!!proof.source&&freshGridFact(proof.observedAt,now)&&gridRecyclerGate(proof.recycler,now)
    &&new Decimal(proof.balance).gt(0)&&new Decimal(proof.balance).eq(proof.withdrawable)&&new Decimal(proof.balance).eq(String(r.data.amount));
}
export class GridLaunchTransientError extends Error {}
/** Reservations lock master, then bot. The POST fence takes no quota lock. */
export class GridLaunchStorage {
  constructor(private pool:Pool,private ready=()=>requireSchemaCapabilityReady('grid_bot',async(q,v)=>pool.query(q,v?[...v]:undefined)),
    private marginRead?:(r:ExactGridRequest)=>Promise<GridMarginReading|null>){}
  /** All POST kinds share the takeover fence through completion. No async gap after final authority. */
  async sendOwned<T>(r:ExactGridRequest,leaseToken:string,post:()=>Promise<T>):Promise<T>{
    return this.transaction(async c=>{
      if(!await gridWorkerFence(c,r.botId))throw new GridLaunchTransientError('Grid sender fence unavailable');
      let pilotUntil:number|null=null;
      if(gridAddsExposure(r)){
        const bot=(await c.query('SELECT id,clock_timestamp() AS now FROM grid_bots WHERE id=$1 FOR UPDATE',[r.botId])).rows[0];
        if(!bot)throw new GridLaunchTransientError('Grid send ownership unavailable');
        pilotUntil=(await this.pilotGate(c,r.botId,new Date(bot.now).getTime())).validUntil;
      }
      if(!reduction(r)&&await gridWorkerEntryBlocked(c,r.botId))throw new GridLaunchTransientError('Grid send ownership unavailable');
      const owned=(await c.query(`SELECT b.id FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id
         JOIN grid_risk_events e ON e.bot_id=b.id AND e.event_key='worker-ownership'
         LEFT JOIN grid_lifecycle l ON l.bot_id=b.id
         WHERE b.id=$1 AND b.lease_token=$2::uuid AND b.lease_expires_at>clock_timestamp() AND a.released_at IS NULL
         AND a.account=$3 AND a.master_account=$4 AND e.evidence->>'version'='1' AND e.evidence->>'generation'=$2::text
         AND b.status=ANY($5::text[]) AND $6::bigint<=extract(epoch FROM clock_timestamp())*1000
         AND ($6::bigint+$7::bigint)>extract(epoch FROM clock_timestamp())*1000
         AND (l.bot_id IS NULL OR l.epoch::text=$9) AND ($10::boolean=false OR b.status='stopping')
         AND ($11::bigint IS NULL OR $11::bigint>=extract(epoch FROM clock_timestamp())*1000)
         AND EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.state='submitted' AND o.exact_request_digest=$8) FOR UPDATE OF b`,
         [r.botId,leaseToken,r.account,r.masterAccount,reduction(r)?liveStates:['provisioning','canary','active'],r.timestamp,r.expiryMs,requestDigest(r),r.authority.lifecycleEpoch??null,['close','sweep'].includes(r.kind),pilotUntil])).rowCount;
      if(!owned)throw new GridLaunchTransientError('Grid send ownership unavailable');
      return post();
    });
  }
  private async freshMargin(r:ExactGridRequest){
    if(!gridAddsExposure(r))return null;
    if(this.marginRead){try{return await this.marginRead(r);}catch{return null;}}
    const [{GridLaunchReads},{pacificaTransportAuthority}]=await Promise.all([import('./launch-reads'),import('../protocol/pacifica/pacifica-transport')]);
    return readGridMargin(new GridLaunchReads(pacificaTransportAuthority(),this,'0.5'),r);
  }
  /** Caller holds the bot lock. Durable claims, exact fills and the monitor snapshot are
   * read together; neither promotion nor a replacement worker supplies fresh capacity. */
  async pilotExposure(c:PoolClient,botId:string,now:number,snapshot?:{observation:GridObservation;fills:GridEconomicFill[];authoritative:boolean},candidate?:{request:ExactGridRequest;increment:string}){
    const account=(await c.query('SELECT canary_limit,canary_committed FROM grid_launch_accounts WHERE bot_id=$1 AND released_at IS NULL',[botId])).rows[0];
    const limitUsd=account?gridPilotLimit(account.canary_limit):null;
    if(!limitUsd)return {limitUsd:null,exposureUsd:null,reason:'pilot_exposure_reservation_unavailable',validUntil:null};
    const operations=(await c.query(`SELECT o.id,o.state,o.venue_order_id,o.exact_request,c.canary_increment FROM grid_operations o
      LEFT JOIN grid_execution_claims c ON c.operation_id=o.id WHERE o.bot_id=$1`,[botId])).rows;
    const monitor=snapshot?null:(await c.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[botId])).rows[0];
    const fills=snapshot?.fills??(await c.query(`SELECT trade_id AS "tradeId",operation_id AS "operationId",order_id AS "orderId",level_id AS "levelId",
      venue_time AS time,leg,size,price,fee FROM grid_exact_fills WHERE bot_id=$1`,[botId])).rows.map(f=>({...f,time:Number(f.time)}));
    const reconciledAt=monitor?new Date(monitor.reconciled_at).getTime():null;
    const authoritative=snapshot?.authoritative??(!!monitor?.boot_id&&!monitor.blocked_reasons.length&&reconciledAt!==null&&reconciledAt<=now&&now-reconciledAt<=5000);
    const observation=snapshot?.observation??monitor?.observation??null;
    // The final ownership statement also checks the observations have not aged out
    // during these reads. A retained signed reservation without a mark has no deadline.
    const deadlines:number[]=[];
    if(authoritative&&observation){deadlines.push(observation.observedAt+5000);if(reconciledAt!==null)deadlines.push(reconciledAt+5000);}
    if(observation?.mark&&observation.mark.observedAt<=now&&now-observation.mark.observedAt<=5000)deadlines.push(observation.mark.observedAt+5000);
    const validUntil=deadlines.length?Math.min(...deadlines):null;
    const exposure=gridPilotExposure({operations,fills,observation,authoritative,retainedUsd:account.canary_committed,now});
    if(candidate&&exposure.exposureUsd!==null){
      const pending={id:'pending-admission',state:'prepared',venue_order_id:null,exact_request:candidate.request,canary_increment:candidate.increment};
      const extra=gridPilotExposure({operations:[pending],fills:[],observation,authoritative:false,retainedUsd:'0',now});
      if(extra.exposureUsd===null)return {limitUsd,...extra,validUntil};
      const proposed=gridPilotExposure({operations:[...operations,pending],fills,observation,authoritative,retainedUsd:account.canary_committed,now});
      if(proposed.exposureUsd===null)return {limitUsd,...proposed,validUntil};
      // Revalue existing filled risk at the candidate's worst price as well. Retained
      // high-water reservations must also gain the ENTIRE new reservation, not max(old,new).
      exposure.exposureUsd=Decimal.max(proposed.exposureUsd,new Decimal(exposure.exposureUsd).plus(extra.exposureUsd)).toFixed();
    }
    return {limitUsd,...exposure,validUntil};
  }
  private async pilotGate(c:PoolClient,botId:string,now:number,candidate?:{request:ExactGridRequest;increment:string}){
    const exposure=await this.pilotExposure(c,botId,now,undefined,candidate);
    if(exposure.exposureUsd===null||exposure.limitUsd===null)throw new GridLaunchTransientError('Grid pilot exposure is unknown; reconcile before adding risk.');
    if(new Decimal(exposure.exposureUsd).gt(exposure.limitUsd))throw new GridLaunchTransientError('Grid pilot exposure limit exceeded (at most $250 per bot).');
    return {...exposure,exposureUsd:exposure.exposureUsd};
  }
  private async capacityBlocked(c:PoolClient,r:ExactGridRequest){
    return !reduction(r)&&!!(await c.query("SELECT 1 FROM grid_risk_events WHERE bot_id=$1 AND event_key='venue_order_capacity'",[r.botId])).rowCount;
  }
  private async slotBudget(c:PoolClient,r:ExactGridRequest,monitor:any,availableSlots:number,exclude?:string){
    if(monitor&&!monitor.fresh)return 0;
    const retained=(await c.query(`SELECT c.bot_id,c.slots,o.state,o.venue_order_id,o.exact_request FROM grid_execution_claims c
      JOIN grid_operations o ON o.id=c.operation_id WHERE c.account=$1 AND NOT c.slot_released AND c.slots>0
      AND ($2::uuid IS NULL OR c.operation_id<>$2)`,[r.account,exclude??null])).rows;
    return gridClaimPlacementBudget(r.botId,r.account,availableSlots,retained,monitor?.observation??null);
  }
  /** Capacity is a durable entry latch, not a cancel/stop barrier. The existing outbox is unique per bot. */
  private async capacityPause(c:PoolClient,r:ExactGridRequest){
    const monitor=(await c.query("SELECT observation,reconciled_at>clock_timestamp()-interval '5 seconds' AS fresh FROM grid_monitor_state WHERE bot_id=$1",[r.botId])).rows[0];
    const observation=monitor?.fresh&&monitor.observation?.inventoryComplete&&monitor.observation.account===r.account?monitor.observation:null;
    const evidence={classification:'venue_capacity',reason:'OPEN_ORDER_LIMIT_REACHED',venueErrorCode:10,
      account:r.account,requestDigest:requestDigest(r),observedOpenOrders:observation?observation.orders.filter((o:{status:string})=>['open','partially_filled'].includes(o.status)).length:null,
      observedAt:observation?.observedAt??null};
    await c.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,'venue_order_capacity','venue_capacity',$2) ON CONFLICT DO NOTHING",[r.botId,evidence]);
    await c.query("UPDATE grid_bots SET status=CASE WHEN status IN ('provisioning','active','canary','resuming') THEN 'paused' ELSE status END,pause_reason='venue_capacity' WHERE id=$1",[r.botId]);
  }
  /** Caller holds master then bot locks. Pause, cancellation intent and outbox are one commit. */
  private async marginPause(c:PoolClient,bot:any,r:ExactGridRequest,reason:string){
    if(bot.pause_reason==='margin'&&['pausing','paused'].includes(bot.status))return;
    const life=(await c.query('SELECT l.*,r.action,r.state FROM grid_lifecycle l LEFT JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1',[r.botId])).rows[0];
    const key='margin:'+(life?.epoch??0),evidence={classification:'margin',reason,account:r.account,requestDigest:requestDigest(r)};
    await c.query('INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[r.botId,key,'margin_pause',evidence]);
    if(bot.status==='stopping'||life?.action==='stop'&&life.state==='pending')return;
    if(life?.state==='pending'&&life.action!=='pause')await c.query("UPDATE grid_control_requests SET state='superseded',completed_at=clock_timestamp() WHERE id=$1",[life.active_request]);
    if(!(life?.state==='pending'&&life.action==='pause')){
      const id=randomUUID();
      await c.query("INSERT INTO grid_control_requests(id,bot_id,request_key,action,source,previous_status,evidence) VALUES($1,$2,$3,'pause','risk',$4,$5)",[id,r.botId,key,bot.status,evidence]);
      await c.query(`INSERT INTO grid_lifecycle(bot_id,epoch,active_request) VALUES($1,1,$2) ON CONFLICT(bot_id)
        DO UPDATE SET epoch=grid_lifecycle.epoch+1,active_request=EXCLUDED.active_request,blocker=NULL,terminal_proof=NULL`,[r.botId,id]);
      await c.query('INSERT INTO grid_control_keys(bot_id,request_key,control_id,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[r.botId,key,id,evidence]);
    }
    await c.query("UPDATE grid_bots SET status=CASE WHEN status='paused' THEN status ELSE 'pausing' END,pause_reason='margin',canary_clean_since=NULL,canary_clean_ticks=0,updated_at=clock_timestamp() WHERE id=$1",[r.botId]);
    await c.query('UPDATE grid_monitor_state SET boot_id=NULL,generation=generation+1 WHERE bot_id=$1',[r.botId]);
  }
  private async marginGate(c:PoolClient,bot:any,r:ExactGridRequest,reading:GridMarginReading|null,now:number,exclude?:string){
    if(!gridAddsExposure(r))return true;
    let committed='0';
    try{const outstanding=(await c.query("SELECT id,exact_request FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed') AND ($2::uuid IS NULL OR id<>$2)",[r.botId,exclude??null])).rows;
      for(const op of outstanding)if(gridAddsExposure(op.exact_request)){
        if(!reading||op.exact_request.account!==r.account||op.exact_request.data.symbol!==r.data.symbol)throw Error('Unknown commitment');
        committed=new Decimal(committed).plus(gridRequiredMargin(op.exact_request,reading)).toFixed();
      }
      if(gridMarginAllowed(r,reading,committed,now,bot.leverage))return true;
    }catch{/* Unknown committed risk cannot be reused. */}
    await this.marginPause(c,bot,r,reading?'insufficient_or_stale_margin':'margin_unavailable');return false;
  }
  /** Final transport boundary, after book observation and before POST. No optional entry bypass. */
  async finalMargin(r:ExactGridRequest,leaseToken:string):Promise<void>{
    if(!gridAddsExposure(r))return;
    const reading=await this.freshMargin(r);
    const allowed=await this.transaction(async c=>{
      await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[r.masterAccount]);
      const bot=(await c.query('SELECT b.*,a.account,a.master_account,clock_timestamp() AS now FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id WHERE b.id=$1 AND a.released_at IS NULL FOR UPDATE OF b,a',[r.botId])).rows[0];
      const op=(await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND exact_request_digest=$2 AND state='submitted'",[r.botId,requestDigest(r)])).rows[0];
      if(!bot||bot.account!==r.account||bot.master_account!==r.masterAccount||!op)return null;
      const now=new Date(bot.now).getTime();
      if(await gridWorkerEntryBlocked(c,r.botId))return null;
      if(!leaseToken||bot.lease_token!==leaseToken||new Date(bot.lease_expires_at).getTime()<=now||!['provisioning','canary','active'].includes(bot.status)||r.timestamp+ r.expiryMs<=now)return null;
      await this.pilotGate(c,r.botId,now);
      return this.marginGate(c,bot,r,reading,now,op.id);
    });
    if(allowed===null)throw new GridLaunchTransientError('Final Grid submit ownership unavailable');
    if(!allowed)throw new GridMarginDenied('Final Grid margin authority denied exposure');
  }
  async transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{
    await this.ready();const c=await this.pool.connect();
    try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async read(botId:string,key:string):Promise<DurableGridOperation|null>{
    await this.ready();return (await this.pool.query('SELECT * FROM grid_operations WHERE bot_id=$1 AND idempotency_key=$2',[botId,key])).rows[0]??null;
  }
  /** Existing persisted owner confirmation and exact terminal funding; no balance inference or new schema. */
  async firstPlacementContext(r:ExactGridRequest):Promise<GridFirstPlacementContext|null>{
    return this.transaction(async c=>{
      const b=(await c.query(`SELECT b.*,a.account,a.master_account,a.released_at FROM grid_bots b
        JOIN grid_launch_accounts a ON a.bot_id=b.id WHERE b.id=$1`,[r.botId])).rows[0];
      if(!b||b.released_at||!b.created_at||b.account!==r.account||b.master_account!==r.masterAccount||!b.client_request_id||!b.server_intent_digest
        ||!b.policy_hmac||b.policy_hmac!==r.authority.policyHmac||!['provisioning','canary','active'].includes(b.status))return null;
      const levels=(await c.query('SELECT ordinal,price,size,side,reduce_only FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal',[r.botId])).rows;
      const policy:GridPolicy={id:b.id,protocol:b.protocol,market:b.market,direction:b.direction,upperPrice:b.upper_price,lowerPrice:b.lower_price,
        startPrice:b.start_price,gridCount:b.grid_count,totalInvestment:b.total_investment,leverage:b.leverage,entryScaleType:b.entry_scale_type,
        profitScaleType:b.profit_scale_type,policyVersion:b.policy_version,feePolicyVersion:b.fee_policy_version,runtimePolicyVersion:b.runtime_policy_version,
        stopLossPercent:b.stop_loss_percent,stopLossPrice:b.stop_loss_price,seedAtCreation:b.seed_at_creation,
        levels:levels.map(l=>({ordinal:l.ordinal,price:l.price,size:l.size,side:l.side,reduceOnly:l.reduce_only}))};
      if(!canonicalGridPolicy(policy)||canonicalGridPolicy(policy)!==canonicalGridPolicy(r.authority.policy as GridPolicy))return null;
      const ops=(await c.query('SELECT state,exact_request,exact_request_digest,terminal_at,idempotency_key FROM grid_operations WHERE bot_id=$1',[r.botId])).rows;
      const fund=ops.find(o=>o.idempotency_key===`grid:${r.botId}:launch:fund`),f=fund?.exact_request as ExactGridRequest|undefined;
      if(!fund||fund.state!=='confirmed'||!fund.terminal_at||!f||requestDigest(f)!==fund.exact_request_digest||f.kind!=='fund'
        ||f.account!==r.account||f.masterAccount!==r.masterAccount||f.data.to_account!==r.account||f.data.amount!==policy.totalInvestment
        ||f.authority.policyHmac!==b.policy_hmac||f.path!=='/account/subaccount/transfer'||f.operationType!=='transfer_funds')return null;
      let alreadyPlaced=false;
      for(const op of ops){
        const q=op.exact_request as ExactGridRequest;
        if(!q||requestDigest(q)!==op.exact_request_digest)return null;
        if(['prepared','submitted','unconfirmed'].includes(op.state)&&op.exact_request_digest!==requestDigest(r))return null;
        // Seed and first resting entry each consume their own post-funding price proof.
        if(op.state==='confirmed'&&q.kind===r.kind&&q.account===r.account&&q.masterAccount===r.masterAccount
          &&q.data.symbol===r.data.symbol&&q.data.reduce_only===false)alreadyPlaced=true;
      }
      const confirmedAt=new Date(b.created_at).getTime(),fundedAt=new Date(fund.terminal_at).getTime();
      return Number.isSafeInteger(confirmedAt)&&Number.isSafeInteger(fundedAt)?{policy,confirmedAt,fundedAt,alreadyPlaced}:null;
    });
  }
  /** Read traffic shares the same master's serialized budget. Failed reads still consume their credit. */
  async claimRead(masterAccount:string,credits='1',observedCredits='300',share='0.5'){
    if(!masterAccount||!new Decimal(credits).gt(0)||!new Decimal(share).gt(0)||new Decimal(share).gt(1))throw Error('Invalid Grid read claim');
    return this.transaction(async c=>{
      await c.query('INSERT INTO grid_master_quota(master_account,share) VALUES($1,$2) ON CONFLICT DO NOTHING',[masterAccount,share]);
      const q=(await c.query('SELECT share,backoff_until>clock_timestamp() AS blocked FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[masterAccount])).rows[0];
      if(!new Decimal(q.share).eq(share))throw Error('Grid master read authority unavailable');
      if(q.blocked)throw new GridLaunchTransientError('Grid master read authority unavailable during backoff');
      const used=(await c.query(`SELECT (SELECT COALESCE(sum(credits),0) FROM grid_read_claims WHERE master_account=$1 AND claimed_at>clock_timestamp()-interval '60 seconds')
        +(SELECT COALESCE(sum(credits),0) FROM grid_execution_claims WHERE master_account=$1 AND (settled_at IS NULL OR settled_at>clock_timestamp()-interval '60 seconds')) AS used`,[masterAccount])).rows[0].used;
      if(new Decimal(used).plus(credits).gt(Decimal.min(300,observedCredits).mul(q.share).floor()))throw new GridLaunchTransientError('Grid fixed quota share exhausted');
      const id=randomUUID();await c.query('INSERT INTO grid_read_claims(id,master_account,credits) VALUES($1,$2,$3)',[id,masterAccount,credits]);return id;
    });
  }
  async recordRateLimit(masterAccount:string){await this.transaction(async c=>{await c.query("UPDATE grid_master_quota SET backoff_until=GREATEST(backoff_until,clock_timestamp()+interval '60 seconds') WHERE master_account=$1",[masterAccount]);});}
  async availableCredits(masterAccount:string,observedCredits='300'):Promise<string>{
    await this.ready();const q=(await this.pool.query(`SELECT share,backoff_until>clock_timestamp() AS blocked,
      (SELECT COALESCE(sum(credits),0) FROM grid_execution_claims WHERE master_account=$1 AND (settled_at IS NULL OR settled_at>clock_timestamp()-interval '60 seconds'))
      +(SELECT COALESCE(sum(credits),0) FROM grid_read_claims WHERE master_account=$1 AND claimed_at>clock_timestamp()-interval '60 seconds') AS used
      FROM grid_master_quota WHERE master_account=$1`,[masterAccount])).rows[0];
    return !q||q.blocked?'0':Decimal.max(0,Decimal.min(300,observedCredits).mul(q.share).floor().minus(q.used)).toFixed();
  }
  /** Only a never-submitted expired request may be abandoned. It cannot be silently refreshed. */
  async expirePrepared(op:DurableGridOperation,leaseToken:string):Promise<boolean>{
    return this.transaction(async c=>{
      await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[op.exact_request.masterAccount]);
      const r=await c.query(`UPDATE grid_operations o SET state='failed',failure_classification='policy',terminal_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM grid_bots b WHERE o.id=$1 AND o.bot_id=b.id AND o.state='prepared' AND o.submitted_at IS NULL AND o.exact_request_digest=$2 AND b.lease_token=$3
        AND b.lease_expires_at>clock_timestamp() AND ($4::bigint+$5::bigint)<=extract(epoch from clock_timestamp())*1000 RETURNING o.id`,
        [op.id,op.exact_request_digest,leaseToken,op.exact_request.timestamp,op.exact_request.expiryMs]);
      if(r.rowCount){
        const claim=(await c.query('UPDATE grid_execution_claims SET settled_at=clock_timestamp(),slot_released=true WHERE operation_id=$1 RETURNING canary_increment',[op.id])).rows[0];
        if(claim)await c.query('UPDATE grid_launch_accounts SET canary_committed=GREATEST(0,canary_committed-$2) WHERE bot_id=$1',[op.exact_request.botId,claim.canary_increment]);
        if(op.exact_request.kind==='limit')await c.query(`UPDATE grid_levels SET status='pending',client_order_uuid=NULL,venue_order_id=NULL,placement_attempt=placement_attempt+1
          WHERE id=$1 AND bot_id=$2 AND status='submitting' AND client_order_uuid=$3`,[op.exact_request.authority.levelId,op.exact_request.botId,op.exact_request.data.client_order_id]);
        if(op.exact_request.kind==='cancel')await c.query(`UPDATE grid_levels SET status=CASE WHEN cumulative_filled_size>0 THEN 'partially_filled' ELSE 'active' END
          WHERE id=$1 AND bot_id=$2 AND status='cancelling'`,[op.exact_request.authority.levelId,op.exact_request.botId]);
        await c.query('UPDATE grid_profit_allocations SET released_at=clock_timestamp(),released_size=size WHERE operation_id=$1 AND released_at IS NULL',[op.id]);
      }
      return !!r.rowCount;
    });
  }
  async prepare(key:string,request:ExactGridRequest,claim:GridClaim,leaseToken:string):Promise<DurableGridOperation>{
    const margin=await this.freshMargin(request);
    const exact=JSON.parse(canonicalRequest(request)) as ExactGridRequest,digest=requestDigest(exact);
    if(!request.botId || !request.account || !request.masterAccount || !Number.isSafeInteger(request.timestamp)
      || !Number.isSafeInteger(request.expiryMs) || request.expiryMs<1 || request.expiryMs>15000
      || !new Decimal(claim.credits).gte(10) || !new Decimal(claim.canaryIncrement).gte(0)
      || !Number.isSafeInteger(claim.availableSlots) || ![0,1].includes(claim.slots))throw Error('Invalid exact claim');
    if(claim.slots!==(request.kind==='limit'?1:0))throw Error('Invalid resting slot claim');
    const minimumRisk=request.kind==='limit'&&request.data.reduce_only===false?new Decimal(String(request.data.price)).mul(String(request.data.amount))
      :request.kind==='seed'?new Decimal(String(request.authority.seedWorstPrice)).mul(String(request.data.amount)):new Decimal(0);
    if(new Decimal(claim.canaryIncrement).lt(minimumRisk))throw Error('Understated canary commitment');
    if(!gridAddsExposure(request)&&!new Decimal(claim.canaryIncrement).isZero())throw Error('Only entries reserve pilot exposure');
    const prepared=await this.transaction(async c=>{
      const master=(await c.query('SELECT *,clock_timestamp() AS clock FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[request.masterAccount])).rows[0];
      if(!master)throw Error('Master quota unavailable');const now=new Date(master.clock).getTime();
      const bot=(await c.query('SELECT b.*,a.account,a.master_account,a.canary_limit,a.canary_committed,a.released_at FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id WHERE b.id=$1 FOR UPDATE OF b,a',[request.botId])).rows[0];
      if(!bot || bot.released_at || bot.account!==request.account || bot.master_account!==request.masterAccount || bot.lease_token!==leaseToken
        || new Date(bot.lease_expires_at).getTime()<=now || !(reduction(request)?liveStates:['provisioning','canary','active']).includes(bot.status))throw Error('Lost Grid ownership');
      if(!reduction(request)&&await gridWorkerEntryBlocked(c,request.botId))throw new GridLaunchTransientError('Grid ownership recovery requires reconciliation');
      const lifecycle=(await c.query('SELECT * FROM grid_lifecycle WHERE bot_id=$1',[request.botId])).rows[0];
      if(lifecycle&&String(lifecycle.epoch)!==String(request.authority.lifecycleEpoch))throw Error('Grid lifecycle changed');
      if(['close','sweep'].includes(request.kind)&&bot.status!=='stopping')throw Error('Stop intent required');
      const old=(await c.query('SELECT * FROM grid_operations WHERE idempotency_key=$1',[key])).rows[0];
      if(old){if(old.bot_id!==request.botId || old.exact_request_digest!==digest || canonicalRequest(old.exact_request)!==canonicalRequest(exact))throw Error('Exact request conflict');return old;}
      if(await this.capacityBlocked(c,request))throw new GridLaunchTransientError('Durable Grid venue-capacity pause');
      if(!await this.marginGate(c,bot,request,margin,now))return null;
      const monitor=(await c.query('SELECT *,reconciled_at>clock_timestamp()-interval \'5 seconds\' AS fresh FROM grid_monitor_state WHERE bot_id=$1',[request.botId])).rows[0];
      if(monitor&&['limit','seed'].includes(request.kind)&&!reduction(request)){
        if(!monitor.fresh||monitor.boot_id!==request.authority.monitorBootId||String(monitor.generation)!==String(request.authority.monitorGeneration)
          ||!monitor.boot_id||monitor.blocked_reasons.length)throw Error('Grid restart or reconciliation barrier');
        if(!gridEntrySafety({sol:bot.sol_balance,solObservedAt:bot.sol_balance_observed_at?new Date(bot.sol_balance_observed_at).getTime():null,failures:bot.consecutive_failures,mark:monitor.observation?.mark??null},now).allowed)throw Error('Grid entry risk gate');
      }
      if(request.kind==='close'){
        const p=monitor?.observation?.position;
        if(!monitor?.fresh||!p||monitor.observation.account!==request.account||monitor.observation.symbol!==request.data.symbol||!new Decimal(p.size).gt(0)
          ||new Decimal(String(request.data.amount)).gt(p.size)||request.data.reduce_only!==true||request.data.side!==(p.direction==='long'?'ask':'bid'))throw Error('Close position authority unavailable');
      }
      if(request.kind==='sweep'&&(!monitor?.fresh||monitor.blocked_reasons.length||monitor.observation?.position?.size==null
        ||!new Decimal(monitor.observation.position.size).isZero()||request.data.to_account!==request.masterAccount||request.authority.settlementComplete!==true))throw Error('Sweep settlement authority unavailable');
      if(!reductionAuthority(request,monitor,now))throw Error('Grid reduction authority unavailable');
      const unresolved=(await c.query("SELECT * FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[request.botId])).rows;
      if(unresolved.length&&!(['close','cancel'].includes(request.kind)&&bot.status==='stopping'
        &&lifecycle?.active_request===request.authority.controlRequestId
        &&(await c.query("SELECT id FROM grid_control_requests WHERE id=$1 AND bot_id=$2 AND action='stop' AND state='pending'",[lifecycle.active_request,request.botId])).rowCount
        &&unresolved.every(op=>gridUnresolvedStopReduction(op,request,now))))throw Error('Unresolved operation barrier');
      if(!Number.isSafeInteger(claim.observedAt) || !Number.isSafeInteger(claim.expiresAt) || claim.observedAt>now || claim.expiresAt<=now
        || claim.expiresAt-claim.observedAt>5000 || request.timestamp>now || request.timestamp+request.expiryMs<=now)throw Error('Stale admission');
      if(new Date(master.backoff_until).getTime()>now)throw new GridLaunchTransientError('Durable Grid rate-limit backoff');
      const quota=(await c.query(`SELECT (SELECT COALESCE(sum(credits),0) FROM grid_execution_claims
        WHERE master_account=$1 AND (settled_at IS NULL OR settled_at>clock_timestamp()-interval '60 seconds'))
        +(SELECT COALESCE(sum(credits),0) FROM grid_read_claims WHERE master_account=$1 AND claimed_at>clock_timestamp()-interval '60 seconds') AS used`,[request.masterAccount])).rows[0];
      // Unknown observed tier uses the owner-assumed 300; observations may only reduce that conservative floor.
      const ceiling=Decimal.min(300,claim.observedCredits).mul(master.share).floor();
      if(!ceiling.gt(0) || new Decimal(quota.used).plus(claim.credits).gt(ceiling))throw new GridLaunchTransientError('Grid fixed quota share exhausted');
      if(claim.slots && await this.slotBudget(c,request,monitor,claim.availableSlots)<claim.slots)throw Error('Grid subaccount slots unavailable');
      const committed=gridAddsExposure(request)?(await this.pilotGate(c,request.botId,now,{request,increment:claim.canaryIncrement})).exposureUsd:null;
      const id=randomUUID();
      const levelId=request.authority.levelId??null;
      if(request.kind==='cancel'){
        const original=request.authority.originalRequest as ExactGridRequest|undefined;
        if(!original||original.kind!=='limit'||original.botId!==request.botId||original.account!==request.account||original.data.symbol!==request.data.symbol
          ||!(await c.query('SELECT id FROM grid_operations WHERE bot_id=$1 AND exact_request_digest=$2 AND venue_order_id=$3 AND level_id=$4',[request.botId,requestDigest(original),String(request.data.order_id),levelId])).rowCount)throw Error('Cancel ownership unavailable');
      }
      if(request.kind==='limit'||request.kind==='cancel'){
        const level=(await c.query('SELECT * FROM grid_levels WHERE id=$1 AND bot_id=$2 FOR UPDATE',[levelId,request.botId])).rows[0];
        if(!level)throw Error('Grid level ownership unavailable');
        const profit=!!monitor&&request.data.reduce_only===true;
        const previous=(await c.query(`SELECT p.remaining,p.status FROM grid_monitor_orders p JOIN grid_operations o ON o.id=p.operation_id
          WHERE o.bot_id=$1 AND o.level_id=$2 AND o.exact_request->'data'->>'reduce_only'='false' ORDER BY o.created_at DESC,o.id DESC LIMIT 1`,[request.botId,levelId])).rows[0];
        const entrySize=monitor&&level.status==='cancelled'&&previous?.status==='cancelled'?previous.remaining:level.size;
        if(request.kind==='limit'&&(!(profit?['pending','cancelled','filled']:['pending','cancelled']).includes(level.status)||level.placement_attempt!==request.authority.levelAttempt
          || !new Decimal(level.price).eq(String(request.data.price))||!(profit?new Decimal(request.data.amount as string).gt(0):new Decimal(entrySize).eq(String(request.data.amount)))
          ||(!profit&&(level.reduce_only!==request.data.reduce_only||(level.side==='buy'?'bid':'ask')!==request.data.side))
          ||(profit&&request.data.side!==(bot.direction==='long'?'ask':'bid'))))throw Error('Grid signed level changed');
        if(request.kind==='cancel'&&(!['active','partially_filled'].includes(level.status)||level.venue_order_id!==String(request.data.order_id)))throw Error('Grid cancel identity changed');
        await c.query('UPDATE grid_levels SET status=$2,client_order_uuid=COALESCE($3,client_order_uuid),updated_at=clock_timestamp() WHERE id=$1',[levelId,request.kind==='limit'?'submitting':'cancelling',request.data.client_order_id??null]);
      }
      const result=await c.query(`INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type,client_order_uuid,exact_request,exact_request_digest,level_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,request.botId,key,digest,typeFor[request.kind],request.data.client_order_id??null,exact,digest,levelId]);
      if(monitor&&request.kind==='limit'&&request.data.reduce_only===true){
        const allocations=request.authority.fillAllocations as {tradeId:string;size:string}[];
        if(!Array.isArray(allocations)||!allocations.length||new Set(allocations.map(a=>a.tradeId)).size!==allocations.length)throw Error('Missing actual fill backing');
        let total=new Decimal(0);
        for(const a of allocations){if(typeof a.size!=='string'||!new Decimal(a.size).gt(0))throw Error('Invalid fill allocation');
          const fill=(await c.query(`SELECT f.size,f.level_id,l.ordinal,COALESCE((SELECT sum(a.size-a.released_size) FROM grid_profit_allocations a WHERE a.account=f.account AND a.trade_id=f.trade_id AND a.released_at IS NULL),0) AS reserved
            FROM grid_exact_fills f LEFT JOIN grid_levels l ON l.id=f.level_id WHERE f.account=$1 AND f.trade_id=$2 AND f.bot_id=$3 AND f.leg='entry' FOR UPDATE OF f`,[request.account,a.tradeId,request.botId])).rows[0];
          if(!fill||new Decimal(fill.reserved).plus(a.size).gt(fill.size))throw Error('Fill backing already reserved');total=total.plus(a.size);
          const target=(await c.query('SELECT ordinal,reduce_only FROM grid_levels WHERE id=$1 AND bot_id=$2',[levelId,request.botId])).rows[0];
          if(!target||(fill.level_id?target.ordinal!==fill.ordinal+(bot.direction==='long'?1:-1):!target.reduce_only))throw Error('Profit must pair with its adjacent entry or seed');
          await c.query('INSERT INTO grid_profit_allocations(operation_id,account,trade_id,size) VALUES($1,$2,$3,$4)',[id,request.account,a.tradeId,a.size]);
        }
        if(!total.eq(String(request.data.amount)))throw Error('Allocation size mismatch');
        const backing=monitor.observation?.position?.size;
        const outstanding=(await c.query(`SELECT COALESCE(sum(GREATEST(0,(o.exact_request->'data'->>'amount')::numeric-
          COALESCE((SELECT sum(f.size) FROM grid_exact_fills f WHERE f.operation_id=o.id),0))),0) AS reserved FROM grid_operations o
          LEFT JOIN grid_monitor_orders p ON p.operation_id=o.id WHERE o.bot_id=$1 AND o.exact_request->'data'->>'reduce_only'='true'
          AND o.state IN ('prepared','submitted','unconfirmed','confirmed') AND (p.status IS NULL OR p.status IN ('open','partially_filled'))`,[request.botId])).rows[0].reserved;
        if(backing==null||new Decimal(outstanding).gt(backing))throw Error('Exit position backing unavailable');
      }
      await c.query('INSERT INTO grid_execution_claims(operation_id,bot_id,master_account,account,credits,slots,canary_increment) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,request.botId,request.masterAccount,request.account,claim.credits,claim.slots,claim.canaryIncrement]);
      if(committed!==null)await c.query('UPDATE grid_launch_accounts SET canary_committed=$2 WHERE bot_id=$1',[request.botId,committed]);
      return result.rows[0];
    });
    if(!prepared)throw new GridLaunchTransientError('Durable Grid margin pause');return prepared;
  }
  async submit(op:DurableGridOperation,leaseToken:string):Promise<boolean>{
    if(requestDigest(op.exact_request)!==op.exact_request_digest)return false;
    const margin=await this.freshMargin(op.exact_request);
    return this.transaction(async c=>{
      const q=(await c.query('SELECT backoff_until>clock_timestamp() AS blocked FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[op.exact_request.masterAccount])).rows[0];
      if(!q||q.blocked)return false;
      const bot=(await c.query('SELECT *,clock_timestamp() AS now FROM grid_bots WHERE id=$1 FOR UPDATE',[op.exact_request.botId])).rows[0];
      if(!bot)return false;
      if(!reduction(op.exact_request)&&await gridWorkerEntryBlocked(c,op.exact_request.botId))return false;
      const account=(await c.query('SELECT account,master_account FROM grid_launch_accounts WHERE bot_id=$1 AND released_at IS NULL',[op.exact_request.botId])).rows[0];
      if(!account||account.account!==op.exact_request.account||account.master_account!==op.exact_request.masterAccount)return false;
      if(await this.capacityBlocked(c,op.exact_request))return false;
      if(!await this.marginGate(c,bot,op.exact_request,margin,new Date(bot.now).getTime(),op.id))return false;
      const monitor=(await c.query('SELECT *,reconciled_at>clock_timestamp()-interval \'5 seconds\' AS fresh FROM grid_monitor_state WHERE bot_id=$1',[op.exact_request.botId])).rows[0];
      const claim=(await c.query('SELECT slots FROM grid_execution_claims WHERE operation_id=$1',[op.id])).rows[0];
      if(claim?.slots && monitor && await this.slotBudget(c,op.exact_request,monitor,0,op.id)<claim.slots)return false;
      if(monitor&&['limit','seed'].includes(op.exact_request.kind)&&!reduction(op.exact_request)&&(!monitor.fresh||!monitor.boot_id||monitor.blocked_reasons.length
        ||monitor.boot_id!==op.exact_request.authority.monitorBootId||String(monitor.generation)!==String(op.exact_request.authority.monitorGeneration)))return false;
      const lifecycle=(await c.query('SELECT * FROM grid_lifecycle WHERE bot_id=$1',[op.exact_request.botId])).rows[0];
      if(lifecycle&&String(lifecycle.epoch)!==String(op.exact_request.authority.lifecycleEpoch))return false;
      if(!reduction(op.exact_request)&&!['provisioning','canary','active'].includes(bot.status))return false;
      if(['close','sweep'].includes(op.exact_request.kind)&&bot.status!=='stopping')return false;
      if(!reductionAuthority(op.exact_request,monitor,new Date(bot.now).getTime()))return false;
      if(gridAddsExposure(op.exact_request))await this.pilotGate(c,op.exact_request.botId,new Date(bot.now).getTime());
      if(monitor&&!reduction(op.exact_request)&&['limit','seed'].includes(op.exact_request.kind)
        &&!gridEntrySafety({sol:bot.sol_balance,solObservedAt:bot.sol_balance_observed_at?new Date(bot.sol_balance_observed_at).getTime():null,failures:bot.consecutive_failures,mark:monitor.observation?.mark??null},new Date(bot.now).getTime()).allowed)return false;
      // The CAS makes a crash before POST uncertain. A new worker never adopts permission to resend.
      const r=await c.query(`UPDATE grid_operations o SET state='submitted',submitted_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM grid_bots b WHERE o.id=$1 AND o.bot_id=b.id AND o.state='prepared' AND o.exact_request_digest=$2
        AND b.lease_token=$3 AND b.lease_expires_at>clock_timestamp() AND b.status IN ('provisioning','canary','active','pausing','paused','resuming','reconciling','range_exhausted','stopping')
        AND ($4::bigint+$5::bigint)>extract(epoch from clock_timestamp())*1000 RETURNING o.id`,
      [op.id,op.exact_request_digest,leaseToken,op.exact_request.timestamp,op.exact_request.expiryMs]);return !!r.rowCount;
    });
  }
  async settle(op:DurableGridOperation,outcome:GridSettlementOutcome,leaseToken?:string){
    const qualifying=outcome.state==='failed'&&['authentication','quota','transport'].includes(outcome.reason??'');
    if(qualifying&&(!outcome.terminalFailure||outcome.terminalFailure.requestDigest!==op.exact_request_digest||outcome.terminalFailure.classification!==outcome.reason))throw Error('Grid terminal failure authority unavailable');
    return this.transaction(async c=>{
      await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[op.exact_request.masterAccount]);
      if(leaseToken&&!(await c.query('SELECT id FROM grid_bots WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE',[op.exact_request.botId,leaseToken])).rowCount)throw Error('Grid recovery ownership lost');
      const r=await c.query(`UPDATE grid_operations SET state=$2,failure_classification=$3,terminal_at=CASE WHEN $2='unconfirmed' THEN NULL ELSE clock_timestamp() END,
        updated_at=clock_timestamp() WHERE id=$1 AND state IN ('submitted','unconfirmed') AND exact_request_digest=$4 RETURNING id`,[op.id,outcome.state,outcome.reason,op.exact_request_digest]);
      if(!r.rowCount)throw Error('Settlement CAS conflict');
      if(outcome.state==='failed'&&outcome.reason==='venue_rejection'&&outcome.capacityRejected)await this.capacityPause(c,op.exact_request);
      if(outcome.state==='failed'&&outcome.reason==='margin'){
        const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 FOR UPDATE',[op.exact_request.botId])).rows[0];
        await this.marginPause(c,bot,op.exact_request,'venue_insufficient_margin');
      }
      // Only terminal venue results alter the breaker; an uncertain HTTP send is not counted repeatedly.
      if(qualifying){
        await c.query("UPDATE grid_bots SET canary_clean_since=NULL,canary_clean_ticks=0,consecutive_failures=consecutive_failures+1,status=CASE WHEN consecutive_failures+1>=5 AND status IN ('provisioning','active','canary','resuming') THEN 'pausing' ELSE status END,pause_reason=CASE WHEN consecutive_failures+1>=5 THEN 'circuit_breaker' ELSE pause_reason END WHERE id=$1",[op.exact_request.botId]);
        await c.query("UPDATE grid_risk_events SET evidence=jsonb_set(evidence,'{clock}', 'null'::jsonb) WHERE bot_id=$1 AND event_key='canary-clock'",[op.exact_request.botId]);
      }
      if(outcome.state==='failed'&&!outcome.capacityRejected&&['venue_rejection','policy','invariant'].includes(outcome.reason??''))await c.query("UPDATE grid_bots SET status=CASE WHEN status IN ('provisioning','active','canary','resuming') THEN 'pausing' ELSE status END,pause_reason=$2 WHERE id=$1",[op.exact_request.botId,outcome.reason]);
      if(outcome.state==='failed'&&outcome.reason==='expected_rejection')await c.query('UPDATE grid_profit_allocations SET released_at=clock_timestamp(),released_size=size WHERE operation_id=$1 AND released_at IS NULL',[op.id]);
      if(outcome.state!=='unconfirmed')await c.query('UPDATE grid_execution_claims SET settled_at=clock_timestamp(),slot_released=$2 WHERE operation_id=$1',[op.id,outcome.releaseSlot]);
      if(outcome.orderId)await c.query('UPDATE grid_operations SET venue_order_id=$2 WHERE id=$1',[op.id,outcome.orderId]);
      if(outcome.state==='confirmed'&&gridAddsExposure(op.exact_request))await c.query('UPDATE grid_bots SET canary_started_at=COALESCE(canary_started_at,clock_timestamp()) WHERE id=$1',[op.exact_request.botId]);
      if(op.exact_request.kind==='limit'&&outcome.state!=='unconfirmed'){
        const status=outcome.reason==='expected_rejection'?'pending':outcome.state==='failed'?'failed':outcome.orderStatus==='cancelled'?'cancelled':outcome.releaseSlot?'filled':'active';
        await c.query('UPDATE grid_levels SET status=$2,venue_order_id=$3,placement_attempt=placement_attempt+CASE WHEN $4 THEN 1 ELSE 0 END,updated_at=clock_timestamp() WHERE id=$1 AND bot_id=$5',
          [op.exact_request.authority.levelId,status,outcome.orderId??null,outcome.reason==='expected_rejection'||outcome.orderStatus==='cancelled',op.exact_request.botId]);
      }
      if(op.exact_request.kind==='cancel'&&outcome.state==='confirmed'){
        await c.query("UPDATE grid_levels SET status=$4,placement_attempt=placement_attempt+1,updated_at=clock_timestamp() WHERE id=$1 AND bot_id=$2 AND venue_order_id=$3 AND status IN ('active','partially_filled','cancelling')",[op.exact_request.authority.levelId,op.exact_request.botId,String(op.exact_request.data.order_id),outcome.orderStatus==='filled'?'filled':'cancelled']);
        await c.query(`UPDATE grid_execution_claims c SET slot_released=true FROM grid_operations o WHERE c.operation_id=o.id AND o.bot_id=$1 AND o.venue_order_id=$2`,[op.exact_request.botId,String(op.exact_request.data.order_id)]);
      }
      if(outcome.rateLimited)await c.query("UPDATE grid_master_quota SET backoff_until=GREATEST(backoff_until,clock_timestamp()+interval '60 seconds') WHERE master_account=$1",[op.exact_request.masterAccount]);
    });
  }
  async markCanary(account:{botId:string;leaseToken:string}){
    return this.transaction(async c=>{
      const r=await c.query(`UPDATE grid_bots b SET status='canary',updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() AND status IN ('provisioning','canary')
        AND NOT EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.state IN ('prepared','submitted','unconfirmed'))
        AND EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.type='fund_subaccount' AND o.state='confirmed')
        AND EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.type='set_leverage' AND o.state='confirmed')
        AND (NOT seed_at_creation OR EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.type='seed_position' AND o.state='confirmed')) RETURNING id`,[account.botId,account.leaseToken]);
      if(!r.rowCount)throw Error('Grid launch has unresolved venue state');
    });
  }
}
