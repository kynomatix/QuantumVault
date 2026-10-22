import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {createHash} from 'node:crypto';
import {quarterAt} from '../grid-ranging-pairs/core.mjs';import {indicators,averageAdx,squeezeAt,adxRanks} from '../grid-long-adx/core.mjs';
import {GEOMETRIES,weeklyTrend,gatePass} from './core.mjs';import {compare,bh,verdict} from './stats.mjs';
const hb=path.resolve('../grid-multi-timeframe-20261022-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const markets=read(root+'/markets.json'),selections=read(root+'/selections.json'),launches=read(root+'/launches.json'),cert=read(root+'/candles15m/certification.json'),drop15m=read(root+'/candles15m/complete.json').drop15m;
const indices=new Map(),daily=new Map(),ranks=new Map(),signals=new Map(),signalRows=[];
for(const m of markets){const d=read(m.dailyFile).rows;daily.set(m.symbol,d);indices.set(m.symbol,indicators(d));}
for(const s of selections){const entries=s.groups.all.map(symbol=>({symbol,p2:averageAdx(indices.get(symbol),s.at,6)}));ranks.set(s.universe+'|'+s.at,adxRanks(entries,'p2').ranging);}
for(const universe of ['A','A+B'])for(const w of launches){const quarter=quarterAt(w.launchAt),selection=selections.find(s=>s.universe===universe&&s.at===quarter);for(const symbol of selection.groups.all){const s={universe,symbol,launchAt:w.launchAt,quarter,squeeze:squeezeAt(indices.get(symbol),w.launchAt),lowAdx:ranks.get(universe+'|'+quarter).includes(symbol),trend:weeklyTrend(daily.get(symbol),w.launchAt)};signals.set([universe,symbol,w.launchAt].join('|'),s);signalRows.push(s);}}
fs.writeFileSync(root+'/signals.json',JSON.stringify(signalRows)+'\n',{flag:'wx'});
const rows=[],tally={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0,ineligibleLaunches:0,reasons:{},byGeometry:{}};
for(const m of markets){const receipt=read(root+'/'+m.symbol+'-complete.json'),h=createHash('sha256');for await(const b of fs.createReadStream(receipt.output))h.update(b);if(h.digest('hex')!==receipt.outputSha256)throw Error('Outcome hash mismatch');const counts={attempted:0,admittedUniqueNew:0,rejected:0,derivedRows:0},seen=new Set(),pairs=new Map(),reasons={};
 for await(const line of readline.createInterface({input:fs.createReadStream(receipt.output),crlfDelay:Infinity})){const r=JSON.parse(line),k=[r.launchAt,r.geometry,r.arm,r.leverage,r.builderRate,r.direction].join('|');if(!r.derived){if(seen.has(k+'|'+r.path))throw Error('Duplicate path simulation');seen.add(k+'|'+r.path);counts.attempted++;const g=tally.byGeometry[r.geometry]??={attempted:0,admitted:0,rejected:0,reasons:{}};g.attempted++;
  if(r.admitted){counts.admittedUniqueNew++;g.admitted++;const a=pairs.get(k)??[];a.push(r);pairs.set(k,a);}else{counts.rejected++;g.rejected++;reasons[r.reason]=(reasons[r.reason]??0)+1;g.reasons[r.reason]=(g.reasons[r.reason]??0)+1;}
 }else{const a=pairs.get(k);if(a?.length!==2||new Set(a.map(x=>x.path)).size!==2)throw Error('Missing physical paths');const worst=a.reduce((x,y)=>x.netReturn<=y.netReturn?x:y);for(const field of ['netReturn','maxDrawdown','protectiveStop','liquidated','fees','fillCount','funding','underwaterDays','underwaterAtHorizon','finalEquity','seedHold'])if(r[field]!==worst[field])throw Error('Conservative metric mismatch '+field);if(r.sourcePath!==worst.path)throw Error('Wrong source path');pairs.delete(k);counts.derivedRows++;rows.push(r);}}
 if(pairs.size)throw Error('Orphan path rows');for(const [k,v]of Object.entries(counts)){if(v!==receipt.counts[k])throw Error('Receipt count mismatch '+k);tally[k]+=v;}
 if(JSON.stringify(Object.entries(reasons).sort())!==JSON.stringify(Object.entries(receipt.counts.reasons).sort()))throw Error('Rejection reconciliation failed');for(const [k,v]of Object.entries(reasons))tally.reasons[k]=(tally.reasons[k]??0)+v;tally.ineligibleLaunches+=receipt.counts.ineligibleLaunches;
}
fs.writeFileSync(root+'/tally.json',JSON.stringify(tally)+'\n',{flag:'wx'});const geometries=GEOMETRIES.filter(g=>!drop15m||g.timeframe==='1h'),cells=[],frequencies=[];
for(const universe of ['A','A+B'])for(const g of geometries){const allowed=new Set(markets.filter(m=>(universe==='A+B'||m.universe==='A')&&(g.timeframe==='1h'||cert.find(c=>c.symbol===m.symbol)?.passed)).map(m=>m.symbol));const population=rows.filter(r=>allowed.has(r.symbol));
 for(const gate of ['G0','G1','G2','G3','G4']){
  const chosen=signalRows.filter(s=>s.universe===universe&&allowed.has(s.symbol)&&['long','short'].some(d=>gatePass(gate,s,d))),counts=new Map();for(const s of chosen)counts.set(s.symbol,(counts.get(s.symbol)??0)+1);
  frequencies.push({universe,geometry:g.id,gate,pairs:[...counts].map(([symbol,launches])=>({symbol,launches})).sort((a,b)=>b.launches-a.launches||a.symbol.localeCompare(b.symbol))});
 }
 for(const arm of ['flat_flat','further_near'])for(const gate of ['G0','G1','G2','G3','G4'])for(const builderRate of [0,.001])for(const leverage of ['all',1,3]){
  const env=population.filter(r=>r.builderRate===builderRate&&(leverage==='all'||r.leverage===leverage)),candidate=env.filter(r=>r.geometry===g.id&&r.arm===arm&&gatePass(gate,signals.get([universe,r.symbol,r.launchAt].join('|')),r.direction));
  for(const baseline of ['raw','advised']){const baselineGate=baseline==='raw'?'G0':'G1',reference=env.filter(r=>r.geometry==='D7H1'&&r.arm==='further_near'&&gatePass(baselineGate,signals.get([universe,r.symbol,r.launchAt].join('|')),r.direction)),identity=g.id==='D7H1'&&arm==='further_near'&&gate===baselineGate;
   const c=compare(candidate,reference);cells.push({universe,geometry:g.id,arm,gate,builderRate,leverage,baseline,identity,eligiblePairs:allowed.size,ungatedCandidateRows:env.filter(r=>r.geometry===g.id&&r.arm===arm).length,...c,p:identity?null:c.one.p});
  }
 }
 console.log(JSON.stringify({phase:'analysis',universe,geometry:g.id,cells:cells.length}));
}
const tested=cells.filter(c=>!c.identity&&c.one.weeks);bh(tested);const decisions=cells.filter(c=>c.universe==='A'&&c.builderRate===0&&c.leverage==='all').map(c=>{const broad=cells.find(b=>b.universe==='A+B'&&b.geometry===c.geometry&&b.arm===c.arm&&b.gate===c.gate&&b.builderRate===0&&b.leverage==='all'&&b.baseline===c.baseline);return {geometry:c.geometry,arm:c.arm,gate:c.gate,baseline:c.baseline,identity:c.identity,...verdict(c,broad)};});
for(const [name,value]of Object.entries({'cells.json':cells,'decisions.json':decisions,'frequencies.json':frequencies,'analysis-complete.json':{completedAt:new Date().toISOString(),newSimulations:tally.admittedUniqueNew,cellCount:cells.length,testedComparisons:tested.length,returnIntervals:tested.length*2,successfulRaw:decisions.filter(d=>d.baseline==='raw'&&d.success).length,successfulAdvised:decisions.filter(d=>d.baseline==='advised'&&d.success).length}}))fs.writeFileSync(root+'/'+name,JSON.stringify(value)+'\n',{flag:'wx'});
console.log(JSON.stringify(read(root+'/analysis-complete.json')));
