/**
 * Pure display helpers for equity and bot financial fields.
 * No React imports — fully testable in Node / vitest without a DOM.
 *
 * IMPORTANT — financialDataStatus vs botFinancialStatus
 * ──────────────────────────────────────────────────────
 * Every helper that takes a status argument expects `financialDataStatus`
 * (the server's freshness verdict: 'fresh' | 'partial' | 'stale' | 'unavailable').
 * Do NOT pass `botFinancialStatus` (the data-source path: 'live' | 'db-only' |
 * 'unavailable') — it overlaps on 'unavailable' but has different semantics and
 * does not include 'fresh', 'partial', or 'stale'.
 *
 * Note: botFinancialStatus CAN be 'unavailable' (e.g. when the exchange read fails
 * completely).  It is NOT the right field for freshness decisions.
 */

import type { EquityDataStatus } from './equity-poller';

// ── Status parsing ────────────────────────────────────────────────────────────

/**
 * Parse and validate the server's `financialDataStatus` field.
 * Recognized values: 'fresh', 'partial', 'stale'.
 * Anything else (null, undefined, unrecognized string) returns null.
 *
 * Use this in fetchFn instead of raw string casts.
 */
export function parseFinancialDataStatus(raw: unknown): EquityDataStatus | null {
  if (raw === 'fresh' || raw === 'partial' || raw === 'stale') return raw;
  return null;
}

/**
 * True when the equity snapshot is degraded and the stale indicator must remain visible.
 * Only an explicit 'fresh' verdict from the server clears the degraded state.
 * 'partial', 'stale', null (missing), and any unrecognized value stay degraded.
 *
 * This is the canonical degraded-state predicate.  Wire all stale-indicator
 * decisions through this function — do not inline `status !== 'fresh'`.
 */
export function isEquityDegraded(status: EquityDataStatus | null): boolean {
  return status !== 'fresh';
}

// ── Observation-time parsing ──────────────────────────────────────────────────

/**
 * Normalize the server's `financialDataObservedAt` field to a numeric epoch-ms value.
 *
 * Wire contract (authoritative): server emits a finite numeric epoch-ms integer.
 * Compatibility path: a valid ISO 8601 string is also accepted and converted.
 * Malformed, non-finite, null, undefined, or any other type → null.
 *
 * Tests MUST use numeric fixtures to verify the real server contract.
 */
export function parseObservedAt(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ── Available-balance arithmetic ──────────────────────────────────────────────

/**
 * Null-safe available balance: only non-null when BOTH components are known.
 * Never coerces an unknown vault to zero — that fabricates a false balance.
 * Explicit zero for either component is valid and participates in the sum.
 */
export function computeAvailableBalance(
  agentBalance: number | null,
  vaultBalance: number | null,
): number | null {
  if (agentBalance === null || vaultBalance === null) return null;
  return agentBalance + vaultBalance;
}

// ── Wallet-transition detection ───────────────────────────────────────────────

/**
 * True when a direct A→B wallet switch is detected.
 * Conditions:
 *  - prev is known (non-null): there was a previous wallet.
 *  - next is defined and non-empty: there is a new wallet identity.
 *  - prev ≠ next: the wallet actually changed.
 *
 * Returns false for:
 *  - First connect (prev null): no prior wallet equity to clear.
 *  - Same-wallet reconnection (prev === next): retain last-known-good values.
 *  - Disconnect (next null/undefined): the disconnect branch handles clearing.
 */
export function isWalletTransition(
  prev: string | null,
  next: string | null | undefined,
): boolean {
  return prev !== null && !!next && prev !== next;
}

// ── Modal affordability helpers ───────────────────────────────────────────────

/**
 * Parse a server `agentBalance` field to a null-truthful numeric value.
 * - Finite numeric value (including 0): returned as-is.
 * - null, undefined, non-numeric, NaN, Infinity: null.
 *
 * Never returns zero for a missing or non-numeric field — that would fabricate
 * a false "you have $0 available" when the server did not report a balance.
 */
export function normalizeAgentBalance(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

// ── Balance formatting ────────────────────────────────────────────────────────

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

// ── Bot financial display helpers ─────────────────────────────────────────────

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
 * True when a bot's financial data is stale or partially populated.
 * Both 'stale' and 'partial' are degraded: known values are shown but the
 * visual stale marker must be present.
 *
 * Note: 'stale'/'partial' ≠ 'unavailable' — stale bots still render numbers.
 *
 * @param financialDataStatus  Pass `bot.financialDataStatus` (freshness verdict).
 */
export function isBotStale(
  financialDataStatus: string | null | undefined,
): boolean {
  return financialDataStatus === 'stale' || financialDataStatus === 'partial';
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
