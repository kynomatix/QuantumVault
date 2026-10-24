import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {GridStorageError} from '../grid-bot/storage-error';

/** Shared host fence required. GET paths never call this recovery producer. */
export async function recoverAbandonedRescues(c:PoolClient){
  const rows=(await c.query(`UPDATE grid_worker_requests r SET state='complete',completed_at=clock_timestamp(),
    result_code=CASE WHEN EXISTS(SELECT 1 FROM grid_worker_send_audit a WHERE a.bot_id=r.bot_id AND a.outcome='unknown')
      OR EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=r.bot_id AND o.state IN ('prepared','submitted','unconfirmed'))
      THEN 'unknown_ended' ELSE 'ended' END FROM grid_worker_host h
    WHERE r.action='protective_close' AND r.state='admitted'
      AND (r.expires_at<=clock_timestamp() OR h.holder_boot_id IS DISTINCT FROM r.id OR h.holder_role IS DISTINCT FROM 'protective'
        OR h.lease_expires_at<=clock_timestamp()) RETURNING r.id,r.bot_id`)).rows;
  for(const r of rows)await c.query(`INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,bot_id,holder_boot_id)
    VALUES($1,$2,'critical','protective_failure',$3,$4)
    ON CONFLICT(dedup_key) WHERE acknowledged_at IS NULL DO UPDATE SET last_seen_at=clock_timestamp(),resolved_at=NULL`,
    [randomUUID(),'protective-failure:'+r.bot_id,r.bot_id,r.id]);
}

/** The enclosing host fence serializes this check against a takeover. */
export async function refuseRescueMutation(c:PoolClient,botId:string){
  if(!(await c.query("SELECT to_regclass('grid_worker_requests') IS NOT NULL AS present")).rows[0]?.present)return;
  const conflict=(await c.query(`SELECT 1 FROM grid_worker_requests r CROSS JOIN grid_worker_host h
    WHERE r.bot_id=$1 AND r.action='protective_close' AND
    (r.state='admitted' AND r.expires_at>clock_timestamp() AND h.holder_boot_id=r.id AND h.holder_role='protective'
      AND h.lease_expires_at>clock_timestamp()
      OR EXISTS(SELECT 1 FROM grid_worker_send_audit a WHERE a.bot_id=r.bot_id AND a.sender_role='protective' AND a.outcome='unknown')
      OR EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=r.bot_id AND o.state IN ('prepared','submitted','unconfirmed')
        AND o.exact_request->'authority'->>'protectiveRequestId' IS NOT NULL)) LIMIT 1`,[botId])).rowCount;
  if(conflict)throw new GridStorageError('conflict');
}
