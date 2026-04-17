const SOLANA_ENV = process.env.SOLANA_NETWORK || 'mainnet-beta';
const IS_MAINNET = SOLANA_ENV === 'mainnet-beta';

export const PACIFICA_USDC_MINT = IS_MAINNET
  ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  : '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
