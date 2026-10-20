export const DAY = 86400000;
export const ARMS = ['BLIND', 'FINDER', 'TOP1', 'TOP2', 'AGAINST'];
export const SETTINGS = [0.001, 0.0005, 0.0002, 0].flatMap(builderRate =>
  [1, 3, 5].map(leverage => ({id:`b${Math.round(builderRate*100000)}-L${leverage}`,
    builderRate, leverage, makerRate:0.00015+builderRate, takerRate:0.0004+builderRate})));
export function closedHistory(bars, launchAt, duration, count = 100) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo+hi) >>> 1; if (bars[mid].time < launchAt) lo = mid+1; else hi = mid; }
  const rows = bars.slice(Math.max(0, lo-count), lo);
  if (rows.length !== count || rows.at(-1).time+duration !== launchAt ||
      rows.some((r, i) => r.time+duration > launchAt || (i && r.time !== rows[i-1].time+duration))) return null;
  return rows;
}
export function rankSelections(rows) {
  const candidates = rows.filter(r => r.state === 'ranging').sort((a,b) =>
    a.adx-b.adx || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const ranks = new Map(candidates.map((r,i) => [r.symbol,i+1]));
  return rows.map(r => ({...r, rank:ranks.get(r.symbol) ?? null}));
}
export function armMembership(selection) {
  const arms = ['BLIND'];
  if (selection?.state === 'ranging') {
    arms.push('FINDER');
    if (selection.rank === 1) arms.push('TOP1');
    if (selection.rank <= 2 && selection.rank >= 1) arms.push('TOP2');
  } else if (selection?.state === 'not-ranging') arms.push('AGAINST');
  return arms;
}
export function proxyCalendar(duration, indices, bars) {
  const through = Date.parse('2026-01-01T00:00:00Z'), rows = [];
  for (const horizonDays of [14,30])
    for (let launchAt=Date.parse('2022-01-02T00:00:00Z'); launchAt+horizonDays*DAY <= through; launchAt+=7*DAY) {
      const endAt = launchAt+horizonDays*DAY, start=indices.get(launchAt), last=indices.get(endAt-duration);
      const before = start === undefined ? null : bars[start-1], old = before ? indices.get(before.time-30*DAY) : undefined;
      const preReturn = old === undefined ? null : before.close/bars[old].close-1;
      rows.push({launchAt,endAt,start:start ?? -1,end:last === undefined ? -1 : last+1,horizonDays,
        year:new Date(launchAt).getUTCFullYear(),source:'okx_proxy',
        regime:preReturn === null ? 'unknown' : preReturn > 0.1 ? 'trending_up' : preReturn < -0.1 ? 'trending_down' : 'ranging',
        reason:start === undefined || last === undefined ? 'missing_boundary' : null});
    }
  return rows;
}
export function summary(rows) {
  const admitted = rows.filter(r => r.admitted), n=admitted.length;
  const returns=admitted.map(r => r.netReturn).sort((a,b) => a-b);
  const avg=k => n ? admitted.reduce((s,r) => s+Number(r[k]),0)/n : null;
  const weeks=new Map();
  for (const r of admitted) { const a=weeks.get(r.launchAt) ?? []; a.push(r.netReturn); weeks.set(r.launchAt,a); }
  const weekly=[...weeks.values()].map(a => a.reduce((s,v) => s+v,0)/a.length);
  const weekMean=weekly.length ? weekly.reduce((s,v) => s+v,0)/weekly.length : null;
  const se=weekly.length > 1 ? Math.sqrt(weekly.reduce((s,v) => s+(v-weekMean)**2,0)/(weekly.length-1)/weekly.length) : null;
  return {runs:n,mean:avg('netReturn'),median:n ? (returns[(n-1)>>>1]+returns[n>>>1])/2 : null,
    profitable:n ? admitted.filter(r => r.netReturn>0).length/n : null,
    stopRate:avg('protectiveStop'),liquidationRate:avg('liquidated'),
    meanDrawdown:avg('maxDrawdown'),worstDrawdown:n ? admitted.reduce((s,r) => Math.max(s,r.maxDrawdown),0) : null,
    seedHolds:admitted.filter(r => r.seedHold).length,
    admittedLaunches:new Set(admitted.map(r => `${r.launchAt}|${r.market}|${r.timeframe}`)).size,
    weeks:weeks.size,weekMean,weekLower95:se === null ? null : weekMean-1.96*se};
}
export function selectDevelopment(rows) {
  const base=rows.filter(r => r.timeframe === '1h' && r.setting === 'b100-L1');
  const blind=summary(base), measurable=summary(base.filter(r => r.selectionState !== 'unavailable'));
  const candidates=['FINDER','TOP1','TOP2'].map(arm => {
    const group=base.filter(r => r.arms.includes(arm)), stats=summary(group);
    const markets=[...new Set(group.map(r => r.market))];
    const marketMeans=markets.map(m => summary(group.filter(r => r.market === m)).mean);
    const paths=['OHLC','OLHC'].map(p => summary(group.filter(r => r.path === p)).mean);
    const retention=blind.admittedLaunches ? stats.admittedLaunches/blind.admittedLaunches : 0;
    const qualifies=stats.weeks>=20 && retention>=0.2 && stats.mean>0 && stats.profitable>0.5 &&
      stats.mean>measurable.mean && stats.meanDrawdown<=measurable.meanDrawdown &&
      marketMeans.filter(x => x !== null && x>0).length>markets.length/2 && paths.every(x => x !== null && x>0);
    return {arm,...stats,retention,marketMeans,paths,qualifies};
  });
  const qualifying=candidates.filter(c => c.qualifies).sort((a,b) => b.mean-a.mean || a.meanDrawdown-b.meanDrawdown ||
    b.retention-a.retention || a.arm.localeCompare(b.arm));
  return {selected:qualifying[0]?.arm ?? 'no qualifying filter',blind,measurable,candidates};
}
