import type {PoolClient} from 'pg';

/** A separate lock namespace; collisions can only delay recovery, never admit two senders. */
export async function gridWorkerFence(c:PoolClient,botId:string){
  return (await c.query("SELECT pg_try_advisory_xact_lock(hashtext('grid:worker:send'),hashtext($1)) AS acquired",[botId])).rows[0].acquired===true;
}
export async function recordGridWorker(c:PoolClient,botId:string,generation:string,reconciliationRequired:boolean){
  await c.query(`INSERT INTO grid_risk_events(bot_id,event_key,kind,evidence,delivered_at)
    VALUES($1,'worker-ownership','internal_worker_ownership',$2,clock_timestamp()) ON CONFLICT(bot_id,event_key)
    DO UPDATE SET evidence=EXCLUDED.evidence,delivered_at=EXCLUDED.delivered_at`,
    [botId,{version:1,generation,reconciliationRequired}]);
}
export async function gridWorkerEntryBlocked(c:PoolClient,botId:string){
  const evidence=(await c.query("SELECT evidence FROM grid_risk_events WHERE bot_id=$1 AND event_key='worker-ownership'",[botId])).rows[0]?.evidence;
  return evidence?.reconciliationRequired===true;
}
