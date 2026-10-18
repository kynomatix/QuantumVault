import { gridOneShotOwners, type GridBehaviourMode } from '../../shared/grid-behaviour';
import { gridPolicyExtension } from '../../server/grid-bot/behaviour-policy';
import { retainedGridCycles } from '../../server/grid-bot/cycle-policy';
import { gridSeedPriceBounds } from '../../server/grid-bot/cycle-engine';
import type { GridPolicy } from '../../server/grid-bot/policy-hmac';
import { cyclePolicy } from './cycle-fixtures';

export function withBehaviour(base: GridPolicy, mode: GridBehaviourMode): GridPolicy {
  const cycles = retainedGridCycles(base)!;
  const selected = gridOneShotOwners(mode, cycles.filter(c => c.anchor === 'closing').map(c => c.ownerOrdinal), base.gridCount, base.direction === 'long');
  for (const c of cycles) {
    c.recycles = !selected.includes(c.ownerOrdinal); c.enabled = c.recycles || base.seedAtCreation;
    if (!c.enabled) c.quantity = '0';
    if (!c.recycles) c.initialOpeningCredit = '0';
  }
  const envelope = base.safetyEnvelopePrice ?? (base.direction === 'long' ? base.upperPrice : '130.00000000');
  return { ...base, policyVersion: '2.2.0', runtimePolicyVersion: '2.2.0', sizingVersion: 'lean-1', safetyEnvelopePrice: envelope,
    levels: base.levels.map((l, i) => ({ ...l, size: cycles.find(c => c.ownerOrdinal === i)?.enabled === false ? '0.00000000' : l.size })),
    gridPolicyExtension: gridPolicyExtension(cycles, mode, envelope, base.seedAtCreation, base.direction === 'long', gridSeedPriceBounds(base.startPrice, '0.01')) };
}
export const behaviourPolicy = (mode: GridBehaviourMode, side: 'long' | 'short' = 'long', seed = true) => withBehaviour(cyclePolicy(side, seed), mode);
