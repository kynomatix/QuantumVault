import { createHash } from "crypto";

/**
 * Vault position scoping.
 *
 * A `vault_positions` row is scoped either to the shared account wallet
 * (`tradingBotId == null`) or to a single bot's own wallet (a Flash per-bot
 * wallet). Account and per-bot rows for the same wallet+asset must never
 * collide: they are separate balances on separate on-chain wallets.
 */

/**
 * Stable, unambiguous Postgres advisory-lock key (32-bit signed) for a
 * (wallet, scope, asset) tuple. A JSON array keeps `null` (account scope)
 * distinct from any bot id, so account and per-bot rows never share a lock
 * slot. `null` and `undefined` both mean account scope and hash identically.
 */
export function vaultLockKey(
  walletAddress: string,
  tradingBotId: string | null | undefined,
  assetKey: string,
): number {
  return createHash("sha1")
    .update(JSON.stringify([walletAddress, tradingBotId ?? null, assetKey]))
    .digest()
    .readInt32BE(0);
}
