import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-1b-20261021-handback';
const root=fs.readFileSync(path.join(HB,'phase1b-root.txt'),'utf8').trim();
const tasks=Object.entries({development:['BTC','ETH','SOL','HYPE','ZEC'],evaluation:['BTC','ETH','SOL','HYPE','ZEC'],okx:['BTC','ETH','SOL','NEAR','XRP','DOGE','UNI','FIL','BAT','BCH','AAVE','ADA']}).flatMap(([c,ss])=>ss.map(s=>[c,s]));
const workers=os.freemem()/2**30>=3.6?2:1;let cursor=0,completed=0,failed=null;
async function work(){while(cursor<tasks.length&&!failed){const [c,s]=tasks[cursor++],log=fs.openSync(path.join(root,c+'-'+s+'.log'),'wx');
 try{await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-transform-types','--import','./scripts/research/grid-walkforward/loader.mjs','scripts/research/grid-sizing-1b/worker.mjs','phase1b',c,s],{windowsHide:true,stdio:['ignore',log,log],env:{...process.env,GRID_TRAIL_VENDOR:'C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence/vendor',FINDER_INPUT_MAP:path.join(root,c+'-'+s+'-runtime-inputs.json')}});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error(c+' '+s+' worker exit '+code)));});completed++;}
 catch(e){failed=e;}finally{fs.closeSync(log);}
 fs.writeFileSync(path.join(HB,'RESUME.md'),`Phase 1b workers=${workers}; completed=${completed}/22; ${failed?'BLOCKED '+failed.message:'in progress'}. Evidence: ${root}\n`);
}}
await Promise.all(Array.from({length:workers},work));
fs.writeFileSync(path.join(root,'launch-complete.json'),JSON.stringify({completed,workers,error:failed?.message??null,completedAt:new Date().toISOString()})+'\n',{flag:'wx'});
if(failed)throw failed;console.log('Phase 1b completed 22 tasks with '+workers+' workers.');
