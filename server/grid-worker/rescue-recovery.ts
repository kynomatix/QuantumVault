import {walletFences} from './transaction';
import {identityFences} from './identity-locks';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {GridStorageError} from '../grid-bot/storage-error';

/** Shared host fence required. GET paths never call this recovery producer. */
export async function recoverAbandonedRescues(c:PoolClient){
  const candidates=(await c.query("SELECT id,owner_wallet,bot_id FROM grid_worker_requests WHERE action='protective_close' AND state='admitted' FOR NO KEY UPDATE SKIP LOCKED")).rows;
  await walletFences(c,candidates.map(r=>r.owner_wallet));await identityFences(c,candidates.map(r=>r.bot_id),[]);
  const rows=(await c.query(`UPDATE grid_worker_requests r SET state='complete',completed_at=clock_timestamp(),
    result_code=CASE WHEN EXISTS(SELECT 1 FROM grid_worker_send_audit a WHERE a.bot_id=r.bot_id AND a.outcome='unknown')
      OR EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=r.bot_id AND o.state IN ('prepared','submitted','unconfirmed'))
      THEN 'unknown_ended' ELSE 'ended' END FROM grid_worker_host h
    WHERE r.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) AND r.action='protective_close' AND r.state='admitted'
      AND (r.expires_at<=clock_timestamp() OR h.holder_boot_id IS DISTINCT FROM r.id OR h.holder_role IS DISTINCT FROM 'protective'
        OR h.lease_expires_at IS NULL OR h.lease_expires_at<=clock_timestamp()
         OR NOT EXISTS(SELECT 1 FROM grid_control_keys k WHERE k.bot_id=r.bot_id AND k.request_key='rescue:'||r.id::text
           AND k.control_id=r.control_request_id AND k.evidence->>'protectiveEpoch'=h.fencing_epoch::text)) RETURNING r.id,r.bot_id`,[JSON.stringify(candidates.map(r=>r.id))])).rows;
  for(const r of rows)await c.query(`INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,bot_id,holder_boot_id,first_seen_at,last_seen_at)
    VALUES($1,$2,'critical','protective_failure',$3,$4,clock_timestamp(),clock_timestamp())
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
