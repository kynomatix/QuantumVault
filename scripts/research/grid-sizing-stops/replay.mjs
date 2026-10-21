// Research-only full-fill simulator. The actual planner supplies every price and
// quantity. Integer lot balances preserve inventory; differential validation
// against runTrailBacktest is mandatory before this backend supplies results.
import {retainedGridCycles} from '../../../server/grid-bot/cycle-policy.ts';
import {gridAutoResumeBand} from '../../../server/grid-bot/auto-resume-policy.ts';
import {GRID_CAPS} from '../../../server/grid-bot/grid-caps.ts';
import {gridPlacementBudget} from '../../../shared/grid-capacity.ts';
import {movement} from '../grid-backtest-r2/movement.mjs';
import {liquidationCrossing,liquidationChargeRate,maintenanceRate} from '../grid-backtest-r2/risk.mjs';

export function sizingReplay(input){
 const {candles:bars,market:m,start,end,path}=input;let p=input.policy;
 const equity0=Number(p.totalInvestment),maker=input.makerRate??0.00115,taker=input.takerRate??0.0014,slippage=0.0005;
 const long=p.direction==='long',sign=long?1:-1,lot=Number(m.lot);let envelope=Number(p.safetyEnvelopePrice),stopPrice=Number(p.stopLossPrice);
 const duration=input.timeframe==='1h'?3600000:14400000,stopMode=input.stopMode??'touch';
 if(stopMode==='1h-close'&&duration!==3600000)throw Error('Hourly close requires hourly execution candles');
 const cycles=retainedGridCycles(p).map(c=>({...c,open:Number(c.openingPrice),close:Number(c.closingPrice),units:Math.round(Number(c.quantity)/lot),held:0,credit:Math.round(Number(c.initialOpeningCredit)/lot)}));
 for(const c of cycles)if(Math.abs(c.units*lot-Number(c.quantity))>1e-9)throw Error('Nonintegral lot quantity');
 let band=gridAutoResumeBand(p.lowerPrice,p.upperPrice,m.tick);
 const moving=input.moveMode&&input.moveMode!=='fixed'?movement(input,p,cycles):null;
 let cash=input.initialCash??equity0,positionUnits=0,fees=0,fillCount=0,peak=input.peak??equity0,maxDrawdown=input.maxDrawdown??0,entriesAllowed=true,seeded=false,stopped=false,seedHold=false,breached=false,pendingClose=false,stopSnapshot=null,turnover=0,unavailable=null;
 const executions=input.executions?[]:null; const hourlyEquities=[]; let lastIndex=start-1;
 const risk=!!(input.markBars||input.fundingEvents||input.maxLeverage);
 let currentMark=bars[start].open,funding=0,liquidated=false,liquidationSnapshot=null,liquidationFees=0;
 const mark=value=>{const equity=cash+sign*positionUnits*lot*value;peak=Math.max(peak,equity);if(peak>0)maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);return equity;};
 const execute=(kind,closing,units,price,time,owner=null)=>{
  const q=units*lot,signed=sign*(closing?-q:q),fee=q*price*(kind==='limit'?maker:taker);
  cash-=signed*price+fee;positionUnits+=closing?-units:units;fees+=fee;turnover+=q*price;fillCount++;
  moving?.fill(kind,closing,owner,units,price,kind==='limit'?maker:taker,time);
  if(!closing&&price>envelope)breached=true;
  executions?.push({kind,side:signed>0?'buy':'sell',size:q,price,fee,time});
  mark(risk?currentMark:price);
 };
 const stop=(price,time,index)=>{
  stopSnapshot={time,index,cash,position:sign*positionUnits*lot,triggerPrice:price,stopPrice};
  if(positionUnits)execute('close',true,positionUnits,price*(1-sign*slippage),time);
  stopped=true;
 };
 const settle=(event,price)=>{
  const cost=sign*positionUnits*lot*(event.oraclePrice??price)*event.rate;
  cash-=cost;funding+=cost;mark(price);
 };
 const liquidate=(tradePrice,markPrice,time,index)=>{
  liquidationSnapshot={time,index,markPrice,tradePrice,cash,position:sign*positionUnits*lot,stopPrice};
  if(cash+sign*positionUnits*lot*markPrice<positionUnits*lot*markPrice*maintenanceRate(input.maxLeverage)*2/3){
   liquidationSnapshot.backstop=true;cash=0;positionUnits=0;liquidated=true;stopped=true;mark(markPrice);return;
  }
  const penalty=positionUnits*lot*markPrice*liquidationChargeRate(input.maxLeverage);
  cash-=penalty;fees+=penalty;liquidationFees+=penalty;
  if(positionUnits)execute('close',true,positionUnits,tradePrice*(1-sign*slippage),time);
  liquidated=true;stopped=true;
 };
 for(let i=start;i<end;i++){
  lastIndex=i; const bar=bars[i],prev=bars[i-1],now=bar.time;
  const mb=input.markBars?.[i]??bar;currentMark=mb.open;
  if(risk)for(const f of input.fundingEvents?.[i]??[])if(f.time<=now)settle(f,currentMark);
  if(input.maxLeverage&&liquidationCrossing(cash,sign*positionUnits*lot,input.maxLeverage,currentMark,currentMark)!==null){liquidate(bar.open,currentMark,now,i);break;}
  if(pendingClose){if(now!==prev.time+duration){unavailable='missing next close-stop execution open';break;}stop(bar.open,now+1,i);break;}
  const dataHold=input.dataHolds?.[i]??null;
  if(dataHold){entriesAllowed=false;if(!seeded){mark(mb.close);continue;}}
  if(!seeded){
   const units=cycles.reduce((s,c)=>s+Math.round(Number(c.initialInventory)/lot),0),price=bar.open*(1+sign*slippage),bounds=p.gridPolicyExtension.seedPriceBounds;
   if(units&&(price<Number(bounds.low)||price>Number(bounds.high))){seedHold=true;break;}
   if(units)execute('seed',false,units,price,now+2);
   for(const c of cycles)c.held=Math.round(Number(c.initialInventory)/lot);
   seeded=true;
  }
  const moved=moving?.step(i,dataHold);
  if(moved){p=moved;envelope=Number(p.safetyEnvelopePrice);stopPrice=Number(p.stopLossPrice);band=gridAutoResumeBand(p.lowerPrice,p.upperPrice,m.tick);}
  const outside=prev.close<Number(p.lowerPrice)||prev.close>Number(p.upperPrice);
  if(outside)entriesAllowed=false;
  else if(!dataHold&&!entriesAllowed&&band&&prev.close>=Number(band.lower)&&prev.close<=Number(band.upper))entriesAllowed=true;
  const exits=[],entries=[];
  for(const c of cycles){
   const closingPassive=long?c.close>prev.close:c.close<prev.close,openingPassive=long?c.open<prev.close:c.open>prev.close;
   if(c.held&&closingPassive)exits.push({c,closing:true,price:c.close,units:c.held});
   const credit=c.imported?Math.min(c.credit,Math.max(0,c.units-c.held)):c.credit;
   if(credit&&c.recycles!==false&&openingPassive&&credit*lot*c.open>=Number(m.minimumQuote)-1e-10)entries.push({c,closing:false,price:c.open,units:credit});
  }
  const distance=(a,b)=>Math.abs(a.price-prev.close)-Math.abs(b.price-prev.close)||a.c.ownerOrdinal-b.c.ownerOrdinal;
  exits.sort(distance);entries.sort(distance);
  if(exits.length>GRID_CAPS.ordinaryRestingPerBot)throw Error('Backed exits exceed slot cap');
  const pending=[...exits];let remaining=equity0,pool=Math.max(0,equity0*p.leverage-positionUnits*lot*envelope);
  if(entriesAllowed)for(const e of entries){
   if(pending.length>=GRID_CAPS.ordinaryRestingPerBot)break;
   const notional=e.units*lot*e.price,reservation=e.units*lot*envelope;
   if(notional>remaining+1e-10||breached||prev.close>envelope||reservation>pool+1e-10)continue;
   pending.push(e);remaining-=notional;pool-=reservation;
  }
  pending.splice(gridPlacementBudget(0,100));
  if(risk){
   const tn=path==='OHLC'?[bar.open,bar.high,bar.low,bar.close]:[bar.open,bar.low,bar.high,bar.close];
   const mp=input.markPath??path,mn=mp==='OHLC'?[mb.open,mb.high,mb.low,mb.close]:[mb.open,mb.low,mb.high,mb.close];
   const stopHit=v=>long?v<=stopPrice:v>=stopPrice;
   for(let segment=0;segment<4&&!stopped;segment++){
    const tf=segment?tn[segment-1]:tn[0],tt=tn[segment],mf=segment?mn[segment-1]:mn[0],mt=mn[segment];
    const fromTime=segment?now+(segment-1)*duration/3:now,toTime=segment?now+segment*duration/3:now;
    const fraction=price=>segment===0||tt===tf?0:Math.max(0,Math.min(1,(price-tf)/(tt-tf)));
    const events=pending.filter(e=>(long!==e.closing)?Math.min(tf,tt)<=e.price:Math.max(tf,tt)>=e.price).map(e=>({at:fraction(e.price),type:'limit',e}));
    if(stopMode==='touch'&&(stopHit(mf)||stopHit(mt)))events.push({at:stopHit(mf)?0:(stopPrice-mf)/(mt-mf),type:'stop'});
    if(segment)for(const f of input.fundingEvents?.[i]??[])if(f.time>fromTime&&f.time<=toTime)events.push({at:(f.time-fromTime)/(toTime-fromTime),type:'funding',f});
    events.push({at:1,type:'mark'});
    events.sort((a,b)=>a.at-b.at||(['stop','funding','limit','mark'].indexOf(a.type)-['stop','funding','limit','mark'].indexOf(b.type)));
    let cursor=0;
    for(const event of events){
     const endMark=mf+(mt-mf)*event.at,fromMark=mf+(mt-mf)*cursor;
     const crossing=input.maxLeverage?liquidationCrossing(cash,sign*positionUnits*lot,input.maxLeverage,fromMark,endMark):null;
     const floorAt=input.equityFloor==null?null:equityCrossing(cash,sign*positionUnits*lot,input.equityFloor,fromMark,endMark);
     if(floorAt!==null&&(crossing===null||floorAt<crossing)){
      const at=cursor+(event.at-cursor)*floorAt; currentMark=mf+(mt-mf)*at;
      stop(tf+(tt-tf)*at,Math.round(fromTime+(toTime-fromTime)*at),i); break;
     }
     if(crossing!==null){
      const at=cursor+(event.at-cursor)*crossing;currentMark=mf+(mt-mf)*at;
      liquidate(tf+(tt-tf)*at,currentMark,Math.round(fromTime+(toTime-fromTime)*at),i);break;
     }
     currentMark=endMark;mark(currentMark);cursor=event.at;
     const at=Math.round(fromTime+(toTime-fromTime)*event.at),tradePrice=tf+(tt-tf)*event.at;
     if(event.type==='stop'){stop(tradePrice,at,i);break;}
     if(event.type==='funding'){settle(event.f,currentMark);continue;}
     if(event.type==='limit'){
      const e=event.e;execute('limit',e.closing,e.units,e.price,at,e.c);
      if(e.closing){e.c.held-=e.units;if(e.c.recycles!==false)e.c.credit+=e.units;}
      else{e.c.credit-=e.units;e.c.held+=e.units;}
      pending.splice(pending.indexOf(e),1);
     }
    }
   }
   hourlyEquities.push(mark(mb.close));if(stopped)break;
   if(['1h-close','4h-close'].includes(stopMode)&&(long?bar.close<=stopPrice:bar.close>=stopPrice)&&(stopMode==='1h-close'||(now+duration)%14400000===0))pendingClose=true;
   continue;
  }
  const nodes=path==='OHLC'?[bar.open,bar.high,bar.low,bar.close]:[bar.open,bar.low,bar.high,bar.close];
  const stopHit=v=>long?v<=stopPrice:v>=stopPrice;let eventAt=now+10;
  for(let segment=0;segment<4;segment++){
   const from=segment?nodes[segment-1]:nodes[0],to=nodes[segment];
   const events=pending.filter(e=>(long!==e.closing)?Math.min(from,to)<=e.price:Math.max(from,to)>=e.price).map(e=>({price:segment===0?from:Math.max(Math.min(e.price,Math.max(from,to)),Math.min(from,to)),e,stop:false}));
   if(stopMode==='touch'&&(stopHit(to)||stopHit(from)))events.push({price:stopHit(from)?from:stopPrice,stop:true});
   events.sort((a,b)=>(to>=from?a.price-b.price:b.price-a.price)||Number(b.stop)-Number(a.stop));
   for(const event of events){
    if(event.stop){stop(event.price,eventAt++,i);break;}
    const e=event.e;execute('limit',e.closing,e.units,e.price,eventAt++,e.c);
    if(e.closing){e.c.held-=e.units;if(e.c.recycles!==false)e.c.credit+=e.units;}
    else {e.c.credit-=e.units;e.c.held+=e.units;}
    pending.splice(pending.indexOf(e),1);
   }
   mark(to);if(stopped)break;
  }
  mark(bar.close);if(stopped)break;
  if(['1h-close','4h-close'].includes(stopMode)&&stopHit(bar.close)&&(stopMode==='1h-close'||(now+duration)%14400000===0))pendingClose=true;
 }
 const finalPrice=input.markBars?.[end-1]?.close??bars[end-1].close;
 if(input.closeAtHorizon&&!stopped&&positionUnits)execute('close',true,positionUnits,bars[end-1].close*(1-sign*slippage),bars[end-1].time+duration);
 const finalEquity=mark(finalPrice);
 // One observation per completed hour; stopped cash remains underwater through horizon.
 while(hourlyEquities.length<end-start)hourlyEquities.push(finalEquity);
 hourlyEquities[hourlyEquities.length-1]=finalEquity;
 return {netReturn:finalEquity/equity0-1,maxDrawdown,fees,fillCount,turnover,protectiveStop:Number(stopped&&!liquidated),stopped,seedHold,stopSnapshot,
  hourlyEquities,lastIndex,peak,finalEquity,cash,position:sign*positionUnits*lot,finalMark:finalPrice,unfilledCloseStop:pendingClose&&!stopped,unavailable,executions,
  moves:moving?.moves.length??0,moveLog:moving?.moves??[],moveHolds:moving?.holds??{},funding,liquidated,liquidationSnapshot,liquidationFees};
}

export function equityCrossing(cash,signedQuantity,floor,from,to){
 const margin=p=>cash+signedQuantity*p-floor;
 if(margin(from)<=0)return 0;
 if(margin(to)>0||signedQuantity===0)return null;
 return Math.max(0,Math.min(1,margin(from)/(margin(from)-margin(to))));
}
