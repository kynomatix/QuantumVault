import { getMarketInfo } from "../market-registry";

/**
 * Exact-symbol AI Trader admission. The registry key is the authority: this
 * helper deliberately performs no trimming, case folding, alias resolution,
 * multiplier stripping, or fallback lookup.
 */
export function isAiTraderMarketAdmitted(internalSymbol: string): boolean {
  return typeof internalSymbol === "string"
    && internalSymbol.length > 0
    && getMarketInfo(internalSymbol) !== undefined;
}

export const SCANNER_MARKET_UNADMITTED_REASON = "scanner_market_unadmitted" as const;
