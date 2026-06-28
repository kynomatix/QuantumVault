/**
 * BORROW LAUNCH ALLOWLIST — Phase C (NON-money config). Decision Wall #5 + #7.
 *
 * Two owner-controlled launch gates the read-only preview + (future) money path
 * consult. They are intentionally CONSERVATIVE and owner-pending where the owner
 * has not yet ratified membership — the same "owner-pending default" discipline
 * as borrow-preview-assumptions.ts. Widening any of these is an owner decision,
 * made HERE, on purpose.
 *
 * Collateral is gated by VAULT ID, never by a client-supplied mint/symbol: the
 * route resolves the on-chain vault config first, then checks its `vaultId`. This
 * means a caller can never smuggle in an unverified mint, and we never hardcode a
 * mint string that could go stale.
 */

/**
 * Launch collateral allowlist (Decision Wall #5), by Jupiter Lend vault id. Every
 * id here has a verified direct-Pyth-feed entry in `borrow-oracle-registry.ts`
 * (kept in lockstep: an allowlisted vault with no registry entry fails closed at
 * the oracle gate). Each feed was cross-checked against the vault's on-chain
 * liquidation price before being added.
 *   - 43 = INF (verified 2026-06-24).
 *   - 1/15/49 = SOL/JitoSOL/mSOL, 8 = JLP, 41/9/11/25 = LBTC/xBTC/cbBTC/WBTC,
 *     7 = syrupUSDC, 40 = JUP (all verified 2026-06-28).
 *   - 77/80/78/79 = TSLAx/NVDAx/SPYx/QQQx (tokenized equities — their Pyth feeds
 *     go stale outside US market hours, so the oracle gate denies new borrows
 *     off-hours by design; safe, but limited availability).
 * Owner adds vault ids here to widen the launch collateral set.
 */
export const ALLOWED_BORROW_VAULT_IDS: ReadonlySet<number> = new Set<number>([
  43, // INF
  1, 15, 49, // SOL (WSOL), JitoSOL, mSOL
  8, // JLP
  41, 9, 11, 25, // LBTC, xBTC, cbBTC, WBTC
  7, // syrupUSDC
  40, // JUP
  77, 80, 78, 79, // TSLAx, NVDAx, SPYx, QQQx (tokenized equities; off-hours stale by design)
]);

export function isCollateralVaultAllowlisted(vaultId: number): boolean {
  return Number.isInteger(vaultId) && ALLOWED_BORROW_VAULT_IDS.has(vaultId);
}

/**
 * Beta borrow allowlist (Decision Wall #7). OWNER-PENDING: empty until the owner
 * names beta wallets. Combined with the owner wallet below, this is the "who may
 * borrow at all" gate the enforced policy reads.
 */
export const BORROW_BETA_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * BORROW OPEN TO ALL — the owner has launched borrowing publicly. Any connected
 * wallet may use the borrow money path, in EVERY environment (development AND the
 * live production site, myquantumvault.com). The owner made this call deliberately
 * after being shown that the production site is public, so this opens borrowing to
 * any visitor who connects a wallet — not just the owner.
 *
 * IMPORTANT: this removes ONLY the per-WALLET whitelist. Every other money-safety
 * breaker still runs unchanged — oracle freshness, max-LTV cap, health factor,
 * platform exposure caps, and the collateral-VAULT allowlist (ALLOWED_BORROW_VAULT_IDS).
 *
 * To re-close borrowing to a private beta (owner + named wallets only), flip this
 * to false and populate BORROW_BETA_ALLOWLIST and/or the BORROW_OWNER_WALLET env var.
 */
export const BORROW_OPEN_TO_ALL = true;

export function isBorrowOpenToAll(): boolean {
  return BORROW_OPEN_TO_ALL;
}

export function isBorrowAllowlisted(walletAddress: string): boolean {
  // Borrowing is open to every wallet (owner launch decision). When re-closed,
  // this falls back to the explicit beta allowlist.
  if (isBorrowOpenToAll()) return true;
  return typeof walletAddress === "string" && BORROW_BETA_ALLOWLIST.has(walletAddress);
}

/**
 * The owner wallet (Decision Wall #7 first-live gate). OWNER-PENDING: resolved
 * from the optional `BORROW_OWNER_WALLET` env var so it can be set without a code
 * change. Returns null when unset → no wallet is treated as the owner (fail
 * closed: borrowing stays gated until the owner opts in).
 */
export function getBorrowOwnerWallet(): string | null {
  const w = (process.env.BORROW_OWNER_WALLET || "").trim();
  return w.length > 0 ? w : null;
}

export function isBorrowOwnerWallet(walletAddress: string): boolean {
  const owner = getBorrowOwnerWallet();
  return !!owner && typeof walletAddress === "string" && walletAddress === owner;
}

/**
 * The single "may this wallet use the borrow money path?" check the routes gate
 * on. While BORROW_OPEN_TO_ALL is true this returns true for every wallet (owner
 * launch decision). If borrowing is re-closed to a private beta, it reduces to
 * "owner wallet OR beta-allowlisted wallet".
 */
export function isBorrowEligibleWallet(walletAddress: string): boolean {
  return isBorrowOpenToAll() || isBorrowOwnerWallet(walletAddress) || isBorrowAllowlisted(walletAddress);
}
