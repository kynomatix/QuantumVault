import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const hb=path.resolve('../grid-ranging-finder-20261023-handback'),scratch=hb+'/commit-repo';
const git=(args,cwd=scratch)=>execFileSync('git.exe',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(!fs.existsSync(scratch)){
 git(['clone','--shared','--no-checkout',process.cwd(),scratch],process.cwd());
 const baseCommitHash='5e354392665cae7fa7ef087a58218b4ed6266312';
 git(['checkout','-b','finder-delivery',baseCommitHash]);
}
for(const dir of ['scripts/research/grid-ranging-finder','tests/research']){
 if(!fs.existsSync(dir))continue;
 for(const name of fs.readdirSync(dir)){
  if(dir==='tests/research'&&name!=='grid-ranging-finder.test.ts')continue;
  const src=path.join(dir,name);if(!fs.statSync(src).isFile())continue;
  const dest=path.join(scratch,src);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
 }
}
git(['add','--','scripts/research/grid-ranging-finder']);
if(fs.existsSync(scratch+'/tests/research/grid-ranging-finder.test.ts'))git(['add','--','tests/research/grid-ranging-finder.test.ts']);
if(git(['diff','--cached','--name-only']).trim())git(['-c','user.name=Codex','-c','user.email=codex@local','commit','-m',process.argv[2]||'research: implement mean-reversion finder study','-m','Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']);
const tipCommitHash=git(['rev-parse','HEAD']);
fs.writeFileSync(hb+'/tip.json',JSON.stringify({tipCommitHash,scratch})+'\n');
console.log(JSON.stringify({tipCommitHash,scratch}));
