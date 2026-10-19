import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { deriveSubkey, zeroizeBuffer } from '../crypto-v3';
import { GridLifecycleStorage } from './lifecycle-storage';
import type { GridMonitorClaim } from './monitor-storage';
import { readCycleState } from './cycle-storage';
import { replayGridCycles, type CycleReplayInput } from './cycle-replay';
import { epochDigest, GRID_RANGE_MOVE_ENABLED, GRID_MOVE_REVISION, type EpochCarry } from './epoch-policy';
import { candidateGridEpoch, qualifyGridDow } from './move-policy';
import { computeGridPolicyHmac, canonicalGridPolicy, type GridPolicy } from './policy-hmac';
import { preflightGridResume, type LaunchFacts } from './provision';
import { gridResumeClearance, type GridResumeRisk } from './resume-clearance';
import { stableGridExtension } from './behaviour-policy';
import type { PlannerCandle } from '../grid-planner/types';
import type { GridRebalanceLevel } from './rebalance';

export class GridMoveError extends Error {}
export interface GridMoveAuthority { facts:LaunchFacts; risk:GridResumeRisk; candles:PlannerCandle[]; umk:Buffer; cleanup:()=>void }
export interface GridMoveProposal {
  botId:string; wallet:string; account:string; originEpochId:string; epochId:string; ordinal:number;
  lifecycleEpoch:string; settingsGeneration:string; bandRequestId:string; policyHmac:string;
  createdAt:number; expiresAt:number; carryDigest:string; constraintsDigest:string;
  policy:GridPolicy; displacement:string; confirmation:ReturnType<typeof qualifyGridDow>;
}
export function gridMoveProposalHash(p:GridMoveProposal,key:Buffer){
  const subkey=deriveSubkey(key,'grid_move_proposal');
  try{return createHmac('sha256',subkey).update(stableGridExtension(p as any)).digest('hex');}finally{zeroizeBuffer(subkey);}
}
const constraints=(f:LaunchFacts)=>epochDigest({tick:f.tick,lot:f.lot,min:f.minimumQuote,max:f.maximumQuote,low:f.minimumPrice,high:f.maximumPrice,
  maker:f.maker.effectiveRate,profit:f.profit.effectiveRate,agent:f.agentGeneration,account:f.account,master:f.masterAccount,leverage:f.margin.leverage});
export class GridMoveStorage {
  constructor(readonly lifecycle:GridLifecycleStorage,readonly collect:(wallet:string,id:string,signal:AbortSignal)=>Promise<GridMoveAuthority>,readonly enabled:()=>boolean=()=>GRID_RANGE_MOVE_ENABLED){}
  private requireEnabled(){if(!this.enabled())throw new GridMoveError('Range moving is not enabled');}
  private async lock(c:PoolClient,wallet:string,id:string){
    const account=(await c.query('SELECT a.* FROM grid_launch_accounts a JOIN grid_bots b ON b.id=a.bot_id WHERE a.bot_id=$1 AND b.wallet_address=$2 AND a.released_at IS NULL',[id,wallet])).rows[0];
    if(!account)throw new GridMoveError('The bot account is unavailable');
    await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[account.master_account]);
    const bot=(await c.query('SELECT *,clock_timestamp() AS db_now FROM grid_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE',[id,wallet])).rows[0];
    if(!bot)throw new GridMoveError('Bot not found');
    return {...bot,account:account.account,master_account:account.master_account};
  }
  async surface(wallet:string,id:string){
    this.requireEnabled();
    return this.lifecycle.monitor.launch.transaction(async c=>{
      const bot=(await c.query('SELECT id,direction,status,active_epoch_id FROM grid_bots WHERE id=$1 AND wallet_address=$2',[id,wallet])).rows[0];
      if(!bot)throw new GridMoveError('Bot not found');
      const setting=(await c.query('SELECT mode,generation FROM grid_trailing WHERE bot_id=$1',[id])).rows[0];
      const epochs=(await c.query('SELECT ordinal,lower_price,upper_price,stop_loss_price,activated_at,reason FROM grid_epochs WHERE bot_id=$1 ORDER BY ordinal DESC',[id])).rows;
      return {enabled:this.enabled(),mode:setting?.mode??'off',generation:String(setting?.generation??0),direction:bot.direction,
        available:this.enabled()&&bot.status==='range_exhausted'&&!!bot.active_epoch_id,epochs};
    });
  }
  async set(wallet:string,id:string,mode:'off'|'ask',generation:string){
    this.requireEnabled();if(!['off','ask'].includes(mode))throw new GridMoveError('Automatic following is unavailable');
    return this.lifecycle.monitor.launch.transaction(async c=>{
      const bot=await this.lock(c,wallet,id);if(['draft','failed','stopped','stopping'].includes(bot.status))throw new GridMoveError('Following is unavailable for this bot');
      await c.query('INSERT INTO grid_trailing(bot_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
      const result=await c.query('UPDATE grid_trailing SET mode=$2,generation=generation+1,updated_at=clock_timestamp() WHERE bot_id=$1 AND generation=$3 RETURNING mode,generation',[id,mode,generation]);
      if(!result.rowCount)throw new GridMoveError('Following settings changed; refresh');return result.rows[0];
    });
  }
  private async context(c:PoolClient,bot:any,authority:GridMoveAuthority,proposal?:GridMoveProposal,activating=false){
    const now=new Date(bot.db_now).getTime(),id=bot.id;
    if(!bot.active_epoch_id||!['2.2.0','2.3.0'].includes(bot.policy_version)||bot.consecutive_failures>=5)throw new GridMoveError('This bot is not eligible for range moving');
    const life=(await c.query('SELECT l.*,r.action,r.state FROM grid_lifecycle l LEFT JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1',[id])).rows[0];
    if(activating?bot.status!=='pausing'||life?.action!=='regrid'||life.state!=='pending':bot.status!=='range_exhausted'||life?.state==='pending')throw new GridMoveError('The completed range has changed');
    const band=(await c.query("SELECT * FROM grid_control_requests WHERE bot_id=$1 AND action='band' AND state='complete' ORDER BY completed_at DESC LIMIT 1",[id])).rows[0];
    const epochs=(await c.query('SELECT * FROM grid_epochs WHERE bot_id=$1 ORDER BY ordinal',[id])).rows;
    const origin=epochs.at(-1);if(!origin||origin.id!==bot.active_epoch_id||!band||new Date(band.completed_at).getTime()<new Date(origin.activated_at).getTime())throw new GridMoveError('A completed band event is required on this range');
    const setting=(await c.query('SELECT * FROM grid_trailing WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];
    if(!setting||setting.policy_revision!==GRID_MOVE_REVISION)throw new GridMoveError('Following policy is unavailable');
    if(proposal&&(proposal.originEpochId!==origin.id||proposal.settingsGeneration!==String(setting.generation)||proposal.bandRequestId!==band.id
      ||proposal.policyHmac!==bot.policy_hmac||proposal.account!==bot.account||proposal.wallet!==bot.wallet_address||proposal.expiresAt<=now||proposal.createdAt>now
      ||proposal.expiresAt-proposal.createdAt!==60000||(!activating&&proposal.lifecycleEpoch!==String(life.epoch))))throw new GridMoveError('Move confirmation expired or its authority changed');
    const moves=epochs.slice(1),last=moves.at(-1),first=epochs[0];
    if(moves.length>=setting.lifetime_limit||moves.filter(e=>new Date(e.activated_at).getTime()>now-86400000).length>=setting.daily_limit
      ||last&&now-new Date(last.activated_at).getTime()<Number(setting.cooldown_ms))throw new GridMoveError('The retained range-move limit has been reached');
    if((await c.query("SELECT 1 FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[id])).rowCount)throw new GridMoveError('An operation is unresolved; its reservation stays in place');
    await c.query('SELECT id FROM grid_levels WHERE bot_id=$1 AND epoch_id=$2 ORDER BY ordinal FOR UPDATE',[id,origin.id]);
    const history=await readCycleState(c,bot,bot.account,now),f=authority.facts;
    if(f.account!==bot.account||f.masterAccount!==bot.master_account||f.observedAt>now||now-f.observedAt>=5000||f.expiresAt<=now||f.agentGeneration.wallet!==bot.wallet_address)throw new GridMoveError('Fresh account authority is required');
    if(!await this.lifecycle.auto.security(c,bot,{policyHash:bot.policy_hmac,umkVersion:f.agentGeneration.umkVersion}))throw new GridMoveError('Execution authority changed');
    const mark=history.state.observation.mark;
    if(!mark||mark.observedAt>now||now-mark.observedAt>=5000)throw new GridMoveError('Fresh market and account observations are required');
    const exported=replayGridCycles({...history.input,exportEpochId:origin.id,projectClosingCancellation:!activating});
    if(!exported.ok||!exported.carry)throw new GridMoveError(exported.ok?'Carry unavailable':exported.reason);
    const carry=exported.carry;
    let confirmation:ReturnType<typeof qualifyGridDow>;try{confirmation=qualifyGridDow({policy:history.policy,timeframe:bot.chart_timeframe,candles:authority.candles,now,after:Math.max(new Date(band.completed_at).getTime(),new Date(origin.activated_at).getTime())});}catch(error){throw new GridMoveError((error as Error).message);}
    let candidate:ReturnType<typeof candidateGridEpoch>;try{candidate=candidateGridEpoch({policy:history.policy,policyHmac:bot.policy_hmac,epochId:proposal?.epochId??randomUUID(),originEpochId:origin.id,ordinal:origin.ordinal+1,
      carry,facts:f,close:confirmation.close,mark:mark.price});}catch(error){throw new GridMoveError((error as Error).message);}
    if(new Decimal(candidate.policy.lowerPrice).minus(first.lower_price).abs().gt(new Decimal(first.upper_price).minus(first.lower_price)))throw new GridMoveError('The original range-width move limit has been reached');
    if(!gridResumeClearance(authority.risk,history.state.observation,candidate.policy,f.tick,now))throw new GridMoveError('Current liquidation clearance is unavailable');
    const signed=computeGridPolicyHmac(candidate.policy,authority.umk);if(!signed.ok)throw new GridMoveError('Moved policy cannot be signed');
    const replay:CycleReplayInput={policy:candidate.policy,account:bot.account,historyComplete:true,carry,operations:[],fills:[],allocations:[],progress:[]};
    const canaryLimit=new Decimal(candidate.policy.totalInvestment).mul(candidate.policy.leverage).toFixed();
    const preflight=preflightGridResume(candidate.policy,signed.digest,authority.umk,f,now,{direction:candidate.policy.direction,
      levels:candidate.policy.levels.map((l):GridRebalanceLevel=>({...l,id:'preview:'+l.ordinal,attempt:0,status:'pending'})),fills:[],reserved:[],owned:[],positionSize:history.state.observation.position?.size??null,
      bookPrice:f.bookPrice,lot:f.lot,minimumQuote:f.minimumQuote,freeSlots:f.availableSlots,inventoryComplete:true,entriesAllowed:true,canaryRemaining:canaryLimit,cycleReplay:replay});
    if(!preflight.ok)throw new GridMoveError(preflight.reason);
    if(proposal&&(proposal.carryDigest!==epochDigest(carry)||proposal.constraintsDigest!==constraints(f)||canonicalGridPolicy(proposal.policy)!==canonicalGridPolicy(candidate.policy)
      ||proposal.confirmation.candleDigest!==confirmation.candleDigest))throw new GridMoveError('Holdings, candles or market limits changed; confirm a new move');
    return {now,life,band,origin,setting,carry,confirmation,candidate,signed,canaryLimit};
  }
  async proposal(wallet:string,id:string,signal:AbortSignal){
    this.requireEnabled();const authority=await this.collect(wallet,id,signal);
    try{return await this.lifecycle.monitor.launch.transaction(async c=>{
      const bot=await this.lock(c,wallet,id),v=await this.context(c,bot,authority);
      const p:GridMoveProposal={botId:id,wallet,account:bot.account,originEpochId:v.origin.id,epochId:v.candidate.policy.epochAuthority!.epochId,ordinal:v.origin.ordinal+1,
        lifecycleEpoch:String(v.life.epoch),settingsGeneration:String(v.setting.generation),bandRequestId:v.band.id,policyHmac:bot.policy_hmac,
        createdAt:v.now,expiresAt:v.now+60000,carryDigest:epochDigest(v.carry),constraintsDigest:constraints(authority.facts),policy:v.candidate.policy,
        displacement:v.candidate.displacement,confirmation:v.confirmation};
      return {proposal:p,proposalHash:gridMoveProposalHash(p,authority.umk),old:{lower:bot.lower_price,upper:bot.upper_price,stop:bot.stop_loss_price}};
    });}finally{authority.cleanup();}
  }
  async confirm(wallet:string,id:string,key:string,p:GridMoveProposal,proposalHash:string,signal:AbortSignal){
    this.requireEnabled();if(!p||p.botId!==id||p.wallet!==wallet||JSON.stringify(p).length>100000||!/^[0-9a-f]{64}$/.test(proposalHash))throw new GridMoveError('Invalid move confirmation');
    const authority=await this.collect(wallet,id,signal);
    try{
      if(!timingSafeEqual(Buffer.from(gridMoveProposalHash(p,authority.umk),'hex'),Buffer.from(proposalHash,'hex')))throw new GridMoveError('Move confirmation signature changed');
      return await this.lifecycle.monitor.launch.transaction(async c=>{
        const bot=await this.lock(c,wallet,id);
        const prior=(await c.query('SELECT r.*,k.evidence AS requested_evidence FROM grid_control_keys k JOIN grid_control_requests r ON r.id=k.control_id WHERE k.bot_id=$1 AND k.request_key=$2',[id,key])).rows[0];
        if(prior){if(prior.action!=='regrid'||prior.requested_evidence?.proposalHash!==proposalHash)throw new GridMoveError('Request identity changed');return {id:prior.id,state:prior.state};}
        await this.context(c,bot,authority,p);
        const requestId=randomUUID(),evidence={proposal:p,proposalHash};
        await this.lifecycle.auto.revoke(c,id,false,'policy_changed');
        await c.query("INSERT INTO grid_control_requests(id,bot_id,request_key,action,source,previous_status,evidence,origin_epoch_id) VALUES($1,$2,$3,'regrid','owner','range_exhausted',$4,$5)",[requestId,id,key,evidence,bot.active_epoch_id]);
        await c.query('INSERT INTO grid_control_keys(bot_id,request_key,control_id,evidence) VALUES($1,$2,$3,$4)',[id,key,requestId,evidence]);
        await c.query('UPDATE grid_lifecycle SET epoch=epoch+1,active_request=$2,blocker=NULL,terminal_proof=NULL WHERE bot_id=$1',[id,requestId]);
        await c.query("UPDATE grid_bots SET status='pausing',pause_reason='regrid',updated_at=clock_timestamp() WHERE id=$1",[id]);
        await c.query('UPDATE grid_monitor_state SET boot_id=NULL,generation=generation+1 WHERE bot_id=$1',[id]);
        return {id:requestId,state:'pending'};
      });
    }finally{authority.cleanup();}
  }
  async activate(claim:GridMonitorClaim,signal:AbortSignal){
    this.requireEnabled();const snapshot=await this.lifecycle.monitor.snapshot(claim),authority=await this.collect(snapshot.bot.wallet_address,claim.id,signal);
    try{return await this.lifecycle.monitor.launch.transaction(async c=>{
      const bot=await this.lock(c,snapshot.bot.wallet_address,claim.id);await this.lifecycle.monitor.assertLease(c,claim);
      const request=(await c.query("SELECT r.* FROM grid_lifecycle l JOIN grid_control_requests r ON r.id=l.active_request WHERE l.bot_id=$1 AND r.action='regrid' AND r.state='pending'",[claim.id])).rows[0];
      if(!request)return 'move_superseded';
      const p=request.evidence.proposal as GridMoveProposal;
      if(request.evidence.proposalHash!==gridMoveProposalHash(p,authority.umk))throw new GridMoveError('Move confirmation signature changed');
      let v:Awaited<ReturnType<GridMoveStorage['context']>>;
      try{v=await this.context(c,bot,authority,p,true);}catch(error){
        if(!(error instanceof GridMoveError))throw error;
        await c.query("UPDATE grid_control_requests SET state='superseded',completed_at=clock_timestamp() WHERE id=$1",[request.id]);
        await c.query("UPDATE grid_bots SET status='range_exhausted',pause_reason='move_confirmation_required' WHERE id=$1",[claim.id]);
        await c.query('UPDATE grid_lifecycle SET epoch=epoch+1,blocker=$2 WHERE bot_id=$1',[claim.id,error.message]);return 'move_confirmation_required';
      }
      const policy=v.candidate.policy,epochId=policy.epochAuthority!.epochId;
      await c.query(`INSERT INTO grid_epochs(id,bot_id,ordinal,predecessor_id,creating_control_request_id,policy_version,policy_snapshot,policy_hmac,carry_snapshot,carry_digest,confirmation,reason,activated_at,direction,lower_price,upper_price,stop_loss_price,grid_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual_dow',clock_timestamp(),$12,$13,$14,$15,$16)`,
        [epochId,claim.id,p.ordinal,p.originEpochId,request.id,policy.policyVersion,policy,v.signed.digest,v.carry,epochDigest(v.carry),v.confirmation,policy.direction,policy.lowerPrice,policy.upperPrice,policy.stopLossPrice,policy.gridCount]);
      // Old stop remains authoritative until this single atomic pointer/geometry/stop switch.
      await c.query(`UPDATE grid_bots SET active_epoch_id=$2,lower_price=$3,upper_price=$4,start_price=$5,stop_loss_price=$6,policy_version=$7,runtime_policy_version=$7,policy_hmac=$8,
        authority_snapshot=authority_snapshot||$9::jsonb,status='canary',pause_reason=NULL,canary_started_at=clock_timestamp(),canary_clean_since=NULL,canary_clean_ticks=0,updated_at=clock_timestamp() WHERE id=$1`,
        [claim.id,epochId,policy.lowerPrice,policy.upperPrice,policy.startPrice,policy.stopLossPrice,policy.policyVersion,v.signed.digest,{gridEpoch:policy.epochAuthority,gridSizing:{sizingVersion:policy.sizingVersion,safetyEnvelopePrice:policy.safetyEnvelopePrice},gridPolicyExtension:policy.gridPolicyExtension}]);
      await c.query('UPDATE grid_launch_accounts SET canary_limit=$2 WHERE bot_id=$1',[claim.id,v.canaryLimit]);
      for(const l of policy.levels)await c.query('INSERT INTO grid_levels(id,bot_id,epoch_id,ordinal,price,size,side,reduce_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),claim.id,epochId,l.ordinal,l.price,l.size,l.side,l.reduceOnly]);
      await c.query("UPDATE grid_control_requests SET state='complete',completed_at=clock_timestamp() WHERE id=$1",[request.id]);
      await c.query('UPDATE grid_lifecycle SET epoch=epoch+1,blocker=NULL,terminal_proof=NULL WHERE bot_id=$1',[claim.id]);
      await c.query("UPDATE grid_monitor_state SET boot_id=NULL,generation=generation+1,blocked_reasons='[\"epoch_reconciliation_required\"]' WHERE bot_id=$1",[claim.id]);
      await c.query("UPDATE grid_risk_events SET event_key=event_key||':'||$2 WHERE bot_id=$1 AND event_key IN ('canary-clock','cycle-projection')",[claim.id,p.originEpochId]);
      await c.query("INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence) VALUES($1,$2,'range_moved',$3) ON CONFLICT DO NOTHING",[claim.id,'epoch:'+epochId,{controlRequestId:request.id,epochId,lower:policy.lowerPrice,upper:policy.upperPrice,stop:policy.stopLossPrice}]);
      return 'range_moved';
    });}finally{authority.cleanup();}
  }
}
