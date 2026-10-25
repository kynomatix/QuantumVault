import {loadActiveGridLevels} from './active-epoch';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {GridMonitorStorage,GridMonitorClaim} from './monitor-storage';
import {GridStorageError} from './storage-error';
import {gridRuntimeGates} from './service';
import {gridAutoResumeBand,gridInsideAutoResumeBand,gridAutoResumeRetry,type GridAutoResumeReason} from './auto-resume-policy';
import {freshGridFact,gridEntrySafety} from './lifecycle-policy';
export interface GridResumeIdentity {policyHash:string;umkVersion:number}
export interface GridAutoResumeToken {generation:string;cycle:string;requestId:string;epoch:string;policyHash:string;umkVersion:number}
export const clearGridAutoResumeArm=`armed_epoch_id=NULL,armed_cycle=NULL,armed_generation=NULL,armed_lifecycle_epoch=NULL,armed_band_request=NULL,armed_policy_hmac=NULL,armed_umk_version=NULL,resume_request_id=NULL,attempts=0,first_attempt_at=NULL,next_attempt_at=NULL`;
/** All mutations acquire the owning bot lock first. No remote action is performed here. */
export class GridAutoResumeStorage {
  constructor(readonly monitor:GridMonitorStorage,private gates=gridRuntimeGates){}
  async armed(claim:GridMonitorClaim){return this.monitor.launch.transaction(async c=>{await this.monitor.assertLease(c,claim);return !!(await c.query('SELECT 1 FROM grid_auto_resume WHERE bot_id=$1 AND enabled AND armed_cycle IS NOT NULL',[claim.id])).rowCount;});}
  async identity(wallet:string,id:string):Promise<GridResumeIdentity|null>{
    const {durableGridUmk}=await import('./service'),{retainedGridPolicy}=await import('./launch-authority-core'),{verifyGridPolicyHmac}=await import('./policy-hmac');
    const snapshot=await this.monitor.launch.transaction(async c=>({bot:(await c.query('SELECT * FROM grid_bots WHERE id=$1 AND wallet_address=$2',[id,wallet])).rows[0],levels:(await loadActiveGridLevels(c,id,'all')).rows}));
    if(!snapshot.bot)return null;
    const before=(await this.monitor.launch.transaction(c=>c.query('SELECT umk_version,umk_encrypted_for_execution,agent_public_key,agent_private_key_encrypted_v3 FROM wallets WHERE address=$1',[wallet]))).rows[0];if(!before)return null;
    const key=await durableGridUmk(wallet);if(!key)return null;
    try{
      if(!verifyGridPolicyHmac(retainedGridPolicy(snapshot.bot,snapshot.levels),key.umk,snapshot.bot.policy_hmac).ok)return null;
      const w=(await this.monitor.launch.transaction(c=>c.query('SELECT umk_version,umk_encrypted_for_execution,agent_public_key,agent_private_key_encrypted_v3 FROM wallets WHERE address=$1',[wallet]))).rows[0];
      return w&&Object.keys(before).every(k=>w[k]===before[k])?{policyHash:snapshot.bot.policy_hmac,umkVersion:w.umk_version}:null;
    }finally{key.cleanup();}
  }
  async security(c:PoolClient,bot:any,identity:GridResumeIdentity){
    const w=(await c.query('SELECT w.execution_enabled,w.emergency_stop_triggered,w.umk_version,w.umk_encrypted_for_execution,w.agent_public_key,a.master_account,a.account FROM wallets w JOIN grid_launch_accounts a ON a.bot_id=$2 AND a.released_at IS NULL WHERE w.address=$1 FOR SHARE OF w,a',[bot.wallet_address,bot.id])).rows[0];
    return !!w&&w.agent_public_key===w.master_account&&!!w.account&&(!bot.account||bot.account===w.account)&&(!bot.master_account||bot.master_account===w.master_account)&&w.execution_enabled===true&&w.emergency_stop_triggered===false&&!!w.umk_encrypted_for_execution&&w.umk_version===identity.umkVersion&&bot.policy_hmac===identity.policyHash;
  }
  async revoke(c:PoolClient,botId:string,off:boolean,reason:GridAutoResumeReason,preserveBoot=false){
    const old=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1 FOR UPDATE',[botId])).rows[0];
    if(old?.resume_request_id){
      const superseded=await c.query("UPDATE grid_control_requests SET state='superseded',completed_at=clock_timestamp() WHERE id=$1 AND state='pending' RETURNING id",[old.resume_request_id]);
      if(superseded.rowCount)await c.query("UPDATE grid_bots SET status='range_exhausted',pause_reason=$2 WHERE id=$1 AND status='resuming'",[botId,reason]);
    }
    await c.query(`INSERT INTO grid_auto_resume(bot_id,enabled,generation,held_reason) VALUES($1,NOT $3,1,$2) ON CONFLICT(bot_id) DO UPDATE SET enabled=CASE WHEN $3 THEN false ELSE grid_auto_resume.enabled END,generation=grid_auto_resume.generation+1,${clearGridAutoResumeArm},held_reason=$2,updated_at=clock_timestamp()`,[botId,reason,off]);
    await c.query('UPDATE grid_lifecycle SET epoch=epoch+1 WHERE bot_id=$1',[botId]);
    await c.query(`UPDATE grid_monitor_state SET boot_id=${preserveBoot?'boot_id':'NULL'},generation=generation+1 WHERE bot_id=$1`,[botId]);
  }
  async set(wallet:string,id:string,enabled:boolean,expectedGeneration:string,tick:string|null,identity:GridResumeIdentity|null){
    return this.monitor.launch.transaction(async c=>{
      await refuseRescueMutation(c,id);
      const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE',[id,wallet])).rows[0];if(!bot)throw new GridStorageError('not_found');
      const row=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];
      if(String(row?.generation??'0')!==expectedGeneration)throw new GridStorageError('conflict');
      // Absence is the default ON preference, never an automatic-resume arm.
      if((row?.enabled??true)===enabled)return row??{enabled:true,generation:'0',cycle:'0',held_reason:null};
      if(enabled&&(!tick||!gridAutoResumeBand(bot.lower_price,bot.upper_price,tick)||['draft','failed','stopping','stopped'].includes(bot.status)))throw new GridStorageError('conflict');
      await this.revoke(c,id,!enabled,enabled?'waiting_for_inner_band':'preference_off',enabled);
      const updated=(await c.query('UPDATE grid_auto_resume SET enabled=$2 WHERE bot_id=$1 RETURNING *',[id,enabled])).rows[0];
      if(enabled&&bot.status==='range_exhausted'){
        const life=(await c.query('SELECT l.*,r.action,r.source,r.state FROM grid_lifecycle l JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1',[id])).rows[0];
        // Off/on may explicitly re-arm a held automatic cycle. Automatic requests do
        // not erase its completed band provenance; any later owner/risk control does.
        const latest=(await c.query("SELECT * FROM grid_control_requests WHERE bot_id=$1 AND source<>'auto' ORDER BY created_at DESC,id DESC LIMIT 1",[id])).rows[0];
        if(life&&latest?.action==='band'&&latest.source==='risk'&&latest.state==='complete'){
          await c.query('UPDATE grid_lifecycle SET active_request=$2,blocker=NULL WHERE bot_id=$1',[id,latest.id]);
          await this.arm(c,bot,{...life,active_request:latest.id,action:latest.action,source:latest.source,state:latest.state},identity);
        }
      }
      return (await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1',[id])).rows[0]??updated;
    });
  }
  async arm(c:PoolClient,bot:any,life:any,identity:GridResumeIdentity|null){
    // Materialize the default only for a completed band exit. Owner/risk pauses
    // cannot manufacture an arm, even when no preference has ever been saved.
    if(life.action!=='band'||life.source!=='risk'||life.state!=='complete')return;
    await c.query('INSERT INTO grid_auto_resume(bot_id) VALUES($1) ON CONFLICT(bot_id) DO NOTHING',[bot.id]);
    const row=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1 FOR UPDATE',[bot.id])).rows[0];
    if(!row?.enabled)return;
    const m=(await c.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[bot.id])).rows[0],now=new Date(bot.db_now??Date.now()).getTime();
    const unresolved=(await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[bot.id])).rowCount;
    if(!identity||!await this.security(c,bot,identity)){await c.query(`UPDATE grid_auto_resume SET ${clearGridAutoResumeArm},held_reason='execution_revoked' WHERE bot_id=$1`,[bot.id]);return;}
    if(life.action!=='band'||life.source!=='risk'||life.state!=='complete'||unresolved||!m?.boot_id||m.blocked_reasons.length||!freshGridFact(new Date(m.reconciled_at).getTime(),now)){
      await c.query("UPDATE grid_auto_resume SET held_reason='reconciliation_required' WHERE bot_id=$1",[bot.id]);return;
    }
    // An interrupted automatic Resume keeps its cycle and its spent budget.
    if(row.armed_cycle){
      if((row.armed_epoch_id??null)!==(bot.active_epoch_id??null)||row.armed_policy_hmac!==identity.policyHash||row.armed_umk_version!==identity.umkVersion){await c.query(`UPDATE grid_auto_resume SET ${clearGridAutoResumeArm},held_reason='policy_changed' WHERE bot_id=$1`,[bot.id]);return;}
      await c.query("UPDATE grid_auto_resume SET armed_lifecycle_epoch=$2,armed_band_request=$3,held_reason='waiting_for_inner_band',updated_at=clock_timestamp() WHERE bot_id=$1",[bot.id,String(life.epoch),life.active_request]);return;
    }
    await c.query(`UPDATE grid_auto_resume SET cycle=cycle+1,armed_cycle=cycle+1,armed_generation=generation,armed_lifecycle_epoch=$2,armed_band_request=$3,armed_policy_hmac=$4,armed_umk_version=$5,armed_epoch_id=$6,held_reason='waiting_for_inner_band',updated_at=clock_timestamp() WHERE bot_id=$1`,[bot.id,String(life.epoch),life.active_request,identity.policyHash,identity.umkVersion,bot.active_epoch_id??null]);
  }
  async hold(claim:GridMonitorClaim,reason:GridAutoResumeReason,clear=false,permit?:GridAutoResumeToken){return this.monitor.launch.transaction(async c=>{
    const bot=await this.monitor.assertLease(c,claim);const a=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1 FOR UPDATE',[claim.id])).rows[0];if(!a?.enabled||!a.armed_cycle)return;
    if(permit&&(String(a.generation)!==permit.generation||String(a.cycle)!==permit.cycle||a.resume_request_id!==permit.requestId||a.armed_policy_hmac!==permit.policyHash||a.armed_umk_version!==permit.umkVersion||String(a.armed_lifecycle_epoch)!==permit.epoch))return;
    if(clear){
      if(a.resume_request_id)await c.query("UPDATE grid_control_requests SET state='superseded',completed_at=clock_timestamp() WHERE id=$1 AND state='pending'",[a.resume_request_id]);
      if(bot.status==='resuming')await c.query("UPDATE grid_bots SET status='range_exhausted',pause_reason=$2 WHERE id=$1",[claim.id,reason]);
      await c.query('UPDATE grid_lifecycle SET epoch=epoch+1,blocker=$2 WHERE bot_id=$1',[claim.id,reason]);
      await c.query('UPDATE grid_monitor_state SET boot_id=NULL,generation=generation+1 WHERE bot_id=$1',[claim.id]);
    }
    await c.query(`UPDATE grid_auto_resume SET ${clear?clearGridAutoResumeArm+',':''}held_reason=$2,updated_at=CASE WHEN held_reason IS DISTINCT FROM $2 AND (held_reason IS NULL OR held_reason='waiting_for_inner_band' OR $2='waiting_for_inner_band') THEN clock_timestamp() ELSE updated_at END WHERE bot_id=$1`,[claim.id,reason]);
    if(clear||a.held_reason!==reason)await c.query('INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[claim.id,'auto-held:'+randomUUID(),'auto_resume_held',{reason,cycle:String(a.cycle),generation:String(a.generation),attempts:a.attempts,controlRequestId:a.resume_request_id}]);
  });}
  async reserve(claim:GridMonitorClaim,tick:string,mark:{price:string;observedAt:number}|null):Promise<GridAutoResumeToken|null>{
    return this.monitor.launch.transaction(async c=>{
      const bot=await this.monitor.assertLease(c,claim),now=new Date(bot.db_now).getTime();
      const a=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1 FOR UPDATE',[claim.id])).rows[0];
      if(!a?.enabled||!a.armed_cycle)return null;
      const fence={generation:String(a.generation),cycle:String(a.cycle),requestId:a.resume_request_id,epoch:String(a.armed_lifecycle_epoch),policyHash:a.armed_policy_hmac,umkVersion:a.armed_umk_version};
      const reason=async(r:GridAutoResumeReason)=>{
        await c.query(`UPDATE grid_auto_resume SET held_reason=$2,updated_at=CASE WHEN held_reason IS DISTINCT FROM $2 AND (held_reason IS NULL OR held_reason='waiting_for_inner_band' OR $2='waiting_for_inner_band') THEN clock_timestamp() ELSE updated_at END WHERE bot_id=$1`,[claim.id,r]);
        if(a.held_reason!==r)await c.query('INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[claim.id,'auto-held:'+randomUUID(),'auto_resume_held',{reason:r,cycle:String(a.cycle),generation:String(a.generation),attempts:a.attempts,controlRequestId:a.resume_request_id}]);
        return null;
      };
      if(!this.gates().startEnabled)return reason('resume_authority_unavailable');
      const life=(await c.query('SELECT l.*,r.action,r.source,r.state FROM grid_lifecycle l JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1',[claim.id])).rows[0];
      if(!['range_exhausted','resuming'].includes(bot.status)||!life||String(life.epoch)!==String(a.armed_lifecycle_epoch)||String(a.generation)!==String(a.armed_generation))return {...fence,clearReason:'risk_pause'} as GridAutoResumeToken;
      if((a.armed_epoch_id??null)!==(bot.active_epoch_id??null)||!await this.security(c,bot,{policyHash:a.armed_policy_hmac,umkVersion:a.armed_umk_version}))return {...fence,clearReason:bot.policy_hmac!==a.armed_policy_hmac?'policy_changed':'execution_revoked'} as unknown as GridAutoResumeToken;
      const band=(await c.query("SELECT * FROM grid_control_requests WHERE id=$1 AND bot_id=$2 AND action='band' AND source='risk' AND state='complete'",[a.armed_band_request,claim.id])).rows[0];
      if(!band||!(life.active_request===a.armed_band_request&&life.state==='complete'||life.active_request===a.resume_request_id&&life.action==='resume'&&life.source==='auto'&&life.state==='pending'))return {...fence,clearReason:'risk_pause'} as GridAutoResumeToken;
      const retry=gridAutoResumeRetry(a.attempts,a.first_attempt_at?new Date(a.first_attempt_at).getTime():null,a.next_attempt_at?new Date(a.next_attempt_at).getTime():null,now);
      if(retry==='expired'||retry==='exhausted')return {...fence,expired:true} as unknown as GridAutoResumeToken;
      if(retry==='waiting')return null;
      const inner=gridAutoResumeBand(bot.lower_price,bot.upper_price,tick);if(!inner)return reason('range_unavailable');
      if(!mark||!freshGridFact(mark.observedAt,now))return reason('market_data_unavailable');
      if(!gridInsideAutoResumeBand(mark.price,inner))return reason('waiting_for_inner_band');
      const m=(await c.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[claim.id])).rows[0];
      if(!m?.boot_id||m.blocked_reasons.length||!freshGridFact(new Date(m.reconciled_at).getTime(),now))return reason('reconciliation_required');
      if((await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[claim.id])).rowCount)return reason('operation_pending');
      if(!gridEntrySafety({sol:bot.sol_balance,solObservedAt:bot.sol_balance_observed_at?new Date(bot.sol_balance_observed_at).getTime():null,failures:bot.consecutive_failures,mark},now).allowed)return {...fence,clearReason:'risk_pause'} as GridAutoResumeToken;
      const key=`auto-resume:${claim.id}:${a.generation}:${a.cycle}`,requestId=a.resume_request_id??randomUUID();
      if(!a.resume_request_id){
        await c.query("INSERT INTO grid_control_requests(id,bot_id,request_key,action,source,previous_status,evidence) VALUES($1,$2,$3,'resume','auto','range_exhausted',$4)",[requestId,claim.id,key,{generation:String(a.generation),cycle:String(a.cycle),policyHash:a.armed_policy_hmac,umkVersion:a.armed_umk_version}]);
        await c.query('INSERT INTO grid_control_keys(bot_id,request_key,control_id,evidence) VALUES($1,$2,$3,$4)',[claim.id,key,requestId,{}]);
      }else await c.query("UPDATE grid_control_requests SET state='pending',completed_at=NULL WHERE id=$1 AND bot_id=$2 AND source='auto' AND action='resume'",[requestId,claim.id]);
      const epoch=String(BigInt(life.epoch)+1n),first=a.first_attempt_at?new Date(a.first_attempt_at).getTime():now;
      await c.query("UPDATE grid_auto_resume SET resume_request_id=$2,armed_lifecycle_epoch=$3,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,$4),next_attempt_at=$5,held_reason=NULL,updated_at=clock_timestamp() WHERE bot_id=$1",[claim.id,requestId,epoch,new Date(first),a.attempts>=2?null:new Date(first+(a.attempts===0?15000:60000))]);
      await c.query('UPDATE grid_lifecycle SET epoch=$2,active_request=$3,blocker=NULL WHERE bot_id=$1',[claim.id,epoch,requestId]);
      await c.query("UPDATE grid_bots SET status='resuming',pause_reason='resume' WHERE id=$1",[claim.id]);
      return {generation:String(a.generation),cycle:String(a.cycle),requestId,epoch,policyHash:a.armed_policy_hmac,umkVersion:a.armed_umk_version};
    }).then(async permit=>{if(permit&&'clearReason' in permit){await this.hold(claim,permit.clearReason as GridAutoResumeReason,true,permit);return null;}if(permit&&'expired' in permit){await this.hold(claim,'retry_limit',true,permit);return null;}return permit;});
  }
  async transient(claim:GridMonitorClaim,permit:GridAutoResumeToken){
    const exhausted=await this.monitor.launch.transaction(async c=>{await this.monitor.assertLease(c,claim);const a=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1',[claim.id])).rows[0];return a&&String(a.generation)===permit.generation&&a.attempts>=3;});
    await this.hold(claim,exhausted?'retry_limit':'resume_authority_unavailable',!!exhausted,permit);
  }
  async valid(c:PoolClient,bot:any,permit:GridAutoResumeToken,tick?:string){
    const a=(await c.query('SELECT * FROM grid_auto_resume WHERE bot_id=$1',[bot.id])).rows[0];
    const l=(await c.query('SELECT * FROM grid_lifecycle WHERE bot_id=$1',[bot.id])).rows[0];
    if(!this.gates().startEnabled||!a?.enabled||(a.armed_epoch_id??null)!==(bot.active_epoch_id??null)||String(a.generation)!==permit.generation||String(a.armed_cycle)!==permit.cycle||a.resume_request_id!==permit.requestId||a.armed_policy_hmac!==permit.policyHash||a.armed_umk_version!==permit.umkVersion||String(a.armed_lifecycle_epoch)!==permit.epoch||l?.active_request!==permit.requestId||String(l.epoch)!==permit.epoch||bot.status!=='resuming'||!await this.security(c,bot,permit))return false;
    if(a.first_attempt_at&&new Date(bot.db_now).getTime()-new Date(a.first_attempt_at).getTime()>=120000)return false;
    if(tick){const m=(await c.query('SELECT * FROM grid_monitor_state WHERE bot_id=$1',[bot.id])).rows[0];return !!m?.observation?.mark&&freshGridFact(m.observation.mark.observedAt,new Date(bot.db_now).getTime())&&gridInsideAutoResumeBand(m.observation.mark.price,gridAutoResumeBand(bot.lower_price,bot.upper_price,tick));}
    return true;
  }
  async current(claim:GridMonitorClaim,permit:GridAutoResumeToken,tick?:string){return this.monitor.launch.transaction(async c=>this.valid(c,await this.monitor.assertLease(c,claim),permit,tick));}
}
import {refuseRescueMutation} from '../grid-worker/rescue-recovery';
