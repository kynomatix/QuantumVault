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
