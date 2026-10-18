import type {GridIntent} from './grid-draft';
import type {GridStartRequest} from './grid-start';
export type GridOwnerAction='pause'|'resume'|'resync'|'stop';
export interface GridBotSummary {
  id:string;name:string;market:string;direction:string;status:string;lowerPrice:string;upperPrice:string;
  totalInvestment:string;stopLossPrice:string|null;gridCount:number;chartTimeframe:string;updatedAt:string;
  createIntent?:GridIntent;
  seedAtCreation?:boolean;leverage?:number;
}
export interface GridBotSurface {
  autoResume?:{enabled:boolean;generation:string;cycle:string;attempts:number;armed:boolean;heldReason:string|null;heldSince?:string|null;band:{lower:string;upper:string;tick:string}|null;available:boolean;unavailableReason?:'range_unavailable'|'market_data_unavailable'|'control_unavailable'};
  bot:GridBotSummary;
  levels:{id:string;ordinal:number;price:string;size:string;side:string;reduceOnly:boolean;status:string;cumulativeFilledSize:string}[];
  operations:{id:string;type:string;state:string}[];
  lifecycle:{action:string|null;state:string|null;blocker:string|null};
  pnl:{realised:string|null;unrealised:string|null;total:string|null;fees:string|null;averageEntry:string|null;breakeven:string|null};
  fills:{tradeId:string;time:number;leg:'entry'|'exit';size:string;price:string}[];
  cycles:number|null;
  qualification:{firstConfirmedAt:string|null;cleanSince:string|null;cleanTicks:number|null;promotedAt:string|null};
  position:{size:string;direction:string}|null;mark:string|null;observedAt:string|null;
  residual:string|null;sweep:string;
  returnedFunds:{amount:string|null;confirmedAt:string|null};
  capacity:{ordinaryWindow:number;reservedSlots:number;liveOrders:number|null;venueMaximum:number|null};
  authorities:{safeWindow:boolean;safeWindowState:'inferred'|'unavailable';resume:boolean;lostSweepLookup:false;breaker:'retained_terminal_failures'};
  entriesBlockedReasons:string[];
  /** Retained signed confirmation identity, including after admission. */
  startDraft:GridStartRequest|null;
  notifications:{pending:number;uncertain:number};
  draftEnabled:boolean;startConfigured:boolean;workerEnabled:boolean;workerRunning:boolean;startEnabled:boolean;
}
export function gridActionAllowed(bot:GridBotSummary,action:GridOwnerAction){
  if(['draft','failed','stopped'].includes(bot.status))return false;
  if(bot.status==='stopping')return action==='stop';
  if(action==='stop')return true;
  if(action==='pause')return ['active','canary','provisioning','resuming','reconciling','pausing','paused','range_exhausted'].includes(bot.status);
  return ['paused','range_exhausted'].includes(bot.status);
}
