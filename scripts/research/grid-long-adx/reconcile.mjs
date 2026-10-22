import fs from 'node:fs';import readline from 'node:readline';import path from 'node:path';
const hb=path.resolve('../grid-long-adx-20261022-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),reference=fs.readFileSync(hb+'/reference-study-root.txt','utf8').trim();
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));if(!process.argv.includes('--reference-only')&&!fs.existsSync(root+'/completion.json'))throw Error('Wait for completed analysis');
const old=[];for await(const line of readline.createInterface({input:fs.createReadStream(reference+'/cells.jsonl'),crlfDelay:Infinity}))old.push(JSON.parse(line));
let cells=0,numericValues=0,maxAbsoluteDifference=0;
function check(a,b,key){if(typeof a==='number'){if(typeof b!=='number')throw Error('Type difference: '+key);const delta=Math.abs(a-b);numericValues++;maxAbsoluteDifference=Math.max(maxAbsoluteDifference,delta);if(delta>1e-12)throw Error('Estimator difference: '+key);return;}if(a===null||typeof a!=='object'){if(a!==b)throw Error('Value difference: '+key);return;}if(JSON.stringify(Object.keys(a))!==JSON.stringify(Object.keys(b)))throw Error('Key difference: '+key);for(const k of Object.keys(a))check(a[k],b[k],key+'.'+k);}
for await(const line of readline.createInterface({input:fs.createReadStream(root+'/cells.jsonl'),crlfDelay:Infinity})){if(cells>=old.length)break;check(old[cells],JSON.parse(line),'cell'+cells);cells++;}
if(cells!==old.length)throw Error('Missing reference cells');
const baseline=read(root+'/baseline-reconciliation.json');if(Math.abs(baseline.netReturn.mean*100-(-.730))>.0005)throw Error('Prior headline not reproduced');
const selections=read(root+'/selections.json'),tally=read(root+'/tally.json');
const {calendar,quarterAt}=await import('../grid-ranging-pairs/core.mjs');
const coverageRoot=fs.readFileSync('../grid-ranging-pairs-20261021-handback/coverage-root.txt','utf8').trim(),coverage=read(coverageRoot+'/coverage.json').filter(c=>c.passed);
let noLaunch=0;for(const c of coverage)for(const w of calendar(Date.UTC(2023,2,1),Date.UTC(2026,9,19)))if(!selections.find(s=>s.universe==='A+B'&&s.at===quarterAt(w.launchAt)).all.includes(c.symbol))noLaunch++;
if(noLaunch!==tally.noLaunch)throw Error('No-launch count differs');
const result={referenceCells:cells,numericValues,maxAbsoluteDifference,passed:true,baselineReproduced:true,noLaunchVerified:noLaunch};
fs.writeFileSync(root+'/estimator-reconciliation.json',JSON.stringify(result)+'\n');console.log(JSON.stringify(result));
