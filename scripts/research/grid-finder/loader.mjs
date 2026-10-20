import '../grid-backtest-r2/loader.mjs';
import {registerHooks} from 'node:module';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {extractScanner} from './source.mjs';
const inputs = new Set();
registerHooks({load(url, context, next) {
  if (url.startsWith('file:')) inputs.add(fileURLToPath(url));
  if (url.endsWith('/server/grid-planner/scanner.ts'))
    return {format:'module-typescript', source:extractScanner(readFileSync(new URL(url), 'utf8')), shortCircuit:true};
  return next(url, context);
}});
process.on('exit', () => {
  if (process.env.FINDER_INPUT_MAP) writeFileSync(process.env.FINDER_INPUT_MAP, JSON.stringify({files:[...inputs].sort()}, null, 2)+'\n');
});
