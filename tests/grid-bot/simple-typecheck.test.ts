import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
/** Owner-requested compiler gate, executed on FRACTAL alongside the focused tests. */
it('adds zero TypeScript errors against the CI multiset baseline',()=>{
  const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--incremental','false'],{encoding:'utf8',timeout:180_000,maxBuffer:8*1024*1024});
  if(result.error)throw result.error;
  expect(result.status===0||result.status===2).toBe(true);
  const baseline=new Map<string,number>();
  for(const line of readFileSync('.github/typecheck-baseline.txt','utf8').split(/\r?\n/).filter(Boolean))baseline.set(line,(baseline.get(line)??0)+1);
  const current=(result.stdout+result.stderr).split(/\r?\n/).filter(line=>/error TS\d+:/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,''));
  const added:string[]=[];
  for(const line of current){const count=baseline.get(line)??0;if(count)baseline.set(line,count-1);else added.push(line);}
  console.log(`TypeScript errors: ${current.length}; New errors: ${added.length}`);
  expect(added,added.join('\n')).toEqual([]);
},200_000);
