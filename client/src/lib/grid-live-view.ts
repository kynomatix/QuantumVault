import {gridActionAllowed,type GridBotSurface,type GridOwnerAction} from '../../../shared/grid-surface';
import Decimal from 'decimal.js';
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
    &&(action!=='pause'||!['paused','range_exhausted'].includes(surface.bot.status)||surface.autoResume?.enabled===true)
    &&(action!=='resume'||surface.authorities.resume));
}
export function gridCanAdjust(surface:GridBotSurface){return surface.startEnabled&&surface.workerRunning&&!!surface.bot.createIntent
  &&(gridAdjustReady(surface)||gridActionAllowed(surface.bot,'stop'));}
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
/** Position-only display; existing ledger accounting remains the authority. */
export function gridBreakevenView(surface: GridBotSurface, now: number) {
  const price = positive(surface.pnl.breakeven), size = positive(surface.position?.size ?? null);
  const direction = surface.position?.direction;
  if (!gridFactsFresh(surface, now) || !price || !size || !['long', 'short'].includes(direction ?? '')) return null;
  const mark = positive(surface.mark);
  const percent = mark ? mark.minus(price).div(price).mul(direction === 'long' ? 100 : -100) : null;
  return { price: price.toFixed(), percent: percent?.toDecimalPlaces(2).toFixed(2) ?? null,
    tone: percent === null || percent.isZero() ? 'neutral' : percent.gt(0) ? 'profit' : 'loss' };
}

/** One primary explanation; owner controls take precedence over waiting copy. */
export function gridAutoResumeView(surface:GridBotSurface,now:number){
  const a=surface.autoResume;
  if(!a)return null;
  if(!a.enabled&&surface.bot.status==='paused'&&surface.lifecycle.action==='pause')return {title:'Paused by you',detail:'Your Pause wins. Resume manually when ready.',badge:'Auto-resume off'};
  if(!a.available&&a.unavailableReason!=='market_data_unavailable'&&a.unavailableReason!=='control_unavailable')return {title:'Auto-resume unavailable for this range',detail:'This range leaves no inner band after the 2% buffer. You can still Resume manually when safe, or Stop.',badge:''};
  if(!a.enabled||['active','canary'].includes(surface.bot.status))return null;
  const reason=a.heldReason;
  if(reason==='reconciliation_required')return {title:'Checking exchange state',detail:'Price is back inside. Waiting for orders and fills to reconcile.',badge:''};
  if(reason==='operation_pending')return {title:'Waiting for an operation to settle',detail:'An order or transfer is unconfirmed. No new request yet.',badge:''};
  if(['retry_limit','execution_revoked','policy_changed'].includes(reason??''))return {title:'Auto-resume held',detail:'Retry limit reached or execution access changed. Review, then Resume.',badge:''};
  if(!a.available||!surface.workerRunning||!surface.startEnabled||!gridFactsFresh(surface,now)||!a.armed||reason&&reason!=='waiting_for_inner_band')return {title:'Safety check needs attention',detail:'Stop clearance, margin or current data is unavailable. Entries stay paused.',badge:''};
  return {title:'Waiting to auto-resume',detail:'Entries paused; position held.',badge:surface.mark&&new Decimal(surface.mark).gt(surface.bot.upperPrice)?'Above range':surface.mark&&new Decimal(surface.mark).lt(surface.bot.lowerPrice)?'Below range':''};
}
