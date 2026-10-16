import { expect, it } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';

it('type checks the changed Phoenix production and contract modules', () => {
  const names = ['execution-production', 'markets', 'native-events', 'production-reader', 'production', 'order-contract', 'order-service', 'order-store', 'protection-builder', 'protection-contract', 'protection-service', 'safety-routes'];
  const files = [...names.map(n => resolve(`server/protocol/phoenix/${n}.ts`)), resolve('tests/protocol/phoenix-receipt-shape-unit2c1.test.ts')];
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
  const program = ts.createProgram(files, { ...parsed.options, incremental: false, noEmit: true });
  const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error && d.file && files.includes(resolve(d.file.fileName)));
  expect(errors.map(d => `${d.file!.fileName}:${d.file!.getLineAndCharacterOfPosition(d.start!).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)).toEqual([]);
}, 120_000);
