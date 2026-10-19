// Descriptive preregistered aggregation. Returns are fractions, CSV percentages are explicit.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {metrics} from './core.mjs';
const evidence=process.argv[2],root=join(evidence,'evaluation-v3'),out=join(evidence,'summary');mkdirSync(out);
const phases=['pacifica',...['2022','2023','2024','2025'].flatMap(y=>['BTC','ETH','SOL'].map(m=>y+'-'+m))];
const rows=[],records=[],signals=new Map(),duplicates=new Set(),hashes=[];
const sha256=b=>createHash('sha256').update(b).digest('hex');
for(const phase of phases){
 const record=JSON.parse(readFileSync(join(root,phase,'run-record.json')));records.push(record);
 const bytes=readFileSync(join(root,phase,'runs.jsonl'));hashes.push({path:join(root,phase,'runs.jsonl'),sha256:sha256(bytes)});
 const a=bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);if(a.length!==record.runs)throw Error('Run count mismatch');
 for(const r of a){const key=[r.period,r.market,r.timeframe,r.launchAt,r.horizonDays,r.direction,r.seed,r.mode,r.path].join('|');if(duplicates.has(key))throw Error('Duplicate run');duplicates.add(key);if(!Number.isFinite(r.netReturn)||!Number.isFinite(r.maxDrawdown))throw Error('Invalid metric');rows.push(r);}
 const sb=readFileSync(join(root,phase,'signals.jsonl'));hashes.push({path:join(root,phase,'signals.jsonl'),sha256:sha256(sb)});
 for(const line of sb.toString().trim().split('\n').filter(Boolean)){const s=JSON.parse(line),key=[s.market,s.timeframe,s.launchAt].join('|');if(signals.has(key)&&JSON.stringify(signals.get(key))!==line)throw Error('Signal changed across horizon/phase');signals.set(key,s);for(const [k,v]of Object.entries(s.inputAudit))if(k.startsWith('latest')&&v!==null&&v>s.launchAt)throw Error('Future input');if(!s.views.find(v=>v.name==='Funding').unavailable)throw Error('Funding guessed');}
}
const rules=['Macro','Weekly structure','Trend','Funding','All available agree','Majority agree'],classes=['aligned','against','neutral/mixed','unavailable'];
const groups=new Map();
function group(k,r){let a=groups.get(k);if(!a)groups.set(k,a=[]);a.push(r);}
for(const r of rows){
 for(const path of [r.path,'combined']){
  const prefix=[r.period,path];group(JSON.stringify([...prefix,'all','all']),r);
  for(const [axis,value]of Object.entries({side:r.direction,market:r.market,timeframe:r.timeframe,horizonDays:r.horizonDays,seed:r.seed,mode:r.mode,macroRegime:r.macroRegime,availableSignals:r.availableSignals,year:new Date(r.launchAt).getUTCFullYear()}))group(JSON.stringify([...prefix,axis,String(value)]),r);
  if(path!=='combined')group(JSON.stringify([...prefix,'fullCell',[r.market,r.timeframe,r.horizonDays,r.direction,r.seed,r.mode].join('|')]),r);
 }
}
const output=[];
for(const [key,a]of groups){
 const [period,path,axis,value]=JSON.parse(key),base=metrics(a),sideMeans=Object.fromEntries(['long','short'].map(side=>[side,metrics(a.filter(r=>r.direction===side)).meanReturn]));
 const add=(rule,classification,b)=>{const m=metrics(b),matched=b.length?b.reduce((s,r)=>s+sideMeans[r.direction],0)/b.length:null;output.push({period,path,axis,value,rule,classification,...m,runRetention:b.length/a.length,launchRetention:m.launches/base.launches,blindRuns:base.runs,blindLaunches:base.launches,blindMeanReturn:base.meanReturn,deltaVsBlind:m.meanReturn===null?null:m.meanReturn-base.meanReturn,sideMatchedBlindMean:matched,deltaVsSideMatched:matched===null?null:m.meanReturn-matched});};
 add('Blind','all',a);
 for(const rule of rules){let n=0;for(const classification of classes){const b=a.filter(r=>r.classes[rule]===classification);n+=b.length;add(rule,classification,b);}if(n!==a.length)throw Error('Class partition mismatch');}
}
const keys=Object.keys(output[0]),csvValue=v=>v===null?'':typeof v==='string'?'"'+v.replaceAll('"','""')+'"':String(v);
function csv(path,a){writeFileSync(path,keys.join(',')+'\n'+a.map(r=>keys.map(k=>csvValue(r[k])).join(',')).join('\n')+'\n');}
csv(join(out,'class-splits.csv'),output.filter(r=>r.axis!=='fullCell'));csv(join(out,'full-cells.csv'),output.filter(r=>r.axis==='fullCell'));
writeFileSync(join(out,'headline.json'),JSON.stringify(output.filter(r=>r.axis==='all'),null,2));
const counts={};for(const s of signals.values())for(const v of s.views){const k=[s.market,s.timeframe,v.name,v.unavailable?'unavailable':v.direction].join('|');counts[k]=(counts[k]??0)+1;}
const audit={completedAt:new Date().toISOString(),phases:records.map(r=>({phase:r.phase,runs:r.runs,uniqueLaunches:r.uniqueLaunches,seconds:r.seconds,minFreeGiB:r.minFreeGiB,rejected:r.rejected.length,equivalence:r.equivalence.length})),runs:rows.length,uniqueLaunches:signals.size,duplicateRuns:0,lookAheadViolations:0,classPartitionViolations:0,rowsWithMissingReplayTime:rows.filter(r=>r.missingMs>0).length,fundingAvailable:0,signalCounts:counts,inputs:hashes};
writeFileSync(join(out,'audit.json'),JSON.stringify(audit,null,2));
const p=n=>n===null?'—':(n*100).toFixed(2),n=n=>n.toLocaleString('en-US');
let md='## Preregistered class tables\n\nEach run is one launch configuration under one intrabar ordering. These tables pool both orderings; their separate results are in class-splits.csv. Retention is shown as configurations / distinct market-timeframe-launch opportunities. Returns and drawdowns are percentages of equity; profitable means strictly above zero.\n';
for(const period of ['development','evaluation','proxy']){
 md+='\n### '+period+'\n\n| Rule | Class | Runs | Kept runs / opportunities | Mean return | Median return | Profitable | Stop rate | Mean drawdown | Worst drawdown |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
 for(const r of output.filter(r=>r.period===period&&r.path==='combined'&&r.axis==='all'&&r.runs))md+='| '+[r.rule,r.classification,n(r.runs),p(r.runRetention)+'% / '+p(r.launchRetention)+'%',p(r.meanReturn),p(r.medianReturn),p(r.profitableShare),p(r.stopRate),p(r.meanDrawdown),p(r.worstDrawdown)].join(' | ')+' |\n';
}
md+='\n## Intrabar sensitivity and side balance\n\nThe side-matched comparison weights blind long and short means to the selected class’s long/short mix. It diagnoses side imbalance; it does not control for launch timing.\n\n| Period | Rule (aligned) | OHLC mean | OLHC mean | Combined delta vs blind | Delta vs side-matched blind |\n|---|---|---:|---:|---:|---:|\n';
for(const period of ['development','evaluation','proxy'])for(const rule of rules.filter(r=>r!=='Funding')){const find=path=>output.find(r=>r.period===period&&r.path===path&&r.axis==='all'&&r.rule===rule&&r.classification==='aligned'),a=find('combined');md+='| '+[period,rule,p(find('OHLC').meanReturn),p(find('OLHC').meanReturn),p(a.deltaVsBlind),p(a.deltaVsSideMatched)].join(' | ')+' |\n';}
writeFileSync(join(out,'tables.md'),md);
console.log(JSON.stringify({runs:rows.length,uniqueLaunches:signals.size,summaryRows:output.length,rowsWithMissingReplayTime:audit.rowsWithMissingReplayTime}));
for(const r of output.filter(r=>r.axis==='all'&&r.path==='combined'&&(r.rule==='Blind'||r.classification==='aligned')))console.log(JSON.stringify({period:r.period,rule:r.rule,n:r.runs,meanPct:r.meanReturn===null?null:r.meanReturn*100,keepPct:r.runRetention*100}));