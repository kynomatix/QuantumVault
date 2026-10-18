import {gridActionAllowed,type GridBotSurface,type GridOwnerAction} from '../../../shared/grid-surface';
import Decimal from 'decimal.js';
import {stopLocksProfit} from '../../../shared/grid-breakeven';
const D = Decimal.clone({precision:220});
/** Invalidate reads on selection, identity, action submission and newer reads. */
export class GridReadOrder {
  private version=0;
  next(){return ++this.version;}
  accepts(version:number){return version===this.version;}
}
/** Retain an idempotency key after a lost HTTP response; never auto-submit. */
export class GridActionKeys {
  private keys=new Map<string,string>();
  key(bot:string,action:GridOwnerAction,uuid:()=>string){const name=bot+':'+action;let key=this.keys.get(name);if(!key){key=uuid();this.keys.set(name,key);}return key;}
  accepted(bot:string,action:GridOwnerAction){this.keys.delete(bot+':'+action);}
}
export function gridAdjustReady(surface:GridBotSurface){return surface.bot.status==='stopped'&&surface.lifecycle.state==='complete'&&surface.sweep==='Confirmed terminal';}
export function gridFactsFresh(surface:GridBotSurface,now:number){const at=Date.parse(surface.observedAt??'');return at<=now&&now-at<=15000;}
/** Capability is not admission: Resume still performs fresh production checks. */
export function gridVisibleActions(surface:GridBotSurface):GridOwnerAction[]{
  if(!surface.workerRunning)return [];
  return (['pause','resume','resync','stop'] as const).filter(action=>gridActionAllowed(surface.bot,action)
    &&(action!=='pause'||surface.bot.status!=='paused'&&(surface.bot.status!=='range_exhausted'||surface.autoResume?.enabled===true))
    &&(action!=='resume'||surface.authorities.resume));
}
export function gridCanAdjust(surface:GridBotSurface){return surface.startEnabled&&surface.workerRunning&&!!surface.bot.createIntent
  &&(gridAdjustReady(surface)||gridActionAllowed(surface.bot,'stop'));}
export function gridCanStartAgain(surface:GridBotSurface){return surface.draftEnabled&&gridCanAdjust(surface)&&gridAdjustReady(surface);}
export function gridLaunchState(surface:GridBotSurface){
  if(surface.bot.status==='draft')return surface.startEnabled?'Draft ready for review and Start':'Draft saved; Start is off';
  if(surface.bot.status==='stopping')return 'Stop pending; waiting for orders, positions and settlement';
  if(surface.bot.status==='stopped')return 'Stopped; terminal settlement confirmed';
  const op=surface.operations[0];
  if(op&&['prepared','submitted','unconfirmed'].includes(op.state)){const step=({provision_subaccount:'Creating isolated account',fund_subaccount:'Funding isolated account',set_leverage:'Setting leverage',
    seed_position:'Placing starting position',place_level_order:'Placing order',cancel_level_order:'Cancelling order',close_position:'Closing position',sweep_subaccount:'Returning funds to master'} as Record<string,string>)[op.type]??op.type.replaceAll('_',' ');
    return step+(['submitted','unconfirmed'].includes(op.state)?'; awaiting exchange confirmation':'; prepared');}
  return ({provisioning:'Provisioning isolated account',canary:'First order confirmed; checking clean trading history',active:'Trading',
    pausing:'Pause pending',paused:'Paused',resuming:'Checking current authority before resuming',reconciling:'Checking exchange state',
    range_exhausted:'Range exhausted; entries paused'} as Record<string,string>)[surface.bot.status]??surface.bot.status.replaceAll('_',' ');
}
const positive = (value: string | null) => {
  if (typeof value !== 'string' || value.length > 100 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const number = new Decimal(value); return number.gt(0) ? number : null;
};
export function gridRangeState(surface: GridBotSurface, now: number) {
  const mark = positive(surface.mark), lower = positive(surface.bot.lowerPrice), upper = positive(surface.bot.upperPrice);
  if (!gridFactsFresh(surface, now) || !mark || !lower || !upper || !lower.lt(upper)) return 'Price unavailable';
  return mark.gt(upper) ? 'Above range' : mark.lt(lower) ? 'Below range' : 'Within range';
}
/** Bot-lifetime display; legacy surfaces retain their existing position-only line. */
export function gridBreakevenView(surface: GridBotSurface, now: number) {
  if (surface.bot.status === 'stopped') return null;
  const price = positive(surface.pnl.botBreakeven === undefined ? surface.pnl.breakeven : surface.pnl.botBreakeven), size = positive(surface.position?.size ?? null);
  const direction = surface.position?.direction;
  if (!gridFactsFresh(surface, now) || !price || !size || !['long', 'short'].includes(direction ?? '')) return null;
  const mark = positive(surface.mark);
  const percent = mark ? mark.minus(price).div(price).mul(direction === 'long' ? 100 : -100) : null;
  return { price: price.toFixed(), percent: percent?.toDecimalPlaces(2).toFixed(2) ?? null,
    tone: percent === null || percent.isZero() ? 'neutral' : percent.gt(0) ? 'profit' : 'loss' };
}

export interface GridAutoResumeView {state:'waiting'|'checking'|'attention';title:string;detail?:string;action?:'resume'|'review'}
export const GRID_AUTO_RESUME_ATTENTION_MS=10*60*1000;
/** Internal reasons collapse into two held states; owner/risk pauses use the normal view. */
export function gridAutoResumeView(surface:GridBotSurface,now:number):GridAutoResumeView|null{
  const a=surface.autoResume;
  if(!a?.enabled||!['range_exhausted','resuming'].includes(surface.bot.status)||['pause','stop'].includes(surface.lifecycle.action??''))return null;
  if(a.unavailableReason==='range_unavailable')return null;
  const reason=a.heldReason;
  if(reason==='preference_off'||!a.armed&&(!reason||reason==='waiting_for_inner_band'))return null;
  const attention=['retry_limit','execution_revoked','policy_changed','risk_pause'].includes(reason??'');
  const checking=reason!=='waiting_for_inner_band'||!a.available||!a.band||!surface.workerRunning||!surface.startEnabled||!gridFactsFresh(surface,now);
  const heldAt=Date.parse(a.heldSince??'');
  if(attention||checking&&heldAt<=now&&now-heldAt>=GRID_AUTO_RESUME_ATTENTION_MS){
    const action=!['execution_revoked','policy_changed','risk_pause'].includes(reason??'')&&gridVisibleActions(surface).includes('resume')?'resume':'review';
    return {state:'attention',title:'Needs your attention',detail:action==='resume'?'Your bot needs a fresh safety check before it can resume.':'Review your bot settings before resuming.',action};
  }
  if(checking)return {state:'checking',title:'Resuming — checking safety'};
  return {state:'waiting',title:'Waiting for price to return'};
}
export function gridProfitCoversPosition(surface: GridBotSurface, now: number) {
  return surface.bot.status !== 'stopped' && gridFactsFresh(surface, now) && surface.position?.direction === 'long'
    && positive(surface.position.size) !== null && surface.pnl.profitCoversPosition === true;
}
/** Distance is a move from today's mark, rather than a return on the breakeven price. */
export function gridBreakevenSentence(surface: GridBotSurface, now: number): string | null {
  if (gridProfitCoversPosition(surface, now)) return 'Profit covers your position';
  const line = gridBreakevenView(surface, now), mark = positive(surface.mark);
  if (!line || !mark) return null;
  const side = surface.position!.direction, base = surface.bot.market.replace(/-PERP$/, '');
  const distance = new D(mark.toFixed()).minus(line.price).div(mark.toFixed()).mul(side === 'long' ? 100 : -100);
  if (distance.isZero()) return `${base} is at this bot's breakeven`;
  const rounded = distance.abs().toDecimalPlaces(1, distance.gt(0) ? Decimal.ROUND_DOWN : Decimal.ROUND_UP);
  const percent = rounded.isZero() ? 'less than 0.1' : rounded.toFixed(1);
  return distance.gt(0) ? `${base} can ${side === 'long' ? 'fall' : 'rise'} ${percent}% before this bot is at a loss`
    : `${base} needs to ${side === 'long' ? 'rise' : 'fall'} ${percent}% for this bot to break even`;
}
/** Assumes execution at the stop; already-paid fees are in Convention B. No rebates credited. */
export function gridStopProtected(surface: GridBotSurface, now: number): boolean {
  const fee = surface.stopFee, at = Date.parse(fee?.observedAt ?? ''), stop = positive(surface.bot.stopLossPrice);
  if (surface.bot.status === 'stopped' || !gridFactsFresh(surface, now) || !stop || !positive(surface.position?.size ?? null)
    || !fee || !Number.isFinite(at) || at > now || now - at > 5000
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fee.rate) || fee.rate.length > 100 || fee.rate.trim() !== fee.rate) return false;
  const rate = new D(fee.rate), side = surface.position!.direction;
  if (rate.gte(1) || side !== surface.bot.direction) return false;
  // Unlike the line view, a covered long can have a zero or negative threshold.
  const breakeven = surface.pnl.botBreakeven;
  const netStop = new D(stop.toFixed()).mul(side === 'long' ? new D(1).minus(rate) : new D(1).plus(rate));
  // The ledger DTO rounds to 18 places. Require more than one last-place unit
  // of headroom so its rounding can never turn a zero-profit stop into a claim.
  const roundingGuard = new D('0.000000000000000001');
  return stopLocksProfit(side, (side === 'long' ? netStop.minus(roundingGuard) : netStop.plus(roundingGuard)).toFixed(), breakeven ?? null);
}

/** V2 geometry is immutable; only the certified projection describes current order legs. */
export function gridCycleDisplayLevels(surface:GridBotSurface,now:number):GridBotSurface['levels']{
  if(surface.bot.policyVersion!=='2.0.0')return surface.levels;
  const p=surface.cycleProjection,at=p?Date.parse(p.observedAt):NaN;
  if(!p||!Number.isFinite(at)||at>now||now-at>15000)return [];
  return p.orders.map(o=>({id:`cycle:${o.ownerOrdinal}:${o.leg}`,ordinal:o.ownerOrdinal+1,price:o.price,size:o.size,
    side:o.side,reduceOnly:o.leg==='closing',status:o.state==='stopped'?'Stopped':o.state,cumulativeFilledSize:'0'}));
}
