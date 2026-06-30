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
 * docs (or Jupiter's VERIFIED token list, not a bare symbol match), then flipping
 * `enabled` to true.
 */

/** How funds enter and exit a yield asset. */
export type YieldRouteKind = "jupiter" | "kamino" | "jupiter_lend";
/** How a yield holding is valued in USDC. */
export type YieldValuation = "market_quote" | "redemption_rate";
/**
 * User-facing risk tier for the inline chip. Deliberately NOT the same as
 * `valuation` (a pricing-method detail). This answers the only question a
 * non-technical user has: "is this basically a dollar that earns, or can it move?"
 *   stable - trades near $1, deep liquidity, value accrues. Low downside.
 *   float  - the token's USDC price genuinely moves (basis risk / exit spread).
 */
export type YieldRiskClass = "stable" | "float";

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
  /** User-facing risk tier for the inline chip (see YieldRiskClass). */
  riskClass: YieldRiskClass;
  /**
   * True ONLY for assets that can actually lose principal value (e.g. tokenized
   * reinsurance). Drives the inline "may lose value" hint. A token whose price
   * merely floats UP (Treasury-backed) is `float` but NOT mayLoseValue.
   */
  mayLoseValue: boolean;
  /** Approximate APY label for the dropdown/table. Always carries a "~" qualifier. */
  apyLabel: string;
  /** Short, plain-language yield/structure note for the UI (inline supporting text). */
  tag: string;
  /** Longer plain-language note shown behind a detail/expand affordance in the Vault tab. */
  riskNote: string;
  /** Only enabled assets can be quoted, parked, or unparked. */
  enabled: boolean;
  /**
   * DeFiLlama yields pool id (https://yields.llama.fi/pools) for this exact asset.
   * When set, the yield oracle serves the REAL, already-measured APY from DeFiLlama
   * (instant) instead of waiting 12h–14d to self-measure it from on-chain price
   * snapshots. Leave undefined for assets DeFiLlama does not cover (e.g. Perena
   * USD*), which keep the self-measured path. Verify the id against the live /pools
   * feed (project + symbol + chain) before pasting — never guess.
   */
  defiLlamaPoolId?: string;
  /**
   * Switchboard On-Demand price-oracle feed (Solana mainnet pubkey) that reports
   * this asset's EXACT USDC NAV from on-chain account parsing — the protocol's OWN
   * authoritative price, not a swap-quote proxy. When set, the self-measured yield
   * oracle samples price from THIS feed (an exact, clean single-source accrual
   * series, stdev 0) instead of a market swap quote, so a real realized APY can be
   * measured over a SHORT trailing window. Takes precedence over the `valuation`
   * sampling method; `valuation` still governs how money actually moves/is valued.
   * Only meaningful for assets DeFiLlama does NOT cover (a `defiLlamaPoolId` wins).
   * VERIFY the pubkey against the protocol's own developer docs before pasting —
   * never guess, and prefer the single-source feed (the multi-source aggregate can
   * be manipulable).
   */
  navOracleFeed?: string;
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
 *  - JupUSD (Jupiter USD): Jupiter VERIFIED mint, decimals 6, ~$13.8M liquidity.
 *    USDC round trip at $500/$2k/$5k showed ~0% price impact both ways. NOW DISABLED:
 *    plain JupUSD passes NO yield to holders (yield needs a Jupiter Lend deposit ->
 *    jlJupUSD, a different route). See the jupusd row comment.
 *  - USDY (Ondo): Jupiter VERIFIED mint, decimals 6, ~$1.9M liquidity. USDC round
 *    trip at $500/$2k/$5k: buy ~0%, sell ~0.3% (under the 0.5% cap). Treasury-backed,
 *    price floats UP. ENABLED, with a non-US-only eligibility restriction (Ondo's
 *    Reg S terms) surfaced to users in the tag + riskNote so each user self-selects.
 *    See the usdy row comment.
 */
const YIELD_ASSETS: YieldAsset[] = [
  {
    key: "kamino_usdc",
    displayName: "Kamino USDC",
    // kUSDC collateral (cToken) mint for the Kamino main-market USDC reserve,
    // verified on-chain (see .agents/memory/kamino-usdc-onchain-facts.md and
    // KAMINO_KUSDC_MINT in kamino-route.ts). Direct Kamino Lend route is wired
    // (valuation + deposit + withdraw). Enabled at the user's request; the user
    // is running the mainnet deposit/withdraw round-trip smoke themselves in dev.
    mint: "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D",
    decimals: 6,
    route: "kamino",
    valuation: "redemption_rate",
    defaultEligible: true,
    riskClass: "stable",
    mayLoseValue: false,
    apyLabel: "~4-9%",
    tag: "Yield-bearing stablecoin. Kamino lending.",
    riskNote:
      "Your USDC is supplied to Kamino's USDC lending market and earns interest. Principal stays in USDC terms and the value accrues over time.",
    enabled: true,
    // Kamino Lend "Main Market" USDC (verified project+symbol+chain on /pools).
    defiLlamaPoolId: "d2141a59-c199-4be7-8d4b-c8223954836b",
  },
  {
    key: "perena_usd_star",
    displayName: "Perena USD*",
    mint: "star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM",
    decimals: 6,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: true,
    riskClass: "stable",
    mayLoseValue: false,
    apyLabel: "~10%",
    tag: "Yield-bearing stablecoin. Perena pool.",
    riskNote:
      "A yield-bearing stablecoin backed by a pool of stablecoins. Trades near $1; value accrues from the pool's yield.",
    enabled: true,
    // DeFiLlama does not carry a usable USD* pool (only a junk $46K row with a
    // ~0.3% APY), so USD* uses the self-measured path. Perena's "Build with USD*"
    // developer docs publish official on-chain USD* price oracles; this is the
    // SINGLE-SOURCE Switchboard On-Demand feed (from on-chain account parsing = the
    // exact NAV). Verified live via Switchboard Crossbar /simulate (returns the
    // exact NAV ~$1.0757 with stdev 0). The docs also list a triple-source aggregate
    // they warn can be manipulated — deliberately NOT used here. Sampling the exact
    // NAV (instead of the noisy market swap quote) lets the oracle measure a real
    // realized APY over a short window. See switchboard-oracle.ts.
    navOracleFeed: "BmxVZFzucJEgqjcWrp4T5TE62NvgHQrWtxHiZUeNjpBB",
  },
  {
    key: "jupusd",
    displayName: "Jupiter USD",
    // DISABLED 2026-06-20: JupUSD does NOT pass yield to a passive holder. By
    // design (to stay regulatory-compliant) the plain JupUSD token earns nothing;
    // its reserve yield is routed to Jupiter's treasury, not to holders. Yield
    // accrues ONLY if JupUSD is deposited into Jupiter Lend Earn (which mints
    // jlJupUSD), a different token and route. Parking USDC into plain JupUSD via a
    // swap (this route) would earn ~0% while paying the swap spread, so the old
    // "yield-bearing ~4-5%" copy was simply wrong. The real yield-bearing Jupiter
    // option is Jupiter Lend (see the disabled jupiter_lend_usdc row); wire and
    // enable THAT once its mint + deposit/withdraw route are verified, not this.
    // Mint kept (Jupiter VERIFIED list, ~$13.8M liq, ~0% round-trip impact) so the
    // teardown sweep still detects any stray balance.
    mint: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
    decimals: 6,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: false,
    riskClass: "stable",
    mayLoseValue: false,
    apyLabel: "~0% (no native yield)",
    tag: "Plain reserve stablecoin. Earns only via Jupiter Lend, not by holding.",
    riskNote:
      "Jupiter's reserve-backed stablecoin. Holding it does not earn yield on its own; yield only comes from depositing it into Jupiter Lend. Disabled here until that lending route is wired.",
    enabled: false,
  },
  {
    key: "onyc",
    displayName: "OnRe ONyc",
    mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
    decimals: 9,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: false,
    riskClass: "float",
    mayLoseValue: true,
    apyLabel: "~10-12%",
    tag: "Tokenized reinsurance. Price floats, not a stablecoin.",
    riskNote:
      "Tokenized reinsurance. The price floats with the underlying insurance results and CAN lose value. The highest-risk option here.",
    enabled: true,
    // OnRe ONYC (project "onre", Solana) — verified on /pools.
    defiLlamaPoolId: "7083d6a5-e3cb-4eeb-8204-f1b735e4ecbb",
  },
  {
    key: "usdy",
    displayName: "Ondo USDY",
    // Ondo's Treasury-backed yield token. Mint from Jupiter's VERIFIED token list
    // (~$1.9M liq; round-trip buy ~0% / sell ~0.3%, under the 0.5% cap). Price
    // floats UP as it earns (not a fixed $1 token).
    // COMPLIANCE NOTE (eligibility): Ondo's own terms restrict USDY to non-US
    // persons (Regulation S; USDY is an unregistered security outside the US). We
    // do NOT remove the option for the user; instead the restriction is surfaced
    // plainly in the UI copy (tag + riskNote) so each user self-selects. Keeping
    // it available, with disclosure, is the platform owner's decision.
    mint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
    decimals: 6,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: false,
    riskClass: "float",
    mayLoseValue: false,
    apyLabel: "~4-5%",
    tag: "Treasury-backed yield token. Non-US persons only; price floats up.",
    riskNote:
      "Ondo's Treasury-backed yield token, backed by short-term US Treasuries. Ondo's terms restrict it to non-US persons (Regulation S), so only use it if that applies to you. The price floats UP as it earns, so it is not a fixed $1 token, and selling back to USDC costs a small spread (around 0.3%).",
    enabled: true,
    // Ondo USDY on Solana (project "ondo-yield-assets") — verified on /pools.
    defiLlamaPoolId: "00b83068-9f87-4411-b5d7-5d2ff48c40c4",
  },
  {
    key: "jupiter_lend_usdc",
    displayName: "Jupiter Lend USDC",
    // The REAL yield-bearing Jupiter option (plain JupUSD above earns the holder
    // nothing). jlUSDC is Jupiter Lend's receipt token, the direct analogue of
    // Kamino's kUSDC: deposit USDC -> receive jlUSDC, whose USDC redemption value
    // accrues over time (rate = totalAssets/totalSupply from the protocol).
    //
    // Mint VERIFIED ON-CHAIN (2026-06-20) via the protocol's OWN registry, NOT by
    // symbol: getLendingTokens() lists it (id 2) and getLendingTokenDetails reports
    // asset == USDC, decimals == 6, SPL owner, supply > 0 (see JLUSDC_MINT in
    // jupiter-lend-route.ts). The direct "jupiter_lend" deposit/redeem route is now
    // wired (valuation + park + unpark, fail-closed realized-delta verification).
    // Exit is an in-protocol redeem, NOT a swap: on-DEX jlUSDC liquidity is
    // negligible, so the "jupiter" swap seam cannot price it.
    //
    // ENABLED 2026-06-20 but NOT default-eligible (defaultEligible:false): live and
    // selectable for users who opt in, never auto-selected. The route is fully wired
    // and fail-closed; the platform owner is running their own real mainnet
    // deposit/withdraw round-trip to confirm it end-to-end. Same lending model and
    // precedent as Kamino (already live).
    mint: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
    decimals: 6,
    route: "jupiter_lend",
    valuation: "redemption_rate",
    defaultEligible: false,
    riskClass: "stable",
    mayLoseValue: false,
    apyLabel: "~4-5%",
    tag: "Yield-bearing stablecoin. Jupiter Lend.",
    riskNote:
      "Your USDC is supplied to Jupiter's USDC lending market and earns interest. Principal stays in USDC terms and the value accrues over time.",
    enabled: true,
    // Jupiter Lend "Earn" USDC (project "jupiter-lend", Solana) — verified on /pools.
    // NOTE: this pool carries an apyReward component (incentive tokens NOT reflected
    // in the jlUSDC redemption value), so the oracle's headline rule uses apyBase
    // here, not the reward-inflated 30-day mean.
    defiLlamaPoolId: "d783c8df-e2ed-44b4-8317-161ccc1b5f06",
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
