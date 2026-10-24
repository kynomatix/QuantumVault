import { expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

it('U2a full product typecheck has CI New errors: 0 and changed tests typecheck', () => {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
  const testFiles = ['tests/server/grid-worker-u2a-schema.test.ts', 'tests/server/grid-worker-u2a-types.test.ts', 'tests/server/grid-worker-u2b-auth.test.ts', 'tests/server/grid-worker-u2b-postgres.test.ts', 'tests/grid-bot/first-placement.test.ts', 'tests/grid-bot/launch-storage.test.ts'].map(f => resolve(f));
  testFiles.push(...['tests/server/grid-worker-u2c-postgres.test.ts','tests/server/grid-worker-u2c-consent.test.ts','tests/server/grid-worker-u2c-oracle.test.ts','tests/helpers/grid-worker-isolation.ts','scripts/backfill-protocol-subaccounts.ts'].map(f=>resolve(f)));
  testFiles.push(...['auto-resume-storage','cycle-runtime','draft-storage','lean-capacity-storage','monitor-storage','range-move-storage'].map(f=>resolve('tests/grid-bot/'+f+'.test.ts')));
  testFiles.push(resolve('tests/server/grid-worker-u2a-wallets.test.ts'));
  const program = ts.createProgram([...parsed.fileNames, ...testFiles], { ...parsed.options, incremental: false, noEmit: true });
  const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  const baseline = new Map<string, number>();
  for (const line of readFileSync('.github/typecheck-baseline.txt', 'utf8').trim().split(/\r?\n/)) baseline.set(line, (baseline.get(line) ?? 0) + 1);
  const added: string[] = [];
  // Match CI's line/column-stripped multiset, including its first-line diagnostic convention.
  for (const d of errors) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0];
    const file = d.file ? relative(process.cwd(), resolve(d.file.fileName)).replaceAll('\\', '/') : '';
    const line = (file ? file + ': ' : '') + 'error TS' + d.code + ': ' + message;
    const count = baseline.get(line) ?? 0;
    if (count > 0) baseline.set(line, count - 1); else added.push(line);
  }
  expect(added, 'CI New errors: ' + added.length + ' ' + added.map(d=>d.replace(/^.*error TS/,'TS').slice(0,80)).join(' | ')).toEqual([]);
  expect(errors.filter(d => d.file && testFiles.includes(resolve(d.file.fileName)))).toEqual([]);
}, 180_000);
