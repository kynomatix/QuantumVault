import fs from 'node:fs';import path from 'node:path';import {execFileSync,spawn} from 'node:child_process';
const hb=path.resolve('../grid-ranging-finder-20261023-handback'),{tipCommitHash:sourceCommitHash,scratch}=JSON.parse(fs.readFileSync(hb+'/tip.json','utf8'));
const git=args=>execFileSync('git.exe',args,{cwd:scratch,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const originMainCommitHash=execFileSync('git.exe',['rev-parse','origin/main'],{cwd:process.cwd(),encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(sourceCommitHash)||!/^[a-f0-9]{40}$/.test(originMainCommitHash)||git(['rev-parse',sourceCommitHash+'^{commit}'])!==sourceCommitHash)throw Error('Unverified commit');
const root=hb+'/evidence/focused-'+new Date().toISOString().replace(/[-:.]/g,'');if(fs.existsSync(root))throw Error('Evidence root already exists');fs.mkdirSync(root);
const tests=['tests/research/grid-ranging-finder.test.ts'];
const files=new Set();function visit(file){file=file.replaceAll('\\','/');if(files.has(file))return;const text=git(['show',sourceCommitHash+':'+file]);files.add(file);for(const m of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]));const candidates=[base,base+'.ts',base+'.mjs',base+'.js',base.replace(/\.js$/,'.ts'),base+'/index.ts'];const found=candidates.find(p=>fs.existsSync(path.join(scratch,p))&&fs.statSync(path.join(scratch,p)).isFile());if(!found)throw Error('Missing import '+base);visit(found);}}
for(const f of tests)visit(f);
const env={...process.env,GIT_INDEX_FILE:root+'/probe.index',GIT_AUTHOR_NAME:'Codex',GIT_AUTHOR_EMAIL:'codex@local',GIT_COMMITTER_NAME:'Codex',GIT_COMMITTER_EMAIL:'codex@local'};
const probe=args=>execFileSync('git.exe',args,{cwd:scratch,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();probe(['read-tree',originMainCommitHash]);
const bindings=[];for(const file of files){const blobHash=git(['rev-parse',sourceCommitHash+':'+file]);probe(['update-index','--add','--cacheinfo','100644,'+blobHash+','+file]);bindings.push({file,blobHash});}
const treeHash=probe(['write-tree']),tipCommitHash=probe(['commit-tree',treeHash,'-p',originMainCommitHash,'-m','research: focused ranging finder source projection','-m','Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']);
fs.writeFileSync(root+'/bundle.sh','set -euo pipefail\ngit update-ref refs/heads/qv-probe-tip "$1"\ngit update-ref refs/heads/qv-probe-main "$2"\ngit bundle create "$3" refs/heads/qv-probe-tip refs/heads/qv-probe-main --not "$2^"\ngit bundle verify "$3"\n');
execFileSync('C:/Program Files/Git/bin/bash.exe',['-lc','bash "$1" "$2" "$3" "$4"','bundle',root+'/bundle.sh',tipCommitHash,originMainCommitHash,root+'/probe.bundle'],{cwd:scratch,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const bytes=fs.statSync(root+'/probe.bundle').size;if(bytes>1024*1024)throw Error('Thin test bundle too large: '+bytes);
const intent={tipCommitHash,sourceCommitHash,originMainCommitHash,bindings,bundleBytes:bytes,tests,root};fs.writeFileSync(root+'/intent.json',JSON.stringify(intent)+'\n');fs.writeFileSync(hb+'/focused-root.txt',root+'\n');
const out=fs.openSync(root+'/receipt.utf8.log','wx'),err=fs.openSync(root+'/transport.utf8.log','wx');
const child=spawn(process.execPath,['C:/Apps/Replit/claude-drafts/tools/qv-runner-probe/send.mjs','C:/Windows/System32/OpenSSH/ssh.exe',root+'/probe.bundle',tipCommitHash,originMainCommitHash,...tests],{env:{...process.env,QV_SSH_CONFIG:'C:/Apps/Replit/claude-drafts/tools/qv-runner-ssh/config'},windowsHide:true,stdio:['ignore',out,err]});
await new Promise((resolve,reject)=>{child.once('error',e=>reject(Error('PROCESS CREATION FAILED: '+e.message)));child.once('exit',resolve);});fs.closeSync(out);fs.closeSync(err);
const objects=fs.readFileSync(root+'/receipt.utf8.log','utf8').split(/\r?\n/).map(l=>l.replace(/^STDOUT: /,'')).filter(l=>l.startsWith('{')).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
const raw=objects.find(x=>x.kind&&x.state),transport=objects.find(x=>'sshExit'in x),result=raw?Object.fromEntries(['kind','state','passed','failed','skipped','exitCode','host','environment'].map(k=>[k,raw[k]])):null;
const summary={tipCommitHash,result,sshExit:transport?.sshExit,localExit:child.exitCode,root};fs.writeFileSync(root+'/result.json',JSON.stringify(summary)+'\n');console.log(JSON.stringify(summary));if(!result||result.failed>0||transport?.sshExit!==0)process.exitCode=1;
