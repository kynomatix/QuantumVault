import {walletFences} from '../grid-worker/transaction';
import {refuseRescueMutation} from '../grid-worker/rescue-recovery';
import type {PoolClient} from 'pg';
import {identityFences} from '../grid-worker/identity-locks';
import {supersedeStartConsents} from '../grid-worker/consent';
import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {GridStorageError} from './storage-error';
import {GridMonitorStorage,type GridMonitorClaim} from './monitor-storage';
import {canonicalRequest} from './launch-storage-core';
import {gridWorkerFence,waitGridWorkerFence} from './worker-ownership';
import {gridWalletEntryGate} from './runtime-policy';
import {freshGridFact,gridEntrySafety,type GridControlAction} from './lifecycle-policy';
import type {GridObservation} from './reconciliation';
import {GridAutoResumeStorage,clearGridAutoResumeArm,type GridResumeIdentity,type GridAutoResumeToken} from './auto-resume-storage';
export interface GridControl {id:string;bot_id:string;action:GridControlAction;state:string;previous_status:string;evidence:Record<string,unknown>}
export class GridLifecycleStorage {
  readonly auto:GridAutoResumeStorage;
  constructor(readonly monitor:GridMonitorStorage){this.auto=new GridAutoResumeStorage(monitor);}
  /** Only the executor holding this bot claim turns the host revision into ordinary Pause. */
  async observeHostPause(claim:GridMonitorClaim):Promise<void>{
    const request=await this.monitor.launch.transaction(async c=>{
      const revision=this.monitor.launch.hostPause(c);if(revision===null)return null;
      const bot=await this.monitor.assertLease(c,claim);
      if(['draft','failed','stopped','stopping'].includes(bot.status))return null;
      return {wallet:String(bot.wallet_address),revision};
    });
    if(request)await this.request(request.wallet,claim.id,`host-pause:${request.revision}:${claim.id}`,'pause',{},'risk',claim);
  }
  /** Owner scope, request deduplication and the entry fence commit in one transaction. */
  async request(wallet:string,botId:string,key:string,action:GridControlAction,evidence:Record<string,unknown>={},source:'owner'|'risk'='owner',claim?:GridMonitorClaim,outer?:PoolClient):Promise<GridControl>{
    if(!['owner','risk'].includes(source)||!key||key.length>200||!['pause','resume','resync','stop','band'].includes(action)||source==='owner'&&action==='band')throw new GridStorageError('invariant');
    const work=async(c:PoolClient)=>{
      if(outer){
        if(action!=='stop'||source!=='owner'||!(await c.query('SELECT grid_worker_has_host_lock(true) AS held')).rows[0]?.held)throw Error('GRID_PROTECTIVE_STOP_FENCE');
      }else this.monitor.launch.hostAction(c,action==='resume'?'resume':'settle');
      await walletFences(c,[wallet]);
      await waitGridWorkerFence(c,botId);
      const workerPackage=source==='owner'&&action==='stop'&&!!(await c.query("SELECT to_regclass('grid_worker_requests') IS NOT NULL AS present")).rows[0]?.present;
      if(workerPackage){
        await identityFences(c,[botId],[]);
        await supersedeStartConsents(c,wallet,[botId],'stop');
      }
      const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE',[botId,wallet])).rows[0];
      if(!bot)throw new GridStorageError('not_found');
      if(source==='owner'&&!outer)await refuseRescueMutation(c,botId);
      if(source==='risk'){if(!claim||claim.id!==botId)throw new GridStorageError('lost_lease');await this.monitor.assertLease(c,claim);}
      const prior=(await c.query('SELECT r.*,k.evidence AS requested_evidence FROM grid_control_keys k JOIN grid_control_requests r ON r.id=k.control_id WHERE k.bot_id=$1 AND k.request_key=$2',[botId,key])).rows[0];
      if(prior){if(prior.action!==action||canonicalRequest(prior.requested_evidence)!==canonicalRequest(evidence))throw new GridStorageError('conflict');return prior;}
      if(source==='owner'&&['pause','stop','resume'].includes(action))await this.auto.revoke(c,botId,action!=='resume',action==='resume'?'waiting_for_inner_band':'preference_off');
      if(source==='risk'&&['pause','stop'].includes(action))await this.auto.revoke(c,botId,false,'risk_pause');
      const bind=async(control:GridControl)=>{await c.query('INSERT INTO grid_control_keys(bot_id,request_key,control_id,evidence) VALUES($1,$2,$3,$4)',[botId,key,control.id,evidence]);return control;};
      const current=(await c.query('SELECT r.* FROM grid_lifecycle l JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1',[botId])).rows[0];
      if(current?.state==='pending'&&current.action===action)return bind(current);
      if(bot.status==='stopped'&&action==='stop'){
        const last=(await c.query("SELECT * FROM grid_control_requests WHERE bot_id=$1 AND action='stop' AND state='complete' ORDER BY completed_at DESC LIMIT 1",[botId])).rows[0];
        if(last)return bind(last);
      }
      if(bot.status==='draft'&&workerPackage){
        // Cancelling an unadmitted draft commits the consent supersession without custody or execution.
        if((await c.query("SELECT 1 FROM grid_worker_requests WHERE bot_id=$1 AND state='admitted' LIMIT 1",[botId])).rowCount)throw new GridStorageError('conflict');
        const row=(await c.query(`INSERT INTO grid_control_requests(id,bot_id,request_key,action,source,previous_status,evidence,state,completed_at)
          VALUES($1,$2,$3,'stop','owner','draft',$4,'complete',clock_timestamp()) RETURNING *`,[randomUUID(),botId,key,evidence])).rows[0];
        return bind(row);
      }
      if(['draft','failed','stopped'].includes(bot.status)||bot.status==='stopping'&&action!=='stop'
        ||current?.state==='pending'&&action!=='stop'&&action!=='pause'&&action!=='band')throw new GridStorageError('conflict');
      if(action==='resume'&&!['paused','range_exhausted'].includes(bot.status))throw new GridStorageError('conflict');
      if(current?.state==='pending')await c.query("UPDATE grid_control_requests SET state='superseded',completed_at=clock_timestamp() WHERE id=$1",[current.id]);
      const id=randomUUID(),status=action==='stop'?'stopping':action==='resume'?'resuming':action==='resync'?'reconciling':'pausing';
      const row=(await c.query('INSERT INTO grid_control_requests(id,bot_id,request_key,action,source,previous_status,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,botId,key,action,source,bot.status,evidence])).rows[0];
      await c.query(`INSERT INTO grid_lifecycle(bot_id,epoch,active_request) VALUES($1,1,$2) ON CONFLICT(bot_id)
        DO UPDATE SET epoch=grid_lifecycle.epoch+1,active_request=EXCLUDED.active_request,blocker=NULL,terminal_proof=NULL`,[botId,id]);
      await c.query('UPDATE grid_bots SET status=$2,pause_reason=$3,updated_at=clock_timestamp() WHERE id=$1',[botId,status,action==='band'?'range_exhausted':action]);
      await c.query('UPDATE grid_monitor_state SET boot_id=NULL,generation=generation+1 WHERE bot_id=$1',[botId]);
      await c.query('INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[botId,id,action,evidence]);
      return bind(row);
    };
    return outer?work(outer):this.monitor.launch.transaction(work,source==='owner');
  }
  async state(claim:GridMonitorClaim){return this.monitor.launch.transaction(async c=>{const bot=await this.monitor.assertLease(c,claim);
    const life=(await c.query('SELECT l.*,r.action,r.source,r.state,r.previous_status,r.evidence FROM grid_lifecycle l LEFT JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1',[claim.id])).rows[0];return {bot,life};});}
  async blocked(claim:GridMonitorClaim,reason:string){await this.monitor.launch.transaction(async c=>{await this.monitor.assertLease(c,claim);
    await c.query('UPDATE grid_lifecycle SET blocker=$2 WHERE bot_id=$1',[claim.id,reason]);});}
  async safetyObservation(claim:GridMonitorClaim,observation:GridObservation){await this.monitor.launch.transaction(async c=>{
    const bot=await this.monitor.assertLease(c,claim);
    if(observation.account!==claim.account||observation.symbol!==bot.market.replace(/-PERP$/,'')||!observation.inventoryComplete||!freshGridFact(observation.observedAt,new Date(bot.db_now).getTime()))throw Error('Safety observation unavailable');
    await c.query(`INSERT INTO grid_monitor_state(bot_id,observation,reconciled_at,blocked_reasons) VALUES($1,$2,clock_timestamp(),'["safety_observation_only"]')
      ON CONFLICT(bot_id) DO UPDATE SET observation=EXCLUDED.observation,reconciled_at=clock_timestamp(),boot_id=NULL,pnl=NULL,generation=grid_monitor_state.generation+1,blocked_reasons=EXCLUDED.blocked_reasons`,[claim.id,observation]);
  });}
  async sol(claim:GridMonitorClaim,fact:{balance:string;observedAt:number}|null){
    await this.monitor.launch.transaction(async c=>{await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[claim.masterAccount]);
      const bot=await this.monitor.assertLease(c,claim),now=new Date(bot.db_now).getTime();
      const valid=fact&&freshGridFact(fact.observedAt,now)&&/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(fact.balance),gate=gridWalletEntryGate(valid?fact.balance:null);
      const state=!valid?'unknown':!gate.entryAllowed?'entry_blocked':gate.warning?'warning':'healthy';
      const prior=(await c.query('SELECT * FROM grid_wallet_safety WHERE execution_wallet=$1 FOR UPDATE',[claim.masterAccount])).rows[0];
      const incident=state==='healthy'?null:prior?.incident_id??randomUUID();
      await c.query(`INSERT INTO grid_wallet_safety(execution_wallet,balance_lamports,observed_at,guard_state,incident_id,policy_version) VALUES($1,$2,$3,$4,$5,'1.0.0')
        ON CONFLICT(execution_wallet) DO UPDATE SET balance_lamports=EXCLUDED.balance_lamports,observed_at=EXCLUDED.observed_at,guard_state=EXCLUDED.guard_state,incident_id=EXCLUDED.incident_id,policy_version=EXCLUDED.policy_version`,
        [claim.masterAccount,valid?new Decimal(fact.balance).mul('1000000000').toFixed(0):null,valid?new Date(fact.observedAt):null,state,incident]);
      await c.query('UPDATE grid_bots SET sol_balance=$2,sol_balance_observed_at=$3,sol_guard_state=$4 WHERE id=$1',[claim.id,valid?fact.balance:null,valid?new Date(fact.observedAt):null,state]);
      if(state!=='healthy'&&prior?.guard_state!==state&&!(await c.query('SELECT 1 FROM grid_risk_events WHERE event_key=$1',[incident+':'+state])).rowCount)await c.query('INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[claim.id,incident+':'+state,'sol_'+state,{executionWallet:claim.masterAccount,balance:valid?fact.balance:null,observedAt:valid?fact.observedAt:null,policyVersion:'1.0.0'}]);
    });
  }
  async complete(claim:GridMonitorClaim,requestId:string,status:'paused'|'range_exhausted'|'active'|'canary',proof?:{identity?:GridResumeIdentity|null;token?:GridAutoResumeToken;tick?:string;epoch?:string}){
    await this.monitor.launch.transaction(async c=>{
      this.monitor.launch.hostAction(c,['active','canary'].includes(status)?'resume':'settle');
      if(!await gridWorkerFence(c,claim.id))throw new GridStorageError('conflict');
      const bot=await this.monitor.assertLease(c,claim);
      const l=(await c.query('SELECT l.*,r.action,r.source,r.state FROM grid_lifecycle l JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1 FOR UPDATE OF l',[claim.id])).rows[0];
      if(l?.active_request!==requestId||l.state!=='pending'||proof?.epoch!==undefined&&String(l.epoch)!==proof.epoch)throw new GridStorageError('conflict');
      if(l.action==='stop')throw new GridStorageError('invariant');
      if(['active','canary'].includes(status)){
        if(l.source==='auto'&&(!proof?.token||!proof.tick||!await this.auto.valid(c,bot,proof.token,proof.tick)))throw new GridStorageError('conflict');
        if(proof?.identity&&!await this.auto.security(c,bot,proof.identity))throw new GridStorageError('conflict');
        const m=(await c.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[claim.id])).rows[0],now=new Date(bot.db_now).getTime();
        if(l.action!=='resume'||!m?.boot_id||m.blocked_reasons.length||!freshGridFact(new Date(m.reconciled_at).getTime(),now)
          ||!gridEntrySafety({sol:bot.sol_balance,solObservedAt:bot.sol_balance_observed_at?new Date(bot.sol_balance_observed_at).getTime():null,failures:bot.consecutive_failures,mark:m.observation?.mark??null},now).allowed)throw new GridStorageError('invariant');
      }
      if((await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[claim.id])).rowCount)throw new GridStorageError('conflict');
      await c.query("UPDATE grid_control_requests SET state='complete',completed_at=clock_timestamp() WHERE id=$1 AND state='pending'",[requestId]);
      await c.query('UPDATE grid_bots SET status=$2,updated_at=clock_timestamp() WHERE id=$1',[claim.id,status]);
      await c.query('INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[claim.id,requestId+':complete',status,{controlRequestId:requestId}]);
      await c.query('UPDATE grid_lifecycle SET blocker=NULL WHERE bot_id=$1',[claim.id]);
      if(status==='range_exhausted'&&l.action==='band')await this.auto.arm(c,bot,{...l,state:'complete'},proof?.identity??null);
      if(['active','canary'].includes(status))await c.query(`UPDATE grid_auto_resume SET ${clearGridAutoResumeArm},held_reason=NULL,updated_at=clock_timestamp() WHERE bot_id=$1`,[claim.id]);
    });
  }
}
