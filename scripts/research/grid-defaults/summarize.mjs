import fs from 'node:fs';
import path from 'node:path';
import {readLines,sha256} from '../grid-direction/io.mjs';
import {settings,BASELINE,metrics,idle,compare} from './design.mjs';
const [evidence,handback]=process.argv.slice(2);
const read=name=>JSON.parse(fs.readFileSync(path.join(evidence,name),'utf8'));
const record=read('run-record.json'),selection=read('development-selection.json');
if(!record.completedAt)throw Error('Incomplete evaluation');
if(sha256(fs.readFileSync(path.join(evidence,'development-selection.json')))!==record.selectionSha256)throw Error('Development selection changed');
const output=path.join(evidence,'summary');fs.mkdirSync(output);
const csv=(name,rows)=>{const keys=[...new Set(rows.flatMap(Object.keys))];fs.writeFileSync(path.join(output,name),keys.join(',')+'\n'+rows.map(r=>keys.map(k=>JSON.stringify(r[k]??'')).join(',')).join('\n')+'\n');};
const pooled=[],splits=[],pairs=[],confirmations=[],rejections=[],coverage=[];
for(const period of ['development','evaluation','proxy']){
  const phase=record.phases.find(p=>p.period===period),file=path.join(evidence,`runs-${period}.jsonl`);
  if(sha256(fs.readFileSync(file))!==phase.runsSha256)throw Error('Run file changed');
  const rows=[],seen=new Set();await readLines(file,r=>{const key=r.setting+'|'+r.key;if(seen.has(key))throw Error('Duplicate scenario');seen.add(key);rows.push(r);});
  if(rows.length!==phase.scheduled||rows.filter(r=>r.admitted).length!==phase.admitted)throw Error('Cardinality mismatch');
  const byId=new Map(settings.map(s=>[s.id,rows.filter(r=>r.setting===s.id)]));
  for(const s of settings){
    const rr=byId.get(s.id);
    for(const pathName of ['pooled','OHLC','OLHC']){
      const group=rr.filter(r=>pathName==='pooled'||r.path===pathName),admitted=group.filter(r=>r.admitted);
      for(const accounting of ['admitted','cash'])pooled.push({period,setting:s.id,path:pathName,accounting,scheduled:group.length,admitted:admitted.length,coverage:admitted.length/group.length,...metrics(accounting==='admitted'?admitted:group.map(idle))});
    }
    for(const axis of ['market','direction','timeframe','horizonDays','year']){
      const value=r=>axis==='year'?String(new Date(r.launchAt).getUTCFullYear()):String(r[axis]);
      for(const v of [...new Set(rr.map(value))])for(const pathName of ['pooled','OHLC','OLHC']){
        const group=rr.filter(r=>value(r)===v&&(pathName==='pooled'||r.path===pathName)),admitted=group.filter(r=>r.admitted);
        splits.push({period,setting:s.id,axis,value:v,path:pathName,scheduled:group.length,admitted:admitted.length,...metrics(admitted)});
      }
    }
    const reasons=new Map();for(const r of rr.filter(r=>!r.admitted))reasons.set(r.reason,(reasons.get(r.reason)??0)+1);
    for(const [reason,n] of reasons)rejections.push({period,setting:s.id,reason,n});
    const comparison=compare(rr,byId.get(BASELINE));
    for(const p of comparison.paths)pairs.push({period,setting:s.id,path:p.path,passes:p.passes,paired:p.paired.n,candidateAdmitted:p.candidateAdmitted,baselineAdmitted:p.baselineAdmitted,
      meanDelta:p.paired.mean-p.baseline.mean,meanDrawdownDelta:p.paired.meanDrawdown-p.baseline.meanDrawdown,stopRateDelta:p.paired.stopRate-p.baseline.stopRate,
      cashMeanDelta:p.cash.mean-p.baselineCash.mean,cashDrawdownDelta:p.cash.meanDrawdown-p.baselineCash.meanDrawdown,cashStopRateDelta:p.cash.stopRate-p.baselineCash.stopRate});
    if(s.id===selection.selected){const sameId=`week-1-10-${s.mode}`,sameMode=s.id===sameId?null:compare(rr,byId.get(sameId));confirmations.push({period,setting:s.id,passes:comparison.passes&&(!sameMode||sameMode.passes),shipped:comparison,sameMode});}
  }
  coverage.push({period,scheduled:rows.length,admitted:phase.admitted,uniqueScenarioKeys:new Set(rows.map(r=>r.key)).size,earliestLaunch:new Date(Math.min(...rows.filter(r=>r.setting===BASELINE).map(r=>r.launchAt))).toISOString(),latestLaunch:new Date(Math.max(...rows.filter(r=>r.setting===BASELINE).map(r=>r.launchAt))).toISOString()});
}
csv('all-settings.csv',pooled);csv('splits.csv',splits);csv('paired-comparisons.csv',pairs);csv('rejections.csv',rejections);
const confirmed=!!selection.selected&&confirmations.length===3&&confirmations.every(c=>c.passes);
fs.writeFileSync(path.join(output,'conclusion.json'),JSON.stringify({developmentSelected:selection.selected,confirmed,recommendation:confirmed?selection.selected:'keep the shipped defaults',confirmations,coverage},null,2)+'\n');
const p=x=>Number.isFinite(x)?(x*100).toFixed(3)+'%':'N/A',f=x=>Number.isFinite(x)?x.toFixed(2):'N/A';
let report='# Grid defaults backtest\n\n'+(confirmed
  ?'One preregistered setting improved average results without increasing average drawdown or the stop rate in development and both historical confirmation periods. This supports a candidate default for further validation, not a promise that a future bot will make money.\n\n'
  :'Keep the shipped defaults: no preregistered setting met the full rule for a reliable improvement across development and both historical confirmation periods. A higher win rate or fewer stops alone did not establish a better default.\n\n');
report+='## Decision\n\nDevelopment selection: '+(selection.selected??'none')+'. Final recommendation: **'+(confirmed?selection.selected:'keep the shipped defaults')+'**. Selection was written before confirmation replay and has an unchanged SHA-256 binding. No confirmation-period re-picking was permitted.\n\n';
report+='The comparator is week / shipped stop / 10 intervals / repeat_all, seed on. The source still defaults to repeat_all; the proposed transition to step_back is tested explicitly. Entry and profit sizes are Equal, leverage is 1, and capital is fixed at 1,000 quote units. The UI has no investment default. Both 1h and 4h, both sides, 14/30-day holds and both intrabar paths are included; these pooled returns are not the result of running just the default 1h long form.\n\n';
report+='## Shipped baseline\n\n| Period | Admitted / scheduled | Mean | Median | Profitable | Stop rate | Mean DD | Worst DD | Mean fees | Mean fills |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of pooled.filter(r=>r.setting===BASELINE&&r.path==='pooled'&&r.accounting==='admitted'))report+=`| ${r.period} | ${r.admitted}/${r.scheduled} | ${p(r.mean)} | ${p(r.median)} | ${p(r.profitable)} | ${p(r.stopRate)} | ${p(r.meanDrawdown)} | ${p(r.worstDrawdown)} | ${f(r.meanFees)} | ${f(r.meanFills)} |\n`;
report+='\n## Every registered setting\n\nIDs encode window, stop-buffer multiplier, intervals and behaviour mode. Tables pool both intrabar paths and show admitted bots. The complete CSV also gives each path, totals, seed holds, missing-data runs and the cash-for-rejected sensitivity. Drawdown is relative to each running equity peak, matching the prior simulator. Fees are quote units; fills include seeds and stop exits.\n';
for(const period of ['development','evaluation','proxy']){
 report+=`\n### ${period}\n\n| Setting | Admitted / scheduled | Mean | Median | Profitable | Stop rate | Mean DD | Worst DD | Mean fees | Mean fills |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
 for(const r of pooled.filter(r=>r.period===period&&r.path==='pooled'&&r.accounting==='admitted'))report+=`| ${r.setting} | ${r.admitted}/${r.scheduled} | ${p(r.mean)} | ${p(r.median)} | ${p(r.profitable)} | ${p(r.stopRate)} | ${p(r.meanDrawdown)} | ${p(r.worstDrawdown)} | ${f(r.meanFees)} | ${f(r.meanFills)} |\n`;
}
report+='\n## Interpretation and limitations\n\nRanges and stops are produced by the product PlannerRangeFacts, including its original tick rounding. The period range is the observed high/low expanded by 0.5 ATR; its stop is another 0.75 ATR beyond the adverse edge on these timeframes. Wider settings multiply the shipped rounded buffer. The separate manual-range 3% suggestion is not the stop tested here. The old eight-interval study is not substituted for this ten-interval seeded baseline.\n\n';
report+='All settings use the same scheduled calendar. Missing history and invalid/underfunded/fee-rejected grids are explicit refusals. Selection requires no lower admission coverage and no worse risk on both paired admitted runs and the cash-inclusive scheduled grid. This prevents improved averages being accepted solely because an arm refuses difficult launches. Month-window early-history exclusions and narrow-day fee clearance can materially change which bots can start. See rejections.csv.\n\n';
report+='The proxy applies current frozen Pacifica fees, tick/lot constraints and safety envelopes to older OKX prices; Gate data remains in the verified direction snapshot but is not spliced into replay where complete OKX perpetual bars exist. BTC/ETH/SOL are surviving markets selected today; the proxy omits HYPE/ZEC. Funding, real spreads, queue priority, partial fills, latency and historical constraint changes are not reconstructed. Current fees/slippage are scenario assumptions. Fixed capital does not establish optimal settings for smaller accounts.\n\n';
report+='Weekly launches and 14/30-day horizons overlap; markets, parameter arms and the two intrabar paths are dependent. Counts are simulated bots, not independent samples. The earlier research already inspected evaluation dates, and the proxy is retrospective, so neither confirmation is an untouched prospective holdout. Many settings are compared without a significance claim. Results are per-bot returns with inventory marked at horizon, not annualized returns or a portfolio. Protective stops terminate permanently; missing candles retain the prior data-hold treatment.\n\n';
report+='## Evidence\n\n[Preregistration](PREREGISTRATION.md), [source inventory](SHIPPED-DEFAULTS.md), [all settings](<'+path.join(output,'all-settings.csv').replaceAll('\\','/')+'>), [paired comparisons](<'+path.join(output,'paired-comparisons.csv').replaceAll('\\','/')+'>), [strata](<'+path.join(output,'splits.csv').replaceAll('\\','/')+'>), [rejected plans](<'+path.join(output,'rejections.csv').replaceAll('\\','/')+'>). CSV returns and drawdowns are fractions.\n\n';
report+=`Offline replay used one worker, ${record.seconds.toFixed(1)} seconds, and sampled minimum free memory ${record.minimumFreeGiB.toFixed(2)} GiB. Twenty representative prior runs exactly matched returns, drawdowns, stopped flags, fees and fills; the actual planner matched the earlier week geometry. Source and result SHA-256 bindings are retained in run-record.json. The focused FRACTAL status and static review are recorded separately in REVIEW-REPORT.md.\n`;
fs.writeFileSync(path.join(handback,'DEFAULTS-BACKTEST-REPORT.md'),report);
console.log(JSON.stringify({recommendation:confirmed?selection.selected:'keep the shipped defaults',developmentSelected:selection.selected,rows:record.phases.reduce((s,p)=>s+p.scheduled,0),coverage}));
