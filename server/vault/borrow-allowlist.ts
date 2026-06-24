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
 * Launch collateral allowlist (Decision Wall #5), by Jupiter Lend vault id.
 *   - 43 = INF → USDC (verified Phase A/B on mainnet, 2026-06-24).
 * Owner adds vault ids here to widen the launch collateral set.
 */
export const ALLOWED_BORROW_VAULT_IDS: ReadonlySet<number> = new Set<number>([43]);

export function isCollateralVaultAllowlisted(vaultId: number): boolean {
  return Number.isInteger(vaultId) && ALLOWED_BORROW_VAULT_IDS.has(vaultId);
}

/**
 * Beta borrow allowlist (Decision Wall #7). OWNER-PENDING: empty until the owner
 * names beta wallets. Combined with the owner wallet below, this is the "who may
 * borrow at all" gate the enforced policy reads.
 */
export const BORROW_BETA_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

export function isBorrowAllowlisted(walletAddress: string): boolean {
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
