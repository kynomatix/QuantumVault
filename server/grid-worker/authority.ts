import type { PoolClient } from 'pg';

export interface AuthorityIdentity {
  botId: string; wallet?: string; masterAccount: string; account?: string;
  generation?: string; requirePool?: boolean; workerExposure?: boolean;
}
export interface CurrentAuthority { wallet: string; generation: string | null; umkVersion: number }

/** Caller holds host, wallet, send/lifecycle and identity fences, in that order.
 * Legacy MAIN uses the same current grant predicate without an owner-only restriction.
 */
export async function currentAuthority(c: PoolClient, input: AuthorityIdentity): Promise<CurrentAuthority> {
  const r = (await c.query(`SELECT b.wallet_address,w.agent_public_key,w.umk_version,
    w.execution_enabled,w.emergency_stop_triggered,
    w.umk_encrypted_for_execution IS NOT NULL AND length(w.umk_encrypted_for_execution)>0 AS wrapped,
    w.agent_private_key_encrypted_v3 IS NOT NULL AND length(w.agent_private_key_encrypted_v3)>0 AS signer,
    w.execution_expires_at IS NULL OR w.execution_expires_at>clock_timestamp() AS grant_live,
    l.master_account,l.account,l.released_at,p.wallet_address AS pool_wallet,p.agent_public_key AS pool_agent,
    p.protocol_subaccount_id AS pool_account,p.protocol,b.protocol_subaccount_id AS bot_pool,l.protocol_subaccount_id AS launch_pool
    FROM grid_bots b JOIN wallets w ON w.address=b.wallet_address
    LEFT JOIN grid_launch_accounts l ON l.bot_id=b.id LEFT JOIN protocol_subaccounts p ON p.id=l.protocol_subaccount_id
    WHERE b.id=$1`, [input.botId])).rows[0];
  if (!r) throw Error('GRID_CURRENT_AUTHORITY_INVALID');
  const present = (await c.query("SELECT to_regclass('grid_worker_host') IS NOT NULL AS present")).rows[0]?.present;
  const host = present ? (await c.query('SELECT authority_tracking_enabled,owner_wallet,start_scope FROM grid_worker_host WHERE singleton_id=1')).rows[0] : undefined;
  let generation: string | null = null;
  if (host?.authority_tracking_enabled) {
    const a = (await c.query('SELECT generation::text FROM grid_worker_wallet_authority WHERE wallet_address=$1',[r.wallet_address])).rows[0];
    if (!a) throw Error('GRID_AUTHORITY_HISTORY_MISSING');
    generation = a.generation;
    if (input.generation !== undefined && generation !== input.generation) throw Error('GRID_AUTHORITY_GENERATION_CHANGED');
  } else if (input.generation !== undefined) throw Error('GRID_AUTHORITY_TRACKING_REQUIRED');
  if (input.wallet !== undefined && r.wallet_address !== input.wallet
    || r.agent_public_key !== input.masterAccount || !r.execution_enabled || r.emergency_stop_triggered
    || !r.wrapped || !r.signer || !r.grant_live) throw Error('GRID_CURRENT_AUTHORITY_INVALID');
  if (input.requirePool !== false && (r.pool_wallet !== r.wallet_address || r.pool_agent !== input.masterAccount
    || r.master_account !== input.masterAccount || r.released_at !== null || r.protocol !== 'pacifica'
    || r.bot_pool !== r.launch_pool || r.account !== r.pool_account
    || input.account !== undefined && r.account !== input.account)) throw Error('GRID_CURRENT_AUTHORITY_INVALID');
  if (input.workerExposure) {
    if (!host?.authority_tracking_enabled || host.start_scope !== 'owner_allowlist'
      || !(await c.query('SELECT 1 FROM grid_worker_owner WHERE singleton_id=1 AND wallet_address=$1 AND wallet_address=$2',[r.wallet_address,host.owner_wallet])).rowCount) throw Error('GRID_OWNER_SCOPE_REFUSED');
  }
  return { wallet: r.wallet_address, generation, umkVersion: r.umk_version };
}
