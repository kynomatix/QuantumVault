import fs from 'node:fs';
import path from 'node:path';
import {read,sha256} from './data.mjs';
const root=process.argv[2],handback=path.resolve(root,'../..'),partial=process.argv.includes('--phase-b');
const registered=phase=>path.join(root,phase+(fs.existsSync(path.join(root,phase+'-registered-summary.json'))?'-registered-summary.json':'-summary.json'));
const b=read(registered('phase-b')),bs=read(path.join(root,'phase-b-selection.json'));
const pct=v=>Number.isFinite(v)?(100*v).toFixed(2)+'%':'—',num=v=>Number.isFinite(v)?v.toFixed(2):'—';
const sum=(rows,key)=>rows.reduce((s,r)=>s+(r[key]??0),0);
const aggregate=(rows)=>{const a={};for(const r of rows)for(const [k,v] of Object.entries(r))if(typeof v==='number')a[k]=(a[k]??0)+v;return a;};
const all=(s,id)=>aggregate(s.summaries.filter(r=>r.setting===id&&r.dimension==='all'));
const table=(heads,rows)=>'| '+heads.join(' | ')+' |\n| '+heads.map(()=>'---').join(' | ')+' |\n'+rows.map(r=>'| '+r.join(' | ')+' |').join('\n')+'\n';
const mean=(r,k)=>r.n?r[k]/r.n:NaN;
const csv=(name,rows)=>{
 if(!rows.length)return;
 const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))],q=v=>'"'+String(typeof v==='object'?JSON.stringify(v):v??'').replaceAll('"','""')+'"';
 fs.writeFileSync(path.join(handback,name),keys.map(q).join(',')+'\n'+rows.map(r=>keys.map(k=>q(r[k])).join(',')).join('\n')+'\n');
};
const normalized=rows=>rows.map(r=>({...r,meanNetReturn:mean(r,'netReturn'),meanDrawdown:mean(r,'maxDrawdown'),meanFees:mean(r,'fees'),meanFills:mean(r,'fillCount'),stopRate:mean(r,'stops')}));
csv('PHASE-B-ALL-RESULTS.csv',normalized(b.summaries));csv('PHASE-B-REJECTIONS.csv',b.rejections);csv('PHASE-B-CLOSE-PAIRS.csv',b.closePairs);
const groups=b.summaries.filter(r=>r.dimension==='all');
const funded=fs.existsSync(path.join(root,'phase-b-mark-held-summary.json'))?read(path.join(root,'phase-b-mark-held-summary.json')):null;
let report='The weekly range with step-back beats the shipped repeat-all setting across the three declared market regimes, but that improvement does not make the average run profitable at the modelled maximum builder fee. Wider stops, more lines and leverage must earn their place through the comparisons below; none should be treated as a live trading recommendation.\n\n';
report+='Research only. No production changes, merge or push. Weekly fresh launches, 14/30-day horizons, BTC/ETH/SOL/HYPE/ZEC where listed, both directions and both OHLC paths. These overlap and are **not independent samples**; percentages are scenario averages, not compounded portfolio returns or statistical confidence intervals. Proxy coverage begins January 2022; direct Pacifica data continues through 19 October 2026 (exclusive). A market is never backfilled before its listing. Detailed rows include 2022, 2023, 2024, 2025 and 2026, regime, market, source and timeframe. See [all Phase B results](PHASE-B-ALL-RESULTS.csv) and [exact rejection inventory](PHASE-B-REJECTIONS.csv).\n\n';
report+='Precondition: the 6/14/30-interval research adapter used requested range endpoints even when Decimal rounding put the last generated line one tick lower. The research adapter now signs actual first/last line prices; canonical product validation is untouched. All six interval counts passed the admission check with zero canonical failures: [admission table](PHASE-A-ADMISSION.md). The earlier line-count conclusion is withdrawn.\n\n';
report+='Population audit: the original proxy loader also included a short pre-Pacifica HYPE segment. Final comparisons exclude HYPE/ZEC proxy launches to honor the preregistration; original rows and exclusion counts remain available. Direct development selections are unchanged. The admission prerequisite covered a broader population and still established zero canonical failures. Phases B and the unleveraged movement/line/fee comparisons exclude funding, consistently with round one; leverage, direction and the funded held-profit diagnostic include observed funding.\n\n';
report+='1. Stopped, then came back. Stop multiples widen the buffer outside the range edge, not the entire entry-to-stop distance. Follow-up excludes the stopping candle, uses its timestamp as the hourly/four-hourly reference, and censors incomplete 3/7-day windows. This is descriptive only. Funded held profit freezes the inventory immediately before stopping and pays observed funding plus hypothetical exit costs through the scheduled horizon; it does not keep running the grid. Missing funding is unknown. Counts pool the two paths and both horizons.\n\n';
report+='The held-profit counterfactual does not impose liquidation; it measures the specified frozen-inventory outcome, not whether that position could actually survive until the horizon. The leverage section separately models liquidation. Three/seven-day recovery uses candle-resolution windows, which can end up to one candle earlier than the true touch time.\n\n';
const settings=read(path.join(root,'phase-b-method.json')).settings;
report+=table(['Setting: window / stop multiple / mode / trigger','Stopped','Back in 3d','Back in 7d','3d / 7d eligible','Funded held profit / known','Funding unknown'],settings.map(s=>{
 const a=aggregate(groups.filter(r=>r.setting===s.id)),h=funded?aggregate(funded.held.filter(r=>r.setting===s.id&&r.dimension==='all')):null;
 return [s.id,a.stops,pct(a.back3/a.follow3),pct(a.back7/a.follow7),`${a.follow3} / ${a.follow7}`,h?`${pct(h.profitable/h.n)} / ${h.n??0}`:'Pending funded replay',h?.unknown??'—'];
}));
if(funded){
 const a=aggregate(groups.filter(r=>r.setting==='week-1-step_back-touch')),h=aggregate(funded.held.filter(r=>r.setting==='week-1-step_back-touch'&&r.dimension==='all'));
 report+=`\nFor the weekly step-back arm at the shipped stop, ${pct(a.back3/a.follow3)} returned inside the range within three days and ${pct(a.back7/a.follow7)} within seven days among complete follow-ups. Only ${pct(h.profitable/h.n)} of the ${h.n} funding-complete stopped scenarios finished profitable in the frozen-inventory counterfactual; ${h.unknown} others have unknown funded outcomes. Coming back into the range is much more common than recovering all costs.\n`;
}
report+='\n2. Completed-close stops. One-hour closes run only on hourly strategies; four-hour close uses completed UTC boundaries. Fills occur at the next contiguous bar open with 0.05% adverse slippage. A close without an available next open is censored. A genuine breakdown here means a stopped touch run with complete seven-day follow-up and no return into the original range. Extra loss is relative to the paired touch arm, in equity percentage points; worst cases matter more than the mean alone.\n\n';
const closeDetail=fs.existsSync(path.join(root,'phase-b-close-pair-detail.json'))?read(path.join(root,'phase-b-close-pair-detail.json')).rows:null;
if(closeDetail)csv('CLOSE-PAIRS-ALL-REGIMES-YEARS.csv',closeDetail);
report+=table(['Close setting','Paired runs','Hunts certainly avoided / same-candle uncertain / hunts','Mean return change, pp','Breakdowns','Mean extra breakdown loss, pp','Worst extra loss, pp'],settings.filter(s=>s.stopMode!=='touch').map(s=>{
 const rows=closeDetail?closeDetail.filter(r=>r.setting===s.id&&r.dimension==='all'):b.closePairs.filter(r=>r.setting===s.id),a=aggregate(rows);
 return [s.id,a.n,closeDetail?`${a.huntsAvoidedCertain}/${a.sameReturnCandleAmbiguous}/${a.touchHunts}`:`${a.huntsAvoided} estimated / ${a.touchHunts}`,num(100*a.delta/a.n),a.breakdowns,num(100*a.extraLoss/a.breakdowns),num(100*Math.max(...rows.map(r=>r.worstExtraLoss)))];
}));
report+='\nA return and stop in the same candle have uncertain ordering; the certain count excludes them. Extra breakdown loss is the final net-equity difference, including inventory still open at the scheduled horizon. [Every close comparison by regime and year](CLOSE-PAIRS-ALL-REGIMES-YEARS.csv).\n';
if(closeDetail){
 const rows=closeDetail.filter(r=>r.setting==='week-1-step_back-4h-close'&&r.dimension==='all'),a=aggregate(rows);
 report+=`\nThe weekly four-hour-close arm certainly avoided ${a.huntsAvoidedCertain} of ${a.touchHunts} observed touch-and-return cases, with ${a.sameReturnCandleAmbiguous} more ambiguous within one candle. Its matched mean return changed by ${num(100*a.delta/a.n)} percentage points, and its worst extra breakdown loss was ${num(100*Math.max(...rows.map(r=>r.worstExtraLoss)))} percentage points of starting equity. Avoiding a hunt did not establish a better default.\n`;
}
report+='\n3. Day, week or month: **week remains the default research choice**. Month improves the later-period mean but takes more drawdown; day has narrower opportunity and lower admission coverage. The choice is based on matched scenarios and regime checks, not on whichever raw pooled mean looks best.\n\n';
report+=table(['Period','Regime','Window, step-back / shipped stop / touch','Admitted','Mean net return','Mean max drawdown','Stop rate'],['development','evaluation','proxy'].flatMap(period=>['all','trending_up','trending_down','ranging'].flatMap(regime=>['day','week','month'].map(window=>{
 const r=b.summaries.find(r=>r.period===period&&r.setting===`${window}-1-step_back-touch`&&r.dimension===(regime==='all'?'all':'regime')&&r.value===regime);
 return [period,regime,window,r?.n??0,pct(mean(r??{},'netReturn')),pct(mean(r??{},'maxDrawdown')),pct(mean(r??{},'stops'))];
}))));
report+='\n4. Regimes are fixed from pre-launch 30-day close return: above +10% up, below −10% down, otherwise ranging; a missing old close is unknown. The table shows step-back minus shipped repeat-all for the weekly range and shipped stop, in net return percentage points. Positive means better, not necessarily profitable. Every arm’s regime and calendar-year results are in [the complete results table](PHASE-B-ALL-RESULTS.csv).\n\n';
report+=table(['Period','Path','Paired','Trending up, pp','Trending down, pp','Ranging, pp','Mean return gain, pp','Mean drawdown change, pp'],b.comparisons.filter(r=>r.setting==='week-1-step_back-touch').map(r=>[r.period,r.path,r.paired,...['trending_up','trending_down','ranging'].map(k=>num(100*r.regimes[k]?.delta/r.regimes[k]?.n)),num(100*r.delta/r.paired),num(100*r.drawdownDelta/r.paired)]));
if(funded){
 csv('FUNDED-HELD-RESULTS.csv',funded.held);csv('MARK-TRADE-RESULTS.csv',funded.mark);
 report+='\nLive trigger sensitivity. Pacifica stops use mark-price touches; grid fills still use traded prices. These are direct-Pacific a comparisons only (no historical mark proxy), with all four trade/mark OHLC order combinations. They are plausible timing scenarios, not guaranteed bounds on asynchronous ticks. Differences in equity also include the final mark basis. Older proxy candles cannot measure this difference.\n\n'.replace('Pacific a','Pacifica');
 report+=table(['Touch setting','Paired timing scenarios','Traded stop rate','Mark stop rate','Trade-only stops','Mark-only stops','Mean return change, pp','Touch hunts avoided / hunts'],settings.filter(s=>s.stopMode==='touch').map(s=>{
  const a=aggregate(funded.mark.filter(r=>r.setting===s.id&&r.dimension==='all'));
  return [s.id,a.n,pct(a.tradeStops/a.n),pct(a.markStops/a.n),a.tradeOnlyStops,a.markOnlyStops,num(100*a.delta/a.n),`${a.huntsAvoided}/${a.touchHunts}`];
 }));
 report+='\nThe mark-based hunt count uses candle timestamps. Recovery and a second stop within the same candle cannot be ordered exactly, so that count is an estimate; the stop-rate comparison is the more direct measure of trigger bias.\n';
 const a=aggregate(funded.mark.filter(r=>r.dimension==='all'));
 report+=`\nAcross admitted paired timing scenarios, traded-price stops fired ${a.tradeStops>a.markStops?'more':'less'} often than mark stops (${pct(a.tradeStops/a.n)} versus ${pct(a.markStops/a.n)}). The mean mark-model return change was ${num(100*a.delta/a.n)} percentage points. This measures the direction of the bias in this sample; fewer stops are not automatically better on genuine breakdowns.\n`;
 report+='\nThus traded-price touches slightly overstate stop frequency in this sample. The return difference is a model sensitivity, including assumed trade/mark timing and final valuation; it is not a measured live execution improvement.\n';
}
if(partial){fs.writeFileSync(path.join(handback,'PHASE-B-REPORT.md'),report);console.log('Phase B report and CSVs written');process.exit(0);}
const movement=read(path.join(root,'phase-c-movement-summary.json')),lines=read(registered('phase-c-lines')),lineMethod=read(path.join(root,'phase-c-lines-method.json')),correct=read(path.join(root,'phase-c-lines-diagnostics-corrected.json')),risk=read(path.join(root,'phase-c-risk-summary.json')),riskMethod=read(path.join(root,'phase-c-risk-method.json')),direction=read(path.join(root,'phase-d-summary.json'));
for(const [prefix,s] of [['MOVEMENT',movement],['LINES-FEES',lines],['LEVERAGE',risk],['DIRECTION',direction]]){
 csv(prefix+'-ALL-RESULTS.csv',normalized(s.summaries));csv(prefix+'-REJECTIONS.csv',s.rejections);csv(prefix+'-PAIRED.csv',s.comparisons);
}
csv('LEVERAGE-UNSAFE-DIAGNOSTICS.csv',normalized(risk.unsafe.summaries));csv('LINES-PLANNER-DIAGNOSTICS.csv',correct.diagnostics);csv('MOVEMENT-HOLDS.csv',movement.moveHolds);
report+='\n5. Moving the range. Step-back uses a fixed range, unchanged trail-research-1 confirmed-breakout rules, or that same breakout followed by two later completed closes within 0.25 frozen ATR of the old favorable edge, with a band touch, expiring after seven days. Caps, inventory carry and the prohibition on loosening stops remain. Native OKX perpetual candles pass a research-only source adapter for the older period. [All movement regimes/years](MOVEMENT-ALL-RESULTS.csv) and [move hold reasons](MOVEMENT-HOLDS.csv).\n\n';
report+=table(['Setting','Period','Admitted','Mean return','Mean max drawdown','Mean moves','Stop rate'],movement.summaries.filter(r=>r.dimension==='all').map(r=>[r.setting,r.period,r.n,pct(mean(r,'netReturn')),pct(mean(r,'maxDrawdown')),num(mean(r,'moves')),pct(mean(r,'stops'))]));
report+='\nPlain answer: keep the weekly range fixed under these rules. Neither moving-range variant passed development selection. Confirmed moves increased mean drawdown in every period; retest moves were infrequent and their return effect changed sign across periods. This does not support moving the range as a default upgrade.\n';
report+='\n5b. Grid count. “50” means 50 intervals and 51 price levels, not a promise of 25 active orders on each side. Both range windows use the shipped stop, which is also the round-one winning stop. Fees are 0.115% maker / 0.14% taker in this table. Fee rejection precedes the minimum-order gate; the separate zero-maker analytical call measures minimum-only feasibility and never supplies performance. Counts include both paths/horizons. [All regime/year results](LINES-FEES-ALL-RESULTS.csv); [exact rejection reasons](LINES-FEES-REJECTIONS.csv).\n\n';
report+=table(['Window','Intervals','Equity','Admitted','Fee rejected','Minimum rejected after fee gate','Minimum-only rejected / attempts','Fills/run','Fees/run','Mean return','Worst step/fee ratio'],lineMethod.settings.filter(s=>s.family==='lines').map(s=>{
 const a=all(lines,s.id),ds=correct.diagnostics.filter(r=>r.setting===s.id),m=aggregate(ds.map(d=>d.minimumOnly??{}));
 return [s.window,s.intervals,s.investment,a.n??0,sum(ds,'fee'),sum(ds,'minimum'),`${m.minimumRejected??0}/${m.attempts??0}`,num(mean(a,'fillCount')),num(mean(a,'fees')),pct(mean(a,'netReturn')),num(Math.min(...ds.filter(r=>r.minimumOnly?.minStepFeeRatio!==null).map(r=>r.minimumOnly.minStepFeeRatio)))];
}));
report+='\nA step/fee ratio at or below 1 fails clearance. The first rejected line count depends on the actual launch range; there is no universal safe count. The diagnostic table contains each window/count/equity combination and its first observed fee failures.\n';
report+='\nMinimum-only counts include only the planner’s minimum-funding reasons. Any other failure of the zero-maker analytical call remains separately counted, with its exact reason, in LINES-PLANNER-DIAGNOSTICS.csv. The worst step/fee ratio is measured among zero-maker plans that otherwise pass.\n';
for(const window of ['week','month']){
 const arms=lineMethod.settings.filter(s=>s.family==='lines'&&s.window===window&&s.investment===1000).sort((a,b)=>a.intervals-b.intervals);
 const first=arms.find(s=>sum(correct.diagnostics.filter(d=>d.setting===s.id),'fee')>0),largest=arms.at(-1),lastRows=correct.diagnostics.filter(d=>d.setting===largest.id);
 report+=`\n${window}: at the ceiling fee, the first tested count with any fee-clearance rejection was ${first?.intervals??'none'} intervals; ${largest.intervals} intervals had ${sum(lastRows,'fee')} fee rejections. These are launch-dependent boundaries, not a claim that every range fails there.\n`;
}
report+='\n5c. Fees. Pacifica publishes no maker rebate: Tier 1 maker 0.015%, taker 0.040%; VIP 1 maker 0%, taker 0.030%, requiring over $100 million of 30-day volume. Subaccounts share their master’s tier. [Published fee schedule](https://docs.pacifica.fi/trading-on-pacifica/trading-fees). The adapter’s 0.10% builder setting is a ceiling; the actual charged rate comes from public builder metadata keyed by the configured identity, unavailable here without reading prohibited environment values. These are fee scenarios, not claims about the platform’s current charge. At the ceiling, the builder component is 86.96% of the maker cost.\n\n';
report+=table(['Window','Intervals','Tier','Builder','Admitted','Fee rejected','Mean return','Fees/run','Fills/run'],lineMethod.settings.filter(s=>s.family==='fees').map(s=>{
 const a=all(lines,s.id),ds=correct.diagnostics.filter(r=>r.setting===s.id);
 return [s.window,s.intervals,s.tier,pct(s.builder),a.n??0,sum(ds,'fee'),pct(mean(a,'netReturn')),num(mean(a,'fees')),num(mean(a,'fillCount'))];
}));
report+='\nFee answer: 50 intervals can clear the step-fee test with no builder charge, but that does not make them the most profitable or best-performing choice. For 1,000 quote units at Tier 1, the following contrasts use all registered periods; admission changes mean the raw returns are not a matched fee-effect estimate.\n';
for(const window of ['week','month']){
 const parts=[0,0.001].map(builder=>{
  const s=lineMethod.settings.find(s=>s.family==='fees'&&s.window===window&&s.intervals===50&&s.tier==='tier1'&&s.builder===builder);
  const a=all(lines,s.id),denied=sum(correct.diagnostics.filter(r=>r.setting===s.id),'fee');
  return `${pct(builder)} builder: ${a.n} admitted, ${denied} fee denials, ${pct(mean(a,'netReturn'))} mean return`;
 });
 report+=`\n${window}, 50 intervals — ${parts.join('; ')}.\n`;
}
report+='\n5d. Leverage. Results below apply the shipped stop-clearance projection and exclude its denials from deployable-performance averages. The separate unsafe diagnostic population shows what would happen if that guard were bypassed. Maintenance uses each market’s current maximum leverage (BTC/ETH 50, SOL/HYPE 20, ZEC 10), hence 1%, 2.5%, 5% maintenance respectively, and the documented liquidation and backstop rules. Historical limit changes are unknown. [Pacifica liquidation documentation](https://docs.pacifica.fi/trading-on-pacifica/liquidations). Older data uses actual OKX funding payments and a **traded-price mark proxy**, so it cannot establish historical Pacifica liquidation outcomes. Funding gaps are excluded. [All admitted risk results](LEVERAGE-ALL-RESULTS.csv), [exact denials](LEVERAGE-REJECTIONS.csv), [unsafe scenarios](LEVERAGE-UNSAFE-DIAGNOSTICS.csv).\n\n';
report+=table(['Family / setting','Leverage','Projection admitted','Mean equity return','Mean / worst DD','DD >25% / >50%','Stops','Liquidated before stop','Unsafe count / liquidated','Mean funding cost','Minimum denials'],riskMethod.settings.map(s=>{
 const a=all(risk,s.id),u=all(risk.unsafe,s.id),worst=Math.max(0,...risk.summaries.filter(r=>r.setting===s.id&&r.dimension==='all').map(r=>r.worstDrawdown));
 const min=risk.rejections.filter(r=>r.key.split('|')[1]===s.id&&/cannot fund|opening minimum/.test(r.key));
 return [`${s.family}: ${s.window}, stop ${s.multiplier}, ${s.moveMode}, ${s.intervals} intervals, maker ${pct(s.makerRate)}`,s.leverage,a.n??0,pct(mean(a,'netReturn')),`${pct(mean(a,'maxDrawdown'))} / ${pct(worst)}`,`${a.dd25??0} / ${a.dd50??0}`,pct(a.stops/a.n),a.liquidations??0,`${u.n??0} / ${u.liquidations??0}`,num(mean(a,'funding')),sum(min,'count')];
}));
report+='\n“Unsafe” is not one universal leverage number: settings can be denied before launch, liquidate after price gaps, or exceed the owner’s drawdown thresholds. The first tested leverage with any such outcome is an observed warning boundary, not a guarantee below it. The model uses a standalone funded account, full fills at passive prices, and linear intrabar timing; it cannot reproduce order-book depth or liquidation slippage. The live launcher also reserves entry fees before sizing, whereas these comparisons retain round-one investment sizing. That difference and historical maintenance uncertainty prevent a production-safety certification.\n';
report+='\n[Every liquidation scenario](EVERY-LIQUIDATION.csv) identifies the market, launch, leverage, paths and whether the launch projection had denied it. [Matched stop-distance comparisons at the same leverage](STOP-DISTANCE-BY-LEVERAGE.csv) separate stop width from leverage. [All admissions and exact rejection reasons by year and regime](ADMISSIONS-REJECTIONS-BY-YEAR-REGIME.csv) preserve the denominators.\n';
report+='\nThe replay also retains the earlier engine’s entry-notional cap of one initial-equity amount per candle. Leverage increases total position capacity and seed size, but does not multiply that per-candle entry cap. This execution assumption limits how directly these outcomes translate into live leveraged trading.\n';
report+='\nAn accepted launch is not protection against execution loss: some simulated stops leave negative equity when the traded and mark candles are assigned opposite intrabar orders. For example, the 5× weekly HYPE long launched on 5 October 2025 loses more than its equity under one such 4h path. Those are modelled stress outcomes, not observed account losses or proof of the real tick sequence. [Same versus opposite extremum-order sensitivity](LEVERAGE-TIMING-SENSITIVITY.csv) isolates this assumption; losses are retained rather than capped or discarded.\n';
const riskCoverage=['development','evaluation','proxy'].map(period=>{const a=risk.summaries.find(r=>r.period===period&&r.setting==='family0-L1'&&r.dimension==='all');const denials=risk.rejections.filter(r=>r.key.startsWith(period+'|family0-L1|'));return `${period}: ${a?.n??0} admitted of ${(a?.n??0)+sum(denials,'count')}, including ${sum(denials.filter(r=>r.key.endsWith('|incomplete settled funding coverage')),'count')} excluded for funding gaps`;});
report+='\nFunded-cohort coverage for the 1× weekly baseline — '+riskCoverage.join('; ')+'. Public funding histories contain missing hourly observations; any affected horizon is excluded, never assigned zero cost. This sharply narrows the direct 2026 sample and can bias funded comparisons even though each comparison uses matched admissions.\n';
for(const family of [...new Set(riskMethod.settings.map(s=>s.family))]){
 const arms=riskMethod.settings.filter(s=>s.family===family),unsafeAt=arms.find(s=>{const a=all(risk,s.id),u=all(risk.unsafe,s.id);return (a.liquidations??0)+(u.liquidations??0)>0;}),dd25=arms.find(s=>(all(risk,s.id).dd25??0)>0),dd50=arms.find(s=>(all(risk,s.id).dd50??0)>0);
 report+=`\n${family}: first tested liquidation-before-stop ${unsafeAt?unsafeAt.leverage+'×':'not observed'}; admitted drawdown above 25% ${dd25?dd25.leverage+'×':'not observed'}, above 50% ${dd50?dd50.leverage+'×':'not observed'}.`;
}
const stopPairs=read(path.join(root,'stop-distance-pairs.json')).rows;
report+='\nStop distance at each leverage, compared on jointly projection-admitted scenarios with the same window, fees and leverage (descriptive; no reselection):\n';
for(const window of ['week','month'])for(const leverage of [1,3,5,10]){
 const values=[1.5,2].map(multiplier=>{
  const rows=stopPairs.filter(r=>r.window===window&&r.leverage===leverage&&r.multiplier===multiplier&&r.dimension==='all'),a=aggregate(rows);
  return `${multiplier} times the buffer: ${a.paired?num(100*a.delta/a.paired)+' pp return, '+num(100*a.drawdownDelta/a.paired)+' pp mean drawdown':'no jointly admitted comparison'}`;
 });
 report+=`\n${window}, ${leverage} times leverage — ${values.join('; ')}.`;
}
report+='\nThese pooled differences do not override the regime, market, admission and drawdown requirements. Wider stops that fail the launch projection remain excluded even when their unsafe counterfactual earns more.\n';
const rs=read(path.join(root,'phase-c-risk-selection.json')),ds=read(path.join(root,'phase-d-selection.json'));
const chosenRisk=riskMethod.settings.find(s=>s.id===rs.selected);
report+=`\nThe locked funded setting is ${chosenRisk.window}, ${chosenRisk.intervals} intervals, ${chosenRisk.leverage} times leverage, stop-buffer multiple ${chosenRisk.multiplier}, ${chosenRisk.moveMode} range, maker ${pct(chosenRisk.makerRate)} and taker ${pct(chosenRisk.takerRate)}. A zero-maker VIP scenario requires the published VIP volume qualification and is not the fee tier of an ordinary small account.\n`;
report+='\n\n6. Direction pairing. The development-locked funded setting is '+rs.selected+'. Shipped Trend and majority select a direction using only pre-launch history; neutral/unavailable stays in cash. A historical fresh Funding direction view cannot be reconstructed from settled payments, so majority uses the other available shipped views. Baseline averages the two direction trials, not a simultaneous two-sided portfolio. Both sides must be admitted for a matched comparison. [All direction regimes/years](DIRECTION-ALL-RESULTS.csv).\n\n';
report+=table(['Period','Signal','Paired scenarios','Take rate','Mean return','Mean max DD','Gain versus unfiltered, pp'],direction.summaries.filter(r=>r.dimension==='all').map(r=>{
 const take=direction.takes.find(t=>t.period===r.period&&t.setting===r.setting),pairs=direction.comparisons.filter(p=>p.period===r.period&&p.setting===r.setting);
 return [r.period,r.setting,r.n,take?pct(take.taken/take.n):'100%',pct(mean(r,'netReturn')),pct(mean(r,'maxDrawdown')),num(100*sum(pairs,'delta')/sum(pairs,'paired'))];
}));
function confirmed(summary,selected,baseline){
 if(selected===baseline)return 'baseline retained';
 return ['evaluation','proxy'].every(period=>['OHLC','OLHC'].every(p=>{
  const a=summary.comparisons.find(a=>a.period===period&&a.setting===selected&&a.path===p);
  return a&&a.paired&&a.admitted>=a.baseAdmitted&&a.delta>0&&a.drawdownDelta<=0&&['trending_up','trending_down','ranging'].filter(k=>a.regimes[k]?.delta>0).length>=2&&Object.values(a.markets).filter(m=>m.delta>0).length>Object.keys(a.markets).length/2;
 }))?'confirmed in both held-out periods':'not confirmed in both held-out periods; retain baseline';
}
report+='\nSelection audit. All choices were locked after development and before their evaluation/proxy runs. The criterion requires better return, no higher mean drawdown, at least baseline admission, wins in two of three known regimes and a majority of represented markets under both paths. Fees and leverage remain scenario-dependent.\n\n';
const ml=read(path.join(root,'phase-c-movement-selection.json')),ll=read(path.join(root,'phase-c-lines-selection.json'));
report+=ds.selected==='unfiltered'?'\nNeither direction pairing passed the development selection rule; retain the unfiltered baseline.\n':`\nDirection answer: ${ds.selected} passed the development rule and is ${confirmed(direction,ds.selected,'unfiltered')}. A held-out failure means the pairing has not shown the required broad improvement.\n`;
report+=table(['Comparison','Development choice','Held-out confirmation'],[
 ['Stops/window/mode',bs.selected,confirmed(b,bs.selected,'week-1-repeat_all-touch')],
 ['Movement',ml.selected,confirmed(movement,ml.selected,'week-fixed')],
 ['Lines',ll.lines.selected,confirmed(lines,ll.lines.selected,'lines-week-10-1000')],
 ['Fees',ll.fees.selected,confirmed(lines,ll.fees.selected,'lines-week-10-1000')],
 ['Funded leverage',rs.selected,confirmed(risk,rs.selected,'family0-L1')],
 ['Direction',ds.selected,confirmed(direction,ds.selected,'unfiltered')]
]);
report+='\nValidation and limits: [test and source audit](VALIDATION.md). Rejected plans never contribute to return averages. Exact reasons, missing funding/mark coverage and unsafe diagnostics remain separate. No confidence claim is justified by the overlapping samples. The readonly scanner result controls sealing; see REVIEW-SCAN-STATUS.md. The retired source was neither loaded nor used.\n';
fs.writeFileSync(path.join(handback,'ROUND-2-REPORT.md'),report);
const phaseCStart=report.indexOf('\n5. Moving the range.'),phaseDStart=report.indexOf('\n\n6. Direction pairing.');
if(phaseCStart<0||phaseDStart<phaseCStart)throw Error('Phase report boundaries missing');
fs.writeFileSync(path.join(handback,'PHASE-C-REPORT.md'),'Phase C: movement, grid count, fees and leverage. Detailed results below use only admitted runs; unsafe diagnostics are labelled separately.\n\n'+report.slice(phaseCStart,phaseDStart));
fs.writeFileSync(path.join(handback,'PHASE-D-REPORT.md'),'Phase D: direction pairing and held-out confirmation.\n\n'+report.slice(phaseDStart));
fs.writeFileSync(path.join(root,'report-sha256.json'),JSON.stringify({reportSha256:sha256(Buffer.from(report)),createdAt:new Date().toISOString()},null,2)+'\n');
console.log('Complete report and all regime/year/rejection CSVs written');
