import Decimal from 'decimal.js';
import type { GridPlan } from './engine-types';
const D = Decimal.clone({ precision: 100 });
/** Owner ruling 2026-10-12. Safe-side distance from projected liquidation. */
export const GRID_STOP_EXECUTION_CUSHION = '0.01';
export const GRID_SEED_MAX_SLIPPAGE_PERCENT = '0.5';
export interface GridProjectionInput {
  plan: GridPlan; funding: string; stop: string; tick: string; maxLeverage: string;
  makerRate: string; takerRate: string; observedAt: number; expiresAt: number;
}
const numeric = (s: unknown, signed = false): s is string => typeof s === 'string' && s.length <= 80
  && s.trim() === s && (signed ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/).test(s);
/** New, USDC-funded, single-market cross-margin subaccount only. No master equity input. */
export function projectGridStop(input: GridProjectionInput, now: number) {
  const deny = (reason: string) => ({ state: 'unavailable' as const, reason });
  try {
    const { plan: p } = input;
    if (![input.funding,input.stop,input.tick,input.maxLeverage,p.start,p.seedQuantity].every(s=>numeric(s))
      || ![input.makerRate,input.takerRate].every(s=>numeric(s,true)) || !['long','short'].includes(p.side)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(input.observedAt) || !Number.isSafeInteger(input.expiresAt)
      || input.observedAt > now || now >= input.expiresAt || input.expiresAt-input.observedAt > 300_000) return deny('Projection inputs are unknown or stale.');
    const tick=new D(input.tick), funding=new D(input.funding), max=new D(input.maxLeverage), stop=new D(input.stop);
    if (!tick.gt(0) || !funding.gt(0) || !max.gte(1) || !stop.gt(0) || !stop.mod(tick).eq(0)
      || !new D(p.leverage).gte(1) || new D(p.leverage).gt(max)) return deny('Invalid funding, stop tick or market leverage.');
    const long=p.side==='long', sign=long?1:-1;
    const seedPrice=new D(p.start).mul(new D(1).plus(new D(GRID_SEED_MAX_SLIPPAGE_PERCENT).div(100).mul(sign)))
      .div(tick).toDecimalPlaces(0,long?D.ROUND_CEIL:D.ROUND_FLOOR).mul(tick);
    let size=new D(p.seedQuantity), notional=size.mul(seedPrice), fees=notional.mul(D.max(0,input.takerRate));
    for (const level of p.lines.filter(l=>l.role==='entry')) {
      if (![level.price,level.quantity].every(s=>numeric(s)) || !new D(level.price).gt(0) || !new D(level.quantity).gte(0)) return deny('Entry exposure is unknown.');
      size=size.plus(level.quantity); notional=notional.plus(new D(level.quantity).mul(level.price));
      fees=fees.plus(new D(level.quantity).mul(level.price).mul(D.max(0,input.makerRate)));
    }
    const startup = { size: size.toFixed(), notional: notional.toFixed(), fees: fees.toFixed() };
    if (p.policyVersion === '2.0.0') {
      if (!p.cycles?.length || !p.capacityPrice || p.cycles.some(c => ![c.quantity,c.openingPrice,c.closingPrice].every(s=>numeric(s)&&new D(s).gt(0))))
        return deny('Reachable cycle inventory is unknown.');
      const candidates = p.cycles.map(c=>new D(c.openingPrice));
      if (new D(p.seedQuantity).gt(0)) candidates.push(seedPrice);
      const basis = long ? D.max(...candidates) : D.min(...candidates);
      size = p.cycles.reduce((sum,c)=>sum.plus(c.quantity),new D(0));
      notional = size.mul(basis);
      fees = size.mul(p.capacityPrice).mul(D.max(0,input.makerRate,input.takerRate));
    }
    if (!size.gt(0) || !funding.gt(fees) || !seedPrice.gt(0)) return deny('Projected exposure or funded margin is unavailable.');
    const entry=notional.div(size), margin=funding.minus(fees);
    // Pacifica: (price - side*position_margin/size)/(1-side/(2*market_max_leverage)).
    // At weighted entry there is no unrealized PnL; margin is NEW subaccount funding minus entry fees.
    let projected=entry.minus(margin.div(size).mul(sign)).div(new D(1).minus(new D(sign).div(max.mul(2))));
    if (p.policyVersion === '2.0.0' && new D(startup.size).gt(0)) {
      if (!funding.gt(startup.fees)) return deny('Startup funded margin is unavailable.');
      const initial = new D(startup.notional).div(startup.size).minus(funding.minus(startup.fees).div(startup.size).mul(sign))
        .div(new D(1).minus(new D(sign).div(max.mul(2))));
      projected = long ? D.max(projected,initial) : D.min(projected,initial);
    }
    // A nonpositive long liquidation boundary is conservatively represented by one tick.
    const liquidation=D.max(tick,projected).div(tick).toDecimalPlaces(0,long?D.ROUND_CEIL:D.ROUND_FLOOR).mul(tick);
    const clearance=D.max(tick,liquidation.mul(GRID_STOP_EXECUTION_CUSHION).div(tick).ceil().mul(tick));
    if (long ? !stop.lt(p.start) || stop.minus(liquidation).lt(clearance) : !stop.gt(p.start) || liquidation.minus(stop).lt(clearance))
      return deny('Stop must remain at least 1% on the safe side of projected liquidation, rounded to the market tick.');
    return {state:'available' as const,liquidation:liquidation.toFixed(),validatedClearance:clearance.toFixed(),
      boundedAdverseExitPrice:stop.toFixed(),observedAt:input.observedAt,expiresAt:input.expiresAt,
      source:'pacifica:documented-liquidation-formula:new-subaccount:owner-2026-10-12',
      projection:{funding:funding.toFixed(),fees:fees.toFixed(),size:size.toFixed(),weightedEntry:entry.toFixed(),
        maintenanceRate:new D(1).div(max.mul(2)).toFixed(),maxLeverage:max.toFixed(),seedWorstPrice:seedPrice.toFixed(),
        ...(p.policyVersion === '2.0.0' ? { scenario: 'all_reachable_cycle_inventory', startup } : {})}};
  } catch { return deny('Projection inputs are unknown or invalid.'); }
}
