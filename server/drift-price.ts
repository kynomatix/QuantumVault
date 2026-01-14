const COINGECKO_IDS: Record<string, string> = {
  'SOL-PERP': 'solana',
  'BTC-PERP': 'bitcoin',
  'ETH-PERP': 'ethereum',
  'ZEC-PERP': 'zcash',
  'DOGE-PERP': 'dogecoin',
  'SUI-PERP': 'sui',
  'APT-PERP': 'aptos',
  'AVAX-PERP': 'avalanche-2',
  'ARB-PERP': 'arbitrum',
  'OP-PERP': 'optimism',
  'LINK-PERP': 'chainlink',
  'POL-PERP': 'polygon-ecosystem-token',
  'JTO-PERP': 'jito-governance-token',
  'JUP-PERP': 'jupiter-exchange-solana',
  'WIF-PERP': 'dogwifcoin',
  'BONK-PERP': 'bonk',
  '1MBONK-PERP': 'bonk',
  'PEPE-PERP': 'pepe',
  '1MPEPE-PERP': 'pepe',
  'RNDR-PERP': 'render-token',
  'INJ-PERP': 'injective-protocol',
  'PYTH-PERP': 'pyth-network',
  'W-PERP': 'wormhole',
  'TIA-PERP': 'celestia',
  'WLD-PERP': 'worldcoin-wld',
  'SEI-PERP': 'sei-network',
  'NEAR-PERP': 'near',
  'FTM-PERP': 'fantom',
  'ATOM-PERP': 'cosmos',
  'DOT-PERP': 'polkadot',
  'LTC-PERP': 'litecoin',
  'BCH-PERP': 'bitcoin-cash',
  'XRP-PERP': 'ripple',
  'ADA-PERP': 'cardano',
  'TON-PERP': 'the-open-network',
  'PAXG-PERP': 'pax-gold',
  'RAY-PERP': 'raydium',
  'PENGU-PERP': 'pudgy-penguins',
  'MNT-PERP': 'mantle',
  'BERA-PERP': 'berachain-bera',
};

let priceCache: Record<string, number> = {};
let lastFetch = 0;
const CACHE_TTL = 30000; // 30 seconds

// Drift API cache (longer TTL since it's for fallback)
let driftPriceCache: Record<string, number> = {};
let lastDriftFetch = 0;
const DRIFT_CACHE_TTL = 60000; // 1 minute

export async function getMarketPrice(market: string): Promise<number | null> {
  const prices = await getAllPrices();
  return prices[market] ?? null;
}

/**
 * Fetch prices from Drift Data API (has all markets)
 */
async function fetchDriftPrices(): Promise<Record<string, number>> {
  const now = Date.now();
  
  if (now - lastDriftFetch < DRIFT_CACHE_TTL && Object.keys(driftPriceCache).length > 0) {
    return driftPriceCache;
  }
  
  try {
    const response = await fetch('https://data.api.drift.trade/contracts', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      console.log('[DriftPrice] Drift API error:', response.status);
      return driftPriceCache;
    }
    
    const data = await response.json();
    const prices: Record<string, number> = {};
    
    const contracts = data.contracts || data;
    if (Array.isArray(contracts)) {
      for (const contract of contracts) {
        const symbol = contract.ticker_id;
        const indexPrice = parseFloat(contract.index_price);
        
        if (symbol && !isNaN(indexPrice) && indexPrice > 0) {
          prices[symbol] = indexPrice;
        }
      }
    }
    
    if (Object.keys(prices).length > 0) {
      driftPriceCache = prices;
      lastDriftFetch = now;
      console.log(`[DriftPrice] Fetched ${Object.keys(prices).length} prices from Drift API`);
    }
    
    return prices;
  } catch (error: any) {
    console.error('[DriftPrice] Failed to fetch from Drift API:', error.message);
    return driftPriceCache;
  }
}

/**
 * Fetch prices from CoinGecko (limited markets but reliable)
 */
async function fetchCoinGeckoPrices(): Promise<Record<string, number>> {
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(10000) }
    );
    
    if (!response.ok) {
      console.log('[DriftPrice] CoinGecko API error:', response.status);
      return {};
    }
    
    const data = await response.json();
    
    const prices: Record<string, number> = {};
    for (const [market, geckoId] of Object.entries(COINGECKO_IDS)) {
      if (data[geckoId]?.usd) {
        prices[market] = data[geckoId].usd;
      }
    }
    
    return prices;
  } catch (error: any) {
    console.error('[DriftPrice] Failed to fetch from CoinGecko:', error.message);
    return {};
  }
}

export async function getAllPrices(): Promise<Record<string, number>> {
  const now = Date.now();
  
  // Return cache if still fresh
  if (now - lastFetch < CACHE_TTL && Object.keys(priceCache).length > 0) {
    return priceCache;
  }
  
  // Fetch from both sources in parallel
  const [driftPrices, coinGeckoPrices] = await Promise.all([
    fetchDriftPrices(),
    fetchCoinGeckoPrices(),
  ]);
  
  // Merge: CoinGecko takes priority for the markets it covers (more reliable),
  // Drift fills in all other markets
  const prices: Record<string, number> = {
    ...driftPrices,      // All Drift markets as base
    ...coinGeckoPrices,  // CoinGecko overrides for supported markets
  };
  
  if (Object.keys(prices).length > 0) {
    priceCache = prices;
    lastFetch = now;
  }
  
  return prices;
}
