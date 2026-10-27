import { makeLifecycleFenceFixture } from '../helpers/close-lifecycle-fence';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq, and, or, isNull, isNotNull } from 'drizzle-orm';
import * as schema from '../../shared/schema';
import { assessResetBlockerRows } from '../../server/vault/reset-blocker-policy';
import { walletWrite, rejectUnfencedAuthority } from '../../server/grid-worker/wallet-writers';
import { gridWorkerIsolation } from '../helpers/grid-worker-isolation';

const baseCommitHash = '905aa2650a765fa1e2a58f3dee474cce33e5e46d';
const names = ['createWallet', 'updateWallet', 'updateWalletLastSeen', 'updateWalletAgentKeys', 'updateWalletAgentKeyV3', 'updateWalletExecution', 'resyncWalletExecutionUmk', 'atomicRevokeExecutionAndPauseBots', 'updateWalletEmergencyStop', 'finalizeAgentWalletReset'];
function methods(text: string) {
  const ast = ts.createSourceFile('storage.ts', text, ts.ScriptTarget.Latest, true);
  const bodies = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.body && names.includes(node.name.getText(ast))) bodies.set(node.name.getText(ast), node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (bodies.size !== names.length) throw Error('wallet writer inventory incomplete');
  return names.map(name => bodies.get(name)!);
}
const source = readFileSync('server/storage.ts', 'utf8').replaceAll('\r\n', '\n');
const baseline = execFileSync('git', ['show', baseCommitHash + ':server/storage.ts'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).replaceAll('\r\n', '\n');
const tables = ['wallets', 'grid_bots', 'grid_operations', 'grid_control_requests', 'protocol_subaccounts', 'grid_launch_accounts', 'borrow_positions', 'borrow_operations', 'trading_bots', 'ai_trader_bots', 'orphaned_subaccounts'];
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => ['createdAt', 'lastSeen'].includes(key) ? 'EXAMPLE_DB_TIME' : item));

describe('U2c fenced wallet writer result parity with U2a', () => {
  for (const seeded of [false, true]) it('same writer results with ' + (seeded ? 'seeded' : 'absent') + ' host', async () => {
    const url = process.env.DATABASE_URL;
    if (!url || new URL(url).pathname !== '/qvtest') throw Error('FRACTAL qvtest required');
    const admin = new Pool({ connectionString: url, max: 1 });
    const results: unknown[] = [];
    const walletAddress = "EXAMPLE_U2A_" + randomUUID();
    try {
      for (const installed of [false, true]) {
        const namespace = 'grid_wallet_' + randomUUID().replaceAll('-', '');
        await admin.query('CREATE SCHEMA ' + namespace);
        const pool = new Pool({ connectionString: url, max: 2, options: '-c search_path=' + namespace + ',pg_catalog' });
        pool.on('connect',gridWorkerIsolation());
        const client = await pool.connect();
        try {
          for (const name of tables) await client.query(`CREATE TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
          if (installed) {
            await client.query(readFileSync('migrations/grid_worker_v3_owner.sql', 'utf8').replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + namespace));
          }
          const js = ts.transpileModule('class Writer {\n' + methods(installed ? source : baseline).join('\n') + '\n}; new Writer()', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
          const writer = vm.runInNewContext(js, { ...schema, db: drizzle(client), pool, walletWrite, rejectUnfencedAuthority, sql, eq, and, or, isNull, isNotNull, AGENT_WALLET_RESET_LOCK_NAMESPACE: 927412, assessResetBlockerRows, closeIntentStore: makeLifecycleFenceFixture() });
            writer.getWallet = async (address: string) => (await drizzle(client).select().from(schema.wallets).where(eq(schema.wallets.address, address)))[0];
          const outcomes: unknown[] = [];
          outcomes.push(await writer.createWallet({ address: walletAddress, agentPublicKey: 'EXAMPLE_OLD' }));
          if (installed && seeded) {
            await client.query("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:host',0))");
            await client.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)', [walletAddress]);
            await client.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)", [walletAddress]);
            await client.query('COMMIT');
          }
          await writer.updateWalletLastSeen(walletAddress);
          outcomes.push(await writer.updateWallet(walletAddress, { displayName: 'EXAMPLE', notificationsEnabled: true }));
          if(installed)await expect(writer.updateWallet(walletAddress,{agentPublicKey:'EXAMPLE_BYPASS'})).rejects.toThrow('GRID_FENCED_WALLET_WRITER_REQUIRED');
          outcomes.push(await writer.updateWalletExecution(walletAddress, { executionEnabled: true, umkEncryptedForExecution: 'EXAMPLE', executionExpiresAt: new Date('2099-01-01T00:00:00Z') }));
          outcomes.push(await writer.resyncWalletExecutionUmk(walletAddress, 'EXAMPLE_RESYNC'));
          outcomes.push(await writer.atomicRevokeExecutionAndPauseBots(walletAddress, 'EXAMPLE'));
          outcomes.push(await writer.resyncWalletExecutionUmk(walletAddress, 'EXAMPLE_AFTER_REVOKE'));
          outcomes.push(await writer.updateWalletEmergencyStop(walletAddress, { executionEnabled: false, umkEncryptedForExecution: null, executionExpiresAt: null, emergencyStopTriggered: true, emergencyStopAt: new Date('2026-01-01T00:00:00Z'), emergencyStopBy: 'EXAMPLE' }));
          await writer.updateWalletAgentKeys(walletAddress, 'EXAMPLE_OLD', 'EXAMPLE');
          await writer.updateWalletAgentKeyV3(walletAddress, 'EXAMPLE');
          outcomes.push(await writer.finalizeAgentWalletReset({ walletAddress, observedAgentPublicKey: 'EXAMPLE_OLD', encryptedMnemonicWords: 'EXAMPLE', newAgentPublicKey: 'EXAMPLE_NEW', newAgentPrivateKeyEncryptedV3: 'EXAMPLE' }));
          expect(outcomes.at(-1)).toEqual({ outcome: 'committed', clearedBotCount: 0 });
          expect((await client.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n).toBe(0);
          if (installed) expect((await client.query('SELECT count(*)::integer AS n FROM grid_worker_wallet_authority')).rows[0].n).toBe(0);
          results.push(normalize(outcomes));
        } finally {
          await client.query('ROLLBACK'); client.release(); await pool.end();
          await admin.query('DROP SCHEMA ' + namespace + ' CASCADE');
        }
      }
      expect(results[1]).toEqual(results[0]);
    } finally { await admin.end(); }
  }, 30_000);
});
