/**
 * Market Liquidity Service
 * Provides information about Drift perpetual markets with OI-based slippage estimates
 * 
 * Data sources:
 * 1. Primary: Drift public stats API (driftapi.com)
 * 2. Fallback: Static estimates based on Drift UI (updated periodically)
 * 
 * Cache: 24 hours with manual refresh capability
 */

export type RiskTier = 'recommended' | 'caution' | 'high_risk';

export interface MarketInfo {
  symbol: string;
  fullName: string;
  marketIndex: number;
  category: string[];
  baseAssetSymbol: string;
  riskTier: RiskTier;
  estimatedSlippagePct: number;
  openInterestUsd: number | null;
  lastPrice: number | null;
  isActive: boolean;
  warning?: string;
  maxLeverage?: number;
}

interface MarketMetadata {
  symbol: string;
  fullName: string;
  marketIndex: number;
  category: string[];
  baseAssetSymbol: string;
  isActive: boolean;
  maxLeverage: number;
  warning?: string;
}

interface StaticOiData {
  oiUsd: number;
  lastUpdated: string; // ISO date
}

// Market metadata (static - describes the market)
// CRITICAL: Market indices MUST match drift-executor.mjs PERP_MARKET_INDICES exactly
// Source of truth: https://drift-labs.github.io/v2-teacher/#market-indexes-names
const MARKET_METADATA: Record<string, MarketMetadata> = {
  'SOL-PERP': { symbol: 'SOL-PERP', fullName: 'Solana', marketIndex: 0, category: ['L1', 'Infra'], baseAssetSymbol: 'SOL', isActive: true, maxLeverage: 101 },
  'BTC-PERP': { symbol: 'BTC-PERP', fullName: 'Bitcoin', marketIndex: 1, category: ['L1', 'Payment'], baseAssetSymbol: 'BTC', isActive: true, maxLeverage: 101 },
  'ETH-PERP': { symbol: 'ETH-PERP', fullName: 'Ethereum', marketIndex: 2, category: ['L1', 'Infra'], baseAssetSymbol: 'ETH', isActive: true, maxLeverage: 101 },
  'APT-PERP': { symbol: 'APT-PERP', fullName: 'Aptos', marketIndex: 3, category: ['L1', 'Infra'], baseAssetSymbol: 'APT', isActive: true, maxLeverage: 10 },
  '1MBONK-PERP': { symbol: '1MBONK-PERP', fullName: 'Bonk', marketIndex: 4, category: ['Meme', 'Dog'], baseAssetSymbol: '1MBONK', isActive: true, maxLeverage: 10, warning: 'High volatility meme token' },
  'POL-PERP': { symbol: 'POL-PERP', fullName: 'Polygon', marketIndex: 5, category: ['L2', 'Infra'], baseAssetSymbol: 'POL', isActive: true, maxLeverage: 10 },
  'ARB-PERP': { symbol: 'ARB-PERP', fullName: 'Arbitrum', marketIndex: 6, category: ['L2', 'Infra'], baseAssetSymbol: 'ARB', isActive: true, maxLeverage: 10 },
  'DOGE-PERP': { symbol: 'DOGE-PERP', fullName: 'Dogecoin', marketIndex: 7, category: ['Meme', 'Dog'], baseAssetSymbol: 'DOGE', isActive: true, maxLeverage: 10 },
  'BNB-PERP': { symbol: 'BNB-PERP', fullName: 'Binance Coin', marketIndex: 8, category: ['Exchange'], baseAssetSymbol: 'BNB', isActive: true, maxLeverage: 10 },
  'SUI-PERP': { symbol: 'SUI-PERP', fullName: 'Sui', marketIndex: 9, category: ['L1'], baseAssetSymbol: 'SUI', isActive: true, maxLeverage: 10 },
  '1MPEPE-PERP': { symbol: '1MPEPE-PERP', fullName: 'Pepe', marketIndex: 10, category: ['Meme'], baseAssetSymbol: '1MPEPE', isActive: true, maxLeverage: 4, warning: 'High volatility meme token' },
  'OP-PERP': { symbol: 'OP-PERP', fullName: 'Optimism', marketIndex: 11, category: ['L2', 'Infra'], baseAssetSymbol: 'OP', isActive: true, maxLeverage: 10 },
  'RENDER-PERP': { symbol: 'RENDER-PERP', fullName: 'Render', marketIndex: 12, category: ['AI', 'GPU'], baseAssetSymbol: 'RENDER', isActive: true, maxLeverage: 10 },
  'XRP-PERP': { symbol: 'XRP-PERP', fullName: 'XRP', marketIndex: 13, category: ['L1', 'Payment'], baseAssetSymbol: 'XRP', isActive: true, maxLeverage: 20 },
  'HNT-PERP': { symbol: 'HNT-PERP', fullName: 'Helium', marketIndex: 14, category: ['IoT', 'Infra'], baseAssetSymbol: 'HNT', isActive: true, maxLeverage: 5 },
  'INJ-PERP': { symbol: 'INJ-PERP', fullName: 'Injective', marketIndex: 15, category: ['L1', 'DeFi'], baseAssetSymbol: 'INJ', isActive: true, maxLeverage: 10 },
  'LINK-PERP': { symbol: 'LINK-PERP', fullName: 'Chainlink', marketIndex: 16, category: ['Oracle', 'DeFi'], baseAssetSymbol: 'LINK', isActive: true, maxLeverage: 10 },
  'RLB-PERP': { symbol: 'RLB-PERP', fullName: 'Rollbit', marketIndex: 17, category: ['Gaming'], baseAssetSymbol: 'RLB', isActive: true, maxLeverage: 5 },
  'PYTH-PERP': { symbol: 'PYTH-PERP', fullName: 'Pyth Network', marketIndex: 18, category: ['Oracle', 'Solana'], baseAssetSymbol: 'PYTH', isActive: true, maxLeverage: 10 },
  'TIA-PERP': { symbol: 'TIA-PERP', fullName: 'Celestia', marketIndex: 19, category: ['L1', 'Modular'], baseAssetSymbol: 'TIA', isActive: true, maxLeverage: 10 },
  'JTO-PERP': { symbol: 'JTO-PERP', fullName: 'Jito', marketIndex: 20, category: ['DeFi', 'Solana'], baseAssetSymbol: 'JTO', isActive: true, maxLeverage: 10 },
  'SEI-PERP': { symbol: 'SEI-PERP', fullName: 'Sei', marketIndex: 21, category: ['L1', 'Trading'], baseAssetSymbol: 'SEI', isActive: true, maxLeverage: 10 },
  'AVAX-PERP': { symbol: 'AVAX-PERP', fullName: 'Avalanche', marketIndex: 22, category: ['L1', 'Infra'], baseAssetSymbol: 'AVAX', isActive: true, maxLeverage: 10 },
  'WIF-PERP': { symbol: 'WIF-PERP', fullName: 'dogwifhat', marketIndex: 23, category: ['Meme', 'Dog'], baseAssetSymbol: 'WIF', isActive: true, maxLeverage: 10 },
  'JUP-PERP': { symbol: 'JUP-PERP', fullName: 'Jupiter', marketIndex: 24, category: ['DeFi', 'Solana'], baseAssetSymbol: 'JUP', isActive: true, maxLeverage: 10 },
  'DYM-PERP': { symbol: 'DYM-PERP', fullName: 'Dymension', marketIndex: 25, category: ['L1', 'Modular'], baseAssetSymbol: 'DYM', isActive: true, maxLeverage: 5 },
  'TAO-PERP': { symbol: 'TAO-PERP', fullName: 'Bittensor', marketIndex: 26, category: ['AI'], baseAssetSymbol: 'TAO', isActive: true, maxLeverage: 5 },
  'W-PERP': { symbol: 'W-PERP', fullName: 'Wormhole', marketIndex: 27, category: ['Bridge', 'Infra'], baseAssetSymbol: 'W', isActive: true, maxLeverage: 5 },
  'KMNO-PERP': { symbol: 'KMNO-PERP', fullName: 'Kamino', marketIndex: 28, category: ['DeFi', 'Solana'], baseAssetSymbol: 'KMNO', isActive: true, maxLeverage: 3 },
  'TNSR-PERP': { symbol: 'TNSR-PERP', fullName: 'Tensor', marketIndex: 29, category: ['NFT', 'Solana'], baseAssetSymbol: 'TNSR', isActive: true, maxLeverage: 5 },
  'DRIFT-PERP': { symbol: 'DRIFT-PERP', fullName: 'Drift Protocol', marketIndex: 30, category: ['DeFi', 'Solana'], baseAssetSymbol: 'DRIFT', isActive: true, maxLeverage: 5 },
  'CLOUD-PERP': { symbol: 'CLOUD-PERP', fullName: 'Cloud', marketIndex: 31, category: ['Infra'], baseAssetSymbol: 'CLOUD', isActive: true, maxLeverage: 3 },
  'IO-PERP': { symbol: 'IO-PERP', fullName: 'IO.net', marketIndex: 32, category: ['AI', 'GPU'], baseAssetSymbol: 'IO', isActive: true, maxLeverage: 5 },
  'ZEX-PERP': { symbol: 'ZEX-PERP', fullName: 'Zeta', marketIndex: 33, category: ['DeFi', 'Solana'], baseAssetSymbol: 'ZEX', isActive: true, maxLeverage: 5 },
  'POPCAT-PERP': { symbol: 'POPCAT-PERP', fullName: 'Popcat', marketIndex: 34, category: ['Meme'], baseAssetSymbol: 'POPCAT', isActive: true, maxLeverage: 4, warning: 'High volatility meme token' },
  '1KWEN-PERP': { symbol: '1KWEN-PERP', fullName: 'Wen', marketIndex: 35, category: ['Meme', 'Solana'], baseAssetSymbol: '1KWEN', isActive: true, maxLeverage: 5, warning: 'High volatility' },
  'TON-PERP': { symbol: 'TON-PERP', fullName: 'Toncoin', marketIndex: 36, category: ['L1'], baseAssetSymbol: 'TON', isActive: true, maxLeverage: 10 },
  'MOTHER-PERP': { symbol: 'MOTHER-PERP', fullName: 'Mother Iggy', marketIndex: 37, category: ['Meme'], baseAssetSymbol: 'MOTHER', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'MOODENG-PERP': { symbol: 'MOODENG-PERP', fullName: 'Moo Deng', marketIndex: 39, category: ['Meme'], baseAssetSymbol: 'MOODENG', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'DBR-PERP': { symbol: 'DBR-PERP', fullName: 'deBridge', marketIndex: 40, category: ['Bridge', 'Infra'], baseAssetSymbol: 'DBR', isActive: true, maxLeverage: 5 },
  '1KMEW-PERP': { symbol: '1KMEW-PERP', fullName: 'Cat in a Dog World', marketIndex: 41, category: ['Meme'], baseAssetSymbol: '1KMEW', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'MICHI-PERP': { symbol: 'MICHI-PERP', fullName: 'Michi', marketIndex: 42, category: ['Meme'], baseAssetSymbol: 'MICHI', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'GOAT-PERP': { symbol: 'GOAT-PERP', fullName: 'Goatseus Maximus', marketIndex: 43, category: ['Meme', 'AI'], baseAssetSymbol: 'GOAT', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'FWOG-PERP': { symbol: 'FWOG-PERP', fullName: 'Fwog', marketIndex: 44, category: ['Meme'], baseAssetSymbol: 'FWOG', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'PNUT-PERP': { symbol: 'PNUT-PERP', fullName: 'Peanut', marketIndex: 45, category: ['Meme'], baseAssetSymbol: 'PNUT', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'RAY-PERP': { symbol: 'RAY-PERP', fullName: 'Raydium', marketIndex: 46, category: ['DeFi', 'Solana'], baseAssetSymbol: 'RAY', isActive: true, maxLeverage: 5 },
  'HYPE-PERP': { symbol: 'HYPE-PERP', fullName: 'Hyperliquid', marketIndex: 47, category: ['DeFi', 'L1'], baseAssetSymbol: 'HYPE', isActive: true, maxLeverage: 10 },
  'LTC-PERP': { symbol: 'LTC-PERP', fullName: 'Litecoin', marketIndex: 48, category: ['L1', 'Payment'], baseAssetSymbol: 'LTC', isActive: true, maxLeverage: 10 },
  'ME-PERP': { symbol: 'ME-PERP', fullName: 'Magic Eden', marketIndex: 49, category: ['NFT', 'Solana'], baseAssetSymbol: 'ME', isActive: true, maxLeverage: 5 },
  'PENGU-PERP': { symbol: 'PENGU-PERP', fullName: 'Pudgy Penguins', marketIndex: 50, category: ['NFT', 'Meme'], baseAssetSymbol: 'PENGU', isActive: true, maxLeverage: 5 },
  'AI16Z-PERP': { symbol: 'AI16Z-PERP', fullName: 'ai16z', marketIndex: 51, category: ['AI', 'Meme'], baseAssetSymbol: 'AI16Z', isActive: true, maxLeverage: 5, warning: 'High volatility' },
  'TRUMP-PERP': { symbol: 'TRUMP-PERP', fullName: 'Trump', marketIndex: 52, category: ['Meme', 'Politics'], baseAssetSymbol: 'TRUMP', isActive: true, maxLeverage: 10, warning: 'High volatility meme token' },
  'MELANIA-PERP': { symbol: 'MELANIA-PERP', fullName: 'Melania', marketIndex: 53, category: ['Meme', 'Politics'], baseAssetSymbol: 'MELANIA', isActive: true, maxLeverage: 5, warning: 'High volatility meme token' },
  'BERA-PERP': { symbol: 'BERA-PERP', fullName: 'Berachain', marketIndex: 54, category: ['L1', 'DeFi'], baseAssetSymbol: 'BERA', isActive: true, maxLeverage: 5 },
  'KAITO-PERP': { symbol: 'KAITO-PERP', fullName: 'Kaito', marketIndex: 55, category: ['AI'], baseAssetSymbol: 'KAITO', isActive: true, maxLeverage: 5 },
  'IP-PERP': { symbol: 'IP-PERP', fullName: 'Story Protocol', marketIndex: 56, category: ['Infra'], baseAssetSymbol: 'IP', isActive: true, maxLeverage: 5 },
  'FARTCOIN-PERP': { symbol: 'FARTCOIN-PERP', fullName: 'Fartcoin', marketIndex: 57, category: ['Meme'], baseAssetSymbol: 'FARTCOIN', isActive: true, maxLeverage: 10, warning: 'High volatility meme token' },
  'ADA-PERP': { symbol: 'ADA-PERP', fullName: 'Cardano', marketIndex: 58, category: ['L1'], baseAssetSymbol: 'ADA', isActive: true, maxLeverage: 10 },
  'PAXG-PERP': { symbol: 'PAXG-PERP', fullName: 'PAX Gold', marketIndex: 59, category: ['Commodity', 'Gold'], baseAssetSymbol: 'PAXG', isActive: true, maxLeverage: 10 },
  'LAUNCHCOIN-PERP': { symbol: 'LAUNCHCOIN-PERP', fullName: 'Believe', marketIndex: 60, category: ['Meme', 'Solana'], baseAssetSymbol: 'LAUNCHCOIN', isActive: true, maxLeverage: 5, warning: 'High volatility' },
  'PUMP-PERP': { symbol: 'PUMP-PERP', fullName: 'Pump.fun', marketIndex: 61, category: ['Meme', 'Solana'], baseAssetSymbol: 'PUMP', isActive: true, maxLeverage: 5, warning: 'High volatility' },
  'ASTER-PERP': { symbol: 'ASTER-PERP', fullName: 'Aster', marketIndex: 62, category: ['L1'], baseAssetSymbol: 'ASTER', isActive: true, maxLeverage: 10 },
  'XPL-PERP': { symbol: 'XPL-PERP', fullName: 'XPL', marketIndex: 63, category: ['Infra'], baseAssetSymbol: 'XPL', isActive: true, maxLeverage: 10 },
  '2Z-PERP': { symbol: '2Z-PERP', fullName: '2Z', marketIndex: 64, category: ['Meme'], baseAssetSymbol: '2Z', isActive: true, maxLeverage: 5 },
  'MNT-PERP': { symbol: 'MNT-PERP', fullName: 'Mantle', marketIndex: 65, category: ['L2'], baseAssetSymbol: 'MNT', isActive: true, maxLeverage: 5 },
  '1KPUMP-PERP': { symbol: '1KPUMP-PERP', fullName: 'Pump', marketIndex: 66, category: ['Meme', 'Solana'], baseAssetSymbol: '1KPUMP', isActive: true, maxLeverage: 5, warning: 'High volatility' },
  'MET-PERP': { symbol: 'MET-PERP', fullName: 'Metaplex', marketIndex: 67, category: ['NFT', 'Solana'], baseAssetSymbol: 'MET', isActive: true, maxLeverage: 5 },
  '1KMON-PERP': { symbol: '1KMON-PERP', fullName: 'Mon', marketIndex: 68, category: ['Meme'], baseAssetSymbol: '1KMON', isActive: true, maxLeverage: 5, warning: 'High volatility' },
  'LIT-PERP': { symbol: 'LIT-PERP', fullName: 'Litentry', marketIndex: 69, category: ['Identity', 'Infra'], baseAssetSymbol: 'LIT', isActive: true, maxLeverage: 10 },
  'WLD-PERP': { symbol: 'WLD-PERP', fullName: 'Worldcoin', marketIndex: 70, category: ['Identity', 'AI'], baseAssetSymbol: 'WLD', isActive: true, maxLeverage: 5 },
  'NEAR-PERP': { symbol: 'NEAR-PERP', fullName: 'NEAR Protocol', marketIndex: 71, category: ['L1', 'AI'], baseAssetSymbol: 'NEAR', isActive: true, maxLeverage: 10 },
  'FTM-PERP': { symbol: 'FTM-PERP', fullName: 'Fantom', marketIndex: 72, category: ['L1'], baseAssetSymbol: 'FTM', isActive: true, maxLeverage: 10 },
  'ATOM-PERP': { symbol: 'ATOM-PERP', fullName: 'Cosmos', marketIndex: 73, category: ['L0', 'Infra'], baseAssetSymbol: 'ATOM', isActive: true, maxLeverage: 10 },
  'DOT-PERP': { symbol: 'DOT-PERP', fullName: 'Polkadot', marketIndex: 74, category: ['L0', 'Infra'], baseAssetSymbol: 'DOT', isActive: true, maxLeverage: 10 },
  'BCH-PERP': { symbol: 'BCH-PERP', fullName: 'Bitcoin Cash', marketIndex: 75, category: ['L1', 'Payment'], baseAssetSymbol: 'BCH', isActive: true, maxLeverage: 10 },
  'ZEC-PERP': { symbol: 'ZEC-PERP', fullName: 'Zcash', marketIndex: 79, category: ['L1', 'Privacy'], baseAssetSymbol: 'ZEC', isActive: true, maxLeverage: 5 },
};

// Static OI estimates (fallback data from Drift UI - Jan 14, 2026)
const STATIC_OI_DATA: Record<string, StaticOiData> = {
  'SOL-PERP': { oiUsd: 147_160_000, lastUpdated: '2026-01-14' },
  'BTC-PERP': { oiUsd: 77_100_000, lastUpdated: '2026-01-14' },
  'ETH-PERP': { oiUsd: 37_070_000, lastUpdated: '2026-01-14' },
  'SUI-PERP': { oiUsd: 1_770_000, lastUpdated: '2026-01-14' },
  'ZEC-PERP': { oiUsd: 1_750_000, lastUpdated: '2026-01-14' },
  'DRIFT-PERP': { oiUsd: 1_510_000, lastUpdated: '2026-01-14' },
  'HYPE-PERP': { oiUsd: 1_450_000, lastUpdated: '2026-01-14' },
  'JUP-PERP': { oiUsd: 1_360_000, lastUpdated: '2026-01-14' },
  'XRP-PERP': { oiUsd: 1_340_000, lastUpdated: '2026-01-14' },
  'PAXG-PERP': { oiUsd: 979_570, lastUpdated: '2026-01-14' },
  'FARTCOIN-PERP': { oiUsd: 835_930, lastUpdated: '2026-01-14' },
  'TAO-PERP': { oiUsd: 733_370, lastUpdated: '2026-01-14' },
  'LIT-PERP': { oiUsd: 598_240, lastUpdated: '2026-01-14' },
  '1MBONK-PERP': { oiUsd: 597_560, lastUpdated: '2026-01-14' },
  'DOGE-PERP': { oiUsd: 572_270, lastUpdated: '2026-01-14' },
  'LINK-PERP': { oiUsd: 397_510, lastUpdated: '2026-01-14' },
  'XPL-PERP': { oiUsd: 319_240, lastUpdated: '2026-01-14' },
  'WIF-PERP': { oiUsd: 297_390, lastUpdated: '2026-01-14' },
  'BNB-PERP': { oiUsd: 282_460, lastUpdated: '2026-01-14' },
  'PYTH-PERP': { oiUsd: 246_500, lastUpdated: '2026-01-14' },
  'ADA-PERP': { oiUsd: 213_120, lastUpdated: '2026-01-14' },
  'AVAX-PERP': { oiUsd: 207_090, lastUpdated: '2026-01-14' },
  'RAY-PERP': { oiUsd: 206_900, lastUpdated: '2026-01-14' },
  'JTO-PERP': { oiUsd: 194_380, lastUpdated: '2026-01-14' },
  'KMNO-PERP': { oiUsd: 180_070, lastUpdated: '2026-01-14' },
  'ASTER-PERP': { oiUsd: 173_280, lastUpdated: '2026-01-14' },
  'RENDER-PERP': { oiUsd: 169_250, lastUpdated: '2026-01-14' },
  'LTC-PERP': { oiUsd: 132_790, lastUpdated: '2026-01-14' },
  'IP-PERP': { oiUsd: 128_640, lastUpdated: '2026-01-14' },
  'TRUMP-PERP': { oiUsd: 123_740, lastUpdated: '2026-01-14' },
  'POPCAT-PERP': { oiUsd: 103_880, lastUpdated: '2026-01-14' },
  'HNT-PERP': { oiUsd: 95_660, lastUpdated: '2026-01-14' },
  'SEI-PERP': { oiUsd: 91_830, lastUpdated: '2026-01-14' },
  'TNSR-PERP': { oiUsd: 88_220, lastUpdated: '2026-01-14' },
  'INJ-PERP': { oiUsd: 87_610, lastUpdated: '2026-01-14' },
  'ARB-PERP': { oiUsd: 81_310, lastUpdated: '2026-01-14' },
  '1KPUMP-PERP': { oiUsd: 79_790, lastUpdated: '2026-01-14' },
  '1KMON-PERP': { oiUsd: 75_060, lastUpdated: '2026-01-14' },
  'BERA-PERP': { oiUsd: 74_390, lastUpdated: '2026-01-14' },
  'APT-PERP': { oiUsd: 63_890, lastUpdated: '2026-01-14' },
  'W-PERP': { oiUsd: 47_910, lastUpdated: '2026-01-14' },
  'TON-PERP': { oiUsd: 40_050, lastUpdated: '2026-01-14' },
  'TIA-PERP': { oiUsd: 39_810, lastUpdated: '2026-01-14' },
  '1MPEPE-PERP': { oiUsd: 32_800, lastUpdated: '2026-01-14' },
  'POL-PERP': { oiUsd: 32_520, lastUpdated: '2026-01-14' },
  'MET-PERP': { oiUsd: 28_170, lastUpdated: '2026-01-14' },
  'CLOUD-PERP': { oiUsd: 24_630, lastUpdated: '2026-01-14' },
  'KAITO-PERP': { oiUsd: 24_540, lastUpdated: '2026-01-14' },
  '2Z-PERP': { oiUsd: 24_270, lastUpdated: '2026-01-14' },
  'PENGU-PERP': { oiUsd: 23_130, lastUpdated: '2026-01-14' },
  'ME-PERP': { oiUsd: 19_680, lastUpdated: '2026-01-14' },
  'MNT-PERP': { oiUsd: 18_570, lastUpdated: '2026-01-14' },
  'OP-PERP': { oiUsd: 17_630, lastUpdated: '2026-01-14' },
};

// OI thresholds for risk tier classification (in USD)
const OI_THRESHOLDS = {
  RECOMMENDED: 10_000_000, // $10M+ OI = Recommended
  CAUTION: 1_000_000,      // $1M+ OI = Caution
};

/**
 * Calculate risk tier based on open interest
 */
function calculateRiskTier(oiUsd: number): RiskTier {
  if (oiUsd >= OI_THRESHOLDS.RECOMMENDED) return 'recommended';
  if (oiUsd >= OI_THRESHOLDS.CAUTION) return 'caution';
  return 'high_risk';
}

/**
 * Get estimated slippage based on OI
 */
function calculateSlippage(oiUsd: number): number {
  if (oiUsd >= 100_000_000) return 0.02;
  if (oiUsd >= 50_000_000) return 0.03;
  if (oiUsd >= 10_000_000) return 0.05;
  if (oiUsd >= 5_000_000) return 0.10;
  if (oiUsd >= 2_000_000) return 0.15;
  if (oiUsd >= 1_000_000) return 0.25;
  if (oiUsd >= 500_000) return 0.40;
  if (oiUsd >= 200_000) return 0.55;
  if (oiUsd >= 100_000) return 0.70;
  return 0.85;
}

// Cache for market data
interface MarketCache {
  markets: MarketInfo[];
  oiData: Record<string, number>;
  lastUpdated: Date;
  expiresAt: Date;
  source: 'api' | 'static';
}

let marketCache: MarketCache | null = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Try to fetch OI data from Drift's public Data API
 * Endpoint: https://data.api.drift.trade/contracts
 * Returns open_interest in base units, need to multiply by index_price for USD value
 */
async function fetchDynamicOi(): Promise<Record<string, number> | null> {
  try {
    console.log('[MarketLiquidity] Fetching OI from Drift Data API...');
    
    const response = await fetch('https://data.api.drift.trade/contracts', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });
    
    if (!response.ok) {
      console.warn(`[MarketLiquidity] Drift Data API returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    const oiData: Record<string, number> = {};
    
    // Parse contracts array - each has ticker_id, open_interest (base units), index_price
    const contracts = data.contracts || data;
    if (Array.isArray(contracts)) {
      for (const contract of contracts) {
        const symbol = contract.ticker_id;
        const openInterestBase = parseFloat(contract.open_interest);
        const indexPrice = parseFloat(contract.index_price);
        
        if (symbol && !isNaN(openInterestBase) && !isNaN(indexPrice) && openInterestBase > 0) {
          // Calculate OI in USD: base units * price
          const oiUsd = openInterestBase * indexPrice;
          oiData[symbol] = oiUsd;
        }
      }
    }
    
    if (Object.keys(oiData).length > 0) {
      console.log(`[MarketLiquidity] Fetched OI for ${Object.keys(oiData).length} markets from Drift API`);
      // Log top 5 for verification
      const sorted = Object.entries(oiData).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`[MarketLiquidity] Top 5 by OI: ${sorted.map(([s, oi]) => `${s}: $${(oi/1000000).toFixed(2)}M`).join(', ')}`);
      return oiData;
    }
    
    console.warn('[MarketLiquidity] No valid OI data in API response');
    return null;
  } catch (error: any) {
    console.warn('[MarketLiquidity] Failed to fetch from Drift API:', error.message);
    return null;
  }
}

/**
 * Get static OI data as fallback
 */
function getStaticOiData(): Record<string, number> {
  const oiData: Record<string, number> = {};
  for (const [symbol, data] of Object.entries(STATIC_OI_DATA)) {
    oiData[symbol] = data.oiUsd;
  }
  return oiData;
}

/**
 * Get oracle price for markets (using existing price endpoint)
 */
async function fetchMarketPrices(): Promise<Record<string, number>> {
  try {
    const response = await fetch('http://localhost:5000/api/prices');
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    // Silently fail - prices are optional
  }
  return {};
}

/**
 * Get all available Drift perp markets with liquidity info
 */
export async function getAllPerpMarkets(forceRefresh = false): Promise<MarketInfo[]> {
  const now = new Date();
  
  // Return cached data if still valid
  if (marketCache && !forceRefresh && now < marketCache.expiresAt) {
    return marketCache.markets;
  }
  
  console.log('[MarketLiquidity] Refreshing market data...');
  
  // Try to fetch dynamic OI, fall back to static
  let oiData = await fetchDynamicOi();
  let source: 'api' | 'static' = 'api';
  
  if (!oiData || Object.keys(oiData).length === 0) {
    console.log('[MarketLiquidity] Using static OI data as fallback');
    oiData = getStaticOiData();
    source = 'static';
  }
  
  // Fetch current prices
  const prices = await fetchMarketPrices();
  
  // Build market info
  const markets: MarketInfo[] = [];
  
  for (const [symbol, metadata] of Object.entries(MARKET_METADATA)) {
    if (!metadata.isActive) continue;
    
    const oi = oiData[symbol] || STATIC_OI_DATA[symbol]?.oiUsd || 0;
    const riskTier = calculateRiskTier(oi);
    const slippage = calculateSlippage(oi);
    
    markets.push({
      symbol: metadata.symbol,
      fullName: metadata.fullName,
      marketIndex: metadata.marketIndex,
      category: metadata.category,
      baseAssetSymbol: metadata.baseAssetSymbol,
      isActive: metadata.isActive,
      warning: metadata.warning,
      maxLeverage: metadata.maxLeverage,
      riskTier,
      estimatedSlippagePct: slippage,
      lastPrice: prices[symbol] || null,
      openInterestUsd: oi > 0 ? oi : null,
    });
  }
  
  // Sort by OI descending (most liquid first)
  markets.sort((a, b) => (b.openInterestUsd || 0) - (a.openInterestUsd || 0));
  
  // Update cache
  marketCache = {
    markets,
    oiData,
    lastUpdated: now,
    expiresAt: new Date(now.getTime() + CACHE_DURATION_MS),
    source,
  };
  
  const recommended = markets.filter(m => m.riskTier === 'recommended').length;
  const caution = markets.filter(m => m.riskTier === 'caution').length;
  const highRisk = markets.filter(m => m.riskTier === 'high_risk').length;
  
  console.log(`[MarketLiquidity] Cached ${markets.length} markets (source: ${source}): ${recommended} recommended, ${caution} caution, ${highRisk} high risk`);
  
  return markets;
}

/**
 * Get a single market by symbol
 */
export async function getMarketBySymbol(symbol: string): Promise<MarketInfo | null> {
  const markets = await getAllPerpMarkets();
  return markets.find(m => m.symbol === symbol) || null;
}

/**
 * Get risk tier description for UI
 */
export function getRiskTierInfo(tier: RiskTier): { label: string; color: string; description: string } {
  switch (tier) {
    case 'recommended':
      return {
        label: 'Recommended',
        color: 'green',
        description: 'High liquidity ($10M+ OI) - minimal slippage',
      };
    case 'caution':
      return {
        label: 'Caution',
        color: 'yellow', 
        description: 'Medium liquidity ($1M-$10M OI) - moderate slippage',
      };
    case 'high_risk':
      return {
        label: 'High Risk',
        color: 'red',
        description: 'Low liquidity (<$1M OI) - higher slippage expected',
      };
  }
}

/**
 * Check if a market symbol is valid and tradeable
 */
export function isValidMarket(symbol: string): boolean {
  return symbol in MARKET_METADATA && MARKET_METADATA[symbol].isActive;
}

/**
 * Get the market index for a symbol
 */
export function getMarketIndex(symbol: string): number | null {
  return MARKET_METADATA[symbol]?.marketIndex ?? null;
}

/**
 * Force refresh market data and return status
 */
export async function refreshMarketData(): Promise<{ 
  success: boolean; 
  marketCount: number; 
  source: 'api' | 'static';
  message: string;
  cacheExpiresAt: string;
}> {
  try {
    const markets = await getAllPerpMarkets(true);
    return {
      success: true,
      marketCount: markets.length,
      source: marketCache?.source || 'static',
      message: `Refreshed ${markets.length} markets from ${marketCache?.source || 'static'} data`,
      cacheExpiresAt: marketCache?.expiresAt.toISOString() || new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      success: false,
      marketCount: 0,
      source: 'static',
      message: error.message || 'Failed to refresh market data',
      cacheExpiresAt: new Date().toISOString(),
    };
  }
}

/**
 * Get cache status
 */
export function getCacheStatus(): {
  cached: boolean;
  source: 'api' | 'static' | null;
  lastUpdated: string | null;
  expiresAt: string | null;
  marketCount: number;
} {
  if (!marketCache) {
    return {
      cached: false,
      source: null,
      lastUpdated: null,
      expiresAt: null,
      marketCount: 0,
    };
  }
  
  return {
    cached: true,
    source: marketCache.source,
    lastUpdated: marketCache.lastUpdated.toISOString(),
    expiresAt: marketCache.expiresAt.toISOString(),
    marketCount: marketCache.markets.length,
  };
}
