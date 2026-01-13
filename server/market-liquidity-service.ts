/**
 * Market Liquidity Service
 * Provides information about Drift perpetual markets including estimated slippage
 * Caches data hourly to minimize RPC calls
 */

import { Connection, PublicKey } from '@solana/web3.js';

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
}

// Static list of Drift mainnet perp markets with pre-assessed liquidity tiers
// This avoids constant RPC calls - we know the major markets are liquid
const DRIFT_PERP_MARKETS: Omit<MarketInfo, 'openInterestUsd' | 'lastPrice'>[] = [
  // Tier 1 - High liquidity (Recommended)
  { symbol: 'SOL-PERP', fullName: 'Solana', marketIndex: 0, category: ['L1', 'Infra'], baseAssetSymbol: 'SOL', riskTier: 'recommended', estimatedSlippagePct: 0.05, isActive: true },
  { symbol: 'BTC-PERP', fullName: 'Bitcoin', marketIndex: 1, category: ['L1', 'Payment'], baseAssetSymbol: 'BTC', riskTier: 'recommended', estimatedSlippagePct: 0.05, isActive: true },
  { symbol: 'ETH-PERP', fullName: 'Ethereum', marketIndex: 2, category: ['L1', 'Infra'], baseAssetSymbol: 'ETH', riskTier: 'recommended', estimatedSlippagePct: 0.05, isActive: true },
  
  // Tier 2 - Medium liquidity (Caution)
  { symbol: 'SUI-PERP', fullName: 'Sui', marketIndex: 9, category: ['L1'], baseAssetSymbol: 'SUI', riskTier: 'caution', estimatedSlippagePct: 0.15, isActive: true },
  { symbol: 'DOGE-PERP', fullName: 'Dogecoin', marketIndex: 7, category: ['Meme', 'Dog'], baseAssetSymbol: 'DOGE', riskTier: 'caution', estimatedSlippagePct: 0.20, isActive: true },
  { symbol: 'BNB-PERP', fullName: 'Binance Coin', marketIndex: 8, category: ['Exchange'], baseAssetSymbol: 'BNB', riskTier: 'caution', estimatedSlippagePct: 0.20, isActive: true },
  { symbol: 'ARB-PERP', fullName: 'Arbitrum', marketIndex: 6, category: ['L2', 'Infra'], baseAssetSymbol: 'ARB', riskTier: 'caution', estimatedSlippagePct: 0.25, isActive: true },
  { symbol: 'OP-PERP', fullName: 'Optimism', marketIndex: 11, category: ['L2', 'Infra'], baseAssetSymbol: 'OP', riskTier: 'caution', estimatedSlippagePct: 0.25, isActive: true },
  { symbol: 'APT-PERP', fullName: 'Aptos', marketIndex: 3, category: ['L1', 'Infra'], baseAssetSymbol: 'APT', riskTier: 'caution', estimatedSlippagePct: 0.30, isActive: true },
  { symbol: 'POL-PERP', fullName: 'Polygon', marketIndex: 5, category: ['L2', 'Infra'], baseAssetSymbol: 'POL', riskTier: 'caution', estimatedSlippagePct: 0.30, isActive: true },
  { symbol: 'AVAX-PERP', fullName: 'Avalanche', marketIndex: 15, category: ['L1', 'Infra'], baseAssetSymbol: 'AVAX', riskTier: 'caution', estimatedSlippagePct: 0.30, isActive: true },
  { symbol: 'LINK-PERP', fullName: 'Chainlink', marketIndex: 17, category: ['Oracle', 'DeFi'], baseAssetSymbol: 'LINK', riskTier: 'caution', estimatedSlippagePct: 0.30, isActive: true },
  { symbol: 'WIF-PERP', fullName: 'dogwifhat', marketIndex: 24, category: ['Meme', 'Dog'], baseAssetSymbol: 'WIF', riskTier: 'caution', estimatedSlippagePct: 0.35, isActive: true },
  { symbol: 'JTO-PERP', fullName: 'Jito', marketIndex: 20, category: ['DeFi', 'Solana'], baseAssetSymbol: 'JTO', riskTier: 'caution', estimatedSlippagePct: 0.35, isActive: true },
  { symbol: 'JUP-PERP', fullName: 'Jupiter', marketIndex: 26, category: ['DeFi', 'Solana'], baseAssetSymbol: 'JUP', riskTier: 'caution', estimatedSlippagePct: 0.35, isActive: true },
  
  // Tier 3 - Lower liquidity (High Risk)
  { symbol: '1MBONK-PERP', fullName: 'Bonk', marketIndex: 4, category: ['Meme', 'Dog'], baseAssetSymbol: '1MBONK', riskTier: 'high_risk', estimatedSlippagePct: 0.50, isActive: true, warning: 'High volatility meme token' },
  { symbol: '1MPEPE-PERP', fullName: 'Pepe', marketIndex: 10, category: ['Meme'], baseAssetSymbol: '1MPEPE', riskTier: 'high_risk', estimatedSlippagePct: 0.50, isActive: true, warning: 'High volatility meme token' },
  { symbol: 'LTC-PERP', fullName: 'Litecoin', marketIndex: 13, category: ['L1', 'Payment'], baseAssetSymbol: 'LTC', riskTier: 'high_risk', estimatedSlippagePct: 0.50, isActive: true },
  { symbol: 'XRP-PERP', fullName: 'XRP', marketIndex: 14, category: ['L1', 'Payment'], baseAssetSymbol: 'XRP', riskTier: 'caution', estimatedSlippagePct: 0.40, isActive: true },
  { symbol: 'RENDER-PERP', fullName: 'Render', marketIndex: 16, category: ['AI', 'GPU'], baseAssetSymbol: 'RENDER', riskTier: 'high_risk', estimatedSlippagePct: 0.60, isActive: true },
  { symbol: 'W-PERP', fullName: 'Wormhole', marketIndex: 27, category: ['Bridge', 'Infra'], baseAssetSymbol: 'W', riskTier: 'high_risk', estimatedSlippagePct: 0.60, isActive: true },
  { symbol: 'TNSR-PERP', fullName: 'Tensor', marketIndex: 28, category: ['NFT', 'Solana'], baseAssetSymbol: 'TNSR', riskTier: 'high_risk', estimatedSlippagePct: 0.60, isActive: true },
  { symbol: 'DRIFT-PERP', fullName: 'Drift Protocol', marketIndex: 29, category: ['DeFi', 'Solana'], baseAssetSymbol: 'DRIFT', riskTier: 'high_risk', estimatedSlippagePct: 0.60, isActive: true },
  { symbol: 'INJ-PERP', fullName: 'Injective', marketIndex: 19, category: ['L1', 'DeFi'], baseAssetSymbol: 'INJ', riskTier: 'high_risk', estimatedSlippagePct: 0.55, isActive: true },
  { symbol: 'RNDR-PERP', fullName: 'Render (old)', marketIndex: 16, category: ['AI', 'GPU'], baseAssetSymbol: 'RNDR', riskTier: 'high_risk', estimatedSlippagePct: 0.60, isActive: false },
  { symbol: 'PYTH-PERP', fullName: 'Pyth Network', marketIndex: 21, category: ['Oracle', 'Solana'], baseAssetSymbol: 'PYTH', riskTier: 'high_risk', estimatedSlippagePct: 0.55, isActive: true },
  { symbol: 'TIA-PERP', fullName: 'Celestia', marketIndex: 23, category: ['L1', 'Modular'], baseAssetSymbol: 'TIA', riskTier: 'high_risk', estimatedSlippagePct: 0.55, isActive: true },
  { symbol: 'SEI-PERP', fullName: 'Sei', marketIndex: 18, category: ['L1', 'Trading'], baseAssetSymbol: 'SEI', riskTier: 'high_risk', estimatedSlippagePct: 0.55, isActive: true },
  { symbol: 'ATOM-PERP', fullName: 'Cosmos', marketIndex: 12, category: ['L0', 'Infra'], baseAssetSymbol: 'ATOM', riskTier: 'high_risk', estimatedSlippagePct: 0.50, isActive: true },
  { symbol: 'NEAR-PERP', fullName: 'Near', marketIndex: 22, category: ['L1', 'Infra'], baseAssetSymbol: 'NEAR', riskTier: 'high_risk', estimatedSlippagePct: 0.55, isActive: true },
  { symbol: 'POPCAT-PERP', fullName: 'Popcat', marketIndex: 30, category: ['Meme'], baseAssetSymbol: 'POPCAT', riskTier: 'high_risk', estimatedSlippagePct: 0.80, isActive: true, warning: 'High volatility meme token' },
  { symbol: 'BOME-PERP', fullName: 'Book of Meme', marketIndex: 25, category: ['Meme'], baseAssetSymbol: 'BOME', riskTier: 'high_risk', estimatedSlippagePct: 0.80, isActive: true, warning: 'High volatility meme token' },
  { symbol: 'MOG-PERP', fullName: 'Mog Coin', marketIndex: 33, category: ['Meme'], baseAssetSymbol: 'MOG', riskTier: 'high_risk', estimatedSlippagePct: 0.90, isActive: true, warning: 'Low liquidity meme token' },
  { symbol: 'TAO-PERP', fullName: 'Bittensor', marketIndex: 31, category: ['AI'], baseAssetSymbol: 'TAO', riskTier: 'high_risk', estimatedSlippagePct: 0.70, isActive: true },
  { symbol: 'KMNO-PERP', fullName: 'Kamino', marketIndex: 32, category: ['DeFi', 'Solana'], baseAssetSymbol: 'KMNO', riskTier: 'high_risk', estimatedSlippagePct: 0.70, isActive: true },
  { symbol: 'ZEC-PERP', fullName: 'Zcash', marketIndex: 37, category: ['L1', 'Privacy'], baseAssetSymbol: 'ZEC', riskTier: 'high_risk', estimatedSlippagePct: 0.65, isActive: true },
  { symbol: 'DOT-PERP', fullName: 'Polkadot', marketIndex: 36, category: ['L0', 'Infra'], baseAssetSymbol: 'DOT', riskTier: 'high_risk', estimatedSlippagePct: 0.55, isActive: true },
  { symbol: 'TRUMP-PERP', fullName: 'Trump', marketIndex: 42, category: ['Meme', 'Politics'], baseAssetSymbol: 'TRUMP', riskTier: 'high_risk', estimatedSlippagePct: 0.80, isActive: true, warning: 'High volatility meme token' },
  { symbol: 'MELANIA-PERP', fullName: 'Melania', marketIndex: 43, category: ['Meme', 'Politics'], baseAssetSymbol: 'MELANIA', riskTier: 'high_risk', estimatedSlippagePct: 0.90, isActive: true, warning: 'Very low liquidity' },
];

// Cache for price data (refreshed hourly)
interface MarketCache {
  markets: MarketInfo[];
  lastUpdated: Date;
  expiresAt: Date;
}

let marketCache: MarketCache | null = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get oracle price for a market (using existing price endpoint)
 */
async function fetchMarketPrices(): Promise<Record<string, number>> {
  try {
    // Use internal API to get cached prices (avoids extra RPC calls)
    const response = await fetch('http://localhost:5000/api/prices');
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.warn('[MarketLiquidity] Could not fetch prices:', error);
  }
  return {};
}

/**
 * Get all available Drift perp markets with liquidity info
 * Caches results for 1 hour to minimize RPC usage
 */
export async function getAllPerpMarkets(forceRefresh = false): Promise<MarketInfo[]> {
  const now = new Date();
  
  // Return cached data if still valid
  if (marketCache && !forceRefresh && now < marketCache.expiresAt) {
    return marketCache.markets;
  }
  
  console.log('[MarketLiquidity] Refreshing market data (hourly cache)');
  
  // Fetch current prices
  const prices = await fetchMarketPrices();
  
  // Build market info with current prices
  const markets: MarketInfo[] = DRIFT_PERP_MARKETS
    .filter(m => m.isActive)
    .map(market => ({
      ...market,
      lastPrice: prices[market.symbol] || null,
      openInterestUsd: null, // Would require RPC call - skip for now
    }));
  
  // Sort by risk tier then alphabetically
  const tierOrder: Record<RiskTier, number> = { recommended: 0, caution: 1, high_risk: 2 };
  markets.sort((a, b) => {
    const tierDiff = tierOrder[a.riskTier] - tierOrder[b.riskTier];
    if (tierDiff !== 0) return tierDiff;
    return a.symbol.localeCompare(b.symbol);
  });
  
  // Update cache
  marketCache = {
    markets,
    lastUpdated: now,
    expiresAt: new Date(now.getTime() + CACHE_DURATION_MS),
  };
  
  console.log(`[MarketLiquidity] Cached ${markets.length} markets, expires at ${marketCache.expiresAt.toISOString()}`);
  
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
        description: 'High liquidity market with minimal slippage (<0.25%)',
      };
    case 'caution':
      return {
        label: 'Caution',
        color: 'yellow', 
        description: 'Medium liquidity - expect 0.25-0.75% slippage on trades',
      };
    case 'high_risk':
      return {
        label: 'High Risk',
        color: 'red',
        description: 'Low liquidity - slippage may exceed 0.75%, not recommended for small-cap strategies',
      };
  }
}

/**
 * Check if a market symbol is valid and tradeable
 */
export function isValidMarket(symbol: string): boolean {
  return DRIFT_PERP_MARKETS.some(m => m.symbol === symbol && m.isActive);
}

/**
 * Get the market index for a symbol
 */
export function getMarketIndex(symbol: string): number | null {
  const market = DRIFT_PERP_MARKETS.find(m => m.symbol === symbol);
  return market?.marketIndex ?? null;
}
