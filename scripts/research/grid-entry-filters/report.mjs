import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {RULES,SETTINGS,summary,configurations,confirmation,tally} from './core.mjs';
const root=process.argv[2],handback=path.resolve(root,'../..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=async file=>{const rows=[];for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity}))if(line)rows.push(JSON.parse(line));return rows;};
const esc=v=>v===null||v===undefined?'':/[",\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v);
export function writeCsv(file,rows){
  const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  fs.writeFileSync(file,[columns.join(','),...rows.map(r=>columns.map(k=>esc(r[k])).join(','))].join('\n')+'\n','utf8');
}
const lock=read(path.join(root,'development-lock.json')),results=[],rejections=[],signalStats=[],candidateRows=[],
  periods={},confirmations={},reconciliations=[];
const arms=['BLIND','BLIND_MEASURABLE',...RULES],dimensionKeys=['year','regime','market','direction','horizonDays','path','markPath'];
const launchKey=r=>`${r.launchAt}|${r.market}`;
const countLaunches=rows=>new Set(rows.map(launchKey)).size;
const priorRoot=fs.readFileSync('C:/Apps/Replit/conductor-worktrees/grid-finder-backtest-20261020-handback/evidence-root.txt','utf8').trim();
for(const period of ['development','evaluation','proxy']){
  const file=path.join(root,`runs-${period}.jsonl`),receipt=read(path.join(root,`complete-${period}.json`));
  if(hash(fs.readFileSync(file))!==receipt.runsSha256)throw Error('Run binding mismatch');
  if(hash(fs.readFileSync(path.join(root,'development-lock.json')))!==receipt.developmentLockSha256)throw Error('Development lock changed');
  const rows=await load(file);
  periods[period]=tally(rows);
  if(periods[period].admitted!==receipt.admitted||periods[period].attempted!==receipt.attempted)throw Error('Tally differs from completion receipt');
  confirmations[period]=confirmation(rows,lock.selected);
  for(const c of configurations(rows)){
    const dev=lock.candidates.find(d=>d.rule===c.rule&&d.window===c.window&&d.setting===c.setting);
    const locked=!!lock.selected&&c.rule===lock.selected.rule&&c.window===lock.selected.window&&c.setting===lock.selected.setting;
    candidateRows.push({period,rule:c.rule,window:c.window,setting:c.setting,mean:c.mean,median:c.median,
      profitable:c.profitable,stopRate:c.stopRate,meanDrawdown:c.meanDrawdown,worstDrawdown:c.worstDrawdown,
      weeks:c.weeks,retention:c.retention,developmentPass:dev.qualifies,directionalPass:c.qualifies,locked,
      confirmed:locked&&period!=='development'?confirmations[period].passed:null,
      failedConditions:Object.entries(c.checks).filter(([,v])=>!v).map(([k])=>k).join(';')});
  }
  for(const window of ['week','month'])for(const setting of SETTINGS)for(const timeframe of ['1h','4h']){
    const base=rows.filter(r=>r.window===window&&r.setting===setting.id&&r.timeframe===timeframe);
    const dims=[['all','all'],...dimensionKeys.flatMap(key=>[...new Set(base.map(r=>r[key]))].map(v=>[key,v]))];
    for(const [dimension,value]of dims){
      const population=dimension==='all'?base:base.filter(r=>r[dimension]===value);
      const calendarWeeks=new Set(population.map(r=>r.launchAt)).size;
      for(const arm of arms){
        const group=population.filter(r=>r.arms.includes(arm)),s=summary(group);
        const weeks=new Set(group.filter(r=>r.admitted).map(r=>r.launchAt));
        const blind=summary(population.filter(r=>r.arms.includes('BLIND_MEASURABLE')&&weeks.has(r.launchAt)));
        const fullBlind=summary(population.filter(r=>r.arms.includes('BLIND_MEASURABLE')));
        results.push({period,window,setting:setting.id,builderRate:setting.builderRate,leverage:setting.leverage,timeframe,
          arm,dimension,value,...s,calendarWeeks,selectedLaunches:countLaunches(group),
          selectedPerWeek:calendarWeeks?countLaunches(group)/calendarWeeks:0,
          admittedPerWeek:calendarWeeks?s.admittedLaunches/calendarWeeks:0,
          retention:fullBlind.admittedLaunches?s.admittedLaunches/fullBlind.admittedLaunches:null,
          blindRuns:blind.runs,blindMean:blind.mean,blindMedian:blind.median,blindProfitable:blind.profitable,
          blindStopRate:blind.stopRate,blindMeanDrawdown:blind.meanDrawdown,blindWorstDrawdown:blind.worstDrawdown,
          meanLift:s.mean!==null&&blind.mean!==null?s.mean-blind.mean:null});
      }
    }
    const reasons=new Map();
    for(const r of base.filter(r=>!r.admitted))reasons.set(r.reason,(reasons.get(r.reason)??0)+1);
    for(const [reason,count]of reasons)rejections.push({period,window,setting:setting.id,timeframe,reason,count});
  }
  const selections=read(path.join(root,`selections-${period}.json`));
  if(hash(fs.readFileSync(path.join(root,`selections-${period}.json`)))!==receipt.selectionSha256)throw Error('Selection binding mismatch');
  const weeks=new Set(selections.map(s=>s.launchAt)).size;
  for(const rule of RULES){
    const counts={pass:0,fail:0,unavailable:0},reasons={};
    for(const s of selections){const v=s.rules[rule];counts[v.state]++;if(v.reason)reasons[v.reason]=(reasons[v.reason]??0)+1;}
    signalStats.push({period,rule,...counts,calendarWeeks:weeks,selectedPerWeek:counts.pass/weeks,
      reasons:JSON.stringify(reasons),okx:selections.filter(s=>s.venue==='okx').length,
      gate:selections.filter(s=>s.venue==='gate').length});
  }
  const key=r=>[r.setting,r.timeframe,r.market,r.launchAt,r.horizonDays,r.direction,r.path,r.markPath].join('|');
  const current=new Map(rows.filter(r=>r.window==='week').map(r=>[key(r),r]));
  const priorFile=path.join(priorRoot,`runs-${period}.jsonl`),priorReceipt=read(path.join(priorRoot,`complete-${period}.json`));
  if(hash(fs.readFileSync(priorFile))!==priorReceipt.runsSha256)throw Error('Prior evidence binding mismatch');
  let compared=0,admittedCompared=0,mismatches=0;
  for await(const line of readline.createInterface({input:fs.createReadStream(priorFile),crlfDelay:Infinity})){
    if(!line)continue;const p=JSON.parse(line),r=current.get(key(p));if(!r)continue;
    compared++;
    if(p.admitted!==r.admitted||p.reason!==r.reason){mismatches++;continue;}
    if(r.admitted){
      admittedCompared++;
      if(['netReturn','maxDrawdown','fees','funding','fillCount'].some(k=>Math.abs(p[k]-r[k])>1e-12)||
        ['protectiveStop','liquidated','seedHold'].some(k=>p[k]!==r[k]))mismatches++;
    }
  }
  if(compared!==current.size||mismatches)throw Error(`Weekly baseline reconciliation failed: ${period}`);
  reconciliations.push({period,priorPath:priorFile,priorSha256:priorReceipt.runsSha256,compared,admittedCompared,mismatches});
}
writeCsv(path.join(handback,'ENTRY-FILTERS-ALL-RESULTS.csv'),results);
writeCsv(path.join(handback,'ENTRY-FILTERS-REJECTIONS.csv'),rejections);
writeCsv(path.join(handback,'ENTRY-FILTERS-SIGNALS.csv'),signalStats);
writeCsv(path.join(handback,'ENTRY-FILTERS-CANDIDATES.csv'),candidateRows);
fs.writeFileSync(path.join(root,'baseline-reconciliation.json'),JSON.stringify({results:reconciliations},null,2)+'\n');
fs.writeFileSync(path.join(root,'confirmation.json'),JSON.stringify(confirmations,null,2)+'\n');
fs.writeFileSync(path.join(root,'tally.json'),JSON.stringify(periods,null,2)+'\n');
const total=Object.values(periods).reduce((s,p)=>s+p.admitted,0),rejected=Object.values(periods).reduce((s,p)=>s+p.rejected,0),
  memberships=Object.values(periods).reduce((s,p)=>s+p.memberships,0);
const pct=x=>x===null||x===undefined?'unavailable':(100*x).toFixed(2)+'%',num=x=>x===null?'unavailable':Number(x).toFixed(2);
const pick=(period,window,arm,setting='b100-L1',timeframe='1h')=>results.find(r=>r.period===period&&r.window===window&&r.arm===arm&&r.setting===setting&&r.timeframe===timeframe&&r.dimension==='all');
const confirmed=lock.selected&&confirmations.evaluation.passed&&confirmations.proxy.passed;
const answer=confirmed
  ?`The locked ${lock.selected.rule} configuration met the preregistered checks in development and both confirmation periods, but these reused historical samples do not establish reliably profitable future trading. Its fee, leverage and observed signal frequency are reported below; fresh forward evidence is still needed.`
  :'None of the nine preregistered rules established reliably profitable grid trading at a validated fee and leverage, so there is no confirmed signal frequency to promise users. Present grids as a conditional range-trading tool with explicit fees, stops and drawdown risk, rather than a finder-backed income claim.';
const text=[`# Entry-filter backtest\n\n${answer}\n\nUnique ADMITTED simulations: **${total.toLocaleString('en-US')}**. Rejected: ${rejected.toLocaleString('en-US')}. Overlapping admitted arm memberships: ${memberships.toLocaleString('en-US')}; these are not additional simulations.\n`,
  `## Fixed design\n\nNine rules, both one-week and one-month shipped ranges, four builder fees (0.10%, 0.05%, 0.02%, zero), 1x/3x leverage, weekly launches, 14/30-day horizons, long/short alternatives and four trade/mark path combinations. Step-back, 10 intervals, seed on, shipped touch stop, 1000 starting equity, observed funding, frozen current maintenance constraints and liquidation/backstop. Signals use hourly closed OKX-first/Gate-fallback data; execution uses 1h and 4h. Full descriptions and exact thresholds: [preregistration](PREREGISTRATION.md).\n\nSignals and the bot's execution range are separate: a 28-day signal can admit either a one-week or one-month bot. R1 counts two boundary visits at least 24 hours apart on EACH side and requires a return to the middle 40–60%. R2 tests the subsequent 14 days against a band frozen from the earlier 14 days. R3 excludes the bottom volatility quintile while retaining ADX<20; R4 requires variance ratio <=0.8; R5 uses a flat 28-day return; R6 requires transitional ADX and a quiet 7-day return; R7 isolates middle entry; R8/R9 are fixed conjunctions. No post-result threshold changes.\n`,
  `## Development decision\n\nPreregistration commitHash: ${lock.preregistrationCommitHash}. Preregistration SHA-256: ${lock.preregistrationSha256}. Lock written at ${lock.createdAt}, before either confirmation run. Selected configuration: **${lock.selected?JSON.stringify(lock.selected):'no qualifying filter'}**. There were ${lock.candidates.filter(c=>c.qualifies).length} passing configurations among the fixed 144. Selection required coverage, positive mean/median, majority profitability, same-week baseline improvement without higher mean drawdown, and positive results across both sides/horizons/trade paths and a majority of markets.\n\n| Rule | Passing development configurations / 16 | Confirmed in both periods |\n| --- | ---: | --- |\n`,
  ...RULES.map(rule=>`| ${rule} | ${lock.candidates.filter(c=>c.rule===rule&&c.qualifies).length} | ${lock.selected?.rule===rule?(confirmed?'yes':'no'):'not selected; descriptive only'} |\n`),
  '\n## Primary comparisons: builder 0.10%, leverage 1x, hourly execution\n\nReturns and drawdowns are percentages of starting equity / peak equity respectively. BLIND_MEASURABLE and each rule use the same signal-data requirement. “Same-week blind” includes all measurable markets on weeks where that rule has an admitted bot; it does not condition on future performance. The CSV additionally provides its median, profitability, stops and drawdown. Signal/admitted frequency divides unique market launches by the complete calendar, including zero-signal weeks.\n'];
for(const period of ['development','evaluation','proxy'])for(const window of ['week','month']){
  text.push(`\n### ${period}: ${window} range\n\n| Rule | Admitted | Mean | Median | Profitable | Stops | Mean / worst DD | Same-week blind mean | Signal / admitted per week | Weeks |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`);
  for(const arm of arms){
    const r=pick(period,window,arm);
    text.push(`| ${arm} | ${r.runs} | ${pct(r.mean)} | ${pct(r.median)} | ${pct(r.profitable)} | ${pct(r.stopRate)} | ${pct(r.meanDrawdown)} / ${pct(r.worstDrawdown)} | ${pct(r.blindMean)} | ${num(r.selectedPerWeek)} / ${num(r.admittedPerWeek)} | ${r.weeks} |\n`);
  }
}
text.push('\n## All fees, leverage, years and regimes\n\n[Every result](ENTRY-FILTERS-ALL-RESULTS.csv) includes every rule and BLIND for all fees/leverage/ranges, both execution timeframes, year (2022–2026), regime, market, direction, horizon, trade path and mark path. Empty cells mean unavailable evidence, never zero return. [Candidate checks](ENTRY-FILTERS-CANDIDATES.csv) give development-pass and locked confirmation status per configuration. [Signal counts](ENTRY-FILTERS-SIGNALS.csv) separate rejected conditions from missing signal history. [Execution rejection counts](ENTRY-FILTERS-REJECTIONS.csv) count each attempted scenario once.\n');
text.push('\n## What the results mean\n\nAll 144 development configurations failed the fixed minimum of 20 admitted signal weeks; the most any rule had was 17. This is partly an underpowered experiment, not proof that every possible entry rule fails. Development BLIND had 30 admitted hourly weeks for the weekly range, whereas the filters removed most opportunities. In evaluation, no rule retained more than nine admitted weeks. None can be promoted from the descriptive confirmation tables.\n\n');
text.push('The owner’s repeated-touch/middle-entry rule (R1) had weekly-range means of +0.19%, +1.25% and -0.64% in development, Pacifica evaluation and proxy respectively at 0.10% builder fees and 1x. Its same-week measurable BLIND means were +0.03%, +0.13% and -0.52%. Development had only seven admitted signal weeks and 50% profitable scenarios; evaluation had six. Its proxy result was negative in every calendar year and every pre-launch regime, including the ranging regime. With the monthly range it lost on average in all three periods. Lower fees did not rescue it: zero-fee proxy means were -0.41% weekly and -0.72% monthly at 1x, and -1.24% / -2.17% at 3x. These are per-bot horizon returns, not annualized or portfolio returns.\n\n');
text.push('R1 generated 0.42, 0.56 and 0.21 raw market signals per calendar week in development, evaluation and proxy, across the frozen five-, five- and three-market universes respectively: roughly one signal every 2.4, 1.8 and 4.7 weeks. After execution-data and risk admission, weekly-range 1x launches averaged 0.33, 0.19 and 0.16 per week. Those are historical opportunity counts, not a validated profitable-signal frequency or a projection for the full platform.\n\n');
text.push('The not-squeezed filter (R3) supplied the only positive-mean proxy configurations: 10 of the 144. At 0.10% / 1x it returned +0.36% for the weekly range and +0.19% for the monthly range, but had only 16 admitted proxy weeks, negative development means, and no admitted evaluation outcomes. The weekly proxy result also underperformed its same-week BLIND (+0.37%). It remains a descriptive observation, not a replacement winner. Month ranges generally reduced stops while leaving larger drawdowns; 3x magnified losses and drawdowns without establishing a valid rule. The earlier low-ADX breakout explanation is not established by these comparisons.\n\n');
text.push('### R1 by proxy year and pre-launch regime, weekly range, 0.10% / 1x\n\n| Split | Mean | Same-week BLIND | Stops | Admitted weeks |\n| --- | ---: | ---: | ---: | ---: |\n');
for(const r of results.filter(r=>r.period==='proxy'&&r.window==='week'&&r.setting==='b100-L1'&&r.timeframe==='1h'&&r.arm==='R1_ESTABLISHED'&&['year','regime'].includes(r.dimension)))
  text.push(`| ${r.value} | ${pct(r.mean)} | ${pct(r.blindMean)} | ${pct(r.stopRate)} | ${r.weeks} |\n`);
text.push('\nEvery other rule’s year/regime results, both leverage levels and every same-week BLIND metric are in the CSV; these descriptive splits never change selection. Signal-count CSV rows use the union of the two execution calendars, while the report tables and frequencies above use the primary hourly calendar. R8 had no admitted development or evaluation outcomes, and R6 and R3 also had none in evaluation; unavailable outcomes are not zero returns.\n');
text.push('\n### Fee sensitivity, 1x and hourly execution (mean return)\n\n| Period / range / rule | 0.10% | 0.05% | 0.02% | Zero |\n| --- | ---: | ---: | ---: | ---: |\n');
for(const period of ['development','evaluation','proxy'])for(const window of ['week','month'])for(const arm of ['BLIND',...RULES])
  text.push(`| ${period} / ${window} / ${arm} | ${SETTINGS.filter(s=>s.leverage===1).map(s=>pct(pick(period,window,arm,s.id).mean)).join(' | ')} |\n`);
text.push('\n## Coverage and interpretation\n\n| Period | Unique admitted | Rejected | Rejection reasons |\n| --- | ---: | ---: | --- |\n');
for(const [period,t]of Object.entries(periods))text.push(`| ${period} | ${t.admitted} | ${t.rejected} | ${Object.entries(t.rejections).map(([k,v])=>`${k}: ${v}`).join('; ')} |\n`);
text.push(`\nThe one-week BLIND baseline reconciled against the existing finder evidence: ${reconciliations.reduce((s,r)=>s+r.compared,0)} attempted scenarios, ${reconciliations.reduce((s,r)=>s+r.admittedCompared,0)} admitted outcomes, zero mismatches in admission/reason, return, drawdown, fees, funding, fills, stops, liquidation or seed holds. This verifies the fee/leverage subset against existing raw receipts, rather than relying on the brief's rounded claims.\n\n`);
text.push('Important limits: complete funding/mark/candle history excludes many overlapping scheduled horizons and can leave only a few evaluation weeks. This coverage cannot be repaired by counting paths, sides, horizons or fee scenarios as independent trials. New rules were fixed before this job’s results, but earlier research already inspected these historical periods; they are not fresh forward validation. The 144-way development search can overfit. Long and short are separate alternatives, not a funded hedged portfolio. No capital-constrained concurrency or compounding is modeled. Trades assume full fills and continuous protective execution; queue position, latency, outages, final liquidation of open inventory and its exit costs are omitted. Net inventory is marked at the horizon. Current constraints/max leverage substitute for unknown historical schedules. Proxy execution uses OKX prices/funding and trade prices as marks with Pacifica constraints, not historical Pacifica executions. Intrabar paths are sensitivities, not guaranteed bounds. The requested builder fees are scenarios, not a live billing assertion.\n\n');
text.push('The owner’s successful grids describe a plausible point-in-time pattern; this study tests it as a fixed rule. The earlier “bots that stayed inside the range” group is selected using future behavior and cannot be treated as an entry signal. The claim that low ADX selects imminent breakouts remains a hypothesis: higher stops alone do not establish that causal explanation.\n\n');
text.push('## Evidence and review\n\nFrozen input SHA-256 checks, per-run records, selections, development lock, confirmation checks and baseline reconciliation are in the evidence root. [Review and tests](REVIEW-REPORT.md) records focused FRACTAL results and static review. [Snapshot scan](REVIEW-SCAN-STATUS.md) controls whether a formal seal is possible. No independent Opus/Kimi approval, production integration, push or merge is claimed. The authorized fallback bundle and INSTALL-FILTERS.ps1 target only this research worktree and branch.\n');
fs.writeFileSync(path.join(handback,'ENTRY-FILTERS-REPORT.md'),text.join(''),'utf8');
fs.writeFileSync(path.join(handback,'ADMITTED-TALLY.txt'),`${total} admitted unique simulations\n`,'utf8');
fs.writeFileSync(path.join(root,'report-summary.json'),JSON.stringify({total,rejected,memberships,selected:lock.selected,
  confirmed:!!confirmed,periods,confirmation:confirmations},null,2)+'\n');
console.log(JSON.stringify({admitted:total,rejected,selected:lock.selected,confirmed:!!confirmed,resultsRows:results.length,
  reconciled:reconciliations.reduce((s,r)=>s+r.admittedCompared,0)}));
