/** Deterministic, offline OHLC experiment. No venue, persistence or application bootstrap. */
import Decimal from 'decimal.js';
import { calculateCycleGrid } from './cycle-engine';
import { canonicalGridPolicy, type GridPolicy } from './policy-hmac';
import { createHash } from 'node:crypto';
import { replayGridCycles, type CycleReplayInput, type CycleOperation } from './cycle-replay';
import { cycleCapacity } from './cycle-capacity';
import { planCycleWindow, cyclePortions } from './cycle-planner';
import { windowLevelKey } from './window';
import { candidateGridEpoch } from './move-policy';
import { gridAutoResumeBand, gridInsideAutoResumeBand } from './auto-resume-policy';
import { GRID_TRAIL_POLICY, qualifyAutomaticTrail, trailHistory, trailCapHold, trailDataHold, type TrailVariant } from './trail-policy';
import type { PlannerCandle } from '../grid-planner/types';
import type { GridBehaviourMode } from '../../shared/grid-behaviour';
import type { LaunchFacts } from './provision';

const D = Decimal.clone({precision:80});
export const TRAIL_EXPERIMENT = Object.freeze({version:'trail-experiment-1',investment:'1000.00',leverage:1,
  halfWidth:0.06,stopDistance:0.08,intervals:8,makerRate:'0.00115',takerRate:'0.0014',marketSlippage:'0.0005',
  split:'2026-03-01T00:00:00Z',fundingIncluded:false});
export interface TrailMarket {symbol:string;tick:string;lot:string;minimumQuote:string;maximumQuote:string;minimumPrice:string;maximumPrice:string}
export interface TrailRun {
  candles:PlannerCandle[];timeframe:'15m'|'1h'|'4h';start:number;end:number;market:TrailMarket;
  direction:'long'|'short';seed:boolean;mode:GridBehaviourMode;variant:TrailVariant;path:'OHLC'|'OLHC';
}
export const trailDuration = (tf:TrailRun['timeframe']) => ({'15m':900000,'1h':3600000,'4h':14400000})[tf];
const uuid = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function makeTrailGrid(input:Pick<TrailRun,'market'|'direction'|'seed'|'mode'>,reference:string):GridPolicy {
  const e=TRAIL_EXPERIMENT,m=input.market,long=input.direction==='long',tick=new D(m.tick);
  const quantize=(n:Decimal)=>n.div(tick).floor().mul(tick).toFixed(8);
  const lower=quantize(new D(reference).mul(1-e.halfWidth)),upper=quantize(new D(reference).mul(1+e.halfWidth));
  const stop=quantize(new D(reference).mul(long?1-e.stopDistance:1+e.stopDistance));
  const envelope=long?upper:stop;
  const result=calculateCycleGrid({side:input.direction,lower,upper,start:reference,intervals:e.intervals,
    entryScale:'flat',profitScale:'flat',seed:input.seed,leverage:String(e.leverage),tick:m.tick,lot:m.lot,
    minimumQuote:m.minimumQuote,maximumQuote:m.maximumQuote,investmentStep:'0.01',transferFloor:'0',investment:e.investment,
    effectiveMakerCostRate:e.makerRate,policyVersion:'2.2.0',behaviourMode:input.mode,sizingVersion:'lean-1',safetyEnvelopePrice:envelope});
  if(!result.ok)throw Error(result.issues.map(i=>i.reason).join('; '));
  const p=result.plan;
  const policy:GridPolicy={id:uuid(1),protocol:'pacifica',market:m.symbol+'-PERP',direction:input.direction,
    lowerPrice:lower,upperPrice:upper,startPrice:new D(p.start).toFixed(8),gridCount:e.intervals,totalInvestment:e.investment,
    leverage:e.leverage,entryScaleType:'flat',profitScaleType:'flat',policyVersion:'2.2.0',runtimePolicyVersion:'2.2.0',
    feePolicyVersion:'1.0.0',stopLossPercent:'8.0000',stopLossPrice:stop,seedAtCreation:input.seed,
    sizingVersion:'lean-1',safetyEnvelopePrice:envelope,gridPolicyExtension:p.gridPolicyExtension,
    levels:p.lines.map(l=>{const closing=long?new D(l.price).gt(p.start):new D(l.price).lt(p.start);
      return {ordinal:l.ordinal+1,price:new D(l.price).toFixed(8),size:new D(l.quantity).toFixed(8),reduceOnly:closing,
        side:long?(closing?'sell':'buy'):(closing?'buy':'sell')};})};
  if(!canonicalGridPolicy(policy))throw Error('Generated research policy is not canonical');
  return policy;
}

/** Every period starts a fresh bot, and stops permanently on its protective stop. No reseeding. */
export function runTrailBacktest(input:TrailRun) {
  const {candles:bars,market:m}=input,duration=trailDuration(input.timeframe),e=TRAIL_EXPERIMENT;
  if(input.start<GRID_TRAIL_POLICY.indicatorBars||input.end>bars.length||input.end<=input.start)throw Error('Invalid replay period');
  let p=makeTrailGrid(input,String(bars[input.start-1].close)),ledger=trailHistory(p,bars[input.start].time);
  let h:CycleReplayInput={policy:p,account:'EXAMPLE_RESEARCH_ACCOUNT',historyComplete:true,operations:[],fills:[],progress:[],allocations:[]};
  if(!input.seed)h.unusedSeedProof={operationIds:[],historyThrough:bars[input.start].time,entriesAllowed:true};
  let cash=new D(e.investment),position=new D(0),fees=new D(0),turnover=new D(0),peak=new D(e.investment),maxDrawdown=new D(0);
  let serial=0,epoch=1,entriesAllowed=true,stopped=false,seeded=false,fillCount=0,outMs=0,activeMs=0,missingMs=0;
  const holds:Record<string,number>={},moves:{decisionAt:number;activatedAt:number;lower:string;upper:string}[]=[];
  const executions:{kind:string;side:string;size:string;price:string;fee:string;time:number}[]=[];
  const hold=(why:string)=>{holds[why]=(holds[why]??0)+1;};
  let cachedReplay:Extract<ReturnType<typeof replayGridCycles>,{ok:true}>|null=null;
  let capacityKey='',cachedCapacity:ReturnType<typeof cycleCapacity>;
  const replay=()=>{if(cachedReplay)return cachedReplay;const r=replayGridCycles(h);if(!r.ok)throw Error(r.reason);cachedReplay=r;return r;};
  const equity=(mark:number|string)=>{
    const value=cash.plus(position.mul(mark));peak=D.max(peak,value);
    if(peak.gt(0))maxDrawdown=D.max(maxDrawdown,peak.minus(value).div(peak));return value;
  };
  const operation=(kind:CycleOperation['kind'],closing:boolean,size:string,at:number,owner:number|null,price:string|null):CycleOperation=>({
    id:`EXAMPLE_OPERATION_${++serial}`,botId:p.id,account:h.account,kind,leg:closing?'closing':'opening',
    side:p.direction==='long'?(closing?'sell':'buy'):(closing?'buy':'sell'),reduceOnly:closing,cycleOrdinal:owner,size,price,preparedAt:at});
  const execute=(op:CycleOperation,price:string,at:number)=>{
    const q=new D(op.size),notional=q.mul(price),fee=notional.mul(op.kind==='limit'?e.makerRate:e.takerRate);
    h.operations.push(op);h.fills.push({operationId:op.id,tradeId:`EXAMPLE_FILL_${serial}`,account:h.account,time:at,
      size:op.size,price,leg:op.reduceOnly?'exit':'entry',fee:fee.toFixed()});
    h.progress.push({operationId:op.id,state:'terminal',filledSize:op.size,observedAt:at,terminalAt:at,historyThrough:at});
    cachedReplay=null;
    const signed=op.side==='buy'?q:q.neg();position=position.plus(signed);cash=cash.minus(signed.mul(price)).minus(fee);
    fees=fees.plus(fee);turnover=turnover.plus(notional);fillCount++;
    executions.push({kind:op.kind,side:op.side,size:op.size,price,fee:fee.toFixed(),time:at});
    const reconstructed=replay().cycles.reduce((s,c)=>s.plus(c.held),new D(0));
    if(!reconstructed.eq(position.abs()))throw Error('Inventory conservation failed');
    equity(price);
  };
  const marketPrice=(mark:number,side:'buy'|'sell')=>new D(mark).mul(new D(1).plus(new D(e.marketSlippage).mul(side==='buy'?1:-1))).toFixed();
  const stop=(mark:number,at:number)=>{
    if(position.abs().gt(0)){
      const r=replay(),op=operation('close',true,position.abs().toFixed(),at,null,null);
      for(const c of r.cycles)for(const lot of cyclePortions(c.availableEntryLots,c.held))h.allocations.push({...lot,operationId:op.id,cycleOrdinal:c.cycle.ownerOrdinal});
      execute(op,marketPrice(mark,op.side),at);
    }
    stopped=true;hold('protective_stop');
  };
  // Signal and orders are based on the preceding CLOSED bar. Their activation is at open+1ms;
  // OHLC has no sub-bar timestamps: open is only the explicitly stated execution proxy.
  for(let i=input.start;i<input.end;i++){
    if(stopped)break;
    const bar=bars[i],previous=bars[i-1],now=bar.time,warm=bars.slice(Math.max(0,i-GRID_TRAIL_POLICY.indicatorBars),i);
    const dataHold=trailDataHold(warm,input.timeframe,now);
    const currentValid=trailDataHold([bar],input.timeframe,now+duration);
    missingMs+=Math.max(0,now-previous.time-duration);
    if(currentValid!=='warmup')throw Error('Invalid replay candle: '+currentValid);
    if(dataHold){
      hold(dataHold);entriesAllowed=false;
      // No seed/entry/move while history is broken. Known bars still execute backed exits
      // and protective stops; missing intervals themselves are never filled or interpolated.
      if(!seeded){equity(bar.close);continue;}
    }
    activeMs+=duration;
    if(!seeded){
      if(input.seed){
        const q=replay().cycles.reduce((s,c)=>s.plus(c.pendingSeed),new D(0));
        if(q.gt(0)){
          const op=operation('seed',false,q.toFixed(),now+1,null,null),price=marketPrice(bar.open,op.side);
          const bounds=p.gridPolicyExtension!.seedPriceBounds;
          if(new D(price).lt(bounds.low)||new D(price).gt(bounds.high)){hold('launch_seed_slippage');stopped=true;break;}
          execute(op,price,now+2);
        }
      }
      seeded=true;
    }
    const decision=dataHold?{eligible:false as const,reason:'data_hold'}:qualifyAutomaticTrail({policy:p,history:ledger,candles:warm,timeframe:input.timeframe,now,variant:input.variant});
    ledger.lastDecisionAt=now;
    if(!decision.eligible){if(!dataHold)hold(decision.reason);}
    else {
      const exported=replayGridCycles({...h,exportEpochId:uuid(epoch)});
      if(!exported.ok||!exported.carry)throw Error(exported.ok?'Missing carry':exported.reason);
      // Only pure candidate validation uses these public market facts, never launch admission.
      const facts={...m,tick:m.tick,lot:m.lot,bookPrice:String(bar.open),maker:{effectiveRate:e.makerRate},profit:{effectiveRate:e.makerRate}} as unknown as LaunchFacts;
      let candidate:GridPolicy|null=null;
      try{
        const policyHmac=createHash('sha256').update(canonicalGridPolicy(p)!).digest('hex'); // research digest, not live signing authority
        candidate=candidateGridEpoch({policy:p,policyHmac,epochId:uuid(epoch+1),originEpochId:uuid(epoch),ordinal:epoch+1,
          carry:exported.carry,facts,close:decision.close,mark:String(bar.open)}).policy;
      }catch(error){hold('candidate: '+(error as Error).message);}
      if(candidate){
        const capped=trailCapHold(p,ledger,now,candidate);
        if(capped)hold(capped);
        else {
          p=candidate;epoch++;
          const move={decisionAt:now,activatedAt:now+GRID_TRAIL_POLICY.latencyMs,lower:p.lowerPrice,upper:p.upperPrice};
          ledger.moves.push({...move,actor:'automatic'});moves.push(move);
          h={policy:p,account:h.account,historyComplete:true,carry:exported.carry,operations:[],fills:[],progress:[],allocations:[]};
          cachedReplay=null;
          replay();
        }
      }
    }
    const outside=previous.close<Number(p.lowerPrice)||previous.close>Number(p.upperPrice);
    if(outside)entriesAllowed=false;
    else if(!dataHold&&!entriesAllowed&&gridInsideAutoResumeBand(String(previous.close),gridAutoResumeBand(p.lowerPrice,p.upperPrice,m.tick)))entriesAllowed=true;
    if(outside)outMs+=duration;
    const r=replay(),nextCapacityKey=`${epoch}/${serial}/${previous.close>Number(p.safetyEnvelopePrice)}`;
    if(nextCapacityKey!==capacityKey){cachedCapacity=cycleCapacity(h,String(previous.close));capacityKey=nextCapacityKey;}
    const capacity=cachedCapacity;
    const plan=planCycleWindow({cycles:r.cycles,direction:p.direction,levels:p.levels.map(l=>({id:`EXAMPLE_LEVEL_${l.ordinal}`,ordinal:l.ordinal,attempt:0})),
      owned:[],positionSize:position.abs().toFixed(),bookPrice:String(previous.close),lot:m.lot,minimumQuote:m.minimumQuote,
      freeSlots:100,inventoryComplete:true,entriesAllowed,canaryRemaining:e.investment,pool:capacity});
    const pending=plan.chunks.flat().filter(a=>a.kind==='place').map(a=>a.level);
    // Each resting request is filled at most once per bar. New recycle credit waits for the next bar.
    const nodes=input.path==='OHLC'?[bar.open,bar.high,bar.low,bar.close]:[bar.open,bar.low,bar.high,bar.close];
    const stopPrice=Number(p.stopLossPrice),stopHit=(v:number)=>p.direction==='long'?v<=stopPrice:v>=stopPrice;
    let eventAt=now+10;
    for(let segment=0;segment<nodes.length;segment++){
      const from=segment?nodes[segment-1]:nodes[0],to=nodes[segment];
      const touched=pending.filter(l=>l.side==='buy'?Math.min(from,to)<=Number(l.price):Math.max(from,to)>=Number(l.price));
      const events=touched.map(l=>({price:segment===0?from:Math.max(Math.min(Number(l.price),Math.max(from,to)),Math.min(from,to)),level:l,stop:false}));
      if(stopHit(to)||stopHit(from))events.push({price:stopHit(from)?from:stopPrice,level:null as any,stop:true});
      events.sort((a,b)=>(to>=from?a.price-b.price:b.price-a.price)||Number(b.stop)-Number(a.stop));
      for(const event of events){
        if(event.stop){stop(event.price,eventAt++);break;}
        const l=event.level,op=operation('limit',l.reduceOnly,l.size,now+3,l.cycle.ownerOrdinal,l.price);
        if(l.reduceOnly)for(const lot of plan.allocations[windowLevelKey(l)])h.allocations.push({...lot,operationId:op.id,cycleOrdinal:l.cycle.ownerOrdinal});
        else {op.initialCredit=l.initialCredit;op.recycleAllocations=l.recycleAllocations;}
        execute(op,l.price,eventAt++);pending.splice(pending.indexOf(l),1);
      }
      equity(to);if(stopped)break;
    }
    equity(bar.close);
  }
  const finalEquity=equity(bars[input.end-1].close),cycleState=replay().cycles;
  return {variant:input.variant,path:input.path,direction:input.direction,seed:input.seed,mode:input.mode,
    netReturn:finalEquity.div(e.investment).minus(1).toNumber(),maxDrawdown:maxDrawdown.toNumber(),fees:fees.toNumber(),
    turnover:turnover.toNumber(),fillCount,moves:moves.length,moveLog:moves,holds,activeMs,outMs,missingMs,stopped,
    finalEquity:finalEquity.toFixed(),cash:cash.toFixed(),position:position.toFixed(),finalMark:bars[input.end-1].close,
    finalPolicy:p,ledger,cycleState,executions};
}
