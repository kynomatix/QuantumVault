import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]),a=JSON.parse(fs.readFileSync(path.join(root,'analysis.json'),'utf8'));
const pct=x=>(100*x).toFixed(3),m=r=>`${pct(r.mean)} [${pct(r.lower95)}, ${pct(r.upper95)}]`;
const out=[
'The broad claim that the finder performs worse is only partly confirmed across start times. At 0.10% builder fee, its stop-rate point estimate is higher in all three periods, but every calendar-week interval includes zero. Returns are materially worse in Pacifica evaluation; development and the longer proxy period do not establish a return difference. All three finder mean returns at this fee have negative one-week intervals (see the overall table). These are pooled scenario results, not evidence that every slot performs worse.',
'',
'| Period | Finder minus blind mean return, pp [95% CI] | Stop-rate difference, pp [95% CI] |',
'|---|---:|---:|'];
for(const r of a.differences.filter(r=>r.cohort==='ALL_UNIQUE'&&r.dimension==='overall'&&r.fee===.001))out.push(`| ${r.period} | ${m(r)} | ${pct(r.stopDifference)} [${pct(r.stopLower95)}, ${pct(r.stopUpper95)}] |`);
out.push('',
'The finder selects compressed ATR more often: 24.9% versus 17.8% of admitted scenarios in development, 43.7% versus 30.4% in evaluation, and 26.0% versus 18.9% in the proxy period. However, within compressed ATR, its stop-rate differences are -1.177 pp [-5.606, 4.631], +0.084 pp [-2.868, 3.377], and -1.446 pp [-3.099, 0.377], respectively. All include zero. Compression is associated with high absolute stop rates in development and the proxy period for both arms; it is not a demonstrated finder-specific failure. In evaluation the compressed finder and blind stop rates are almost identical (51.392% and 51.308%).',
'',
'An accounting decomposition attributes 1.361 pp of the development stop difference and 1.310 pp of the proxy difference to the ATR-bin mix; within-bin contributions are +0.219 and -0.197 pp. Evaluation differs: +0.442 pp from the mix and +1.446 pp within bins, chiefly normal and unavailable ATR. This decomposition is descriptive, order-dependent, and has no causal interpretation; its components have no uncertainty estimates. ATR/close normalization preserves the absence of a consistent compressed-bin penalty. ATR is unavailable for 24.4%, 6.2%, and 6.0% of finder scenarios, respectively; those outcomes remain in the totals.',
'',
'Young ranges do not supply a consistent explanation either. Under-seven-day scenarios dominate both arms, so raw stop counts naturally cluster there. Older bins often have higher stop rates: for example, development finder stops rise from 53.775% under seven days to 70.918% at 7-14 days and 72.177% over 14 days. Evaluation differences are largest in the middle bin; the proxy middle-bin difference is negative. The outside-band/age-zero group is large, so the report also shows the latest-close-inside-only sensitivity. This age measure describes a separate frozen band; it cannot establish the age of the actual finder band.',
'',
'### Start times, mode and fees',
'',
'The tables below provide the previously missing hour-bucket and weekday estimates at both fees. Each mean has its calendar-week interval. They are descriptive; the best-looking slot is not a tested deployment choice. Use matched differences, not overlap between two marginal intervals, to assess the earlier claims.',
'',
'| Period | Step_back minus repeat_all at 0.10%, pp [95% CI] | Same contrast at zero builder fee, pp [95% CI] | Zero minus 0.10% builder, pp [95% CI] |',
'|---|---:|---:|---:|');
for(const period of ['development','evaluation','proxy']){const get=(comparison,fee)=>a.paired.find(r=>r.period===period&&r.cohort==='ALL_UNIQUE'&&r.dimension==='overall'&&r.comparison===comparison&&r.fee===fee);out.push(`| ${period} | ${m(get('step_back minus repeat_all',.001))} | ${m(get('step_back minus repeat_all',0))} | ${m(get('zero minus 0.10% builder',0))} |`);}
out.push('',
'At 0.10%, step_back has a positive pooled interval in development and the proxy period, but not evaluation; four-week blocks give the same conclusion. Among the 21 fixed slots, positive mode intervals occur in 12, 3, and 21 slots respectively. At zero builder fee the pooled mode interval is positive only in the proxy period; positive fixed-slot intervals occur in 0, 1, and 7 slots. Thus “step_back beats repeat_all” is not established universally across dates, times and fees.',
'',
'The fee penalty is robust: the zero-fee advantage has a positive interval in every fixed slot, hour bucket and weekday in all three periods, and in the overall four-week sensitivity. “Fees dominate” survives as a statement that the fee drag is consistent and consequential. It is not a demonstrated ranking above every timing or mode effect: this study does not test that ordering. The point estimates of the pooled fee drag exceed the mode improvements, but overlapping intervals alone cannot establish dominance.',
'',
'Four-week blocks also preserve the negative evaluation finder-minus-blind mean difference at 0.10% (95% CI -0.379 to -0.003 pp); at zero fee that sensitivity crosses zero (-0.393 to +0.008 pp). There are only 19 contributing blind evaluation weeks and 18 finder weeks, despite 33 calendar weeks in the schedule. Treat near-zero endpoints cautiously.',
'',
'### Owner recommendation: the live button',
'',
'The live “Find ranging markets” button should not imply that its picks are safer or more profitable. Across start times, its stop-rate point estimate remains worse, with uncertain differences, and its return disadvantage is confirmed in the Pacifica evaluation sample at the current fee; it is not confirmed in every period. Before grid launch, options for the owner are to relabel it “Low-ADX markets” with a clear statement that this describes recent price action and does not predict grid returns, or to remove/de-emphasize it until replacement selection logic passes a separate preregistered study. Simple/Auto must not rely on the current finder as is. Excluding compressed ATR could be a candidate experiment because it changes the selected mix, but these results do not validate that fix; its exact threshold, age definition, fallback, missing-history policy and evaluation period need their own preregistered test. These are options for the owner, not a product decision made by this research.',
'');
// Check narrative invariants against the retained data before publishing.
for(const period of ['development','evaluation','proxy']){
 const fee=a.paired.filter(r=>r.period===period&&r.comparison==='zero minus 0.10% builder'&&((r.cohort==='SLOT'&&r.value!=='RANDOM')||(r.cohort==='FIXED21'&&['hour','weekday'].includes(r.dimension))));
 if(fee.length!==31||fee.some(r=>!(r.lower95>0)))throw Error('Fee narrative does not match evidence');
}
fs.writeFileSync(path.join(root,'findings.md'),out.join('\n'));
console.log('Findings written; fee claims checked against all 31 fixed-slot/hour/weekday cells per period.');
