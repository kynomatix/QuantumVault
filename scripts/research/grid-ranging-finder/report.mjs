import fs from 'node:fs';import path from 'node:path';
const hb=path.resolve('../grid-ranging-finder-20261023-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const cells=read(root+'/cells.json'),contrasts=read(root+'/contrasts.json'),decisions=read(root+'/decisions.json'),tally=read(root+'/tally.json'),signals=read(root+'/signal-counts.json'),membership=read(root+'/membership.json'),registration=read(root+'/registration.json');
const runs=fs.readdirSync(hb+'/evidence').filter(x=>x.startsWith('focused-')).map(x=>({...read(hb+'/evidence/'+x+'/result.json'),intent:read(hb+'/evidence/'+x+'/intent.json')}));
const pct=n=>n===null||!Number.isFinite(n)?'n/a':(100*n).toFixed(2),num=n=>n===null||!Number.isFinite(n)?'n/a':n.toFixed(2),ci=x=>`[${pct(x.low)}, ${pct(x.high)}]`,date=t=>new Date(t).toISOString().slice(0,10);
const table=(heads,rows)=>['| '+heads.join(' | ')+' |','| '+heads.map(()=> '---').join(' | ')+' |',...rows.map(r=>'| '+r.join(' | ')+' |')].join('\n');
const focus=contrasts.filter(c=>c.universe==='A'&&c.leverage==='pooled');
const md=`# Ranging finder research

None of the five new filters reliably found markets where this grid bot did better than both today's finder and taking every eligible opportunity. Keep the tool, but call it **“Show weaker-trend markets”** until a genuinely new period of data demonstrates a better ranking.

**Delivery status: UNSEALED.** The complete review-input closure scan found 46 findings in unchanged production dependencies, in addition to the two explicitly permitted raw FRACTAL QV_RUN_ID findings. These are scanner findings, not a claim of 46 exposed secrets. No source was changed or removed from the closure to clear them, and the scanner and raw receipts are unchanged. The verified research bundle is available for review, but a zero-finding freeze is blocked pending owner handling of the inherited findings. See REVIEW-SCAN-STATUS.md.

## Decision

**No replacement ranking passes.** This is not evidence that a low variance ratio or low Hurst estimate cannot describe mean reversion; it is evidence that the tested launch-time criteria did not establish better grid outcomes under the registered rule. The current finder itself has no reliable advantage over ALL: primary matched difference ${pct(focus[0].one.mean)} percentage points, one-week 95% CI ${ci(focus[0].one)}. ADX measures trend strength, so “weaker-trend” is more accurate than either “ranging” or “calmer.” This handback changes research files only; it does not rename the live button.

${table(['Arm','Criterion','Registered failure against M0','Registered failure against ALL'],decisions.map(d=>[d.arm,({M1:'Significance-adjusted variance ratio',M2:'DFA persistence',M3:'Completed edge rejections',M4:'Travel / spacing / stop distance',M5:'Equal percentile-rank blend'})[d.arm],...d.checks.map(c=>c.failed.join('; ')||'none')]))}

## Primary matched comparisons

Universe A is the frozen Pacifica-listed set. All numbers below use zero builder fee and equal-weight pooled 1x/3x leverage; return differences and CI endpoints are percentage points of initial margin over fourteen days. Each row matches calendar weeks and leverage strata, not identical symbols. Quarter counts can differ because no-selection weeks are absent, never zero-return cash allocations.

${table(['Arm / baseline','Difference pp','1-week 95% CI pp','4-week 95% CI pp','Quarter wins','Matched weeks','BH q'],focus.map(c=>[c.arm+' / '+c.baseline,pct(c.one.mean),ci(c.one),ci(c.four),c.quarterWins+'/'+c.quarterCount,c.one.weeks,num(c.bhQ)]))}

${table(['Arm / baseline','Worst 5% return %, arm / baseline','Stop %, arm / baseline','Liquidation %, arm / baseline','Underwater days, arm / baseline'],focus.map(c=>[c.arm+' / '+c.baseline,pct(c.left.worst5)+' / '+pct(c.right.worst5),pct(c.left.metrics.protectiveStop)+' / '+pct(c.right.metrics.protectiveStop),pct(c.left.metrics.liquidated)+' / '+pct(c.right.metrics.liquidated),num(c.left.metrics.underwaterDays)+' / '+num(c.right.metrics.underwaterDays)]))}

## Absolute outcomes and selection coverage

These rows use each arm's own available weeks, so they are descriptive, not substitutes for the matched contrasts. Rows are direction-specific conservative outcomes, not fresh simulations. Weighted tail means are the average worst 5% of outcomes; all rates and averages give equal weight to weeks, then leverage strata and pairs. Liquidation counts are unweighted counts of reused conservative rows selected by that arm.

${table(['Universe','Arm','Selected pair-launches','Empty weeks / 188','Unfilled quota slots','Admitted rows','Net return %','Worst 5% %','Stop %','Liquidation % (count)','Underwater days / %'],cells.filter(c=>c.leverage==='pooled').map(c=>[c.universe,c.arm,c.selectedLaunches,c.emptyWeeks,c.shortfall,c.rows,pct(c.metrics.netReturn),pct(c.worst5),pct(c.metrics.protectiveStop),pct(c.metrics.liquidated)+' ('+c.liquidationCount+')',num(c.metrics.underwaterDays)+' / '+pct(c.metrics.underwaterFraction)]))}

## Leverage and broader-universe checks

All eleven contrasts are shown for each leverage and universe in COMPARISONS.csv. Below are the candidate-versus-ALL effects; M0 comparisons and matched risk metrics remain in that CSV and the bound contrasts evidence. A+B is a secondary frozen 45-market universe, not an independent sample. “Not contradicted” was preregistered as the broad upper CI being nonnegative against both comparators; it does not establish replication.

${table(['Universe','Leverage','Arm','Difference pp','1-week 95% CI pp','4-week 95% CI pp','Quarter wins'],contrasts.filter(c=>c.arm!=='M0'&&c.baseline==='ALL'&&(c.universe==='A+B'||c.leverage!=='pooled')).map(c=>[c.universe,c.leverage,c.arm,pct(c.one.mean),ci(c.one),ci(c.four),c.quarterWins+'/'+c.quarterCount]))}

## Registered design and what was actually tested

The registration commit hash is **${registration.preregistrationCommitHash}**, created before new scores, memberships, or result analysis. Today's main was read at commit hash **${registration.mainCommitHash}**. The research base commit hash is **5e354392665cae7fa7ef087a58218b4ed6266312**. No parameter was fitted to outcomes. The inherited rolling prior-year eligibility calendar has 188 weekly launches from ${date(Math.min(...membership.map(w=>w.launchAt)))} through ${date(Math.max(...membership.map(w=>w.launchAt)))}, with complete fourteen-day horizons and March/June/September/December selection quarters. There is no newly untouched holdout: these same historical outcomes have already informed earlier studies, so this is exploratory forward-calendar evidence, not new confirmatory validation.

Simple configuration is seven-day range on hourly candles, ten intervals, step_back, shipped range-facts stops, Further/Near sizing, seed on, USD 1,000, 1x/3x, both long and short, fixed range, stop on touch, close at day fourteen. Fees are maker 0.015%, taker 0.040%, builder 0%; adverse entry/exit slippage is 0.05%, with observed funding. Each direction uses the lower-return complete OHLC/OLHC replay. Signals use only closed bars before launch; replay fill and mark prices remain the inherited hourly proxy assumptions, not live execution evidence. The 25 A / 20 B snapshot is fixed; 43 markets ever qualify. Frozen present-day listing membership entails survivorship limitations.

Every arm and ALL skips squeezed launches using the live daily advisory formula: twenty closes, population standard deviation, strict-less bandwidth percentile against the previous twelve calendar months, squeezed below 20%. The live UI is advisory; skipping here is the owner's requested research policy. Of 8,460 market-weeks, ${signals.ineligible} fail inherited quarterly eligibility, ${signals.squeezed} are squeezed, ${signals.squeezeUnavailable} lack squeeze history, and ${signals.featureUnavailable} lack usable features; ${signals.measured} remain in A+B. Requiring 721 contiguous closes therefore removes no additional eligible non-squeezed launches in this snapshot.

Rank within A and A+B separately before execution admission. Quota is floor(eligible non-squeezed population / 3), with ASCII ties. M0 preserves today's live qualification (100 bars, ADX below 20 and usable range), ranked by ascending ADX. M1 requires both q=4 and q=12 Lo–MacKinlay heteroskedastic variance-ratio upper bounds below one on 336 hourly returns; each uses a one-sided 2.5% test, Bonferroni-adjusted across the two horizons. M2 requires DFA H below 0.5 over both 336 and 720 returns; scales are 8/16/32/64 and additionally 128 for thirty days. M3 counts completed upper/lower-edge rejections over the preceding seven days, each against its own prior seven-day range, returning at least 10% of range inside within six closed bars; same-edge events cannot overlap. M4 ranks absolute hourly close travel per day divided by twice actual ten-interval spacing, then by mean fractional distance to long/short stops. M5 equally averages component percentile ranks without hard M1/M2 gates. M4 is a travel opportunity proxy, not a forecast of executed profitable round trips.

M0, M1 and M2 can leave quota vacancies when too few markets qualify. This explicitly preregistered interpretation of “top third” preserves the meaning of today's finder and the hard statistical thresholds; forced filling would test a different rule. No rejected selected bot is replaced. Both directions must be admitted on both paths before comparison, avoiding accidental direction imbalance. ALL includes all eligible non-squeezed launches before the same admission and direction-pair filters. Coverage differences mean the resulting estimand is conditional launched-bot performance, not equal-capital portfolio return.

Bootstrap resamples full calendar weeks, including empty gaps, with 10,000 deterministic circular draws, one-week blocks primary and four-week blocks sensitivity. There are 66 declared comparisons (11 contrasts × 3 leverage views × 2 universes), ${contrasts.filter(c=>Number.isFinite(c.one.p)).length} estimable p-values, and ${contrasts.filter(c=>c.bhQ!==null&&c.bhQ<.05).length} BH q-values below 0.05. BH q-values cover all one-week contrasts; reported 95% CIs are pointwise, not multiplicity-adjusted. Four-week intervals address adjacent fourteen-day-horizon dependence but cannot eliminate all shared-market dependence. Quarter wins use the inherited selection quarters, including partial first/last quarters. Full quarter deltas are in QUARTERS.csv. No rescue search or post-result tuning was performed.

Method references: [MathWorks variance-ratio test documentation](https://www.mathworks.com/help/econ/vratiotest.html), [PhysioNet DFA reference implementation](https://www.physionet.org/content/dfa/1.0.0/dfa.c). The implementation and all exact thresholds are frozen in PREREGISTRATION.md and core.mjs.

## Admitted tally — new and reused kept separate

**NEW simulations attempted: 0; admitted: 0; rejected: 0.** The previous multi-timeframe run already contained the exact required D7H1 / Further-Near / zero-builder paths. All 45 output hashes and receipt hashes were checked, both physical paths required, and each retained worst-path row compared to its physical source. The following is a reuse audit, not newly generated evidence or a multiplication by arm membership.

${table(['Reuse audit','Count'],[['Physical paths inspected for requested settings',tally.reusedPhysicalAttempted],['Physical paths admitted',tally.reusedPhysicalAdmitted],['Physical paths rejected',tally.reusedPhysicalRejected],['Derived worst-path outcomes',tally.reusedDerived],['Direction-specific outcomes excluded for absent partner',tally.directionUnpaired],['Paired direction-specific conservative outcomes before squeeze/membership',tally.reusedPairedDerived]])}

${table(['Inherited rejection reason','Physical paths'],Object.entries(tally.reasons))}

The inherited files include squeezed and otherwise nonselected launches. Admission counts in each arm above apply membership only after the audit. 381 direction/launch/leverage combinations lack an admitted pair of physical paths. There were no new network market-data requests or rate-limit responses.

## Validation and evidence

TEST-RISK: REQUIRED. Focused pure-estimator, closed-bar timing, selection, pairing and matched-week tests ran only on FRACTAL using verified exact-source thin-bundle projections. No local Vitest, full regression, database reset or capture endpoint was used. Both run records remain intact:

${table(['Test commit hash','Source commit hash','Host','Passed','Failed','Skipped'],runs.map(r=>[r.tipCommitHash,r.intent.sourceCommitHash,r.result.host,r.result.passed,r.result.failed,r.result.skipped]))}

The first run's two failures were corrected test expectations: the edge fixture accidentally touched the lower edge repeatedly, and the BH assertion required exact floating-point equality. Research formulas and results did not change. The rerun passed all nine checks. Projection blob bindings in each intent.json show exactly which source files were tested. These are build-time research checks, not conductor gate evidence.

Evidence root: ${root}. It contains registration/input bindings, launch-time features and memberships, replay-reuse bindings, 66 complete comparisons, decisions, and tally. REVIEW.md describes the static review and limitations; REVIEW-SCAN-STATUS.md records the reviewer's read-only snapshot secret-scan result. Raw FRACTAL QV_RUN_ID entropy findings, if present, are disclosed there under the owner's explicit exception; neither receipts nor scanner are altered. Delivery bundle and installer byte verification are recorded separately in DELIVERY-MANIFEST.json and DELIVERY-VERIFICATION.json.
`;
fs.writeFileSync(hb+'/RANGING-FINDER-REPORT.md',md);
fs.writeFileSync(hb+'/OWNER-NOTE.md','No mean-reversion filter passed; recommend “Show weaker-trend markets”; no live change was made, and delivery is unsealed because the review closure has 46 inherited scanner findings beyond the permitted run-ID findings.\n');
const csv=(heads,rows)=>[heads,...rows].map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
fs.writeFileSync(hb+'/COMPARISONS.csv',csv(['universe','leverage','arm','baseline','difference','oneWeekLow','oneWeekHigh','fourWeekLow','fourWeekHigh','p','bhQ','quarterWins','quarterCount','weeks','armRows','baselineRows','armWorst5','baselineWorst5','armStopRate','baselineStopRate','armLiquidationRate','baselineLiquidationRate','armLiquidationCount','baselineLiquidationCount','armUnderwaterDays','baselineUnderwaterDays'],contrasts.map(c=>[c.universe,c.leverage,c.arm,c.baseline,c.one.mean,c.one.low,c.one.high,c.four.low,c.four.high,c.one.p,c.bhQ,c.quarterWins,c.quarterCount,c.one.weeks,c.left.rows,c.right.rows,c.left.worst5,c.right.worst5,c.left.metrics.protectiveStop,c.right.metrics.protectiveStop,c.left.metrics.liquidated,c.right.metrics.liquidated,c.left.liquidationCount,c.right.liquidationCount,c.left.metrics.underwaterDays,c.right.metrics.underwaterDays])));
fs.writeFileSync(hb+'/QUARTERS.csv',csv(['universe','leverage','arm','baseline','quarter','difference','matchedWeeks'],contrasts.flatMap(c=>c.quarters.map(q=>[c.universe,c.leverage,c.arm,c.baseline,date(q.quarter),q.mean,q.weeks]))));
fs.writeFileSync(hb+'/RETENTION.csv',csv(['universe','launch','eligible','quota',...['ALL','M0','M1','M2','M3','M4','M5']],membership.map(w=>[w.universe,date(w.launchAt),w.eligible,w.quota,...['ALL','M0','M1','M2','M3','M4','M5'].map(a=>w.groups[a].length)])));
fs.writeFileSync(hb+'/LESSONS.md','# Lessons\n\n- 2026-10-23, grid-ranging-finder: hard mean-reversion significance gates can leave most weekly quotas empty; preserve vacancies and show matched-week coverage rather than silently backfilling.\n- 2026-10-23, grid-ranging-finder: matching frozen replay settings permits verified path reuse, but count zero new simulations and audit both paths plus both direction partners.\n');
console.log(JSON.stringify({report:hb+'/RANGING-FINDER-REPORT.md',comparisons:contrasts.length,tests:runs.length}));
