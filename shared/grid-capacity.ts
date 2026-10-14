/** Owner's 100-grid policy; H.5 proves a floor, not Pacifica's actual maximum. */
export const PER_BOT_ORDINARY_MAX = 100;
export const VENUE_OPEN_ORDER_CAPACITY = 100;
export const GRID_PROTECTION_RESERVE = 5;
export const GRID_TRANSPORT_BATCH_ACTIONS = 10;
export const GRID_FULL_WINDOW_SLOTS = PER_BOT_ORDINARY_MAX + GRID_PROTECTION_RESERVE;
export const GRID_MINIMUM_LAUNCH_SLOTS = GRID_PROTECTION_RESERVE + 1;

/** availableSlots excludes observed orders, but has not subtracted retained reservations. */
export function gridPlacementBudget(ordinaryUsed: number, availableSlots: number, pendingSlots = 0) {
  if (![ordinaryUsed, availableSlots, pendingSlots].every(n => Number.isSafeInteger(n) && n >= 0)) return 0;
  return Math.max(0, Math.min(PER_BOT_ORDINARY_MAX - ordinaryUsed,
    Math.min(availableSlots, VENUE_OPEN_ORDER_CAPACITY - Math.max(0, ordinaryUsed - pendingSlots)) - pendingSlots - GRID_PROTECTION_RESERVE));
}
