/** Product window, transport batching and proven venue floor are different quantities. */
import {PER_BOT_ORDINARY_MAX, VENUE_OPEN_ORDER_CAPACITY, GRID_PROTECTION_RESERVE, GRID_TRANSPORT_BATCH_ACTIONS, GRID_FULL_WINDOW_SLOTS} from '../../shared/grid-capacity';
export const GRID_CAPS = Object.freeze({ ordinaryRestingPerBot: PER_BOT_ORDINARY_MAX, sharedProtectionReserve: GRID_PROTECTION_RESERVE,
  requiredAvailableSlots: GRID_FULL_WINDOW_SLOTS, intervals: 100, lines: 101, pilotBotsPerQuotaDomain: 2,
  transportBatchActions: GRID_TRANSPORT_BATCH_ACTIONS, subaccountsPerAgent: 10,
  restingCapacityProof: Object.freeze({ ruling: 'H.5/2026-09-28', provenFloor: VENUE_OPEN_ORDER_CAPACITY,
    venueMaximum: null, newSlotProofRequired: false }) });
