import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, generateKeyPairSync, createPrivateKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
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
import { probeGridWorkerSchema } from '../../server/grid-worker/boot';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness-probe';
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
    const historical = oldDb.slice(start, end);
    const literalArrays = (text: string) => {
      const ast = ts.createSourceFile('manifest.ts', text, ts.ScriptTarget.Latest, true);
      const result: string[][] = [];
      for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!['schemaMigrationSql', 'schemaMigrationMetadata'].includes(declaration.name.getText(ast))) continue;
          const value = declaration.initializer;
          const array = value && ts.isAsExpression(value) ? value.expression : value;
          if (array && ts.isArrayLiteralExpression(array)) result.push(array.elements.map(element => element.getText(ast)));
        }
      }
      return result;
    };
    const preserved = literalArrays(historical), current = literalArrays(source('server/schema-migration-manifest.ts'));
    expect(preserved).toHaveLength(2);
    for (let i=0;i<2;i++) expect(current[i].slice(0,preserved[i].length)).toEqual(preserved[i]);
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
  async function parity(kind: string) {
    const serverKey = randomBytes(32);
    vi.stubEnv('SERVER_EXECUTION_KEY', serverKey.toString('hex'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const umk = randomBytes(32);
    const walletAddress = bs58.encode(randomBytes(32));
    const wrapped = encryptToBase64(umk, serverKey, buildAAD(walletAddress, 'EUMK_EXEC'));
    const enabled = { executionEnabled: true, emergencyStopTriggered: false, umkEncryptedForExecution: wrapped };
    const cases = {
      Enabled: enabled, Missing: null, Revoked: { ...enabled, executionEnabled: false },
      Stopped: { ...enabled, emergencyStopTriggered: true }, Unwrapped: { ...enabled, umkEncryptedForExecution: null },
      Corrupt: { ...enabled, umkEncryptedForExecution: 'EXAMPLE' },
      Mismatched: { ...enabled, umkEncryptedForExecution: encryptToBase64(umk, serverKey, buildAAD(bs58.encode(randomBytes(32)), 'EUMK_EXEC')) },
    };
    const wallet = cases[kind as keyof typeof cases];
    const context = { exports: {} as Record<string, any>, storage: { getWallet: async () => wallet }, getServerExecutionKey, buildAAD, decryptFromBase64, zeroizeBuffer: (b: Buffer) => b.fill(0), console: { error() {} } };
    vm.runInNewContext(transpile(functionText(baselineSource('server/session-v3.ts'), 'getUmkForWebhook')), context);
    const oldResult = await context.exports.getUmkForWebhook(walletAddress);
    const newResult = unwrapExecutionUmk(walletAddress, wallet);
    const result = { refused: newResult === null, baselineRefused: oldResult === null,
      equal: Boolean(newResult && oldResult && newResult.umk.equals(oldResult.umk)), cleared: false };
    newResult?.cleanup(); oldResult?.cleanup(); umk.fill(0); serverKey.fill(0);
    result.cleared = Boolean(newResult?.umk.every(byte => byte === 0));
    return result;
  }
  for (const name of ['Enabled', 'Missing', 'Revoked', 'Stopped', 'Unwrapped', 'Corrupt', 'Mismatched']) {
    it(`Parity${name}`, async () => { const r = await parity(name); expect(r.refused).toBe(r.baselineRefused); });
  }
  it('ParityBytes', async () => { expect((await parity('Enabled')).equal).toBe(true); });
  it('ParityCleanup', async () => { expect((await parity('Enabled')).cleared).toBe(true); });
  async function lookup() {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await readExecutionWallet({ query }, 'EXAMPLE-wallet');
    return { result, sql: query.mock.calls[0][0] as string, args: query.mock.calls[0][1] };
  }
  it('LookupMissing', async () => { expect((await lookup()).result).toBeNull(); });
  it('LookupIdentity', async () => { expect((await lookup()).args).toEqual(['EXAMPLE-wallet']); });
  it('LookupBoundary', async () => { expect((await lookup()).sql).not.toMatch(/SELECT\s+\*|encrypted_user_master_key|user_salt|encrypted_mnemonic_words|agent_private_key_encrypted(?:\s|,)/i); });
  const columns = { Address: 'address', Enabled: 'execution_enabled', Stop: 'emergency_stop_triggered', Wrap: 'umk_encrypted_for_execution', Version: 'umk_version', Public: 'agent_public_key', Private: 'agent_private_key_encrypted_v3' };
  for (const [name, column] of Object.entries(columns)) it(`Column${name}`, async () => { expect((await lookup()).sql).toContain(column); });
});

function catalogFixture() {
  const requirements = SCHEMA_MIGRATION_MANIFEST.flatMap(m => [...m.requirements]);
  return vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('AS \"checkedAt\"')) return { rows: [{ checkedAt: new Date(0), expiresAt: new Date(60_000) }] };
    if (/^(BEGIN READ ONLY|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (!/^SELECT\b/i.test(sql.trim())) throw new Error('fixture refused a write');
    // Data postconditions also query information_schema/pg_index. Match their
    // exact SQL before generic catalog shapes so their boolean `ok` survives.
    if (requirements.some(r => r.kind === 'data' && r.checkSql === sql)) return { rows: [{ ok: true }] };
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

describe('U2a readiness isolation', () => {
  it('package absence changes only grid_worker and leaves previous requirements identical', async () => {
    const legacy = SCHEMA_MIGRATION_MANIFEST.filter(m => !m.capabilities.includes('grid_worker'));
    const added = SCHEMA_MIGRATION_MANIFEST.filter(m => m.capabilities.includes('grid_worker'));
    expect(added).toHaveLength(1);
    expect(added[0].sql.trim()).toBe('SELECT 1');
    expect(added[0].capabilities).toEqual(['grid_worker']);
    const requirement = added[0].requirements[0];
    if (requirement.kind !== 'data') throw Error('isolated data requirement expected');
    expect(legacy.flatMap(m => [...m.requirements]).some(r => r.kind === 'data' && r.identity === requirement.identity)).toBe(false);
    const query = catalogFixture();
    const before = await probeSchemaMigrationManifest(query, legacy);
    const after = await probeSchemaMigrationManifest((sql, values) => sql === requirement.checkSql ? Promise.reject(Error('package absent')) : query(sql, values), SCHEMA_MIGRATION_MANIFEST);
    expect(after.unavailableCapabilities.filter(c => c !== 'grid_worker')).toEqual(before.unavailableCapabilities);
    expect(after.evidence.filter(e => e.capability !== 'grid_worker')).toEqual(before.evidence);
    expect(after.unavailableCapabilities).toContain('grid_worker');
  });
  it('unrelated missing capability cannot block required worker capabilities', async () => {
    const query = catalogFixture();
    const required = new Set(['grid_bot', 'wallet_security', 'grid_worker']);
    const unrelated = SCHEMA_MIGRATION_MANIFEST.filter(m => !m.capabilities.some(c => required.has(c))).flatMap(m => [...m.requirements]).filter(r => r.kind === 'data');
    const forbidden = new Set(unrelated.map(r => r.kind === 'data' ? r.checkSql : ''));
    const snapshot = await probeGridWorkerSchema((sql, values) => forbidden.has(sql) ? Promise.resolve({ rows: [{ ok: false }] }) : query(sql, values));
    expect(snapshot.unavailableCapabilities.filter(c => required.has(c))).toEqual([]);
    expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.checkedAt)).toBe(60_000);
  });
});

let built: ReturnType<typeof buildGridWorker> | undefined;
const artifactBuild = () => built ??= buildGridWorker(artifactDir);
async function artifactFixture() {
  const { outfile } = await artifactBuild();
  vi.stubEnv('AGENT_ENCRYPTION_KEY', undefined); vi.stubEnv('UMK_STORAGE_SECRET', undefined);
  for (const key of Object.keys(process.env)) if (/^PG|^(SESSION_SECRET|ADMIN_PASSWORD|LOG_READ_TOKEN|QV_PROD_DATABASE_URL)$|^TELEGRAM_|^DATA_RELAY_/.test(key)) vi.stubEnv(key, undefined);
  const env = fixtureEnv();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return { env, artifact: require(outfile) as typeof import('../../server/grid-worker/index') };
}
async function bootFixture() {
  const { artifact } = await artifactFixture();
  const query = catalogFixture();
  const release = vi.fn(); const close = vi.fn(async () => {});
  await artifact.bootGridWorker(() => ({ connect: async () => ({ query, release }) as any, close }));
  return { query, release, close };
}
async function signingFixture() {
  const { artifact, env } = await artifactFixture();
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
  if (!execution) throw new Error('fixture execution unwrap failed');
  const decrypted = artifact.decryptAgentKeyV3(execution.umk, encrypted, wallet);
  try {
    const length = decrypted.length;
    const der = Buffer.concat([Buffer.from([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]), decrypted.subarray(0, 32)]);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); der.fill(0);
    const message = Buffer.from('EXAMPLE offline U1 signing fixture');
    const verified = verify(null, message, pair.publicKey, sign(null, message, key));
    execution.cleanup();
    return { length, verified, cleared: execution.umk.every(byte => byte === 0) };
  } finally { decrypted.fill(0); execution.cleanup(); umk.fill(0); }
}
describe('U1 built artifact', () => {
  it('ClosureComputed', async () => { expect((await artifactBuild()).proof.computedImports).toBe(0); });
  it('ClosurePool', async () => { expect((await artifactBuild()).proof.inputs).toContain('server/grid-worker/database.ts'); });
  it('ClosureReadiness', async () => { expect((await artifactBuild()).proof.inputs.some(p => /schema-readiness\.ts$/.test(p))).toBe(false); });
  for (const [name, suffix] of Object.entries({ External: 'require("EXAMPLE");', Dynamic: 'require(process.argv[2]);', Canonical: 'getStorageKeyV3();', MnemonicCall: 'decryptMnemonic();', MnemonicAccess: 'record.MNEMONIC;', MnemonicComputed: 'record["MNEMONIC"];', MnemonicMethod: '({ MNEMONIC() {} });' })) {
    it(`Closure${name}`, async () => {
      const { outfile } = await artifactBuild();
      const meta = JSON.parse(readFileSync(join(artifactDir, 'grid-worker.meta.json'), 'utf8'));
      expect(() => auditWorkerOutput(readFileSync(outfile, 'utf8') + '\n' + suffix, meta)).toThrow();
    });
  }
  async function invalidBoot() {
    const { outfile } = await artifactBuild();
    const r = spawnSync(process.execPath, [outfile], { env: {}, encoding: 'utf8' });
    if (r.error) throw r.error;
    return r;
  }
  it('BootDenied', async () => { expect((await invalidBoot()).status).toBe(1); });
  it('BootSanitized', async () => { expect((await invalidBoot()).stderr.trim()).toBe('GRID_WORKER_U1_BOOT_FAILED'); });
  it('BootReadonly', async () => { expect((await bootFixture()).query.mock.calls[0][0]).toBe('BEGIN READ ONLY'); });
  it('BootCommit', async () => { expect((await bootFixture()).query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); });
  it('BootRelease', async () => { expect((await bootFixture()).release).toHaveBeenCalledOnce(); });
  it('BootClose', async () => { expect((await bootFixture()).close).toHaveBeenCalledOnce(); });
  it('BootSchemaDenied', async () => {
    const { artifact } = await artifactFixture();
    const query = catalogFixture();
    const failedSql = SCHEMA_MIGRATION_MANIFEST.filter(m => m.capabilities.includes('grid_worker')).flatMap(m => [...m.requirements]).find(r => r.kind === 'data')!;
    if (failedSql.kind !== 'data') throw new Error('fixture data requirement missing');
    await expect(artifact.bootGridWorker(() => ({
      connect: async () => ({ query: (sql: string, values: readonly unknown[]) => sql === failedSql.checkSql
        ? Promise.resolve({ rows: [{ ok: false }] }) : query(sql, values), release() {} }) as any,
      close: async () => {},
    }))).rejects.toThrow('GRID_WORKER_SCHEMA_UNAVAILABLE');
  });
  it('SignerLength', async () => { expect((await signingFixture()).length).toBe(64); });
  it('SignerVerified', async () => { expect((await signingFixture()).verified).toBe(true); });
  it('SignerCleanup', async () => { expect((await signingFixture()).cleared).toBe(true); });
});

const typedFiles = {
  Worker: 'tests/server/grid-worker-u1.test.ts',
  U2a: 'tests/server/grid-worker-u2a-schema.test.ts',
  U2aWallets: 'tests/server/grid-worker-u2a-wallets.test.ts',
  Database: 'tests/server/grid-worker-database.test.ts',
  Url: 'tests/helpers/grid-worker-fixture-url.ts',
  Draft: 'tests/grid-bot/draft-storage.test.ts',
  Phoenix: 'tests/helpers/phoenix-schema.ts',
  Manifest: 'tests/helpers/schema-migration-manifest.ts',
  Rpc: 'tests/server/rpc-runtime-failover-inventory.test.ts',
  Monitor: 'tests/grid-bot/monitor-storage.test.ts',
  Pnl: 'tests/server/bot-trades-pnl-convention.test.ts',
  Enrichment: 'tests/storage/bot-list-enrichment.test.ts',
  Reset: 'tests/vault/reset-agent-wallet-db-lock.test.ts',
  Build: 'script/build-grid-worker.ts',
};
let typedProgram: ts.Program | undefined;
function compilerOptions() {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
}
function diagnosticsFor(path: string) {
  typedProgram ??= ts.createProgram(Object.values(typedFiles), { ...compilerOptions().options, incremental: false });
  const file = typedProgram.getSourceFile(resolve(path));
  if (!file) throw new Error(`missing compiler input ${path}`);
  return [...typedProgram.getSyntacticDiagnostics(file), ...typedProgram.getSemanticDiagnostics(file)]
    .map(d => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}
describe('U1 compiler diagnostics', () => {
  it('TypesCiBaselineDriftMatchesMain', () => {
    const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 150_000 });
    if (result.error) throw result.error;
    expect([0, 2]).toContain(result.status);
    const lines = result.stdout.split('\n').filter(line => /error TS[0-9]+:/.test(line)).map(line => line.replace(/\([0-9]+,[0-9]+\)/, '').trim()).sort();
    const counts = new Map<string, number>();
    for (const line of readFileSync('.github/typecheck-baseline.txt', 'utf8').split('\n').filter(Boolean)) counts.set(line, (counts.get(line) ?? 0) + 1);
    const added = lines.filter(line => { const n = counts.get(line) ?? 0; if (n) { counts.set(line, n - 1); return false; } return true; });
    const mainCommitHash = '905aa2650a765fa1e2a58f3dee474cce33e5e46d';
    const checkout = mkdtempSync(join(tmpdir(), 'grid-u2a-main-types-'));
    try {
      const archive = execFileSync('git', ['archive', '--format=tar', mainCommitHash], { maxBuffer: 128 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', checkout], { input: archive });
      symlinkSync(resolve('node_modules'), join(checkout, 'node_modules'), 'dir');
      const main = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', 'false'], { cwd: checkout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 150_000 });
      if (main.error) throw main.error;
      expect([0, 2]).toContain(main.status);
      const baselineLines = main.stdout.split('\n').filter(line => /error TS[0-9]+:/.test(line)).map(line => line.replace(/\([0-9]+,[0-9]+\)/, '').trim()).sort();
      const remaining = [...baselineLines];
      const newErrors = lines.filter(line => { const index = remaining.indexOf(line); if (index < 0) return true; remaining.splice(index, 1); return false; });
      writeFileSync(join(artifactDir, 'typecheck-ci.json'), JSON.stringify({ mainCommitHash, total: lines.length, storedBaselineDrift: added.length, newErrors: newErrors.length, added, newDiagnostics: newErrors }, null, 2));
      const first = newErrors[0] ?? '';
      const previous = baselineLines.find(line => line.split(': error ')[0] === first.split(': error ')[0]) ?? '';
      let common = 0; while (common < Math.min(first.length, previous.length) && first[common] === previous[common]) common++;
      expect(newErrors, JSON.stringify({ count: newErrors.length, path: first.split(': error ')[0], current: first.slice(common, common + 65), main: previous.slice(common, common + 65) })).toEqual([]);
    } finally { rmSync(checkout, { recursive: true, force: true }); }
  }, 320_000);
  for (const [name, path] of Object.entries(typedFiles)) it(`Types${name}`, () => {
    const diagnostics = diagnosticsFor(path);
    writeFileSync(join(artifactDir, `typecheck-${name}.json`), JSON.stringify(diagnostics, null, 2));
    expect(diagnostics).toEqual([]);
  }, 150_000);
  it('TypesProduction', () => {
    // Compare both trees with the same compiler/dependencies. A stored rendered
    // baseline can differ solely in object member ordering across installations.
    const config = compilerOptions();
    const options = { ...config.options, incremental: false };
    const changed = execFileSync('git', ['diff', '--name-only', baseCommitHash, 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(p => /\.tsx?$/.test(p));
    const oldFiles = new Map<string, string | undefined>();
    for (const path of changed) {
      const r = spawnSync('git', ['show', `${baseCommitHash}:${path}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (r.error) throw r.error;
      if (![0, 128].includes(r.status!)) throw new Error('baseline source lookup failed');
      oldFiles.set(resolve(path), r.status === 0 ? r.stdout : undefined);
    }
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host); const exists = host.fileExists.bind(host);
    host.readFile = path => oldFiles.has(resolve(path)) ? oldFiles.get(resolve(path)) : read(path);
    host.fileExists = path => oldFiles.has(resolve(path)) ? oldFiles.get(resolve(path)) !== undefined : exists(path);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (!oldFiles.has(resolve(path))) return getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
      const text = oldFiles.get(resolve(path));
      return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true);
    };
    const format = (program: ts.Program) => ts.getPreEmitDiagnostics(program).map(d => `${d.file ? d.file.fileName.replace(process.cwd() + '/', '') : 'config'}: TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`).sort();
    const baseline = format(ts.createProgram(config.fileNames.filter(p => host.fileExists(p)), options, host));
    const diagnostics = format(ts.createProgram(config.fileNames, options));
    const counts = new Map<string, number>();
    for (const line of baseline) counts.set(line, (counts.get(line) ?? 0) + 1);
    const added = diagnostics.filter(line => { const n = counts.get(line) ?? 0; if (n) { counts.set(line, n - 1); return false; } return true; });
    writeFileSync(join(artifactDir, 'typecheck.json'), JSON.stringify({ total: diagnostics.length, newErrors: added.length, added }, null, 2));
    expect(added).toEqual([]);
  }, 150_000);
});
