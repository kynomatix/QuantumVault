import type { TradingBot } from '../../../shared/schema';
import { labMarket, LAB_PROVENANCE_MESSAGES } from '../../../shared/lab-provenance';
import { validLabSnapshot } from '../../lab/provenance-snapshot';

/** Owned by product/lab-provenance-live-bots. Flags cannot supply a Lab link. */
export function phoenixLabProvenanceSatisfied(bot: Pick<TradingBot, 'id'> & Partial<TradingBot>): {
  satisfied: boolean; reason: keyof typeof LAB_PROVENANCE_MESSAGES | null; message: string;
} {
  const denied = (reason: keyof typeof LAB_PROVENANCE_MESSAGES) => ({ satisfied: false, reason, message: LAB_PROVENANCE_MESSAGES[reason] });
  if (!['linked', 'owner_confirmed'].includes(bot.labLinkState ?? '')) return denied('LAB_UNLINKED');
  const snapshot = bot.labDeploySnapshot;
  if (!validLabSnapshot(snapshot)) return denied('LAB_SNAPSHOT_INVALID');
  if (typeof bot.market !== 'string' || snapshot.market !== labMarket(bot.market) || snapshot.botId !== bot.id
    || snapshot.ownerWallet !== bot.walletAddress) return denied('LAB_DEPLOYMENT_MISMATCH');
  return { satisfied: true, reason: null, message: 'Lab source confirmed. Other Phoenix checks still apply.' };
}
