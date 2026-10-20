import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {ARMS,SETTINGS,summary} from './core.mjs';
import {sha256} from '../grid-backtest-r2/data.mjs';
const root=process.argv[2], handback=path.resolve(root,'../..');
const groups=new Map(), rejectionGroups=new Map(), opportunities=new Map(), diagnostics=new Map();
let uniqueAdmitted=0, rejected=0, memberships=0;
const get=(map,key,init) => {if(!map.has(key))map.set(key,init());return map.get(key);};
const dimensions=r => [['all','all'],['timeframe',r.timeframe],['year',String(r.year)],['regime',r.regime],
  ['year_regime',`${r.year}:${r.regime}`],['market',r.market],['direction',r.direction],
  ['horizon',String(r.horizonDays)],['tradePath',r.path],['markPath',r.markPath]];
for (const period of ['development','evaluation','proxy']) {
  const complete=JSON.parse(fs.readFileSync(path.join(root,`complete-${period}.json`),'utf8'));
  const runFile=path.join(root,`runs-${period}.jsonl`);
  if(sha256(fs.readFileSync(runFile)) !== complete.runsSha256) throw Error('Result SHA-256 mismatch');
  for await (const line of readline.createInterface({input:fs.createReadStream(runFile),crlfDelay:Infinity})) {
    const r=JSON.parse(line), dims=dimensions(r);
    if(r.admitted){uniqueAdmitted++; memberships+=r.arms.length;}else rejected++;
    const slim={admitted:r.admitted,netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,protectiveStop:r.protectiveStop,
      liquidated:r.liquidated,seedHold:r.seedHold,launchAt:r.launchAt,market:r.market,timeframe:r.timeframe};
    for (const [dimension,value] of dims) {
      const prefix=[period,r.setting,dimension,value].join('|');
      const opportunity=get(opportunities,prefix,()=>({weeks:new Set(),markets:new Set()}));
      opportunity.weeks.add(r.launchAt); opportunity.markets.add(`${r.launchAt}|${r.market}|${r.timeframe}`);
      for (const arm of [...r.arms,...(r.selectionState !== 'unavailable' ? ['MEASURABLE_BLIND'] : [])]) {
        const key=[prefix,arm].join('|'),g=get(groups,key,()=>({rows:[],selected:new Set(),selectedWeeks:new Set(),rejected:0}));
        g.selected.add(`${r.launchAt}|${r.market}|${r.timeframe}`);g.selectedWeeks.add(r.launchAt);
        if(r.admitted)g.rows.push(slim);else g.rejected++;
      }
    }
    if(!r.admitted) for(const arm of r.arms){
      const key=[period,r.setting,arm,r.reason].join('|');rejectionGroups.set(key,(rejectionGroups.get(key)??0)+1);
    }
    const dk=[period,r.timeframe,r.setting].join('|'),d=get(diagnostics,dk,()=>({attempted:0,admitted:0,reasons:{},states:{}}));
    d.attempted++;if(r.admitted)d.admitted++;else d.reasons[r.reason]=(d.reasons[r.reason]??0)+1;
    d.states[r.selectionState]=(d.states[r.selectionState]??0)+1;
  }
}
const rows=[];
// Include zero-run cells rather than silently dropping a filter that never fires.
for(const [prefix,o] of opportunities)for(const arm of [...ARMS,'MEASURABLE_BLIND']){
  const g=groups.get(prefix+'|'+arm)??{rows:[],selected:new Set(),selectedWeeks:new Set(),rejected:0};
  const [period,setting,dimension,value]=prefix.split('|'),s=SETTINGS.find(s=>s.id===setting);
  const stats=summary(g.rows);
  rows.push({period,setting,builderPercent:s.builderRate*100,leverage:s.leverage,arm,dimension,value,...stats,
    selectedLaunches:g.selected.size,selectedWeeks:g.selectedWeeks.size,calendarWeeks:o.weeks.size,
    eligibleLaunches:o.markets.size,selectedPerWeek:g.selected.size/o.weeks.size,
    admittedPerWeek:stats.admittedLaunches/o.weeks.size,
    selectionRetention:g.selected.size/o.markets.size,admissionRetention:stats.admittedLaunches/o.markets.size,
    rejected:g.rejected});
}
const esc=v=>v===null||v===undefined?'':/[",\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v);
function csv(file,rs) {const keys=Object.keys(rs[0]??{});fs.writeFileSync(path.join(handback,file),[keys.join(','),...rs.map(r=>keys.map(k=>esc(r[k])).join(','))].join('\n')+'\n');}
csv('FINDER-ALL-RESULTS.csv',rows);
csv('FINDER-REJECTIONS.csv',[...rejectionGroups].map(([key,count])=>{const [period,setting,arm,...reason]=key.split('|');return {period,setting,arm,reason:reason.join('|'),count};}));
const selectorRows=[];
for(const period of ['development','evaluation','proxy']){
  const selections=JSON.parse(fs.readFileSync(path.join(root,`selections-${period}.json`),'utf8'));
  for(const r of selections)selectorRows.push({...r,launchUTC:new Date(r.launchAt).toISOString()});
}
csv('FINDER-SELECTIONS.csv',selectorRows);
fs.writeFileSync(path.join(root,'report-summary.json'),JSON.stringify({uniqueAdmitted,rejected,overlappingArmMemberships:memberships,
  diagnostics:Object.fromEntries(diagnostics),rows:rows.filter(r=>r.dimension==='all'||r.dimension==='timeframe')},null,2)+'\n');
const pct=v=>v===null?'—':(100*v).toFixed(2)+'%', num=v=>v===null?'—':Number(v).toFixed(2);
const pick=(period,arm,setting='b100-L1',tf='1h')=>rows.find(r=>r.period===period&&r.arm===arm&&r.setting===setting&&r.dimension==='timeframe'&&r.value===tf);
const lock=JSON.parse(fs.readFileSync(path.join(root,'development-lock.json'),'utf8'));
const main=[];
main.push('# Finder-conditioned grid backtest\n');
if(lock.selected!=='no qualifying filter')throw Error('A selected filter requires explicit registered confirmation assessment before the report is published');
main.push('Starting where the shipped finder says “ranging” did not turn grid bots into reliably winning bots at any fee or leverage established by this study. A reliable claim would need a filter that passes development first, fuller funding history, and a fresh forward test with fees and leverage fixed in advance.\n');
main.push(`Unique ADMITTED simulations for the tally: **${uniqueAdmitted.toLocaleString('en-US')}**. Rejected simulations: ${rejected.toLocaleString('en-US')}. Overlapping memberships across BLIND/FINDER/TOP1/TOP2/AGAINST: ${memberships.toLocaleString('en-US')}; do not add those to the tally. Fees, leverage, sides, horizons and intrabar paths are repeated modeling scenarios, not independent live bots.\n`);
main.push('## What was tested\n');
main.push('Actual shipped qualification: exactly 100 closed candles, available structural range, ADX(14) below 20; ascending unrounded ADX then symbol. Finder inputs use frozen OKX first, Gate only when needed. Pacifica candles cannot pass the shipped finder source guard. Selecting a result changes the market, not the bot range. [Exact file-and-line inventory](FINDER-INVENTORY.md).\n');
main.push('The default 1h timeframe is primary; 4h and pooled results are in the complete CSV. Weekly Sunday launches, fixed one-week bot range, shipped touch stop, 10 intervals, step_back, seed on, 1,000 initial equity, both long/short trials, 14/30-day horizons. Long and short results are separate alternatives, not a combined hedged portfolio. BLIND is the same round-2 weekly step_back setting rerun on this calendar. TOP1/TOP2 choose only from qualifying candidates and never backfill a rejected launch.\n');
main.push('Every fee cell adds the builder fee to Tier-1 maker 0.015% / taker 0.040%; the 0.10% builder scenario was requested by the owner, not verified as live billing. All cells include round-2 funding, mark, liquidation/backstop and shipped stop-clearance admission. Current frozen maximum leverage determines maintenance; historical tiers are unknown. Four equal-duration linear trade/mark path combinations are sensitivities, not guaranteed bounds. Full fills and continuous protective execution are assumptions; final inventory remains marked, and latency, queue position, outages and final exit costs are omitted.\n');
main.push('Pacifica development ends before 2026-03-01; evaluation runs from that date to 2026-10-19 exclusive. BTC/ETH/SOL/HYPE/ZEC enter direct research only after history exists. Proxy confirmation covers BTC/ETH/SOL in 2022–2025, including the full proxy calendar after Pacifica inception; these are OKX perpetual prices and funding with Pacifica frozen trading constraints, not actual historical Pacifica executions. Gate remains an allowed fallback, and its actual use is disclosed below.\n');
main.push(`## Development lock\n\nRegistered commitHash: ${lock.preregistrationCommitHash}. Registration SHA-256: ${lock.preregistrationSha256}. Development choice: **${lock.selected}**. The lock was saved before either confirmation run. Filters needed at least 20 weeks, 20% launch retention, positive mean, >50% profitable, better mean/no worse mean drawdown than measurable BLIND, and positive results across a majority of markets and both trade paths. Other fee/leverage cells are descriptive and cannot be promoted to a winner after seeing confirmation.\n`);
main.push('| Development filter, 0.10% builder / 1x / 1h | Runs | Mean | Profitable | Weeks | Admission retention vs BLIND | Qualified |\n|---|---:|---:|---:|---:|---:|---|');
for(const c of lock.candidates)main.push(`| ${c.arm} | ${c.runs} | ${pct(c.mean)} | ${pct(c.profitable)} | ${c.weeks} | ${pct(c.retention)} | ${c.qualifies?'yes':'no'} |`);
main.push('\n## Primary comparison at the requested 0.10% builder fee and 1x\n');
main.push('| Period | Arm | Admitted | Mean | Median | Profitable | Stops | Mean / worst DD | Selected / admitted launches per week |\n|---|---|---:|---:|---:|---:|---:|---:|---:|');
for(const period of ['development','evaluation','proxy'])for(const arm of ARMS){const r=pick(period,arm);main.push(`| ${period} | ${arm} | ${r.runs} | ${pct(r.mean)} | ${pct(r.median)} | ${pct(r.profitable)} | ${pct(r.stopRate)} | ${pct(r.meanDrawdown)} / ${pct(r.worstDrawdown)} | ${num(r.selectedPerWeek)} / ${num(r.admittedPerWeek)} |`);}
main.push('\n## Every fee and leverage, primary 1h\n\nReturns are percentages of starting equity; drawdowns measure the fall from each run’s peak equity. The complete CSV adds liquidation rates, idle seed holds, calendar coverage, week-cluster intervals, market/side/horizon/path, 4h and pooled breakdowns. A zero-run cell is unavailable evidence, not a zero return.\n');
for(const period of ['development','evaluation','proxy']){
  main.push(`### ${period}\n\n| Builder % | Leverage | Arm | Admitted | Mean % | Median % | Profitable % | Stop % | Mean DD % | Worst DD % | Selected / admitted per week |\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for(const s of SETTINGS)for(const arm of ARMS){const r=pick(period,arm,s.id);const p=v=>v===null?'—':num(v*100);main.push(`| ${num(s.builderRate*100)} | ${s.leverage}x | ${arm} | ${r.runs} | ${p(r.mean)} | ${p(r.median)} | ${p(r.profitable)} | ${p(r.stopRate)} | ${p(r.meanDrawdown)} | ${p(r.worstDrawdown)} | ${num(r.selectedPerWeek)} / ${num(r.admittedPerWeek)} |`);}
}
main.push('\n## Regime and year\n\nThe descriptive regime uses the pre-launch 30-day return (>10% up, <-10% down, otherwise ranging); it is not the ADX finder label or a hindsight inside-range group. Every arm/fee/leverage is broken down by regime, year and year×regime in [FINDER-ALL-RESULTS.csv](FINDER-ALL-RESULTS.csv). The following pooled-timeframe rows show the requested 0.10% / 1x comparison.\n');
main.push('| Period | Breakdown | Arm | Admitted | Mean | Profitable | Mean / worst DD |\n|---|---|---|---:|---:|---:|---:|');
for(const r of rows.filter(r=>r.setting==='b100-L1'&&['regime','year'].includes(r.dimension)&&['BLIND','FINDER','AGAINST'].includes(r.arm)))
  main.push(`| ${r.period} | ${r.dimension}: ${r.value} | ${r.arm} | ${r.runs} | ${pct(r.mean)} | ${pct(r.profitable)} | ${pct(r.meanDrawdown)} / ${pct(r.worstDrawdown)} |`);
main.push('\n## Coverage, missing data and rejections\n');
main.push('Selected launches/week counts unique market/timeframe opportunities across all calendar weeks, including weeks when the filter selects nothing. Admitted launches/week requires at least one admitted direction/horizon/path at that fee/leverage; it does not imply every selected configuration can launch. The primary tables use 1h only. Pooled counts treat each market/timeframe as a separate opportunity. All return totals exclude rejected simulations; exact per-arm reasons and counts are in [FINDER-REJECTIONS.csv](FINDER-REJECTIONS.csv).\n');
main.push('| Period | 1h finder observations | Ranging | Not ranging | Unavailable | Source use |\n|---|---:|---:|---:|---:|---|');
for(const period of ['development','evaluation','proxy']){
  const a=selectorRows.filter(r=>r.period===period&&r.timeframe==='1h'),sources={};
  for(const r of a)sources[r.venue??'none']=(sources[r.venue??'none']??0)+1;
  main.push(`| ${period} | ${a.length} | ${a.filter(r=>r.state==='ranging').length} | ${a.filter(r=>r.state==='not-ranging').length} | ${a.filter(r=>r.state==='unavailable').length} | ${Object.entries(sources).map(([k,v])=>`${k}: ${v}`).join('; ')} |`);
}
main.push('\n| Period, all fees/leverage/timeframes | Unique admitted | Rejected | Exact first rejection reasons |\n|---|---:|---:|---|');
for(const period of ['development','evaluation','proxy']){
  const m=JSON.parse(fs.readFileSync(path.join(root,`complete-${period}.json`),'utf8'));
  main.push(`| ${period} | ${m.admitted} | ${m.attempted-m.admitted} | ${Object.entries(m.rejectionCounts).map(([k,v])=>`${k}: ${v}`).join('; ')} |`);
}
main.push('\nFunding is required for the entire scheduled horizon, including later hours after a bot would have stopped; this preserves round-2 admission but sharply reduces coverage and can bias the sample. Missing funding is never free funding. Finder-unavailable markets remain in BLIND but do not enter AGAINST; MEASURABLE_BLIND CSV rows expose that distinction. The frozen universe has at most five markets; current live pagination, deadlines and all-market rankings cannot be reconstructed from it.\n');
main.push('## Evidence and validation\n\n[Preregistration](PREREGISTRATION.md), [full results](FINDER-ALL-RESULTS.csv), [point-in-time selections](FINDER-SELECTIONS.csv), [rejections](FINDER-REJECTIONS.csv), [review and tests](REVIEW-REPORT.md), [scan status](REVIEW-SCAN-STATUS.md). Raw per-simulation records, verified data bindings and the development lock are retained under the evidence directory. Round-2 code was copied byte-for-byte from C:/Apps/Replit/conductor-worktrees/grid-backtest-r2-20261020/scripts/research/grid-backtest-r2; the exact copied paths and SHA-256 bindings are in reused-source-bindings.json. No production files, scanner, package files, databases or shared source snapshots were changed.\n');
main.push('The scan and independent review status control whether this handback may be sealed; numerical completion alone is not gate acceptance. Install only into the named research branch/worktree using INSTALL-FINDER.ps1. Never merge or push this research branch.\n');
fs.writeFileSync(path.join(handback,'FINDER-BACKTEST-REPORT.md'),main.join('\n')+'\n');
fs.writeFileSync(path.join(handback,'ADMITTED-TALLY.txt'),`${uniqueAdmitted} admitted simulations\n`);
fs.copyFileSync('scripts/research/grid-finder/FINDER-INVENTORY.md',path.join(handback,'FINDER-INVENTORY.md'));
console.log(JSON.stringify({uniqueAdmitted,rejected,overlappingArmMemberships:memberships,aggregateRows:rows.length,selection:lock.selected,
 primary:['development','evaluation','proxy'].map(period=>({period,blind:pick(period,'BLIND').mean,finder:pick(period,'FINDER').mean,
 finderRuns:pick(period,'FINDER').runs,finderWeeks:pick(period,'FINDER').weeks}))}));
