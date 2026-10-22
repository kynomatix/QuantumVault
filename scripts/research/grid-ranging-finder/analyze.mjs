import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {createHash} from 'node:crypto';
import {compare,absolute,bh,verdict,METRICS} from '../grid-multi-timeframe/stats.mjs';import {worstPath} from '../grid-ranging-pairs/design.mjs';import {pairedDirections,ARMS} from './core.mjs';
const hb=path.resolve('../grid-ranging-finder-20261023-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),read=p=>JSON.parse(fs.readFileSync(p,'utf8')),registration=read(root+'/registration.json'),markets=read(root+'/markets.json'),membership=read(root+'/membership.json');
const sha256=p=>new Promise((resolve,reject)=>{const h=createHash('sha256'),s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});
const oldRoot=registration.oldRoot,tally={newSimulations:0,reusedPhysicalAttempted:0,reusedPhysicalAdmitted:0,reusedPhysicalRejected:0,reusedDerived:0,reasons:{},missingBothPaths:0,directionUnpaired:0},bindings=[],rows=[];
for(const m of markets){
 const receiptFile=oldRoot+'/'+m.symbol+'-complete.json',receipt=read(receiptFile),file=receipt.output;
 if(await sha256(file)!==receipt.outputSha256)throw Error('Outcome hash changed '+m.symbol);
 bindings.push({file,sha256:receipt.outputSha256,receiptFile,receiptSha256:await sha256(receiptFile)});
 const groups=new Map();for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
  const r=JSON.parse(line);if(r.geometry!=='D7H1'||r.arm!=='further_near'||r.builderRate!==0||![1,3].includes(r.leverage))continue;
  if(r.horizonDays!==14)throw Error('Horizon mismatch');const key=[r.launchAt,r.leverage,r.direction].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  if(r.path!=='worst'){tally.reusedPhysicalAttempted++;if(r.admitted)tally.reusedPhysicalAdmitted++;else{tally.reusedPhysicalRejected++;tally.reasons[r.reason]=(tally.reasons[r.reason]??0)+1;}}
 }
 for(const g of groups.values()){
  const physical=g.filter(r=>r.path!=='worst');if(physical.length!==2||new Set(physical.map(r=>r.path)).size!==2||physical.some(r=>!['OHLC','OLHC'].includes(r.path)))throw Error('Path completeness mismatch');
  if(physical.some(r=>!r.admitted)){tally.missingBothPaths++;continue;}
  const expected=worstPath(physical),derived=g.filter(r=>r.path==='worst');if(derived.length!==1||derived[0].sourcePath!==expected.path)throw Error('Worst path mismatch');
  for(const k of [...METRICS.filter(k=>k!=='underwaterFraction'),'admitted'])if(derived[0][k]!==expected[k])throw Error('Derived metric mismatch '+k);
  rows.push(derived[0]);tally.reusedDerived++;
 }
}
const paired=pairedDirections(rows);tally.directionUnpaired=rows.length-paired.length;tally.reusedPairedDerived=paired.length;
const cells=[],contrasts=[];for(const universe of ['A','A+B'])for(const leverage of ['pooled',1,3]){
 const members=membership.filter(x=>x.universe===universe),sets=Object.fromEntries(['ALL',...ARMS].map(arm=>[arm,new Set(members.flatMap(w=>w.groups[arm].map(symbol=>symbol+'|'+w.launchAt)))]));
 const groups=Object.fromEntries(['ALL',...ARMS].map(arm=>[arm,paired.filter(r=>(leverage==='pooled'||r.leverage===leverage)&&sets[arm].has(r.symbol+'|'+r.launchAt))]));
 for(const arm of ['ALL',...ARMS])cells.push({universe,leverage,arm,...absolute(groups[arm]),selectedLaunches:members.reduce((n,w)=>n+w.groups[arm].length,0),emptyWeeks:members.filter(w=>!w.groups[arm].length).length,shortfall:arm==='ALL'?0:members.reduce((n,w)=>n+w.quota-w.groups[arm].length,0)});
 for(const arm of ARMS)for(const baseline of arm==='M0'?['ALL']:['M0','ALL'])contrasts.push({universe,leverage,arm,baseline,...compare(groups[arm],groups[baseline])});
}
const pvalues=contrasts.map(c=>({id:[c.universe,c.leverage,c.arm,c.baseline].join('|'),p:c.one.p}));bh(pvalues);for(let i=0;i<contrasts.length;i++)contrasts[i].bhQ=pvalues[i].q??null;
const decisions=ARMS.filter(a=>a!=='M0').map(arm=>{const checks=['M0','ALL'].map(baseline=>({baseline,...verdict(contrasts.find(c=>c.universe==='A'&&c.leverage==='pooled'&&c.arm===arm&&c.baseline===baseline),contrasts.find(c=>c.universe==='A+B'&&c.leverage==='pooled'&&c.arm===arm&&c.baseline===baseline))}));return {arm,success:checks.every(c=>c.success),checks};});
for(const [name,value]of Object.entries({'reuse-bindings.json':bindings,'reused-outcomes.json':paired,'tally.json':tally,'cells.json':cells,'contrasts.json':contrasts,'decisions.json':decisions}))fs.writeFileSync(root+'/'+name,JSON.stringify(value)+'\n',{flag:'wx'});
fs.writeFileSync(hb+'/RESUME.md','Signals frozen; inherited replay hashes and worst-path derivations verified; 66 comparisons complete. Study: '+root+'\n');console.log(JSON.stringify({tally,passing:decisions.filter(x=>x.success).map(x=>x.arm),contrasts:contrasts.length}));
