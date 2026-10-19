import {describe,it,expect,vi} from 'vitest';
vi.mock('../../server/grid-planner/candle-pool',()=>({PLANNER_CANDLE_SOURCES:[]}));
vi.mock('../../server/lab/datafeed',()=>({readPlannerPerpSource:vi.fn()}));
vi.mock('../../server/grid-planner/pacifica-candles',()=>({pacificaPerpWindow:vi.fn()}));
import {aggregateStructureWeeks,computeWeeklyStructure} from '../../server/grid-planner/weekly-structure';
import {classifySignals,closedWindow,signalAt,toBars,metrics,DAY} from '../../scripts/research/grid-direction/core.mjs';
import {btcUtcWeekStart,BTC_TREND_WEEK_MS as WEEK} from '../../shared/grid-direction';
const launch=Date.UTC(2026,9,18),completed=btcUtcWeekStart(launch);
const views=(dirs:string[])=>dirs.map((direction,i)=>({name:['Macro','Weekly structure','Trend','Funding'][i],direction:direction==='unavailable'?'neutral':direction,unavailable:direction==='unavailable'}));
const macro=(source='okx-index',basis='index',n=50)=>({source,basis,rows:Array.from({length:n},(_,i)=>[completed-(n-i)*WEEK,String(100+i)])});
const series=(tf:string,n=260)=>{const ms=tf==='1h'?3600000:14400000;return toBars(Array.from({length:n+2},(_,i)=>[launch-(n-i)*ms,100+i,102+i,99+i,101+i,1]),'okx');};
const days=toBars(Array.from({length:365},(_,i)=>[completed-364*DAY+i*DAY,100+10*Math.sin(i/20),115+10*Math.sin(i/20),85+10*Math.sin(i/20),100+10*Math.sin(i/20),1]),'okx');
const at=(tf='1h',extra={})=>signalAt({market:'BTC',timeframe:tf,launchAt:launch,macroSources:[macro()],sources:[{venue:'okx',bars:series(tf),days}],aggregateStructureWeeks,computeWeeklyStructure,...extra});
describe('preregistered direction research',()=>{
  it('separates against, neutral and unavailable',()=>{expect(classifySignals(views(['long','short','neutral','unavailable']),'long')).toMatchObject({Macro:'aligned','Weekly structure':'against',Trend:'neutral/mixed',Funding:'unavailable','All available agree':'neutral/mixed','Majority agree':'neutral/mixed'});});
  it('counts available neutral votes in the strict-majority denominator',()=>{expect(classifySignals(views(['long','neutral','unavailable','unavailable']),'long')['Majority agree']).toBe('neutral/mixed');expect(classifySignals(views(['long','long','neutral','unavailable']),'short')['Majority agree']).toBe('against');});
  it('makes single-signal consensus explicit and zero signals unavailable',()=>{expect(classifySignals(views(['short','unavailable','unavailable','unavailable']),'short')['All available agree']).toBe('aligned');expect(classifySignals(views(['unavailable','unavailable','unavailable','unavailable']),'long')['All available agree']).toBe('unavailable');});
  it('includes the candle ending at launch and excludes forming/future candles',()=>{const a=closedWindow(series('1h'),launch,3600000,200);expect(a).toHaveLength(200);expect(a.at(-1).time).toBe(launch-3600000);expect(a[0].time).toBe(launch-200*3600000);});
  it('does not fill a gapped time window by pulling older bars',()=>{const a=series('1h').filter(b=>b.time!==launch-2*3600000);expect(closedWindow(a,launch,3600000,200)).toHaveLength(199);expect(at('1h',{sources:[{venue:'okx',bars:a,days}]}).trend.state).toBe('unavailable');});
  it('uses exactly the shipped WEEK planner 200/100 context counts',()=>{expect(at('1h').inputAudit.trendBars).toBe(200);expect(at('4h').inputAudit.trendBars).toBe(100);});
  it('reuses the latest completed UTC week and falls back for insufficient history',()=>{const s=at('1h',{macroSources:[macro('okx-index','index',49),macro('gate-spot','spot')]});expect(s.macro.source).toBe('gate-spot');expect(s.macro.asOf).toBe(completed);expect(s.macro.lastClose).toBe(149);expect(s.macro.movingAverage).toBe(124.5);});
  it('is invariant to arbitrary future price mutations',()=>{const before=at(),bars=series('1h');for(const b of bars.filter(b=>b.time>=launch)){b.close=999999;b.high=999999;}const futureMacro={...macro(),rows:[...macro().rows,[completed,'999999']]};const after=at('1h',{sources:[{venue:'okx',bars,days}],macroSources:[futureMacro]});expect(after).toEqual(before);});
  it('keeps funding unavailable and all signal close boundaries before launch',()=>{const s=at();expect(s.funding.state).toBe('unavailable');for(const [k,v]of Object.entries(s.inputAudit))if(k.startsWith('latest')&&v!==null)expect(v).toBeLessThanOrEqual(launch);});
  it('reports median, stop rate, worst drawdown and deduplicated launches',()=>{const rows=[-0.25,0.125,0.375,0].map((netReturn,i)=>({netReturn,stopped:i===0,maxDrawdown:i/10,market:'BTC',timeframe:'1h',launchAt:launch}));expect(metrics(rows)).toMatchObject({runs:4,launches:1,meanReturn:0.0625,medianReturn:0.0625,profitableShare:0.5,stopRate:0.25,worstDrawdown:0.3});});
});
// Source-only adapter is explicit, guarded, and never relabels input candles.
import {readFileSync} from 'node:fs';
import {allowResearchProxyPolicy,originalSourceGuard,researchSourceGuard} from '../../scripts/research/grid-direction/proxy-policy.mjs';
it('allows only the declared replay venues without changing other engine code',()=>{
 const source=readFileSync('server/grid-bot/trail-policy.ts','utf8');
 expect(allowResearchProxyPolicy(source)).toBe(source.replace(originalSourceGuard,researchSourceGuard));
 expect(()=>allowResearchProxyPolicy('changed')).toThrow();
 const rejected=new Function('c',`return ${researchSourceGuard}`);
 for(const venue of ['pacifica','okx'])expect(rejected({provenance:{source:venue,venue}})).toBe(false);
 expect(rejected({provenance:{source:'okx',venue:'pacifica'}})).toBe(true);
 expect(rejected({provenance:{source:'EXAMPLE',venue:'EXAMPLE'}})).toBe(true);
 expect(rejected({})).toBe(true);
});it('selects a full 252-bar 1h pool before truncating to 200 indicator bars',()=>{
 const short=series('1h',220),full=series('1h').map(b=>({...b,provenance:{...b.provenance,source:'gate',venue:'gate'}}));
 const s=at('1h',{sources:[{venue:'okx',bars:short,days},{venue:'gate',bars:full,days}]});
 expect(s.inputAudit.trendSource).toBe('gate');expect(s.inputAudit.requestedPoolBars).toBe(252);expect(s.inputAudit.trendBars).toBe(200);
});
