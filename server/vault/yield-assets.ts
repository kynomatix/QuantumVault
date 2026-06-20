/**
 * Phase 0a Vaults: yield-asset registry.
 *
 * The vault parks idle agent-wallet USDC into a yield-bearing token and pulls it
 * back to USDC on demand, through the Jupiter swap seam (server/swap). The edge
 * is CUSTODY: spare capital sits off-exchange in the user's own recoverable
 * agent wallet, not on a trading venue.
 *
 * SECURITY: only assets with a hand-verified canonical mint may be `enabled`.
 * NEVER resolve a yield-token mint by symbol. A symbol search for "ONyc" /
 * "onreUSD" returns pump.fun scam impersonators (see memory onre-onyc-vault.md),
 * so a name lookup could swap user funds into a scam coin. Adding an asset means
 * pasting its canonical mint here after verifying it against the protocol's own
 * docs, then flipping `enabled` to true.
 */

export type YieldAssetType = "hard_peg" | "floating_nav";

export interface YieldAsset {
  /** Stable registry key used by the API and DB rows (never the mint or symbol). */
  key: string;
  displayName: string;
  /** Canonical SPL mint. Verified by hand, never symbol-resolved. */
  mint: string;
  decimals: number;
  /**
   * hard_peg: redeems close to 1:1 with USDC (Kamino USDC, Perena USD*).
   * floating_nav: price drifts with the fund NAV (ONyc), so it carries basis
   * risk and must never be a safe auto-default.
   */
  type: YieldAssetType;
  /** Whether this asset may ever be auto-selected as a default (a Phase 0b concern). */
  defaultEligible: boolean;
  /** Short, plain-language yield/structure note for the UI. */
  tag: string;
  /** Only enabled assets can be quoted, parked, or unparked. */
  enabled: boolean;
}

/**
 * The registry. Disabled rows document intended assets whose canonical mint is
 * not yet hand-verified. They are NOT routable until a verified mint is pasted
 * in and `enabled` is set to true.
 *
 * ONyc decimals (9) and Jupiter routability were verified live against the real
 * mint in 2026-06 (deep Whirlpool liquidity, negligible price impact).
 */
const YIELD_ASSETS: YieldAsset[] = [
  {
    key: "onyc",
    displayName: "OnRe ONyc",
    mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
    decimals: 9,
    type: "floating_nav",
    defaultEligible: false,
    tag: "Tokenized reinsurance, NAV-accruing (~10-12% target). Price floats, this is not a stablecoin.",
    enabled: true,
  },
  // --- Present but DISABLED: canonical mint pending hand-verification. ---
  // Do NOT enable until `mint` is replaced with a verified address.
  {
    key: "kamino_usdc",
    displayName: "Kamino USDC",
    mint: "",
    decimals: 6,
    type: "hard_peg",
    defaultEligible: true,
    tag: "Kamino lending USDC (4-9% variable).",
    enabled: false,
  },
  {
    key: "perena_usd_star",
    displayName: "Perena USD*",
    mint: "",
    decimals: 6,
    type: "hard_peg",
    defaultEligible: true,
    tag: "Perena stable-LP USD* (~10%).",
    enabled: false,
  },
  {
    key: "jupiter_lend_usdc",
    displayName: "Jupiter Lend USDC",
    mint: "",
    decimals: 6,
    type: "hard_peg",
    defaultEligible: false,
    tag: "Jupiter Lend USDC (thinner pools, quote-first before enabling).",
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
 * Returns an ENABLED asset by key, or null. Disabled or unknown keys return
 * null so a caller can never route a non-verified mint.
 */
export function getYieldAssetByKey(key: string): YieldAsset | null {
  const a = YIELD_ASSETS.find((x) => x.key === key);
  if (!a || !a.enabled || a.mint.length === 0) return null;
  return { ...a };
}
