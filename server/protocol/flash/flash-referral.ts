/**
 * Flash referral / builder-attribution helpers.
 *
 * Flash has NO string builder code (that is a Pacifica concept). On-chain
 * attribution is by WALLET: a trade instruction carries `privilege: Referral`
 * plus two PDAs — the partner's `token_stake` account (rebate sink, derived from
 * the builder wallet) and the trader's `referral` account (derived from the bot
 * wallet). See FLASH_INTEGRATION.md §5 Q5 / §13.1.
 *
 * PDA seeds are per §13.1 (`["token_stake", wallet]`, `["referral", wallet]`),
 * derived against the Flash program id. These seeds are documented but pending
 * mainnet confirmation (Phase 4 soak) — if a seed is wrong the trade ix will
 * reference a wrong account and FAIL on-chain (fail-closed: no silent loss, no
 * mis-routed funds), which the validation phase will surface immediately.
 */

import { PublicKey } from '@solana/web3.js';
import { FLASH_PROGRAM_ID, FLASH_BUILDER_WALLET } from './flash-constants.js';

const FLASH_PROGRAM = new PublicKey(FLASH_PROGRAM_ID);
const PARTNER_WALLET = new PublicKey(FLASH_BUILDER_WALLET);

const TOKEN_STAKE_SEED = Buffer.from('token_stake');
const REFERRAL_SEED = Buffer.from('referral');

/**
 * flash-sdk anchor enum literals. Defined structurally (not imported from the
 * SDK) so this module stays decoupled; the adapter casts them to the SDK's
 * `Side` / `Privilege` union types at the call boundary.
 */
export const FLASH_SIDE_LONG = { long: {} } as const;
export const FLASH_SIDE_SHORT = { short: {} } as const;
export const FLASH_SIDE_NONE = { none: {} } as const;
export const FLASH_PRIVILEGE_NONE = { none: {} } as const;
export const FLASH_PRIVILEGE_STAKE = { stake: {} } as const;
export const FLASH_PRIVILEGE_REFERRAL = { referral: {} } as const;

export function deriveTokenStakeAccount(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [TOKEN_STAKE_SEED, wallet.toBuffer()],
    FLASH_PROGRAM,
  )[0];
}

export function deriveUserReferralAccount(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [REFERRAL_SEED, wallet.toBuffer()],
    FLASH_PROGRAM,
  )[0];
}

export interface FlashReferralAccounts {
  /** Partner rebate sink — `["token_stake", builderWallet]`. */
  tokenStakeAccount: PublicKey;
  /** Trader referral account — `["referral", botWallet]`. */
  userReferralAccount: PublicKey;
}

/**
 * Resolve the referral account pair to thread into a trade instruction so the
 * 10% rebate accrues to the partner wallet. Threaded on EVERY trade path.
 */
export function getReferralAccounts(botWallet: PublicKey): FlashReferralAccounts {
  return {
    tokenStakeAccount: deriveTokenStakeAccount(PARTNER_WALLET),
    userReferralAccount: deriveUserReferralAccount(botWallet),
  };
}
