const COINGECKO_IDS: Record<string, string> = {
  'SOL-PERP': 'solana',
  'BTC-PERP': 'bitcoin',
  'ETH-PERP': 'ethereum',
};

let priceCache: Record<string, number> = {};
let lastFetch = 0;
const CACHE_TTL = 30000;

export async function getMarketPrice(market: string): Promise<number | null> {
  const prices = await getAllPrices();
  return prices[market] ?? null;
}

export async function getAllPrices(): Promise<Record<string, number>> {
  const now = Date.now();
  
  if (now - lastFetch < CACHE_TTL && Object.keys(priceCache).length > 0) {
    return priceCache;
  }
  
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    
    if (!response.ok) {
      console.log('CoinGecko API error:', response.status);
      return priceCache;
    }
    
    const data = await response.json();
    
    const prices: Record<string, number> = {};
    for (const [market, geckoId] of Object.entries(COINGECKO_IDS)) {
      if (data[geckoId]?.usd) {
        prices[market] = data[geckoId].usd;
      }
    }
    
    priceCache = prices;
    lastFetch = now;
    return prices;
  } catch (error) {
    console.error('Failed to fetch prices:', error);
    return priceCache;
  }
}
