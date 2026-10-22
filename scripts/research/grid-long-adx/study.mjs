import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {createHash} from 'node:crypto';import os from 'node:os';
import {calendar,quarterAt,DAY} from '../grid-ranging-pairs/core.mjs';
import {selections as originalSelections,ARMS} from '../grid-ranging-pairs/design.mjs';
import {METRICS} from '../grid-ranging-pairs/analysis-core.mjs';
import {absolute,compare} from './fast-stats.mjs';
import {indicators,averageAdx,squeezeAt,adxRanks,pickerMembership,correlation,spearman} from './core.mjs';
const hb=path.resolve('../grid-long-adx-20261022-handback'),old=path.resolve('../grid-ranging-pairs-20261021-handback');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')),hash=b=>createHash('sha256').update(b).digest('hex');
async function fileHash(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
const root=hb+'/evidence/study-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(hb+'/study-root.txt',root+'\n');
const write=(name,x)=>fs.writeFileSync(root+'/'+name,JSON.stringify(x)+'\n',{flag:'wx'});
const coverageRoot=fs.readFileSync(old+'/coverage-root.txt','utf8').trim(),replayRoot=fs.readFileSync(old+'/study-r2-root.txt','utf8').trim();
const coverage=read(coverageRoot+'/coverage.json'),certified=coverage.filter(x=>x.passed),registration=read(replayRoot+'/registration.json'),bindings=new Map();
async function bind(file,expected){file=path.resolve(file);if(bindings.has(file)){if(expected&&bindings.get(file).sha256!==expected)throw Error('Conflicting hash binding');return;}
 const sha256=await fileHash(file);if(expected&&sha256!==expected.toLowerCase())throw Error('Input drift: '+file);bindings.set(file,{file,sha256,bytes:fs.statSync(file).size});}
await bind(registration.frozenFile,registration.frozenSha256);const frozen=read(registration.frozenFile);
for(const f of frozen.files)await bind(f.file,f.sha256);
for(const f of registration.sources)await bind(f.file,f.sha256);
await bind(replayRoot+'/registration.json');await bind(replayRoot+'/selections.json',registration.selectionsSha256);
await bind(coverageRoot+'/coverage.json');
if(certified.length!==45||frozen.summary.certified!==45)throw Error('Unexpected frozen universe');
const markets=[];for(const c of certified){await bind(c.dailyFile,c.dailySha256);markets.push({...c,daily:read(c.dailyFile).rows});}
const inherited=read(replayRoot+'/selections.json');if(JSON.stringify(originalSelections(markets))!==JSON.stringify(inherited))throw Error('Inherited selections differ on recomputation');
const indices=new Map(markets.map(m=>[m.symbol,indicators(m.daily)]));
const selections=inherited.map(s=>{
 const entries=s.groups.all.map(symbol=>({symbol,p1:averageAdx(indices.get(symbol),s.at,3),p2:averageAdx(indices.get(symbol),s.at,6)}));
 return {universe:s.universe,at:s.at,all:s.groups.all,trending:s.groups.trending,entries,p1:adxRanks(entries,'p1'),p2:adxRanks(entries,'p2')};
});write('selections.json',selections);
const lookup=new Map(selections.map(s=>[s.universe+'|'+s.at,s])),signalMap=new Map(),signals=[],signalReasons={};
const launches=[...new Set(calendar(Date.UTC(2023,2,1),Date.UTC(2026,9,19)).map(x=>x.launchAt))];
for(const universe of ['A','A+B'])for(const launchAt of launches){const quarter=quarterAt(launchAt),s=lookup.get(universe+'|'+quarter);for(const symbol of s.all){
 const signal=squeezeAt(indices.get(symbol),launchAt),entry=s.entries.find(e=>e.symbol===symbol),membership=pickerMembership(s,signal,symbol);
 const row={universe,symbol,launchAt,quarter,p1:entry.p1,p2:entry.p2,...signal,membership};signalMap.set([universe,symbol,launchAt].join('|'),row);signals.push(row);
 if(!signal.available){const k=universe+'|'+signal.reason;signalReasons[k]=(signalReasons[k]??0)+1;}
 }}
write('signals.json',signals);
const correlations=Object.fromEntries(['A','A+B'].map(u=>{const a=signals.filter(s=>s.universe===u&&s.available&&s.p2!==null),p=a.map(s=>[s.p2,s.percentile]);return[u,{launches:a.length,pearson:correlation(p),spearman:spearman(p),binarySqueezed:correlation(a.map(s=>[s.p2,Number(s.squeezed)]))}];}));
const frequencies=[];for(const universe of ['A','A+B'])for(const picker of ['P1','P2','P3','P4']){
 const counts=new Map();for(const s of signals.filter(x=>x.universe===universe&&x.membership[picker]))counts.set(s.symbol,(counts.get(s.symbol)??0)+1);
 frequencies.push({universe,picker,pairs:[...counts].map(([symbol,launches])=>({symbol,launches,quarters:selections.filter(s=>s.universe===universe&&(picker==='P1'?s.p1.ranging:picker==='P2'?s.p2.ranging:[]).includes(symbol)).length})).sort((a,b)=>b.launches-a.launches||a.symbol.localeCompare(b.symbol))});
}
write('signal-summary.json',{correlations,frequencies,signalReasons,missingAdx:selections.map(s=>({universe:s.universe,at:s.at,p1:s.entries.filter(e=>e.p1===null).length,p2:s.entries.filter(e=>e.p2===null).length}))});
const rows=[],tally={newAdmittedSimulations:0,newAttemptedSimulations:0,reusedAttempted:0,reusedAdmitted:0,reusedRejected:0,derivedRows:0,noLaunch:0,reasons:{}},pathMetrics=METRICS.filter(k=>k!=='underwaterFraction');
for(const market of certified){const receiptPath=replayRoot+'/'+market.symbol+'-complete.json';await bind(receiptPath);const receipt=read(receiptPath);await bind(receipt.output,receipt.outputSha256);
 const seen=new Set(),pairs=new Map(),counts={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0},reasons={};
 for await(const line of readline.createInterface({input:fs.createReadStream(receipt.output),crlfDelay:Infinity})){
  const r=JSON.parse(line),base=[r.symbol,r.launchAt,r.horizonDays,r.window,r.arm,r.leverage,r.builderRate,r.direction].join('|');
  if(!r.derived){const key=base+'|'+r.path;if(seen.has(key))throw Error('Duplicate physical simulation');seen.add(key);counts.attempted++;
   if(r.admitted){counts.admittedUniqueNew++;const pair=pairs.get(base)??[];pair.push(r);pairs.set(base,pair);}else{counts.rejected++;reasons[r.reason]=(reasons[r.reason]??0)+1;}
  }else{
   const pair=pairs.get(base);if(pair?.length!==2||new Set(pair.map(x=>x.path)).size!==2)throw Error('Missing physical paths');
   const worst=pair.reduce((a,b)=>a.netReturn<=b.netReturn?a:b);if(r.sourcePath!==worst.path)throw Error('Wrong source path');
   for(const k of pathMetrics)if(r[k]!==worst[k])throw Error('Wrong conservative metric');
   if(!Number.isFinite(r.netReturn)||!Number.isFinite(r.maxDrawdown))throw Error('Invalid metric');pairs.delete(base);counts.derivedRows++;
   const compact={};for(const k of ['symbol','universe','quarter','week','launchAt','horizonDays','window','arm','leverage','builderRate','direction',...pathMetrics])compact[k]=r[k];
   compact.membershipAB=signalMap.get(['A+B',r.symbol,r.launchAt].join('|'))?.membership;
   compact.membershipA=r.universe==='A'?signalMap.get(['A',r.symbol,r.launchAt].join('|'))?.membership:null;
   if(!compact.membershipAB?.all)throw Error('Outcome absent from eligible population');rows.push(compact);
  }
 }
 if(pairs.size)throw Error('Unpaired outcomes');for(const [k,v]of Object.entries(counts))if(v!==receipt.counts[k])throw Error('Receipt count mismatch');
 if(JSON.stringify(Object.entries(reasons).sort())!==JSON.stringify(Object.entries(receipt.counts.reasons).sort()))throw Error('Rejection reason mismatch');
 tally.reusedAttempted+=counts.attempted;tally.reusedAdmitted+=counts.admittedUniqueNew;tally.reusedRejected+=counts.rejected;tally.derivedRows+=counts.derivedRows;tally.noLaunch+=receipt.counts.noLaunch;
 for(const [k,v]of Object.entries(reasons))tally.reasons[k]=(tally.reasons[k]??0)+v;
}
if(tally.reusedAdmitted!==1289774||rows.length!==644887)throw Error('Inherited headline tally differs');
write('input-bindings.json',[...bindings.values()]);write('tally.json',tally);
const baseline=rows.filter(r=>r.universe==='A'&&r.builderRate===0),oldMembership=new Map(inherited.filter(s=>s.universe==='A').map(s=>[s.at,s.groups]));
const validation=compare(baseline.filter(r=>oldMembership.get(r.quarter).ranging.includes(r.symbol)),baseline.filter(r=>oldMembership.get(r.quarter).trending.includes(r.symbol)));
write('baseline-reconciliation.json',{netReturn:validation.one.metrics.netReturn,quarterWins:validation.quarterWins,quarterCount:validation.quarterCount});
console.log(JSON.stringify({phase:'verified inputs and reused paths',tally,freeGiB:os.freemem()/2**30,root}));
fs.writeFileSync(hb+'/RESUME.md','# Long ADX checkpoint\n\nPreregistration committed before results. Inputs and inherited physical paths verified. Single-worker analysis in progress. Evidence: '+root+'\nNew admitted simulations: 0.\n');
const names=['P1','P2','P3','P4','all','trending','p1High','p2High','squeezed'];
const contrasts=['P1','P2','P3','P4'].flatMap(a=>['all','trending','p1High','p2High'].map(b=>[a,b]));contrasts.push(['P3','squeezed']);
const fd=fs.openSync(root+'/cells.jsonl','wx');let cellCount=0,comparisonCount=0,intervalCount=0;
for(const universe of ['A','A+B'])for(const builderRate of [0,.001])for(const leverage of ['all',1,3])for(const arm of ['all',...ARMS])for(const window of ['all','week','month'])for(const year of ['all',2023,2024,2025,2026]){
 const eligible=rows.filter(r=>(universe==='A+B'||r.universe==='A')&&r.builderRate===builderRate&&(leverage==='all'||r.leverage===leverage)&&(arm==='all'||r.arm===arm)&&(window==='all'||r.window===window)&&(year==='all'||new Date(r.launchAt).getUTCFullYear()===year));
 const groups=Object.fromEntries(names.map(n=>[n,eligible.filter(r=>(universe==='A'?r.membershipA:r.membershipAB)?.[n])]));
 const cell={universe,builderRate,leverage,arm,window,year,groups:Object.fromEntries(names.map(n=>[n,absolute(groups[n])])),comparisons:{}};
 for(const [a,b]of contrasts){const c=compare(groups[a],groups[b]);cell.comparisons[a+'-'+b]=c;if(c.one.weeks)comparisonCount++;}
 for(const s of [...Object.values(cell.groups),...Object.values(cell.comparisons)])for(const block of ['one','four'])intervalCount+=Object.values(s[block].metrics).filter(x=>x.low!==null).length;
 fs.writeSync(fd,JSON.stringify(cell)+'\n');cellCount++;
}
fs.closeSync(fd);write('completion.json',{cellCount,comparisonCount,intervalCount,tally,correlations,completedAt:new Date().toISOString(),host:os.hostname(),workers:1});
console.log(JSON.stringify({phase:'complete',cellCount,comparisonCount,intervalCount,root}));
