// Descriptive post-processing only. No arm selection or simulation changes.
export class ClosePairDetail {
 constructor(){this.key=null;this.touch=new Map();this.groups=new Map();}
 record(row,setting){
  const key=[row.market,row.timeframe,row.launchAt,row.horizonDays].join('|');
  if(key!==this.key){this.key=key;this.touch.clear();}
  if(!row.admitted)return;
  const pairKey=[setting.window,setting.multiplier,setting.mode,row.direction,row.path].join('|');
  if(setting.stopMode==='touch'){this.touch.set(pairKey,row);return;}
  const base=this.touch.get(pairKey);if(!base)return;
  const duration=row.timeframe==='1h'?3600000:14400000;
  for(const [dimension,value] of [['all','all'],['regime',row.regime],['year',row.year],['market',row.market],['path',row.path],['timeframe',row.timeframe],['source',row.source],['direction',row.direction],['horizonDays',row.horizonDays]]){
   const k=[row.period,row.setting,dimension,value].join('|');
   if(!this.groups.has(k))this.groups.set(k,{period:row.period,setting:row.setting,dimension,value,n:0,delta:0,touchHunts:0,huntsAvoided:0,huntsAvoidedCertain:0,sameReturnCandleAmbiguous:0,breakdowns:0,extraLoss:0,worstExtraLoss:0});
   const a=this.groups.get(k);a.n++;a.delta+=row.netReturn-base.netReturn;
   if(base.follow7&&base.back7){
    a.touchHunts++;
    if(!row.stopAt||row.stopAt>=base.returnAt)a.huntsAvoided++;
    if(!row.stopAt||row.stopAt>=base.returnAt+duration)a.huntsAvoidedCertain++;
    else if(row.stopAt>=base.returnAt)a.sameReturnCandleAmbiguous++;
   }
   if(base.protectiveStop&&base.follow7&&!base.back7){
    a.breakdowns++;const loss=Math.max(0,base.netReturn-row.netReturn);a.extraLoss+=loss;a.worstExtraLoss=Math.max(a.worstExtraLoss,loss);
   }
  }
 }
 rows(){return [...this.groups.values()];}
}
