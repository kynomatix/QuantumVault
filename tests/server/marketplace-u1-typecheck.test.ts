import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// FRACTAL-only evidence: use the same diagnostic multiset as GitHub CI.
function newErrors(focused: boolean): string[] {
  const root = process.cwd();
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const files = focused ? [...parsed.fileNames,
    path.join(root, 'tests/server/marketplace-subscriber-fill-accounting.test.ts'),
    path.join(root, 'tests/server/marketplace-subscriber-repair-postgres.test.ts'),
    path.join(root, 'tests/server/marketplace-u1-typecheck.test.ts')] : parsed.fileNames;
  const program = ts.createProgram(files, { ...parsed.options, incremental: false });
  const current = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
    .filter(d => d.category === ts.DiagnosticCategory.Error).map(d => {
      const prefix = d.file ? path.relative(root, d.file.fileName).replaceAll('\\', '/') + ': ' : '';
      return prefix + 'error TS' + d.code + ': ' + ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0];
    });
  const counts = new Map<string, number>();
  for (const line of readFileSync(path.join(root, '.github/typecheck-baseline.txt'), 'utf8').trim().split(/\r?\n/)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return current.filter(line => {
    const count = counts.get(line) ?? 0;
    if (count === 0) return true;
    counts.set(line, count - 1);
    return false;
  });
}
it('CI.production', () => expect(newErrors(false)).toEqual([]), 240000);
it('CI.focused.tests', () => expect(newErrors(true)).toEqual([]), 240000);
