import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt,widerGeometry} from '../grid-defaults/geometry.mjs';
import {fixedReplay} from '../grid-backtest-r2/fixed-replay.mjs';
import {projection} from '../grid-backtest-r2/projection.mjs';
import {features,evaluateRules} from '../grid-entry-filters/core.mjs';
import {plannerRegime} from '../../../server/grid-planner/regime.ts';
import {qualifyRangingMarket} from '../../../server/grid-planner/scanner.ts';
import {MENU,HOUR,WEEK,END,weekCalendar,closeWeek} from './procedure.mjs';
import {researchBindings} from './bindings.mjs';
const [hb]=process.argv.slice(2),read=p=>JSON.parse(fs.readFileSync(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
if(!hb)throw Error('Handback directory required');
const certified=fs.readFileSync(path.join(hb,'certified-root-r2.txt'),'utf8').trim(),admission=read(path.join(certified,'admission.json'));
if(admission.admittedMarkets<6)throw Error('Fewer than six admitted markets');
const prereg=read(path.join(hb,'PREREGISTRATION-BINDING-R2.json')),here=path.dirname(fileURLToPath(import.meta.url));
for(const f of prereg.files)if(hash(fs.readFileSync(f.file))!==f.sha256)throw Error('Frozen procedure file changed');
const resume=process.argv.includes('--resume'),root=resume?fs.readFileSync(path.join(hb,'simulation-root-r2.txt'),'utf8').trim():path.join(hb,'evidence','r2-simulations-'+new Date().toISOString().replace(/[-:.]/g,''));
if(!resume){fs.mkdirSync(root);fs.writeFileSync(path.join(hb,'simulation-root-r2.txt'),root+'\n');}
const write=(n,x)=>fs.writeFileSync(path.join(root,n),JSON.stringify(x)+'\n');
const sourceRoot=fs.readFileSync(path.join(hb,'evidence-root.txt'),'utf8').trim(),instruments=read(path.join(sourceRoot,'instruments.response')).data;
const sourceFiles=researchBindings(path.resolve(here,'../../..'),path.join(hb,'actual-runtime-inputs-r2.json'));
const binding={startedAt:new Date().toISOString(),preregistrationCommitHash:prereg.commitHash,preregistrationSha256:hash(fs.readFileSync(path.join(here,'PREREGISTRATION-R2.md'))),admissionFile:path.join(certified,'admission.json'),admissionSha256:hash(fs.readFileSync(path.join(certified,'admission.json'))),sourceFiles,workers:1,freeMemoryBytes:os.freemem()};
if(resume){const old=read(path.join(root,'binding.json'));if(old.admissionSha256!==binding.admissionSha256||JSON.stringify(old.sourceFiles)!==JSON.stringify(binding.sourceFiles))throw Error('Simulation resume binding changed');}else write('binding.json',binding);
const counters={attempted:0,admittedUniqueNew:0,plannerRejected:0,dataRejected:0,replayRejected:0,filterCashRows:0,derivedOptionRows:0,reasons:{}};
const record=(kind,reason,n=1)=>{counters[kind]+=n;const k=kind+': '+reason;counters.reasons[k]=(counters.reasons[k]??0)+n;};
const toBars=(rows,venue)=>rows.map(([time,open,high,low,close,volume])=>({time,open,high,low,close,volume,provenance:{source:venue,venue,basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:'finalized'}}));
const calendar=weekCalendar(),PATHS=['OHLC','OLHC'];
for(const adm of admission.results.filter(x=>x.admitted)){
 const output=adm.market+'-weeks.json',countFile=adm.market+'-counts.json';if(resume&&fs.existsSync(path.join(root,output))){const old=read(path.join(root,countFile));for(const key of Object.keys(counters).filter(x=>x!=='reasons'))counters[key]+=old[key];for(const [k,v]of Object.entries(old.reasons))counters.reasons[k]=(counters.reasons[k]??0)+v;continue;}
 const before=structuredClone(counters),inst=instruments.find(x=>x.instId===adm.market);if(Number(inst.minSz)!==Number(inst.lotSz)||inst.ctValCcy!==adm.symbol)throw Error('Unsupported contract constraints '+adm.market);
 const market={symbol:adm.symbol,tick:inst.tickSz,lot:String(Number(inst.ctVal)*Number(inst.lotSz)),minimumQuote:'0.01',maximumQuote:'1000000000',minimumPrice:inst.tickSz,maximumPrice:'1000000000'},maxLeverage=Number(inst.lever);
 const bytes=fs.readFileSync(path.join(admission.priceRoot,adm.price.file));if(hash(bytes)!==adm.price.sha256)throw Error('Candle hash mismatch');const bars=toBars(JSON.parse(bytes).rows,'okx');
 const fb=fs.readFileSync(adm.fundingFile);if(hash(fb)!==adm.fundingSha256)throw Error('Funding hash mismatch');
 const timeIndex=new Map(bars.map((b,i)=>[b.time,i])),fundingEvents=bars.map(()=>[]);for(const f of JSON.parse(fb).rows){const i=timeIndex.get(Math.floor(f.time/HOUR)*HOUR);if(i!==undefined)fundingEvents[i].push(f);}
 const rows=[],partialFile=adm.market+'-partial.json';
 if(resume&&fs.existsSync(path.join(root,partialFile))){const part=read(path.join(root,partialFile));rows.push(...part.rows);Object.assign(counters,part.counters);}
 for(const launch of calendar){
  if(rows.some(r=>r.time===launch))continue;
  const start=timeIndex.get(launch),end=start+168;if(start===undefined||end>bars.length)throw Error('Certified calendar mismatch');
  const history=bars.slice(start-840,start),regime=plannerRegime(adm.symbol+'-PERP','1h',history.slice(-100),launch),finder=qualifyRangingMarket(adm.symbol+'-PERP',adm.symbol,'1h',history.slice(-100),launch,launch);
  if(history.length!==840||regime.state!=='available')throw Error('Signal unavailable '+adm.market+' '+new Date(launch).toISOString());
  const feature=features(history,{adx:regime.adx,state:finder.state}),rules=evaluateRules(feature),filters={none:true,R1:rules.R1_ESTABLISHED.state==='pass',ATR:rules.R3_NOT_SQUEEZED.state==='pass',finder:finder.state==='ranging'},signSide=bars[start-1].close>=bars[start-721].close?'long':'short';
  const geometry={};for(const window of ['week','month'])geometry[window]=await geometryAt(bars,'1h',start,market,window);
  const feeRows=[];
  for(const builder of [.001,0]){
   const makerRate=.00015+builder,takerRate=.0004+builder,physical=new Map(),rejections={};
   for(const window of ['week','month'])for(const lines of [6,10,14,20])for(const stop of [1,1.5])for(const mode of ['step_back','repeat_all'])for(const side of ['long','short']){
    const key=[window,lines,stop,mode,side].join('|');let policy,reason;
    if(!geometry[window].ok)reason=geometry[window].reason;
    else try{policy=makeTrailGrid({market,direction:side,mode,seed:true,geometry:widerGeometry(geometry[window].geometry,stop,market.tick),intervals:lines,economics:{investment:'1000.00',leverage:1,makerRate:String(makerRate),takerRate:String(takerRate)}},String(bars[start-1].close));const clearance=projection(policy,market,maxLeverage,makerRate,takerRate,launch);if(clearance.state!=='available')reason=clearance.reason;}catch(e){reason=e.message;}
    counters.attempted+=2;
    if(reason){record('plannerRejected',reason,2);rejections[key]=reason;physical.set(key,PATHS.map(()=>({netReturn:0,protectiveStop:0,maxDrawdown:0,cash:true})));continue;}
    const outcomes=[];
    for(const pathName of PATHS){const result=closeWeek(fixedReplay({candles:bars,market,timeframe:'1h',start,end,policy,path:pathName,markPath:pathName,markBars:bars,fundingEvents,maxLeverage,makerRate,takerRate,moveMode:'fixed',stopMode:'touch'}),takerRate);if(result.unavailable){record('replayRejected',result.unavailable);throw Error(result.unavailable);}counters.admittedUniqueNew++;outcomes.push({netReturn:result.netReturn,protectiveStop:result.protectiveStop,maxDrawdown:result.maxDrawdown,fees:result.fees,funding:result.funding,seedHold:result.seedHold,liquidated:result.liquidated,exitCost:result.exitCost});}
    physical.set(key,outcomes);
   }
   const pathReturns=PATHS.map(()=>[]),pathStops=PATHS.map(()=>[]),returns=[],stops=[],dds=[];
   for(const option of MENU){const side=option.side==='sign30'?signSide:option.side,key=[option.window,option.lines,option.stop,option.mode,side].join('|'),pair=physical.get(key),pass=filters[option.filter];counters.derivedOptionRows++;
    if(!pass)counters.filterCashRows++;const selected=pair[0].netReturn<=pair[1].netReturn?pair[0]:pair[1];returns.push(pass?selected.netReturn:0);stops.push(pass?selected.protectiveStop:0);dds.push(pass?selected.maxDrawdown:0);for(let p=0;p<2;p++){pathReturns[p].push(pass?pair[p].netReturn:0);pathStops[p].push(pass?pair[p].protectiveStop:0);}}
   feeRows.push({builder,returns,stops,dds,pathReturns,pathStops,rejections,physical:Object.fromEntries(physical)});
  }
  rows.push({time:launch,signalLatestClosedAt:launch,signSide,filters,feeRows});
  if(rows.length%8===0){write(partialFile,{rows,counters});write('checkpoint.json',{market:adm.market,weeks:rows.length,calendarWeeks:calendar.length,counters,freeMemoryBytes:os.freemem()});}
 }
 write(output,rows);const counts={};for(const key of Object.keys(counters).filter(x=>x!=='reasons'))counts[key]=counters[key]-before[key];counts.reasons=Object.fromEntries(Object.entries(counters.reasons).map(([k,v])=>[k,v-(before.reasons[k]??0)]).filter(([,v])=>v));write(countFile,counts);console.log(JSON.stringify({market:adm.market,weeks:rows.length,admittedUniqueNew:counts.admittedUniqueNew,plannerRejected:counts.plannerRejected}));
}
write('counts.json',counters);write('checkpoint.json',{phase:'complete',counters,pending:null});write('manifest.json',{files:fs.readdirSync(root).filter(f=>!f.endsWith('-partial.json')&&f!=='manifest.json').map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,file))),bytes:fs.statSync(path.join(root,file)).size}))});console.log('Walk-forward simulations complete.');
