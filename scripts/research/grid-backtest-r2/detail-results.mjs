import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {inRegisteredPopulation} from './registered-population.mjs';
const root=process.argv[2],handback=path.resolve(root,'../..'),groups=new Map(),liquidations=[],stopPairs=new Map(),timing=new Map();
const settings=JSON.parse(fs.readFileSync(path.join(root,'phase-c-risk-method.json'),'utf8')).settings;
const byId=new Map(settings.map(s=>[s.id,s]));
const riskArms=settings.filter(s=>s.moveMode==='fixed'&&s.mode==='step_back'&&s.stopMode==='touch'&&s.intervals===10&&s.makerRate===0.00115);
const csv=(name,rows)=>{
 if(!rows.length){fs.writeFileSync(path.join(handback,name),'No observed rows\n');return;}
 const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))],quote=v=>'"'+String(typeof v==='object'?JSON.stringify(v):v??'').replaceAll('"','""')+'"';
 fs.writeFileSync(path.join(handback,name),keys.map(quote).join(',')+'\n'+rows.map(r=>keys.map(k=>quote(r[k])).join(',')).join('\n')+'\n');
};
for(const phase of ['phase-b','phase-c-lines','phase-c-movement','phase-c-risk','phase-d']){
 for(const period of ['development','evaluation','proxy']){
  let key=null,rows=[];
  const flush=()=>{
   if(phase!=='phase-c-risk'||!rows.length)return;
   for(const row of rows){
    const s=byId.get(row.setting);if(!riskArms.includes(s)||s.multiplier===1)continue;
    const baseSetting=riskArms.find(b=>b.multiplier===1&&b.window===s.window&&b.leverage===s.leverage);
    const base=rows.find(b=>b.setting===baseSetting.id&&b.direction===row.direction&&b.path===row.path&&b.markPath===row.markPath);if(!base)throw Error('Missing matched stop arm');
    for(const [dimension,value] of [['all','all'],['regime',row.regime],['year',row.year],['market',row.market],['path',row.path]]){
     const k=[period,s.window,s.leverage,s.multiplier,dimension,value].join('|');
     if(!stopPairs.has(k))stopPairs.set(k,{period,window:s.window,leverage:s.leverage,multiplier:s.multiplier,dimension,value,n:0,admitted:0,baselineAdmitted:0,paired:0,delta:0,drawdownDelta:0});
     const a=stopPairs.get(k);a.n++;a.admitted+=Number(row.admitted);a.baselineAdmitted+=Number(base.admitted);
     if(row.admitted&&base.admitted){a.paired++;a.delta+=row.netReturn-base.netReturn;a.drawdownDelta+=row.maxDrawdown-base.maxDrawdown;}
    }
   }
  };
  for await(const line of createInterface({input:fs.createReadStream(path.join(root,`${phase}-${period}.jsonl`)),crlfDelay:Infinity})){
   const row=JSON.parse(line);if(!inRegisteredPopulation(row))continue;
   const k=[phase,period,row.setting,row.regime,row.year,row.admitted,row.reason??''].join('|');
   if(!groups.has(k))groups.set(k,{phase,period,setting:row.setting,regime:row.regime,year:row.year,admitted:row.admitted,reason:row.reason??'',count:0});
   groups.get(k).count++;
   if(phase==='phase-c-risk'){
    if(row.admitted){
     const relationship=row.path===row.markPath?'same extremum order':'opposite extremum order',tk=[period,row.setting,relationship].join('|');
     if(!timing.has(tk))timing.set(tk,{period,setting:row.setting,relationship,n:0,netReturn:0,maxDrawdown:0,worstDrawdown:0,negativeEquity:0,liquidations:0});
     const t=timing.get(tk);t.n++;t.netReturn+=row.netReturn;t.maxDrawdown+=row.maxDrawdown;t.worstDrawdown=Math.max(t.worstDrawdown,row.maxDrawdown);t.negativeEquity+=Number(row.netReturn < -1);t.liquidations+=Number(row.liquidated);
    }
    if(row.liquidated)liquidations.push({period,setting:row.setting,market:row.market,timeframe:row.timeframe,launchAt:row.launchAt,horizonDays:row.horizonDays,direction:row.direction,path:row.path,markPath:row.markPath,regime:row.regime,year:row.year,source:row.source,leverage:row.leverage,projectionAdmitted:row.admitted,projectionDenial:row.reason,netReturn:row.netReturn,maxDrawdown:row.maxDrawdown,liquidationSnapshot:row.liquidationSnapshot});
    const next=[row.market,row.timeframe,row.launchAt,row.horizonDays].join('|');
    if(next!==key){flush();rows=[];key=next;}rows.push(row);
   }
  }
  flush();
 }
}
const pairs=[...stopPairs.values()].map(r=>({...r,meanReturnDelta:r.paired?r.delta/r.paired:null,meanDrawdownDelta:r.paired?r.drawdownDelta/r.paired:null}));
csv('ADMISSIONS-REJECTIONS-BY-YEAR-REGIME.csv',[...groups.values()]);
csv('EVERY-LIQUIDATION.csv',liquidations);csv('STOP-DISTANCE-BY-LEVERAGE.csv',pairs);
csv('LEVERAGE-TIMING-SENSITIVITY.csv',[...timing.values()].map(r=>({...r,meanReturn:r.netReturn/r.n,meanDrawdown:r.maxDrawdown/r.n})));
fs.writeFileSync(path.join(root,'stop-distance-pairs.json'),JSON.stringify({method:'Descriptive matched wider-stop comparison at the same window/leverage/fees; projected launch denials excluded from returns. No post-confirmation reselection.',rows:pairs},null,2)+'\n');
console.log(`Supplemental audit: ${groups.size} year/regime admission groups, ${liquidations.length} liquidations, ${pairs.length} stop-distance comparisons`);
