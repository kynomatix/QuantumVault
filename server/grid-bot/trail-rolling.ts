/** Offline launch schedule and arm-independent descriptive cohorts. */
import Decimal from 'decimal.js';
import {timeWindowRange} from '../grid-planner/range-facts';
import {gridHistoryWindow} from '../../shared/grid-lookback';
import {trailDuration,type TrailRun,type TrailGeometry} from './trail-backtest';
import {trailDataHold} from './trail-policy';
import type {PlannerCandle} from '../grid-planner/types';

const DAY=86_400_000;
export const TRAIL_ROLLING=Object.freeze({version:'trail-rolling-2',cadenceDays:7,horizonsDays:[14,30] as const,
  rangePeriod:'week' as const,split:'2026-03-01T00:00:00Z',endExclusive:'2026-10-19T00:00:00Z',
  policySelection:'Unchanged trail-research-1; no threshold search',runtimeBudgetMinutes:90});

export function rollingWindows(bars:PlannerCandle[],timeframe:TrailRun['timeframe'],periodStart:number,periodEnd:number,horizonDays:number){
  if(![14,30].includes(horizonDays)||periodEnd<=periodStart)throw Error('Invalid rolling period');
  const duration=trailDuration(timeframe),indices=new Map(bars.map((b,i)=>[b.time,i]));
  const result:{launchAt:number;endAt:number;start:number;end:number;hold:string|null}[]=[];
  for(let launchAt=periodStart;launchAt+horizonDays*DAY<=periodEnd;launchAt+=TRAIL_ROLLING.cadenceDays*DAY){
    const endAt=launchAt+horizonDays*DAY,start=indices.get(launchAt),last=indices.get(endAt-duration);
    const hold=start===undefined||last===undefined?'missing_boundary':trailDataHold(bars.slice(Math.max(0,start-100),start),timeframe,launchAt);
    result.push({launchAt,endAt,start:start??-1,end:last===undefined?-1:last+1,hold});
  }
  return result;
}

/** The same week-window and outward stop / inward range tick snapping as PlannerRangeFacts. */
export function plannerLaunchGeometry(bars:PlannerCandle[],timeframe:TrailRun['timeframe'],start:number,tick:string){
  const window=gridHistoryWindow(timeframe,TRAIL_ROLLING.rangePeriod)!;
  const history=bars.slice(Math.max(0,start-window.chartBars),start);
  const range=timeWindowRange('RESEARCH',timeframe,TRAIL_ROLLING.rangePeriod,history,bars[start].time);
  if(range.state!=='available')return {ok:false as const,reason:range.reason};
  const snap=(v:string,rounding:Decimal.Rounding)=>new Decimal(v).div(tick).toDecimalPlaces(0,rounding).mul(tick).toFixed(8);
  const geometry:TrailGeometry={lower:snap(range.lowerPrice,Decimal.ROUND_CEIL),upper:snap(range.upperPrice,Decimal.ROUND_FLOOR),
    longStop:snap(range.longStop,Decimal.ROUND_FLOOR),shortStop:snap(range.shortStop,Decimal.ROUND_CEIL)};
  const mark=new Decimal(bars[start-1].close);
  if(!mark.gt(geometry.lower)||!mark.lt(geometry.upper)||!new Decimal(geometry.longStop).gt(0)
    ||!new Decimal(geometry.longStop).lt(geometry.lower)||!new Decimal(geometry.shortStop).gt(geometry.upper))return {ok:false as const,reason:'Planner geometry collapses at venue tick'};
  return {ok:true as const,geometry,atr:range.atr,historyStart:history[0].time,historyEnd:history.at(-1)!.time};
}

/** Fixed initial bounds and stop, shared by every arm. A stop before a breakout ends
 * the reference run. Breakout-first runs may subsequently stop; reported separately.
 * Same-bar order is resolved by the named path, never by the treatment's outcome. */
export function launchCohort(input:Pick<TrailRun,'candles'|'start'|'end'|'direction'|'path'>,g:TrailGeometry){
  const long=input.direction==='long',edge=Number(long?g.upper:g.lower),stop=Number(long?g.longStop:g.shortStop);
  let adverseExcursion=false;
  for(const bar of input.candles.slice(input.start,input.end)){
    const nodes=input.path==='OHLC'?[bar.open,bar.high,bar.low,bar.close]:[bar.open,bar.low,bar.high,bar.close];
    for(const value of nodes){
      if(long?value>edge:value<edge)return 'favourable_breakout';
      if(long?value<=stop:value>=stop)return 'adverse_stop_without_breakout';
      if(long?value<Number(g.lower):value>Number(g.upper))adverseExcursion=true;
    }
  }
  return adverseExcursion?'adverse_excursion_no_stop':'inside_range';
}
