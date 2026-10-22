/** Read-only advisory; unavailable is never equivalent to not squeezed. */
export type GridSqueeze = {
  state: 'available'; market: string; squeezed: boolean; bandwidth: number; percentile: number;
  historyDays: number; latestFinalizedTime: number; retrievedAt: number; validForMs: number;
} | { state: 'unavailable'; reason: string };
