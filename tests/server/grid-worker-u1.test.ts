import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, generateKeyPairSync, createPrivateKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import bs58 from 'bs58';
import { build } from 'esbuild';
import { assertGridWorkerEnvironment, assertWebProcessRole } from '../../server/process-role';
import { unwrapExecutionUmk, readExecutionWallet } from '../../server/execution/umk';
import { getServerExecutionKey } from '../../server/execution/server-key';
import { buildAAD, encryptToBase64, decryptFromBase64, deriveSubkey, SUBKEY_PURPOSES, encryptBuffer } from '../../server/crypto-v3';
import { SCHEMA_MIGRATION_MANIFEST } from '../../server/schema-migration-manifest';
import { buildGridWorker, auditWorkerOutput } from '../../script/build-grid-worker';
import { gridWorkerFixtureUrl } from '../helpers/grid-worker-fixture-url';

const baseCommitHash = '96d6916bacd44d8e6f8e7bca43fe6f90667dd1a3';
const require = createRequire(import.meta.url);
const artifactDir = mkdtempSync(join(tmpdir(), 'grid-worker-u1-'));
const fixtureEnv = () => ({ QV_PROCESS_ROLE: 'grid-worker', REPLIT_DEPLOYMENT: '1', DATABASE_URL: gridWorkerFixtureUrl(), SERVER_EXECUTION_KEY: randomBytes(32).toString('hex') });
const baselineSource = (path: string) => execFileSync('git', ['show', `${baseCommitHash}:${path}`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const transpile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function functionText(text: string, name: string): string {
  const ast = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`missing fixture function ${name}`);
  return node.getText(ast);
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('U1 process and MAIN boundaries', () => {
  it('binds roles, requires deployment, and rejects even empty forbidden keys', () => {
    for (const value of [undefined, '', 'web']) expect(() => assertWebProcessRole({ QV_PROCESS_ROLE: value })).not.toThrow();
    for (const value of ['grid-worker', 'WEB', ' web']) expect(() => assertWebProcessRole({ QV_PROCESS_ROLE: value })).toThrow();
    const env = fixtureEnv();
    expect(() => assertGridWorkerEnvironment(env)).not.toThrow();
    for (const key of ['AGENT_ENCRYPTION_KEY', 'UMK_STORAGE_SECRET', 'PGHOST', 'PGPASSWORD', 'PGSERVICEFILE', 'SESSION_SECRET', 'TELEGRAM_BOT_TOKEN', 'DATA_RELAY_SECRET']) {
      expect(() => assertGridWorkerEnvironment({ ...env, [key]: '' })).toThrow('GRID_WORKER_SECRET_BOUNDARY');
    }
    for (const patch of [{ QV_PROCESS_ROLE: '' }, { REPLIT_DEPLOYMENT: '' }, { SERVER_EXECUTION_KEY: 'EXAMPLE' }, { SERVER_EXECUTION_KEY: 'z'.repeat(64) }, { DATABASE_URL: '' }, { SOLANA_ENV: 'devnet' }]) {
      expect(() => assertGridWorkerEnvironment({ ...env, ...patch })).toThrow();
    }
  });

  it('preserves the actual legacy validator and pre-listen fail-fast outcomes', async () => {
    const current = source('server/crypto.ts');
    const old = baselineSource('server/crypto.ts');
    expect(functionText(current, 'getEncryptionKey')).toBe(functionText(old, 'getEncryptionKey'));
    const entry = source('server/index.ts');
    const guardEnd = entry.indexOf('validateLegacyEncryptionKey();') + 'validateLegacyEncryptionKey();'.length;
    expect(guardEnd).toBeGreaterThan(0);
    expect(guardEnd).toBeLessThan(entry.indexOf('httpServer.listen('));
    const prefix = entry.slice(0, guardEnd);
    const oldPath = join(artifactDir, 'old-main-guard.cjs');
    writeFileSync(oldPath, transpile(old) + '\nconsole.log("PORT_BOUNDARY_REACHED");');
    const newPath = join(artifactDir, 'new-main-guard.cjs');
    await build({ stdin: { contents: prefix + '\nconsole.log("PORT_BOUNDARY_REACHED");', resolveDir: resolve('server'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: newPath, logLevel: 'silent' });
    for (const key of [undefined, 'EXAMPLE', randomBytes(32).toString('hex'), 'z'.repeat(64)]) {
      const env = key === undefined ? {} : { AGENT_ENCRYPTION_KEY: key };
      const oldResult = spawnSync(process.execPath, [oldPath], { env, encoding: 'utf8' });
      const newResult = spawnSync(process.execPath, [newPath], { env, encoding: 'utf8' });
      if (oldResult.error || newResult.error) throw oldResult.error ?? newResult.error;
      expect(newResult.status).toBe(oldResult.status);
      expect(newResult.stdout).toBe(oldResult.stdout);
      expect(newResult.status).toBe(key === undefined || key === 'EXAMPLE' ? 1 : 0);
    }
    const invalidRole = spawnSync(process.execPath, [newPath], { env: { AGENT_ENCRYPTION_KEY: randomBytes(32).toString('hex'), QV_PROCESS_ROLE: 'grid-worker' }, encoding: 'utf8' });
    if (invalidRole.error) throw invalidRole.error;
    expect(invalidRole.status).toBe(1);
    expect(invalidRole.stdout).toBe('');
  });

  it('keeps MAIN UMK health policy, migration bytes and RPC implementation bodies intact', () => {
    const oldDb = baselineSource('server/db.ts');
    const currentDb = source('server/db.ts');
    expect(functionText(currentDb, 'checkUmkStorageSecretHealth')).toBe(functionText(oldDb, 'checkUmkStorageSecretHealth'));
    const start = oldDb.indexOf('const schemaMigrationSql =');
    const end = oldDb.indexOf('registerSchemaMigrationManifest(SCHEMA_MIGRATION_MANIFEST)');
    expect(source('server/schema-migration-manifest.ts').trimEnd().endsWith(oldDb.slice(start, end).trimEnd())).toBe(true);
    const before = baselineSource('server/rpc-config.ts');
    for (const name of ['getPrimaryRpcUrl', 'getBackupRpcUrl', 'createSolanaRpcTransport', 'createSolanaRpcConnection', 'fetchSolanaRpc']) {
      expect(functionText(source('server/solana-rpc-transport.ts'), name)).toBe(functionText(before, name));
    }
    expect(functionText(source('server/rpc-config.ts'), 'submitSignedTransactionWithDefinitiveFailover')).toBe(functionText(before, 'submitSignedTransactionWithDefinitiveFailover'));
    expect(functionText(source('server/solana-balance-read.ts'), 'getAgentSolBalanceLamportsStrict')).toBe(functionText(baselineSource('server/agent-wallet.ts'), 'getAgentSolBalanceLamportsStrict'));
    expect(source('server/index.ts').split('checkUmkStorageSecretHealth').length).toBe(baselineSource('server/index.ts').split('checkUmkStorageSecretHealth').length);
  });
});

describe('U1 execution parity', () => {
  it('matches the original function on enabled/revoked/stopped/AAD/corrupt fixtures and clears returned UMKs', async () => {
    const serverKey = randomBytes(32);
    vi.stubEnv('SERVER_EXECUTION_KEY', serverKey.toString('hex'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const umk = randomBytes(32);
    const walletAddress = bs58.encode(randomBytes(32));
    const wrapped = encryptToBase64(umk, serverKey, buildAAD(walletAddress, 'EUMK_EXEC'));
    const originalText = functionText(baselineSource('server/session-v3.ts'), 'getUmkForWebhook');
    const enabled = { executionEnabled: true, emergencyStopTriggered: false, umkEncryptedForExecution: wrapped };
    const cases = [enabled, null, { ...enabled, executionEnabled: false }, { ...enabled, emergencyStopTriggered: true }, { ...enabled, umkEncryptedForExecution: null }, { ...enabled, umkEncryptedForExecution: 'EXAMPLE' }, { ...enabled, umkEncryptedForExecution: encryptToBase64(umk, serverKey, buildAAD(bs58.encode(randomBytes(32)), 'EUMK_EXEC')) }];
    for (const wallet of cases) {
      const context = { exports: {} as Record<string, any>, storage: { getWallet: async () => wallet }, getServerExecutionKey, buildAAD, decryptFromBase64, zeroizeBuffer: (b: Buffer) => b.fill(0), console: { error() {} } };
      vm.runInNewContext(transpile(originalText), context);
      const oldResult = await context.exports.getUmkForWebhook(walletAddress);
      const newResult = unwrapExecutionUmk(walletAddress, wallet);
      expect(newResult === null).toBe(oldResult === null);
      if (newResult && oldResult) {
        expect(newResult.umk.equals(oldResult.umk)).toBe(true);
        newResult.cleanup(); oldResult.cleanup();
        expect(newResult.umk.every(byte => byte === 0)).toBe(true);
      }
    }
  });

  it('uses only explicit execution columns and a parameterized wallet identity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await readExecutionWallet({ query }, 'EXAMPLE-wallet')).toBeNull();
    const [sql, args] = query.mock.calls[0];
    expect(args).toEqual(['EXAMPLE-wallet']);
    expect(sql).not.toMatch(/SELECT\s+\*|encrypted_user_master_key|user_salt|encrypted_mnemonic_words|agent_private_key_encrypted(?:\s|,)/i);
    for (const name of ['address', 'execution_enabled', 'emergency_stop_triggered', 'umk_encrypted_for_execution', 'umk_version', 'agent_public_key', 'agent_private_key_encrypted_v3']) expect(sql).toContain(name);
  });
});

function catalogFixture() {
  const requirements = SCHEMA_MIGRATION_MANIFEST.flatMap(m => [...m.requirements]);
  return vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (/^(BEGIN READ ONLY|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (!/^SELECT\b/i.test(sql.trim())) throw new Error('fixture refused a write');
    if (sql.includes('to_regclass')) return { rows: [{ relation: 'EXAMPLE' }] };
    if (sql.includes('SELECT column_name')) return { rows: requirements.flatMap(r => r.kind === 'table' && r.table === values[0] ? r.columns.map(column_name => ({ column_name })) : []) };
    if (sql.includes('information_schema.columns')) return { rows: [{ present: 1 }] };
    if (sql.includes('SELECT 1 AS present FROM pg_constraint')) return { rows: [] };
    if (sql.includes('AS definition')) return { rows: requirements.flatMap(r => {
      if (r.kind === 'table' && r.table === values[0] && values.length === 1) return (r.constraintDefinitions ?? []).map(definition => ({ definition }));
      if (r.kind === 'constraint' && r.table === values[0] && r.constraint === values[1]) return [{ definition: (r.definitionIncludes ?? []).join(' ') }];
      return [];
    }).slice(values.length === 1 ? 0 : -1) };
    if (sql.includes('FROM pg_index')) {
      const r = requirements.findLast(r => r.kind === 'index' && r.index === values[0]);
      return { rows: r?.kind === 'index' ? [{ table_name: r.table, is_unique: r.unique, predicate: r.predicateIncludes?.join(' '), columns: r.columns }] : [] };
    }
    return { rows: [{ ok: true }] };
  });
}

describe('U1 built artifact', () => {
  it('proves output closure, rejects unsafe edges, boots read-only and signs with canonical keys absent', async () => {
    const { outfile, proof } = await buildGridWorker(artifactDir);
    const meta = JSON.parse(readFileSync(join(artifactDir, 'grid-worker.meta.json'), 'utf8'));
    const code = readFileSync(outfile, 'utf8');
    expect(proof.computedImports).toBe(0);
    expect(proof.inputs).toContain('server/grid-worker/database.ts');
    expect(proof.inputs.some(p => /schema-readiness\.ts$/.test(p))).toBe(false);
    expect(() => auditWorkerOutput(code + '\nrequire("EXAMPLE");', meta)).toThrow();
    expect(() => auditWorkerOutput(code + '\nrequire(process.argv[2]);', meta)).toThrow();
    expect(() => auditWorkerOutput(code + '\ngetStorageKeyV3();', meta)).toThrow();
    const invalidBoot = spawnSync(process.execPath, [outfile], { env: {}, encoding: 'utf8' });
    if (invalidBoot.error) throw invalidBoot.error;
    expect(invalidBoot.status).toBe(1);
    expect(invalidBoot.stderr.trim()).toBe('GRID_WORKER_U1_BOOT_FAILED');
    vi.stubEnv('AGENT_ENCRYPTION_KEY', undefined); vi.stubEnv('UMK_STORAGE_SECRET', undefined);
    for (const key of Object.keys(process.env)) if (/^PG|^(SESSION_SECRET|ADMIN_PASSWORD|LOG_READ_TOKEN|QV_PROD_DATABASE_URL)$|^TELEGRAM_|^DATA_RELAY_/.test(key)) vi.stubEnv(key, undefined);
    const env = fixtureEnv();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const artifact = require(outfile) as typeof import('../../server/grid-worker/index');
    const query = catalogFixture();
    const release = vi.fn(); const close = vi.fn(async () => {});
    await artifact.bootGridWorker(() => ({ connect: async () => ({ query, release }) as any, close }));
    expect(query.mock.calls[0][0]).toBe('BEGIN READ ONLY');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    const pair = generateKeyPairSync('ed25519');
    const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
    const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
    const privateBytes = Buffer.concat([privateDer.subarray(-32), publicDer.subarray(-32)]);
    privateDer.fill(0);
    const umk = randomBytes(32); const wallet = bs58.encode(randomBytes(32));
    const wrapped = encryptToBase64(umk, Buffer.from(env.SERVER_EXECUTION_KEY, 'hex'), buildAAD(wallet, 'EUMK_EXEC'));
    const subkey = deriveSubkey(umk, SUBKEY_PURPOSES.AGENT_PRIVKEY);
    const encrypted = encryptBuffer(privateBytes, subkey, buildAAD(wallet, 'AGENT_PRIVKEY')).toString('base64');
    subkey.fill(0); privateBytes.fill(0);
    const execution = await artifact.getExecutionUmk({ query: async () => ({ rows: [{ address: wallet, executionEnabled: true, emergencyStopTriggered: false, umkEncryptedForExecution: wrapped, umkVersion: 3, agentPublicKey: 'EXAMPLE', agentPrivateKeyEncryptedV3: encrypted }] }) }, wallet);
    expect(execution).not.toBeNull();
    const decrypted = artifact.decryptAgentKeyV3(execution!.umk, encrypted, wallet);
    try {
      expect(decrypted.length).toBe(64);
      const der = Buffer.concat([Buffer.from([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]), decrypted.subarray(0, 32)]);
      const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      der.fill(0);
      const message = Buffer.from('EXAMPLE offline U1 signing fixture');
      expect(verify(null, message, pair.publicKey, sign(null, message, key))).toBe(true);
    } finally { decrypted.fill(0); execution!.cleanup(); umk.fill(0); }
    expect(execution!.umk.every(byte => byte === 0)).toBe(true);
    console.log(`U1 artifactSha256=${proof.artifactSha256} inputs=${proof.inputCount} externals=${proof.externalBuiltins.length} computedImports=0 evidence=${artifactDir}`);
  }, 60_000);

  it('has zero new CI TypeScript diagnostics', () => {
    const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    if (result.error) throw result.error;
    const diagnostics = result.stdout.split(/\r?\n/).filter(l => /error TS\d+:/.test(l)).map(l => l.replace(/\(\d+,\d+\)/, '')).sort();
    const baseline = source('.github/typecheck-baseline.txt').split('\n');
    const counts = new Map<string, number>();
    for (const line of baseline) counts.set(line, (counts.get(line) ?? 0) + 1);
    const added = diagnostics.filter(line => { const n = counts.get(line) ?? 0; if (n) { counts.set(line, n - 1); return false; } return true; });
    writeFileSync(join(artifactDir, 'typecheck.json'), JSON.stringify({ total: diagnostics.length, newErrors: added.length, added }, null, 2));
    expect(result.signal).toBeNull();
    expect([0, 2]).toContain(result.status);
    expect(added).toEqual([]);
  }, 150_000);
});
