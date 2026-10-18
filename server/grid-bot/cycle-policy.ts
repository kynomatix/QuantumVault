import Decimal from 'decimal.js';
import type { GridCycle } from './engine-types';
import type { GridPolicy } from './policy-hmac';

export const GRID_CYCLE_POLICY_VERSION = '2.0.0';
// Release only after Stage B's locked preparation, replay and lifecycle integration is reviewed.
// Server-owned, never selected by a request or an environment flag.
export const GRID_CYCLE_V2_CREATION = false;
const D = Decimal.clone({ precision: 120 });

/** Derive authority exclusively from immutable signed rows; never trust preview descriptors. */
export function retainedGridCycles(p: GridPolicy): GridCycle[] | null {
  try {
    if (p.policyVersion !== GRID_CYCLE_POLICY_VERSION || p.runtimePolicyVersion !== GRID_CYCLE_POLICY_VERSION
      || p.feePolicyVersion !== '1.0.0' || !['long', 'short'].includes(p.direction)
      || typeof p.seedAtCreation !== 'boolean' || p.levels.length !== p.gridCount + 1
      || !new D(p.startPrice).gt(p.lowerPrice) || !new D(p.startPrice).lt(p.upperPrice)) return null;
    const cycles: GridCycle[] = [], long = p.direction === 'long';
    for (const [i, row] of p.levels.entries()) {
      const price = new D(row.price), quantity = new D(row.size), start = new D(p.startPrice);
      if (row.ordinal !== i + 1 || !price.isFinite() || !price.gt(0) || !quantity.isFinite() || quantity.lt(0)
        || i > 0 && !price.gt(p.levels[i - 1].price)) return null;
      const equal = price.eq(start), opening = long ? price.lt(start) : price.gt(start);
      const closing = !opening && !equal;
      if (row.reduceOnly !== closing || row.side !== (long ? closing ? 'sell' : 'buy' : closing ? 'buy' : 'sell')) return null;
      if (equal) { if (!quantity.isZero()) return null; continue; }
      if (!quantity.gt(0)) return null;
      const openingOrdinal = opening ? i : i + (long ? -1 : 1);
      const closingOrdinal = opening ? i + (long ? 1 : -1) : i;
      if (!p.levels[openingOrdinal] || !p.levels[closingOrdinal]) return null;
      const seeded = closing && p.seedAtCreation;
      cycles.push({ ownerOrdinal: i, anchor: opening ? 'opening' : 'closing', openingOrdinal, closingOrdinal,
        openingPrice: p.levels[openingOrdinal].price, closingPrice: p.levels[closingOrdinal].price,
        quantity: row.size, initialInventory: seeded ? row.size : '0', initialOpeningCredit: seeded ? '0' : row.size });
    }
    return cycles;
  } catch { return null; }
}
