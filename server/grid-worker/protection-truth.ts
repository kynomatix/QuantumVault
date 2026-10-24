import type {PoolClient} from 'pg';
import type {GridIncidents} from './incidents';
import {fencedTransaction,type ClientLane} from './transaction';
import {ownerSha256} from './owner-auth';

/** Per-bot durable failure counts survive supervisor passes and process replacement. */
export class ProtectionTruth {
  constructor(private lane:ClientLane,private terminate:(pid:number)=>Promise<void>,private incidents:Pick<GridIncidents,'record'>){}
  async observe(botId:string,error?:unknown){
    const result=await fencedTransaction(this.lane,async c=>{
      const r=(await c.query(`SELECT b.status,b.market,a.account,h.drain_requested,l.blocker,r.action,r.state,m.observation,
        extract(epoch FROM clock_timestamp())*1000 AS now,
        m.reconciled_at BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp() AS fresh,
        EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.state IN ('prepared','submitted','unconfirmed'))
          OR EXISTS(SELECT 1 FROM grid_worker_send_audit s WHERE s.bot_id=b.id AND s.outcome='unknown') AS unknown,
        EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.state IN ('prepared','submitted','unconfirmed')
          AND CASE WHEN o.exact_request->>'timestamp' ~ '^[0-9]{1,16}$' AND o.exact_request->>'expiryMs' ~ '^[0-9]{1,5}$'
            THEN (o.exact_request->>'timestamp')::numeric+(o.exact_request->>'expiryMs')::numeric+7000 ELSE 0 END>
          extract(epoch FROM clock_timestamp())*1000) AS signed_wait
        FROM grid_bots b CROSS JOIN grid_worker_host h LEFT JOIN grid_lifecycle l ON l.bot_id=b.id
        LEFT JOIN grid_launch_accounts a ON a.bot_id=b.id
        LEFT JOIN grid_control_requests r ON r.id=l.active_request LEFT JOIN grid_monitor_state m ON m.bot_id=b.id WHERE b.id=$1`,[botId])).rows[0];
      if(!r)return null;
      const o=r.observation;
      const flat=r.status==='stopped'||!r.unknown&&r.fresh&&o?.inventoryComplete===true&&o.account===r.account
        &&o.symbol===r.market.replace(/-PERP$/,'')&&Number.isSafeInteger(o.observedAt)&&o.observedAt<=Number(r.now)&&Number(r.now)-o.observedAt<5000
        &&o.position&&/^0(?:\.0+)?$/.test(o.position.size)&&Array.isArray(o.orders)&&o.orders.length===0;
      if(flat){await resolveProtection(c,botId);return null;}
      const stop=r.status==='stopping'||r.action==='stop'&&r.state==='pending';
      const protection=stop||r.state==='pending'&&['pause','band'].includes(r.action)||r.drain_requested;
      if(!protection){await c.query("DELETE FROM grid_risk_events WHERE bot_id=$1 AND event_key='protective-pass-count'",[botId]);return null;}
      const failed=error instanceof Error?error.message:error?'unknown':null;
      const immediate=!!failed||/refused|failed|quota|backoff|rejection/.test(r.blocker??'');
      const blocked=!!r.blocker||!!failed;
      const count=(await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at)
        VALUES($1,'protective-pass-count','internal_protection',$2::jsonb,clock_timestamp())
        ON CONFLICT(bot_id,event_key) DO UPDATE SET evidence=jsonb_build_object('passes',
          CASE WHEN $3 THEN coalesce((grid_risk_events.evidence->>'passes')::integer,0)+1 ELSE 0 END),delivered_at=clock_timestamp()
        RETURNING evidence`,[botId,JSON.stringify({passes:blocked&&!r.signed_wait?1:0}),blocked&&!r.signed_wait])).rows[0].evidence.passes;
      if(!immediate&&count<3)return null;
      return {code:stop?'stop_failed' as const:'protective_failure' as const,dedupKey:(stop?'stop-failed:':'protective-failure:')+botId,
        botId,evidenceDigest:ownerSha256(failed??r.blocker??'blocked')};
    },{terminate:this.terminate});
    if(result)await this.incidents.record(result);
  }
}
export async function resolveProtection(c:PoolClient,botId:string){
  await c.query("DELETE FROM grid_risk_events WHERE bot_id=$1 AND event_key='protective-pass-count'",[botId]);
  await c.query(`UPDATE grid_worker_incidents SET resolved_at=clock_timestamp() WHERE bot_id=$1
    AND code IN ('stop_failed','protective_failure') AND resolved_at IS NULL`,[botId]);
}
