import Decimal from 'decimal.js';
import { GRID_BOUNDARY_RULE, type GridBehaviourMode } from '../../shared/grid-behaviour';
import type { GridCycle } from './engine-types';
export interface GridPolicyExtension {
  reservationAlgorithm: 'lean-1'; mode: GridBehaviourMode; boundaryRule: typeof GRID_BOUNDARY_RULE;
  selectedOwnerOrdinals: number[]; boundaryPrices: string[]; safetyEnvelopePrice: string; seed: boolean;
  seedPriceBounds: { low: string; high: string };
  owners: { ownerOrdinal: number; recycles: boolean; enabled: boolean; quantity: string;
    openingOrdinal: number; closingOrdinal: number; initialInventory: string; initialOpeningCredit: string; openingValuationBound: string }[];
}
/** Canonical descriptor is recomputed from signed rows, not executable client metadata. */
export function gridPolicyExtension(cycles: GridCycle[], mode: GridBehaviourMode, envelope: string, seed: boolean,
  long: boolean, bounds: { low: string; high: string }): GridPolicyExtension {
  const fixed = (n: string) => new Decimal(n).toFixed(8);
  const selected = cycles.filter(c => c.recycles === false);
  return { reservationAlgorithm: 'lean-1', mode, boundaryRule: GRID_BOUNDARY_RULE,
    selectedOwnerOrdinals: selected.map(c => c.ownerOrdinal), boundaryPrices: selected.map(c => fixed(c.closingPrice)),
    safetyEnvelopePrice: fixed(envelope), seed, seedPriceBounds: { low: fixed(bounds.low), high: fixed(bounds.high) },
    owners: cycles.map(c => ({ ownerOrdinal: c.ownerOrdinal, recycles: c.recycles !== false, enabled: c.enabled !== false,
      quantity: fixed(c.quantity), openingOrdinal: c.openingOrdinal, closingOrdinal: c.closingOrdinal,
      initialInventory: fixed(c.initialInventory), initialOpeningCredit: fixed(c.initialOpeningCredit),
      openingValuationBound: fixed(c.enabled === false ? '0' : c.recycles === false ? bounds.high : !long ? envelope
        : Decimal.max(c.openingPrice, new Decimal(c.initialInventory).gt(0) ? bounds.high : '0').toFixed()) })) };
}
export const stableGridExtension = (value: unknown): string => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function retainedGridBehaviour(snapshot: any, version: string): { gridPolicyExtension?: GridPolicyExtension } {
  if (version !== '2.2.0') return {};
  if (!snapshot?.gridPolicyExtension) throw Error('Grid behaviour authority unavailable');
  return { gridPolicyExtension: snapshot.gridPolicyExtension };
}
