import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {inventory,loadMarket,calendar,bindings,sha256,HB,read} from './data.mjs';
import {geometryAt} from '../grid-defaults/geometry.mjs';
import {projection} from '../grid-backtest-r2/projection.mjs';
import {sizingPolicy,ARMS} from './policy.mjs';
import {replayStrategy} from './strategy.mjs';
const [phase,cohort,symbol]=process.argv.slice(2);
if(!['phase1','phase2'].includes(phase)||!['development','evaluation','okx'].includes(cohort)||!symbol)throw Error('phase cohort symbol required');
const root=fs.readFileSync(path.join(HB,phase+'-root.txt'),'utf8').trim(),binding=read(path.join(root,'registration.json'));
if(sha256(fs.readFileSync(binding.file))!==binding.sha256)throw Error('Preregistration changed');
const inv=inventory(),d=loadMarket(inv,cohort,symbol),startTime=Date.now(),counts={attempted:0,admittedUniqueNew:0,derivedRows:0,rejected:0,reasons:{}};
const output=path.join(root,cohort+'-'+symbol+'.jsonl'),fd=fs.openSync(output,'wx');
const selected=phase==='phase2'?read(path.join(HB,'phase1-selection.json')).selected:null;
const arms=phase==='phase1'?Object.keys(ARMS):['flat_flat',...(selected?[selected]:[])];
const variants=phase==='phase1'?['shipped']:['none','loss10','loss15','loss25','reenter1','reenter2','reenter3'];
const geometry=new Map(),plans=new Map();
const checkpoint=(status,launch)=>fs.writeFileSync(path.join(HB,'RESUME.md'),`# Sizing/stops checkpoint\n\n${phase} ${cohort} ${symbol}: ${status}; ${launch??''}.\nCounts for this task: ${JSON.stringify(counts)}\nEvidence: ${root}\nOne worker; never treat a partial output as completed. Phase 2 requires completed Phase 1 report.\n`);
function replay(w,p,variant,pathName,markPath,makerRate,takerRate,policyInput){
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
for(const w of calendar(d,cohort)){
 for(const window of ['week','month'])for(const builderRate of [.001,0])for(const leverage of [1,3])for(const direction of ['long','short'])for(const arm of arms){
  const makerRate=.00015+builderRate,takerRate=.0004+builderRate,gkey=w.launchAt+'|'+window,pkey=[gkey,builderRate,leverage,direction,arm].join('|');
  let reason=w.reason,record;
  if(!reason){if(!geometry.has(gkey))geometry.set(gkey,await geometryAt(d.bars,'1h',w.start,d.market,window));const g=geometry.get(gkey);
   if(!g.ok)reason=g.reason;
   else {if(!plans.has(pkey)){try{const args={market:d.market,direction,geometry:g.geometry,reference:String(d.bars[w.start-1].close),leverage,makerRate,arm};
     const v=sizingPolicy(args),clearance=projection(v.policy,d.market,d.maxLeverage,makerRate,takerRate,w.launchAt);
     plans.set(pkey,{...v,args,reason:clearance.state==='available'?null:clearance.reason});
    }catch(e){plans.set(pkey,{reason:e.message});}}record=plans.get(pkey);reason=record.reason;}
  }
  for(const variant of variants){const pair=[];
   for(const pathName of ['OHLC','OLHC'])for(const markPath of cohort==='okx'?[pathName]:['OHLC','OLHC']){
    let result=null,why=reason;if(!why){try{result=replay(w,record.policy,variant,pathName,markPath,makerRate,takerRate,record.args);}catch(e){throw Error('Replay defect: '+e.message);}}
    const row={phase,cohort,market:symbol,launchAt:w.launchAt,horizonDays:w.horizonDays,window,builderRate,leverage,direction,arm,variant,path:pathName,markPath,
     admitted:!why,reason:why??null,liftCount:record?.lift?.count??0,...result};
    counts.attempted++;if(why){counts.rejected++;counts.reasons[why]=(counts.reasons[why]??0)+1;}else{counts.admittedUniqueNew++;pair.push(row);}
    fs.writeSync(fd,JSON.stringify(row)+'\n');
   }
   if(pair.length){const worst=pair.reduce((a,b)=>a.netReturn<=b.netReturn?a:b);fs.writeSync(fd,JSON.stringify({...worst,derived:true,path:'worst',markPath:'worst',sourcePath:worst.path,sourceMarkPath:worst.markPath})+'\n');counts.derivedRows++;}
  }
 }
 checkpoint('running',new Date(w.launchAt).toISOString());
}
fs.closeSync(fd);
const sourceFiles=fs.readdirSync('scripts/research/grid-sizing-stops').filter(x=>x.endsWith('.mjs')).map(x=>{const file=path.resolve('scripts/research/grid-sizing-stops',x);return {file,sha256:sha256(fs.readFileSync(file))};});
const receipt={phase,cohort,market:symbol,counts,elapsedSeconds:(Date.now()-startTime)/1000,host:os.hostname(),workers:1,freeGB:os.freemem()/2**30,output,outputSha256:sha256(fs.readFileSync(output)),bindings:[...bindings.values()],sourceFiles,preregistrationSha256:binding.sha256,completedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,cohort+'-'+symbol+'-complete.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
checkpoint('complete');console.log(JSON.stringify({phase,cohort,symbol,...counts,elapsedSeconds:receipt.elapsedSeconds}));
