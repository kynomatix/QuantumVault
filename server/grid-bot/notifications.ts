import type {Pool} from 'pg';
export interface GridNotificationEvent {bot_id:string;event_key:string;kind:string;evidence:Record<string,unknown>;wallet_address:string;market:string}
export function gridNotificationText(event:GridNotificationEvent){
  const labels:Record<string,string>={stop:'Stop requested; closing and settlement are not yet confirmed',band:'Range exhausted; holding the position',
    pause:'Pause requested',resume:'Resume requested',resync:'Re-sync requested',paused:'Paused; position may remain open',range_exhausted:'Range exhausted; position held',
    canary:'Resumed in canary mode',stopped:'Stopped; terminal settlement confirmed',sol_warning:'Execution wallet SOL is low',sol_entry_blocked:'Execution wallet SOL blocks new entries',sol_unknown:'Execution wallet SOL is UNKNOWN'};
  const reason=event.kind==='venue_capacity'?'Venue order capacity reached; new placements paused':event.evidence.reason==='circuit_breaker'?'Circuit breaker paused entries':labels[event.kind]??'Lifecycle event requires attention';
  return {title:'Grid Bot · '+event.market,body:`${reason}. Bot ${event.bot_id}. PnL excludes funding. Open Grid Bot for current venue and residual status.`};
}
export class GridNotifications {
  constructor(private pool:Pool,private send:(wallet:string,title:string,body:string)=>Promise<'sent'|'skipped'|'uncertain'>){}
  async deliverNext(){
    // Atomic persisted claim prevents two workers, retries or a restart from sending twice.
    // Telegram has no idempotent send: a crash after claim remains UNKNOWN, never auto-replayed.
    const event=(await this.pool.query(`WITH next AS (
      SELECT bot_id,event_key FROM grid_risk_events WHERE delivered_at IS NULL AND evidence->'notificationDelivery' IS NULL
      ORDER BY created_at,bot_id,event_key FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE grid_risk_events e SET evidence=e.evidence||jsonb_build_object('notificationDelivery',jsonb_build_object('state','uncertain','attemptedAt',clock_timestamp()))
      FROM next n WHERE e.bot_id=n.bot_id AND e.event_key=n.event_key RETURNING e.*
    ) SELECT c.*,b.wallet_address,b.market FROM claimed c JOIN grid_bots b ON b.id=c.bot_id`)).rows[0] as GridNotificationEvent|undefined;
    if(!event)return false;
    const text=gridNotificationText(event);
    let outcome:'sent'|'skipped'|'uncertain'='uncertain';
    try{outcome=await this.send(event.wallet_address,text.title,text.body);}catch{/* Retain claimed uncertainty. */}
    await this.pool.query(`UPDATE grid_risk_events SET evidence=jsonb_set(evidence,'{notificationDelivery,state}',to_jsonb($3::text)),
      delivered_at=CASE WHEN $3 IN ('sent','skipped') THEN clock_timestamp() ELSE NULL END WHERE bot_id=$1 AND event_key=$2`,[event.bot_id,event.event_key,outcome]);
    return true;
  }
}
let timer:ReturnType<typeof setTimeout>|null=null,stopped=true,pending:Promise<void>|null=null;
export async function startGridNotifications(){
  if(!stopped)return;
  const [{pool},{sendGridOwnerNotification},{requireSchemaCapabilityReady}]=await Promise.all([import('../db'),import('../notification-service'),import('../schema-readiness')]);
  await requireSchemaCapabilityReady('grid_bot',async(q,v)=>pool.query(q,v?[...v]:undefined));
  if(!stopped)return;stopped=false;
  const service=new GridNotifications(pool,sendGridOwnerNotification);
  const tick=async()=>{try{for(let i=0;i<20&&!stopped;i++)if(!await service.deliverNext())break;}catch{console.warn('[Grid notifications] delivery unavailable');}
    finally{pending=null;if(!stopped)timer=setTimeout(()=>{pending=tick();},15000);}};
  pending=tick();
}
export async function stopGridNotifications(){stopped=true;if(timer)clearTimeout(timer);timer=null;await pending;}
