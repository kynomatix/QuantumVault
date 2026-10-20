import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {HOUR,DAY,RULES,SETTINGS,validHistory,chooseSignal,spacedTouches,varianceRatio,features,
  evaluateRules,memberships,candidate,selectDevelopment,confirmation,tally,lowerBound}
  from '../../scripts/research/grid-entry-filters/core.mjs';
const launch=Date.UTC(2026,0,4);
const bars=()=>Array.from({length:842},(_,i)=>({time:launch+(i-840)*HOUR,open:100,close:100,
  high:101,low:99,volume:1,provenance:{source:'okx',venue:'okx',basis:'perp',
    proxy:'direct',finality:'finalized',timeSemantic:'open_time'}}));
const fixture=()=>({position:.5,anchorPosition:.5,lowerTouches:2,upperTouches:2,aged:true,
  adx:19,volatility:.02,volatilityP20:.01,vr:.8,return28:.05,return7:.03,finderState:'ranging'});
it('loads reused replay and geometry through the documented plain Node loader',()=>{
  const source="import {geometryAt} from './scripts/research/grid-defaults/geometry.mjs';"+
    "import {fixedReplay} from './scripts/research/grid-backtest-r2/fixed-replay.mjs';"+
    "import {chooseSignal} from './scripts/research/grid-entry-filters/core.mjs';"+
    "if([geometryAt,fixedReplay,chooseSignal].some(f=>typeof f!=='function'))throw Error('Missing function');";
  execFileSync(process.execPath,['--experimental-transform-types','--import','./scripts/research/grid-finder/loader.mjs',
    '--input-type=module','-e',source],{timeout:30000,env:{...process.env,FINDER_INPUT_MAP:''}});
});
it('requires 35 complete closed days and ignores forming or future price changes',()=>{
  const b=bars(),before=validHistory(b,launch);
  b[840].close=100000;b[841].high=100000;
  expect(validHistory(b,launch)).toEqual(before);
  expect(before).toHaveLength(840);
  expect(validHistory(b.slice(1),launch)).toBeNull();
  expect(validHistory(b.filter((_,i)=>i!==200),launch)).toBeNull();
  expect(validHistory(b,launch+HOUR/2)).toBeNull();
});
it('uses full-window source fallback and never stitches incompatible venues',()=>{
  const b=bars(),g=b.map(x=>({...x,provenance:{...x.provenance,source:'gate',venue:'gate'}}));
  const measure=()=>({state:'ranging',adx:10});
  expect(chooseSignal([{venue:'okx',bars:b},{venue:'gate',bars:g}],launch,measure).venue).toBe('okx');
  expect(chooseSignal([{venue:'okx',bars:b.slice(1)},{venue:'gate',bars:g}],launch,measure).venue).toBe('gate');
  b[50].provenance.source='gate';
  expect(validHistory(b,launch)).toBeNull();
});
it('rejects malformed finalized OHLC and unavailable finder states',()=>{
  const b=bars();b[500].low=110;
  expect(validHistory(b,launch)).toBeNull();
  expect(chooseSignal([{venue:'okx',bars:bars()}],launch,()=>({state:'unavailable',adx:10}))).toBeNull();
});
it('counts independent boundary visits no more than once each 24 hours',()=>{
  const b=bars().slice(0,49);
  expect(spacedTouches(b,()=>true)).toBe(3);
  expect(spacedTouches(b.slice(0,24),()=>true)).toBe(1);
  expect(spacedTouches(b,x=>x.time===b[0].time||x.time===b[23].time)).toBe(1);
});
it('freezes age boundaries before validation so a later breakout fails age',()=>{
  const h=validHistory(bars(),launch),f=features(h,{adx:10,state:'ranging'});
  expect(f.aged).toBe(true);
  h[800]={...h[800],open:103,close:103,high:104,low:102};
  const broken=features(h,{adx:10,state:'ranging'});
  expect(broken.anchorUpper).toBe(101);expect(broken.aged).toBe(false);
  expect(broken.upper).toBe(104);
});
it('computes reversion from returns and treats zero variance as unavailable',()=>{
  const alternating=Array.from({length:337},(_,i)=>100*Math.exp(i%2 ? .01 : 0));
  expect(varianceRatio(alternating)).toBeCloseTo(0,10);
  expect(varianceRatio(Array(337).fill(100))).toBeNull();
  const rules=evaluateRules({...fixture(),vr:null});
  expect(rules.R4_REVERSION.state).toBe('unavailable');
  expect(rules.R9_AGED_REVERSION.state).toBe('unavailable');
  expect(rules.R1_ESTABLISHED.state).toBe('pass');
});
it('uses closed endpoints for exact returns and nearest-rank volatility percentile',()=>{
  const h=validHistory(bars(),launch);
  h[839]={...h[839],close:100.5};
  const f=features(h,{adx:10,state:'ranging'});
  expect(f.return28).toBeCloseTo(.005);
  expect(f.return7).toBeCloseTo(.005);
  expect(f.volatilityP20).toBeCloseTo(.02);
  expect(f.volatility).toBeCloseTo(2/100.5);
});
it('enforces registered thresholds, rejected-quiet identity and conjunctions',()=>{
  const f=fixture(),r=evaluateRules(f);
  expect(r.R1_ESTABLISHED.state).toBe('pass');expect(r.R4_REVERSION.state).toBe('pass');
  expect(r.R5_FLAT.state).toBe('pass');expect(r.R6_REJECTED_QUIET.state).toBe('fail');
  expect(evaluateRules({...f,volatility:f.volatilityP20}).R3_NOT_SQUEEZED.state).toBe('fail');
  expect(evaluateRules({...f,adx:20}).R3_NOT_SQUEEZED.state).toBe('fail');
  expect(evaluateRules({...f,adx:25,finderState:'not-ranging'}).R6_REJECTED_QUIET.state).toBe('pass');
  expect(evaluateRules({...f,position:.600001}).R8_ESTABLISHED_VOL.state).toBe('fail');
  expect(evaluateRules({...f,aged:false}).R9_AGED_REVERSION.state).toBe('fail');
  expect(memberships(evaluateRules(null),false)).toEqual(['BLIND']);
  expect(SETTINGS).toHaveLength(8);expect(RULES).toHaveLength(9);
});
function rows(weeks=20){
  const result=[];
  for(let i=0;i<weeks;i++)for(const market of ['EXAMPLE_A','EXAMPLE_B','EXAMPLE_C'])
    for(const direction of ['long','short'])for(const horizonDays of [14,30])
      for(const path of ['OHLC','OLHC'])for(const markPath of ['OHLC','OLHC'])
        result.push({period:'development',launchAt:launch+i*7*DAY,market,timeframe:'1h',window:'week',
          setting:'b100-L1',direction,horizonDays,path,markPath,admitted:true,reason:null,
          arms:['BLIND','BLIND_MEASURABLE',...(market!=='EXAMPLE_C'?['R1_ESTABLISHED']:[])],
          netReturn:market==='EXAMPLE_C'?-.06:.02,maxDrawdown:market==='EXAMPLE_C'?.2:.03,
          protectiveStop:false,liquidated:false,seedHold:false});
  return result;
}
it('selects one full development configuration and refuses inadequate coverage or side losses',()=>{
  expect(selectDevelopment(rows()).selected).toEqual({rule:'R1_ESTABLISHED',window:'week',setting:'b100-L1'});
  expect(selectDevelopment(rows(19)).selected).toBeNull();
  const r=rows();r.forEach(x=>{if(x.direction==='short')x.netReturn=-.01;});
  expect(selectDevelopment(r).selected).toBeNull();
});
it('compares only same represented weeks while retention keeps the full measurable denominator',()=>{
  const r=rows(),extra=rows(1).map(x=>({...x,launchAt:launch-7*DAY,
    arms:['BLIND','BLIND_MEASURABLE'],netReturn:1}));
  const c=candidate([...r,...extra],'R1_ESTABLISHED');
  expect(c.blind.weeks).toBe(20);
  expect(c.blind.mean).toBeCloseTo(-.02/3);
  expect(c.retention).toBeCloseTo(40/63);
});
it('confirmation cannot repick and checks return and matched lift bounds with lag four',()=>{
  expect(confirmation(rows(),null).state).toBe('not selected');
  const s=selectDevelopment(rows()).selected;
  expect(confirmation(rows(),s).passed).toBe(true);
  const r=rows().map(x=>({...x,netReturn:x.arms.includes('R1_ESTABLISHED')?-.01:.03}));
  expect(confirmation(r,s).passed).toBe(false);
  expect(lowerBound(Array(20).fill(.02),4)).toBeCloseTo(.02);
});
it('counts admitted scenarios once despite arm overlap and rejects duplicate identities',()=>{
  const r=rows(1),expected=r.length;
  const counts=tally(r);
  expect(counts.admitted).toBe(expected);expect(counts.memberships).toBeGreaterThan(expected);
  expect(()=>tally([...r,r[0]])).toThrow('Duplicate simulation identity');
  r[0]={...r[0],admitted:false,reason:'missing funding'};
  expect(tally(r).rejections).toEqual({'missing funding':1});
});
