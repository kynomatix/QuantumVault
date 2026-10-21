import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-1b-20261021-handback';
const oldHB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback';
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=path.resolve('scripts/research/grid-sizing-1b');
const oldRoot=fs.readFileSync(path.join(oldHB,'phase1-root.txt'),'utf8').trim();
// Mechanical worker adaptation: only arm list, phase name, output root and checkpoints change.
let worker=fs.readFileSync('scripts/research/grid-sizing-stops/run.mjs','utf8');
const replacements=[
 ["sha256,HB,read} from './data.mjs'","sha256,read} from '../grid-sizing-stops/data.mjs'"],
 ["import {sizingPolicy,ARMS} from './policy.mjs';","import {sizingPolicy,NEW_ARMS} from './arms.mjs';\nconst HB='"+HB+"';"],
 ["from './strategy.mjs'","from '../grid-sizing-stops/strategy.mjs'"],
 ["['phase1','phase2'].includes(phase)","['phase1b'].includes(phase)"],
 ["const arms=phase==='phase1'?Object.keys(ARMS):['flat_flat',...(selected?[selected]:[])];","const arms=Object.keys(NEW_ARMS);"],
 ["const variants=phase==='phase1'?['shipped']:['none','loss10','loss15','loss25','reenter1','reenter2','reenter3'];","const variants=['shipped'];"],
 ["path.join(HB,'RESUME.md')","path.join(root,cohort+'-'+symbol+'-checkpoint.md')"],
 ["'scripts/research/grid-sizing-stops'","'scripts/research/grid-sizing-1b'"]
];
for(const [a,b]of replacements){if(!worker.includes(a))throw Error('Worker adaptation seam absent: '+a);worker=worker.replaceAll(a,b);}
worker=worker.replace("const inv=inventory()", "for(const f of binding.sourceFiles)if(sha256(fs.readFileSync(f.file))!==f.sha256)throw Error('Bound source changed');\nconst inv=inventory()");
fs.writeFileSync(path.join(source,'worker.mjs'),worker,{flag:'wx'});
const root=path.join(HB,'evidence','phase1b-'+new Date().toISOString().replace(/[-:.]/g,''));
if(fs.existsSync(root))throw Error('Fresh root required');fs.mkdirSync(root,{recursive:true});
const priorReceipts=fs.readdirSync(oldRoot).filter(n=>n.endsWith('-complete.json')).map(n=>{const file=path.join(oldRoot,n),bytes=fs.readFileSync(file);return {file,sha256:hash(bytes)};});
if(priorReceipts.length!==22)throw Error('Expected 22 completed Phase 1 market/cohort tasks');
const sourceFiles=[];
for(const dir of [source,path.resolve('scripts/research/grid-sizing-stops')])for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.mjs'))) {const file=path.join(dir,name);sourceFiles.push({file,sha256:hash(fs.readFileSync(file))});}
const file=path.join(source,'PREREGISTRATION.md');
fs.writeFileSync(path.join(root,'registration.json'),JSON.stringify({registeredAt:new Date().toISOString(),file,sha256:hash(fs.readFileSync(file)),sourceFiles,priorRoot:oldRoot,priorReceipts},null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(HB,'phase1b-root.txt'),root+'\n',{flag:'wx'});
fs.writeFileSync(path.join(HB,'RESUME.md'),'Phase 1b preregistered; zero new simulations. Evidence: '+root+'\n');
console.log('Phase 1b registered before results; 22 original receipt bindings; new admitted tally 0.');
