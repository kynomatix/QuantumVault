/**
 * Exact quarantine for unqualified multiplier-prefixed internal markets.
 *
 * This duplicates only the documented 1K/1M prefix shape from datafeed.ts.
 * It deliberately does not resolve aliases, infer a scale, or modify symbols.
 */
export function isMultiplierMarketQuarantined(internalSymbol: string): boolean {
  if (typeof internalSymbol !== "string" || internalSymbol.length === 0) return false;
  const base = internalSymbol.replace(/-PERP$/i, "");
  return /^1[KM].+$/i.test(base);
}

export const MULTIPLIER_UNQUALIFIED_REASON = "multiplier_unqualified" as const;
