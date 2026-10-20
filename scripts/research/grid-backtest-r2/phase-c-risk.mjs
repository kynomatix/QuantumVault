import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {geometryAt,widerGeometry} from '../grid-defaults/geometry.mjs';
import {fixedReplay} from './fixed-replay.mjs';
import {Stats} from './stats.mjs';
import {loadData,windows,sha256} from './data.mjs';
import {publicData} from './public-data.mjs';
import {projection} from './projection.mjs';
import {riskSettings} from './risk-settings.mjs';
const root=process.argv[2],started=Date.now(),data=loadData(),publicFacts=publicData(root,data),settings=riskSettings(root),stats=new Stats(),unsafe=new Stats();
const baseline='family0-L1';
fs.writeFileSync(path.join(root,'phase-c-risk-method.json'),JSON.stringify({settings,baseline,publicFacts,bindings:data.bindings,
 method:'Four equal-duration linear OHLC/OLHC mark/trade combinations, not guaranteed bounds. Prior proxy mark equals traded price, explicitly unavailable as actual historical mark. Current maintenance limits; historical tier changes unknown. Fully collateral-funded standalone account, no cross-market offsets. Market liquidation fee plus documented liquidation charge; below backstop threshold remaining isolated account is forfeited. Positive funding pays long/credits short. No missing payments imputed. Research investment remains 1000, rather than live fee-reserved investment.',
 unsafe:'Actual planner accepted, actual stop projection rejected; diagnostic only, excluded from admitted safe return.',
 close:'Completed traded close; protective touch is mark. Funding settlement intrabar timing is interpolated, not observed tick order.',
 createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
for(const period of ['development','evaluation','proxy']){
 const fd=fs.openSync(path.join(root,`phase-c-risk-${period}.jsonl`),'wx');
 for(const d of data.datasets){
  const gs=new Map(),ps=new Map(),moveDecisionCache=new Map();
  for(const w of windows(d,period)){
   const scenario=new Map();
   const dataReason=w.reason??(d.markBars.slice(w.start,w.end).some(b=>!b)?'missing actual Pacifica mark candle':d.fundingCoverage.slice(w.start,w.end).some(x=>!x)?'incomplete settled funding coverage':null);
   for(const s of settings){
    const gkey=[w.launchAt,s.window,s.multiplier].join('|');
    if(!gs.has(gkey)){const g=w.start<0?{ok:false,reason:'missing launch'}:await geometryAt(d.bars,d.timeframe,w.start,d.market,s.window);gs.set(gkey,g.ok?{...g,geometry:widerGeometry(g.geometry,s.multiplier,d.market.tick)}:g);}
    const g=gs.get(gkey);
    for(const direction of ['long','short']){
     const pk=[w.launchAt,s.id,direction].join('|');
     if(!ps.has(pk)){
      let policy=null,reason=g.ok?null:g.reason,clearance=null;
      if(!reason)try{
       policy=makeTrailGrid({market:d.market,direction,mode:s.mode,seed:true,geometry:g.geometry,intervals:s.intervals,
        economics:{investment:'1000.00',leverage:s.leverage,makerRate:String(s.makerRate),takerRate:String(s.takerRate)}},String(d.bars[w.start-1].close));
       clearance=projection(policy,d.market,d.maxLeverage,s.makerRate,s.takerRate,w.launchAt);
      }catch(e){reason=e.message;}
      ps.set(pk,{policy,reason,clearance});
     }
     const p=ps.get(pk);
     for(const pathName of ['OHLC','OLHC'])for(const markPath of ['OHLC','OLHC']){
      let reason=dataReason??p.reason;
      if(s.stopMode==='1h-close'&&d.timeframe!=='1h')reason='uncomputed: 1h close on 4h strategy';
      const base={period,setting:s.id,market:d.symbol,timeframe:d.timeframe,launchAt:w.launchAt,horizonDays:w.horizonDays,regime:w.regime,year:w.year,source:w.source,direction,path:pathName,markPath,markProxy:w.source!=='pacifica',leverage:s.leverage,clearance:p.clearance};
      let result=null;
      if(!reason){
       const r=fixedReplay({candles:d.bars,dataHolds:d.dataHolds,market:d.market,timeframe:d.timeframe,start:w.start,end:w.end,policy:p.policy,
        path:pathName,markPath,markBars:d.markBars,fundingEvents:d.fundingEvents,maxLeverage:d.maxLeverage,
        makerRate:s.makerRate,takerRate:s.takerRate,moveMode:s.moveMode,stopMode:s.stopMode,moveDecisionCache});
       if(r.unavailable)reason=r.unavailable;
       else result={netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,fees:r.fees,fillCount:r.fillCount,protectiveStop:r.protectiveStop,moves:r.moves,
        funding:r.funding,liquidated:r.liquidated,liquidationSnapshot:r.liquidationSnapshot,liquidationFees:r.liquidationFees,seedHold:r.seedHold};
      }
      const diagnostic={...base,admitted:!reason,reason,...result};
      const safe={...base,...result,admitted:!reason&&p.clearance?.state==='available',reason:reason??(p.clearance?.state==='available'?null:p.clearance?.reason)};
      // Unsafe admitted rows are exclusively policies rejected by live stop clearance.
      if(!reason&&p.clearance?.state!=='available')unsafe.record(diagnostic);
      stats.record(safe);scenario.set([s.id,direction,pathName,markPath].join('|'),safe);
      fs.writeSync(fd,JSON.stringify({...safe,unsafeDiagnostic:!reason&&!safe.admitted?result:null})+'\n');
     }
    }
   }
   for(const direction of ['long','short'])for(const p of ['OHLC','OLHC'])for(const mp of ['OHLC','OLHC'])for(const s of settings)stats.pair(scenario.get([s.id,direction,p,mp].join('|')),scenario.get([baseline,direction,p,mp].join('|')));
  }
  console.log(`Risk ${period} ${d.symbol} ${d.timeframe}: ${stats.admitted}/${stats.total}; unsafe ${unsafe.admitted}`);
 }
 fs.closeSync(fd);
 if(period==='development')fs.writeFileSync(path.join(root,'phase-c-risk-selection.json'),JSON.stringify(stats.select(settings.map(s=>s.id),baseline),null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(root,'phase-c-risk-summary.json'),JSON.stringify({...stats.json(),unsafe:unsafe.json(),seconds:(Date.now()-started)/1000,host:os.hostname(),workers:1},null,2)+'\n');
 fs.writeFileSync(path.join(root,`phase-c-risk-${period}-complete.json`),JSON.stringify({runsSha256:sha256(fs.readFileSync(path.join(root,`phase-c-risk-${period}.jsonl`))),selectionSha256:sha256(fs.readFileSync(path.join(root,'phase-c-risk-selection.json')))},null,2)+'\n');
}
