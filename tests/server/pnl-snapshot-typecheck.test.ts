import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('CI typecheck: New errors: 0, including new snapshot tests', () => {
  if (process.platform !== 'linux') throw Error('FRACTAL only');
  const root = process.cwd();
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([...parsed.fileNames,
    path.join(root, 'tests/server/pnl-snapshot-job.test.ts'),
    path.join(root, 'tests/server/pnl-snapshot-typecheck.test.ts'),
  ], { ...parsed.options, incremental: false });
  const current = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
    .filter(d => d.category === ts.DiagnosticCategory.Error).map(d => {
      const prefix = d.file ? path.relative(root, d.file.fileName).replaceAll('\\', '/') + ': ' : '';
      return prefix + 'error TS' + d.code + ': ' + ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0];
    });
  const counts = new Map<string, number>();
  for (const line of readFileSync(path.join(root, '.github/typecheck-baseline.txt'), 'utf8').trim().split(/\r?\n/)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const introduced = current.filter(line => {
    const count = counts.get(line) ?? 0;
    if (count === 0) return true;
    counts.set(line, count - 1);
    return false;
  });
  console.log('New errors: ' + introduced.length);
  expect(introduced).toEqual([]);
}, 240000);
