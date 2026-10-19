export const BASELINE='week-1-10-repeat_all';
export const settings=Object.freeze(['repeat_all','step_back'].flatMap(mode=>{
  const rows=[];
  const add=(window,multiplier,intervals)=>rows.push({id:`${window}-${multiplier}-${intervals}-${mode}`,window,multiplier,intervals,mode});
  for(const window of ['day','week','month'])for(const multiplier of [1,1.5,2])add(window,multiplier,10);
  for(const window of ['day','week','month'])for(const intervals of [6,14])add(window,1,intervals);
  for(const multiplier of [1.5,2])for(const intervals of [6,14])add('week',multiplier,intervals);
  return rows;
}));
export function parameterizeIntervals(source){
  for(const [from,to] of [['intervals:e.intervals,','intervals:(input.intervals??e.intervals),'],['gridCount:e.intervals,','gridCount:(input.intervals??e.intervals),']]){
    if(source.split(from).length!==2)throw Error('Interval adapter boundary changed');
    source=source.replace(from,to);
  }
  return source;
}
export function metrics(rows){
  if(!rows.length)return {n:0};
  const mean=k=>rows.reduce((s,r)=>s+r[k],0)/rows.length;
  const returns=rows.map(r=>r.netReturn).sort((a,b)=>a-b),n=rows.length;
  return {n,mean:mean('netReturn'),median:(returns[Math.floor((n-1)/2)]+returns[Math.floor(n/2)])/2,
    profitable:rows.filter(r=>r.netReturn>0).length/n,stopRate:mean('protectiveStop'),meanDrawdown:mean('maxDrawdown'),worstDrawdown:Math.max(...rows.map(r=>r.maxDrawdown)),
    meanFees:mean('fees'),totalFees:mean('fees')*n,meanFills:mean('fillCount'),totalFills:mean('fillCount')*n,
    seedHolds:rows.filter(r=>r.seedHold).length,missingRuns:rows.filter(r=>r.missingMs>0).length};
}
export const idle=r=>r.admitted?r:{...r,netReturn:0,maxDrawdown:0,fees:0,fillCount:0,protectiveStop:0,seedHold:false,missingMs:0};
export function compare(candidate,baseline){
  const paths=['OHLC','OLHC'].map(path=>{
    const c=candidate.filter(r=>r.path===path),b=baseline.filter(r=>r.path===path),bm=new Map(b.map(r=>[r.key,r]));
    if(c.length!==b.length||c.some(r=>!bm.has(r.key)))throw Error('Unpaired scheduled calendar');
    const ca=c.filter(r=>r.admitted),ba=b.filter(r=>r.admitted),paired=ca.filter(r=>bm.get(r.key).admitted);
    const cm=metrics(paired),base=metrics(paired.map(r=>bm.get(r.key))),cash=metrics(c.map(idle)),baseCash=metrics(b.map(idle));
    const improves=(a,z)=>a.n>0&&a.mean>z.mean&&a.meanDrawdown<=z.meanDrawdown&&a.stopRate<=z.stopRate;
    return {path,scheduled:c.length,candidateAdmitted:ca.length,baselineAdmitted:ba.length,paired:cm,baseline:base,cash,baselineCash:baseCash,
      passes:ca.length>=ba.length&&improves(cm,base)&&improves(cash,baseCash)};
  });
  return {passes:paths.every(p=>p.passes),paths,meanDelta:paths.reduce((s,p)=>s+(p.paired.mean-p.baseline.mean),0)/2};
}
export function selectDevelopment(rows){
  const byId=new Map(settings.map(s=>[s.id,rows.filter(r=>r.setting===s.id)]));
  const comparisons=settings.filter(s=>s.id!==BASELINE).map(s=>{
    const shipped=compare(byId.get(s.id),byId.get(BASELINE)),sameId=`week-1-10-${s.mode}`;
    const sameMode=s.id===sameId?null:compare(byId.get(s.id),byId.get(sameId));
    return {setting:s.id,passes:shipped.passes&&(!sameMode||sameMode.passes),shipped,sameMode};
  });
  const eligible=comparisons.filter(c=>c.passes).sort((a,b)=>b.shipped.meanDelta-a.shipped.meanDelta||
    a.shipped.paths[0].paired.meanDrawdown-b.shipped.paths[0].paired.meanDrawdown||a.shipped.paths[0].paired.stopRate-b.shipped.paths[0].paired.stopRate||a.setting.localeCompare(b.setting));
  return {selected:eligible[0]?.setting??null,eligible:eligible.map(c=>c.setting),comparisons};
}
