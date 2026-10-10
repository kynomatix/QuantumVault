import { PublicKey } from '@solana/web3.js';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';

/** Rise 0.6.1 ts/src/pdas.ts: trader, authority bytes, u8 portfolio, u8 subaccount.
 * U02 deliberately supports only the initial cross account (0,0), HD version 1.
 * This public derivation neither loads a key nor registers an account.
 */
export function derivePhoenixIdentity(authorityWalletAddress: string): PhoenixTraderIdentity {
  const authority = new PublicKey(authorityWalletAddress);
  if (authority.toBase58() !== authorityWalletAddress || !PublicKey.isOnCurve(authority.toBytes())) {
    throw new Error('Phoenix authority must be a canonical signing wallet');
  }
  const [trader] = PublicKey.findProgramAddressSync(
    [Buffer.from('trader'), authority.toBuffer(), Buffer.from([0]), Buffer.from([0])],
    new PublicKey(PHOENIX_PUBLIC_ADDRESSES.program),
  );
  return {
    venue: 'phoenix', network: 'solana-mainnet', programAddress: PHOENIX_PUBLIC_ADDRESSES.program,
    authorityWalletAddress, traderAccountAddress: trader.toBase58(),
    portfolioIndex: 0, subaccountIndex: 0, derivationVersion: 1,
  };
}

export function assertPhoenixIdentity(identity: PhoenixTraderIdentity): void {
  const expected = derivePhoenixIdentity(identity.authorityWalletAddress);
  for (const key of Object.keys(expected) as (keyof PhoenixTraderIdentity)[]) {
    if (identity[key] !== expected[key]) throw new Error(`Phoenix identity mismatch: ${key}`);
  }
}

export interface PhoenixBotIdentityColumns {
  activeProtocol?: string;
  id?: string;
  walletAddress?: string;
  protocolSubaccountId?: string | null;
  derivationIndex?: number | null;
  derivationPathVersion?: number | null;
  phoenixAuthorityWallet?: string | null;
  phoenixTraderAccount?: string | null;
  phoenixNetwork?: string | null;
  phoenixProgramAddress?: string | null;
  phoenixPortfolioIndex?: number | null;
  phoenixSubaccountIndex?: number | null;
}

export function phoenixIdentityFromBot(bot: PhoenixBotIdentityColumns): PhoenixTraderIdentity {
  if (bot.activeProtocol !== 'phoenix' || !bot.id || !bot.walletAddress
    || !Number.isInteger(bot.derivationIndex) || bot.derivationIndex! < 1 || bot.derivationIndex! > 2147483647) {
    throw new Error('Phoenix bot ownership or derivation missing');
  }
  const identity: PhoenixTraderIdentity = {
    venue: 'phoenix', network: bot.phoenixNetwork as PhoenixTraderIdentity['network'],
    programAddress: bot.phoenixProgramAddress!, authorityWalletAddress: bot.phoenixAuthorityWallet!,
    traderAccountAddress: bot.phoenixTraderAccount!, portfolioIndex: bot.phoenixPortfolioIndex!,
    subaccountIndex: bot.phoenixSubaccountIndex!, derivationVersion: bot.derivationPathVersion!,
  };
  assertPhoenixIdentity(identity);
  if (bot.protocolSubaccountId !== identity.traderAccountAddress) throw new Error('Phoenix trader alias mismatch');
  return identity;
}

export function phoenixIdentityColumns(identity: PhoenixTraderIdentity) {
  assertPhoenixIdentity(identity);
  return {
    phoenixAuthorityWallet: identity.authorityWalletAddress, phoenixTraderAccount: identity.traderAccountAddress,
    phoenixNetwork: identity.network, phoenixProgramAddress: identity.programAddress,
    phoenixPortfolioIndex: identity.portfolioIndex, phoenixSubaccountIndex: identity.subaccountIndex,
    derivationPathVersion: identity.derivationVersion, protocolSubaccountId: identity.traderAccountAddress,
  };
}
