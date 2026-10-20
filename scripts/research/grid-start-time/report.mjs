import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {PERIODS,SLOTS,ARMS,armRows,physicalKey,cohortKey,stats,spread,addAdmissionMask,pairRows} from './core.mjs';
const root=path.resolve(process.argv[2]),handback=path.resolve(root,'../..'),fullMask=2**21-1;
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
async function* lines(file){for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity}))if(line)yield line;}
const fileHash=async file=>{const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');};
const esc=v=>v===null||v===undefined?'':/[",\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v);
function csv(name,rows){const cols=[...new Set(rows.flatMap(r=>Object.keys(r)))];fs.writeFileSync(path.join(handback,name),[cols.join(','),...rows.map(r=>cols.map(k=>esc(r[k])).join(','))].join('\n')+'\n');}
const output=path.join(root,'report-'+new Date().toISOString().replace(/[-:.]/g,''));fs.mkdirSync(output);
const results=[],spreads=[],paired=[],r1Comparisons=[],rejections=[],reconciliations=[],tally=[],signalCounts=[],sundayPairs=[];
const allSlots=[...SLOTS.map(s=>s.id),'RANDOM'];
const priorRoot=fs.readFileSync('C:/Apps/Replit/conductor-worktrees/grid-entry-filters-20261020-handback/evidence-root.txt','utf8').trim();
const baselineKey=r=>[r.window,r.leverage,r.builderRate,r.market,r.launchAt,r.horizonDays,r.direction,r.path,r.markPath].join('|');
for(const period of PERIODS){
  const receipt=read(path.join(root,`complete-${period}.json`)),mask=new Map(),slotPaths=new Map(),fds=new Map();
  const frozen=read(path.join(root,'registration.json'));
  if(receipt.preregistrationCommitHash!==frozen.commitHash||receipt.preregistrationSha256!==frozen.sha256)throw Error('Preregistration receipt differs');
  for(const slot of allSlots){const p=path.join(output,period+'-'+slot+'.jsonl');slotPaths.set(slot,p);fds.set(slot,fs.openSync(p,'wx'));}
  let attempted=0,admitted=0,slotAdmitted=0,r1Admitted=0;const reasons={};
  for(const f of receipt.files){
    if(await fileHash(f.file)!==f.sha256)throw Error('Raw result SHA-256 mismatch');
    const unique=new Set();let count=0;
    for await(const line of lines(f.file)){
      const r=JSON.parse(line),key=physicalKey(r);if(unique.has(key))throw Error('Duplicate physical simulation');unique.add(key);count++;attempted++;
      if(r.admitted){admitted++;slotAdmitted+=r.slots.length;if(r.setting==='A_WEEK'&&r.r1==='pass')r1Admitted++;}
      else reasons[r.reason]=(reasons[r.reason]??0)+1;
      for(const slot of r.slots){
        fs.writeSync(fds.get(slot),line+'\n');
      }
      addAdmissionMask(mask,r);
    }
    if(count!==f.rows)throw Error('Raw file row count mismatch');
  }
  for(const fd of fds.values())fs.closeSync(fd);
  for(const [key,value] of Object.entries({attempted,admitted,slotAdmitted,r1Admitted}))if(value!==receipt[key])throw Error('Completion tally mismatch: '+key);
  if(JSON.stringify(Object.entries(reasons).sort())!==JSON.stringify(Object.entries(receipt.rejectionCounts).sort()))throw Error('Rejection count mismatch');
  tally.push({period,attempted,admitted,rejected:attempted-admitted,slotAdmitted,r1Admitted});
  const common=new Set([...mask].filter(([,m])=>m===fullMask).map(([k])=>k));
  let sunday=null;
  for(const slot of allSlots){
    const raw=[];for await(const line of lines(slotPaths.get(slot)))raw.push(JSON.parse(line));
    const rows=raw.flatMap(armRows),groups=new Map();
    for(const r of rows){const k=r.arm+'|'+r.builderRate;const a=groups.get(k)??[];a.push(r);groups.set(k,a);}
    for(const arm of ARMS)for(const fee of [.001,0]){
      const group=groups.get(arm+'|'+fee)??[];
      const base={period,slot,arm,builderRate:fee};
      const rejection=new Map();for(const r of group)if(!r.admitted)rejection.set(r.reason,(rejection.get(r.reason)??0)+1);
      for(const [reason,count]of rejection)rejections.push({...base,reason,count});
      for(const cohort of ['scheduled','common21']){
        const population=cohort==='scheduled'?group:group.filter(r=>common.has(cohortKey(r)));
        const dims=[['all','all'],...['year','market','direction','horizonDays','path','markPath'].flatMap(d=>[...new Set(group.map(r=>r[d]))].map(v=>[d,v]))];
        for(const [dimension,value]of dims){
          const a=dimension==='all'?population:population.filter(r=>r[dimension]===value);
          results.push({...base,cohort,dimension,value,attempted:a.length,...stats(a)});
        }
      }
      if(arm==='A_WEEK'){
        const pairs=pairRows(group,groups.get('B_REPEAT|'+fee)??[]);
        paired.push({...base,comparison:'step_back minus repeat_all',...stats(pairs)});
      }
      if(fee===0){
        const pairs=pairRows(group,groups.get(arm+'|0.001')??[]);
        paired.push({...base,comparison:'zero minus 0.10% builder',...stats(pairs)});
      }
      if(arm==='C_R1'){
        const selected=group.filter(r=>r.admitted),weeks=new Set(selected.map(r=>r.anchor));
        const blind=(groups.get('A_WEEK|'+fee)??[]).filter(r=>r.admitted&&r.measurable&&weeks.has(r.anchor));
        const a=stats(selected),b=stats(blind);
        r1Comparisons.push({...base,...a,blindAdmitted:b.admitted,blindMean:b.mean,blindMedian:b.median,blindWeeks:b.weeks,
          meanLift:a.mean!==null&&b.mean!==null?a.mean-b.mean:null});
      }
    }
    const admittedRows=new Map(rows.filter(r=>r.admitted).map(r=>[cohortKey(r),r]));
    if(slot==='Sun-00'){
      sunday=admittedRows;
      const current=new Map(raw.filter(r=>r.setting!=='B_REPEAT').map(r=>[baselineKey(r),r]));
      const priorPath=path.join(priorRoot,`runs-${period}.jsonl`),priorReceipt=read(path.join(priorRoot,`complete-${period}.json`));
      if(await fileHash(priorPath)!==priorReceipt.runsSha256)throw Error('Prior baseline hash mismatch');
      let compared=0,mismatches=0,priorAdmitted=0;const mismatchExamples=[];
      for await(const line of lines(priorPath)){
        const p=JSON.parse(line);
        if(p.timeframe!=='1h'||![.001,0].includes(p.builderRate)||!(p.leverage===1||p.leverage===3&&p.window==='week'))continue;
        const k=baselineKey(p),r=current.get(k);compared++;if(p.admitted)priorAdmitted++;
        const fields=p.admitted?['admitted','netReturn','maxDrawdown','protectiveStop','liquidated','seedHold','fees','funding','fillCount']:['admitted','reason'];
        if(!r||fields.some(f=>typeof p[f]==='number'?Math.abs(r[f]-p[f])>1e-10:r[f]!==p[f])){mismatches++;if(mismatchExamples.length<5)mismatchExamples.push({key:k,fields});}
        current.delete(k);
      }
      mismatches+=current.size;
      reconciliations.push({period,priorPath,priorRunsSha256:priorReceipt.runsSha256,compared,priorAdmitted,mismatches,mismatchExamples});
      if(mismatches)throw Error('Sunday baseline failed reconciliation');
    }else{
      for(const arm of ARMS)for(const fee of [.001,0]){
        const pairs=[];
        for(const [k,a]of admittedRows){if(a.arm!==arm||a.builderRate!==fee)continue;const b=sunday.get(k);if(b)pairs.push({...a,netReturn:a.netReturn-b.netReturn});}
        sundayPairs.push({period,slot,arm,builderRate:fee,...stats(pairs)});
      }
    }
    const launchMap=new Map(raw.filter(r=>r.setting==='A_WEEK'&&r.builderRate===.001).map(r=>[r.market+'|'+r.launchAt,r]));
    signalCounts.push({period,slot,calendarLaunches:launchMap.size,r1Pass:[...launchMap.values()].filter(r=>r.r1==='pass').length,
      r1Fail:[...launchMap.values()].filter(r=>r.r1==='fail').length,r1Unavailable:[...launchMap.values()].filter(r=>r.r1==='unavailable').length});
  }
  for(const arm of ARMS)for(const builderRate of [.001,0])for(const cohort of ['scheduled','common21']){
    const population=results.filter(r=>r.period===period&&r.arm===arm&&r.builderRate===builderRate&&r.cohort===cohort&&r.slot!=='RANDOM'&&['all','year'].includes(r.dimension));
    const dims=[...new Set(population.map(r=>r.dimension+'|'+r.value))];
    for(const dim of dims){const [dimension,value]=dim.split('|'),a=population.filter(r=>r.dimension===dimension&&String(r.value)===value);
      for(const metric of ['mean','median','profitable','stopRate','meanDrawdown','worstDrawdown','admitted','launches','weeks'])spreads.push({period,arm,builderRate,cohort,dimension,value,...spread(a,metric)});
    }
  }
  console.log(`${period}: reconciled ${admitted} unique admitted; Sunday matches prior results`);
}
const overall=results.filter(r=>r.dimension==='all'),consistent=[];
for(const arm of ARMS)for(const fee of [.001,0])for(const slot of SLOTS.map(s=>s.id).filter(s=>s!=='Sun-00')){
  const cells=PERIODS.map(period=>overall.find(r=>r.period===period&&r.arm===arm&&r.builderRate===fee&&r.slot===slot&&r.cohort==='scheduled'));
  const baseline=PERIODS.map(period=>overall.find(r=>r.period===period&&r.arm===arm&&r.builderRate===fee&&r.slot==='Sun-00'&&r.cohort==='scheduled'));
  const comparisons=PERIODS.map(period=>sundayPairs.find(r=>r.period===period&&r.arm===arm&&r.builderRate===fee&&r.slot===slot));
  const qualifies=cells.every((c,i)=>c&&c.mean>0&&c.median>0&&c.profitable>.5&&baseline[i]?.mean!==null&&c.mean>baseline[i].mean);
  const pairedSurvives=comparisons.every(c=>c&&c.mean!==null&&c.mean>0);
  consistent.push({arm,builderRate:fee,slot,qualifies,pairedSurvives,...Object.fromEntries(PERIODS.flatMap((p,i)=>[
    [p+'Mean',cells[i]?.mean??null],[p+'Admitted',cells[i]?.admitted??0],[p+'Launches',cells[i]?.launches??0],[p+'Weeks',cells[i]?.weeks??0],[p+'PairedLift',comparisons[i]?.mean??null]]))});
}
csv('START-TIME-ALL-RESULTS.csv',results);csv('START-TIME-SPREADS.csv',spreads);csv('START-TIME-PAIRED.csv',paired);
csv('START-TIME-R1-COMPARISONS.csv',r1Comparisons);csv('START-TIME-REJECTIONS.csv',rejections);
csv('START-TIME-SUNDAY-PAIRS.csv',sundayPairs);csv('START-TIME-CONSISTENT-SLOTS.csv',consistent);csv('START-TIME-SIGNALS.csv',signalCounts);
fs.writeFileSync(path.join(root,'baseline-reconciliation.json'),JSON.stringify({results:reconciliations},null,2)+'\n');
const summary={tally,overall,spreads:spreads.filter(r=>r.dimension==='all'),paired,r1Comparisons,consistent:consistent.filter(r=>r.qualifies),reconciliations,reportRoot:output};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary)+'\n');
const n=tally.reduce((s,t)=>s+t.admitted,0),rejected=tally.reduce((s,t)=>s+t.rejected,0);
fs.writeFileSync(path.join(handback,'ADMITTED-TALLY.txt'),`Unique ADMITTED simulations: ${n}\nRejected physical simulations: ${rejected}\n`);
const pct=x=>x===null||x===undefined?'unavailable':(x*100).toFixed(3)+'%',num=x=>x===null||x===undefined?'unavailable':String(x);
const text=['# Grid start-time robustness','',`Unique ADMITTED simulations: **${n.toLocaleString('en-US')}**; rejected physical simulations: **${rejected.toLocaleString('en-US')}**.`,
  '', '## Design and interpretation','',
  'Twenty-one fixed weekday/UTC-hour slots plus a seeded random hour per Sunday-anchored week; no selection. Hourly execution, both 14/30-day horizons, both directions and four trade/mark paths. A_WEEK is the round-2 weekly step_back setting; B_REPEAT changes only to repeat_all; C_R1 is the owner’s exact repeated-touch/middle rule applied to A_WEEK; A_MONTH uses the monthly range; A_3X is the weekly 3x check. Builder fee is 0.10% or zero on top of maker/taker fees. Funding, liquidation and full-horizon data admission are unchanged.',
  '', 'All cells below report scenario counts, not independent samples. Distinct market launches and anchored weeks are reported alongside them. RANDOM collisions and overlapping C_R1 membership are excluded from the unique tally. Return is net equity change over the bot horizon; drawdown is from peak equity. Both sides are alternatives, not a combined portfolio. [Preregistration](PREREGISTRATION.md) fixes the design and published seed.',
  '', '## Coverage','', '| Period | Unique admitted | Rejected | Slot admitted memberships | R1 admitted memberships |','| --- | ---: | ---: | ---: | ---: |'];
for(const t of tally)text.push(`| ${t.period} | ${t.admitted} | ${t.rejected} | ${t.slotAdmitted} | ${t.r1Admitted} |`);
text.push('', 'Full rejection reasons and counts, including R1 unavailable/failed signals, are in [rejections](START-TIME-REJECTIONS.csv) and [signals](START-TIME-SIGNALS.csv). Missing funding and complete-horizon requirements can change the market-week population across slots. Offset horizons crossing period boundaries remain explicit rejections.', '', '## Every setting and slot','');
for(const period of PERIODS)for(const arm of ARMS)for(const fee of [.001,0]){
  text.push(`### ${period} / ${arm} / builder ${pct(fee)}`,'','| Slot UTC | Admitted | Launches / weeks | Mean | Median | Profitable | Stops | Mean / worst DD |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const r of overall.filter(r=>r.period===period&&r.arm===arm&&r.builderRate===fee&&r.cohort==='scheduled'))text.push(`| ${r.slot} | ${r.admitted} | ${r.launches} / ${r.weeks} | ${pct(r.mean)} | ${pct(r.median)} | ${pct(r.profitable)} | ${pct(r.stopRate)} | ${pct(r.meanDrawdown)} / ${pct(r.worstDrawdown)} |`);
  const s=spreads.find(r=>r.period===period&&r.arm===arm&&r.builderRate===fee&&r.cohort==='scheduled'&&r.dimension==='all'&&r.metric==='mean');
  text.push('',`Fixed-slot mean spread: ${pct(s.min)} to ${pct(s.max)}; population SD ${pct(s.sd)}. Sunday ranks ${num(s.sundayRank)} of ${s.availableSlots??0} (1 = highest return); outside the other slots’ range: ${s.rangeOutlier}; outside their Tukey fences: ${s.fenceOutlier}.`,'');
}
text.push('## Comparisons and complete splits','',
  '[All results](START-TIME-ALL-RESULTS.csv) include every scheduled and common-21-slot result plus year, market, side, horizon and intrabar-path splits. [Spreads](START-TIME-SPREADS.csv) report min/max/population SD and Sunday rank for every requested metric, by period and year. Common21 matches identical market/week/scenario keys admitted in all 21 fixed slots; its R1 intersection can be empty and is not assigned zero performance. RANDOM is a separate reference and is excluded from fixed-slot spreads.',
  '', '[Paired comparisons](START-TIME-PAIRED.csv) compare step_back with repeat_all and zero with 0.10% builder fees only on jointly admitted scenarios. Their mean/median/profitable fields describe return DIFFERENCES; stop/drawdown fields describe the first arm, not differences. [R1 comparisons](START-TIME-R1-COMPARISONS.csv) use measurable blind runs on the same represented anchored weeks. [Sunday pairs](START-TIME-SUNDAY-PAIRS.csv) compare each slot with Sunday on jointly admitted identical scenarios.',
  '', '[Consistent-slot inventory](START-TIME-CONSISTENT-SLOTS.csv) records the preregistered descriptive screen and counts for all slots, whether or not they pass; nothing is selected. Comparing many correlated slots in previously inspected histories cannot establish a tradable timing edge.',
  '', '## Evidence and limits','',
  'Sunday baseline reconciliation reproduces the previous entry-filter study exactly for all matching weekly/monthly 1x and weekly 3x hourly configurations, including admission and numerical outcomes. See the evidence baseline-reconciliation.json. The unchanged engine assumes full fills, fixed frozen current constraints, continuous protective execution, and no final inventory liquidation costs; proxy trade prices also serve as marks. Queues, latency, outages, capital concurrency and compounding are absent. Four-hour execution was not rerun. Historical data and overlapping samples support descriptive robustness, not a live recommendation or an independent confidence claim.',
  '', '[Review and tests](REVIEW-REPORT.md) records focused FRACTAL evidence and self-review. [Snapshot scan status](REVIEW-SCAN-STATUS.md) controls sealing. No independent approval, production integration, push or merge is claimed.');
fs.writeFileSync(path.join(handback,'START-TIME-REPORT.md'),text.join('\n')+'\n');
console.log(JSON.stringify({admitted:n,rejected,consistent:summary.consistent.length,report:path.join(handback,'START-TIME-REPORT.md')}));
