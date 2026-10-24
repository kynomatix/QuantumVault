import type { PoolClient } from 'pg';
import { walletFences } from './transaction';

/** Order: host, reserved aggregate, wallets, send/lifecycle, v3 bots, v3 pools, rows. */
export async function identityFences(c: PoolClient, bots: readonly string[], pools: readonly number[]) {
  for (const bot of [...new Set(bots)].sort()) {
    if (!/^[0-9a-f-]{36}$/i.test(bot)) throw Error('GRID_BOT_ID_INVALID');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:bot:'||$1,0))", [bot]);
  }
  for (const pool of [...new Set(pools)].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(pool) || pool < 1) throw Error('GRID_POOL_ID_INVALID');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:pool:'||$1,0))", [String(pool)]);
  }
}

export async function pendingAuthorityBots(c: PoolClient, wallets: readonly string[]): Promise<string[]> {
  const present = (await c.query("SELECT to_regclass('grid_worker_requests') IS NOT NULL AS present")).rows[0]?.present;
  if (!present) return [];
  return (await c.query<{ bot_id: string }>(`SELECT DISTINCT bot_id FROM grid_worker_requests
    WHERE owner_wallet IN (SELECT jsonb_array_elements_text($1::jsonb)) AND state='pending' ORDER BY bot_id`,
  [JSON.stringify(wallets)])).rows.map(r => r.bot_id);
}

/** No row is locked during discovery. The shared host fence excludes P2. */
export async function prelockWalletMutation(c: PoolClient, wallets: readonly string[]) {
  await walletFences(c, wallets);
  const bots = await pendingAuthorityBots(c, wallets);
  await identityFences(c, bots, []);
}

export async function allocatePoolId(c: PoolClient): Promise<number> {
  const id = Number((await c.query("SELECT nextval(pg_get_serial_sequence('protocol_subaccounts','id')) AS id")).rows[0]?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw Error('GRID_POOL_ID_INVALID');
  return id;
}

/** Discover under the wallet fence; reread after identity fences, before tuple locks. */
export async function launchIdentityFences(c: PoolClient, botId: string): Promise<void> {
  const read = async () => (await c.query('SELECT protocol_subaccount_id FROM grid_launch_accounts WHERE bot_id=$1',[botId])).rows[0]?.protocol_subaccount_id;
  const before = await read();
  await identityFences(c,[botId],before == null ? [] : [before]);
  if (before !== await read()) throw Error('GRID_POOL_IDENTITY_CHANGED');
}
