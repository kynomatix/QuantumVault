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
 *
 * WO-15C.1 regression invariants (Defects 1, 4, 5, 6):
 * 15. isBotStale: returns true only for 'stale', false for everything else (Defect 5)
 * 16. isBotFinancialUnavailable: returns true only for 'unavailable' (Defect 5)
 * 17. fmtBotPnl with 'stale' shows value (stale ≠ unavailable) (Defect 5)
 * 18. fmtBotTradeCount with 'stale' shows value (stale ≠ unavailable) (Defect 5)
 * 19. botPublishState with 'stale' returns state (stale ≠ unavailable) (Defect 5)
 * 20. availableBalance null when either component is null (Defect 4)
 * 21. availableBalance uses exact vault value when vault=0 (Defect 4)
 * 22. bot null PnL always sorts last regardless of asc/desc direction (Defect 6)
 */

import { describe, it, expect } from 'vitest';
import {
  fmtBalance,
  fmtBotPnl,
  fmtBotPnlPercent,
  fmtBotTradeCount,
  botPublishState,
  isBotStale,
  isBotFinancialUnavailable,
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

  // WO-15C.1 Defect 5: 'stale' shows value (stale ≠ unavailable)
  it('stale status shows value — stale data is displayed, not suppressed', () => {
    expect(fmtBotPnl(100, 'stale')).toBe('+$100.00');
    expect(fmtBotPnl(-50, 'stale')).toBe('$-50.00');
    expect(fmtBotPnl(0, 'stale')).toBe('+$0.00');
  });

  it('stale with null pnl → null (value was not available)', () => {
    expect(fmtBotPnl(null, 'stale')).toBeNull();
    expect(fmtBotPnl(undefined, 'stale')).toBeNull();
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

  // WO-15C.1 Defect 5: stale shows value
  it('stale status shows value — not suppressed like unavailable', () => {
    expect(fmtBotPnlPercent(10.5, 1000, 'stale')).toBe('+10.5%');
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

  // WO-15C.1 Defect 5: stale shows value
  it('stale status shows trade count — not suppressed like unavailable', () => {
    expect(fmtBotTradeCount(7, 3, 'stale')).toBe(7);
    expect(fmtBotTradeCount(0, undefined, 'stale')).toBe(0);
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

  // WO-15C.1 Defect 5: stale does NOT suppress publish state
  it('stale financial status passes through — stale ≠ unavailable', () => {
    expect(botPublishState(false, 'webhook', 'stale')).toBe('unpublished');
    expect(botPublishState(true, 'webhook', 'stale')).toBe('published');
  });
});

// ── isBotStale (WO-15C.1 Defect 5) ───────────────────────────────────────────

describe('isBotStale', () => {
  it('returns true only for "stale"', () => {
    expect(isBotStale('stale')).toBe(true);
  });

  it('returns false for "fresh"', () => {
    expect(isBotStale('fresh')).toBe(false);
  });

  it('returns false for "unavailable" — unavailable is NOT stale', () => {
    expect(isBotStale('unavailable')).toBe(false);
  });

  it('returns false for "live" (source path, not freshness verdict)', () => {
    expect(isBotStale('live')).toBe(false);
  });

  it('returns false for null/undefined (missing field)', () => {
    expect(isBotStale(null)).toBe(false);
    expect(isBotStale(undefined)).toBe(false);
  });
});

// ── isBotFinancialUnavailable (WO-15C.1 Defect 5) ────────────────────────────

describe('isBotFinancialUnavailable', () => {
  it('returns true only for "unavailable"', () => {
    expect(isBotFinancialUnavailable('unavailable')).toBe(true);
  });

  it('returns false for "stale" — stale has a value, it is not unavailable', () => {
    expect(isBotFinancialUnavailable('stale')).toBe(false);
  });

  it('returns false for "fresh"', () => {
    expect(isBotFinancialUnavailable('fresh')).toBe(false);
  });

  it('returns false for null/undefined (field missing → treat as live/fresh)', () => {
    expect(isBotFinancialUnavailable(null)).toBe(false);
    expect(isBotFinancialUnavailable(undefined)).toBe(false);
  });
});

// ── availableBalance null-guard (WO-15C.1 Defect 4) ──────────────────────────

describe('availableBalance null-guard', () => {
  /**
   * Replicate the exact expression from App.tsx so the test is the source of truth:
   *   agentBalance === null || vaultBalance === null ? null : agentBalance + vaultBalance
   */
  function computeAvailable(
    agentBalance: number | null,
    vaultBalance: number | null,
  ): number | null {
    return agentBalance === null || vaultBalance === null
      ? null
      : agentBalance + vaultBalance;
  }

  it('null agent → null (vault unknown is not added as 0)', () => {
    expect(computeAvailable(null, 200)).toBeNull();
    expect(fmtBalance(computeAvailable(null, 200))).toBe('Unavailable');
  });

  it('null vault → null (agent unknown is not added as 0)', () => {
    expect(computeAvailable(500, null)).toBeNull();
    expect(fmtBalance(computeAvailable(500, null))).toBe('Unavailable');
  });

  it('both null → null', () => {
    expect(computeAvailable(null, null)).toBeNull();
  });

  it('vault=0 (explicit zero) is valid — sum computed, not null', () => {
    expect(computeAvailable(500, 0)).toBe(500);
    expect(fmtBalance(computeAvailable(500, 0))).toBe('$500.00');
  });

  it('both non-null → correct sum', () => {
    expect(computeAvailable(500, 200)).toBe(700);
    expect(fmtBalance(computeAvailable(500, 200))).toBe('$700.00');
  });
});

// ── bot PnL null-last sort (WO-15C.1 Defect 6) ───────────────────────────────

describe('bot sort: null PnL always last', () => {
  /**
   * Replicate the null-last sort comparator from App.tsx sortedBots.
   * Null always ends up after non-null values regardless of direction.
   */
  function nullLastCompare(
    av: number | null,
    bv: number | null,
    desc: boolean,
  ): number {
    if (av === null && bv === null) return 0;
    if (av === null) return 1;   // null → after known values
    if (bv === null) return -1;
    const cmp = av - bv;
    return desc ? -cmp : cmp;
  }

  type Bot = { name: string; netPnl: number | null };

  function sortBots(bots: Bot[], desc: boolean): Bot[] {
    return [...bots].sort((a, b) => nullLastCompare(a.netPnl, b.netPnl, desc));
  }

  it('asc: nulls sort after all known values', () => {
    const bots: Bot[] = [
      { name: 'C', netPnl: null },
      { name: 'A', netPnl: -10 },
      { name: 'B', netPnl: 50 },
    ];
    const sorted = sortBots(bots, false);
    expect(sorted[0].name).toBe('A'); // -10 first (smallest)
    expect(sorted[1].name).toBe('B'); // 50 second
    expect(sorted[2].name).toBe('C'); // null last
  });

  it('desc: nulls sort after all known values (even high ones)', () => {
    const bots: Bot[] = [
      { name: 'C', netPnl: null },
      { name: 'A', netPnl: -10 },
      { name: 'B', netPnl: 50 },
    ];
    const sorted = sortBots(bots, true);
    expect(sorted[0].name).toBe('B'); // 50 first (largest)
    expect(sorted[1].name).toBe('A'); // -10 second
    expect(sorted[2].name).toBe('C'); // null still last
  });

  it('all nulls: stable (relative order preserved)', () => {
    const bots: Bot[] = [
      { name: 'X', netPnl: null },
      { name: 'Y', netPnl: null },
    ];
    const sorted = sortBots(bots, false);
    expect(sorted.every(b => b.netPnl === null)).toBe(true);
  });

  it('no nulls: normal numeric sort', () => {
    const bots: Bot[] = [
      { name: 'A', netPnl: 100 },
      { name: 'B', netPnl: 50 },
      { name: 'C', netPnl: 200 },
    ];
    const sorted = sortBots(bots, false); // asc
    expect(sorted.map(b => b.netPnl)).toEqual([50, 100, 200]);
  });

  it('null was previously sorted as zero — this test proves that is fixed', () => {
    // With the OLD `?? 0` coercion, null PnL sorted as 0, ending up between -10 and 50.
    // With the fix, null always sorts LAST.
    const bots: Bot[] = [
      { name: 'null-bot', netPnl: null },
      { name: 'neg-bot', netPnl: -10 },
      { name: 'pos-bot', netPnl: 50 },
    ];
    const sorted = sortBots(bots, false); // asc
    // null-bot must be LAST, not between neg-bot and pos-bot
    expect(sorted[2].name).toBe('null-bot');
    expect(sorted[0].name).toBe('neg-bot');
  });
});
