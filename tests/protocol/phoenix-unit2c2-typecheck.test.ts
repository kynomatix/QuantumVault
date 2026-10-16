import { expect, it } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';
it('type checks Unit 2C-2 production, UI and focused test modules',()=>{
  const names=['lab-provenance','signal-policy','signal-runtime','signal-control','signal-production','signal-routes','recovery-worker','accounting-production','accounting-runtime','production','execution-production','policy'];
  const tests=['phoenix-signal-unit2c2','phoenix-signal-production-unit2c2','phoenix-recovery-unit2c2','phoenix-accounting-native-unit2c2','phoenix-unit2c2-boundaries','phoenix-unit2c2-typecheck'];
  const files=[...names.map(n=>resolve(`server/protocol/phoenix/${n}.ts`)),...tests.map(n=>resolve(`tests/protocol/${n}.test.ts`)),resolve('client/src/components/PhoenixSignalPanel.tsx'),resolve('client/src/components/PhoenixFundingPanel.tsx')];
  const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,'.');
  const program=ts.createProgram(files,{...parsed.options,incremental:false,noEmit:true});
  const errors=ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error&&d.file&&files.includes(resolve(d.file.fileName)));
  const messages=errors.map(d=>`${d.file!.fileName}:${d.file!.getLineAndCharacterOfPosition(d.start!).line+1}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);
  expect(messages,messages.join('\n')).toEqual([]);
},120000);
