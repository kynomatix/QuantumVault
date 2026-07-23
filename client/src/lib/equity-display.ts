/**
 * Pure display helpers for equity and bot financial fields.
 * No React imports — fully testable in Node / vitest without a DOM.
 */

/**
 * Format a nullable equity balance.
 * - null  → "Unavailable"  (never "$0.00" for an unknown value)
 * - 0     → "$0.00"        (explicit zero is valid, render it normally)
 * - n > 0 → "$X.XX"
 */
export function fmtBalance(v: number | null): string {
  if (v === null) return 'Unavailable';
  return `$${v.toFixed(2)}`;
}

/**
 * Format a bot's net PnL for display.
 * Returns null when the value is genuinely unknown (caller should show '–').
 * Known zero is returned as "+$0.00".
 */
export function fmtBotPnl(
  netPnl: number | null | undefined,
  botFinancialStatus?: string | null,
): string | null {
  if (botFinancialStatus === 'unavailable') return null;
  const v = netPnl ?? null;
  if (v === null) return null;
  return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
}

/**
 * Format a bot's net PnL percentage.
 * Returns null when unavailable or when netDeposited ≤ 0 (no basis to show %).
 */
export function fmtBotPnlPercent(
  netPnlPercent: number | null | undefined,
  netDeposited: number | null | undefined,
  botFinancialStatus?: string | null,
): string | null {
  if (botFinancialStatus === 'unavailable') return null;
  const pct = netPnlPercent ?? null;
  const dep = netDeposited ?? null;
  if (pct === null || dep === null || dep <= 0) return null;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * Format a bot's trade count.
 * Returns null when the value is genuinely unknown (caller should show '–').
 * Known zero is returned as the number 0.
 */
export function fmtBotTradeCount(
  actualTradeCount: number | null | undefined,
  statsTotalTrades: number | undefined,
  botFinancialStatus?: string | null,
): number | null {
  if (botFinancialStatus === 'unavailable') return null;
  const v = actualTradeCount ?? statsTotalTrades ?? null;
  return v;
}

/**
 * Resolve a bot's publication state for rendering.
 *
 * Returns:
 *  'published'   — known true, show "Published" badge
 *  'unpublished' — known false and bot can be published, show CTA
 *  'unknown'     — financial status unavailable, suppress both CTA and badge
 *
 * Grid bots cannot be published so they always resolve to 'unpublished'
 * (which the caller should suppress the CTA for, as the botType guard already does).
 */
export function botPublishState(
  isPublished: boolean | null | undefined,
  botType: string | null | undefined,
  botFinancialStatus?: string | null,
): 'published' | 'unpublished' | 'unknown' {
  if (botFinancialStatus === 'unavailable') return 'unknown';
  if (isPublished === null || isPublished === undefined) return 'unknown';
  return isPublished ? 'published' : 'unpublished';
}

/**
 * True when a bot's snapshot data is unavailable (not merely db-only or live).
 * When true, numeric financial fields must not be rendered as zero or false.
 */
export function isBotFinancialUnavailable(
  bot: { botFinancialStatus?: string | null },
): boolean {
  return bot.botFinancialStatus === 'unavailable';
}
