/**
 * Vaults: yield-asset registry.
 *
 * The vault parks idle agent-wallet USDC into a yield-bearing stablecoin and pulls
 * it back to USDC on demand. The edge is CUSTODY: spare capital sits off-exchange in
 * the user's own recoverable agent wallet, not on a trading venue.
 *
 * These are YIELD-BEARING STABLECOINS, not fixed pegs. The yield is rebased into the
 * asset's value over time. They differ in HOW funds enter/exit and HOW value accrues,
 * which is captured by two fields:
 *   - route:     how funds move in/out ("jupiter" swap seam, or "kamino" direct Lend).
 *   - valuation: how the holding is priced in USDC ("market_quote" live swap quote, or
 *                "redemption_rate" protocol redemption rate).
 *
 * SECURITY: only assets with a hand-verified canonical mint may be `enabled`.
 * NEVER resolve a yield-token mint by symbol. A symbol search for "ONyc" /
 * "onreUSD" returns pump.fun scam impersonators (see memory onre-onyc-vault.md),
 * so a name lookup could swap user funds into a scam coin. Adding an asset means
 * pasting its canonical mint here after verifying it against the protocol's own
 * docs, then flipping `enabled` to true.
 */

/** How funds enter and exit a yield asset. */
export type YieldRouteKind = "jupiter" | "kamino";
/** How a yield holding is valued in USDC. */
export type YieldValuation = "market_quote" | "redemption_rate";

export interface YieldAsset {
  /** Stable registry key used by the API and DB rows (never the mint or symbol). */
  key: string;
  displayName: string;
  /** Canonical SPL mint. Verified by hand, never symbol-resolved. */
  mint: string;
  decimals: number;
  /** How funds move in/out: "jupiter" swap seam, or "kamino" direct Lend deposit/withdraw. */
  route: YieldRouteKind;
  /**
   * How the on-chain holding is valued in USDC:
   *   market_quote   - live swap quote (NAV tokens whose price floats: Perena USD*, ONyc).
   *   redemption_rate - protocol redemption rate (principal stable, value accrues: Kamino).
   * market_quote assets carry basis risk: a round trip can return more or less than was
   * put in, so they must never be treated as a riskless 1:1 store.
   */
  valuation: YieldValuation;
  /** Whether this asset may ever be auto-selected as a default (a later concern). */
  defaultEligible: boolean;
  /** Short, plain-language yield/structure note for the UI. */
  tag: string;
  /** Only enabled assets can be quoted, parked, or unparked. */
  enabled: boolean;
}

/**
 * The registry. Disabled rows document intended assets whose canonical mint is
 * not yet hand-verified (or whose route is not yet wired). They are NOT routable
 * until a verified mint is pasted in and `enabled` is set to true.
 *
 * Verified live (2026-06):
 *  - ONyc: real mint, decimals 9, deep Jupiter liquidity, negligible price impact.
 *  - Perena USD*: real mint, decimals 6, NAV mint/redeem route both ways up to ~20k
 *    USDC at ~0.05% impact (single route, output scales linearly).
 */
const YIELD_ASSETS: YieldAsset[] = [
  {
    key: "kamino_usdc",
    displayName: "Kamino USDC",
    // kUSDC collateral (cToken) mint for the Kamino main-market USDC reserve,
    // verified on-chain (see .agents/memory/kamino-usdc-onchain-facts.md and
    // KAMINO_KUSDC_MINT in kamino-route.ts). Stays disabled until the direct route
    // ships and a mainnet round-trip smoke passes.
    mint: "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D",
    decimals: 6,
    route: "kamino",
    valuation: "redemption_rate",
    defaultEligible: true,
    tag: "Yield-bearing stablecoin. Kamino lending, ~4-9%.",
    enabled: false,
  },
  {
    key: "perena_usd_star",
    displayName: "Perena USD*",
    mint: "star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM",
    decimals: 6,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: true,
    tag: "Yield-bearing stablecoin. Perena pool, ~10%.",
    enabled: true,
  },
  {
    key: "onyc",
    displayName: "OnRe ONyc",
    mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
    decimals: 9,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: false,
    tag: "Tokenized reinsurance, ~10-12%. Price floats, not a stablecoin.",
    enabled: true,
  },
  // --- Present but DISABLED: not yet verified/wired. Do NOT enable until ready. ---
  {
    key: "jupiter_lend_usdc",
    displayName: "Jupiter Lend USDC",
    mint: "",
    decimals: 6,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: false,
    tag: "Jupiter Lend USDC (disabled; quote-first before enabling).",
    enabled: false,
  },
];

/** Assets a user can actually quote/park/unpark right now (enabled + real mint). */
export function getEnabledYieldAssets(): YieldAsset[] {
  return YIELD_ASSETS.filter((a) => a.enabled && a.mint.length > 0);
}

/** Full registry including disabled rows (for admin/debug listing only). */
export function getAllYieldAssets(): YieldAsset[] {
  return YIELD_ASSETS.map((a) => ({ ...a }));
}

/**
 * Assets the teardown sweep guard must probe for stranded balances: every row
 * with a verified (non-empty) mint, ENABLED OR DISABLED. Broader than
 * getEnabledYieldAssets because a token parked while an asset was enabled must
 * still be detected after it is later disabled (e.g. Kamino). Blank-mint
 * placeholder rows are excluded: they hold no real mint, so probing them would
 * throw on `new PublicKey("")` and wrongly block every recover/delete sweep.
 */
export function getDetectableYieldAssets(): YieldAsset[] {
  return YIELD_ASSETS.filter((a) => a.mint.length > 0).map((a) => ({ ...a }));
}

/**
 * Returns an ENABLED asset by key, or null. Disabled or unknown keys return
 * null so a caller can never route a non-verified mint.
 */
export function getYieldAssetByKey(key: string): YieldAsset | null {
  const a = YIELD_ASSETS.find((x) => x.key === key);
  if (!a || !a.enabled || a.mint.length === 0) return null;
  return { ...a };
}
