#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [targetArg, mode = 'live'] = process.argv.slice(2);
if (!targetArg) {
  console.error('usage: node scripts/wo-run-suite.mjs <target.json> [live|unauthorized]');
  process.exit(64);
}

const repositoryRoot = process.cwd();
const target = path.resolve(repositoryRoot, targetArg);
const temporaryVitestJson = `${target}.vitest.tmp`;
const runnerPath = realpathSync(path.join(repositoryRoot, 'node_modules/.bin/vitest'));
const command = [
  'npx',
  'vitest',
  'run',
  '--reporter=json',
  `--outputFile=${temporaryVitestJson}`,
];

const result = spawnSync(command[0], command.slice(1), {
  cwd: repositoryRoot,
  env: { ...process.env, PYTH_HERMES_MODE: mode },
  stdio: 'inherit',
});
const originatingExitCode = result.status ?? 125;

if (!existsSync(temporaryVitestJson)) {
  console.error(`Vitest did not produce ${temporaryVitestJson}`);
  process.exit(originatingExitCode || 125);
}

const vitest = JSON.parse(readFileSync(temporaryVitestJson, 'utf8'));
const evidence = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  environment: {
    uname: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(),
    nodeVersion: process.version,
    runnerPath,
  },
  command: `PYTH_HERMES_MODE=${mode} ${command.join(' ')}`,
  mode,
  originatingExitCode,
  vitest,
};

writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
unlinkSync(temporaryVitestJson);
console.log(`Evidence written to ${target}`);
console.log(`ORIGINATING EXIT CODE: ${originatingExitCode}`);
process.exit(originatingExitCode);
