import { getMarketInfo } from "../market-registry";
import { phoenixAiMarkets } from './phoenix-capabilities';

/**
 * Exact-symbol AI Trader admission. The registry key is the authority: this
 * helper deliberately performs no trimming, case folding, alias resolution,
 * multiplier stripping, or fallback lookup.
 */
export function isAiTraderMarketAdmitted(internalSymbol: string, protocol = 'pacifica'): boolean {
  if (protocol === 'phoenix') return phoenixAiMarkets().includes(internalSymbol);
  return typeof internalSymbol === "string"
    && internalSymbol.length > 0
    && getMarketInfo(internalSymbol) !== undefined;
}

export const SCANNER_MARKET_UNADMITTED_REASON = "scanner_market_unadmitted" as const;
