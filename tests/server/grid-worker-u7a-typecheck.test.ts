import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

it('introduces no TypeScript diagnostics relative to the dispatched base',()=>{
  if(process.platform!=='linux')throw Error('FRACTAL only');
  const baseCommitHash='a02bdb5f8e0063128b0c4fc1ab16d0d28138d72c';
  const root=mkdtempSync(join(tmpdir(),'qv-u7a-types-'));
  const check=(cwd:string,extra:string[]=[])=>{
    const r=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false','--pretty','false',...extra],{cwd,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
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
    console.log(JSON.stringify({kind:'U7A_TYPECHECK',baseCommitHash,baselineErrors:baseline.length,tipErrors:tip.length,newErrors:introduced.length,diagnostics:introduced.slice(0,40)}));
    expect(introduced,JSON.stringify(introduced)).toEqual([]);
    const ci=new Map<string,number>();
    for(const d of readFileSync('.github/typecheck-baseline.txt','utf8').split(/\r?\n/).filter(Boolean))ci.set(d,(ci.get(d)??0)+1);
    const ciNew=tip.filter(d=>{const n=ci.get(d)??0;if(n){ci.set(d,n-1);return false;}return true;});
    expect(ciNew,'CI New errors: '+ciNew.length).toEqual([]);
    const changed=execFileSync('git',['diff','--name-only',baseCommitHash,'HEAD'],{encoding:'utf8'}).trim().split('\n').filter(p=>p.endsWith('.ts')&&(p.startsWith('tests/')||p.startsWith('script/')));
    const expanded=(cwd:string,name:string)=>{
      const config=join(root,name+'.json');writeFileSync(config,JSON.stringify({extends:join(cwd,'tsconfig.json'),include:changed.map(p=>join(cwd,p)),exclude:['node_modules','dist']}));
      return check(cwd,['--project',config]);
    };
    const extraBase=new Map<string,number>();for(const d of expanded(root,'base-expanded'))extraBase.set(d,(extraBase.get(d)??0)+1);
    const extraNew=expanded(process.cwd(),'tip-expanded').filter(d=>{const n=extraBase.get(d)??0;if(n){extraBase.set(d,n-1);return false;}return true;});
    expect(extraNew.slice(0,40),'Expanded changed test/script types: '+JSON.stringify(extraNew)).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});}
},270000);
