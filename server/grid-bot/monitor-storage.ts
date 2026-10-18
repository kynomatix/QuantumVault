import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import {readCycleState,recordCycleReplay} from './cycle-storage';
import {retainedGridPolicy} from './retained-policy';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {GridLaunchStorage,canonicalRequest,requestDigest,gridOperationProjection,type DurableGridOperation} from './launch-storage';
import {reconcileGridObservation,type GridObservation,type ReconciliationOperation} from './reconciliation';
import {validGridEmptyProof,type GridAccount,type GridEmptyProof} from './custody';
import type {GridEconomicFill} from './pnl';
import Decimal from 'decimal.js';
import {advanceGridCanary,gridCanaryPolicyCurrent,type GridCanaryClock} from './canary-clock';
import {GRID_HISTORY_PUBLICATION_LAG_MS} from './history-safety';
import {gridWorkerFence,recordGridWorker} from './worker-ownership';
import {isGridPilotExposureBlockReason} from './pilot-exposure';
const D=Decimal.clone({precision:200});
const states=['provisioning','canary','active','pausing','paused','resuming','reconciling','range_exhausted','stopping'];
export interface GridMonitorClaim {id:string;leaseToken:string;account:string;masterAccount:string}
const fillsFromRows=(rows:Record<string,any>[]):GridEconomicFill[]=>rows.map(r=>({tradeId:r.trade_id,operationId:r.operation_id,orderId:r.order_id,levelId:r.level_id,time:Number(r.venue_time),leg:r.leg,size:r.size,price:r.price,fee:r.fee}));
export class GridMonitorStorage {
  constructor(readonly launch:GridLaunchStorage){}
  /** Expiry nominates a generation; the send fence retires it. Unregistered legacy owners stay blocked. */
  async claim(exclude:string[]=[]):Promise<GridMonitorClaim|null>{return this.launch.transaction(async c=>{
    const rows=(await c.query(`SELECT b.id,b.lease_token,a.account,a.master_account FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id
      WHERE b.status=ANY($1::text[]) AND a.released_at IS NULL AND NOT(b.id=ANY($2::uuid[]))
      AND (b.lease_token IS NULL OR (b.lease_expires_at<=clock_timestamp() AND EXISTS
        (SELECT 1 FROM grid_risk_events e WHERE e.bot_id=b.id AND e.event_key='worker-ownership'
          AND e.evidence->>'version'='1' AND e.evidence->>'generation'=b.lease_token::text)))
      AND (b.last_tick_at IS NULL OR b.last_tick_at<=clock_timestamp()-interval '15 seconds')
      ORDER BY b.last_tick_at NULLS FIRST,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 2`,[states,exclude])).rows;
    for(const row of rows){
      if(!await gridWorkerFence(c,row.id))continue;
      // Even a disconnected sender cannot leave a still-valid signed request behind at takeover.
      const operations=(await c.query("SELECT exact_request FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[row.id])).rows;
      const now=Number((await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);
      if(operations.some(({exact_request:r})=>!r||!Number.isSafeInteger(r.timestamp)||!Number.isSafeInteger(r.expiryMs)
        ||r.expiryMs<1||r.expiryMs>15000||r.timestamp+r.expiryMs>now))continue;
      const token=randomUUID();
      if(row.lease_token)await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at)
        VALUES($1,$2,'internal_worker_retirement',$3,clock_timestamp())`,[row.id,'worker-retired:'+row.lease_token,
        {version:1,retiredGeneration:row.lease_token,replacementGeneration:token,retiredAt:now,fence:'exclusive_postgres_sender_lock',signedWindowsExpired:true}]);
      await c.query("UPDATE grid_bots SET lease_token=$2,lease_expires_at=clock_timestamp()+interval '120 seconds',startup_reconciled_at=NULL WHERE id=$1",[row.id,token]);
      await recordGridWorker(c,row.id,token,true);
      await c.query(`INSERT INTO grid_monitor_state(bot_id,blocked_reasons) VALUES($1,'["ownership_recovery_reconciliation_required"]')
        ON CONFLICT(bot_id) DO UPDATE SET boot_id=NULL,pnl=NULL,generation=grid_monitor_state.generation+1,
        blocked_reasons=EXCLUDED.blocked_reasons`,[row.id]);
      return {id:row.id,leaseToken:token,account:row.account,masterAccount:row.master_account};
    }
    return null;
  });}
  async assertLease(c:PoolClient,claim:GridMonitorClaim){const bot=(await c.query(`SELECT b.*,a.account,a.master_account,clock_timestamp() AS db_now
    FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id WHERE b.id=$1 AND b.lease_token=$2
    AND b.lease_expires_at>clock_timestamp() AND a.released_at IS NULL AND b.status=ANY($3::text[]) FOR UPDATE OF b`,[claim.id,claim.leaseToken,states])).rows[0];
    if(!bot||bot.account!==claim.account||bot.master_account!==claim.masterAccount)throw Error('Grid ownership uncertain');return bot;
  }
  async release(claim:GridMonitorClaim){await this.launch.transaction(async c=>{if(!await gridWorkerFence(c,claim.id))throw Error('Grid sender still active');await c.query(`UPDATE grid_bots SET lease_token=NULL,lease_expires_at=NULL,last_tick_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2`,[claim.id,claim.leaseToken]);});}
  async snapshot(claim:GridMonitorClaim){return this.launch.transaction(async c=>{const bot=await this.assertLease(c,claim);
    const operations=(await c.query(`SELECT ${gridOperationProjection} FROM grid_operations o WHERE bot_id=$1 ORDER BY created_at,id`,[claim.id])).rows as ReconciliationOperation[];
    return {bot,operations,levels:(await c.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal',[claim.id])).rows};
  });}
  /** Durable, deduplicated owner notification. Uncertainty cannot disable a Stop already in progress. */
  async transferUnknown(claim:GridMonitorClaim,op:DurableGridOperation){return this.launch.transaction(async c=>{
    const bot=await this.assertLease(c,claim),r=op.exact_request;
    if(!['fund','sweep'].includes(r.kind)||r.botId!==claim.id||r.account!==claim.account||r.masterAccount!==claim.masterAccount
      ||requestDigest(r)!==op.exact_request_digest)throw Error('Grid transfer uncertainty identity changed');
    if(!(await c.query("SELECT 1 FROM grid_operations WHERE id=$1 AND bot_id=$2 AND exact_request_digest=$3 AND state IN ('submitted','unconfirmed')",
      [op.id,claim.id,op.exact_request_digest])).rowCount)return;
    await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,'transfer_unknown',$3) ON CONFLICT DO NOTHING`,
      [claim.id,'transfer-unknown:'+op.id,{operationId:op.id,requestDigest:op.exact_request_digest,kind:r.kind,reason:'transfer_unknown',previousStatus:bot.status}]);
    await c.query(`UPDATE grid_bots SET status=CASE WHEN status='stopping' THEN status ELSE 'paused' END,
      pause_reason=CASE WHEN status IN ('paused','pausing','stopping') AND pause_reason IS DISTINCT FROM 'transfer_unknown'
        THEN pause_reason ELSE 'transfer_unknown' END,updated_at=clock_timestamp() WHERE id=$1`,[claim.id]);
  });}
  /** Only untouched custody can use absence to authorize setup. This never grants a monitor boot for exposure. */
  async authorizeProvisioning(claim:GridMonitorClaim,account:GridAccount,proof:GridEmptyProof){return this.launch.transaction(async c=>{
    const bot=await this.assertLease(c,claim),now=new Date(bot.db_now).getTime();
    if(!await gridWorkerFence(c,claim.id))throw Error('Grid sender still active');
    if(bot.status!=='provisioning'||account.botId!==claim.id||account.leaseToken!==claim.leaseToken||account.wallet!==bot.wallet_address
      ||account.account!==claim.account||account.masterAccount!==claim.masterAccount||account.reused||proof.state!=='absent'||!validGridEmptyProof(account,proof,now))throw Error('Provisioning ownership proof unavailable');
    if((await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND (state IN ('submitted','unconfirmed','confirmed') OR submitted_at IS NOT NULL) LIMIT 1",[claim.id])).rowCount
      ||(await c.query('SELECT bot_id FROM grid_lifecycle WHERE bot_id=$1',[claim.id])).rowCount)throw Error('Untouched provisioning required');
    await recordGridWorker(c,claim.id,claim.leaseToken,false);
  });}
  async provisioningDenied(claim:GridMonitorClaim,reason:string){await this.launch.transaction(async c=>{
    const bot=await this.assertLease(c,claim);
    await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,'provisioning_denied',$3)
      ON CONFLICT(bot_id,event_key) DO NOTHING`,[claim.id,'provisioning-denied:'+requestDigest({policyHmac:bot.policy_hmac,reason}),{reason}]);
  });}
  async block(claim:GridMonitorClaim,reason:string){await this.launch.transaction(async c=>{await this.assertLease(c,claim);
    await c.query(`INSERT INTO grid_monitor_state(bot_id,blocked_reasons) VALUES($1,$2) ON CONFLICT(bot_id)
      DO UPDATE SET boot_id=NULL,pnl=NULL,blocked_reasons=EXCLUDED.blocked_reasons,generation=grid_monitor_state.generation+1`,[claim.id,JSON.stringify([reason])]);
    if(reason!=='startup_or_reconciliation_in_progress'){
      await c.query('UPDATE grid_bots SET canary_clean_since=NULL,canary_clean_ticks=0 WHERE id=$1',[claim.id]);
      await c.query("UPDATE grid_risk_events SET evidence=jsonb_set(evidence,'{clock}', 'null'::jsonb) WHERE bot_id=$1 AND event_key='canary-clock'",[claim.id]);
    }
  });}
  /** Cursor, immutable fills, balances and startup generation commit together, or not at all. */
  async reconcile(claim:GridMonitorClaim,bootId:string,observation:GridObservation){return this.launch.transaction(async c=>{
    await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[claim.masterAccount]);
    const bot=await this.assertLease(c,claim),now=new Date(bot.db_now).getTime();
    const operations=(await c.query('SELECT * FROM grid_operations WHERE bot_id=$1 ORDER BY created_at,id FOR UPDATE',[claim.id])).rows as ReconciliationOperation[];
    const prior=fillsFromRows((await c.query('SELECT * FROM grid_exact_fills WHERE bot_id=$1',[claim.id])).rows);
    const checkpoint=(await c.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='canary-clock' FOR UPDATE",[claim.id])).rows[0]?.evidence;
    const previousFull=checkpoint?.full;
    try{for(const stream of ['orders','positions'] as const)if(observation.history?.lastIds&&previousFull?.lastIds
      &&BigInt(observation.history.lastIds[stream])<BigInt(previousFull.lastIds[stream]))observation={...observation,history:null};}catch{observation={...observation,history:null};}
    if(observation.history?.lastId&&previousFull?.lastId&&BigInt(observation.history.lastId)<BigInt(previousFull.lastId))observation={...observation,history:null};
    const result=reconcileGridObservation({account:claim.account,symbol:bot.market.replace(/-PERP$/,''),direction:bot.direction,
      start:new Date(bot.created_at).getTime(),now,operations,prior,observation,...(isGridCyclePolicyVersion(bot.policy_version)?{cyclePolicy:retainedGridPolicy(bot,(await c.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal',[claim.id])).rows)}:{})});
    const exposure=await this.launch.pilotExposure(c,claim.id,now,{observation,fills:result.fills,authoritative:result.entriesAllowed});
    const lastFailure=(await c.query("SELECT max(terminal_at) AS at FROM grid_operations WHERE bot_id=$1 AND state='failed' AND failure_classification IN ('authentication','quota','transport')",[claim.id])).rows[0]?.at;
    let authoritativeRecovery=false;
    // All downstream decisions use exact operation progress, not scale-eight compatibility columns.
    for(const order of observation.orders){const op=operations.find(op=>op.venue_order_id===order.orderId||op.exact_request?.data.client_order_id===order.clientOrderId&&order.clientOrderId!==null);
      if(!op||!['seed','limit','close'].includes(op.exact_request?.kind))continue;
      const actual=result.fills.filter(f=>f.operationId===op.id).reduce((q,f)=>q.plus(f.size),new D(0));
      if(!actual.eq(order.filledAmount))continue;
      const remaining=new D(order.amount).minus(order.filledAmount);
      const old=(await c.query('SELECT * FROM grid_monitor_orders WHERE operation_id=$1 FOR UPDATE',[op.id])).rows[0];
      if(old&&(old.order_id!==order.orderId||new D(old.filled).gt(actual)||Number(old.observed_at)>observation.observedAt
        ||(['filled','cancelled','rejected'].includes(old.status)&&!['filled','cancelled','rejected'].includes(order.status))))throw Error('Regressing order observation');
      await c.query(`INSERT INTO grid_monitor_orders(operation_id,order_id,status,filled,remaining,observed_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(operation_id) DO UPDATE SET status=EXCLUDED.status,filled=EXCLUDED.filled,remaining=EXCLUDED.remaining,observed_at=EXCLUDED.observed_at`,[op.id,order.orderId,order.status,actual.toFixed(),remaining.toFixed(),observation.observedAt]);
      if(['filled','cancelled','rejected'].includes(order.status)){
        if(order.status==='filled'&&!actual.eq(order.amount))throw Error('False terminal fill');
        if(['filled','cancelled'].includes(order.status)&&lastFailure&&order.updatedAt>new Date(lastFailure).getTime())authoritativeRecovery=true;
        await c.query('UPDATE grid_execution_claims SET slot_released=true WHERE operation_id=$1',[op.id]);
        if(!isGridCyclePolicyVersion(bot.policy_version)&&op.level_id)await c.query(`UPDATE grid_levels SET status=$3,placement_attempt=placement_attempt+1,updated_at=clock_timestamp()
          WHERE id=$1 AND bot_id=$2 AND venue_order_id=$4 AND status IN ('active','partially_filled','cancelling')`,[op.level_id,claim.id,order.status==='filled'?'filled':'cancelled',order.orderId]);
        // A proved terminal cancellation frees only the never-filled part of its allocations.
        if(result.entriesAllowed&&observation.history!.through>=order.updatedAt&&op.exact_request.kind==='limit'&&op.exact_request.data.reduce_only===true){
          const allocations=(await c.query(`SELECT a.*,f.venue_time FROM grid_profit_allocations a JOIN grid_exact_fills f ON f.account=a.account AND f.trade_id=a.trade_id
            WHERE a.operation_id=$1 ORDER BY f.venue_time,a.trade_id FOR UPDATE OF a`,[op.id])).rows;
          let consumed=actual;
          for(const a of allocations){const used=D.min(consumed,a.size),released=new D(a.size).minus(used);consumed=consumed.minus(used);
            if(released.lt(a.released_size))throw Error('Terminal allocation settlement regressed');
            await c.query('UPDATE grid_profit_allocations SET released_size=$4,settled_at=clock_timestamp(),released_at=CASE WHEN $4::numeric=size THEN clock_timestamp() ELSE NULL END WHERE operation_id=$1 AND account=$2 AND trade_id=$3',[op.id,a.account,a.trade_id,released.toFixed()]);
          }
          if(!consumed.isZero())throw Error('Profit fill lacks actual entry allocation');
        }
      }
    }
    for(const f of result.fills){
      const inserted=await c.query(`INSERT INTO grid_exact_fills(account,trade_id,bot_id,operation_id,level_id,order_id,venue_time,leg,size,price,fee)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING trade_id`,[claim.account,f.tradeId,claim.id,f.operationId,f.levelId,f.orderId,f.time,f.leg,f.size,f.price,f.fee]);
      if(!inserted.rowCount){const row=(await c.query('SELECT * FROM grid_exact_fills WHERE account=$1 AND trade_id=$2',[claim.account,f.tradeId])).rows[0];
        if(row.bot_id!==claim.id||canonicalRequest(fillsFromRows([row])[0])!==canonicalRequest(f))throw Error('Conflicting stored trade');}
    }
    // Re-arm an entry only after its full operation is filled and every source lot has a settled exit.
    if(!isGridCyclePolicyVersion(bot.policy_version)&&result.entriesAllowed)for(const op of operations.filter(o=>o.exact_request?.kind==='limit'&&o.exact_request.data.reduce_only===false&&o.level_id)){
      const progress=(await c.query('SELECT status,remaining FROM grid_monitor_orders WHERE operation_id=$1',[op.id])).rows[0];
      if(progress?.status!=='filled')continue;
      const unclosed=(await c.query(`SELECT f.trade_id FROM grid_exact_fills f WHERE f.operation_id=$1 AND f.size>
        COALESCE((SELECT sum(a.size-a.released_size) FROM grid_profit_allocations a JOIN grid_monitor_orders p ON p.operation_id=a.operation_id
          WHERE a.account=f.account AND a.trade_id=f.trade_id AND a.settled_at IS NOT NULL AND p.status IN ('filled','cancelled','rejected')),0) LIMIT 1`,[op.id])).rowCount;
      if(!unclosed)await c.query(`UPDATE grid_levels SET status='pending',venue_order_id=NULL,client_order_uuid=NULL WHERE id=$1 AND bot_id=$2 AND status='filled' AND venue_order_id=$3`,[op.level_id,claim.id,op.venue_order_id]);
    }
    // Observe actual residuals; never convert the 98% threshold into a synthetic fill.
    for(const owned of result.owned){if(!isGridCyclePolicyVersion(bot.policy_version)&&owned.levelId)await c.query(`UPDATE grid_levels SET status=CASE WHEN $3::numeric>0 THEN 'partially_filled' ELSE 'active' END
      WHERE id=$1 AND bot_id=$2 AND venue_order_id=$4 AND status IN ('active','partially_filled')`,[owned.levelId,claim.id,owned.order.filledAmount,owned.order.orderId]);}
    // Settle/reconcile reductions above even when marked exposure exceeds the entry cap.
    // The existing <=limit column cannot store a mark-driven overshoot; the immutable
    // fills and monitor observation retain it while the last reservation stays held.
    const reconciliationComplete=result.entriesAllowed;
    if(exposure.exposureUsd===null||exposure.limitUsd===null||new D(exposure.exposureUsd).gt(exposure.limitUsd)){
      result.reasons.push(exposure.reason??'pilot_exposure_limit_exceeded');result.entriesAllowed=false;
    }else if(result.entriesAllowed)await c.query('UPDATE grid_launch_accounts SET canary_limit=$2,canary_committed=$3 WHERE bot_id=$1',[claim.id,exposure.limitUsd,exposure.exposureUsd]);
    const safe=reconciliationComplete?observation.history!.through:null;
    const economicUnknown=result.reasons.some(r=>['unowned_trade','history_safe_through_unavailable','order_trade_mismatch','vanished_order_unresolved','position_mismatch_or_unavailable'].includes(r));
    await c.query(`INSERT INTO grid_monitor_state(bot_id,boot_id,generation,safe_through,observation,pnl,blocked_reasons,reconciled_at)
      VALUES($1,$2,1,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(bot_id) DO UPDATE SET boot_id=EXCLUDED.boot_id,
      generation=grid_monitor_state.generation+1,safe_through=CASE WHEN EXCLUDED.safe_through IS NULL THEN grid_monitor_state.safe_through ELSE GREATEST(grid_monitor_state.safe_through,EXCLUDED.safe_through) END,
      observation=EXCLUDED.observation,pnl=EXCLUDED.pnl,blocked_reasons=EXCLUDED.blocked_reasons,reconciled_at=EXCLUDED.reconciled_at`,
      [claim.id,reconciliationComplete?bootId:null,safe,JSON.stringify(observation),economicUnknown?null:JSON.stringify(result.pnl),JSON.stringify(result.reasons)]);
    await c.query(`UPDATE grid_bots SET last_reconciliation_at=clock_timestamp(),startup_reconciled_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE id=$1`,[claim.id,reconciliationComplete]);
    if(reconciliationComplete)await c.query(`UPDATE grid_risk_events SET evidence=jsonb_set(evidence,'{reconciliationRequired}','false'::jsonb)
      WHERE bot_id=$1 AND event_key='worker-ownership' AND evidence->>'generation'=$2`,[claim.id,claim.leaseToken]);
    // Every eligible monitor tick performs a full replay; this exceeds the 30-minute
    // cadence without creating another scheduler. Completion and safe-through are
    // committed with fills and the durable canary checkpoint in this transaction.
    const generation=String((await c.query('SELECT generation FROM grid_monitor_state WHERE bot_id=$1',[claim.id])).rows[0].generation);
    const full=reconciliationComplete?{generation,safeThrough:safe,completedAt:now,lastId:observation.history?.lastId??null,lastIds:observation.history?.lastIds??null}:previousFull??null;
    const q=observation.qualification;
    const quota=(await c.query('SELECT backoff_until>clock_timestamp() AS blocked FROM grid_master_quota WHERE master_account=$1',[claim.masterAccount])).rows[0];
    const levels=(await c.query('SELECT price,size::text AS exact_size,reduce_only FROM grid_levels WHERE bot_id=$1 ORDER BY price,ordinal',[claim.id])).rows;
    const currentPolicy=gridCanaryPolicyCurrent(q,levels,bot.leverage,now,bot.direction);
    const healthy=result.entriesAllowed&&quota&&!quota.blocked&&currentPolicy
      &&observation.history?.publicationLagMs===GRID_HISTORY_PUBLICATION_LAG_MS&&!!observation.history.lastId;
    if(authoritativeRecovery&&healthy){
      await c.query('UPDATE grid_bots SET consecutive_failures=0 WHERE id=$1',[claim.id]);
      bot.consecutive_failures=0;
    }
    const qualifying=bot.status==='canary'&&result.entriesAllowed&&bot.consecutive_failures===0&&quota&&!quota.blocked&&currentPolicy
      &&observation.history?.publicationLagMs===GRID_HISTORY_PUBLICATION_LAG_MS&&!!observation.history.lastId;
    const first=bot.canary_started_at?new Date(bot.canary_started_at).getTime():null;
    const clock=first===null?null:advanceGridCanary(checkpoint?.clock as GridCanaryClock|null??null,{bootId,tickId:claim.leaseToken,observedAt:observation.observedAt,firstConfirmedAt:first,
      qualifying,generation,safeThrough:result.entriesAllowed?safe:null});
    await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at) VALUES($1,'canary-clock','internal_canary_clock',$2,clock_timestamp())
      ON CONFLICT(bot_id,event_key) DO UPDATE SET evidence=EXCLUDED.evidence,delivered_at=EXCLUDED.delivered_at`,[claim.id,{clock,full}]);
    if(bot.status==='canary')await c.query(`UPDATE grid_bots SET canary_clean_since=$2,canary_clean_ticks=$3,
      status=CASE WHEN $4 THEN 'active' ELSE status END,canary_promoted_at=CASE WHEN $4 THEN clock_timestamp() ELSE canary_promoted_at END WHERE id=$1`,
      [claim.id,clock?.cleanSince===null||!clock?null:new Date(clock.cleanSince),clock?.cleanTicks??0,clock?.promoted??false]);
    if(isGridCyclePolicyVersion(bot.policy_version)&&reconciliationComplete){
      const replayNow=Math.floor(Number((await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now));
      await recordCycleReplay(c,bot,claim.account,replayNow);
    }
    return {...result,reconciliationComplete};
  });}
  async planningState(claim:GridMonitorClaim,bootId:string){return this.launch.transaction(async c=>{
    const bot=await this.assertLease(c,claim);const state=(await c.query('SELECT *,reconciled_at>clock_timestamp()-interval \'5 seconds\' AS fresh FROM grid_monitor_state WHERE bot_id=$1',[claim.id])).rows[0];
    if(!state?.fresh||state.boot_id!==bootId||state.blocked_reasons.some((reason:string)=>!isGridPilotExposureBlockReason(reason)))throw Error('Startup reconciliation unavailable');
    const fills=fillsFromRows((await c.query('SELECT * FROM grid_exact_fills WHERE bot_id=$1',[claim.id])).rows);
    const reserved=(await c.query(`SELECT a.trade_id AS "tradeId",(a.size-a.released_size)::text AS size FROM grid_profit_allocations a JOIN grid_operations o ON o.id=a.operation_id
      WHERE o.bot_id=$1 AND a.released_at IS NULL`,[claim.id])).rows;
    const levels=(await c.query(`SELECT l.*,CASE WHEN l.status='cancelled' AND p.status='cancelled' THEN p.remaining::text ELSE l.size::text END AS exact_size
      FROM grid_levels l LEFT JOIN LATERAL (SELECT p.* FROM grid_monitor_orders p JOIN grid_operations o ON o.id=p.operation_id
        WHERE o.level_id=l.id AND o.exact_request->'data'->>'reduce_only'='false' ORDER BY o.created_at DESC,o.id DESC LIMIT 1) p ON true WHERE l.bot_id=$1 ORDER BY l.ordinal`,[claim.id])).rows;
    const life=(await c.query('SELECT epoch FROM grid_lifecycle WHERE bot_id=$1',[claim.id])).rows[0];
    const auto=(await c.query('SELECT generation FROM grid_auto_resume WHERE bot_id=$1',[claim.id])).rows[0];
    const cycle=isGridCyclePolicyVersion(bot.policy_version)?await readCycleState(c,bot,claim.account,Date.now()):undefined;
    return {fills,reserved,levels,...(cycle?{cycle}:{}),entriesAllowed:state.blocked_reasons.length===0,authority:{autoResumeGeneration:String(auto?.generation??'0'),monitorBootId:bootId,monitorGeneration:String(state.generation),...(life?{lifecycleEpoch:String(life.epoch)}:{})},observation:state.observation as GridObservation};
  });}
  async pnl(wallet:string,id:string){return this.launch.transaction(async c=>{
    if(!(await c.query('SELECT id FROM grid_bots WHERE id=$1 AND wallet_address=$2',[id,wallet])).rowCount)return null;
    const row=(await c.query('SELECT pnl,reconciled_at,blocked_reasons FROM grid_monitor_state WHERE bot_id=$1',[id])).rows[0];
    if(!row?.pnl)return {available:false,label:'PnL excludes funding',reason:'reconciliation_unavailable'};
    const fresh=Date.now()-new Date(row.reconciled_at).getTime()<=15000;
    return {available:true,...row.pnl,...(!fresh?{unrealised:null,total:null,markObservedAt:null}:{}),reconciledAt:row.reconciled_at,blockedReasons:row.blocked_reasons};
  });}
}
