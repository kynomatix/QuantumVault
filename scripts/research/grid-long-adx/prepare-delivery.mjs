import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const hb=path.resolve('../grid-long-adx-20261022-handback');
const scratch=path.join(hb,'commit-repo');
const git=(args,cwd=scratch)=>execFileSync('git.exe',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(!fs.existsSync(scratch)){
 git(['clone','--shared','--no-checkout',process.cwd(),scratch],process.cwd());
 git(['checkout','-b','long-adx-delivery','f04a278b4223755aefde0f92586595fb1c4ff7d1']);
}
for(const dir of ['scripts/research/grid-long-adx','tests/research']){
 if(!fs.existsSync(dir))continue;
 for(const name of fs.readdirSync(dir)){
  if(dir==='tests/research'&&name!=='grid-long-adx.test.ts')continue;
  const src=path.join(dir,name);if(!fs.statSync(src).isFile())continue;
  const dest=path.join(scratch,src);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
 }
}
git(['add','--','scripts/research/grid-long-adx']);
if(fs.existsSync(path.join(scratch,'tests/research/grid-long-adx.test.ts')))git(['add','--','tests/research/grid-long-adx.test.ts']);
git(['-c','user.name=Codex','-c','user.email=codex@local','commit','-m',process.argv[2]||'research: implement long ADX pickers','-m','Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']);
const tipCommitHash=git(['rev-parse','HEAD']);
if(!/^[a-f0-9]{40}$/.test(tipCommitHash))throw Error('Invalid commit hash');
fs.writeFileSync(path.join(hb,'tip.json'),JSON.stringify({tipCommitHash,scratch})+'\n');
console.log(JSON.stringify({tipCommitHash,scratch}));
