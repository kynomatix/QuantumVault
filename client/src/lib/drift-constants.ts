const CONSERVATIVE_FALLBACK = 5;

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
  return CONSERVATIVE_FALLBACK;
}
