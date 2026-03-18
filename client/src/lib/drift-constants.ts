const CONSERVATIVE_FALLBACK = 5;

const DRIFT_LEVERAGE_TIERS: Record<string, number> = {
  'SOL-PERP': 101, 'BTC-PERP': 101, 'ETH-PERP': 101,
  'XRP-PERP': 20,
  'HYPE-PERP': 10, 'SUI-PERP': 10, 'ASTER-PERP': 10, 'FARTCOIN-PERP': 10,
  'LINK-PERP': 10, '1MBONK-PERP': 10, 'AVAX-PERP': 10, 'LIT-PERP': 10,
  'WIF-PERP': 10, 'RENDER-PERP': 10, 'JUP-PERP': 10, 'INJ-PERP': 10,
  'PAXG-PERP': 10, 'BNB-PERP': 10, 'DOGE-PERP': 10, 'JTO-PERP': 10,
  'PYTH-PERP': 10, 'LTC-PERP': 10, 'APT-PERP': 10, 'ARB-PERP': 10,
  'TAO-PERP': 5, '1KPUMP-PERP': 5, 'ZEC-PERP': 5, 'DRIFT-PERP': 5,
  'RAY-PERP': 5, '1KMON-PERP': 5, 'TNSR-PERP': 5,
  'KMNO-PERP': 3,
  'ADA-PERP': 10, 'HNT-PERP': 5, 'PEPE-PERP': 10, 'TRX-PERP': 10,
  'SEI-PERP': 10, 'ONDO-PERP': 10, 'NEAR-PERP': 10, 'MNT-PERP': 10,
  'DOT-PERP': 10, 'AAVE-PERP': 10, 'OP-PERP': 10, 'PENGU-PERP': 10,
  'POL-PERP': 10, 'CRV-PERP': 10, 'POPCAT-PERP': 10,
};

let _cachedLeverageLimits: Record<string, number> | null = null;

export function setLeverageLimitsCache(limits: Record<string, number>): void {
  if (limits && Object.keys(limits).length > 0) {
    _cachedLeverageLimits = limits;
  }
}

export function tickerToDriftMarket(ticker: string): string {
  if (ticker.endsWith('-PERP')) return ticker.toUpperCase();
  const base = ticker.split('/')[0].toUpperCase();
  return `${base}-PERP`;
}

export function getDriftMaxLeverage(ticker: string): number {
  const market = tickerToDriftMarket(ticker);
  if (_cachedLeverageLimits && market in _cachedLeverageLimits) {
    return _cachedLeverageLimits[market];
  }
  return DRIFT_LEVERAGE_TIERS[market] ?? CONSERVATIVE_FALLBACK;
}
