import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {loadSeries,measure,sha256,ATR_BINS,AGE_BINS} from './signals.mjs';
import {SLOTS,physicalKey,launches} from '../grid-start-time/core.mjs';
import {WEEK,weekAt,weekday,hourBucket,accumulator,add,bootstrapDesign,summarize,difference,BOOTSTRAP_SEED,REPLICATES} from './stats.mjs';
const root=path.resolve(process.argv[2]),handback=path.resolve(root,'../..');
const prior=fs.readFileSync('C:/Apps/Replit/conductor-worktrees/grid-start-time-20261021-handback/evidence-root.txt','utf8').trim();
const registrationPath=path.join(root,'registration.json'),registration=JSON.parse(fs.readFileSync(registrationPath,'utf8'));
if(sha256(fs.readFileSync('scripts/research/grid-squeeze-diag/PREREGISTRATION.md'))!==registration.sha256)throw Error('Preregistration binding mismatch');
const started=Date.now(),bindings=new Map([[registrationPath,sha256(fs.readFileSync(registrationPath))]]),audit={rawRows:0,rawAdmitted:0,newAdmitted:0,uniqueSignals:0,futureInputs:0,slotErrors:0,binErrors:0,physicalDuplicates:0,periods:[],sunday:[]};
const allStats=[],allDifferences=[],allPaired=[],allDecomposition=[],signalCounts={};
const checkpoint=message=>fs.writeFileSync(path.join(handback,'RESUME.md'),`# Squeeze diagnostic checkpoint\n\n${new Date().toISOString()}: ${message}\nEvidence: ${root}\nNEW admitted simulations: 0. One Node worker; existing runs only.\nPreregistration commitHash: ${registration.commitHash}\n`);
async function fileHash(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
const lines=file=>readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
const gkey=m=>[m.period,m.fee,m.arm,m.cohort,m.dimension,m.value].join('|');
const physicalScenario=r=>[r.launchAt,r.market,r.horizonDays,r.direction,r.path,r.markPath].join('|');
for(const period of ['development','evaluation','proxy']){
  const receiptFile=path.join(prior,`complete-${period}.json`),receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));bindings.set(receiptFile,await fileHash(receiptFile));
  const groups=new Map(),pairs=new Map(),allWeeks=new Set(),sunday=new Map();let attempted=0,admitted=0,launchCounter=0;
  const signalFile=path.join(root,`signals-${period}.jsonl`),signalFd=fs.openSync(signalFile,'wx');
  const group=(fee,arm,cohort,dimension,value)=>{const m={period,fee,arm,cohort,dimension,value},key=gkey(m);if(!groups.has(key))groups.set(key,accumulator(m));return groups.get(key);};
  const pairGroup=(comparison,fee,cohort,dimension,value)=>{const m={period,fee,comparison,cohort,dimension,value},key=JSON.stringify(m);if(!pairs.has(key))pairs.set(key,accumulator(m));return pairs.get(key);};
  for(const fileInfo of receipt.files){
    if(await fileHash(fileInfo.file)!==fileInfo.sha256)throw Error('Raw source SHA-256 mismatch');bindings.set(fileInfo.file,fileInfo.sha256);
    const market=path.basename(fileInfo.file).replace(`runs-${period}-`,'').replace('.jsonl',''),series=loadSeries(market,bindings),signals=new Map(),ids=new Map(),physical=new Set(),pairMap=new Map();let fileRows=0;
    for await(const line of lines(fileInfo.file)){
      const r=JSON.parse(line);fileRows++;attempted++;if(r.admitted)admitted++;
      if(!['A_WEEK','B_REPEAT'].includes(r.setting))continue;
      if(r.period!==period||r.market!==market||r.leverage!==1||r.timeframe!=='1h'||![0,.001].includes(r.builderRate))throw Error('Unexpected source scenario');
      const pk=physicalKey(r);if(physical.has(pk))throw Error('Duplicate relevant physical simulation');physical.add(pk);
      const expected=launches(r.anchor).find(x=>x.launchAt===r.launchAt);if(!expected||JSON.stringify(expected.slots)!==JSON.stringify(r.slots))throw Error('Start-time slot mismatch');
      allWeeks.add(weekAt(r.launchAt));
      if(!ids.has(r.launchAt))ids.set(r.launchAt,++launchCounter);const id=ids.get(r.launchAt);
      if(!signals.has(r.launchAt)){const s=measure(series,market,r.launchAt);signals.set(r.launchAt,s);fs.writeSync(signalFd,JSON.stringify({period,...s})+'\n');audit.uniqueSignals++;
        const sk=[period,s.venue??'unavailable',s.finderState,s.atrBin,s.ageBin,s.bandStatus].join('|');signalCounts[sk]=(signalCounts[sk]??0)+1;}
      const s=signals.get(r.launchAt),fixed=r.slots.some(x=>x!=='RANDOM'),cohorts=['ALL_UNIQUE',...(fixed?['FIXED21']:[]),...(r.slots.includes('RANDOM')?['RANDOM']:[])];
      if(r.setting==='A_WEEK'){
        for(const arm of ['BLIND',...(s.finderState==='ranging'?['FINDER']:[])]){
          for(const cohort of cohorts){
            add(group(r.builderRate,arm,cohort,'overall','ALL'),r,id);
            for(const [dimension,value] of [['atr',s.atrBin],['age',s.ageBin]])add(group(r.builderRate,arm,cohort,dimension,value),r,id);
            if(arm==='BLIND')for(const [dimension,value] of [['hour',hourBucket(r.launchAt)],['weekday',weekday(r.launchAt)]])add(group(r.builderRate,arm,cohort,dimension,value),r,id);
          }
          for(const [dimension,value] of [['atrNormalized',s.normalizedAtrBin],['joint',s.atrBin+' / '+s.ageBin],['bandStatus',s.bandStatus],...(s.bandStatus==='INSIDE'?[['insideAge',s.ageBin]]:[])])add(group(r.builderRate,arm,'ALL_UNIQUE',dimension,value),r,id);
          for(const slot of r.slots)add(group(r.builderRate,arm,'SLOT','slot',slot),r,id);
        }
        if(r.slots.includes('Sun-00'))sunday.set([r.launchAt,market,r.horizonDays,r.builderRate,r.direction,r.path,r.markPath].join('|'),{admitted:r.admitted,netReturn:r.netReturn,protectiveStop:r.protectiveStop,state:s.finderState});
      }
      if(r.admitted){const key=physicalScenario(r),entry=pairMap.get(key)??{r,id,values:{}};entry.values[r.setting+'-'+r.builderRate]=r.netReturn;pairMap.set(key,entry);}
    }
    if(fileRows!==fileInfo.rows)throw Error('Raw source row count mismatch');
    for(const {r,id,values:v} of pairMap.values()){
      const comparisons=[...[0,.001].map(fee=>({comparison:'step_back minus repeat_all',fee,a:v['A_WEEK-'+fee],b:v['B_REPEAT-'+fee]})),
        {comparison:'zero minus 0.10% builder',fee:0,a:v['A_WEEK-0'],b:v['A_WEEK-0.001']}];
      const fixed=r.slots.some(x=>x!=='RANDOM');
      for(const {comparison,fee,a,b} of comparisons){if(a===undefined||b===undefined)continue;
        for(const cohort of ['ALL_UNIQUE',...(fixed?['FIXED21']:[]),...(r.slots.includes('RANDOM')?['RANDOM']:[])]){
          add(pairGroup(comparison,fee,cohort,'overall','ALL'),r,id,a-b);
          for(const [dimension,value] of [['hour',hourBucket(r.launchAt)],['weekday',weekday(r.launchAt)]])add(pairGroup(comparison,fee,cohort,dimension,value),r,id,a-b);
        }
        for(const slot of r.slots)add(pairGroup(comparison,fee,'SLOT','slot',slot),r,id,a-b);
      }
    }
    checkpoint(`${period}/${market}: verified and aggregated ${fileRows} existing rows`);
    console.log(JSON.stringify({phase:'aggregate',period,market,sourceRows:fileRows,freeGB:Number((os.freemem()/2**30).toFixed(2))}));
  }
  fs.closeSync(signalFd);
  if(attempted!==receipt.attempted||admitted!==receipt.admitted)throw Error('Period source tally mismatch');
  audit.rawRows+=attempted;audit.rawAdmitted+=admitted;
  // Calendar includes empty weeks between first/last scheduled launches.
  const ws=[...allWeeks],first=Math.min(...ws),last=Math.max(...ws);for(let w=first;w<=last;w+=WEEK)allWeeks.add(w);
  const d=bootstrapDesign(period,allWeeks),d4=bootstrapDesign(period,allWeeks,4);
  for(const fee of [0,.001])for(const arm of ['BLIND','FINDER']){
    for(const cohort of ['ALL_UNIQUE','FIXED21','RANDOM']){
      group(fee,arm,cohort,'overall','ALL');for(const bin of ATR_BINS)group(fee,arm,cohort,'atr',bin);for(const bin of AGE_BINS)group(fee,arm,cohort,'age',bin);
    }
    for(const atr of ATR_BINS){group(fee,arm,'ALL_UNIQUE','atrNormalized',atr);for(const age of AGE_BINS)group(fee,arm,'ALL_UNIQUE','joint',atr+' / '+age);}
    for(const b of ['INSIDE','OUTSIDE','UNAVAILABLE'])group(fee,arm,'ALL_UNIQUE','bandStatus',b);
    for(const b of AGE_BINS.filter(x=>x!=='UNAVAILABLE'))group(fee,arm,'ALL_UNIQUE','insideAge',b);
    for(const slot of [...SLOTS.map(s=>s.id),'RANDOM'])group(fee,arm,'SLOT','slot',slot);
    for(const dimension of ['atr','age','atrNormalized','joint','bandStatus']){
      const cells=[...groups.values()].filter(a=>a.meta.fee===fee&&a.meta.arm===arm&&a.meta.cohort==='ALL_UNIQUE'&&a.meta.dimension===dimension),overall=group(fee,arm,'ALL_UNIQUE','overall','ALL');
      if(cells.reduce((n,a)=>n+a.returns.length,0)!==overall.returns.length||Math.abs(cells.reduce((n,a)=>n+a.sum,0)-overall.sum)>1e-8)throw Error('Diagnostic partition mismatch');
    }
  }
  for(const a of groups.values())allStats.push(summarize(a,d,a.meta.dimension==='overall'?d4:null));
  for(const a of pairs.values())allPaired.push(summarize(a,d,a.meta.dimension==='overall'?d4:null));
  for(const a of groups.values())if(a.meta.arm==='FINDER'){
    const m={...a.meta,arm:'BLIND'},b=groups.get(gkey(m));if(!b)throw Error('Missing nested baseline');
    allDifferences.push({...a.meta,...difference(a,b,d,a.meta.dimension==='overall'?d4:null)});
  }
  for(const fee of [0,.001])for(const dimension of ['atr','age','atrNormalized']){
    const bins=dimension==='age'?AGE_BINS:ATR_BINS;
    const bTotal=group(fee,'BLIND','ALL_UNIQUE','overall','ALL').returns.length,fTotal=group(fee,'FINDER','ALL_UNIQUE','overall','ALL').returns.length;
    for(const value of bins){const b=group(fee,'BLIND','ALL_UNIQUE',dimension,value),f=group(fee,'FINDER','ALL_UNIQUE',dimension,value),bn=b.returns.length,fn=f.returns.length;
      const pB=bn/bTotal,pF=fn/fTotal,sB=bn?b.stops/bn:0,sF=fn?f.stops/fn:0;
      allDecomposition.push({period,fee,dimension,value,blindShare:pB,finderShare:pF,blindStopRate:bn?sB:null,finderStopRate:fn?sF:null,
        withinContribution:pF*(sF-sB),compositionContribution:(pF-pB)*sB,totalContribution:pF*sF-pB*sB});
    }
  }
  const oldRoot=fs.readFileSync('C:/Apps/Replit/conductor-worktrees/grid-finder-backtest-20261020-handback/evidence-root.txt','utf8').trim(),old=path.join(oldRoot,`runs-${period}.jsonl`);
  let compared=0,mismatch=0;
  for await(const line of lines(old)){const r=JSON.parse(line);if(r.timeframe!=='1h'||r.leverage!==1||![0,.001].includes(r.builderRate))continue;
    const key=[r.launchAt,r.market,r.horizonDays,r.builderRate,r.direction,r.path,r.markPath].join('|'),s=sunday.get(key);if(!s)throw Error('Prior Sunday row absent');
    compared++;if(s.admitted!==r.admitted||s.state!==r.selectionState||r.admitted&&(Math.abs(s.netReturn-r.netReturn)>1e-10||s.protectiveStop!==r.protectiveStop))mismatch++;
  }
  const oldReceipt=path.join(oldRoot,`complete-${period}.json`),oldHash=await fileHash(old);
  if(oldHash!==JSON.parse(fs.readFileSync(oldReceipt,'utf8')).runsSha256)throw Error('Prior finder raw SHA-256 mismatch');
  bindings.set(oldReceipt,await fileHash(oldReceipt));bindings.set(old,oldHash);
  audit.sunday.push({period,compared,mismatch,priorPath:old});if(mismatch)throw Error('Sunday finder reconciliation mismatch');
  audit.periods.push({period,attempted,admitted,calendarWeeks:allWeeks.size,firstCalendarWeek:new Date(first).toISOString(),lastCalendarWeek:new Date(last).toISOString()});
  fs.writeFileSync(path.join(root,`aggregate-weeks-${period}.json`),JSON.stringify([...groups.values(),...pairs.values()].map(a=>({...a.meta,weekly:[...a.weekly]})))+'\n',{flag:'wx'});
  checkpoint(`${period}: aggregation, 5,000-draw bootstrap and Sunday reconciliation complete`);
}
const output={createdAt:new Date().toISOString(),preregistrationCommitHash:registration.commitHash,preregistrationSha256:registration.sha256,bootstrapSeed:BOOTSTRAP_SEED,replicates:REPLICATES,workers:1,host:os.hostname(),seconds:(Date.now()-started)/1000,audit,signalCounts,statistics:allStats,differences:allDifferences,paired:allPaired,decomposition:allDecomposition};
fs.writeFileSync(path.join(root,'analysis.json'),JSON.stringify(output)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(root,'input-bindings.json'),JSON.stringify({files:[...bindings].map(([file,sha256])=>({file,sha256}))},null,2)+'\n',{flag:'wx'});
checkpoint('Analysis complete; report, review, scan and delivery remain');
console.log(JSON.stringify({phase:'complete',seconds:output.seconds,newAdmitted:0,sourceRows:audit.rawRows,sourceAdmitted:audit.rawAdmitted,statistics:allStats.length,paired:allPaired.length}));
