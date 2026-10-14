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
/** Only offer currently applicable requests. Resume authority remains unavailable. */
export function gridVisibleActions(surface:GridBotSurface){return (['pause','resync','stop'] as const).filter(action=>gridActionAllowed(surface.bot,action));}
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
