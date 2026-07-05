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
  1, 15, 49, // SOL, JitoSOL, mSOL
  13, // JupSOL (stakePool+Chainlink composite; Pyth SOL/USD used as freshness proxy)
  63, // dfdvSOL — DeFi Development Corp Staked SOL (same oracle type as JupSOL)
  8, // JLP
  41, 9, 11, 25, // LBTC, xBTC, cbBTC, WBTC
  7, // syrupUSDC
  40, // JUP
  77, 80, 78, 79, // TSLAx, NVDAx, SPYx, QQQx (tokenized equities; off-hours stale by design)
  // NOT added: 45 (PST / PayFi Strategy Token — Pyth feed address unresolved to a
  //   verifiable hex feedId); 68 (jlJUPUSD — uses jupLend oracle type, unsupported
  //   by current registry; also an unusual Lend receipt token collateral).
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

/**
 * SOL LOOP VAULT OPEN TO ALL — the owner has opened the SOL Loop Vault (the
 * leveraged LST staking loop on Jupiter Lend Multiply) publicly to test it in the
 * live production environment from any connected wallet, in EVERY environment.
 *
 * This is a SEPARATE gate from BORROW_OPEN_TO_ALL on purpose: the loop was kept
 * owner-only after the account/per-bot borrow engines launched publicly, because
 * it is the first novel vault. The owner has now chosen to open it to all wallets.
 *
 * IMPORTANT: this removes ONLY the per-WALLET owner gate. Every other money-safety
 * breaker still runs unchanged — carry/rate gating, dynamic-leverage caps, the
 * health-factor deleverage reflex, oracle freshness, and the vault allowlist.
 *
 * To re-close the loop to owner-only, flip this to false (the gate then resolves
 * from the BORROW_OWNER_WALLET env var via isBorrowOwnerWallet, as before).
 */
export const LOOP_OPEN_TO_ALL = true;

export function isLoopOpenToAll(): boolean {
  return LOOP_OPEN_TO_ALL;
}

/**
 * The single "may this wallet use the SOL Loop Vault?" check the loop routes gate
 * on. While LOOP_OPEN_TO_ALL is true this returns true for every wallet. If the
 * loop is re-closed, it reduces to "owner wallet only".
 */
export function isLoopEligibleWallet(walletAddress: string): boolean {
  return isLoopOpenToAll() || isBorrowOwnerWallet(walletAddress);
}
