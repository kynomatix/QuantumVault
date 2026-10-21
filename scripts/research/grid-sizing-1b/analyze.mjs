import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {createHash} from 'node:crypto';
import {bootstrapDesign,BOOTSTRAP_SEED,REPLICATES,WEEK,weekAt,percentile} from '../grid-squeeze-diag/stats.mjs';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-1b-20261021-handback';
const root=fs.readFileSync(path.join(HB,'phase1b-root.txt'),'utf8').trim(),read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const registration=read(path.join(root,'registration.json')),hash=b=>createHash('sha256').update(b).digest('hex');
const oldArms=['flat_flat','further_further','further_flat','flat_further','near_near'],newArms=['near_flat','flat_near','near_further','further_near'];
const order=['flat_flat','flat_further','flat_near','further_flat','further_further','further_near','near_flat','near_further','near_near'];
const groups=new Map(),bound=new Map(),audit=[],slots=new Set(),oldWeeks=new Map(),newTally={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0};
const groupKey=r=>[r.cohort,r.builderRate,r.leverage,r.arm].join('|');
const pairKey=r=>[r.market,r.launchAt,r.horizonDays,r.window,r.direction].join('|');
async function digest(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
if(hash(fs.readFileSync(registration.file))!==registration.sha256)throw Error('Registration drift');
for(const f of registration.sourceFiles)if(hash(fs.readFileSync(f.file))!==f.sha256)throw Error('Source drift: '+f.file);
for(const item of registration.priorReceipts){
 if(hash(fs.readFileSync(item.file))!==item.sha256)throw Error('Prior receipt drift');
 const prior=read(item.file),nextFile=path.join(root,path.basename(item.file)),next=read(nextFile);
 for(const b of prior.bindings){if(bound.has(b.file)&&bound.get(b.file)!==b.sha256)throw Error('Inconsistent input binding');bound.set(b.file,b.sha256);}
 if(JSON.stringify(prior.bindings.map(b=>[b.file,b.sha256]).sort())!==JSON.stringify(next.bindings.map(b=>[b.file,b.sha256]).sort()))throw Error('Input population changed');
 for(const [receipt,isNew]of [[prior,false],[next,true]]){
  if(await digest(receipt.output)!==receipt.outputSha256)throw Error('Raw output hash mismatch');
  const seen=new Set(),derived=new Set(),pathGroups=new Map(),counts={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0};
  const expectedArms=isNew?newArms:oldArms,paths=receipt.cohort==='okx'?2:4;
  for await(const line of readline.createInterface({input:fs.createReadStream(receipt.output),crlfDelay:Infinity})){
   const r=JSON.parse(line);if(!expectedArms.includes(r.arm)||r.variant!=='shipped')throw Error('Unexpected arm or variant');
   const base=[groupKey(r),pairKey(r)].join('|'),id=base+'|'+r.path+'|'+r.markPath;
   if(r.derived){
    if(!r.admitted||derived.has(base))throw Error('Duplicate/invalid derived row');derived.add(base);counts.derivedRows++;
    const pg=pathGroups.get(base);if(!pg||pg.count!==paths||r.netReturn!==pg.worst.netReturn||r.maxDrawdown!==pg.worst.maxDrawdown||r.sourcePath!==pg.worst.path||r.sourceMarkPath!==pg.worst.markPath)throw Error('Worst-path envelope mismatch');pathGroups.delete(base);
    if(!Number.isFinite(r.netReturn)||!Number.isFinite(r.maxDrawdown))throw Error('Nonfinite metric');
    const k=groupKey(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push({key:pairKey(r),launchAt:r.launchAt,ret:r.netReturn,dd:r.maxDrawdown});
    if(!isNew){const ws=oldWeeks.get(r.cohort)??new Set();ws.add(weekAt(r.launchAt));oldWeeks.set(r.cohort,ws);}
    slots.add(new Date(r.launchAt).getUTCDay()+'|'+new Date(r.launchAt).getUTCHours());
   }else{
    if(seen.has(id))throw Error('Duplicate raw simulation');seen.add(id);counts.attempted++;
    if(r.admitted){counts.admittedUniqueNew++;const pg=pathGroups.get(base)??{count:0,worst:r};pg.count++;if(r.netReturn<pg.worst.netReturn)pg.worst=r;pathGroups.set(base,pg);}else counts.rejected++;
   }
  }
  if(pathGroups.size)throw Error('Missing derived outcome');
  for(const k of Object.keys(counts)){if(counts[k]!==receipt.counts[k])throw Error('Receipt tally mismatch');if(isNew)newTally[k]+=counts[k];}
  audit.push({file:receipt.output,sha256:receipt.outputSha256,isNew,counts});
 }
}
for(const [file,expected]of bound)if(await digest(file)!==expected)throw Error('Frozen input changed: '+file);
const designs=new Map();for(const [cohort,set]of oldWeeks){const ordered=[...set].sort((a,b)=>a-b),weeks=[];for(let w=ordered[0];w<=ordered.at(-1);w+=WEEK)weeks.push(w);for(const block of [1,4])designs.set(cohort+'|'+block,bootstrapDesign('sizing-stops|'+cohort,weeks,block));}
function ci(draws,alpha=.05){const a=Array.from(draws).filter(Number.isFinite).sort((a,b)=>a-b);if(a.length!==REPLICATES)throw Error('Missing bootstrap replicate');return {lower:percentile(a,alpha/2),upper:percentile(a,1-alpha/2)};}
function stats(rows,cohort,block=1){
 const d=designs.get(cohort+'|'+block),weekly=new Map();let ret=0,dd=0;
 for(const r of rows){const i=d.index.get(weekAt(r.launchAt));if(i===undefined)throw Error('New calendar endpoint');const w=weekly.get(i)??[0,0,0];w[0]++;w[1]+=r.ret;w[2]+=r.dd;ret+=r.ret;dd+=r.dd;weekly.set(i,w);}
 const rd=new Float64Array(REPLICATES).fill(NaN),ddraw=new Float64Array(REPLICATES).fill(NaN);
 for(let b=0;b<REPLICATES;b++){let n=0,r=0,x=0;for(const [i,v]of weekly){const w=d.weights[b*d.n+i];n+=w*v[0];r+=w*v[1];x+=w*v[2];}if(n){rd[b]=r/n;ddraw[b]=x/n;}}
 return {n:rows.length,weeks:weekly.size,return:{mean:ret/rows.length,...ci(rd)},drawdown:{mean:dd/rows.length,...ci(ddraw)},returnAdjusted:ci(rd,.05/8)};
}
const cells=[];for(const cohort of ['development','evaluation','okx'])for(const fee of [.001,0])for(const leverage of [1,3]){
 const base=groups.get([cohort,fee,leverage,'flat_flat'].join('|')),bm=new Map(base.map(r=>[r.key,r]));
 if(bm.size!==base.length)throw Error('Duplicate baseline matching key');
 for(const arm of order){const rows=groups.get([cohort,fee,leverage,arm].join('|'));if(!rows?.length)throw Error('Missing factorial cell');
  const matched=rows.filter(r=>bm.has(r.key)),pairs=matched.map(r=>({launchAt:r.launchAt,ret:r.ret-bm.get(r.key).ret,dd:r.dd-bm.get(r.key).dd}));
  const paired=stats(pairs,cohort),four=stats(pairs,cohort,4),absolute=stats(rows,cohort),matchedAbsolute=stats(matched,cohort),matchedBaseline=stats(matched.map(r=>bm.get(r.key)),cohort);
  cells.push({cohort,builderRate:fee,leverage,arm,newArm:newArms.includes(arm),admission:rows.length,baselineAdmission:base.length,unmatchedCandidate:rows.length-pairs.length,unmatchedBaseline:base.length-pairs.length,paired,returnBlock4:four.return,returnBlock4Adjusted:four.returnAdjusted,absolute,matchedAbsolute,matchedBaseline});
 }
}
// Reconstruct the original estimates first-hand; all old 95% means/intervals must agree.
const oldSummary=read(path.join(registration.priorRoot,'summary.json'));let verifiedOriginalCells=0;
for(const c of cells.filter(c=>oldArms.includes(c.arm))){const old=oldSummary.pooled.find(x=>x.cohort===c.cohort&&x.builderRate===c.builderRate&&x.leverage===c.leverage&&x.arm===c.arm);for(const [a,b]of [['return','meanReturn'],['drawdown','meanDrawdown']])for(const k of ['mean','lower','upper'])if(Math.abs(c.absolute[a][k]-old.metrics[b][k])>1e-12)throw Error('Original absolute estimate differs');
 if(c.arm!=='flat_flat'){const p=oldSummary.comparisons.find(x=>x.cohort===c.cohort&&x.builderRate===c.builderRate&&x.leverage===c.leverage&&x.arm===c.arm);for(const [a,b]of [['return','meanReturn'],['drawdown','meanDrawdown']])for(const k of ['mean','lower','upper'])if(Math.abs(c.paired[a][k]-p.metrics[b][k])>1e-12)throw Error('Original paired estimate differs');}verifiedOriginalCells++;}
const tieOrder=[...oldArms.slice(1),...newArms];
const candidates=cells.filter(c=>c.cohort==='development'&&c.builderRate===.001&&c.leverage===1&&c.arm!=='flat_flat').map(c=>({arm:c.arm,weeks:c.paired.weeks,n:c.paired.n,meanReturn:c.paired.return.mean,passes:c.paired.weeks>=20&&c.paired.n>=50&&c.admission>=c.baselineAdmission&&c.paired.returnAdjusted.lower>0&&c.returnBlock4Adjusted.lower>0&&c.paired.drawdown.mean<=0})).sort((a,b)=>b.meanReturn-a.meanReturn||tieOrder.indexOf(a.arm)-tieOrder.indexOf(b.arm));
const selected=candidates.find(c=>c.passes)?.arm??null;
const confirmation=arm=>['evaluation','okx'].every(cohort=>{const c=cells.find(c=>c.cohort===cohort&&c.arm===arm&&c.builderRate===.001&&c.leverage===1);return c.paired.return.lower>0&&c.returnBlock4.lower>0&&c.paired.drawdown.mean<=0;});
const descriptiveBoth=[];for(const fee of [.001,0])for(const leverage of [1,3])for(const arm of tieOrder){const cs=['evaluation','okx'].map(cohort=>cells.find(c=>c.cohort===cohort&&c.arm===arm&&c.builderRate===fee&&c.leverage===leverage));if(cs.every(c=>c.paired.return.lower>0&&c.returnBlock4.lower>0&&c.paired.drawdown.upper<0))descriptiveBoth.push({arm,builderRate:fee,leverage});}
const summary={newTally,oldTally:oldSummary.tally,verifiedOriginalCells,bootstrapSeed:BOOTSTRAP_SEED,bootstrapPeriod:'sizing-stops|COHORT',replicates:REPLICATES,selectionAlpha:.05/8,selected,confirmed:!!selected&&confirmation(selected),candidates,descriptiveBoth,slots:[...slots].sort(),cells,audit,completedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
const csv=cells.map(c=>{const o={cohort:c.cohort,builderFee:c.builderRate,leverage:c.leverage,entry:c.arm.split('_')[0],profit:c.arm.split('_')[1],newArm:c.newArm,admittedRows:c.admission,baselineRows:c.baselineAdmission,matchedRows:c.paired.n,weeks:c.paired.weeks,unmatchedCandidate:c.unmatchedCandidate,unmatchedBaseline:c.unmatchedBaseline};for(const kind of ['absolute','matchedAbsolute','matchedBaseline','paired'])for(const metric of ['return','drawdown'])for(const field of ['mean','lower','upper'])o[kind+'_'+metric+'_'+field+'_pct']=100*c[kind][metric][field];for(const kind of ['returnBlock4','returnBlock4Adjusted'])for(const field of ['lower','upper'])o[kind+'_'+field+'_pp']=100*c[kind][field];for(const field of ['lower','upper'])o['returnAdjusted_'+field+'_pp']=100*c.paired.returnAdjusted[field];return o;});
const keys=Object.keys(csv[0]),q=x=>'"'+String(x).replaceAll('"','""')+'"';fs.writeFileSync(path.join(HB,'SIZING-3X3-ABSOLUTE.csv'),[keys.map(q).join(','),...csv.map(r=>keys.map(k=>q(r[k])).join(','))].join('\n')+'\n');
const names={flat:'Equal',further:'Further',near:'Near'},cohorts={development:'Pacifica development',evaluation:'Pacifica evaluation',okx:'OKX majors'};
const f=x=>(100*x).toFixed(3),cell=x=>`${f(x.mean)} [${f(x.lower)}, ${f(x.upper)}]`;
const answer=summary.confirmed?'A preregistered arm confirmed a return gain without worse drawdown in both confirmation cohorts.':'No sizing combination has a confirmed return-and-drawdown advantage over Equal/Equal in both Pacifica evaluation and the OKX majors under the preregistered rule.';
const lines=['# Sizing: the complete 3 × 3','',answer,'',`**ADMITTED unique NEW simulations: ${newTally.admittedUniqueNew.toLocaleString('en-US')}.** Attempted ${newTally.attempted.toLocaleString('en-US')}; rejected ${newTally.rejected.toLocaleString('en-US')}; conservative derived rows ${newTally.derivedRows.toLocaleString('en-US')} add zero simulations. All ${oldSummary.tally.admittedUniqueNew.toLocaleString('en-US')} original paths are reused, never re-simulated or counted as new.`, '',
 '## Design and selection','',
 'Exactly the corrected Phase 1 setup: Pacifica BTC/ETH/SOL/HYPE/ZEC and 12 OKX majors; one weekly launch rotating across 21 weekday/hour slots; week/month ranges; 14/30-day horizons; both sides; 10 intervals; step_back; seed on; starting equity 1,000; 1x/3x. Builder fee 0.10% or zero plus maker 0.015% and taker 0.040%; adverse market slippage 0.05%. Actual funding and full scheduled coverage, trade-close terminal execution, inherited mark/liquidation model and the same worst-return path carrying all metrics. No fresh data was fetched.', '',
 'Selection uses only Pacifica development at 0.10% and 1x. All eight alternatives now receive 99.375% Bonferroni return intervals for both one- and four-week blocks. The unchanged rule also requires 20 contributing weeks, 50 pairs, no admission-count loss and non-worse mean drawdown. Evaluation and OKX cannot choose a winner.', '',
 `Selected arm: ${selected??'none'}. Development candidate week counts: ${[...new Set(candidates.map(c=>c.weeks))].join(', ')}. Arms satisfying favorable return and drawdown 95% CIs in both confirmation cohorts (descriptive, with positive four-week return bounds): ${descriptiveBoth.length?JSON.stringify(descriptiveBoth):'none'}.`, '',
 '## Combined nine-cell table','',
 'Entry/profit names are independent. Each cohort × fee × leverage contains all nine cells. Values are matched mean differences in percentage points of initial-equity return and percentage points of peak-relative drawdown. Positive return and negative drawdown favor the arm. Brackets are two-sided 95% calendar-week bootstrap CIs, 5,000 resamples; Equal/Equal differences are identically zero. Four-week and selection-adjusted return CIs, absolute means/CIs, matched baseline means, and admission counts are in SIZING-3X3-ABSOLUTE.csv. Pair populations can differ because admission is mutual.', '',
 '| Cohort | Builder fee | Leverage | Entry | Profit | Pairs / weeks | Return difference pp [95% CI] | Drawdown difference pp [95% CI] |','|---|---:|---:|---|---|---:|---:|---:|'];
for(const c of cells){const [e,p]=c.arm.split('_');lines.push(`| ${cohorts[c.cohort]} | ${(c.builderRate*100).toFixed(2)}% | ${c.leverage}x | ${names[e]} | ${names[p]} | ${c.paired.n} / ${c.paired.weeks} | ${cell(c.paired.return)} | ${cell(c.paired.drawdown)} |`);}
lines.push('','## Interpretation and limits','',
 'Further/Equal reproduces the earlier drawdown reduction, but the Pacifica evaluation return interval includes zero. The brief overstated its 3x Pacifica evaluation drawdown reduction: the matched reduction is about 0.96 points at the 0.10% builder fee, versus about 1.35 in development and 1.38 on OKX. Its zero-builder-fee OKX 1x return interval also includes zero. All earlier cells were reconstructed from raw completed paths and verified against Phase 1 means and 95% intervals.', '',
 'The 20-week development gate remains binding. The extension was registered after viewing Phase 1 results and after Phase 2 had already completed; it is a retrospective completion of the original factorial design, not an untouched future validation. Missing funding leaves sparse Pacifica weeks. OKX includes present-day survivors and uses trade prices as mark proxies. Current rather than historical venue constraints, hourly full-fill path assumptions, overlapping horizons and a conservative path envelope limit generalization. Drawdown is inherited peak-relative maximum drawdown. Liquidations can finish with negative equity and remain included.', '',
 `Bootstrap seed: ${BOOTSTRAP_SEED}; period: sizing-stops|COHORT; blocks: 1 and 4 calendar weeks; resamples: ${REPLICATES}; original cohort calendar endpoints and empty intervening weeks retained.`, '',
 '## Evidence','',`Registration and raw/derived outputs: ${root}`,`Original completed output root: ${registration.priorRoot}`,`Verified original pooled cells: ${verifiedOriginalCells}; input file bindings: ${bound.size}; covered launch slots: ${slots.size}.`,
 'Research source, static review, focused FRACTAL receipts, secret-scan status and delivery identity are recorded in VALIDATION.md and DELIVERY-MANIFEST.json. No independent Opus review or conductor gate approval is claimed. No production, package, lockfile, schema, UI or database changes.','');
fs.writeFileSync(path.join(HB,'SIZING-3X3-REPORT.md'),lines.join('\n'));
fs.writeFileSync(path.join(HB,'RESUME.md'),answer+'\nNew admitted tally: '+newTally.admittedUniqueNew+'\nAnalysis complete; validation and delivery remain.\n');
console.log(JSON.stringify({newTally,verifiedOriginalCells,selected,confirmed:summary.confirmed,descriptiveBoth}));
