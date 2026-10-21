// One event-driven wait, without a polling loop; completion receipts are written last.
import fs from 'node:fs';import path from 'node:path';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback',phase=process.argv[2];
if(!['phase1','phase2'].includes(phase))throw Error('phase required');
const root=fs.readFileSync(path.join(HB,phase+'-root.txt'),'utf8').trim();
const names=['development','evaluation'].flatMap(c=>['BTC','ETH','SOL','HYPE','ZEC'].map(s=>`${c}-${s}-complete.json`)).concat(['BTC','ETH','SOL','NEAR','XRP','DOGE','UNI','FIL','BAT','BCH','AAVE','ADA'].map(s=>`okx-${s}-complete.json`));
const ready=()=>names.every(n=>fs.existsSync(path.join(root,n)));
if(!ready())await new Promise((resolve,reject)=>{
 const watcher=fs.watch(root,(_,name)=>{if(name?.endsWith('-complete.json')&&ready()){clearTimeout(timer);watcher.close();resolve();}});
 const timer=setTimeout(()=>{watcher.close();reject(Error('Completion receipts unavailable after one hour'));},3600000);
 if(ready()){clearTimeout(timer);watcher.close();resolve();}
});
console.log(phase+' all 22 completion receipts present.');
