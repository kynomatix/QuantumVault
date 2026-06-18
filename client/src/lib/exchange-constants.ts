import { tickerToMarket, getMaxLeverageFromTiers } from "@shared/leverage";

// Re-export so existing consumers keep importing market normalization from here.
export { tickerToMarket };

// Live per-market leverage limits fetched from the venue at runtime. When present
// they override the static table in @shared/leverage; otherwise we fall back to it.
let _cachedLeverageLimits: Record<string, number> | null = null;

export function setLeverageLimitsCache(limits: Record<string, number>): void {
  if (limits && Object.keys(limits).length > 0) {
    _cachedLeverageLimits = limits;
  }
}

export function getMaxLeverage(ticker: string): number {
  const market = tickerToMarket(ticker);
  if (_cachedLeverageLimits && market in _cachedLeverageLimits) {
    return _cachedLeverageLimits[market];
  }
  return getMaxLeverageFromTiers(ticker);
}

export type ProtocolId = 'pacifica' | 'flash';

export interface ProtocolMeta {
  id: ProtocolId;
  label: string;
  icon: string;
  // Minimum funding (USDC) required to create a bot on this exchange. 0 = no minimum.
  // Pacifica enforces a $10 floor in its atomic provision path; Flash has none.
  minDeposit: number;
}

// User-selectable exchanges for new bot creation. Drift is intentionally excluded
// (retired — existing Drift bots keep running, but no new ones can be created). Icons
// are the white monochrome marks in client/public/images/exchange/.
export const SELECTABLE_PROTOCOLS: ProtocolMeta[] = [
  { id: 'pacifica', label: 'Pacifica', icon: '/images/exchange/Pacifica.webp', minDeposit: 10 },
  { id: 'flash', label: 'Flash', icon: '/images/exchange/Flash.webp', minDeposit: 0 },
];

// Minimum funding (USDC) required to create a bot on the given protocol.
export function getProtocolMinDeposit(id: ProtocolId): number {
  return SELECTABLE_PROTOCOLS.find((p) => p.id === id)?.minDeposit ?? 0;
}
