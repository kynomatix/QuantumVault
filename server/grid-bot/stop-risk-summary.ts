import Decimal from 'decimal.js';
import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import type { GridPlan } from './engine-types';
import type { GridDraftAuthority } from './draft-service';
import { validateGridFeeQuote } from './fee-authority';
const D = Decimal.clone({ precision: 100, toExpNeg: -100, toExpPos: 100 });
export type GridStopRisk = { state: 'unavailable'; reason: string } | {
  state: 'available'; loss: string; inventory: string; entryFees: string; exitFee: string;
  scenario: 'adverse_entries_plus_seed'; stopPrice: string; expiresAt: number;
  exclusions: 'Funding, price gaps and failed stop execution';
};
const numeric = (value: unknown): value is string => typeof value === 'string' && value.length <= 80
  && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
/** Read-only scenario, never liquidation or launch authority. All adverse entry cycles fill once,
 * plus initial seed inventory; paired exits are not extra inventory. Mark at the stop, with
 * maker entries and a taker exit. Seed uses its adverse canonical execution bound. No recycling,
 * funding, gaps or stop failure is modeled: this estimate is NOT a cap on losses.
 * The existing account taker quote supplies the exit assumption too: fee-authority derives its
 * venue rate from liquidity role, independent of entry/profit purpose. No new fee override.
 */
export function gridStopRiskSummary(plan: GridPlan | null, stopPrice: string, authority: GridDraftAuthority, now: number, expiresAt: number): GridStopRisk {
  const deny = (reason: string): GridStopRisk => ({ state: 'unavailable', reason });
  try {
    if (!plan || authority.stop.state !== 'available' || !numeric(stopPrice) || !numeric(plan.start) || !numeric(plan.seedQuantity)
      || !Number.isSafeInteger(expiresAt) || now >= expiresAt) return deny('Fresh stop and plan authority unavailable');
    const identity = { account: authority.referenceAccount ?? '', subaccountId: null, market: authority.market.market, builderCode: null, intent: 'entry' as const };
    const maker = authority.entryFee, taker = authority.seedFee;
    if (!maker || !taker || !validateGridFeeQuote(maker, { ...identity, liquidityRole: 'maker' }, now)
      || !validateGridFeeQuote(taker, { ...identity, liquidityRole: 'taker' }, now)) return deny('Current entry and taker exit fees unavailable');
    const deadline = Math.min(expiresAt, maker.expiresAt, taker.expiresAt, authority.stop.expiresAt);
    if (now >= deadline || now < authority.stop.observedAt) return deny('Stop estimate observations expired');
    const long = plan.side === 'long', stop = new D(stopPrice), start = new D(plan.start);
    if (!['long', 'short'].includes(plan.side) || !stop.gt(0) || (long ? !stop.lt(start) : !stop.gt(start))
      || !new D(authority.stop.boundedAdverseExitPrice).eq(stop)) return deny('Stop scenario is not bound to the accepted stop');
    let inventory = new D(plan.seedQuantity), basis = new D(0), entryFees = new D(0);
    if (inventory.gt(0)) {
      const bounds = plan.seedPriceBounds;
      if (!bounds || !numeric(bounds.low) || !numeric(bounds.high) || !new D(bounds.low).gt(0)
        || new D(bounds.low).gt(start) || new D(bounds.high).lt(start)) return deny('Seed execution bounds unavailable');
      basis = inventory.mul(long ? bounds.high : bounds.low);
      entryFees = basis.mul(D.max(0, taker.effectiveRate));
    }
    if (!isGridCyclePolicyVersion(plan.policyVersion) || !plan.cycles?.length) return deny('Canonical cycle quantities unavailable');
    let seed = new D(0);
    const owners = new Set<number>();
    for (const cycle of plan.cycles) {
      if (owners.has(cycle.ownerOrdinal) || ![cycle.openingPrice, cycle.quantity, cycle.initialInventory, cycle.initialOpeningCredit].every(numeric))
        return deny('Canonical cycle quantities unavailable');
      owners.add(cycle.ownerOrdinal);
      const quantity = new D(cycle.quantity), initial = new D(cycle.initialInventory), credit = new D(cycle.initialOpeningCredit), price = new D(cycle.openingPrice);
      if (!price.gt(0) || !initial.plus(credit).eq(quantity) || cycle.enabled === false && !quantity.eq(0)) return deny('Canonical inventory allocation unavailable');
      seed = seed.plus(initial);
      // Initial inventory already belongs to the seed; never add its paired opening again.
      if (credit.eq(0) || cycle.enabled === false) continue;
      if (long ? price.gt(start) || price.lt(stop) : price.lt(start) || price.gt(stop)) continue;
      inventory = inventory.plus(credit); basis = basis.plus(credit.mul(price));
      entryFees = entryFees.plus(credit.mul(price).mul(D.max(0, maker.effectiveRate)));
    }
    if (!seed.eq(plan.seedQuantity) || !inventory.gt(0)) return deny('Seed and cycle inventory cannot be reconciled');
    const exitNotional = inventory.mul(stop), exitFee = exitNotional.mul(D.max(0, taker.effectiveRate));
    const loss = D.max(0, (long ? basis.minus(exitNotional) : exitNotional.minus(basis)).plus(entryFees).plus(exitFee));
    return { state: 'available', loss: loss.toDecimalPlaces(2, D.ROUND_CEIL).toFixed(2), inventory: inventory.toFixed(),
      entryFees: entryFees.toFixed(), exitFee: exitFee.toFixed(), scenario: 'adverse_entries_plus_seed', stopPrice,
      expiresAt: deadline, exclusions: 'Funding, price gaps and failed stop execution' };
  } catch { return deny('Stop scenario inputs unavailable'); }
}
