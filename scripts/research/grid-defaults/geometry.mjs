import Decimal from 'decimal.js';
import {PlannerRangeFacts} from '../../../server/grid-planner/range-facts.ts';
import {gridHistoryWindow} from '../../../shared/grid-lookback.ts';
import {observePacificaConstraints} from '../../../server/protocol/market-constraints.ts';

export async function geometryAt(bars,timeframe,start,market,window){
  const now=bars[start].time,request=gridHistoryWindow(timeframe,window),history=bars.slice(Math.max(0,start-request.chartBars),start);
  if(history.some(c=>c.time+request.duration>now))throw Error('Future geometry input');
  const internalSymbol=market.symbol+'-PERP';
  const row={internalSymbol,protocolSymbol:market.symbol,fullName:market.symbol,
    constraintObservation:observePacificaConstraints({tick_size:market.tick,lot_size:market.lot,min_order_size:market.minimumQuote,
      max_order_size:market.maximumQuote,min_tick:market.minimumPrice,max_tick:market.maximumPrice},internalSymbol,now)};
  const facts=await new PlannerRangeFacts().read(row,timeframe,100,{now:()=>now,cachedReference:()=>null},new AbortController().signal,
    {state:'available',candles:history},window);
  if(facts.range.state!=='available')return {ok:false,reason:facts.range.reason};
  // The research policy's canonical wire format requires eight decimal places.
  const r=facts.range,wire=v=>new Decimal(v).toFixed(8),geometry={lower:wire(r.lowerPrice),upper:wire(r.upperPrice),longStop:wire(r.longStop),shortStop:wire(r.shortStop)};
  return {ok:true,geometry,atr:r.atr,historyStart:history[0].time,historyEnd:history.at(-1).time,historyBars:history.length,requiredChartBars:request.chartBars};
}
export function widerGeometry(g,multiplier,tick){
  if(![1,1.5,2].includes(multiplier))throw Error('Unregistered stop multiplier');
  if(multiplier===1)return {...g};
  const lower=new Decimal(g.lower),upper=new Decimal(g.upper);
  const snap=(v,mode)=>v.div(tick).toDecimalPlaces(0,mode).mul(tick).toFixed(8);
  return {...g,longStop:snap(lower.minus(lower.minus(g.longStop).mul(multiplier)),Decimal.ROUND_FLOOR),
    shortStop:snap(upper.plus(new Decimal(g.shortStop).minus(upper).mul(multiplier)),Decimal.ROUND_CEIL)};
}
