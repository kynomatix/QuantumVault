import type { PoolClient } from 'pg';
import { newOwnerNonce, ownerParamsDigest, ownerPublicKey, ownerSha256, parseOwnerMessage, serializeOwnerMessage, verifyOwnerSignature, type OwnerAction } from './owner-auth';

const verified = new WeakSet<object>();
export interface VerifiedOwnerContext { readonly receiptId: string; readonly ownerWallet: string; readonly action: OwnerAction; readonly target: string; readonly paramsDigest: string }
export function requireVerifiedOwner(context: VerifiedOwnerContext, action: OwnerAction, target: string) {
  if (!verified.has(context) || context.action !== action || context.target !== target) throw Error('GRID_VERIFIED_OWNER_REQUIRED');
}
async function currentOwner(c: PoolClient): Promise<string> {
  if (!(await c.query('SELECT grid_worker_has_host_lock(false) AS held')).rows[0]?.held) throw Error('GRID_HOST_FENCE_REQUIRED');
  const row = (await c.query(`SELECT o.wallet_address FROM grid_worker_owner o JOIN grid_worker_host h
    ON h.singleton_id=o.singleton_id AND h.owner_wallet=o.wallet_address WHERE o.singleton_id=1`)).rows[0];
  if (!row) throw Error('GRID_OWNER_IDENTITY_MISSING');
  return row.wallet_address;
}
/** Caller supplies a transaction already holding the host fence. Never creates owner/host rows. */
export async function issueOwnerChallenge(c: PoolClient, sessionWallet: string, action: OwnerAction, target: string, params?: unknown, ttlMs = 120_000) {
  ownerPublicKey(sessionWallet);
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000 || sessionWallet !== await currentOwner(c)) throw Error('GRID_OWNER_CHALLENGE_REFUSED');
  const nonce = newOwnerNonce(), paramsDigest = ownerParamsDigest(action, params);
  const times = (await c.query(`WITH t AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS n)
    INSERT INTO auth_nonces(wallet_address,nonce_hash,purpose,created_at,expires_at)
    SELECT $1,$2,$3,n AT TIME ZONE 'UTC',(n+($4::integer*interval '1 millisecond')) AT TIME ZONE 'UTC' FROM t
    RETURNING to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued,
      to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires`,
    [sessionWallet, ownerSha256(nonce), 'owner_action:v1:' + action, ttlMs])).rows[0];
  const message = serializeOwnerMessage({ action, scope: 'grid_worker', target, nonce, ...times, paramsDigest });
  parseOwnerMessage(message);
  return message;
}
/** Conditional nonce use and receipt insertion must commit together in the caller's transaction. */
export async function verifyOwnerReceipt(c: PoolClient, input: { message: string; signature: string; signer: string; sessionWallet: string; params?: unknown }): Promise<VerifiedOwnerContext> {
  const m = parseOwnerMessage(input.message);
  if (input.signer !== await currentOwner(c)) throw Error('GRID_RECEIPT_OWNER');
  if (!verifyOwnerSignature(input.message, input.signature, input.signer)) throw Error('GRID_OWNER_SIGNATURE_INVALID');
  const nonceHash = ownerSha256(m.nonce);
  const n = (await c.query(`SELECT wallet_address,purpose,used_at,
    to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued,
    to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires,
    expires_at>(clock_timestamp() AT TIME ZONE 'UTC') AS live,
    created_at<=(clock_timestamp() AT TIME ZONE 'UTC') AS started
    FROM auth_nonces WHERE nonce_hash=$1 FOR UPDATE`, [nonceHash])).rows[0];
  if (!n || n.wallet_address !== input.signer || n.purpose !== 'owner_action:v1:' + m.action || n.used_at || !n.live) throw Error('GRID_OWNER_NONCE_INVALID');
  if (!n.started || n.issued !== m.issued || n.expires !== m.expires) throw Error('GRID_OWNER_WINDOW_INVALID');
  if (input.sessionWallet !== input.signer) throw Error('GRID_OWNER_SESSION_INVALID');
  if (ownerParamsDigest(m.action, input.params) !== m.paramsDigest) throw Error('GRID_RECEIPT_PARAMS');
  const used = await c.query(`UPDATE auth_nonces SET used_at=clock_timestamp() AT TIME ZONE 'UTC'
    WHERE nonce_hash=$1 AND used_at IS NULL AND expires_at>(clock_timestamp() AT TIME ZONE 'UTC') RETURNING id`, [nonceHash]);
  if (used.rowCount !== 1) throw Error('GRID_OWNER_NONCE_INVALID');
  const receipt = (await c.query(`INSERT INTO owner_action_receipts(owner_wallet,action,scope,target,nonce,message_digest,params_digest,issued_at,expires_at)
    VALUES($1,$2,'grid_worker',$3,$4,$5,$6,$7::timestamptz,$8::timestamptz) RETURNING receipt_id`,
    [input.signer, m.action, m.target, m.nonce, ownerSha256(input.message), m.paramsDigest, m.issued, m.expires])).rows[0];
  const result = Object.freeze({ receiptId: receipt.receipt_id as string, ownerWallet: input.signer, action: m.action, target: m.target, paramsDigest: m.paramsDigest });
  verified.add(result);
  return result;
}
