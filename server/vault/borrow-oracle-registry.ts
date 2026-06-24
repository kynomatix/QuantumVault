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

export type BorrowOracleSource = PythDirectOracleSource;

/**
 * Registry keyed by the on-chain vault id (stable). The `collateralMint` is the
 * mint we EXPECT for that vault; a mismatch at lookup time means the map is
 * wrong -> fail closed.
 */
const REGISTRY: Record<number, BorrowOracleSource> = {
  // INF (Sanctum Infinity LST) -> USDC, vault 43 — the only verified launch vault.
  // Direct Pyth feed "Crypto.INF/USD". VERIFIED 2026-06-24: Hermes $99.27 vs the
  // vault's on-chain liquidation price ~$99.21 (0.06% — confirms the mapping).
  43: {
    kind: "pyth_direct",
    vaultId: 43,
    collateralMint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    collateralSymbol: "INF",
    feedId: "f51570985c642c49c2d6e50156390fdba80bb6d5f7fa389d2f012ced4f7d208f",
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
  if (!src.feedId || typeof src.feedId !== "string") return null;
  return src;
}
