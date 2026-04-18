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
