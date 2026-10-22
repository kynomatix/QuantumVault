import fs from 'node:fs';import path from 'node:path';import {execFileSync,spawn} from 'node:child_process';
const hb=path.resolve('../grid-long-adx-20261022-handback'),{tipCommitHash:sourceCommitHash,scratch}=JSON.parse(fs.readFileSync(hb+'/tip.json','utf8'));
const git=args=>execFileSync('git.exe',args,{cwd:scratch,encoding:'utf8'}).trim();
const originMainCommitHash=execFileSync('git.exe',['rev-parse','origin/main'],{cwd:process.cwd(),encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(sourceCommitHash)||!/^[a-f0-9]{40}$/.test(originMainCommitHash)||git(['rev-parse',sourceCommitHash+'^{commit}'])!==sourceCommitHash)throw Error('Unverified commit');
const root=hb+'/evidence/focused-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(root,{recursive:true});
// A focused probe avoids uploading unrelated ancestral research reports. Exact tested
// source blobs are bound to sourceCommitHash; this is build-time evidence, not a gate.
const files=['scripts/research/grid-long-adx/core.mjs','scripts/research/grid-long-adx/fast-stats.mjs','tests/research/grid-long-adx.test.ts','tests/research/grid-ranging-pairs.test.ts',...['core','design','analysis-core'].map(n=>'scripts/research/grid-ranging-pairs/'+n+'.mjs')];
const env={...process.env,GIT_INDEX_FILE:root+'/probe.index',GIT_AUTHOR_NAME:'Codex',GIT_AUTHOR_EMAIL:'codex@local',GIT_COMMITTER_NAME:'Codex',GIT_COMMITTER_EMAIL:'codex@local'};
const probeGit=args=>execFileSync('git.exe',args,{cwd:scratch,env,encoding:'utf8'}).trim();
probeGit(['read-tree',originMainCommitHash]);
const bindings=[];for(const file of files){const blobHash=git(['rev-parse',sourceCommitHash+':'+file]);probeGit(['update-index','--add','--cacheinfo','100644,'+blobHash+','+file]);bindings.push({file,blobHash});}
const treeHash=probeGit(['write-tree']);
const tipCommitHash=probeGit(['commit-tree',treeHash,'-p',originMainCommitHash,'-m','research: focused long ADX source projection','-m','Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']);
// Git Bash login provides the same explicit thin-ref recipe as the sanctioned probe.
const script='set -euo pipefail\ngit update-ref refs/heads/qv-probe-tip "$1"\ngit update-ref refs/heads/qv-probe-main "$2"\ngit bundle create "$3" refs/heads/qv-probe-tip refs/heads/qv-probe-main --not "$2^"\ngit bundle verify "$3"\n';
fs.writeFileSync(root+'/bundle.sh',script);
execFileSync('C:/Program Files/Git/bin/bash.exe',['-lc','bash "$1" "$2" "$3" "$4"','bundle',root+'/bundle.sh',tipCommitHash,originMainCommitHash,root+'/probe.bundle'],{cwd:scratch,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const bytes=fs.statSync(root+'/probe.bundle').size;if(bytes>1024*1024)throw Error('Thin bundle exceeds safe upload size: '+bytes);
const intent={tipCommitHash,sourceCommitHash,originMainCommitHash,bindings,bundleBytes:bytes,tests:['tests/research/grid-long-adx.test.ts','tests/research/grid-ranging-pairs.test.ts'],root};fs.writeFileSync(root+'/intent.json',JSON.stringify(intent)+'\n');fs.writeFileSync(hb+'/focused-root.txt',root+'\n');
console.log(JSON.stringify({phase:'started',tipCommitHash,bundleBytes:bytes}));
const out=fs.openSync(root+'/receipt.utf8.log','wx'),err=fs.openSync(root+'/transport.utf8.log','wx');
const child=spawn(process.execPath,['C:/Apps/Replit/claude-drafts/tools/qv-runner-probe/send.mjs','C:/Windows/System32/OpenSSH/ssh.exe',root+'/probe.bundle',tipCommitHash,originMainCommitHash,...intent.tests],{env:{...process.env,QV_SSH_CONFIG:'C:/Apps/Replit/claude-drafts/tools/qv-runner-ssh/config'},windowsHide:true,stdio:['ignore',out,err]});
child.on('error',e=>{throw e;});
await new Promise(resolve=>child.on('exit',resolve));fs.closeSync(out);fs.closeSync(err);
const receipt=fs.readFileSync(root+'/receipt.utf8.log','utf8');
const objects=receipt.split(/\r?\n/).map(l=>l.replace(/^STDOUT: /,'')).filter(l=>l.startsWith('{')).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
const raw=objects.find(x=>x.kind&&x.state),transport=objects.find(x=>'sshExit' in x);
const result=raw?Object.fromEntries(['kind','state','passed','failed','skipped','exitCode','host','environment'].map(k=>[k,raw[k]])):null;
fs.writeFileSync(root+'/result.json',JSON.stringify({tipCommitHash,result,sshExit:transport?.sshExit,localExit:child.exitCode})+'\n');
console.log(JSON.stringify({tipCommitHash,result,sshExit:transport?.sshExit,localExit:child.exitCode,root}));
if(!result||result.failed>0||transport?.sshExit!==0)process.exitCode=1;
