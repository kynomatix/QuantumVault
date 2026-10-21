import fs from 'node:fs';
import {ROOT,HB,read,write,json,hash,START,END,DAY,freeze} from './io.mjs';
const candidates=read(ROOT+'/candidate-universe.json'),coverage=read(ROOT+'/coverage.json');
if(coverage.length!==candidates.length)throw Error('Candle certification incomplete');
const audit=[];
for(const s of coverage.filter(s=>!s.passed&&s.universe==='A')){
 const c=candidates.find(c=>c.symbol===s.symbol),g=c.gate;
 const a={symbol:s.symbol,preferredReason:s.reason,checkedAt:new Date().toISOString()};
 if(!g){a.reason='No exact live Gate mapping';}
 else {
  const begin=Math.max(START,Math.ceil(Number(g.launch_time||g.create_time)*1000/DAY)*DAY);a.begin=begin;
  if(begin>Date.UTC(2025,8,1))a.reason='Gate listing leaves fewer than twelve months before final selection';
  else try{
   const rows=await json('https://api.gateio.ws/api/v4/futures/usdt/funding_rate?'+new URLSearchParams({contract:g.name,from:String(begin/1000),to:String((begin+DAY)/1000),limit:'100'}),s.symbol+'-r2-individual-gate');
   write(s.symbol+'-r2-gate-probe.json',{begin,rows});
   const observed=rows.filter(x=>Number(x.t)*1000>=begin&&Number(x.t)*1000<begin+DAY);a.observedFirstDay=observed.length;
   a.reason=observed.length>=3?'First day available; full Gate history not certified':'Required first-day Gate funding absent';
   if(observed.length>=3)throw Error('Gate history newly available: full certification required before proceeding');
  }catch(e){if(e.message.startsWith('Gate history newly'))throw e;a.reason=e.message+' on required first-day historical Gate funding';}
 }
 s.gateFallbackR2=a;audit.push(a);
}
for(const s of coverage.filter(x=>x.passed))s.thin=s.medianDailyQuoteVolumeFull<5e6||s.spreadBps===null||s.spreadBps===undefined||s.spreadBps>20;
write('gate-fallback-r2.json',audit);write('coverage.json',coverage);
const pass=coverage.filter(x=>x.passed),summary={status:pass.length>=24?'FROZEN':'BLOCKED',certified:pass.length,A:pass.filter(x=>x.universe==='A').length,B:pass.filter(x=>x.universe==='B').length,rejected:coverage.length-pass.length,total:coverage.length,admittedUniqueNewSimulations:0};write('coverage-summary.json',summary);
freeze();
const files=[];for(const s of pass)for(const k of ['price','funding','daily']){const file=s[k+'File'],sha256=s[k+'Sha256'];if(hash(fs.readFileSync(file))!==sha256)throw Error('Certification input drift');files.push({file,sha256});}
for(const name of ['coverage.json','candidate-universe.json','gate-fallback-r2.json','manifest.json'])files.push({file:ROOT+'/'+name,sha256:hash(fs.readFileSync(ROOT+'/'+name))});
write('frozen-snapshot-r2.json',{createdAt:new Date().toISOString(),preregistrationCommitHash:'f7fc916fcebd2c17ac42c348c467d909ec98f2ae',preregistrationSha256:hash(fs.readFileSync('scripts/research/grid-ranging-pairs/PREREGISTRATION.md')),summary,files});
write('frozen-snapshot-r2-sha256.json',{snapshotSha256:hash(fs.readFileSync(ROOT+'/frozen-snapshot-r2.json'))});
const q=x=>'"'+String(x??'').replaceAll('"','""')+'"',keys=['symbol','universe','certified','reason','gate_fallback','begin_UTC','median_daily_quote_USD_full','median_daily_quote_USD_30d','spread_bps_current','hourly_high_low_proxy_bps','thin_flag'];
fs.writeFileSync(HB+'/PAIR-COVERAGE.csv',[keys,...coverage.map(s=>[s.symbol,s.universe,s.passed,s.reason,s.gateFallbackR2?.reason??s.gateFallback?.reason,s.begin?new Date(s.begin).toISOString():'',s.medianDailyQuoteVolumeFull,s.medianDailyQuoteVolume,s.spreadBps,s.highLowProxyBps,s.thin])].map(r=>r.map(q).join(',')).join('\n')+'\n');
console.log(JSON.stringify({...summary,gateIndividualChecks:audit.length}));