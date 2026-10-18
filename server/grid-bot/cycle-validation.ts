import Decimal from 'decimal.js';
import type { GridPolicy } from './policy-hmac';
import { canonicalGridPolicy } from './policy-hmac';
import { retainedGridCycles } from './cycle-policy';
import { gridSeedPriceBounds } from './cycle-engine';
const D = Decimal.clone({ precision: 120 });
export interface GridCycleLimits {
  tick: string; lot: string; minimumQuote: string; maximumQuote: string; minimumPrice: string; maximumPrice: string;
  openingFeeRate: string; closingFeeRate: string;
}
/** Current limits may hold an immutable cycle, never resize it or issue fresh initial credit. */
export function validateRetainedGridCycles(policy: GridPolicy, limits: GridCycleLimits) {
  const deny = (reason: string) => ({ ok: false as const, reason });
  try {
    const cycles = retainedGridCycles(policy);
    if (!canonicalGridPolicy(policy) || !cycles) return deny('Retained cycle geometry is invalid.');
    if (![limits.tick,limits.lot,limits.minimumQuote,limits.maximumQuote,limits.minimumPrice,limits.maximumPrice]
      .every(v=>typeof v==='string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && v.length<=80 && new D(v).gt(0))) return deny('Current cycle limits are unavailable.');
    if (![limits.openingFeeRate,limits.closingFeeRate].every(v=>typeof v==='string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && v.length<=80)) return deny('Current cycle fees are unavailable.');
    for (const row of policy.levels) if (!new D(row.price).mod(limits.tick).eq(0) || new D(row.price).lt(limits.minimumPrice) || new D(row.price).gt(limits.maximumPrice)) return deny('Cycle node violates current price limits.');
    for (const c of cycles) {
      if (c.enabled === false) continue;
      const q=new D(c.quantity), open=new D(c.openingPrice), close=new D(c.closingPrice);
      if (!q.mod(limits.lot).eq(0) || c.recycles !== false && open.mul(q).lt(limits.minimumQuote) || (c.recycles === false ? close : D.max(open,close)).mul(q).gt(limits.maximumQuote)) return deny('Cycle endpoint violates current lot or quote limits.');
      if (!open.minus(close).abs().gt(open.mul(D.max(0,limits.openingFeeRate)).plus(close.mul(D.max(0,limits.closingFeeRate))))) return deny('Current fees consume a retained cycle spread.');
    }
    const bound=gridSeedPriceBounds(policy.startPrice,limits.tick);
    if (policy.gridPolicyExtension && policy.seedAtCreation && (new D(bound.high).gt(policy.gridPolicyExtension.seedPriceBounds.high) || new D(bound.low).lt(policy.gridPolicyExtension.seedPriceBounds.low))) return deny('Seed execution exceeds signed behaviour bounds.');
    const worst=D.max(policy.upperPrice,policy.seedAtCreation?bound.high:'0');
    const ceiling=new D(policy.totalInvestment).mul(policy.leverage);
    if(policy.sizingVersion==='lean-1') {
      const envelope=new D(policy.safetyEnvelopePrice!);
      if(envelope.lt(worst) || cycles.some(c=>new D(c.quantity).mul(envelope).gt(ceiling))
        || cycles.reduce((s,c)=>s.plus(c.initialInventory),new D(0)).mul(envelope).gt(ceiling)) return deny('Retained cycles exceed the safety envelope.');
    } else if(cycles.reduce((s,c)=>s.plus(c.quantity),new D(0)).mul(worst).gt(ceiling)) return deny('Retained cycles exceed configured capacity.');
    return { ok: true as const, cycles };
  } catch { return deny('Current cycle authority is invalid.'); }
}
