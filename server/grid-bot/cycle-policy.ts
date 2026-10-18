import { isGridCyclePolicyVersion, isGridBehaviourMode, gridOneShotOwners } from '../../shared/grid-behaviour';
import Decimal from 'decimal.js';
import type { GridCycle } from './engine-types';
import type { GridPolicy } from './policy-hmac';

export const GRID_CYCLE_POLICY_VERSION = '2.0.0';
// New drafts use reviewed v2 cycling; signed drafts and existing bots retain their policy version.
// Server-owned, never selected by a request or an environment flag.
export const GRID_CYCLE_V2_CREATION = true;
const D = Decimal.clone({ precision: 120 });

/** Derive authority exclusively from immutable signed rows; never trust preview descriptors. */
export function retainedGridCycles(p: GridPolicy): GridCycle[] | null {
  try {
    if (!isGridCyclePolicyVersion(p.policyVersion) || p.runtimePolicyVersion !== p.policyVersion
      || p.feePolicyVersion !== '1.0.0' || !['long', 'short'].includes(p.direction)
      || typeof p.seedAtCreation !== 'boolean' || p.levels.length !== p.gridCount + 1
      || !new D(p.startPrice).gt(p.lowerPrice) || !new D(p.startPrice).lt(p.upperPrice)) return null;
    const cycles: GridCycle[] = [], long = p.direction === 'long', modes = p.policyVersion === '2.2.0';
    if (modes && !isGridBehaviourMode(p.gridPolicyExtension?.mode)) return null;
    const profits = p.levels.flatMap((l, i) => (long ? new D(l.price).gt(p.startPrice) : new D(l.price).lt(p.startPrice)) ? [i] : []);
    const selected = new Set(modes ? gridOneShotOwners(p.gridPolicyExtension!.mode, profits, p.gridCount, long) : []);
    for (const [i, row] of p.levels.entries()) {
      const price = new D(row.price), quantity = new D(row.size), start = new D(p.startPrice);
      if (row.ordinal !== i + 1 || !price.isFinite() || !price.gt(0) || !quantity.isFinite() || quantity.lt(0)
        || i > 0 && !price.gt(p.levels[i - 1].price)) return null;
      const equal = price.eq(start), opening = long ? price.lt(start) : price.gt(start);
      const closing = !opening && !equal;
      if (row.reduceOnly !== closing || row.side !== (long ? closing ? 'sell' : 'buy' : closing ? 'buy' : 'sell')) return null;
      if (equal) { if (!quantity.isZero()) return null; continue; }
      const recycles = !selected.has(i), enabled = recycles || p.seedAtCreation;
      if (enabled ? !quantity.gt(0) : !quantity.isZero()) return null;
      const openingOrdinal = opening ? i : i + (long ? -1 : 1);
      const closingOrdinal = opening ? i + (long ? 1 : -1) : i;
      if (!p.levels[openingOrdinal] || !p.levels[closingOrdinal]) return null;
      const seeded = closing && p.seedAtCreation;
      cycles.push({ ...(modes ? { enabled, recycles } : {}), ownerOrdinal: i, anchor: opening ? 'opening' : 'closing', openingOrdinal, closingOrdinal,
        openingPrice: p.levels[openingOrdinal].price, closingPrice: p.levels[closingOrdinal].price,
        quantity: row.size, initialInventory: seeded ? row.size : '0', initialOpeningCredit: seeded || !recycles ? '0' : row.size });
    }
    return cycles;
  } catch { return null; }
}
