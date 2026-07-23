/**
 * Pure display helpers for equity and bot financial fields.
 * No React imports — fully testable in Node / vitest without a DOM.
 *
 * IMPORTANT — financialDataStatus vs botFinancialStatus
 * ──────────────────────────────────────────────────────
 * Every helper that takes a status argument expects `financialDataStatus`
 * (the server's freshness verdict: 'fresh' | 'stale' | 'unavailable').
 * Do NOT pass `botFinancialStatus` (the data-source path: 'live' | 'db-only') —
 * that field is never 'unavailable' and will silently disable suppression.
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
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict),
 *                             NOT `bot.botFinancialStatus` (source path).
 */
export function fmtBotPnl(
  netPnl: number | null | undefined,
  financialDataStatus?: string | null,
): string | null {
  if (financialDataStatus === 'unavailable') return null;
  const v = netPnl ?? null;
  if (v === null) return null;
  return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
}

/**
 * Format a bot's net PnL percentage.
 * Returns null when unavailable or when netDeposited ≤ 0 (no basis to show %).
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict).
 */
export function fmtBotPnlPercent(
  netPnlPercent: number | null | undefined,
  netDeposited: number | null | undefined,
  financialDataStatus?: string | null,
): string | null {
  if (financialDataStatus === 'unavailable') return null;
  const pct = netPnlPercent ?? null;
  const dep = netDeposited ?? null;
  if (pct === null || dep === null || dep <= 0) return null;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * Format a bot's trade count.
 * Returns null when the value is genuinely unknown (caller should show '–').
 * Known zero is returned as 0.
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict).
 */
export function fmtBotTradeCount(
  actualTradeCount: number | null | undefined,
  statsTotalTrades: number | undefined,
  financialDataStatus?: string | null,
): number | null {
  if (financialDataStatus === 'unavailable') return null;
  const v = actualTradeCount ?? statsTotalTrades ?? null;
  return v;
}

/**
 * Resolve a bot's publication state for rendering.
 *
 * Returns:
 *  'published'   — known true, show "Published" badge
 *  'unpublished' — known false, show publish CTA (caller applies botType guard)
 *  'unknown'     — financialDataStatus is unavailable, suppress both CTA and badge
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict).
 */
export function botPublishState(
  isPublished: boolean | null | undefined,
  botType: string | null | undefined,
  financialDataStatus?: string | null,
): 'published' | 'unpublished' | 'unknown' {
  if (financialDataStatus === 'unavailable') return 'unknown';
  if (isPublished === null || isPublished === undefined) return 'unknown';
  return isPublished ? 'published' : 'unpublished';
}

/**
 * True when a bot's financial data is reported stale by the server.
 * Stale bots should retain known values but must show an explicit visual marker.
 * Note: 'stale' ≠ 'unavailable' — stale bots still render their numbers.
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict).
 */
export function isBotStale(
  financialDataStatus: string | null | undefined,
): boolean {
  return financialDataStatus === 'stale';
}

/**
 * True when a bot's snapshot data is unavailable (not merely stale or db-only).
 * When true, numeric financial fields must not be rendered as zero or false.
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict).
 */
export function isBotFinancialUnavailable(
  financialDataStatus: string | null | undefined,
): boolean {
  return financialDataStatus === 'unavailable';
}
