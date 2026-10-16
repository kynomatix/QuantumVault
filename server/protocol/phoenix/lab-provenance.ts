import type { TradingBot } from '../../../shared/schema';

/** Owned by product/lab-provenance-live-bots. Flags cannot supply a Lab link. */
export function phoenixLabProvenanceSatisfied(_bot: Pick<TradingBot, 'id'>) {
  return { satisfied: false as boolean, reason: 'lab_provenance_required' as const,
    message: 'Needs a Lab link before it can start (coming)' };
}
