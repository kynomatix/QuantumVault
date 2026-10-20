import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const [root,mode]=process.argv.slice(2);
const log=fs.openSync(path.join(root,mode+'.log'),'wx');
let program=process.execPath,args,env={...process.env};
if(mode==='analysis'){
  args=['--max-old-space-size=448','--experimental-transform-types','--import','./scripts/research/grid-finder/loader.mjs','scripts/research/grid-squeeze-diag/run.mjs',root];
  env.GRID_TRAIL_VENDOR='C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence/vendor';env.FINDER_INPUT_MAP=path.join(root,'runtime-inputs.json');
}else if(mode==='fractal'){
  const request=JSON.parse(fs.readFileSync(path.join(root,'test-request.json'),'utf8'));
  if(!/^[a-f0-9]{40}$/.test(request.tipHash)||!/^[a-f0-9]{40}$/.test(request.originMainHash))throw Error('Full test commit hashes required');
  if(fs.statSync(request.bundle).size>1024*1024)throw Error('Runner bundle too large');
  args=['C:/Apps/Replit/claude-drafts/tools/qv-runner-probe/send.mjs','C:/Windows/System32/OpenSSH/ssh.exe',request.bundle,request.tipHash,request.originMainHash,'tests/research/grid-squeeze-diag.test.ts'];
  env.QV_SSH_CONFIG='C:/Apps/Replit/claude-drafts/tools/qv-runner-ssh/config';
}else throw Error('Unknown execution mode');
const child=spawn(program,args,{env,stdio:['ignore',log,log],windowsHide:true});
child.on('error',error=>{fs.closeSync(log);console.error('PROCESS CREATION FAILED; STOP: '+error.message);process.exitCode=1;});
child.on('close',code=>{fs.closeSync(log);fs.writeFileSync(path.join(root,mode+'-exit.json'),JSON.stringify({exitCode:code,completedAt:new Date().toISOString()})+'\n');console.log(mode+' exitCode='+code);process.exitCode=code??1;});
