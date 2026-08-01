import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { SCANNER_VERSION, isPlaceholder, scanFiles } from '../../scripts/qv-secrets-scan.mjs';

const scanner = resolve('scripts/qv-secrets-scan.mjs');
const roots: string[] = [];

function fixture(contents: string | Buffer, name = 'fixture.txt') {
  const root = mkdtempSync(join(tmpdir(), 'qv-secret-scan-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, contents);
  return path;
}

function opaque(bytes = 32) {
  return Buffer.from(Array.from({ length: bytes }, (_, index) => (index * 73 + 19) % 256)).toString('base64');
}

function cli(paths: string[]) {
  return spawnSync(process.execPath, [scanner, '--json', ...paths.flatMap(path => ['--file', path])], {
    cwd: resolve('.'), encoding: 'utf8', shell: false,
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('qv-secrets-scan', () => {
  it('catches a synthetic 44-character bearer without echoing it', () => {
    const token = opaque();
    expect(token).toHaveLength(44);
    const result = cli([fixture(`Authorization: Bearer ${token}\n`)]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.files[0].findings).toContainEqual({ ruleId: 'authorization-bearer', line: 1 });
  });

  it.each([
    ['vendor-anthropic-key', `sk-ant-${opaque()}`],
    ['vendor-openrouter-key', `sk-or-v1-${opaque()}`],
    ['vendor-openai-project-key', `sk-proj-${opaque()}`],
    ['vendor-generic-sk-key', `sk-${opaque()}`],
    ['vendor-github-token', `ghp_${opaque()}`],
    ['vendor-slack-token', `xoxb-${opaque()}`],
    ['vendor-aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['vendor-google-api-key', `AIza${opaque()}`],
    ['vendor-huggingface-token', `hf_${opaque()}`],
    ['vendor-perplexity-key', `pplx-${opaque()}`],
    ['vendor-telegram-token', `123456789:${opaque()}`],
  ])('catches %s without echo', (ruleId, value) => {
    const result = cli([fixture(`value=${value}\n`)]);
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(value);
    expect(JSON.parse(result.stdout).files[0].findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId })]),
    );
  });

  it.each([
    ['api-key-assignment', `x-api-key: ${opaque()}`],
    ['pem-private-key', '-----BEGIN PRIVATE KEY-----'],
    ['credential-database-url', `postgres://user:${opaque()}@db.example.invalid/app`],
    ['rpc-url-credential', `https://mainnet.helius-rpc.com/?api-key=${opaque()}`],
    ['secret-assignment-entropy', `mnemonic=${opaque()}`],
    ['standalone-entropy', `opaque ${opaque()}`],
  ])('catches required family %s', (ruleId, line) => {
    const result = cli([fixture(`${line}\n`)]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).files[0].findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId })]),
    );
  });

  it('keeps placeholders and measured false-positive controls clean', () => {
    const vitestJson = Buffer.from(JSON.stringify({ numTotalTestSuites: 17, success: true })).toString('base64');
    const hash = createHash('sha256').update('public fixture').digest('hex');
    const transaction = '4Nd1mYwZPfozKz9hQF6iY3dK7sB8uP2xE5rT9cV1nM4aL6gH8jQ2wS5eR7tY9uK3pD6fG8hJ1kL4mN7pQ';
    const clean = [
      'token=$QV_LOGS_TOKEN', 'token=${NAME}', 'api_key=<API_KEY>', 'token=REDACTED',
      'token=EXAMPLE', 'token=CHANGEME', 'token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'id=550e8400-e29b-41d4-a716-446655440000', 'parkedValueUnavailable=', vitestJson,
      `SHA-256: ${hash}`, `mainnet transaction signature ${transaction}`,
    ].join('\n');
    const result = cli([fixture(clean)]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).findingCount).toBe(0);
  });

  it('reports unclassified 40/64 hex while preserving labelled public hashes', () => {
    const secretLike = createHash('sha256').update('unclassified private material shape').digest('hex');
    const red = cli([fixture(`unlabelled ${secretLike}\n`)]);
    expect(red.status).toBe(2);
    expect(JSON.parse(red.stdout).files[0].findings).toContainEqual({ ruleId: 'unclassified-hex', line: 1 });
    const green = cli([fixture(`| SHA-256 |\n|---|\n| ${secretLike} |\n`)]);
    expect(green.status).toBe(0);
  });

  it('returns deterministic safe file metadata from the importable module', () => {
    const path = fixture('ordinary prose\n');
    const first = scanFiles([path]);
    const second = scanFiles([path]);
    expect(first).toEqual(second);
    expect(first.version).toBe(SCANNER_VERSION);
    expect(first.files[0]).toMatchObject({ path, bytes: 15, lines: 2, findings: [] });
    expect(first.files[0].sha256).toMatch(/^[0-9A-F]{64}$/);
  });

  it('rejects duplicate arguments without scanning adjacent files', () => {
    const target = fixture('clean\n');
    const adjacent = join(resolve(target, '..'), 'adjacent.txt');
    const marker = opaque();
    writeFileSync(adjacent, marker);
    const result = cli([target, target]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(JSON.parse(result.stdout).error.code).toBe('duplicate_file');
  });

  it.each([
    ['missing', (root: string) => join(root, 'missing.txt'), 'file_unreadable'],
    ['directory', (root: string) => root, 'not_regular_file'],
    ['binary', (root: string) => { const p = join(root, 'binary'); writeFileSync(p, Buffer.from([65, 0, 66])); return p; }, 'binary_file'],
  ])('fails closed for a %s input', (_name, build, code) => {
    const root = mkdtempSync(join(tmpdir(), 'qv-secret-scan-error-'));
    roots.push(root);
    const result = cli([build(root)]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
  });

  it('fails closed for a symlink input', () => {
    const root = mkdtempSync(join(tmpdir(), 'qv-secret-scan-link-'));
    roots.push(root);
    const target = join(root, 'target-directory');
    mkdirSync(target);
    writeFileSync(join(target, 'clean.txt'), 'clean\n');
    const link = join(root, 'link.txt');
    symlinkSync(target, link, 'junction');
    const result = cli([link]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('symlink_not_allowed');
  });

  it('exposes placeholder classification without accepting arbitrary low-entropy prose', () => {
    expect(isPlaceholder('$NAME')).toBe(true);
    expect(isPlaceholder('<TOKEN>')).toBe(true);
    expect(isPlaceholder('not-a-placeholder')).toBe(false);
  });

  it('rejects invalid CLI shapes with originating exit 1', () => {
    for (const args of [[], ['--json'], ['--file'], ['--wat']]) {
      const result = spawnSync(process.execPath, [scanner, ...args], { encoding: 'utf8', shell: false });
      expect(result.status).toBe(1);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });
});
