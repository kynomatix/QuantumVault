import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

it('introduces no TypeScript diagnostics relative to the dispatched base',()=>{
  if(process.platform!=='linux')throw Error('FRACTAL only');
  const baseCommitHash='9aef6dc8d15989ceac5f0640b3ea8e86d5ca58af';
  const root=mkdtempSync(join(tmpdir(),'qv-u6b-types-'));
  const check=(cwd:string)=>{
    const r=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false','--pretty','false'],{cwd,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
    if(r.error||r.signal||r.status===null)throw r.error??Error('Typecheck process did not complete');
    const lines=(r.stdout+'\n'+r.stderr).split('\n').filter(x=>/error TS\d+:/.test(x));
    if(r.status!==0&&!lines.length)throw Error('Typecheck did not produce diagnostics');
    return lines.map(x=>x.replace(/\(\d+,\d+\)/,'').trim());
  };
  try{
    writeFileSync(join(root,'base.tar'),execFileSync('git',['archive','--format=tar',baseCommitHash],{maxBuffer:128*1024*1024}));
    execFileSync('tar',['-xf',join(root,'base.tar'),'-C',root]);symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
    const baseline=check(root),tip=check(process.cwd()),remaining=new Map<string,number>();
    for(const d of baseline)remaining.set(d,(remaining.get(d)??0)+1);
    const introduced=tip.filter(d=>{const n=remaining.get(d)??0;if(n){remaining.set(d,n-1);return false;}return true;});
    console.log(JSON.stringify({kind:'U6B_TYPECHECK',baseCommitHash,baselineErrors:baseline.length,tipErrors:tip.length,newErrors:introduced.length,diagnostics:introduced.slice(0,40)}));
    expect(introduced).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});}
},270000);
