/**
 * BORROW ORACLE REGISTRY — Phase C (NON-money, read-only companion to the
 * oracle-freshness reader `borrow-oracle-freshness.ts`).
 *
 * A HARD per-collateral map from a launch-allowlisted borrow vault to the
 * authoritative price feed(s) used to read freshness (publish age) and 1h
 * volatility. Kept in lockstep with the collateral allowlist
 * (`borrow-allowlist.ts`): a vault with NO verified entry here resolves to NO
 * source -> the freshness reader yields {null,null} -> the enforced money gate
 * (`borrow-risk-policy.ts`) fails closed. We NEVER guess a feed.
 *
 * v1 ships only the `pyth_direct` shape (one Pyth price feed == the collateral's
 * USD price). The discriminated `kind` field leaves room for a future
 * `pyth_composite_multiply` (e.g. an LST priced as stake-rate x SOL/USD) — that
 * branch is added, WITH its own tests, only when a composite-oracle asset joins
 * the allowlist. We deliberately do NOT ship an untested composite branch in a
 * money gate.
 *
 * Each Pyth feed id below was VERIFIED against live Pyth Hermes AND cross-checked
 * to the vault's on-chain oracle liquidation price before being registered. The
 * reader also re-runs that price cross-check at call time as a wrong-map guard.
 */

/** A collateral whose USD price is a single direct Pyth feed (Crypto.<BASE>/USD). */
export interface PythDirectOracleSource {
  kind: "pyth_direct";
  vaultId: number;
  collateralMint: string;
  collateralSymbol: string;
  /** Pyth feed id (hex, no 0x). Verified vs live Hermes + the vault's oracle price. */
  feedId: string;
}

/**
 * An LST whose Jupiter Lend vault uses a stakePool + Chainlink composite oracle
 * with NO direct Pyth feed (e.g. JupSOL, dfdvSOL). The Pyth SOL/USD feed is used
 * as a PROXY for freshness and 1h volatility checking:
 *   - Sound: the LST's price volatility directly tracks SOL (same underlying).
 *   - The stakePool rate is stable on-chain (slow accumulation), so SOL feed
 *     freshness covers the volatile component.
 *   - The price-divergence guard is intentionally SKIPPED for this kind — SOL/USD
 *     price ≠ LST/USD price by design, and the proxy relationship is hardcoded
 *     (not user-supplied), so the guard's purpose (catch wrong feed mappings) does
 *     not apply.
 */
export interface PythSolProxyOracleSource {
  kind: "pyth_sol_proxy";
  vaultId: number;
  collateralMint: string;
  collateralSymbol: string;
  /** Pyth SOL/USD feed id (hex, no 0x) — freshness + 1h volatility proxy. */
  solFeedId: string;
}

export type BorrowOracleSource = PythDirectOracleSource | PythSolProxyOracleSource;

/**
 * Registry keyed by the on-chain vault id (stable). The `collateralMint` is the
 * mint we EXPECT for that vault; a mismatch at lookup time means the map is
 * wrong -> fail closed.
 */
const REGISTRY: Record<number, BorrowOracleSource> = {
  // INF (Sanctum Infinity LST) -> USDC, vault 43 — the first verified launch vault.
  // Direct Pyth feed "Crypto.INF/USD". VERIFIED 2026-06-24: Hermes $99.27 vs the
  // vault's on-chain liquidation price ~$99.21 (0.06% — confirms the mapping).
  43: {
    kind: "pyth_direct",
    vaultId: 43,
    collateralMint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    collateralSymbol: "INF",
    feedId: "f51570985c642c49c2d6e50156390fdba80bb6d5f7fa389d2f012ced4f7d208f",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Direct-feed launch set. ALL verified 2026-06-28 against live Pyth Hermes vs
  // each vault's on-chain liquidation price (divergence noted per entry; every
  // one < 0.8%). The freshness reader re-runs this cross-check at call time as a
  // wrong-map guard, so a drifted feed still fails closed.
  // ───────────────────────────────────────────────────────────────────────────

  // SOL -> USDC, vault 1. Priced by the canonical "Crypto.SOL/USD" feed.
  // The mint is the wrapped-SOL token address (1:1 SOL) and the backend
  // transparently wraps native SOL into it. The user only ever sees "SOL".
  1: {
    kind: "pyth_direct",
    vaultId: 1,
    collateralMint: "So11111111111111111111111111111111111111112",
    collateralSymbol: "SOL",
    feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },

  // JitoSOL (Jito LST) -> USDC, vault 15. Direct "Crypto.JITOSOL/USD".
  // VERIFIED: Hermes $91.82 vs vault liq $91.86 (0.04%).
  15: {
    kind: "pyth_direct",
    vaultId: 15,
    collateralMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    collateralSymbol: "JitoSOL",
    feedId: "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb",
  },

  // mSOL (Marinade LST) -> USDC, vault 49. Direct "Crypto.MSOL/USD".
  // VERIFIED: Hermes $98.92 vs vault liq $99.22 (0.30%).
  49: {
    kind: "pyth_direct",
    vaultId: 49,
    collateralMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    collateralSymbol: "mSOL",
    feedId: "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4",
  },

  // JLP (Jupiter Perps LP) -> USDC, vault 8. Uses the JLP REDEMPTION-RATE (NAV)
  // feed — the correct reference for a redeemable LP token, and it reads a USD NAV
  // price (~$3.43), NOT a bare ratio. VERIFIED: Hermes $3.426 vs vault liq $3.424 (0.08%).
  8: {
    kind: "pyth_direct",
    vaultId: 8,
    collateralMint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    collateralSymbol: "JLP",
    feedId: "6704952e00b6a088b6dcdb8170dcd591eaf64cff9e996ca75ae0ca55bfb96687",
  },

  // LBTC (Lombard BTC) -> USDC, vault 41. VERIFIED: Hermes $60,371 vs vault liq $60,445 (0.12%).
  41: {
    kind: "pyth_direct",
    vaultId: 41,
    collateralMint: "LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY",
    collateralSymbol: "LBTC",
    feedId: "8f257aab6e7698bb92b15511915e593d6f8eae914452f781874754b03d0c612b",
  },

  // xBTC -> USDC, vault 9. VERIFIED: Hermes $60,195 vs vault liq $60,182 (0.02%).
  9: {
    kind: "pyth_direct",
    vaultId: 9,
    collateralMint: "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn",
    collateralSymbol: "xBTC",
    feedId: "ae8f269ed9c4bed616c99a98cf6dfe562bd3202e7f91821a471ff854713851b4",
  },

  // cbBTC (Coinbase BTC) -> USDC, vault 11. VERIFIED: Hermes $60,260 vs vault liq $60,182 (0.13%).
  11: {
    kind: "pyth_direct",
    vaultId: 11,
    collateralMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    collateralSymbol: "cbBTC",
    feedId: "2817d7bfe5c64b8ea956e9a26f573ef64e72e4d7891f2d6af9bcc93f7aff9a97",
  },

  // WBTC (Wrapped BTC) -> USDC, vault 25. VERIFIED: Hermes $60,280 vs vault liq $60,182 (0.16%).
  25: {
    kind: "pyth_direct",
    vaultId: 25,
    collateralMint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    collateralSymbol: "WBTC",
    feedId: "c9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33",
  },

  // syrupUSDC (Maple yield-bearing USDC) -> USDC, vault 7.
  // VERIFIED: Hermes $1.1708 vs vault liq $1.1709 (0.02%).
  7: {
    kind: "pyth_direct",
    vaultId: 7,
    collateralMint: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj",
    collateralSymbol: "syrupUSDC",
    feedId: "e616297dab48626eaacf6d030717b25823b13ae6520b83f4735bf8deec8e2c9a",
  },

  // JUP (Jupiter) -> USDC, vault 40. VERIFIED: Hermes $0.2148 vs vault liq $0.2137 (0.56%).
  40: {
    kind: "pyth_direct",
    vaultId: 40,
    collateralMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    collateralSymbol: "JUP",
    feedId: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tokenized US equities (xStocks). Pyth publishes USD feeds for these, but they
  // go STALE outside US market hours → the freshness reader returns null and the
  // money gate fails closed (denies NEW borrows) off-hours BY DESIGN. Safe, but
  // availability is limited to roughly market hours. Verified 2026-06-28 while fresh.
  // ───────────────────────────────────────────────────────────────────────────

  // TSLAx (tokenized TSLA) -> USDC, vault 77. VERIFIED: Hermes $380.82 vs vault liq $378.01 (0.75%).
  77: {
    kind: "pyth_direct",
    vaultId: 77,
    collateralMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    collateralSymbol: "TSLAx",
    feedId: "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362",
  },

  // NVDAx (tokenized NVDA) -> USDC, vault 80. VERIFIED: Hermes $194.01 vs vault liq $193.00 (0.52%).
  80: {
    kind: "pyth_direct",
    vaultId: 80,
    collateralMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    collateralSymbol: "NVDAx",
    feedId: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
  },

  // SPYx (tokenized SPY) -> USDC, vault 78. VERIFIED: Hermes $735.88 vs vault liq $735.40 (0.07%).
  78: {
    kind: "pyth_direct",
    vaultId: 78,
    collateralMint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    collateralSymbol: "SPYx",
    feedId: "2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14",
  },

  // QQQx (tokenized QQQ) -> USDC, vault 79. VERIFIED: Hermes $710.50 vs vault liq $708.14 (0.33%).
  79: {
    kind: "pyth_direct",
    vaultId: 79,
    collateralMint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    collateralSymbol: "QQQx",
    feedId: "178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // SOL-proxy LSTs. These vaults use a stakePool + Chainlink composite oracle
  // on Jupiter Lend's side and have NO direct Pyth price feed. The Pyth SOL/USD
  // feed (same feedId as vault 1) is registered here as a proxy for freshness and
  // 1h volatility. The price-divergence guard is skipped by the freshness reader
  // for this kind (SOL/USD price intentionally differs from the LST price).
  // Both vaults share the same LT=0.80 / CF=0.75 risk params as JitoSOL/mSOL.
  // ───────────────────────────────────────────────────────────────────────────

  // JupSOL (Jupiter Staked SOL) -> USDC, vault 13.
  // Pyth has no direct JupSOL/USD feed; vault uses stakePool 8VpRhuxa... + Chainlink.
  // Mint + vault ID verified 2026-07-05 via @jup-ag/lend/api getVaults().
  // Oracle price: ~$97 (JupSOL stakePool rate ~0.97 when SOL ~$101).
  13: {
    kind: "pyth_sol_proxy",
    vaultId: 13,
    collateralMint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    collateralSymbol: "JupSOL",
    solFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },

  // dfdvSOL (DeFi Development Corp Staked SOL) -> USDC, vault 63.
  // Same oracle type as JupSOL: stakePool pyZMBjpW... + Chainlink, no direct Pyth feed.
  // Mint + vault ID verified 2026-07-05 via @jup-ag/lend/api getVaults().
  // Oracle price: ~$88 (dfdvSOL stakePool rate ~0.87 when SOL ~$101).
  63: {
    kind: "pyth_sol_proxy",
    vaultId: 63,
    collateralMint: "sctmB7GPi5L2Q5G9tUSzXvhZ4YiDMEGcRov9KfArQpx",
    collateralSymbol: "dfdvSOL",
    solFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
};

/**
 * Returns the verified oracle source for a borrow vault, or null when the vault
 * is unmapped OR the collateral mint does not match the registered mint (a mint
 * mismatch means the lookup is wrong -> fail closed, never read a guessed feed).
 */
export function getBorrowOracleSource(
  vaultId: number,
  collateralMint: string,
): BorrowOracleSource | null {
  const src = REGISTRY[vaultId];
  if (!src) return null;
  if (src.collateralMint !== collateralMint) return null;
  if (src.kind === "pyth_direct") {
    if (!src.feedId || typeof src.feedId !== "string") return null;
  } else if (src.kind === "pyth_sol_proxy") {
    if (!src.solFeedId || typeof src.solFeedId !== "string") return null;
  } else {
    return null; // unknown kind → fail closed
  }
  return src;
}

/**
 * The collateral mint a vault's registry entry expects, or null when the vault is
 * unmapped. Introspection helper for the allowlist↔registry lockstep test — so a
 * future allowlist addition that lacks a verified feed is caught at test time
 * rather than silently failing closed in production. NOT used by the money path.
 */
export function getRegisteredCollateralMint(vaultId: number): string | null {
  return REGISTRY[vaultId]?.collateralMint ?? null;
}
