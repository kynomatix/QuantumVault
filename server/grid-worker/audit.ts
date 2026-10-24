import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
export interface SendAudit {
  operationId: string; botId: string; requestId?: string; requestIdentity: string; attempt: number; kind: string;
  bootId: string; role: 'legacy' | 'grid-worker' | 'protective'; epoch: string; generation: string;
  policyDigest: string; requestDigest: string; signedAt: number; expiresAt: number;
}
/** Called in the submitted-operation transaction, before its commit and before any POST. */
export async function prepareSendAudit(c: PoolClient, a: SendAudit): Promise<string> {
  const result = await c.query(`INSERT INTO grid_worker_send_audit(id,operation_id,bot_id,request_id,request_identity,attempt,kind,
    holder_boot_id,sender_role,fencing_epoch,wallet_generation,policy_digest,request_digest,signed_at,signed_expires_at,prepared_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14::double precision/1000),to_timestamp($15::double precision/1000),clock_timestamp()
    WHERE EXISTS(SELECT 1 FROM grid_operations WHERE id=$2 AND bot_id=$3 AND request_identity=$5 AND state='submitted' AND exact_request_digest=$13) RETURNING id`,
    [randomUUID(), a.operationId, a.botId, a.requestId ?? null, a.requestIdentity, a.attempt, a.kind, a.bootId, a.role, a.epoch, a.generation, a.policyDigest, a.requestDigest, a.signedAt, a.expiresAt]);
  if (result.rowCount !== 1) throw Error('GRID_AUDIT_OPERATION_INVALID');
  return result.rows[0].id;
}
/** Only authorization changes under final locks; immutable attribution must already match. */
export async function authorizeSendAudit(c: PoolClient, a: SendAudit): Promise<void> {
  const result = await c.query(`UPDATE grid_worker_send_audit SET authorized_at=clock_timestamp()
    WHERE operation_id=$1 AND attempt=$2 AND bot_id=$3 AND request_identity=$4 AND holder_boot_id=$5::uuid AND sender_role=$6
      AND fencing_epoch=$7::bigint AND wallet_generation=$8::bigint AND policy_digest=$9 AND request_digest=$10
      AND signed_at=to_timestamp($11::double precision/1000) AND signed_expires_at=to_timestamp($12::double precision/1000)
      AND outcome='unknown' AND authorized_at IS NULL RETURNING id`,
    [a.operationId, a.attempt, a.botId, a.requestIdentity, a.bootId, a.role, a.epoch, a.generation, a.policyDigest, a.requestDigest, a.signedAt, a.expiresAt]);
  if (result.rowCount !== 1) throw Error('GRID_AUDIT_ATTRIBUTION_MISMATCH');
}
export async function completeSendAudit(c: PoolClient, operationId: string, outcome: 'confirmed' | 'refused' | 'failed', outcomeCode: string, venueOrderId?: string, venueTradeId?: string) {
  const result = await c.query(`UPDATE grid_worker_send_audit SET outcome=$2,completed_at=clock_timestamp(),outcome_code=$3,venue_order_id=$4,venue_trade_id=$5
    WHERE operation_id=$1 AND outcome='unknown' RETURNING id`, [operationId, outcome, outcomeCode, venueOrderId ?? null, venueTradeId ?? null]);
  if (result.rowCount !== 1) throw Error('GRID_AUDIT_COMPLETION_INVALID');
}
