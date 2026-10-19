// Each worker owns one independent market/timeframe dataset. No shared mutable bot state.
import {parentPort,workerData,isMainThread} from 'node:worker_threads';
import {runTrailBacktest,makeTrailGrid} from '../server/grid-bot/trail-backtest.ts';
import {launchCohort} from '../server/grid-bot/trail-rolling.ts';

export function evaluateRollingWindow(d,w){
  const rows=[],rejected=[];
  for(const direction of ['long','short'])for(const seed of [false,true])for(const mode of ['repeat_all','step_back','step_back_edge']){
    const combo={direction,seed,mode},input={...w,...combo,timeframe:d.timeframe,market:d.market,candles:d.bars};
    try{makeTrailGrid(input,String(d.bars[w.start-1].close));}catch(error){
      rejected.push({market:d.market.symbol,timeframe:d.timeframe,period:w.period,horizonDays:w.horizonDays,launchAt:w.launchAt,...combo,reason:error.message});continue;
    }
    const cohorts=Object.fromEntries(['OHLC','OLHC'].map(path=>[path,launchCohort({...input,path},w.geometry)]));
    for(const variant of ['a','b','c','d','e'])for(const path of ['OHLC','OLHC']){
      const result=runTrailBacktest({...input,variant,path});
      const {finalPolicy,ledger,cycleState,executions,...metrics}=result;
      rows.push({market:d.market.symbol,timeframe:d.timeframe,period:w.period,horizonDays:w.horizonDays,launchAt:w.launchAt,endAt:w.endAt,
        geometrySource:'planner-week',cohort:cohorts[path],...metrics});
    }
  }
  return {rows,rejected};
}
if(!isMainThread){
  for(const w of workerData.windows)parentPort.postMessage(evaluateRollingWindow(workerData,w));
  parentPort.close();
}
