import {createHash,randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import type {Pool,PoolClient} from 'pg';
import {requireSchemaCapabilityReady} from '../schema-readiness';
export const canonicalRequest=(x:unknown):string=>JSON.stringify(x,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const requestDigest=(x:unknown)=>createHash('sha256').update(canonicalRequest(x)).digest('hex');
export interface ExactGridRequest {
  kind:'create'|'fund'|'leverage'|'seed'|'limit'|'cancel'; botId:string; account:string; masterAccount:string;
  path:string; operationType:string; timestamp:number; expiryMs:number; data:Record<string,unknown>;
  authority:Record<string,unknown>;
}
export interface GridClaim {
  credits:string; slots:0|1; canaryIncrement:string; observedCredits:string; availableSlots:number;
  observedAt:number; expiresAt:number;
}
export interface DurableGridOperation {id:string;state:string;exact_request:ExactGridRequest;exact_request_digest:string;failure_classification:string|null}
const typeFor={create:'provision_subaccount',fund:'fund_subaccount',leverage:'set_leverage',seed:'seed_position',limit:'place_level_order',cancel:'cancel_level_order'};
export class GridLaunchTransientError extends Error {}
/** Lock order is always master, then bot. No deployment identity partitions a master's quota. */
export class GridLaunchStorage {
  constructor(private pool:Pool,private ready=()=>requireSchemaCapabilityReady('grid_bot',async(q,v)=>pool.query(q,v?[...v]:undefined))){}
  async transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{
    await this.ready();const c=await this.pool.connect();
    try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async read(botId:string,key:string):Promise<DurableGridOperation|null>{
    await this.ready();return (await this.pool.query('SELECT * FROM grid_operations WHERE bot_id=$1 AND idempotency_key=$2',[botId,key])).rows[0]??null;
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
        FROM grid_bots b WHERE o.id=$1 AND o.bot_id=b.id AND o.state='prepared' AND o.exact_request_digest=$2 AND b.lease_token=$3
        AND b.lease_expires_at>clock_timestamp() AND ($4::bigint+$5::bigint)<=extract(epoch from clock_timestamp())*1000 RETURNING o.id`,
        [op.id,op.exact_request_digest,leaseToken,op.exact_request.timestamp,op.exact_request.expiryMs]);
      if(r.rowCount)await c.query('UPDATE grid_execution_claims SET settled_at=clock_timestamp(),slot_released=true WHERE operation_id=$1',[op.id]);
      return !!r.rowCount;
    });
  }
  async prepare(key:string,request:ExactGridRequest,claim:GridClaim,leaseToken:string):Promise<DurableGridOperation>{
    const exact=JSON.parse(canonicalRequest(request)) as ExactGridRequest,digest=requestDigest(exact);
    if(!request.botId || !request.account || !request.masterAccount || !Number.isSafeInteger(request.timestamp)
      || !Number.isSafeInteger(request.expiryMs) || request.expiryMs<1 || request.expiryMs>15000
      || !new Decimal(claim.credits).gte(10) || !new Decimal(claim.canaryIncrement).gte(0)
      || !Number.isSafeInteger(claim.availableSlots) || ![0,1].includes(claim.slots))throw Error('Invalid exact claim');
    if(claim.slots!==(request.kind==='limit'?1:0))throw Error('Invalid resting slot claim');
    const minimumRisk=request.kind==='limit'&&request.data.reduce_only===false?new Decimal(String(request.data.price)).mul(String(request.data.amount))
      :request.kind==='seed'?new Decimal(String(request.authority.seedWorstPrice)).mul(String(request.data.amount)):new Decimal(0);
    if(new Decimal(claim.canaryIncrement).lt(minimumRisk))throw Error('Understated canary commitment');
    return this.transaction(async c=>{
      const master=(await c.query('SELECT *,clock_timestamp() AS clock FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[request.masterAccount])).rows[0];
      if(!master)throw Error('Master quota unavailable');const now=new Date(master.clock).getTime();
      const bot=(await c.query('SELECT b.*,a.account,a.master_account,a.canary_limit,a.canary_committed,a.released_at FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id WHERE b.id=$1 FOR UPDATE OF b,a',[request.botId])).rows[0];
      if(!bot || bot.released_at || bot.account!==request.account || bot.master_account!==request.masterAccount || bot.lease_token!==leaseToken
        || new Date(bot.lease_expires_at).getTime()<=now || !['provisioning','canary','active'].includes(bot.status))throw Error('Lost Grid ownership');
      const old=(await c.query('SELECT * FROM grid_operations WHERE idempotency_key=$1',[key])).rows[0];
      if(old){if(old.bot_id!==request.botId || old.exact_request_digest!==digest || canonicalRequest(old.exact_request)!==canonicalRequest(exact))throw Error('Exact request conflict');return old;}
      if((await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[request.botId])).rowCount)throw Error('Unresolved operation barrier');
      if(!Number.isSafeInteger(claim.observedAt) || !Number.isSafeInteger(claim.expiresAt) || claim.observedAt>now || claim.expiresAt<=now
        || claim.expiresAt-claim.observedAt>5000 || request.timestamp>now || request.timestamp+request.expiryMs<=now)throw Error('Stale admission');
      if(new Date(master.backoff_until).getTime()>now)throw new GridLaunchTransientError('Durable Grid rate-limit backoff');
      const quota=(await c.query(`SELECT (SELECT COALESCE(sum(credits),0) FROM grid_execution_claims
        WHERE master_account=$1 AND (settled_at IS NULL OR settled_at>clock_timestamp()-interval '60 seconds'))
        +(SELECT COALESCE(sum(credits),0) FROM grid_read_claims WHERE master_account=$1 AND claimed_at>clock_timestamp()-interval '60 seconds') AS used`,[request.masterAccount])).rows[0];
      // Unknown observed tier uses the owner-assumed 300; observations may only reduce that conservative floor.
      const ceiling=Decimal.min(300,claim.observedCredits).mul(master.share).floor();
      if(!ceiling.gt(0) || new Decimal(quota.used).plus(claim.credits).gt(ceiling))throw new GridLaunchTransientError('Grid fixed quota share exhausted');
      const slots=(await c.query('SELECT COALESCE(sum(slots),0) AS used FROM grid_execution_claims WHERE account=$1 AND NOT slot_released',[request.account])).rows[0];
      // Conservatively count all retained claims against observed free inventory. Never double-spend a snapshot.
      if(claim.slots && (new Decimal(slots.used).plus(claim.slots).gt(20) || claim.availableSlots-Number(slots.used)-claim.slots<5))throw Error('Grid subaccount slots unavailable');
      if(bot.status!=='active' && new Decimal(bot.canary_committed).plus(claim.canaryIncrement).gt(bot.canary_limit))throw Error('Canary commitment exceeded');
      const id=randomUUID();
      const levelId=request.authority.levelId??null;
      if(request.kind==='limit'||request.kind==='cancel'){
        const level=(await c.query('SELECT * FROM grid_levels WHERE id=$1 AND bot_id=$2 FOR UPDATE',[levelId,request.botId])).rows[0];
        if(!level)throw Error('Grid level ownership unavailable');
        if(request.kind==='limit'&&(!['pending','cancelled'].includes(level.status)||level.placement_attempt!==request.authority.levelAttempt
          || !new Decimal(level.price).eq(String(request.data.price))||!new Decimal(level.size).eq(String(request.data.amount))||level.reduce_only!==request.data.reduce_only
          || (level.side==='buy'?'bid':'ask')!==request.data.side))throw Error('Grid signed level changed');
        if(request.kind==='cancel'&&(!['active','partially_filled'].includes(level.status)||level.venue_order_id!==String(request.data.order_id)))throw Error('Grid cancel identity changed');
        await c.query('UPDATE grid_levels SET status=$2,client_order_uuid=COALESCE($3,client_order_uuid),updated_at=clock_timestamp() WHERE id=$1',[levelId,request.kind==='limit'?'submitting':'cancelling',request.data.client_order_id??null]);
      }
      const result=await c.query(`INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type,client_order_uuid,exact_request,exact_request_digest,level_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,request.botId,key,digest,typeFor[request.kind],request.data.client_order_id??null,exact,digest,levelId]);
      await c.query('INSERT INTO grid_execution_claims(operation_id,bot_id,master_account,account,credits,slots,canary_increment) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,request.botId,request.masterAccount,request.account,claim.credits,claim.slots,claim.canaryIncrement]);
      if(bot.status!=='active')await c.query('UPDATE grid_launch_accounts SET canary_committed=canary_committed+$2 WHERE bot_id=$1',[request.botId,claim.canaryIncrement]);
      return result.rows[0];
    });
  }
  async submit(op:DurableGridOperation,leaseToken:string):Promise<boolean>{
    if(requestDigest(op.exact_request)!==op.exact_request_digest)return false;
    return this.transaction(async c=>{
      const q=(await c.query('SELECT backoff_until>clock_timestamp() AS blocked FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[op.exact_request.masterAccount])).rows[0];
      if(!q||q.blocked)return false;
      // The CAS makes a crash before POST uncertain. A new worker never adopts permission to resend.
      const r=await c.query(`UPDATE grid_operations o SET state='submitted',submitted_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM grid_bots b WHERE o.id=$1 AND o.bot_id=b.id AND o.state='prepared' AND o.exact_request_digest=$2
        AND b.lease_token=$3 AND b.lease_expires_at>clock_timestamp() AND b.status IN ('provisioning','canary','active')
        AND ($4::bigint+$5::bigint)>extract(epoch from clock_timestamp())*1000 RETURNING o.id`,
      [op.id,op.exact_request_digest,leaseToken,op.exact_request.timestamp,op.exact_request.expiryMs]);return !!r.rowCount;
    });
  }
  async settle(op:DurableGridOperation,outcome:{state:'confirmed'|'failed'|'unconfirmed';reason:string|null;releaseSlot:boolean;rateLimited?:boolean;orderId?:string}){
    return this.transaction(async c=>{
      await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[op.exact_request.masterAccount]);
      const r=await c.query(`UPDATE grid_operations SET state=$2,failure_classification=$3,terminal_at=CASE WHEN $2='unconfirmed' THEN NULL ELSE clock_timestamp() END,
        updated_at=clock_timestamp() WHERE id=$1 AND state IN ('submitted','unconfirmed') AND exact_request_digest=$4 RETURNING id`,[op.id,outcome.state,outcome.reason,op.exact_request_digest]);
      if(!r.rowCount)throw Error('Settlement CAS conflict');
      if(outcome.state!=='unconfirmed')await c.query('UPDATE grid_execution_claims SET settled_at=clock_timestamp(),slot_released=$2 WHERE operation_id=$1',[op.id,outcome.releaseSlot]);
      if(outcome.orderId)await c.query('UPDATE grid_operations SET venue_order_id=$2 WHERE id=$1',[op.id,outcome.orderId]);
      if(outcome.state==='confirmed'&&['seed','limit'].includes(op.exact_request.kind))await c.query('UPDATE grid_bots SET canary_started_at=COALESCE(canary_started_at,clock_timestamp()) WHERE id=$1',[op.exact_request.botId]);
      if(op.exact_request.kind==='limit'&&outcome.state!=='unconfirmed'){
        const status=outcome.reason==='expected_rejection'?'pending':outcome.state==='failed'?'failed':outcome.releaseSlot?'filled':'active';
        await c.query('UPDATE grid_levels SET status=$2,venue_order_id=$3,placement_attempt=placement_attempt+CASE WHEN $4 THEN 1 ELSE 0 END,updated_at=clock_timestamp() WHERE id=$1 AND bot_id=$5',
          [op.exact_request.authority.levelId,status,outcome.orderId??null,outcome.reason==='expected_rejection',op.exact_request.botId]);
      }
      if(op.exact_request.kind==='cancel'&&outcome.state==='confirmed'){
        await c.query("UPDATE grid_levels SET status='cancelled',placement_attempt=placement_attempt+1,updated_at=clock_timestamp() WHERE id=$1 AND bot_id=$2",[op.exact_request.authority.levelId,op.exact_request.botId]);
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
