import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from '../../shared/schema';
import { fencedTransaction, GridDeadline, walletFences } from './transaction';
import { backendTerminator, independentLane } from './lanes';
import { allocatePoolId, identityFences, pendingAuthorityBots } from './identity-locks';

export const WALLET_AUTHORITY_FIELDS = new Set([
  'address', 'executionEnabled', 'umkEncryptedForExecution', 'executionExpiresAt', 'emergencyStopTriggered',
  'agentPublicKey', 'agentPrivateKeyEncryptedV3', 'umkVersion', 'encryptedUserMasterKey', 'userSalt', 'agentPrivateKeyEncrypted',
]);
export function rejectUnfencedAuthority(updates: object) {
  if (Object.keys(updates).some(k => WALLET_AUTHORITY_FIELDS.has(k))) throw Error('GRID_FENCED_WALLET_WRITER_REQUIRED');
}
type WriterDb = NodePgDatabase<typeof schema>;
export interface PoolIdentity { protocol: string; protocolSubaccountId: string; insert?: boolean }

/** MAIN-only adapter. No key decryption, lease ownership, or background loop. */
export async function walletWrite<T>(pool: Pool, wallets: readonly string[],
  work: (tx: WriterDb, poolId?: number) => Promise<T>,
  options: { tightening?: boolean; identity?: PoolIdentity; allPools?: boolean; tryWallet?: boolean } = {}): Promise<T> {
  if (!wallets.every(w => typeof w === 'string' && w.length > 0 && w.length <= 128)) throw Error('GRID_WALLET_INVALID');
  const deadline = new GridDeadline();
  const terminate = backendTerminator(independentLane(pool));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fencedTransaction(pool, async c => {
        // Discover the old identity without tuple locks. Take both wallets before any identity lock.
        const readPool = async () => options.identity ? (await c.query<{id: number; wallet_address: string}>(
          'SELECT id,wallet_address FROM protocol_subaccounts WHERE protocol=$1 AND protocol_subaccount_id=$2',
          [options.identity.protocol, options.identity.protocolSubaccountId])).rows[0] : undefined;
        const old = await readPool();
        const owners = [...new Set([...wallets, ...(old ? [old.wallet_address] : [])])];
        if (options.tightening || attempt > 0) await c.query("SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='9s'");
        if (options.tryWallet) {
          for (const wallet of owners.sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)))) {
            if (!(await c.query('SELECT pg_try_advisory_xact_lock(927412,hashtext($1)) AS acquired',[wallet])).rows[0]?.acquired) throw Error('GRID_WALLET_BUSY');
          }
        } else await walletFences(c, owners);
        await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='2s'");
        const current = await readPool();
        if (old?.id !== current?.id || old?.wallet_address !== current?.wallet_address) throw Error('GRID_POOL_IDENTITY_CHANGED');
        const poolId = old?.id ?? (options.identity?.insert ? await allocatePoolId(c) : undefined);
        const pending = await pendingAuthorityBots(c, owners);
        const pools = options.allPools ? (await c.query<{id:number}>(
          'SELECT id FROM protocol_subaccounts WHERE wallet_address IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY id',[JSON.stringify(owners)])).rows.map(r=>r.id) : poolId === undefined ? [] : [poolId];
        const linked = pools.length ? (await c.query<{bot_id: string}>(
          'SELECT bot_id FROM grid_launch_accounts WHERE protocol_subaccount_id IN (SELECT value::integer FROM jsonb_array_elements_text($1::jsonb)) AND released_at IS NULL ORDER BY bot_id', [JSON.stringify(pools)])).rows.map(r => r.bot_id) : [];
        await identityFences(c, [...pending, ...linked], pools);
        const value = await work(drizzle(c, { schema }), poolId);
        deadline.check();
        return value;
      }, { terminate, budget: deadline, tightening: options.tightening || attempt > 0 });
    } catch (error) {
      let cause:unknown=error,code:string|undefined;
      for(let depth=0;depth<5&&cause&&typeof cause==='object';depth++){
        if(typeof (cause as {code?:unknown}).code==='string'){code=(cause as {code:string}).code;break;}
        cause=(cause as {cause?:unknown}).cause;
      }
      if (attempt || !['55P03', '57014'].includes(code ?? '') || deadline.remaining() < 10_000) throw error;
      // One pre-transport retry within the original watchdog; no unfenced fallback.
    }
  }
}
