import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {calendar,quarterAt,DAY} from '../grid-ranging-pairs/core.mjs';
import {selections} from '../grid-ranging-pairs/design.mjs';
const hb=path.resolve('../grid-multi-timeframe-20261022-handback'),old=path.resolve('../grid-ranging-pairs-20261021-handback');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const root=hb+'/evidence/study-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(root,{recursive:true});
const bindings=new Map();
async function bind(file,expected){file=path.resolve(file);if(bindings.has(file))return;const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);const sha256=h.digest('hex');if(expected&&sha256!==expected.toLowerCase())throw Error('Input hash mismatch: '+file);bindings.set(file,{file,sha256,bytes:fs.statSync(file).size});}
const coverageRoot=fs.readFileSync(old+'/coverage-root.txt','utf8').trim(),replayRoot=fs.readFileSync(old+'/study-r2-root.txt','utf8').trim();
const coverage=read(coverageRoot+'/coverage.json').filter(x=>x.passed),reg=read(replayRoot+'/registration.json');
await bind(reg.frozenFile,reg.frozenSha256);await bind(coverageRoot+'/coverage.json');await bind(coverageRoot+'/candidate-universe.json');await bind(replayRoot+'/selections.json',reg.selectionsSha256);
const frozen=read(reg.frozenFile),frozenMap=new Map(frozen.files.map(f=>[path.resolve(f.file),f.sha256]));
if(coverage.length!==45||coverage.filter(x=>x.universe==='A').length!==25)throw Error('Frozen universe differs');
const candidates=read(coverageRoot+'/candidate-universe.json'),markets=[];
for(const c of coverage){for(const type of ['price','daily','funding']){const file=c[type+'File'],expected=c[type+'Sha256'];if(frozenMap.get(path.resolve(file))!==expected)throw Error('File absent from frozen snapshot: '+file);await bind(file,expected);}markets.push({...c,daily:read(c.dailyFile).rows});}
const selected=selections(markets),inherited=read(replayRoot+'/selections.json');if(JSON.stringify(selected)!==JSON.stringify(inherited))throw Error('Selection recomputation mismatch');
const launches=calendar(Date.UTC(2023,2,1),Date.UTC(2026,9,19)).filter(w=>w.horizonDays===14);
const marketsOut=coverage.map(c=>{const windows=launches.filter(w=>selected.find(s=>s.universe==='A+B'&&s.at===quarterAt(w.launchAt)).groups.all.includes(c.symbol));return {...c,candidate:candidates.find(x=>x.symbol===c.symbol),first:windows[0]?.launchAt??null,last:windows.at(-1)?.launchAt??null,required15mBegin:windows.length?windows[0].launchAt-5*DAY:null,required15mEnd:windows.length?windows.at(-1).launchAt+7*DAY:null};});
for(const [name,value]of Object.entries({'inputs.json':[...bindings.values()],'markets.json':marketsOut,'selections.json':selected,'launches.json':launches,'registration.json':{preregistrationCommitHash:read(hb+'/tip.json').tipCommitHash,coverageRoot,replayRoot,frozenFile:reg.frozenFile,frozenSha256:reg.frozenSha256,createdAt:new Date().toISOString()}}))fs.writeFileSync(root+'/'+name,JSON.stringify(value)+'\n',{flag:'wx'});
fs.writeFileSync(hb+'/study-root.txt',root+'\n');fs.writeFileSync(hb+'/RESUME.md','Preregistration committed in permitted scratch clone. Inputs verified against frozen hashes; original selections recomputed exactly. No new simulations. Evidence: '+root+'\n');
console.log(JSON.stringify({root,certifiedHourly:coverage.length,launches:launches.length,eligiblePairs:marketsOut.filter(x=>x.first).length,inputs:bindings.size}));
