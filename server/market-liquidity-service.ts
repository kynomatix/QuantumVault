/**
 * Market Liquidity Service
 * Provides information about Drift perpetual markets with OI-based slippage estimates
 * 
 * Data sources:
 * 1. Primary: Drift public stats API (driftapi.com)
 * 2. Fallback: Static estimates based on Drift UI (updated periodically)
 * 
 * Leverage limits: Sourced from leverage-cache-service (on-chain marginRatioInitial)
 * 
 * Cache: 24 hours with manual refresh capability
 */

import { getCachedMaxLeverage, isMarketNonTradable, getNonTradableMarkets } from "./leverage-cache-service";
import { CANONICAL_PERP_MARKETS, getCanonicalIndex } from "./market-registry";

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
  minOrderSize: number;
  warning?: string;
}

interface StaticOiData {
  oiUsd: number;
  lastUpdated: string; // ISO date
}

interface MarketMetadataInput {
  fullName: string;
  category: string[];
  minOrderSize: number;
  warning?: string;
}

const MARKET_METADATA_DEFS: Record<string, MarketMetadataInput> = {
  'SOL-PERP': { fullName: 'Solana', category: ['L1', 'Infra'], minOrderSize: 0.01 },
  'BTC-PERP': { fullName: 'Bitcoin', category: ['L1', 'Payment'], minOrderSize: 0.0001 },
  'ETH-PERP': { fullName: 'Ethereum', category: ['L1', 'Infra'], minOrderSize: 0.001 },
  'APT-PERP': { fullName: 'Aptos', category: ['L1', 'Infra'], minOrderSize: 1 },
  '1MBONK-PERP': { fullName: 'Bonk', category: ['Meme', 'Dog'], minOrderSize: 0.5, warning: 'High volatility meme token' },
  'POL-PERP': { fullName: 'Polygon', category: ['L2', 'Infra'], minOrderSize: 5 },
  'ARB-PERP': { fullName: 'Arbitrum', category: ['L2', 'Infra'], minOrderSize: 5 },
  'DOGE-PERP': { fullName: 'Dogecoin', category: ['Meme', 'Dog'], minOrderSize: 50 },
  'BNB-PERP': { fullName: 'Binance Coin', category: ['Exchange'], minOrderSize: 0.01 },
  'SUI-PERP': { fullName: 'Sui', category: ['L1'], minOrderSize: 1 },
  '1MPEPE-PERP': { fullName: 'Pepe', category: ['Meme'], minOrderSize: 5, warning: 'High volatility meme token' },
  'OP-PERP': { fullName: 'Optimism', category: ['L2', 'Infra'], minOrderSize: 5 },
  'RENDER-PERP': { fullName: 'Render', category: ['AI', 'GPU'], minOrderSize: 2 },
  'XRP-PERP': { fullName: 'XRP', category: ['L1', 'Payment'], minOrderSize: 5 },
  'HNT-PERP': { fullName: 'Helium', category: ['IoT', 'Infra'], minOrderSize: 5 },
  'INJ-PERP': { fullName: 'Injective', category: ['L1', 'DeFi'], minOrderSize: 1 },
  'LINK-PERP': { fullName: 'Chainlink', category: ['Oracle', 'DeFi'], minOrderSize: 1 },
  'RLB-PERP': { fullName: 'Rollbit', category: ['Gaming'], minOrderSize: 2 },
  'PYTH-PERP': { fullName: 'Pyth Network', category: ['Oracle', 'Solana'], minOrderSize: 2 },
  'TIA-PERP': { fullName: 'Celestia', category: ['L1', 'Modular'], minOrderSize: 0.5 },
  'JTO-PERP': { fullName: 'Jito', category: ['DeFi', 'Solana'], minOrderSize: 2 },
  'SEI-PERP': { fullName: 'Sei', category: ['L1', 'Trading'], minOrderSize: 5 },
  'AVAX-PERP': { fullName: 'Avalanche', category: ['L1', 'Infra'], minOrderSize: 0.1 },
  'WIF-PERP': { fullName: 'dogwifhat', category: ['Meme', 'Dog'], minOrderSize: 5 },
  'JUP-PERP': { fullName: 'Jupiter', category: ['DeFi', 'Solana'], minOrderSize: 5 },
  'DYM-PERP': { fullName: 'Dymension', category: ['L1', 'Modular'], minOrderSize: 1 },
  'TAO-PERP': { fullName: 'Bittensor', category: ['AI'], minOrderSize: 0.01 },
  'W-PERP': { fullName: 'Wormhole', category: ['Bridge', 'Infra'], minOrderSize: 5 },
  'KMNO-PERP': { fullName: 'Kamino', category: ['DeFi', 'Solana'], minOrderSize: 50 },
  'TNSR-PERP': { fullName: 'Tensor', category: ['NFT', 'Solana'], minOrderSize: 10 },
  'DRIFT-PERP': { fullName: 'Drift Protocol', category: ['DeFi', 'Solana'], minOrderSize: 10 },
  'CLOUD-PERP': { fullName: 'Cloud', category: ['Infra'], minOrderSize: 5 },
  'IO-PERP': { fullName: 'IO.net', category: ['AI', 'GPU'], minOrderSize: 1 },
  'ZEX-PERP': { fullName: 'Zeta', category: ['DeFi', 'Solana'], minOrderSize: 50 },
  'POPCAT-PERP': { fullName: 'Popcat', category: ['Meme'], minOrderSize: 10, warning: 'High volatility meme token' },
  '1KWEN-PERP': { fullName: 'Wen', category: ['Meme', 'Solana'], minOrderSize: 50, warning: 'High volatility' },
  'TON-PERP': { fullName: 'Toncoin', category: ['L1'], minOrderSize: 1 },
  'MOTHER-PERP': { fullName: 'Mother Iggy', category: ['Meme'], minOrderSize: 10, warning: 'High volatility meme token' },
  'MOODENG-PERP': { fullName: 'Moo Deng', category: ['Meme'], minOrderSize: 5, warning: 'High volatility meme token' },
  'DBR-PERP': { fullName: 'deBridge', category: ['Bridge', 'Infra'], minOrderSize: 50 },
  '1KMEW-PERP': { fullName: 'Cat in a Dog World', category: ['Meme'], minOrderSize: 0.5, warning: 'High volatility meme token' },
  'MICHI-PERP': { fullName: 'Michi', category: ['Meme'], minOrderSize: 10, warning: 'High volatility meme token' },
  'GOAT-PERP': { fullName: 'Goatseus Maximus', category: ['Meme', 'AI'], minOrderSize: 10, warning: 'High volatility meme token' },
  'FWOG-PERP': { fullName: 'Fwog', category: ['Meme'], minOrderSize: 5, warning: 'High volatility meme token' },
  'PNUT-PERP': { fullName: 'Peanut', category: ['Meme'], minOrderSize: 5, warning: 'High volatility meme token' },
  'RAY-PERP': { fullName: 'Raydium', category: ['DeFi', 'Solana'], minOrderSize: 1 },
  'HYPE-PERP': { fullName: 'Hyperliquid', category: ['DeFi', 'L1'], minOrderSize: 1 },
  'LTC-PERP': { fullName: 'Litecoin', category: ['L1', 'Payment'], minOrderSize: 0.05 },
  'ME-PERP': { fullName: 'Magic Eden', category: ['NFT', 'Solana'], minOrderSize: 1 },
  'PENGU-PERP': { fullName: 'Pudgy Penguins', category: ['NFT', 'Meme'], minOrderSize: 100 },
  'AI16Z-PERP': { fullName: 'ai16z', category: ['AI', 'Meme'], minOrderSize: 5, warning: 'High volatility' },
  'TRUMP-PERP': { fullName: 'Trump', category: ['Meme', 'Politics'], minOrderSize: 0.5, warning: 'High volatility meme token' },
  'MELANIA-PERP': { fullName: 'Melania', category: ['Meme', 'Politics'], minOrderSize: 1, warning: 'High volatility meme token' },
  'KAITO-PERP': { fullName: 'Kaito', category: ['AI'], minOrderSize: 5 },
  'IP-PERP': { fullName: 'Story Protocol', category: ['Infra'], minOrderSize: 1 },
  'FARTCOIN-PERP': { fullName: 'Fartcoin', category: ['Meme'], minOrderSize: 1, warning: 'High volatility meme token' },
  'ADA-PERP': { fullName: 'Cardano', category: ['L1'], minOrderSize: 1 },
  'PAXG-PERP': { fullName: 'PAX Gold', category: ['Commodity', 'Gold'], minOrderSize: 0.001 },
  'LAUNCHCOIN-PERP': { fullName: 'Believe', category: ['Meme', 'Solana'], minOrderSize: 2, warning: 'High volatility' },
  'PUMP-PERP': { fullName: 'Pump.fun', category: ['Meme', 'Solana'], minOrderSize: 5000, warning: 'High volatility' },
  'ASTER-PERP': { fullName: 'Aster', category: ['L1'], minOrderSize: 1 },
  'XPL-PERP': { fullName: 'XPL', category: ['Infra'], minOrderSize: 1 },
  '2Z-PERP': { fullName: '2Z', category: ['Meme'], minOrderSize: 1 },
  'ZEC-PERP': { fullName: 'Zcash', category: ['L1', 'Privacy'], minOrderSize: 0.01 },
  'MNT-PERP': { fullName: 'Mantle', category: ['L2'], minOrderSize: 1 },
  '1KPUMP-PERP': { fullName: 'Pump.fun', category: ['Meme', 'Solana'], minOrderSize: 1, warning: 'High volatility' },
  'MET-PERP': { fullName: 'Metaplex', category: ['NFT', 'Solana'], minOrderSize: 1 },
  '1KMON-PERP': { fullName: 'Monad', category: ['L1'], minOrderSize: 10 },
  'LIT-PERP': { fullName: 'Litentry', category: ['Identity', 'Infra'], minOrderSize: 1 },
};

const MARKET_METADATA: Record<string, MarketMetadata> = {};
for (const [symbol, def] of Object.entries(MARKET_METADATA_DEFS)) {
  const idx = getCanonicalIndex(symbol);
  if (idx === undefined) {
    console.warn(`[MarketLiquidity] No canonical index for ${symbol}, skipping`);
    continue;
  }
  MARKET_METADATA[symbol] = {
    symbol,
    fullName: def.fullName,
    marketIndex: idx,
    category: def.category,
    baseAssetSymbol: symbol.replace('-PERP', ''),
    isActive: true,
    minOrderSize: def.minOrderSize,
    ...(def.warning ? { warning: def.warning } : {}),
  };
}

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
  'RLB-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'DYM-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'ZEX-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  '1KWEN-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'MOTHER-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'MOODENG-PERP': { oiUsd: 15_000, lastUpdated: '2026-01-14' },
  'DBR-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  '1KMEW-PERP': { oiUsd: 15_000, lastUpdated: '2026-01-14' },
  'MICHI-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'GOAT-PERP': { oiUsd: 15_000, lastUpdated: '2026-01-14' },
  'FWOG-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'PNUT-PERP': { oiUsd: 15_000, lastUpdated: '2026-01-14' },
  'AI16Z-PERP': { oiUsd: 15_000, lastUpdated: '2026-01-14' },
  'MELANIA-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'LAUNCHCOIN-PERP': { oiUsd: 15_000, lastUpdated: '2026-01-14' },
  'PUMP-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
  'IO-PERP': { oiUsd: 10_000, lastUpdated: '2026-01-14' },
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
    const nonTradable = isMarketNonTradable(symbol);
    if (nonTradable === true) continue;
    
    const oi = oiData[symbol] || STATIC_OI_DATA[symbol]?.oiUsd || 0;
    const riskTier = calculateRiskTier(oi);
    const slippage = calculateSlippage(oi);
    
    markets.push({
      symbol: metadata.symbol,
      fullName: metadata.fullName,
      marketIndex: metadata.marketIndex,
      category: metadata.category,
      baseAssetSymbol: metadata.baseAssetSymbol,
      isActive: true,
      warning: metadata.warning,
      maxLeverage: getCachedMaxLeverage(symbol),
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
 * Get minimum order size for a market in base asset units
 * Returns the minimum tradeable amount for the given perp market
 */
export function getMinOrderSize(symbol: string): number {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP') 
    ? symbol.toUpperCase() 
    : `${symbol.toUpperCase()}-PERP`;
  return MARKET_METADATA[normalizedSymbol]?.minOrderSize ?? 0.01;
}

/**
 * Get maximum leverage allowed for a market
 * Reads from the centralized leverage cache (on-chain marginRatioInitial data)
 */
export function getMarketMaxLeverage(symbol: string): number {
  return getCachedMaxLeverage(symbol);
}

export function invalidateMarketCache(): void {
  marketCache = null;
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
