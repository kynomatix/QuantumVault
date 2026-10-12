import type {GridIntent} from './grid-draft';
export type GridOwnerAction='pause'|'resume'|'resync'|'stop';
export interface GridBotSummary {
  id:string;name:string;market:string;direction:string;status:string;lowerPrice:string;upperPrice:string;
  totalInvestment:string;stopLossPrice:string|null;gridCount:number;chartTimeframe:string;updatedAt:string;
  createIntent?:GridIntent;
}
export interface GridBotSurface {
  bot:GridBotSummary;
  levels:{id:string;ordinal:number;price:string;size:string;side:string;reduceOnly:boolean;status:string;cumulativeFilledSize:string}[];
  operations:{id:string;type:string;state:string}[];
  lifecycle:{action:string|null;state:string|null;blocker:string|null};
  pnl:{realised:string|null;unrealised:string|null;total:string|null;fees:string|null;averageEntry:string|null;breakeven:string|null};
  fills:{tradeId:string;time:number;leg:'entry'|'exit';size:string;price:string}[];
  cycles:number|null;
  position:{size:string;direction:string}|null;mark:string|null;observedAt:string|null;
  residual:string|null;sweep:string;
  capacity:{ordinaryWindow:number;reservedSlots:number;liveOrders:number|null;venueMaximum:number|null};
  authorities:{safeWindow:false;resume:false;lostSweepLookup:false;breaker:'not_monitored_by_venue_error_class'};
  notifications:{pending:number;uncertain:number};
  workerEnabled:false;startEnabled:false;
}
export function gridActionAllowed(bot:GridBotSummary,action:GridOwnerAction){
  if(['draft','failed','stopped'].includes(bot.status))return false;
  if(bot.status==='stopping')return action==='stop';
  if(action==='stop')return true;
  if(action==='pause')return ['active','canary','provisioning','resuming','reconciling','pausing'].includes(bot.status);
  return ['paused','range_exhausted'].includes(bot.status);
}
