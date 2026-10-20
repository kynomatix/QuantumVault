// Identical paired admission/selection rules for each research phase.
export class Stats {
 constructor(){this.groups=new Map();this.rejects=new Map();this.pairs=new Map();this.total=0;this.admitted=0;}
 record(r){
  this.total++;
  if(!r.admitted){const key=[r.period,r.setting,r.reason].join('|');this.rejects.set(key,(this.rejects.get(key)??0)+1);return;}
  this.admitted++;
  for(const [dimension,value] of [['all','all'],['regime',r.regime],['year',r.year],['market',r.market],['path',r.path],['timeframe',r.timeframe],['source',r.source],['direction',r.direction],['horizon',r.horizonDays]]){
   const key=[r.period,r.setting,dimension,value].join('|');
   if(!this.groups.has(key))this.groups.set(key,{period:r.period,setting:r.setting,dimension,value,n:0,netReturn:0,maxDrawdown:0,worstDrawdown:0,fees:0,fillCount:0,stops:0,moves:0,funding:0,liquidations:0,dd25:0,dd50:0});
   const a=this.groups.get(key);a.n++;
   for(const k of ['netReturn','maxDrawdown','fees','fillCount','moves','funding'])a[k]+=r[k]??0;
   a.stops+=r.protectiveStop??0;a.liquidations+=Number(r.liquidated??false);a.worstDrawdown=Math.max(a.worstDrawdown,r.maxDrawdown);
   a.dd25+=Number(r.maxDrawdown>0.25);a.dd50+=Number(r.maxDrawdown>0.5);
  }
 }
 pair(r,b){
  const key=[r.period,r.setting,r.path].join('|');
  if(!this.pairs.has(key))this.pairs.set(key,{period:r.period,setting:r.setting,path:r.path,n:0,admitted:0,baseAdmitted:0,paired:0,delta:0,drawdownDelta:0,regimes:{},markets:{}});
  const a=this.pairs.get(key);a.n++;a.admitted+=Number(r.admitted);a.baseAdmitted+=Number(b.admitted);
  if(!r.admitted||!b.admitted)return;
  a.paired++;a.delta+=r.netReturn-b.netReturn;a.drawdownDelta+=r.maxDrawdown-b.maxDrawdown;
  for(const [field,k] of [['regimes',r.regime],['markets',r.market]]){const x=a[field][k]??={n:0,delta:0};x.n++;x.delta+=r.netReturn-b.netReturn;}
 }
 select(ids,baseline,period='development'){
  const candidates=ids.filter(id=>id!==baseline).map(setting=>{
   const paths=['OHLC','OLHC'].map(p=>this.pairs.get([period,setting,p].join('|'))).filter(Boolean);
   const pass=paths.length===2&&paths.every(a=>a.paired&&a.admitted>=a.baseAdmitted&&a.delta>0&&a.drawdownDelta<=0&&['trending_up','trending_down','ranging'].filter(k=>a.regimes[k]?.delta>0).length>=2&&Object.values(a.markets).filter(m=>m.delta>0).length>Object.keys(a.markets).length/2);
   return {setting,pass,delta:paths.reduce((s,a)=>s+a.delta/a.paired,0)/paths.length,drawdownDelta:paths.reduce((s,a)=>s+a.drawdownDelta/a.paired,0)/paths.length,paths};
  }).sort((a,b)=>b.delta-a.delta||a.drawdownDelta-b.drawdownDelta||a.setting.localeCompare(b.setting));
  return {createdAt:new Date().toISOString(),baseline,selected:candidates.find(c=>c.pass)?.setting??baseline,candidates};
 }
 json(){return {total:this.total,admitted:this.admitted,summaries:[...this.groups.values()],comparisons:[...this.pairs.values()],rejections:[...this.rejects].map(([key,count])=>({key,count}))};}
}
