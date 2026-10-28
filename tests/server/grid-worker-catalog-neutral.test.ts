import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GRID_WORKER_CATALOG_CAPTURE_SQL, GRID_WORKER_CATALOG_CHECK_SQL, GRID_WORKER_CATALOG_SHA256 } from '../../server/grid-worker/schema';
import { gridWorkerIsolation } from '../helpers/grid-worker-isolation';
import { readDbSchemaMigrationManifest } from '../helpers/schema-migration-manifest';

const packageLf = readFileSync('migrations/grid_worker_v3_owner.sql', 'utf8').replaceAll('\r\n', '\n');
const pinned: { catalogSha256: string; tablesSha256: string; packageSqlSha256: string; objects: { identity: string; sha256: string }[] } =
  JSON.parse(readFileSync('tests/fixtures/grid-worker-neutral-catalog.json', 'utf8'));

// Lex body tokens, ignoring comments. A newline inside any quoted token could be
// data rather than SQL whitespace, making CRLF normalization unsafe.
function assertNoQuotedLineBreak(body: string) {
  // Fail before lexing, including in comments and literals: these constructs
  // depend on string settings or identifier/dollar-quote boundary rules.
  if (body.includes('\\')) throw Error('Backslash in function body');
  if (/(?:[A-Za-z0-9_\u0080-\uFFFF]\$|\$[A-Za-z0-9_\u0080-\uFFFF])/u.test(body)) {
    throw Error('Dollar sign adjacent to an identifier character in function body');
  }
  for (let i = 0; i < body.length;) {
    if (body.startsWith('--', i)) { const end = body.indexOf('\n', i); i = end < 0 ? body.length : end + 1; continue; }
    if (body.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (depth && i < body.length) {
        if (body.startsWith('/*', i)) { depth++; i += 2; }
        else if (body.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw Error('Unterminated body comment');
      continue;
    }
    const start = i, quote = body[i];
    if (quote === "'" || quote === '"') {
      const escapes = quote === "'" && /(?:^|[^A-Za-z0-9_$])[eE]$/.test(body.slice(0, i));
      let closed = false; i++;
      while (i < body.length) {
        if (escapes && body[i] === '\\') { i += 2; continue; }
        if (body[i++] !== quote) continue;
        if (body[i] === quote) { i++; continue; }
        closed = true; break;
      }
      if (!closed) throw Error('Unterminated body quote');
    } else {
      const tag = body.slice(i).match(/^(?:\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)/)?.[0];
      if (!tag) { i++; continue; }
      const end = body.indexOf(tag, i + tag.length);
      if (end < 0) throw Error('Unterminated body dollar quote');
      i = end + tag.length;
    }
    if (/[\r\n]/.test(body.slice(start, i))) throw Error('Line break inside a quoted body token');
  }
}

describe('Catalog normalization static safety', () => {
  it('all ten package function bodies have line breaks only outside quoted tokens', () => {
    const bodies = [...packageLf.matchAll(/CREATE FUNCTION (\w+)\([^\n]*? AS (\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)([\s\S]*?)\2;/g)];
    expect(bodies).toHaveLength(10);
    expect(bodies.length).toBe([...packageLf.matchAll(/\bCREATE FUNCTION\b/g)].length);
    for (const body of bodies) expect(() => assertNoQuotedLineBreak(body[3]), body[1]).not.toThrow();
  });
  it.each(["'EXAMPLE\nDATA'", '\"EXAMPLE\r\nNAME\"', '$$!\n!$$', "'EXAMPLE''\nDATA'"])(
    'rejects multiline quoted token %j', body => expect(() => assertNoQuotedLineBreak(body)).toThrow('Line break'),
  );
  it.each(["SELECT E'EXAMPLE\\DATA'", "SELECT 'EXAMPLE\\DATA'", '-- EXAMPLE\\', '/* \\ */'])(
    'rejects every backslash before lexing %j', body => expect(() => assertNoQuotedLineBreak(body)).toThrow('Backslash'),
  );
  it.each(['a$b$', '$tag$!$tag$', '$1', 'a$', '$a', '_$', '1$', '$é', 'é$', '-- a$', '/* $a */', "'a$'"])(
    'rejects dollar signs adjacent to identifier characters %j', body => expect(() => assertNoQuotedLineBreak(body)).toThrow('Dollar sign'),
  );
  it('handles doubled quotes and nested comments without treating comment quotes as tokens', () => {
    expect(() => assertNoQuotedLineBreak("-- ' ignored\n/* \" /* nested */ ' */\nSELECT 'EXAMPLE''DATA', \"EXAMPLE\"\"NAME\", $$!$$;\n")).not.toThrow();
  });
  it('all 25 fallback per-object sha256 guards match the normalized fixture', () => {
    const fallback = readFileSync('migrations/grid_worker_v3_fallback.sql', 'utf8');
    const guards = [...fallback.matchAll(/capture\."objectHashes"->>'([^']+)'[\s\S]*?\) capture\) IS DISTINCT FROM '([a-f0-9]{64})'/g)];
    expect(guards).toHaveLength(25);
    expect(new Set(guards.map(m => m[1])).size).toBe(25);
    const expected = new Map(pinned.objects.map(o => [o.identity, o.sha256]));
    for (const guard of guards) expect(guard[2], guard[1]).toBe(expected.get(guard[1]));
  });
  it('all 31 embedded captures are byte-identical and use the same catalog pin', () => {
    const captures = (sql: string) => [...sql.matchAll(/WITH package_tables AS \([\s\S]*? AS "objectHashes" FROM digests/g)].map(m => m[0]);
    const fallback = readFileSync('migrations/grid_worker_v3_fallback.sql', 'utf8').replaceAll('\r\n', '\n');
    const { manifest } = readDbSchemaMigrationManifest();
    const manifestCheck = manifest.flatMap(m => m.requirements).find(r => r.kind === 'data' && r.identity === 'grid_worker.owner_package.exact_catalog_v1');
    if (!manifestCheck || manifestCheck.kind !== 'data') throw Error('Missing owner catalog manifest check');
    expect(manifestCheck.checkSql).toBe(GRID_WORKER_CATALOG_CHECK_SQL);
    const all = [GRID_WORKER_CATALOG_CAPTURE_SQL, ...captures(GRID_WORKER_CATALOG_CHECK_SQL), ...captures(packageLf), ...captures(fallback), ...captures(manifestCheck.checkSql)];
    expect(all).toHaveLength(31);
    for (const capture of all) expect(capture).toBe(GRID_WORKER_CATALOG_CAPTURE_SQL);
    expect(GRID_WORKER_CATALOG_SHA256).toBe(pinned.catalogSha256);
    expect(createHash('sha256').update(packageLf).digest('hex')).toBe(pinned.packageSqlSha256);
    expect(fallback).toContain("IS DISTINCT FROM '" + pinned.tablesSha256 + "'");
    for (const text of [packageLf, fallback, GRID_WORKER_CATALOG_CHECK_SQL]) {
      const pins = [...text.matchAll(/"catalogSha256" = '([a-f0-9]{64})'/g)];
      expect(pins.length).toBeGreaterThan(0);
      for (const pin of pins) expect(pin[1]).toBe(pinned.catalogSha256);
    }
  });
});

type Capture = { catalogSha256: string; tablesSha256: string; objectHashes: Record<string, string> };
type Fixture = { schema: string; pool: Pool; db: PoolClient; install: string; capture?: Capture };
describe('FRACTAL environment-neutral package catalog', () => {
  let admin: Pool;
  const fixtures: Fixture[] = [];
  async function install(crlf: boolean, shifted: boolean) {
    const schema = 'grid_neutral_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: '-c search_path=' + schema + ',pg_catalog' });
    const f: Fixture = { schema, pool, db: gridWorkerIsolation()(await pool.connect()), install: '' };
    fixtures.push(f);
    for (const table of ['wallets', 'grid_bots', 'grid_operations', 'grid_control_requests', 'protocol_subaccounts', 'grid_launch_accounts']) {
      const shift = shifted && ['wallets', 'grid_bots'].includes(table);
      await f.db.query(`CREATE TABLE ${table} (${shift ? 'EXAMPLE_dropped integer, ' : ''}LIKE public.${table} INCLUDING ALL)`);
      if (shift) await f.db.query(`ALTER TABLE ${table} DROP COLUMN EXAMPLE_dropped`);
    }
    f.install = packageLf.replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + schema);
    if (crlf) f.install = f.install.replaceAll('\n', '\r\n');
    await f.db.query(f.install);
    f.capture = (await f.db.query(GRID_WORKER_CATALOG_CAPTURE_SQL)).rows[0];
    return f;
  }
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || new URL(url).pathname !== '/qvtest') throw Error('FRACTAL qvtest required');
    admin = new Pool({ connectionString: url, max: 1 });
    await install(false, false);
    await install(true, false);
    await install(false, true);
  }, 60_000);
  afterAll(async () => {
    for (const f of fixtures) {
      await f.db.query('ROLLBACK'); f.db.release(); await f.pool.end();
      await admin.query('DROP SCHEMA IF EXISTS ' + f.schema + ' CASCADE');
    }
    await admin?.end();
  });
  // Decimal bytes preserve digest diagnostics through the runner's hex redaction.
  for (const object of pinned.objects) it('diagnostic per-object sha256 ' + object.identity, () => {
    const actual = fixtures[0].capture!.objectHashes[object.identity];
    if (actual !== object.sha256) throw Error('actual sha256 bytes=' + JSON.stringify([...Buffer.from(actual, 'hex')]));
  });
  it('diagnostic canonical catalog sha256 measurement', () => {
    const actual = fixtures[0].capture!.catalogSha256;
    if (actual !== pinned.catalogSha256) throw Error('actual sha256 bytes=' + JSON.stringify([...Buffer.from(actual, 'hex')]));
  });
  it('all six UPDATE OF triggers capture column names in source order; the other nine retain empty attributes', async () => {
    const expected = new Map([...packageLf.matchAll(/^CREATE TRIGGER (\w+) [^\n]*?UPDATE OF (.*?) ON (\w+)/gm)]
      .map(m => ['trigger:' + m[3] + '.' + m[1], m[2].split(/\s*,\s*/).join(' ')]));
    expect(expected.size).toBe(6);
    const objectsSql = GRID_WORKER_CATALOG_CAPTURE_SQL.slice(0, GRID_WORKER_CATALOG_CAPTURE_SQL.indexOf('), digests AS (')) + ') SELECT identity, definition FROM objects';
    const triggers = (await fixtures[0].db.query(objectsSql)).rows.filter(r => r.identity.startsWith('trigger:'));
    expect(triggers).toHaveLength(15);
    for (const trigger of triggers) expect(trigger.definition.attributes, trigger.identity).toBe(expected.get(trigger.identity) ?? '');
  });
  for (const [index, name] of ['canonical LF', 'CRLF before install', 'shifted column ordinals'].entries()) {
    it(name + ' measures exactly the catalog and tables sha256 pins and all 36 objects', async () => {
      const f = fixtures[index];
      expect(f.capture?.catalogSha256).toBe(pinned.catalogSha256);
      expect(f.capture?.tablesSha256).toBe(pinned.tablesSha256);
      expect(f.capture?.objectHashes).toEqual(Object.fromEntries(pinned.objects.map(o => [o.identity, o.sha256])));
      expect((await f.db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows).toEqual([{ ok: true }]);
      const counts = (await f.db.query("SELECT count(*) FILTER (WHERE position(chr(13)||chr(10) in prosrc)>0)::integer AS crlf, count(*)::integer AS total FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'grid_worker_%'")).rows[0];
      expect(counts).toEqual({ crlf: index === 1 ? 10 : 0, total: 10 });
    });
    it(name + ' rerun takes the same-shape RETURN branch without replacing objects', async () => {
      const f = fixtures[index];
      const oids = () => f.db.query("SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace UNION ALL SELECT oid FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid");
      const before = (await oids()).rows;
      try { await f.db.query(f.install); } finally { await f.db.query('ROLLBACK'); }
      expect((await oids()).rows).toEqual(before);
      expect((await f.db.query(GRID_WORKER_CATALOG_CAPTURE_SQL)).rows[0]).toEqual(f.capture);
    });
  }
  it('the shifted fixtures really have different tgattr ordinals and a dropped leading column', async () => {
    const sql = "SELECT c.relname, t.tgattr::text AS ordinals FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND t.tgname IN ('grid_worker_wallet_update','grid_worker_grid_bots_update') ORDER BY c.relname";
    const a = (await fixtures[0].db.query(sql)).rows, b = (await fixtures[2].db.query(sql)).rows;
    expect(a).toHaveLength(2); expect(b).toHaveLength(2);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].relname).toBe(a[i].relname);
      expect(b[i].ordinals.split(' ').map(Number)).toEqual(a[i].ordinals.split(' ').map((n: string) => Number(n) + 1));
    }
    expect((await fixtures[2].db.query("SELECT count(*)::integer AS count FROM pg_attribute WHERE attrelid IN ('wallets'::regclass,'grid_bots'::regclass) AND attnum=1 AND attisdropped")).rows[0].count).toBe(2);
  });
  it('PG18 canonical not-null rows are ordinary and excluded only after validation and inheritance checks', async () => {
    const f = fixtures[0];
    const version = Number((await f.db.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    expect(version).toBeGreaterThanOrEqual(180000);
    const rows = (await f.db.query("SELECT k.convalidated, k.connoinherit, k.conislocal, k.coninhcount FROM pg_constraint k WHERE k.conrelid='grid_worker_host'::regclass AND k.contype='n'")).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toEqual({ convalidated: true, connoinherit: false, conislocal: true, coninhcount: 0 });
  });
  for (const kind of ['not-valid', 'no-inherit', 'inherited']) it('PG18 ' + kind + ' not-null changes the digest and is refused by the prior-shape guard', async () => {
    const f = fixtures[0];
    await f.db.query('BEGIN');
    try {
      const constraintSql = "SELECT k.conname, k.convalidated, k.connoinherit, k.conislocal, k.coninhcount, a.attnotnull FROM pg_constraint k JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey) WHERE k.conrelid='grid_worker_host'::regclass AND k.contype='n' AND a.attname='execution_mode'";
      const before = (await f.db.query(constraintSql)).rows;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ convalidated: true, connoinherit: false, conislocal: true, coninhcount: 0, attnotnull: true });
      if (kind === 'inherited') {
        await f.db.query('CREATE TABLE EXAMPLE_parent (execution_mode text NOT NULL)');
        await f.db.query('ALTER TABLE grid_worker_host INHERIT EXAMPLE_parent');
      } else {
        await f.db.query('ALTER TABLE grid_worker_host ALTER COLUMN execution_mode DROP NOT NULL');
        // Preserve the original name so only the exceptional state differs.
        const name = '"' + before[0].conname.replaceAll('"', '""') + '"';
        await f.db.query('ALTER TABLE grid_worker_host ADD CONSTRAINT ' + name + ' NOT NULL execution_mode ' + (kind === 'not-valid' ? 'NOT VALID' : 'NO INHERIT'));
      }
      const after = (await f.db.query(constraintSql)).rows;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ convalidated: kind !== 'not-valid', connoinherit: kind === 'no-inherit', conislocal: true, coninhcount: kind === 'inherited' ? 1 : 0, attnotnull: true });
      const capture: Capture = (await f.db.query(GRID_WORKER_CATALOG_CAPTURE_SQL)).rows[0];
      expect(capture.catalogSha256).not.toBe(pinned.catalogSha256);
      expect(capture.tablesSha256).not.toBe(pinned.tablesSha256);
      // Round one's broad exclusion would miss the NOT VALID and NO INHERIT replacements.
      const broad = GRID_WORKER_CATALOG_CAPTURE_SQL.replace("(k.contype <> 'n' OR NOT k.convalidated OR k.connoinherit OR NOT k.conislocal OR k.coninhcount <> 0)", "k.contype <> 'n'");
      expect(broad).not.toBe(GRID_WORKER_CATALOG_CAPTURE_SQL);
      expect((await f.db.query(broad)).rows[0]).toEqual(f.capture);
      expect((await f.db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows).toEqual([{ ok: false }]);
      await expect(f.db.query(f.install)).rejects.toThrow('GRID_PACKAGE_PRIOR_SHAPE');
    } finally { await f.db.query('ROLLBACK'); }
  });
  for (const kind of ['check', 'function', 'trigger']) it('a real ' + kind + ' change differs and is refused by the prior-shape guard', async () => {
    const f = fixtures[0];
    await f.db.query('BEGIN');
    try {
      if (kind === 'check') await f.db.query('ALTER TABLE grid_worker_host DROP CONSTRAINT grid_worker_singleton, ADD CONSTRAINT grid_worker_singleton CHECK (singleton_id = 2)');
      if (kind === 'function') {
        const def = (await f.db.query("SELECT pg_get_functiondef('grid_worker_has_wallet_lock(text)'::regprocedure) AS def")).rows[0].def;
        expect(def).toContain("mode='ExclusiveLock'");
        await f.db.query(def.replace("mode='ExclusiveLock'", "mode='ShareLock'"));
      }
      if (kind === 'trigger') {
        const def = (await f.db.query("SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid='grid_bots'::regclass AND tgname='grid_worker_grid_bots_update'")).rows[0].def;
        expect(def).toContain('UPDATE OF wallet_address ON');
        await f.db.query('DROP TRIGGER grid_worker_grid_bots_update ON grid_bots');
        await f.db.query(def.replace('UPDATE OF wallet_address ON', 'UPDATE OF wallet_address, id ON'));
      }
      const capture: Capture = (await f.db.query(GRID_WORKER_CATALOG_CAPTURE_SQL)).rows[0];
      expect(capture.catalogSha256).not.toBe(pinned.catalogSha256);
      expect(capture.tablesSha256 === pinned.tablesSha256).toBe(kind !== 'check');
      expect((await f.db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows).toEqual([{ ok: false }]);
      await expect(f.db.query(f.install)).rejects.toThrow('GRID_PACKAGE_PRIOR_SHAPE');
    } finally { await f.db.query('ROLLBACK'); }
  });
});
