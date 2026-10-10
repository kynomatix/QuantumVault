import type { PhoenixBotIdentityColumns } from './identity';
import { phoenixIdentityFromBot } from './identity';

export type BotPolicyInput = PhoenixBotIdentityColumns & {
  market: string; leverage: number; maxPositionSize: string | null;
};

/** Legacy bytes stay unchanged. Phoenix has a distinct, explicit version domain.
 * Every identity field is flattened: crypto-v3 sorts top-level keys only.
 */
export function botPolicyRecord(bot: BotPolicyInput): Record<string, unknown> {
  const legacy = { market: bot.market, leverage: bot.leverage, maxPositionSize: bot.maxPositionSize || '0' };
  if (bot.activeProtocol !== 'phoenix') {
    if ([bot.phoenixAuthorityWallet, bot.phoenixTraderAccount, bot.phoenixNetwork,
      bot.phoenixProgramAddress, bot.phoenixPortfolioIndex, bot.phoenixSubaccountIndex].some(v => v != null)) {
      throw new Error('Phoenix identity cannot be signed for another venue');
    }
    return legacy;
  }
  const identity = phoenixIdentityFromBot(bot);
  return { ...legacy, policyVersion: 'phoenix-v1', botId: bot.id, ownerWallet: bot.walletAddress,
    derivationIndex: bot.derivationIndex, ...identity };
}
