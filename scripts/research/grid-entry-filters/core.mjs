import {closedHistory, summary} from '../grid-finder/core.mjs';
export {closedHistory, summary};
export const HOUR = 3600000, DAY = 24 * HOUR;
export const RULES = ['R1_ESTABLISHED','R2_AGED','R3_NOT_SQUEEZED','R4_REVERSION','R5_FLAT',
  'R6_REJECTED_QUIET','R7_MIDDLE','R8_ESTABLISHED_VOL','R9_AGED_REVERSION'];
export const SETTINGS = [0.001,0.0005,0.0002,0].flatMap(builderRate => [1,3].map(leverage => ({
  id:`b${Math.round(builderRate*100000)}-L${leverage}`,builderRate,leverage,
  makerRate:0.00015+builderRate,takerRate:0.0004+builderRate})));
const average = a => a.length ? a.reduce((s,v) => s+v,0)/a.length : null;
const variance = a => {const m=average(a);return a.length>1 ? a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1) : null;};
export function validHistory(bars, launchAt) {
  const h=closedHistory(bars,launchAt,HOUR,840);
  if (!h || h.some(b => ![b.open,b.high,b.low,b.close].every(v => Number.isFinite(v)&&v>0) ||
      !Number.isFinite(b.volume) || b.volume<0 || b.low>Math.min(b.open,b.close) ||
      b.high<Math.max(b.open,b.close) || b.provenance?.finality!=='finalized')) return null;
  const p=h[0].provenance;
  if (!['okx','gate'].includes(p?.source) || h.some(b => b.provenance.source!==p.source ||
      b.provenance.venue!==p.source || b.provenance.basis!=='perp' || b.provenance.proxy!=='direct' ||
      b.provenance.timeSemantic!=='open_time')) return null;
  return h;
}
export function chooseSignal(series, launchAt, measure) {
  for (const venue of ['okx','gate']) {
    const h=validHistory(series.find(d=>d.venue===venue)?.bars??[],launchAt);
    if (!h) continue;
    const measured=measure(h.slice(-100));
    if (measured.adx===null || !Number.isFinite(measured.adx) || measured.state==='unavailable') continue;
    return {venue,history:h,...measured};
  }
  return null;
}
export function spacedTouches(bars, predicate) {
  let last=-Infinity,count=0;
  for (const b of bars) if (predicate(b) && b.time-last>=DAY) {count++;last=b.time;}
  return count;
}
export function varianceRatio(closes) {
  const r=closes.slice(1).map((c,i)=>Math.log(c/closes[i])),v=variance(r);
  if (r.length!==336 || !Number.isFinite(v) || v<=0) return null;
  const sums=[];
  for(let i=0;i+24<=r.length;i++) sums.push(r.slice(i,i+24).reduce((s,x)=>s+x,0));
  const ratio=variance(sums)/(24*v);
  return Number.isFinite(ratio) ? ratio : null;
}
export function features(h, measured) {
  if(h.length!==840) throw Error('Exactly 840 closed hourly bars required');
  const recent=h.slice(-672),anchor=h.slice(-672,-336),validation=h.slice(-336),p=h.at(-1).close;
  const lower=Math.min(...recent.map(b=>b.low)),upper=Math.max(...recent.map(b=>b.high)),width=upper-lower;
  const anchorLower=Math.min(...anchor.map(b=>b.low)),anchorUpper=Math.max(...anchor.map(b=>b.high));
  if (!(width>0 && anchorUpper>anchorLower)) return null;
  const dailyVol=[];
  for(let daysAgo=27;daysAgo>=0;daysAgo--) {
    const end=h.length-1-daysAgo*24,trs=[];
    for(let i=end-13;i<=end;i++) trs.push(Math.max(h[i].high-h[i].low,
      Math.abs(h[i].high-h[i-1].close),Math.abs(h[i].low-h[i-1].close)));
    dailyVol.push(average(trs)/h[end].close);
  }
  return {lower,upper,position:(p-lower)/width,anchorLower,anchorUpper,
    anchorPosition:(p-anchorLower)/(anchorUpper-anchorLower),
    aged:validation.every(b=>b.close>=anchorLower&&b.close<=anchorUpper),
    lowerTouches:spacedTouches(recent,b=>b.low<=lower+0.1*width),
    upperTouches:spacedTouches(recent,b=>b.high>=upper-0.1*width),
    volatility:dailyVol.at(-1),volatilityP20:[...dailyVol].sort((a,b)=>a-b)[Math.ceil(.2*28)-1],
    vr:varianceRatio(h.slice(-337).map(b=>b.close)),return7:p/h.at(-169).close-1,
    return28:p/h.at(-673).close-1,adx:measured.adx,finderState:measured.state};
}
export function evaluateRules(f) {
  if(!f) return Object.fromEntries(RULES.map(id=>[id,{state:'unavailable',reason:'no complete authorized signal history'}]));
  const within=(v,lo,hi)=>v>=lo&&v<=hi;
  const pass=[
    f.lowerTouches>=2&&f.upperTouches>=2&&within(f.position,.4,.6),
    f.aged&&within(f.anchorPosition,.25,.75),
    f.adx<20&&f.volatility>f.volatilityP20,
    f.vr===null ? null : f.vr<=.8,
    Math.abs(f.return28)<=.05&&within(f.position,.25,.75),
    f.finderState==='not-ranging'&&within(f.adx,20,25)&&Math.abs(f.return7)<=.03,
    within(f.position,.4,.6),
  ];
  pass.push(pass[0]&&pass[2],pass[3]===null ? null : pass[1]&&pass[3]);
  return Object.fromEntries(RULES.map((id,i)=>[id,{state:pass[i]===null?'unavailable':pass[i]?'pass':'fail',
    reason:pass[i]===null?'zero or invalid hourly variance':pass[i]?null:'fixed condition not met'}]));
}
export function memberships(rules, measurable) {
  return ['BLIND',...(measurable?['BLIND_MEASURABLE']:[]),...RULES.filter(id=>rules[id].state==='pass')];
}
const launchKey=r=>`${r.launchAt}|${r.market}|${r.timeframe}`;
export function candidate(base, rule) {
  const group=base.filter(r=>r.arms.includes(rule)),stats=summary(group);
  const weeks=new Set(group.filter(r=>r.admitted).map(r=>r.launchAt));
  const measurable=base.filter(r=>r.arms.includes('BLIND_MEASURABLE'));
  const same=measurable.filter(r=>weeks.has(r.launchAt)),blind=summary(same),fullBlind=summary(measurable);
  const retention=fullBlind.admittedLaunches ? stats.admittedLaunches/fullBlind.admittedLaunches : 0;
  const marketMeans=[...new Set(group.filter(r=>r.admitted).map(r=>r.market))]
    .map(m=>summary(group.filter(r=>r.market===m)).mean);
  const strata={};
  for(const [key,values] of [['direction',['long','short']],['horizonDays',[14,30]],['path',['OHLC','OLHC']]])
    strata[key]=values.map(v=>summary(group.filter(r=>r[key]===v)).mean);
  const checks={weeks:stats.weeks>=20,retention:retention>=.2,mean:stats.mean!==null&&stats.mean>0,
    median:stats.median!==null&&stats.median>0,profitable:stats.profitable!==null&&stats.profitable>.5,
    lift:blind.mean!==null&&stats.mean!==null&&stats.mean>blind.mean,
    drawdown:blind.meanDrawdown!==null&&stats.meanDrawdown!==null&&stats.meanDrawdown<=blind.meanDrawdown,
    markets:marketMeans.length>0&&marketMeans.filter(x=>x>0).length>marketMeans.length/2,
    strata:Object.values(strata).flat().every(x=>x!==null&&x>0)};
  return {rule,...stats,retention,blind,marketMeans,strata,checks,qualifies:Object.values(checks).every(Boolean)};
}
export function configurations(rows) {
  const result=[];
  for(const window of ['week','month']) for(const setting of SETTINGS) {
    const base=rows.filter(r=>r.timeframe==='1h'&&r.window===window&&r.setting===setting.id);
    for(const rule of RULES)result.push({window,setting:setting.id,builderRate:setting.builderRate,
      leverage:setting.leverage,...candidate(base,rule)});
  }
  return result;
}
export function selectDevelopment(rows) {
  const candidates=configurations(rows);
  const q=candidates.filter(c=>c.qualifies).sort((a,b)=>b.weekLower95-a.weekLower95||b.mean-a.mean||
    a.meanDrawdown-b.meanDrawdown||b.builderRate-a.builderRate||a.leverage-b.leverage||
    a.window.localeCompare(b.window)||a.rule.localeCompare(b.rule));
  const c=q[0];
  return {selected:c?{rule:c.rule,window:c.window,setting:c.setting}:null,candidates};
}
export function lowerBound(values, lag=0) {
  if(values.length<2)return null;
  const n=values.length,m=average(values),res=values.map(v=>v-m);
  if(!lag)return m-1.96*Math.sqrt(variance(values)/n);
  let longVariance=res.reduce((s,v)=>s+v*v,0)/n;
  for(let k=1;k<=Math.min(lag,n-1);k++)
    longVariance+=2*(1-k/(lag+1))*res.slice(k).reduce((s,v,i)=>s+v*res[i],0)/n;
  return m-1.96*Math.sqrt(Math.max(0,longVariance)/n);
}
export function confirmation(rows, selected) {
  if(!selected)return {state:'not selected',passed:false};
  const base=rows.filter(r=>r.timeframe==='1h'&&r.window===selected.window&&r.setting===selected.setting);
  const c=candidate(base,selected.rule),weekly=[],lifts=[],full=[],fullLifts=[];
  for(const at of [...new Set(base.map(r=>r.launchAt))].sort((a,b)=>a-b)){
    const g=base.filter(r=>r.admitted&&r.launchAt===at&&r.arms.includes(selected.rule));
    if(!g.length){full.push(0);fullLifts.push(0);continue;}
    const b=base.filter(r=>r.admitted&&r.launchAt===at&&r.arms.includes('BLIND_MEASURABLE'));
    const m=average(g.map(r=>r.netReturn)),lift=m-average(b.map(r=>r.netReturn));
    weekly.push(m);lifts.push(lift);full.push(m);fullLifts.push(lift);
  }
  const bounds={weekLower95:lowerBound(weekly),liftLower95:lowerBound(lifts),
    calendarHacLower95:lowerBound(full,4),calendarLiftHacLower95:lowerBound(fullLifts,4)};
  return {state:'locked configuration',...c,...bounds,
    passed:c.qualifies&&Object.values(bounds).every(x=>x!==null&&x>0)};
}
export function tally(rows) {
  const keys=new Set(),rejections={};let admitted=0,membershipsCount=0;
  for(const r of rows){
    const k=[r.period,launchKey(r),r.horizonDays,r.window,r.setting,r.direction,r.path,r.markPath].join('|');
    if(keys.has(k))throw Error('Duplicate simulation identity');
    keys.add(k);
    if(r.admitted){admitted++;membershipsCount+=r.arms.length;}
    else rejections[r.reason]=(rejections[r.reason]??0)+1;
  }
  return {attempted:rows.length,admitted,rejected:rows.length-admitted,memberships:membershipsCount,rejections};
}
