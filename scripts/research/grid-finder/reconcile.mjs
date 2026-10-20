// Research evidence reconciliation, not a product test runner.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
const root=process.argv[2];
const prior='C:/Apps/Replit/conductor-worktrees/grid-backtest-r2-20261020-handback/evidence/r2-20261020T062012Z';
const fileHash=async file=>{
 const hash=createHash('sha256');
 for await(const bytes of fs.createReadStream(file))hash.update(bytes);
 return hash.digest('hex');
};
async function* rows(file){
 for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity}))yield JSON.parse(line);
}
const key=r=>[r.market,r.timeframe,r.launchAt,r.horizonDays,r.direction,r.path,r.markPath,r.leverage].join('|');
const metrics=['netReturn','maxDrawdown','fees','funding','fillCount','protectiveStop','liquidated','seedHold'];
const results=[];
for(const period of ['development','evaluation']){
 const currentPath=path.join(root,`runs-${period}.jsonl`), priorPath=path.join(prior,`phase-c-risk-${period}.jsonl`);
 const previousBinding=JSON.parse(fs.readFileSync(path.join(prior,`phase-c-risk-${period}-complete.json`),'utf8'));
 const priorSha256=await fileHash(priorPath);
 if(priorSha256!==previousBinding.runsSha256)throw Error('Round-two raw result binding mismatch');
 const current=new Map();
 for await(const r of rows(currentPath))if(/^b100-L[135]$/.test(r.setting))current.set(key(r),r);
 let matched=0,admissionDifferences=0,unexpectedAdmissionDifferences=0,metricDifferences=0,bothAdmitted=0,maxAbsoluteDifference=0;
 const admissionDifferenceReasons={};
 const examples=[];
 for await(const r of rows(priorPath)){
  if(!/^family0-L[135]$/.test(r.setting))continue;
  const c=current.get(key(r));if(!c)continue;
  matched++;
  if(c.admitted!==r.admitted){
   admissionDifferences++;
   const label=`current: ${c.reason??'ADMITTED'}; previous: ${r.reason??'ADMITTED'}`;
   admissionDifferenceReasons[label]=(admissionDifferenceReasons[label]??0)+1;
   if(c.admitted||!r.admitted||c.reason!=='gapped execution horizon')unexpectedAdmissionDifferences++;
   if(examples.length<5)examples.push({key:key(r),currentReason:c.reason,priorReason:r.reason});
  }
  if(c.admitted&&r.admitted){
   bothAdmitted++;
   for(const m of metrics){
    const delta=Math.abs(Number(c[m])-Number(r[m]));maxAbsoluteDifference=Math.max(maxAbsoluteDifference,delta);
    if(delta>1e-12){metricDifferences++;if(examples.length<5)examples.push({key:key(r),metric:m,current:c[m],prior:r[m]});}
   }
  }
 }
 results.push({period,currentPath,currentSha256:await fileHash(currentPath),priorPath,priorSha256,
  candidateRows:current.size,matched,bothAdmitted,admissionDifferences,unexpectedAdmissionDifferences,admissionDifferenceReasons,metricDifferences,maxAbsoluteDifference,examples});
}
const reused=JSON.parse(fs.readFileSync(path.join(root,'reused-source-bindings.json'),'utf8'));
const sourceBindings=[];
for(const b of reused)sourceBindings.push({...b,sourceMatches:await fileHash(b.sourcePath)===b.sha256,copiedMatches:await fileHash(b.copiedPath)===b.sha256});
const out={kind:'research-evidence-reconciliation',results,sourceBindings,
 identicalAdmission:results.every(r=>!r.admissionDifferences),
 note:'This study preregistered complete scheduled candle horizons. Round two allowed some early-stopped runs whose later scheduled candles were gapped.',
 consistent:results.every(r=>r.matched===r.candidateRows&&!r.unexpectedAdmissionDifferences&&!r.metricDifferences)&&sourceBindings.every(b=>b.sourceMatches&&b.copiedMatches)};
fs.writeFileSync(path.join(root,'baseline-reconciliation.json'),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({consistent:out.consistent,periods:results.map(({period,matched,bothAdmitted,admissionDifferences,metricDifferences})=>({period,matched,bothAdmitted,admissionDifferences,metricDifferences}))}));
