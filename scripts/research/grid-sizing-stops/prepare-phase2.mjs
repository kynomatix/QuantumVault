import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback',source=path.resolve('scripts/research/grid-sizing-stops');
const sha256=b=>createHash('sha256').update(b).digest('hex'),report=path.join(HB,'PHASE1-COMPLETE-REPORT.md');
if(!fs.existsSync(report))throw Error('Phase 1 report must be complete before Phase 2');
const p1=fs.readFileSync(path.join(HB,'phase1-root.txt'),'utf8').trim(),summary=JSON.parse(fs.readFileSync(path.join(p1,'summary.json'),'utf8'));
if(summary.receipts.length!==22)throw Error('Incomplete Phase 1');
const selection=JSON.parse(fs.readFileSync(path.join(HB,'phase1-selection.json'),'utf8'));
const file=path.join(source,'PREREGISTRATION-PHASE2.md');
if(fs.existsSync(file)||fs.existsSync(path.join(HB,'phase2-root.txt')))throw Error('Phase 2 already registered');
const text=`# Phase 2 preregistration — stops\n\nFrozen after the complete Phase 1 report and before any Phase 2 result. Phase 1 report SHA-256 hash: ${sha256(fs.readFileSync(report))}. Phase 1 summary SHA-256 hash: ${sha256(fs.readFileSync(path.join(p1,'summary.json')))}.\n\nPhase 1 selected arm: ${selection.selected??'none'}. Use Equal/Equal${selection.selected?' plus '+selection.selected:''}; reuse their already computed shipped-stop paths without counting them again. All populations, timing slots, horizons, ranges, sides, sizing helpers, $10 minimum, funding, fees, leverage, conservative path selection and rejection rules remain as in Phase 1. Admission retains the initial shipped-stop clearance for every arm. This conditions the no-stop population on a safe initial shipped-stop plan.\n\nSeven new variants: no stop; mark-equity disaster triggers at 10%, 15% or 25% of original $1,000 investment; shipped stop followed by at most 1, 2 or 3 re-entries. No stop retains the product range-based entry freeze and the round-2 mark/liquidation/funding model. Include every liquidation, seed hold, loss and below-starting-equity horizon outcome; profitable-if-not-liquidated is a survivorship trap. Disaster triggers include accrued fees and funding in equity; actual closing costs and gaps can exceed the trigger loss, so these are trigger levels rather than guarantees. Liquidation wins simultaneous triggers.\n\nRe-entry observes at least one completed bar after the stop bar, then a completed trade close strictly inside the same frozen range, and attempts at the next open strictly before the original horizon. Retain the original range/stop, leverage and scale types; recompute quantities with the unchanged product helper using remaining cash rounded down to cents. Recheck clearance. A rejected or seed-held relaunch stays cash; no unlimited retry. Charge every execution and funding event, carry cumulative drawdown across legs, and count underwater days against original $1,000 through the original horizon including stopped cash.\n\nReport mean/median/positive share/stop rate/drawdown/fills/fees and worst-1% and worst-5% average outcomes (fractional boundary mass), 1%/5% quantile cutoffs, worst outcome, below-20% and below-50% shares, liquidations, mean underwater days, horizon-underwater share, mean re-entries and rejected re-entry counts. Every mean receives a 5,000-replicate 95% calendar-week block-bootstrap interval. Paired means and tail differences use common sampled weeks; also show four-week block intervals for means and tails.\n\nFor each sizing arm, test a family of seven variants by four fee/leverage cells. A confirmed mean-and-tail improvement requires, on Pacifica development at that exact arm/fee/leverage, at least 20 contributing weeks, 50 matched rows, no smaller admission count, positive one- and four-week mean-return interval lower endpoints at 1-0.05/28 confidence, positive one- and four-week 95% lower endpoints for both worst-1% and worst-5% mean differences, and non-increasing point estimates for below-20% share, below-50% share, liquidation rate, mean drawdown and underwater days. Then require the same gates in both Pacifica evaluation and survivor-labelled OKX. No confirmation data choose a variant. Report point-estimate improvements separately; never recommend no stop from the mean alone. The tail conditions are an intersection, not separate winner searches.\n\nTEST REQUEST (owner): focused. TEST-RISK: REQUIRED. Use FRACTAL only, explicit verified commit hash and bundle-v1/run-qv-tests; preserve every receipt. Research only; no push, production/default, database, package or scanner change.\n`;
fs.writeFileSync(file,text,{flag:'wx'});
// Replace the inline re-entry wrapper with the identical tested shared strategy.
const runFile=path.join(source,'run.mjs');let run=fs.readFileSync(runFile,'utf8');
fs.writeFileSync(path.join(HB,'phase1-worker-original.mjs'),run,{flag:'wx'});
const start=run.indexOf('const metrics=r=>'),end=run.indexOf('for(const w of calendar');
if(start<0||end<start)throw Error('Worker extraction boundary changed');
const originalReplay=run.slice(start,end);fs.writeFileSync(path.join(HB,'phase1-worker-wrapper.txt'),originalReplay,{flag:'wx'});
run=run.replace("import {sizingReplay} from './replay.mjs';","import {replayStrategy} from './strategy.mjs';");
const a=run.indexOf('const metrics=r=>'),b=run.indexOf('for(const w of calendar');
run=run.slice(0,a)+`function replay(w,p,variant,pathName,markPath,makerRate,takerRate,policyInput){
 const input={candles:d.bars,dataHolds:d.dataHolds,market:d.market,timeframe:'1h',start:w.start,end:w.end,policy:p,
  path:pathName,markPath,markBars:d.marks,fundingEvents:d.fundingEvents,maxLeverage:d.maxLeverage,makerRate,takerRate,moveMode:'fixed',
  stopMode:variant==='shipped'||variant.startsWith('reenter')?'touch':'none',closeAtHorizon:true,
  ...(variant.startsWith('loss')?{equityFloor:1000*(1-Number(variant.slice(4))/100)}:{})};
 return replayStrategy(input,variant,({reference,cash,nextIndex})=>{
  const next=sizingPolicy({...policyInput,reference,investment:(Math.floor(cash*100)/100).toFixed(2)}).policy;
  const clearance=projection(next,d.market,d.maxLeverage,makerRate,takerRate,d.bars[nextIndex].time);
  if(clearance.state!=='available')throw Error(clearance.reason);
  return next;
 });
}
`+run.slice(b);
fs.writeFileSync(runFile,run);
const root=path.join(HB,'evidence','phase2-'+new Date().toISOString().replace(/[-:.]/g,''));if(fs.existsSync(root))throw Error('Fresh root required');fs.mkdirSync(root);
const binding={file,sha256:sha256(fs.readFileSync(file)),phase1ReportSha256:sha256(fs.readFileSync(report)),workerSha256:sha256(fs.readFileSync(runFile)),strategySha256:sha256(fs.readFileSync(path.join(source,'strategy.mjs'))),frozenAt:new Date().toISOString(),simulationsAtFreeze:0};
fs.writeFileSync(path.join(root,'registration.json'),JSON.stringify(binding,null,2)+'\n');fs.writeFileSync(path.join(HB,'phase2-root.txt'),root+'\n');
console.log(JSON.stringify({phase1Admitted:summary.tally.admittedUniqueNew,selected:selection.selected,phase2Root:root,preregistrationSha256:binding.sha256}));
