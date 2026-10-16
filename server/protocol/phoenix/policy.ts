import type { PhoenixBotIdentityColumns } from './identity';
import { phoenixIdentityFromBot } from './identity';

export type BotPolicyInput = PhoenixBotIdentityColumns & {
  market: string; leverage: number; maxPositionSize: string | null;
  totalInvestment?: string; side?: string; signalConfig?: unknown;
  riskConfig?: { stopLossPercent?: number; takeProfitPercent?: number } | null;
  aiTraderPolicy?: { policyVersion: 'phoenix-ai-v1'; ownerWallet: string; paperMode: boolean;
    aiBotId: string | null; bindingHash: string; sizingMode: string; riskMinPct: string; riskMaxPct: string };
};

/** Legacy bytes stay unchanged. Phoenix has a distinct, explicit version domain.
 * Every identity field is flattened: crypto-v3 sorts top-level keys only.
 */
export function botPolicyRecord(bot: BotPolicyInput): Record<string, unknown> {
  const legacy = { market: bot.market, leverage: bot.leverage, maxPositionSize: bot.maxPositionSize || '0' };
  if (bot.aiTraderPolicy) {
    if (bot.activeProtocol !== 'phoenix' || bot.aiTraderPolicy.policyVersion !== 'phoenix-ai-v1'
      || !bot.aiTraderPolicy.ownerWallet || !/^[0-9a-f]{64}$/.test(bot.aiTraderPolicy.bindingHash)) {
      throw new Error('Invalid Phoenix AI policy');
    }
    return { ...legacy, ...bot.aiTraderPolicy, venue: 'phoenix' };
  }
  if (bot.activeProtocol !== 'phoenix') {
    if ([bot.phoenixAuthorityWallet, bot.phoenixTraderAccount, bot.phoenixNetwork,
      bot.phoenixProgramAddress, bot.phoenixPortfolioIndex, bot.phoenixSubaccountIndex].some(v => v != null)) {
      throw new Error('Phoenix identity cannot be signed for another venue');
    }
    return legacy;
  }
  const identity = phoenixIdentityFromBot(bot);
  return { ...legacy, policyVersion: 'phoenix-v1', botId: bot.id, ownerWallet: bot.walletAddress,
    derivationIndex: bot.derivationIndex, ...identity,
    ...(bot.riskConfig ? { signalPolicyVersion: 'phoenix-fixed-signal-v1', totalInvestment: bot.totalInvestment,
      side: bot.side, signalConfig: JSON.stringify(bot.signalConfig ?? null),
      stopLossPercent: bot.riskConfig.stopLossPercent, takeProfitPercent: bot.riskConfig.takeProfitPercent } : {}) };
}
