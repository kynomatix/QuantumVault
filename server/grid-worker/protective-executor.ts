import {randomUUID} from 'node:crypto';
import {waitGridWorkerFence} from '../grid-bot/worker-ownership';
import type {Pool,PoolClient} from 'pg';
import {GridLaunchStorage} from '../grid-bot/launch-storage-core';
import {GridMonitorStorage} from '../grid-bot/monitor-storage';
import {GridLifecycleStorage} from '../grid-bot/lifecycle-storage';
import {gridLifecycleCore} from '../grid-bot/lifecycle-core';
import {GridLaunchReads} from '../grid-bot/launch-reads';
import {GridMonitorReads} from '../grid-bot/monitor-reads';
import type {GridRuntimeDependencies} from '../grid-bot/runtime-dependencies';
import {getExecutionUmk} from '../execution/umk';
import {fencedTransaction,walletFences,GridDeadline} from './transaction';
import {localContext} from './host';
import {identityFences} from './identity-locks';
import {currentAuthority} from './authority';
import {parseOwnerMessage,ownerSha256} from './owner-auth';
import {verifyOwnerReceipt,requireVerifiedOwner} from './owner-receipts';
import {encodeProtectiveConsent,protectiveConsentMac,verifyProtectiveConsent,PROTECTIVE_DRAFT,PROTECTIVE_UNUSED_DIGEST,type ProtectiveConsent} from './protective-consent';
import {rescueOffer,rescueWait,rescueView,RescueRefusal,type RescueView} from './rescue-state';
import {GridIncidents} from './incidents';
import {resolveProtection} from './protection-truth';
import {mainQuota} from './main-quota';
import {readQuotaPolicies} from './quota';
import {recoverAbandonedRescues} from './rescue-recovery';
import {withProtectivePurpose} from './protective-purpose';

export interface RescueInput{botId:string;message:string;signature:string}
export class ProtectiveExecutor{
  private incidents:GridIncidents;
  constructor(private pool:Pool,private terminate:(pid:number)=>Promise<void>,private dependencies:GridRuntimeDependencies,
    private ready:(c:PoolClient)=>Promise<void>){this.incidents=new GridIncidents(pool,terminate);}
  /** No network I/O. Receipt, Stop, consent and transition either all commit or all roll back. */
  async start(owner:string,input:RescueInput):Promise<RescueView>{
    const message=parseOwnerMessage(input.message);
    if(message.action!=='break_glass_close'||message.target!=='bot:'+input.botId)throw new RescueRefusal('changed');
    const requestKey=ownerSha256(message.nonce),requestId=randomUUID();
    await fencedTransaction(this.pool,async c=>{
      await this.ready(c);await walletFences(c,[owner]);await waitGridWorkerFence(c,input.botId);await identityFences(c,[input.botId],[]);
      await recoverAbandonedRescues(c);
      const offer=await rescueOffer(c,owner,input.botId);
      if(!offer)throw new RescueRefusal('changed');if(offer.blockedBy)throw new RescueRefusal(offer.blockedBy);
      if(await rescueWait(c,input.botId)>480)throw new RescueRefusal('wait_too_long');
      const h=(await c.query('SELECT *,clock_timestamp() AS db_now FROM grid_worker_host WHERE singleton_id=1 FOR UPDATE')).rows[0];
      if(!h||h.owner_wallet!==owner)throw new RescueRefusal('not_owner');
      const master=(await c.query('SELECT agent_public_key FROM wallets WHERE address=$1',[owner])).rows[0]?.agent_public_key;
      const authority=await currentAuthority(c,{botId:input.botId,wallet:owner,masterAccount:master,workerExposure:true});
      if(authority.generation===null)throw new RescueRefusal('changed');
      const key=await getExecutionUmk(c,owner);if(!key)throw new RescueRefusal('automated_trading_off');
      try{
        const receipt=await verifyOwnerReceipt(c,{message:input.message,signature:input.signature,signer:owner,sessionWallet:owner,params:{botId:input.botId}});
        requireVerifiedOwner(receipt,'break_glass_close','bot:'+input.botId);
        await c.query("SELECT grid_worker_consume_receipt($1::uuid,'break_glass_close',$2,$3)",[receipt.receiptId,receipt.target,receipt.paramsDigest]);
        const now=new Date(h.db_now).getTime();
        const consent:ProtectiveConsent={version:'1',action:'protective_close',owner,botId:input.botId,walletGeneration:authority.generation,
          scopeRevision:String(h.scope_revision),requestKey,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString()};
        const intentDigest=ownerSha256(encodeProtectiveConsent(consent));
        // Unused draft/policy fields are fixed. Both intent digest columns bind the canonical protective intent.
        await c.query(`INSERT INTO grid_worker_requests(id,owner_wallet,bot_id,action,request_key,draft_revision,server_intent_digest,
          policy_hmac,spending_policy_digest,wallet_generation,scope_revision,consent_version,consent_mac,issued_at,expires_at,state,admitted_at,result_code)
          VALUES($1,$2,$3,'protective_close',$4,$5,$6,$7,$6,$8,$9,'1',$10,$11,$12,'admitted',clock_timestamp(),'waiting')`,
          [requestId,owner,input.botId,requestKey,PROTECTIVE_DRAFT,intentDigest,PROTECTIVE_UNUSED_DIGEST,authority.generation,h.scope_revision,
            protectiveConsentMac(consent,key.umk),consent.issuedAt,consent.expiresAt]);
        const ledger=new GridLaunchStorage(this.pool,async()=>{}),lifecycle=new GridLifecycleStorage(new GridMonitorStorage(ledger));
        await lifecycle.request(owner,input.botId,'rescue:'+requestId,'stop',{protectiveRequestId:requestId},'owner',undefined,c);
        await localContext(c,'transition');
        await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
        await c.query(`UPDATE grid_worker_host SET entries_paused=true,
          pause_revision=pause_revision+CASE WHEN entries_paused THEN 0 ELSE 1 END,
          pause_ack_at=CASE WHEN entries_paused THEN pause_ack_at ELSE NULL END,
          pause_ack_revision=CASE WHEN entries_paused THEN pause_ack_revision ELSE NULL END,
          holder_role='protective',holder_boot_id=$1,fencing_epoch=fencing_epoch+1,
          lease_expires_at=clock_timestamp()+interval '45 seconds',heartbeat_at=clock_timestamp() WHERE singleton_id=1`,[requestId]);
      }finally{key.cleanup();}
    },{mode:'exclusive',terminate:this.terminate});
    return fencedTransaction(this.pool,async c=>{const view=await rescueView(c,owner,requestKey);if(!view)throw Error('GRID_RESCUE_START_UNKNOWN');return view;},{mode:'none',terminate:this.terminate});
  }
  async step(owner:string,requestId:string):Promise<RescueView|{next:'wait';retryAfterSeconds:2}>{
    let failure:RescueRefusal|undefined,botId:string|undefined;
    try{
      const result=await fencedTransaction(this.pool,async(c,budget)=>{
        await this.ready(c);
        const r=(await c.query("SELECT * FROM grid_worker_requests WHERE id=$1 AND action='protective_close' FOR NO KEY UPDATE NOWAIT",[requestId])).rows[0];
        if(!r||r.owner_wallet!==owner)throw new RescueRefusal('not_owner');
        botId=r.bot_id;
        if(r.state!=='admitted'){const done=await rescueView(c,owner,r.request_key);if(!done)throw new RescueRefusal('changed');return done;}
        const h=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live,clock_timestamp() AS db_now FROM grid_worker_host WHERE singleton_id=1')).rows[0];
        const ended=new Date(r.expires_at).getTime()<=new Date(h.db_now).getTime()?'expired':h.holder_boot_id!==requestId||h.holder_role!=='protective'?'superseded':!h.live?'lease_lost':null;
        if(ended){
          await this.finish(c,r,'ended');failure=new RescueRefusal(ended);return (await rescueView(c,owner,r.request_key))!;
        }
        const epoch=String(h.fencing_epoch);
        const validate=async(client:PoolClient)=>{
          const key=await getExecutionUmk(client,owner);if(!key)throw new RescueRefusal('automated_trading_off');
          try{await verifyProtectiveConsent(client,r,key.umk);}finally{key.cleanup();}
        };
        await validate(c);
        // Commit the renewal separately: retaining its host row lock would block inner send transactions.
        await fencedTransaction(this.pool,async client=>{
          await localContext(client,'heartbeat',{bootId:requestId,epoch});
          const renewed=await client.query(`UPDATE grid_worker_host SET lease_expires_at=least(clock_timestamp()+interval '45 seconds',$3::timestamptz),
            heartbeat_at=clock_timestamp() WHERE singleton_id=1 AND holder_boot_id=$1 AND holder_role='protective' AND fencing_epoch=$2
            AND lease_expires_at>clock_timestamp() AND $3::timestamptz>clock_timestamp() RETURNING singleton_id`,[requestId,epoch,r.expires_at]);
          if(renewed.rowCount!==1)throw new RescueRefusal('lease_lost');
        },{mode:'none',terminate:this.terminate,budget});
        mainQuota.install(await readQuotaPolicies(c));
        const wait=await rescueWait(c,r.bot_id,requestId);
        if(wait>0){await walletFences(c,[owner]);await identityFences(c,[r.bot_id],[]);await c.query("UPDATE grid_worker_requests SET result_code='waiting' WHERE id=$1",[requestId]);return (await rescueView(c,owner,r.request_key))!;}
        const ledger=new GridLaunchStorage(this.pool,async()=>budget.check(),undefined,undefined,
          {requestId,botId:r.bot_id,epoch,validate,terminate:this.terminate});
        const monitor=new GridMonitorStorage(ledger),claim=await monitor.claimProtective(requestId,r.bot_id);
        if(!claim)return {next:'wait' as const,retryAfterSeconds:2 as const};
        const json=new GridLaunchReads(this.dependencies.transport,ledger,'0.5',this.dependencies.fetcher),reads=new GridMonitorReads(json);
        const unresolved=(await c.query(`SELECT 1 FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed') LIMIT 1`,[r.bot_id])).rowCount;
        const attempts=Number((await c.query(`SELECT count(*) AS n FROM grid_operations WHERE bot_id=$1 AND exact_request->'authority'->>'protectiveRequestId'=$2
          AND exact_request->>'kind'='close'`,[r.bot_id,requestId])).rows[0].n);
        if(attempts>=3&&!unresolved){await this.finish(c,r,await withProtectivePurpose(()=>this.verify(c,json,claim,budget))?'complete':'partial_ended');return (await rescueView(c,owner,r.request_key))!;}
        const lifecycle=gridLifecycleCore(monitor,reads,json,this.dependencies,{},true);
        const outcome=await lifecycle.service.tick(claim,budget.abort.signal);budget.check();
        // Keep the request lock's idle interval below PostgreSQL's twelve-second ceiling.
        await walletFences(c,[owner]);await identityFences(c,[r.bot_id],[]);await c.query('SELECT 1');
        const blocker=(await c.query('SELECT blocker FROM grid_lifecycle WHERE bot_id=$1',[r.bot_id])).rows[0]?.blocker;
        const passes=(await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at)
          VALUES($1,$2,'internal_protection',jsonb_build_object('passes',CASE WHEN $3 THEN 1 ELSE 0 END),clock_timestamp())
          ON CONFLICT(bot_id,event_key) DO UPDATE SET evidence=jsonb_build_object('passes',
            CASE WHEN $3 THEN coalesce((grid_risk_events.evidence->>'passes')::integer,0)+1 ELSE 0 END),delivered_at=clock_timestamp()
          RETURNING evidence`,[r.bot_id,'rescue-blocked:'+requestId,!!blocker])).rows[0].evidence.passes;
        if(outcome==='protective_verify_required'&&await withProtectivePurpose(()=>this.verify(c,json,claim,budget)))await this.finish(c,r,'complete');
        else if(['unrelated_order_requires_review','failed','not_sent','position_direction_changed'].includes(outcome)
          ||/refused|failed|quota|backoff|rejection/.test(blocker??'')||passes>=3)await this.finish(c,r,'partial_ended');
        else await c.query("UPDATE grid_worker_requests SET result_code=$2 WHERE id=$1",[requestId,unresolved?'settling':outcome==='protective_verify_required'?'verifying':'closing']);
        return (await rescueView(c,owner,r.request_key))!;
      },{terminate:this.terminate,budget:new GridDeadline(11000)});
      if(failure)throw failure;return result;
    }catch(error){
      if((error as {code?:string})?.code==='55P03')return {next:'wait',retryAfterSeconds:2};
      if(botId&&!(error instanceof RescueRefusal))await this.incidents.record({code:'protective_failure',dedupKey:'protective-failure:'+botId,botId,bootId:requestId});
      throw error;
    }
  }
  private async finish(c:PoolClient,r:Record<string,any>,phase:'complete'|'partial_ended'|'ended'){
    await walletFences(c,[r.owner_wallet]);await identityFences(c,[r.bot_id],[]);
    const unknown=(await c.query(`SELECT 1 FROM grid_worker_send_audit WHERE bot_id=$1 AND outcome='unknown'
      UNION ALL SELECT 1 FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed') LIMIT 1`,[r.bot_id])).rowCount;
    const outcome=unknown?'unknown_ended':phase;
    await c.query(`UPDATE grid_worker_requests SET state=$2,result_code=$3,completed_at=clock_timestamp() WHERE id=$1 AND state='admitted'`,
      [r.id,'complete',outcome]);
    if(outcome==='complete')await resolveProtection(c,r.bot_id);
    else await c.query(`INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,bot_id,holder_boot_id,first_seen_at,last_seen_at)
      VALUES($1,$2,'critical','protective_failure',$3,$4,clock_timestamp(),clock_timestamp())
      ON CONFLICT(dedup_key) WHERE acknowledged_at IS NULL DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,resolved_at=NULL`,
      [randomUUID(),'protective-failure:'+r.bot_id,r.bot_id,r.id]);
  }
  private async verify(c:PoolClient,json:GridLaunchReads,claim:{id:string;leaseToken:string;account:string;masterAccount:string},budget:GridDeadline){
    if(await rescueWait(c,claim.id,claim.leaseToken)>0)return false;
    if((await c.query(`SELECT 1 FROM grid_worker_send_audit WHERE bot_id=$1 AND outcome='unknown'
      UNION ALL SELECT 1 FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed') LIMIT 1`,[claim.id])).rowCount)return false;
    for(const path of ['/positions','/orders']){
      let cursor:string|undefined;const seen=new Set<string>();
      for(let i=0;i<100;i++){
        const raw=await json.json(claim.masterAccount,path,{account:claim.account,...(cursor?{cursor}:{})},budget.abort.signal) as Record<string,any>;
        if(raw?.success!==true||!Array.isArray(raw.data)||raw.data.length!==0||typeof raw.has_more!=='boolean'
          ||raw.partial===true||raw.complete===false||raw.sequence_gap===true)return false;
        if(!raw.has_more){if(raw.next_cursor!=null)return false;break;}
        if(typeof raw.next_cursor!=='string'||!raw.next_cursor||seen.has(raw.next_cursor)||i===99)return false;
        cursor=raw.next_cursor;seen.add(cursor);
      }
    }
    const raw=await json.json(claim.masterAccount,'/account',{account:claim.account},budget.abort.signal) as Record<string,any>;
    const now=Date.now();return raw?.success===true&&raw.data?.positions_count===0&&raw.data.orders_count===0&&raw.data.stop_orders_count===0
      &&Number.isSafeInteger(raw.data.updated_at)&&raw.data.updated_at<=now&&now-raw.data.updated_at<5000;
  }
}
