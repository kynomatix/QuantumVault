import { getDetectableYieldAssets } from "./yield-assets";

/**
 * A balance reader for a single (wallet, mint). It MUST fail closed: an
 * unreadable balance has to THROW (not collapse to 0) so a caller can never
 * misread an RPC/parse failure as "no parked tokens" and sweep parked funds.
 * In production this is `getAgentTokenBalanceRawStrict` from agent-wallet.
 */
export type YieldBalanceReader = (
  walletPubkey: string,
  mint: string,
) => Promise<{ amountRaw: string }>;

/**
 * Returns the display names of EVERY known yield asset (enabled OR disabled)
 * with a non-zero on-chain balance in `walletPubkey`, so a token parked before
 * an asset was later disabled is still caught. Reads are NOT swallowed: if the
 * injected reader throws, this rejects and the caller must treat it as "cannot
 * confirm empty" and fail closed (never sweep).
 *
 * Extracted as a pure, reader-injected helper so the fail-closed invariant can
 * be unit-tested without importing the full server.
 */
export async function detectParkedYieldTokens(
  walletPubkey: string,
  readBalance: YieldBalanceReader,
): Promise<string[]> {
  const parked: string[] = [];
  for (const asset of getDetectableYieldAssets()) {
    const bal = await readBalance(walletPubkey, asset.mint);
    if (BigInt(bal.amountRaw) > BigInt(0)) parked.push(asset.displayName);
  }
  return parked;
}
