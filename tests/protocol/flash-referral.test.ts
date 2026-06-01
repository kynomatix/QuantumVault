import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  getReferralAccounts,
  deriveTokenStakeAccount,
  deriveUserReferralAccount,
  FLASH_PRIVILEGE_REFERRAL,
  FLASH_PRIVILEGE_NONE,
  FLASH_PRIVILEGE_STAKE,
} from '../../server/protocol/flash/flash-referral.js';
import { FLASH_PROGRAM_ID, FLASH_BUILDER_WALLET } from '../../server/protocol/flash/flash-constants.js';

// Flash referral attribution is by WALLET (Flash has no string builder code). Every
// fee-bearing trade ix (openPosition / swapAndOpen / decreaseSize / closePosition /
// closeAndSwap) threads `privilege: Referral` + two PDAs: the partner token_stake
// sink (rebate pools to ONE wallet — does NOT fragment per bot) and the trader's
// referral account (per bot wallet). Trigger-order placement/cancel are not fee
// events and carry no privilege/referral metas. This pins the PDA derivation and
// the privilege literal so a wrong seed (which fails closed on-chain) is caught here.

const FLASH_PROGRAM = new PublicKey(FLASH_PROGRAM_ID);
const PARTNER = new PublicKey(FLASH_BUILDER_WALLET);

// Two arbitrary, distinct bot wallets.
const BOT_A = new PublicKey('AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez');
const BOT_B = new PublicKey('11111111111111111111111111111112');

function expectedPda(seed: string, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), wallet.toBuffer()],
    FLASH_PROGRAM,
  )[0];
}

describe('flash-referral PDA derivation', () => {
  it('derives the partner token_stake sink from the BUILDER wallet (not the bot)', () => {
    const { tokenStakeAccount } = getReferralAccounts(BOT_A);
    expect(tokenStakeAccount.toBase58()).toBe(expectedPda('token_stake', PARTNER).toBase58());
  });

  it('derives the user referral account from the BOT wallet', () => {
    const { userReferralAccount } = getReferralAccounts(BOT_A);
    expect(userReferralAccount.toBase58()).toBe(expectedPda('referral', BOT_A).toBase58());
  });

  it('pools the rebate into ONE partner sink regardless of which bot trades', () => {
    const a = getReferralAccounts(BOT_A);
    const b = getReferralAccounts(BOT_B);
    // Same partner token_stake sink for every bot...
    expect(a.tokenStakeAccount.toBase58()).toBe(b.tokenStakeAccount.toBase58());
    // ...but a distinct per-trader referral account.
    expect(a.userReferralAccount.toBase58()).not.toBe(b.userReferralAccount.toBase58());
  });

  it('is deterministic for a given wallet', () => {
    const first = getReferralAccounts(BOT_A);
    const second = getReferralAccounts(BOT_A);
    expect(first.tokenStakeAccount.toBase58()).toBe(second.tokenStakeAccount.toBase58());
    expect(first.userReferralAccount.toBase58()).toBe(second.userReferralAccount.toBase58());
  });

  it('uses distinct seeds — token_stake and referral never collide for the same wallet', () => {
    expect(deriveTokenStakeAccount(BOT_A).toBase58()).not.toBe(
      deriveUserReferralAccount(BOT_A).toBase58(),
    );
  });

  it('produces valid off-curve program addresses', () => {
    const { tokenStakeAccount, userReferralAccount } = getReferralAccounts(BOT_A);
    expect(PublicKey.isOnCurve(tokenStakeAccount.toBytes())).toBe(false);
    expect(PublicKey.isOnCurve(userReferralAccount.toBytes())).toBe(false);
  });
});

describe('flash-referral privilege literals', () => {
  it('Referral privilege is the anchor enum literal { referral: {} }', () => {
    expect(FLASH_PRIVILEGE_REFERRAL).toEqual({ referral: {} });
  });

  it('Referral is distinct from None and Stake', () => {
    expect(FLASH_PRIVILEGE_REFERRAL).not.toEqual(FLASH_PRIVILEGE_NONE);
    expect(FLASH_PRIVILEGE_REFERRAL).not.toEqual(FLASH_PRIVILEGE_STAKE);
  });
});
