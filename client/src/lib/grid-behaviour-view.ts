import { GRID_BOUNDARY_RULE, GRID_MODES_POLICY_VERSION, isGridBehaviourMode, gridOneShotOwners } from '../../../shared/grid-behaviour';
import type { GridPlan } from '../../../server/grid-bot/engine-types';

export function gridModePlanValid(plan: GridPlan): boolean {
  if (!plan || !Array.isArray(plan.lines)) return false;
  if (plan.policyVersion !== undefined && !['1.0.0', '2.0.0', GRID_MODES_POLICY_VERSION].includes(plan.policyVersion)) return false;
  if (plan.policyVersion !== GRID_MODES_POLICY_VERSION) return plan.behaviourMode === undefined && plan.gridPolicyExtension === undefined;
  const e = plan.gridPolicyExtension;
  if (!isGridBehaviourMode(plan.behaviourMode) || !e || e.mode !== plan.behaviourMode || e.reservationAlgorithm !== 'lean-1'
    || e.boundaryRule !== GRID_BOUNDARY_RULE || !Array.isArray(plan.cycles) || !plan.cycles.every(c => c && typeof c === 'object') || !Array.isArray(e.owners) || !Array.isArray(e.selectedOwnerOrdinals) || !Array.isArray(e.boundaryPrices)) return false;
  const expected = gridOneShotOwners(e.mode, plan.cycles.filter(c => c.anchor === 'closing').map(c => c.ownerOrdinal), plan.lines.length - 1, plan.side === 'long');
  return JSON.stringify(expected) === JSON.stringify(e.selectedOwnerOrdinals) && e.owners.length === plan.cycles.length
    && plan.cycles.every(c => c.recycles === !expected.includes(c.ownerOrdinal) && c.enabled === (c.recycles || e.seed)
      && (c.enabled ? Number(c.quantity) > 0 : Number(c.quantity) === 0));
}
export function gridModeLines(plan: GridPlan | null | undefined) {
  return plan?.lines.map(line => {
    const c = plan.cycles?.find(c => c.ownerOrdinal === line.ordinal);
    return { ...line, ...(c?.recycles !== undefined ? { recycles: c.recycles, enabled: c.enabled } : {}) };
  }) ?? [];
}
export function gridModeLineRole(plan: GridPlan, ordinal: number): string | null {
  const c = plan.cycles?.find(c => c.ownerOrdinal === ordinal);
  return c?.enabled === false ? 'Unused — no starting position' : c?.recycles === false ? 'Once only' : c?.recycles === true ? 'Keeps trading' : null;
}
export function gridModeBoundary(prices: string[], side: string) {
  return prices.length ? `${side === 'long' ? 'Sells' : 'Closes'} once at ${prices.map(p => String(Number(p))).join(', ')}.` : 'Every active line keeps trading.';
}
