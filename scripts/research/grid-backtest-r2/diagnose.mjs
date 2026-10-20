import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makeTrailGrid} from '../../../server/grid-bot/trail-backtest.ts';
import {retainedGridCycles} from '../../../server/grid-bot/cycle-policy.ts';
import {gridPolicyExtension,stableGridExtension} from '../../../server/grid-bot/behaviour-policy.ts';
const [out]=process.argv.slice(2),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const previous='C:/Apps/Replit/conductor-worktrees/grid-defaults-backtest-20261020-handback/evidence/defaults-20261019T214700Z';
const source='C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence/candles-validated-20261019';
const manifest=read(path.join(source,'manifest.json'));
const geometries=fs.readFileSync(path.join(previous,'geometry-development.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const rows=[];
for(const g of geometries.filter(g=>g.ok&&g.window==='week').slice(0,12)){
  const md=manifest.markets.find(m=>m.symbol===g.symbol),ds=manifest.datasets.find(d=>d.symbol===g.symbol&&d.timeframe===g.timeframe);
  const bars=read(path.join(source,ds.file)).rows;
  const row=bars.findLast(b=>Number(b[0])<g.launchAt);
  if(!row)throw Error('Missing diagnostic reference');
  const market={symbol:g.symbol,tick:md.tick_size,lot:md.lot_size,minimumQuote:md.min_order_size,maximumQuote:md.max_order_size,minimumPrice:md.tick_size,maximumPrice:md.max_tick};
  for(const intervals of [6,10,14,20,30,50]){
    let reason=null;
    globalThis.__r2DiagnosticPolicy=null;
    try{makeTrailGrid({market,direction:'long',seed:true,mode:'step_back',geometry:g.geometry,intervals},String(row[4]));}catch(error){reason=error.message;}
    const p=globalThis.__r2DiagnosticPolicy,cycles=p&&retainedGridCycles(p);
    rows.push({symbol:g.symbol,timeframe:g.timeframe,launchAt:g.launchAt,intervals,reason,requestedUpper:g.geometry.upper,policyUpper:p?.upperPrice,lastLevel:p?.levels.at(-1)?.price,
      upperMatches:p?.upperPrice===p?.levels.at(-1)?.price,cyclesValid:!!cycles,extensionMatches:!!cycles&&stableGridExtension(p.gridPolicyExtension)===stableGridExtension(gridPolicyExtension(cycles,p.gridPolicyExtension.mode,p.safetyEnvelopePrice,true,true,p.gridPolicyExtension.seedPriceBounds))});
  }
}
fs.writeFileSync(path.join(out,'canonical-diagnosis.json'),JSON.stringify({createdAt:new Date().toISOString(),baseCommitHash:'9fa9fa5ce0bb0cb710c99f8ea70159580822592a',rows},null,2)+'\n');
console.log(JSON.stringify({cases:rows.length,failed:rows.filter(r=>r.reason).length,endpointMismatches:rows.filter(r=>!r.upperMatches).length,sample:rows.find(r=>r.reason)}));
