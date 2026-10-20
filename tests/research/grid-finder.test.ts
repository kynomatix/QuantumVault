import {expect,it,vi} from 'vitest';
import fs from 'node:fs';
vi.mock('../../server/grid-planner/finder-candle-cache',()=>({createFinderCandleReader:vi.fn()}));
import {qualifyRangingMarket} from '../../server/grid-planner/scanner';
import {closedHistory,rankSelections,armMembership,proxyCalendar,summary,selectDevelopment,SETTINGS} from '../../scripts/research/grid-finder/core.mjs';
import {extractScanner} from '../../scripts/research/grid-finder/source.mjs';
import {liquidationPrice,liquidationCrossing,maintenanceRate} from '../../scripts/research/grid-backtest-r2/risk.mjs';
const duration=3600000,launch=Date.UTC(2026,0,4);
const candles=()=>Array.from({length:102},(_,i)=>({time:launch+(i-100)*duration,open:100,high:102,low:98,close:100,volume:1,
  provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',finality:'finalized',timeSemantic:'open_time'}}));
it('excludes the launch candle and all future observations',()=>{
  const bars=candles(), before=closedHistory(bars,launch,duration);
  bars[100].close=999; bars[101].high=999;
  expect(closedHistory(bars,launch,duration)).toEqual(before);
  expect(before).toHaveLength(100); expect(before.at(-1).time+duration).toBe(launch);
});
it('refuses missing, stale and gapped finder histories',()=>{
  const bars=candles();
  expect(closedHistory(bars.slice(1),launch,duration)).toBeNull();
  expect(closedHistory(bars.slice(0,99),launch,duration)).toBeNull();
  expect(closedHistory(bars.filter((_,i)=>i!==40),launch,duration)).toBeNull();
});
it('uses actual shipped qualification on finalized direct candles',()=>{
  const bars=closedHistory(candles(),launch,duration);
  expect(qualifyRangingMarket('EXAMPLE-PERP','EXAMPLE','1h',bars,launch,launch).state).toBe('ranging');
  expect(qualifyRangingMarket('EXAMPLE-PERP','EXAMPLE','1h',bars.slice(1),launch,launch).state).toBe('unavailable');
  const direct=bars.map(b=>({...b,provenance:{...b.provenance,source:'pacifica',venue:'pacifica'}}));
  expect(qualifyRangingMarket('EXAMPLE-PERP','EXAMPLE','1h',direct,launch,launch).state).toBe('unavailable');
});
it('rejects a measured trend without classifying it as missing',()=>{
  const bars=closedHistory(candles(),launch,duration).map((b,i)=>({...b,open:100+i,close:100+i,high:102+i,low:98+i}));
  expect(qualifyRangingMarket('EXAMPLE-PERP','EXAMPLE','1h',bars,launch,launch).state).toBe('not-ranging');
});
it('preserves exact qualification body in the research loader',()=>{
  const source=fs.readFileSync('server/grid-planner/scanner.ts','utf8'), extracted=extractScanner(source);
  const begin=source.indexOf('export function qualifyRangingMarket('), end=source.indexOf('/** One on-demand batch per process;');
  expect(extracted.slice(extracted.indexOf('export function qualifyRangingMarket('))).toBe(source.slice(begin,end));
  expect(extracted).not.toContain('createFinderCandleReader');
});
it('ranks full precision before symbols and does not rank rejected or missing markets',()=>{
  const rows=rankSelections([{symbol:'Z',state:'ranging',adx:10},{symbol:'A',state:'ranging',adx:10},
    {symbol:'B',state:'ranging',adx:9.99},{symbol:'C',state:'unavailable',adx:null},{symbol:'D',state:'not-ranging',adx:30}]);
  expect(rows.map(r=>r.rank)).toEqual([3,2,1,null,null]);
  expect(armMembership(rows[2])).toEqual(['BLIND','FINDER','TOP1','TOP2']);
  expect(armMembership(rows[1])).toEqual(['BLIND','FINDER','TOP2']);
  expect(armMembership(rows[3])).toEqual(['BLIND']);
  expect(armMembership(rows[4])).toEqual(['BLIND','AGAINST']);
});
it('does not backfill top one when its launch is rejected',()=>{
  const ranked=rankSelections([{symbol:'A',adx:1,state:'ranging'},{symbol:'B',adx:2,state:'ranging'}]);
  expect(armMembership(ranked[1])).not.toContain('TOP1');
});
it('restricts proxy horizons wholly to the registered 2022 through 2025 window',()=>{
  const rows=proxyCalendar(duration,new Map(),[]);
  expect(rows.length).toBeGreaterThan(400);
  expect(rows.every(r=>r.year>=2022&&r.year<=2025&&r.endAt<=Date.UTC(2026,0,1))).toBe(true);
  expect(rows.every(r=>new Date(r.launchAt).getUTCDay()===0)).toBe(true);
  expect(rows.every(r=>r.reason==='missing_boundary')).toBe(true);
});
it('counts only admissions and keeps scenario rows distinct from market launches',()=>{
  const base={admitted:true,launchAt:launch,market:'EXAMPLE',timeframe:'1h',protectiveStop:0,liquidated:false,maxDrawdown:0.1};
  const s=summary([{...base,netReturn:0.1},{...base,netReturn:-0.02},{...base,admitted:false,netReturn:99}]);
  expect(s.runs).toBe(2);expect(s.mean).toBeCloseTo(0.04);expect(s.median).toBeCloseTo(0.04);
  expect(s.admittedLaunches).toBe(1);expect(s.profitable).toBe(0.5);
});
it('never selects a profitable-looking filter from too few launch weeks',()=>{
  const row={admitted:true,launchAt:launch,market:'EXAMPLE',timeframe:'1h',setting:'b100-L1',selectionState:'ranging',
    path:'OHLC',arms:['BLIND','FINDER','TOP1','TOP2'],netReturn:0.5,protectiveStop:0,liquidated:false,maxDrawdown:0.1};
  expect(selectDevelopment([row]).selected).toBe('no qualifying filter');
});
it('enumerates all twelve fixed fee and leverage scenarios',()=>{
  expect(SETTINGS).toHaveLength(12);
  expect(new Set(SETTINGS.map(s=>s.id)).size).toBe(12);
  expect(SETTINGS.find(s=>s.id==='b100-L1').makerRate).toBeCloseTo(0.00115);
  expect(SETTINGS.find(s=>s.id==='b0-L5').takerRate).toBeCloseTo(0.0004);
});
it('retains round-two maintenance and liquidation crossing equations on both sides',()=>{
  for(const [cash,q,from,to] of [[-900,10,100,80],[1100,-10,100,120]]){
    const price=liquidationPrice(cash,q,50), at=liquidationCrossing(cash,q,50,from,to);
    expect(cash+q*price).toBeCloseTo(Math.abs(q)*price*maintenanceRate(50),10);
    expect(from+(to-from)*at).toBeCloseTo(price,10);
  }
  expect(liquidationCrossing(1000,0,50,100,0)).toBeNull();
});
