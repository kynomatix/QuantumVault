import { GRID_CAPS } from './grid-caps.js';
import {gridPlacementBudget} from '../../shared/grid-capacity';
export interface RestingUse { orderId: string; category: 'grid' | 'non-grid' | 'protection' | 'unclassified'; botId?: string }
export interface CapacityInput {
  owner: string; account: string; subaccountId: string | null; domain: string; expectedDomain: string;
  observedAt: number; expiresAt: number; complete: boolean; orders: RestingUse[];
  reservations: { id: string; slots: number }[]; activeBots: number; now: number;
}
/** Read model only: observations grant no slot reservation or live execution authority. */
export function gridCapacitySnapshot(input: CapacityInput) {
  const counts = { grid: 0, 'non-grid': 0, protection: 0, unclassified: 0 };
  const ids = new Set<string>(); let valid = true;
  for (const o of input.orders) {
    if (!/^[1-9]\d*$/.test(o.orderId) || ids.has(o.orderId) || !Object.hasOwn(counts, o.category)) { valid = false; break; }
    ids.add(o.orderId); counts[o.category]++;
  }
  const reservations = new Set<string>(); let pending = 0;
  for (const r of input.reservations) {
    if (!r.id || reservations.has(r.id) || !Number.isSafeInteger(r.slots) || r.slots < 0) { valid = false; break; }
    reservations.add(r.id); pending += r.slots;
  }
  valid &&= Number.isSafeInteger(pending) && !!input.owner && !!input.account && !!input.domain && input.domain === input.expectedDomain
    && input.complete && Number.isSafeInteger(input.now) && Number.isSafeInteger(input.observedAt)
    && Number.isSafeInteger(input.expiresAt) && input.now >= input.observedAt && input.now < input.expiresAt
    && input.expiresAt > input.observedAt && input.expiresAt - input.observedAt <= 60_000
    && Number.isSafeInteger(input.activeBots) && input.activeBots >= 0;
  const guaranteedAvailable = valid ? Math.max(0, GRID_CAPS.restingCapacityProof.provenFloor - input.orders.length - pending) : 0;
  const ordinaryAvailable = valid ? gridPlacementBudget(0, guaranteedAvailable) : 0;
  const canAdmitWindow = ordinaryAvailable > 0;
  return { owner: input.owner, account: input.account, subaccountId: input.subaccountId, domain: input.domain,
    observedUse: { availability: valid ? 'available' as const : 'unknown' as const,
      totalResting: valid ? input.orders.length : null, byCategory: valid ? counts : null,
      pendingReservedSlots: valid ? pending : null, observedAt: valid ? input.observedAt : null },
    restingCapacity: { ...GRID_CAPS.restingCapacityProof, guaranteedAvailable, actualVenueMaximum: null },
    policyWindow: { ordinaryLimit: GRID_CAPS.ordinaryRestingPerBot, sharedReserved: GRID_CAPS.sharedProtectionReserve,
      requiredAvailable: GRID_CAPS.requiredAvailableSlots, admittedOrdinaryLimit: canAdmitWindow ? ordinaryAvailable : 0 },
    batchActionLimit: GRID_CAPS.transportBatchActions,
    reason: !valid ? 'inventory_unknown_or_stale' : !canAdmitWindow ? 'insufficient_shared_slots' : null };
}
