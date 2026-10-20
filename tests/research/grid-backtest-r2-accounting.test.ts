import {it,expect} from 'vitest';
import {makeTrailGrid} from '../../server/grid-bot/trail-backtest';
import {fixedReplay} from '../../scripts/research/grid-backtest-r2/fixed-replay.mjs';
import {liquidationPrice,liquidationCrossing,maintenanceRate} from '../../scripts/research/grid-backtest-r2/risk.mjs';
import frozen from './fixtures/grid-backtest-r2.json';
import economic from './fixtures/grid-backtest-r2-risk.json';
import {projection} from '../../scripts/research/grid-backtest-r2/projection.mjs';
import {projectGridStop} from '../../server/grid-bot/stop-clearance';
import {rejectionKind} from '../../scripts/research/grid-backtest-r2/rejection-kind.mjs';
for(const [index,c] of economic.cases.entries()){
 it(`leveraged reference accounting ${index}`,()=>{
  expect(c.policy.leverage).toBe(c.leverage);
  const r=fixedReplay({policy:c.policy,market:c.market,candles:c.bars,start:100,end:130,timeframe:'1h',path:'OHLC'});
  for(const k of ['netReturn','fees','fillCount'])expect(r[k],k).toBeCloseTo(Number(c.expected[k]),8);
 });
}
