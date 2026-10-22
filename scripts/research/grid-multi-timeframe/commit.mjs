import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const hb=path.resolve('../grid-multi-timeframe-20261022-handback'),scratch=hb+'/commit-repo';
const git=(args,cwd=scratch)=>execFileSync('git.exe',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(!fs.existsSync(scratch)){
 git(['clone','--shared','--no-checkout',process.cwd(),scratch],process.cwd());
 const baseCommitHash='4eac0f17c072d35c13d5d8b954199b64490feabf';
 git(['checkout','-b','mtf-delivery',baseCommitHash]);
}
for(const dir of ['scripts/research/grid-multi-timeframe','tests/research']){
 if(!fs.existsSync(dir))continue;
 for(const name of fs.readdirSync(dir)){
  if(dir==='tests/research'&&name!=='grid-multi-timeframe.test.ts')continue;
  const src=path.join(dir,name);if(!fs.statSync(src).isFile())continue;
  const dest=path.join(scratch,src);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
 }
}
git(['add','--','scripts/research/grid-multi-timeframe']);
if(fs.existsSync(scratch+'/tests/research/grid-multi-timeframe.test.ts'))git(['add','--','tests/research/grid-multi-timeframe.test.ts']);
git(['-c','user.name=Codex','-c','user.email=codex@local','commit','-m',process.argv[2]||'research: implement multi-timeframe grid study','-m','Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']);
const tipCommitHash=git(['rev-parse','HEAD']);
fs.writeFileSync(hb+'/tip.json',JSON.stringify({tipCommitHash,scratch})+'\n');
console.log(JSON.stringify({tipCommitHash,scratch}));
