/**
 * Market Liquidity Service
 * Provides information about Drift perpetual markets with OI-based slippage estimates
 * OI data is based on known market liquidity as of Jan 2026
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
}

// Static market data with OI-based tiers (updated based on Drift UI data Jan 2026)
// OI thresholds: $10M+ = Recommended, $1M+ = Caution, <$1M = High Risk
interface MarketData {
  symbol: string;
  fullName: string;
  marketIndex: number;
  category: string[];
  baseAssetSymbol: string;
  isActive: boolean;
  oiUsd: number; // Approximate OI in USD (for tier calculation)
  warning?: string;
}

// Markets ordered by approximate OI (descending) based on Drift UI Jan 2026
const DRIFT_PERP_MARKETS: MarketData[] = [
  // Tier 1: Recommended ($10M+ OI)
  { symbol: 'SOL-PERP', fullName: 'Solana', marketIndex: 0, category: ['L1', 'Infra'], baseAssetSymbol: 'SOL', isActive: true, oiUsd: 147_000_000 },
  { symbol: 'BTC-PERP', fullName: 'Bitcoin', marketIndex: 1, category: ['L1', 'Payment'], baseAssetSymbol: 'BTC', isActive: true, oiUsd: 77_000_000 },
  { symbol: 'ETH-PERP', fullName: 'Ethereum', marketIndex: 2, category: ['L1', 'Infra'], baseAssetSymbol: 'ETH', isActive: true, oiUsd: 37_000_000 },
  
  // Tier 2: Caution ($1M-$10M OI)
  { symbol: 'SUI-PERP', fullName: 'Sui', marketIndex: 9, category: ['L1'], baseAssetSymbol: 'SUI', isActive: true, oiUsd: 1_780_000 },
  { symbol: 'ZEC-PERP', fullName: 'Zcash', marketIndex: 37, category: ['L1', 'Privacy'], baseAssetSymbol: 'ZEC', isActive: true, oiUsd: 1_760_000 },
  { symbol: 'DRIFT-PERP', fullName: 'Drift Protocol', marketIndex: 29, category: ['DeFi', 'Solana'], baseAssetSymbol: 'DRIFT', isActive: true, oiUsd: 1_530_000 },
  { symbol: 'HYPE-PERP', fullName: 'Hyperliquid', marketIndex: 38, category: ['DeFi', 'L1'], baseAssetSymbol: 'HYPE', isActive: true, oiUsd: 1_450_000 },
  { symbol: 'JUP-PERP', fullName: 'Jupiter', marketIndex: 26, category: ['DeFi', 'Solana'], baseAssetSymbol: 'JUP', isActive: true, oiUsd: 1_360_000 },
  { symbol: 'TRUMP-PERP', fullName: 'Trump', marketIndex: 42, category: ['Meme', 'Politics'], baseAssetSymbol: 'TRUMP', isActive: true, oiUsd: 1_200_000, warning: 'High volatility meme token' },
  { symbol: 'WIF-PERP', fullName: 'dogwifhat', marketIndex: 24, category: ['Meme', 'Dog'], baseAssetSymbol: 'WIF', isActive: true, oiUsd: 1_100_000 },
  { symbol: 'XRP-PERP', fullName: 'XRP', marketIndex: 14, category: ['L1', 'Payment'], baseAssetSymbol: 'XRP', isActive: true, oiUsd: 1_050_000 },
  
  // Tier 3: High Risk (<$1M OI)
  { symbol: 'DOGE-PERP', fullName: 'Dogecoin', marketIndex: 7, category: ['Meme', 'Dog'], baseAssetSymbol: 'DOGE', isActive: true, oiUsd: 900_000 },
  { symbol: 'LINK-PERP', fullName: 'Chainlink', marketIndex: 17, category: ['Oracle', 'DeFi'], baseAssetSymbol: 'LINK', isActive: true, oiUsd: 850_000 },
  { symbol: 'BNB-PERP', fullName: 'Binance Coin', marketIndex: 8, category: ['Exchange'], baseAssetSymbol: 'BNB', isActive: true, oiUsd: 800_000 },
  { symbol: '1MBONK-PERP', fullName: 'Bonk', marketIndex: 4, category: ['Meme', 'Dog'], baseAssetSymbol: '1MBONK', isActive: true, oiUsd: 750_000, warning: 'High volatility meme token' },
  { symbol: 'JTO-PERP', fullName: 'Jito', marketIndex: 20, category: ['DeFi', 'Solana'], baseAssetSymbol: 'JTO', isActive: true, oiUsd: 700_000 },
  { symbol: 'ARB-PERP', fullName: 'Arbitrum', marketIndex: 6, category: ['L2', 'Infra'], baseAssetSymbol: 'ARB', isActive: true, oiUsd: 650_000 },
  { symbol: 'OP-PERP', fullName: 'Optimism', marketIndex: 11, category: ['L2', 'Infra'], baseAssetSymbol: 'OP', isActive: true, oiUsd: 600_000 },
  { symbol: 'AVAX-PERP', fullName: 'Avalanche', marketIndex: 15, category: ['L1', 'Infra'], baseAssetSymbol: 'AVAX', isActive: true, oiUsd: 550_000 },
  { symbol: 'APT-PERP', fullName: 'Aptos', marketIndex: 3, category: ['L1', 'Infra'], baseAssetSymbol: 'APT', isActive: true, oiUsd: 500_000 },
  { symbol: '1MPEPE-PERP', fullName: 'Pepe', marketIndex: 10, category: ['Meme'], baseAssetSymbol: '1MPEPE', isActive: true, oiUsd: 480_000, warning: 'High volatility meme token' },
  { symbol: 'POL-PERP', fullName: 'Polygon', marketIndex: 5, category: ['L2', 'Infra'], baseAssetSymbol: 'POL', isActive: true, oiUsd: 450_000 },
  { symbol: 'TIA-PERP', fullName: 'Celestia', marketIndex: 23, category: ['L1', 'Modular'], baseAssetSymbol: 'TIA', isActive: true, oiUsd: 400_000 },
  { symbol: 'INJ-PERP', fullName: 'Injective', marketIndex: 19, category: ['L1', 'DeFi'], baseAssetSymbol: 'INJ', isActive: true, oiUsd: 380_000 },
  { symbol: 'PYTH-PERP', fullName: 'Pyth Network', marketIndex: 21, category: ['Oracle', 'Solana'], baseAssetSymbol: 'PYTH', isActive: true, oiUsd: 350_000 },
  { symbol: 'RENDER-PERP', fullName: 'Render', marketIndex: 16, category: ['AI', 'GPU'], baseAssetSymbol: 'RENDER', isActive: true, oiUsd: 320_000 },
  { symbol: 'SEI-PERP', fullName: 'Sei', marketIndex: 18, category: ['L1', 'Trading'], baseAssetSymbol: 'SEI', isActive: true, oiUsd: 300_000 },
  { symbol: 'NEAR-PERP', fullName: 'Near', marketIndex: 22, category: ['L1', 'Infra'], baseAssetSymbol: 'NEAR', isActive: true, oiUsd: 280_000 },
  { symbol: 'TAO-PERP', fullName: 'Bittensor', marketIndex: 31, category: ['AI'], baseAssetSymbol: 'TAO', isActive: true, oiUsd: 260_000 },
  { symbol: 'ATOM-PERP', fullName: 'Cosmos', marketIndex: 12, category: ['L0', 'Infra'], baseAssetSymbol: 'ATOM', isActive: true, oiUsd: 240_000 },
  { symbol: 'DOT-PERP', fullName: 'Polkadot', marketIndex: 36, category: ['L0', 'Infra'], baseAssetSymbol: 'DOT', isActive: true, oiUsd: 220_000 },
  { symbol: 'LTC-PERP', fullName: 'Litecoin', marketIndex: 13, category: ['L1', 'Payment'], baseAssetSymbol: 'LTC', isActive: true, oiUsd: 200_000 },
  { symbol: 'W-PERP', fullName: 'Wormhole', marketIndex: 27, category: ['Bridge', 'Infra'], baseAssetSymbol: 'W', isActive: true, oiUsd: 180_000 },
  { symbol: 'TNSR-PERP', fullName: 'Tensor', marketIndex: 28, category: ['NFT', 'Solana'], baseAssetSymbol: 'TNSR', isActive: true, oiUsd: 150_000 },
  { symbol: 'KMNO-PERP', fullName: 'Kamino', marketIndex: 32, category: ['DeFi', 'Solana'], baseAssetSymbol: 'KMNO', isActive: true, oiUsd: 120_000 },
  { symbol: 'POPCAT-PERP', fullName: 'Popcat', marketIndex: 30, category: ['Meme'], baseAssetSymbol: 'POPCAT', isActive: true, oiUsd: 100_000, warning: 'High volatility meme token' },
  { symbol: 'BOME-PERP', fullName: 'Book of Meme', marketIndex: 25, category: ['Meme'], baseAssetSymbol: 'BOME', isActive: true, oiUsd: 80_000, warning: 'High volatility meme token' },
  { symbol: 'MOG-PERP', fullName: 'Mog Coin', marketIndex: 33, category: ['Meme'], baseAssetSymbol: 'MOG', isActive: true, oiUsd: 60_000, warning: 'Low liquidity meme token' },
  { symbol: 'MELANIA-PERP', fullName: 'Melania', marketIndex: 43, category: ['Meme', 'Politics'], baseAssetSymbol: 'MELANIA', isActive: true, oiUsd: 50_000, warning: 'Very low liquidity' },
  { symbol: 'LIT-PERP', fullName: 'Litentry', marketIndex: 44, category: ['Identity', 'Infra'], baseAssetSymbol: 'LIT', isActive: true, oiUsd: 40_000 },
];

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
 * More granular scaling based on actual OI
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
  lastUpdated: Date;
  expiresAt: Date;
}

let marketCache: MarketCache | null = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour for price updates

/**
 * Get oracle price for a market (using existing price endpoint)
 */
async function fetchMarketPrices(): Promise<Record<string, number>> {
  try {
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
 */
export async function getAllPerpMarkets(forceRefresh = false): Promise<MarketInfo[]> {
  const now = new Date();
  
  // Return cached data if still valid
  if (marketCache && !forceRefresh && now < marketCache.expiresAt) {
    return marketCache.markets;
  }
  
  console.log('[MarketLiquidity] Refreshing market data');
  
  // Fetch current prices
  const prices = await fetchMarketPrices();
  
  // Build market info with OI-based tiers
  const markets: MarketInfo[] = DRIFT_PERP_MARKETS
    .filter(m => m.isActive)
    .map(market => {
      const riskTier = calculateRiskTier(market.oiUsd);
      const slippage = calculateSlippage(market.oiUsd);
      
      return {
        symbol: market.symbol,
        fullName: market.fullName,
        marketIndex: market.marketIndex,
        category: market.category,
        baseAssetSymbol: market.baseAssetSymbol,
        isActive: market.isActive,
        warning: market.warning,
        riskTier,
        estimatedSlippagePct: slippage,
        lastPrice: prices[market.symbol] || null,
        openInterestUsd: market.oiUsd,
      };
    });
  
  // Sort by OI descending (most liquid first)
  markets.sort((a, b) => (b.openInterestUsd || 0) - (a.openInterestUsd || 0));
  
  // Update cache
  marketCache = {
    markets,
    lastUpdated: now,
    expiresAt: new Date(now.getTime() + CACHE_DURATION_MS),
  };
  
  const recommended = markets.filter(m => m.riskTier === 'recommended').length;
  const caution = markets.filter(m => m.riskTier === 'caution').length;
  const highRisk = markets.filter(m => m.riskTier === 'high_risk').length;
  
  console.log(`[MarketLiquidity] Cached ${markets.length} markets: ${recommended} recommended, ${caution} caution, ${highRisk} high risk`);
  
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
  return DRIFT_PERP_MARKETS.some(m => m.symbol === symbol && m.isActive);
}

/**
 * Get the market index for a symbol
 */
export function getMarketIndex(symbol: string): number | null {
  const market = DRIFT_PERP_MARKETS.find(m => m.symbol === symbol);
  return market?.marketIndex ?? null;
}

/**
 * Force refresh market data
 */
export async function refreshMarketData(): Promise<{ success: boolean; marketCount: number; message: string }> {
  try {
    const markets = await getAllPerpMarkets(true);
    return {
      success: true,
      marketCount: markets.length,
      message: `Refreshed ${markets.length} markets with static OI estimates`,
    };
  } catch (error: any) {
    return {
      success: false,
      marketCount: 0,
      message: error.message || 'Failed to refresh market data',
    };
  }
}
