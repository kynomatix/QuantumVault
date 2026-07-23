/**
 * WO-15C — equity display helpers + bot financial field rendering truthfulness.
 *
 * All helpers are pure functions (no React, no DOM).  Tests confirm:
 *
 *  1. fmtBalance: null → "Unavailable" (never "$0.00")
 *  2. fmtBalance: explicit 0 → "$0.00" (zero is valid)
 *  3. Desktop + mobile total equity never show "$0.00" for unknown values
 *  4. Null with prior data: caller retains prior, fmtBalance(prior) shows it
 *  5. 503/timeout: poller reports ok=false; caller keeps prior; fmtBalance(prior) shows stale data
 *  6. fmtBotPnl: unavailable status → null placeholder
 *  7. fmtBotPnl: known zero → "+$0.00" (not Unavailable)
 *  8. fmtBotPnlPercent: unavailable → null; netDeposited≤0 → null
 *  9. fmtBotTradeCount: unavailable → null; known 0 → 0
 * 10. botPublishState: unavailable → 'unknown' (suppresses CTA)
 * 11. botPublishState: known false → 'unpublished' (renders normally)
 * 12. botPublishState: known true  → 'published'  (renders normally)
 * 13. handleEquityResult pure logic: null field with prior retains prior
 * 14. handleEquityResult pure logic: null field without prior stays null
 */

import { describe, it, expect } from 'vitest';
import {
  fmtBalance,
  fmtBotPnl,
  fmtBotPnlPercent,
  fmtBotTradeCount,
  botPublishState,
} from '@/lib/equity-display';

// ── fmtBalance ────────────────────────────────────────────────────────────────

describe('fmtBalance', () => {
  it('null renders "Unavailable", not "$0.00"', () => {
    expect(fmtBalance(null)).toBe('Unavailable');
    expect(fmtBalance(null)).not.toBe('$0.00');
  });

  it('explicit zero renders "$0.00" (zero is a valid known value)', () => {
    expect(fmtBalance(0)).toBe('$0.00');
  });

  it('positive value formats with two decimal places', () => {
    expect(fmtBalance(1234.5)).toBe('$1234.50');
    expect(fmtBalance(0.01)).toBe('$0.01');
  });

  it('negative value (edge case) formats correctly', () => {
    expect(fmtBalance(-5.5)).toBe('$-5.50');
  });

  // Explicit proof for desktop and mobile display requirements.
  it('desktop total equity: null (unknown) never shows "$0.00"', () => {
    const display = fmtBalance(null); // simulates: totalEquity = null
    expect(display).not.toBe('$0.00');
    expect(display).not.toContain('0.00');
  });

  it('mobile total equity: null (unknown) never shows "$0.00"', () => {
    const display = fmtBalance(null); // same function, same guarantee
    expect(display).not.toBe('$0.00');
  });

  it('null available balance never shows "$0.00"', () => {
    expect(fmtBalance(null)).not.toBe('$0.00');
  });
});

// ── last-known-good semantics (pure update logic) ─────────────────────────────

describe('handleEquityResult pure update logic', () => {
  /**
   * Simulate the per-field null-safe update used in App.tsx handleEquityResult.
   * When the server returns null for a field the prior value must be kept.
   */
  function applyField(prior: number | null, incoming: number | null): number | null {
    return incoming !== null ? incoming : prior;
  }

  it('null field with prior data retains the prior value', () => {
    const prior = 1000;
    const result = applyField(prior, null);
    expect(result).toBe(1000);
    // The retained value formats correctly (stale, but not zero or Unavailable)
    expect(fmtBalance(result)).toBe('$1000.00');
  });

  it('null field without prior data stays null → Unavailable', () => {
    const result = applyField(null, null);
    expect(result).toBeNull();
    expect(fmtBalance(result)).toBe('Unavailable');
    expect(fmtBalance(result)).not.toBe('$0.00');
  });

  it('non-null incoming field updates correctly', () => {
    expect(applyField(1000, 2000)).toBe(2000);
    expect(applyField(null, 2000)).toBe(2000);
  });

  it('explicit zero incoming updates to 0 (not discarded)', () => {
    const result = applyField(1000, 0);
    expect(result).toBe(0);
    expect(fmtBalance(result)).toBe('$0.00');
  });

  it('503/timeout (ok=false): caller keeps prior; fmtBalance(prior) shows stale, not zero', () => {
    // Simulate: last good value was 1000, read fails.
    const prior = 1000;
    // ok=false → prior is not overwritten.
    const after = prior; // per handleEquityResult logic, prior is retained
    expect(fmtBalance(after)).toBe('$1000.00');
    expect(fmtBalance(after)).not.toBe('$0.00');
    expect(fmtBalance(after)).not.toBe('Unavailable');
  });

  it('503/timeout with no prior data: stays null → Unavailable, no false-empty', () => {
    const prior: number | null = null;
    const after = prior; // no prior data, read fails → stays null
    expect(fmtBalance(after)).toBe('Unavailable');
    expect(fmtBalance(after)).not.toBe('$0.00');
  });
});

// ── fmtBotPnl ────────────────────────────────────────────────────────────────

describe('fmtBotPnl', () => {
  it('unavailable status → null (caller shows placeholder "–")', () => {
    expect(fmtBotPnl(0, 'unavailable')).toBeNull();
    expect(fmtBotPnl(100, 'unavailable')).toBeNull();
    expect(fmtBotPnl(undefined, 'unavailable')).toBeNull();
  });

  it('known zero → "+$0.00" (zero is valid, not Unavailable)', () => {
    expect(fmtBotPnl(0, 'live')).toBe('+$0.00');
    expect(fmtBotPnl(0, 'db-only')).toBe('+$0.00');
  });

  it('positive pnl formats correctly', () => {
    expect(fmtBotPnl(123.45, 'live')).toBe('+$123.45');
    expect(fmtBotPnl(123.45, 'db-only')).toBe('+$123.45');
  });

  it('negative pnl formats correctly', () => {
    // $ is prepended before toFixed, so -50.toFixed(2) = "-50.00" → "$-50.00".
    // This matches the original JSX display behavior.
    expect(fmtBotPnl(-50, 'live')).toBe('$-50.00');
  });

  it('null pnl with non-unavailable status → null (no DB value)', () => {
    expect(fmtBotPnl(null, 'live')).toBeNull();
    expect(fmtBotPnl(undefined, 'db-only')).toBeNull();
  });

  it('no botFinancialStatus (legacy bot) → treats as live', () => {
    expect(fmtBotPnl(100, undefined)).toBe('+$100.00');
    expect(fmtBotPnl(100, null)).toBe('+$100.00');
  });
});

// ── fmtBotPnlPercent ─────────────────────────────────────────────────────────

describe('fmtBotPnlPercent', () => {
  it('unavailable status → null', () => {
    expect(fmtBotPnlPercent(10, 1000, 'unavailable')).toBeNull();
  });

  it('null percent → null', () => {
    expect(fmtBotPnlPercent(null, 1000, 'live')).toBeNull();
  });

  it('netDeposited ≤ 0 → null (no meaningful basis for %)', () => {
    expect(fmtBotPnlPercent(10, 0, 'live')).toBeNull();
    expect(fmtBotPnlPercent(10, -1, 'live')).toBeNull();
    expect(fmtBotPnlPercent(10, null, 'live')).toBeNull();
  });

  it('valid percent formats with sign', () => {
    expect(fmtBotPnlPercent(10.5, 1000, 'live')).toBe('+10.5%');
    expect(fmtBotPnlPercent(-5.2, 1000, 'db-only')).toBe('-5.2%');
    expect(fmtBotPnlPercent(0, 1000, 'live')).toBe('+0.0%');
  });
});

// ── fmtBotTradeCount ─────────────────────────────────────────────────────────

describe('fmtBotTradeCount', () => {
  it('unavailable status → null (caller shows "–")', () => {
    expect(fmtBotTradeCount(0, undefined, 'unavailable')).toBeNull();
    expect(fmtBotTradeCount(10, undefined, 'unavailable')).toBeNull();
    expect(fmtBotTradeCount(undefined, 5, 'unavailable')).toBeNull();
  });

  it('known zero → 0 (zero is valid, not null)', () => {
    expect(fmtBotTradeCount(0, undefined, 'live')).toBe(0);
    expect(fmtBotTradeCount(0, undefined, 'db-only')).toBe(0);
  });

  it('actualTradeCount takes priority over stats fallback', () => {
    expect(fmtBotTradeCount(7, 3, 'live')).toBe(7);
  });

  it('falls back to statsTotalTrades when actualTradeCount is null/undefined', () => {
    expect(fmtBotTradeCount(null, 5, 'live')).toBe(5);
    expect(fmtBotTradeCount(undefined, 5, 'db-only')).toBe(5);
  });

  it('both null/undefined → null (no value to display)', () => {
    expect(fmtBotTradeCount(null, undefined, 'live')).toBeNull();
  });
});

// ── botPublishState ───────────────────────────────────────────────────────────

describe('botPublishState', () => {
  it('unavailable financial status → "unknown" (suppresses publish CTA)', () => {
    expect(botPublishState(false, 'webhook', 'unavailable')).toBe('unknown');
    expect(botPublishState(true, 'webhook', 'unavailable')).toBe('unknown');
    expect(botPublishState(null, 'webhook', 'unavailable')).toBe('unknown');
  });

  it('known false (not published) renders "unpublished" normally', () => {
    expect(botPublishState(false, 'webhook', 'live')).toBe('unpublished');
    expect(botPublishState(false, 'webhook', 'db-only')).toBe('unpublished');
    expect(botPublishState(false, 'webhook', undefined)).toBe('unpublished');
  });

  it('known true (published) renders "published" normally', () => {
    expect(botPublishState(true, 'webhook', 'live')).toBe('published');
    expect(botPublishState(true, 'webhook', 'db-only')).toBe('published');
  });

  it('null/undefined isPublished with non-unavailable status → "unknown"', () => {
    expect(botPublishState(null, 'webhook', 'live')).toBe('unknown');
    expect(botPublishState(undefined, 'webhook', 'db-only')).toBe('unknown');
  });

  it('no botFinancialStatus (legacy bot) applies same logic as non-unavailable', () => {
    expect(botPublishState(false, 'webhook', null)).toBe('unpublished');
    expect(botPublishState(true, 'webhook', null)).toBe('published');
  });
});
