import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {extractCanonicalPolicy} from '../../scripts/research/grid-walkforward/pure-policy.mjs';
test('preserves the shipped canonical function bytes and fails closed on drift',()=>{
 const source=fs.readFileSync('server/grid-bot/policy-hmac.ts','utf8'),pure=extractCanonicalPolicy(source),at=source.indexOf('export function canonicalGridPolicy('),end=source.indexOf('export function computeGridPolicyHmac(');
 expect(pure.slice(pure.indexOf('export function canonicalGridPolicy('))).toBe(source.slice(at,end));
 expect(()=>extractCanonicalPolicy(source.replace('export function computeGridPolicyHmac(','export function EXAMPLE('))).toThrow();
});
test('native research imports execute without signing or database dependencies',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'walkforward-loader-')),map=path.join(dir,'inputs.json');
 try{const env={...process.env,FINDER_INPUT_MAP:map};delete env.GRID_TRAIL_VENDOR;
 const stdout=execFileSync(process.execPath,['--experimental-transform-types','--import','./scripts/research/grid-walkforward/loader.mjs','./scripts/research/grid-walkforward/preflight.mjs'],{cwd:process.cwd(),env,encoding:'utf8',timeout:30000});
 expect(stdout).toContain('zero strategy simulations');const files=JSON.parse(fs.readFileSync(map,'utf8')).files as string[];
 expect(files.some(f=>/[/\\](crypto-v3|db|storage)\.(ts|js)$|[/\\]bs58[/\\]/.test(f))).toBe(false);
 expect(files.some(f=>f.endsWith('fixed-replay.mjs'))).toBe(true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
