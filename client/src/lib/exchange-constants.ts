const CONSERVATIVE_FALLBACK = 5;

const LEVERAGE_TIERS: Record<string, number> = {
  'BTC-PERP': 50, 'ETH-PERP': 50, 'EURUSD-PERP': 50, 'USDJPY-PERP': 50,
  'SOL-PERP': 20, 'XRP-PERP': 20, 'HYPE-PERP': 20, 'SP500-PERP': 20,
  'DOGE-PERP': 15,
  '1MBONK-PERP': 10, '1MPEPE-PERP': 10, 'AAVE-PERP': 10, 'ADA-PERP': 10,
  'ARB-PERP': 10, 'AVAX-PERP': 10, 'BCH-PERP': 10, 'BNB-PERP': 10,
  'CL-PERP': 10, 'COPPER-PERP': 10, 'CRCL-PERP': 10, 'CRV-PERP': 10,
  'ENA-PERP': 10, 'FARTCOIN-PERP': 10, 'GOOGL-PERP': 10, 'HOOD-PERP': 10,
  'JUP-PERP': 10, 'LDO-PERP': 10, 'LINK-PERP': 10, 'LTC-PERP': 10,
  'NATGAS-PERP': 10, 'NEAR-PERP': 10, 'NVDA-PERP': 10, 'PAXG-PERP': 10,
  'PLATINUM-PERP': 10, 'PLTR-PERP': 10, 'SUI-PERP': 10, 'TAO-PERP': 10,
  'TRUMP-PERP': 10, 'TSLA-PERP': 10, 'UNI-PERP': 10, 'URNM-PERP': 10,
  'XAG-PERP': 10, 'XAU-PERP': 10, 'XMR-PERP': 10, 'XPL-PERP': 10,
  'ZEC-PERP': 10,
  'ASTER-PERP': 5, 'ICP-PERP': 5, 'LIT-PERP': 5, 'PENGU-PERP': 5,
  'PUMP-PERP': 5, 'STRK-PERP': 5, 'VIRTUAL-PERP': 5, 'WIF-PERP': 5,
  'WLD-PERP': 5, 'WLFI-PERP': 5, 'ZK-PERP': 5, 'ZRO-PERP': 5,
  '2Z-PERP': 3, 'BP-PERP': 3, 'MEGA-PERP': 3, 'MON-PERP': 3, 'PIPPIN-PERP': 3,
};

let _cachedLeverageLimits: Record<string, number> | null = null;

export function setLeverageLimitsCache(limits: Record<string, number>): void {
  if (limits && Object.keys(limits).length > 0) {
    _cachedLeverageLimits = limits;
  }
}

const TICKER_ALIASES: Record<string, string> = {
  'BONK': '1MBONK',
  'PEPE': '1MPEPE',
};

export function tickerToMarket(ticker: string): string {
  if (ticker.endsWith('-PERP')) return ticker.toUpperCase();
  const base = ticker.split('/')[0].toUpperCase();
  const canonical = TICKER_ALIASES[base] ?? base;
  return `${canonical}-PERP`;
}

export function getMaxLeverage(ticker: string): number {
  const market = tickerToMarket(ticker);
  if (_cachedLeverageLimits && market in _cachedLeverageLimits) {
    return _cachedLeverageLimits[market];
  }
  return LEVERAGE_TIERS[market] ?? CONSERVATIVE_FALLBACK;
}

export type ProtocolId = 'pacifica' | 'flash';

export interface ProtocolMeta {
  id: ProtocolId;
  label: string;
  icon: string;
}

// User-selectable exchanges for new bot creation. Drift is intentionally excluded
// (retired — existing Drift bots keep running, but no new ones can be created). Icons
// are the white monochrome marks in client/public/images/exchange/.
export const SELECTABLE_PROTOCOLS: ProtocolMeta[] = [
  { id: 'pacifica', label: 'Pacifica', icon: '/images/exchange/Pacifica.webp' },
  { id: 'flash', label: 'Flash', icon: '/images/exchange/Flash.webp' },
];
