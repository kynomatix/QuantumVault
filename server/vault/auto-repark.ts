// Auto-repark idle funds — scheduling layer (storage-only, NO keys).
//
// When a bot with the persistent `autoParkIdle` setting ON fully closes its
// position, we arm a short debounce deadline (`auto_park_due_at`) instead of
// parking immediately — a webhook close is very often followed milliseconds
// later by a fresh open (flip), and parking into that gap would just be undone
// by the open-path auto-unpark. A new open CLEARS the deadline. A periodic
// scanner (in routes.ts, where the agent keys live) claims every elapsed
// deadline, re-verifies the bot is still flat on-chain, and parks.
//
// Venue gate: per-bot park is only clean on Flash isolated wallets. Pacifica is
// account-level with a $10 min + $1 fee, so it stays manual — never auto-reparked.
//
// This module deliberately holds NO key material and performs NO on-chain work;
// it is safe to import from the reconciliation service (which runs without an
// interactive UMK). The actual park executor lives next to the agent-key helpers.

import { storage } from "../storage";
import type { TradingBot } from "@shared/schema";

/** Debounce window between a full close and the repark attempt. */
export const AUTO_REPARK_DEBOUNCE_MS = 60_000;

/**
 * Per-bot auto-repark is only safe on independent-trader venues whose spare USDC
 * lives in the bot's OWN isolated wallet (Flash). Pacifica is account-level and
 * fee'd, so it is intentionally excluded.
 */
export function isAutoReparkEligibleVenue(
  bot: Pick<TradingBot, "activeProtocol">,
): boolean {
  return bot.activeProtocol === "flash";
}

/**
 * Called when a position has FULLY closed. Arms the debounce deadline if (and
 * only if) the bot opted into auto-repark and is on an eligible venue. Idempotent
 * and re-arms to the later deadline under a double-close race.
 */
export async function maybeScheduleAutoRepark(
  bot: Pick<TradingBot, "id" | "autoParkIdle" | "activeProtocol">,
): Promise<void> {
  if (!bot.autoParkIdle) return;
  if (!isAutoReparkEligibleVenue(bot)) return;
  const dueAt = new Date(Date.now() + AUTO_REPARK_DEBOUNCE_MS);
  try {
    await storage.scheduleBotAutoParkDueAt(bot.id, dueAt);
  } catch (err) {
    // Best-effort scheduling — never let it break the close path.
    console.warn(`[AutoRepark ${bot.id.slice(0, 8)}] failed to arm debounce`, err);
  }
}

/**
 * Called when a NEW position opens (or a position remains open after a sync).
 * Cancels any pending repark so we never park funds the bot is about to trade.
 * No-op write when nothing is pending.
 */
export async function cancelAutoRepark(botId: string): Promise<void> {
  try {
    await storage.clearBotAutoParkDueAt(botId);
  } catch (err) {
    console.warn(`[AutoRepark ${botId.slice(0, 8)}] failed to cancel debounce`, err);
  }
}
