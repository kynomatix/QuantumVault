import { withPhoenixBotSigner } from './custody';
import { phoenixIdentityFromBot } from './identity';
import type { FundingIntent } from './funding-contract';

/** Resolve the owned bot anew for every signing lifetime. The caller supplies only
 * a previously authorized wallet signer for the initial wallet-to-bot transfer.
 * This factory is not installed into a live runtime in U04.
 */
export function phoenixFundingSigner(
  getBot: (id: string) => Promise<Parameters<typeof withPhoenixBotSigner>[0]>,
  withOwnedWalletSigner: <T>(owner: string, source: string, sign: (secret: Uint8Array) => T) => Promise<T>,
) {
  return async <T>(intent: FundingIntent, sign: (secret: Uint8Array) => T): Promise<T> => {
    const bot = await getBot(intent.botId);
    const identity = phoenixIdentityFromBot(bot);
    if (bot.walletAddress !== intent.ownerWallet || identity.authorityWalletAddress !== intent.identity.authorityWalletAddress
      || identity.traderAccountAddress !== intent.identity.traderAccountAddress) throw new Error('Funding custody identity mismatch');
    if (intent.funding.leg === 'wallet_funding') return withOwnedWalletSigner(intent.ownerWallet, intent.funding.sourceWallet, sign);
    return withPhoenixBotSigner(bot, sign);
  };
}
