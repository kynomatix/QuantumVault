const SOLANA_ENV = process.env.SOLANA_NETWORK || 'mainnet-beta';
const IS_MAINNET = SOLANA_ENV === 'mainnet-beta';

export const PACIFICA_USDC_MINT = IS_MAINNET
  ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  : '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';

// Pacifica enforces a $10 minimum on deposits at the protocol layer. We apply
// the same threshold to every other money-movement path (withdraws, sweeps,
// auto top-ups, profit auto-withdraws) so sub-$10 transfers are skipped
// cleanly instead of failing at the protocol with cryptic errors or leaving
// dust stuck in subaccounts.
export const PACIFICA_MIN_TRANSFER_USDC = 10;

/**
 * Subaccount Recycling Plan §8 — a swept subaccount counts as "empty" only when
 * its equity is at or below this dust threshold. After a full sweep of a >= $10
 * balance the residue is sub-cent, so this is set conservatively small to ensure
 * we never pool a subaccount that still holds material principal.
 */
export const PACIFICA_RECYCLE_EMPTY_USDC = 0.5;

// Pacifica charges a flat $1 USDC fee on every on-chain withdrawal (deducted
// by the exchange before funds land in the Solana wallet). Internal
// subaccount-to-subaccount transfers do NOT incur this fee. We record it as
// a separate equity event after each successful on-chain withdraw so the
// user-visible balance math reconciles automatically.
// Source: https://docs.pacifica.fi/trading-on-pacifica/deposits-and-withdrawals
export const PACIFICA_WITHDRAW_FEE_USDC = 1;
