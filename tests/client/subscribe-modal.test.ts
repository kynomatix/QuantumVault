/**
 * WO-15C.2 + WO-15C.3 — SubscribeBotModal focused regression tests.
 *
 * WO-15C.2 defects (retained coverage):
 *   Defect 4 — Null-truthful affordability: agentBalance=null/non-numeric →
 *     availableBalance null, never zero. Explicit zero stays a valid balance.
 *   Defect 5 — Post-deposit refresh isolation: a refresh timeout/failure after
 *     a confirmed deposit must never surface "USDC Deposit Failed".
 *
 * WO-15C.3 defects:
 *   Defect 1 — Unknown balance must render "Unavailable", never "$0.00";
 *     explicit zero must still render "$0.00"; null keeps actions disabled.
 *   Defect 2 — A confirmed deposit must immediately eliminate the stale
 *     shortfall (optimistic confirmed-state transition) so the deposit action
 *     cannot re-enable for a duplicate submission; both post-deposit
 *     affordability reads must be bounded; a stale refresh read must never
 *     resurrect the shortfall.
 *
 * Per the work order, these tests do NOT recreate a copy of the handler inside
 * the test file. They exercise:
 *   (a) the PRODUCTION helpers the component imports and calls
 *       (normalizeAgentBalance, computeUsdcDeficit, applyConfirmedDeposit,
 *       reconcileRefreshedBalance, fmtBalance), including the full
 *       deficit → confirmed-deposit → reconcile state chain; and
 *   (b) structural assertions on the actual component source
 *       (client/src/components/SubscribeBotModal.tsx) proving the helpers are
 *       wired in, all affordability reads are bounded, the failure toast has
 *       exactly one call site, and no mutation retry/replay exists.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeAgentBalance,
  computeUsdcDeficit,
  applyConfirmedDeposit,
  reconcileRefreshedBalance,
  fmtBalance,
} from '@/lib/equity-display';

const MODAL_SRC = readFileSync(
  fileURLToPath(new URL('../../client/src/components/SubscribeBotModal.tsx', import.meta.url)),
  'utf8',
);

/** The handleUsdcDeposit function body, as it appears in production source. */
const DEPOSIT_HANDLER = (() => {
  const start = MODAL_SRC.indexOf('const handleUsdcDeposit');
  const end = MODAL_SRC.indexOf('const handleMax');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('handleUsdcDeposit boundaries not found in SubscribeBotModal.tsx');
  }
  return MODAL_SRC.slice(start, end);
})();

// ── WO-15C.2 Defect 4: null-truthful affordability (normalizeAgentBalance) ───

describe('normalizeAgentBalance — modal null-truthful affordability (WO-15C.2 Defect 4)', () => {
  it('explicit numeric zero is valid — returns 0, not null', () => {
    expect(normalizeAgentBalance(0)).toBe(0);
  });

  it('positive finite number returned as-is', () => {
    expect(normalizeAgentBalance(500)).toBe(500);
    expect(normalizeAgentBalance(0.01)).toBe(0.01);
  });

  it('null → null (never zero): regression against ?? 0 coercion', () => {
    expect(normalizeAgentBalance(null)).toBeNull();
    expect(normalizeAgentBalance(null)).not.toBe(0);
  });

  it('undefined → null', () => {
    expect(normalizeAgentBalance(undefined)).toBeNull();
  });

  it('string "100" → null (non-numeric server response field)', () => {
    expect(normalizeAgentBalance('100')).toBeNull();
  });

  it('NaN → null (not a finite number)', () => {
    expect(normalizeAgentBalance(NaN)).toBeNull();
  });

  it('Infinity → null (not finite)', () => {
    expect(normalizeAgentBalance(Infinity)).toBeNull();
  });

  it('boolean → null', () => {
    expect(normalizeAgentBalance(true)).toBeNull();
    expect(normalizeAgentBalance(false)).toBeNull();
  });

  it('object → null', () => {
    expect(normalizeAgentBalance({ value: 100 })).toBeNull();
  });
});

// ── WO-15C.3 Defect 1: unknown balance never renders $0.00 ────────────────────

describe('available-balance rendering (WO-15C.3 Defect 1)', () => {
  it('unknown (null) balance renders "Unavailable", not "$0.00"', () => {
    const rendered = fmtBalance(null);
    expect(rendered).toBe('Unavailable');
    expect(rendered).not.toContain('0.00');
  });

  it('explicit zero still renders "$0.00"', () => {
    expect(fmtBalance(0)).toBe('$0.00');
  });

  it('positive balance renders "$X.XX"', () => {
    expect(fmtBalance(1234.5)).toBe('$1234.50');
  });

  it('component wires the "Available in agent wallet" renderer through fmtBalance', () => {
    // Both nullable-balance display sites must go through fmtBalance.
    const fmtCalls = MODAL_SRC.split('fmtBalance(availableBalance)').length - 1;
    expect(fmtCalls).toBeGreaterThanOrEqual(2);
  });

  it('the old null-to-zero display coercions are gone from the component', () => {
    expect(MODAL_SRC).not.toContain("availableBalance?.toFixed(2) ?? '0.00'");
    expect(MODAL_SRC).not.toContain('(availableBalance ?? 0).toFixed');
  });

  it('null balance keeps balance-requiring actions disabled in the component', () => {
    // Subscribe button: disabled while entered capital present and balance unknown.
    expect(MODAL_SRC).toContain('(enteredCapital > 0 && availableBalance === null)');
    // Max button: disabled when balance is null (or zero).
    expect(MODAL_SRC).toContain('disabled={!availableBalance || availableBalance <= 0}');
  });
});

// ── WO-15C.3 Defect 2: confirmed deposit eliminates the stale shortfall ──────

describe('confirmed-deposit shortfall elimination (WO-15C.3 Defect 2)', () => {
  it('full production state chain: deficit → confirmed amount → zero deficit', () => {
    // Exact chain the component executes: computeUsdcDeficit for the CTA,
    // Math.ceil rounding for the tx amount (unchanged production formula),
    // applyConfirmedDeposit on confirmation.
    const entered = 100;
    const prev = 40;
    const deficit = computeUsdcDeficit(entered, prev);
    expect(deficit).toBe(60);
    const amount = Math.ceil(deficit * 100) / 100; // production rounding formula
    const after = applyConfirmedDeposit(prev, amount);
    expect(after).toBe(100);
    // The recomputed deficit is 0 → needsUsdcDeposit false → the deposit CTA
    // cannot re-enable for a duplicate submission.
    expect(computeUsdcDeficit(entered, after)).toBe(0);
  });

  it('ceil-rounded amount always covers a fractional deficit (no residual CTA)', () => {
    const entered = 100;
    const prev = 40.004999; // deficit 59.995001 → amount rounds up to 60.00
    const deficit = computeUsdcDeficit(entered, prev);
    const amount = Math.ceil(deficit * 100) / 100;
    expect(amount).toBeGreaterThanOrEqual(deficit);
    const after = applyConfirmedDeposit(prev, amount);
    expect(after).not.toBeNull();
    expect(computeUsdcDeficit(entered, after)).toBe(0);
  });

  it('unknown previous balance stays unknown after confirmation (never fabricated)', () => {
    expect(applyConfirmedDeposit(null, 60)).toBeNull();
  });

  it('unknown balance surfaces no deficit → no deposit CTA to duplicate', () => {
    expect(computeUsdcDeficit(100, null)).toBe(0);
  });

  it('component applies the optimistic transition inside the success path', () => {
    expect(DEPOSIT_HANDLER).toContain('setAvailableBalance(prev => applyConfirmedDeposit(prev, amount))');
    // It must run before the finally releases anything: it sits in the try
    // block, after depositSucceeded = true.
    const succeededIdx = DEPOSIT_HANDLER.indexOf('depositSucceeded = true');
    const optimisticIdx = DEPOSIT_HANDLER.indexOf('applyConfirmedDeposit(prev, amount)');
    const finallyIdx = DEPOSIT_HANDLER.indexOf('} finally {');
    expect(succeededIdx).toBeGreaterThan(-1);
    expect(optimisticIdx).toBeGreaterThan(succeededIdx);
    expect(finallyIdx).toBeGreaterThan(optimisticIdx);
  });

  it('busy flag stays held through the refresh on success; released only on failure', () => {
    // The deposit-phase finally releases the button ONLY when the deposit failed.
    expect(DEPOSIT_HANDLER).toMatch(/if \(!depositSucceeded\) \{\s*setIsDepositingUsdc\(false\);/);
    // The refresh block has its own finally that releases the button when the
    // bounded reads settle.
    const refreshBlock = DEPOSIT_HANDLER.slice(DEPOSIT_HANDLER.indexOf('if (depositSucceeded) {'));
    expect(refreshBlock).toMatch(/\} finally \{[\s\S]*?setIsDepositingUsdc\(false\);/);
  });
});

// ── WO-15C.3 Defect 2: stale-read guard on the post-deposit refresh ──────────

describe('reconcileRefreshedBalance — stale-read guard (WO-15C.3 Defect 2)', () => {
  it('refresh timeout / absent read keeps the confirmed optimistic value', () => {
    expect(reconcileRefreshedBalance(100, null)).toBe(100);
  });

  it('null previous + null refresh stays null (never fabricates zero)', () => {
    expect(reconcileRefreshedBalance(null, null)).toBeNull();
    expect(reconcileRefreshedBalance(null, null)).not.toBe(0);
  });

  it('a stale LOWER server read cannot resurrect the eliminated shortfall', () => {
    // Deposit confirmed → optimistic 100; a pre-deposit snapshot says 40.
    const reconciled = reconcileRefreshedBalance(100, 40);
    expect(reconciled).toBe(100);
    // The deficit therefore stays 0 — no duplicate-deposit window reopens.
    expect(computeUsdcDeficit(100, reconciled)).toBe(0);
  });

  it('a higher server read is adopted', () => {
    expect(reconcileRefreshedBalance(100, 120)).toBe(120);
  });

  it('an unknown previous balance is established by a successful bounded refresh', () => {
    expect(reconcileRefreshedBalance(null, 55)).toBe(55);
  });

  it('explicit zero refresh over zero previous stays zero (valid balance)', () => {
    expect(reconcileRefreshedBalance(0, 0)).toBe(0);
  });

  it('component wires the refresh result through the guard', () => {
    expect(DEPOSIT_HANDLER).toContain('setAvailableBalance(prev => reconcileRefreshedBalance(prev, refreshed))');
    expect(DEPOSIT_HANDLER).toContain('normalizeAgentBalance(data.agentBalance)');
  });
});

// ── WO-15C.3: bounded affordability reads ─────────────────────────────────────

describe('bounded one-shot affordability reads (WO-15C.3)', () => {
  it('every /api/total-equity and /api/agent/balance fetch in the modal is bounded', () => {
    const lines = MODAL_SRC.split('\n').filter(
      (l) => l.includes("fetch('/api/total-equity'") || l.includes("fetch('/api/agent/balance'"),
    );
    // Modal-open pair + post-SOL-deposit read + post-USDC-deposit pair = 5 sites.
    expect(lines.length).toBe(5);
    for (const line of lines) {
      expect(line).toContain('AbortSignal.timeout');
    }
  });
});

// ── WO-15C.2 Defect 5 / WO-15C.3: mutation-outcome isolation, no retry ────────

describe('deposit mutation isolation and no-retry (WO-15C.2 Defect 5 / WO-15C.3)', () => {
  it('the failure toast has exactly ONE call site — the deposit-phase catch', () => {
    const toastSites = MODAL_SRC.split("title: 'USDC Deposit Failed'").length - 1;
    expect(toastSites).toBe(1);
    // And that site is inside the deposit handler, before the refresh block —
    // a refresh failure structurally cannot reach it.
    const failureIdx = DEPOSIT_HANDLER.indexOf("title: 'USDC Deposit Failed'");
    const refreshIdx = DEPOSIT_HANDLER.indexOf('if (depositSucceeded) {');
    expect(failureIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(failureIdx);
  });

  it('the refresh block swallows its own failures (own catch, no toast inside)', () => {
    const refreshBlock = DEPOSIT_HANDLER.slice(DEPOSIT_HANDLER.indexOf('if (depositSucceeded) {'));
    expect(refreshBlock).toContain('} catch {');
    // No toast CALL site in the refresh block (the string may appear in
    // explanatory comments; only `title: '...'` is an actual call site).
    expect(refreshBlock).not.toContain("title: 'USDC Deposit Failed'");
  });

  it('pre-confirmation failure path is intact: catch toasts and releases the button', () => {
    const catchIdx = DEPOSIT_HANDLER.indexOf('} catch (error: any) {');
    const finallyIdx = DEPOSIT_HANDLER.indexOf('} finally {');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = DEPOSIT_HANDLER.slice(catchIdx, finallyIdx);
    expect(catchBlock).toContain("title: 'USDC Deposit Failed'");
    // Failure leaves depositSucceeded=false → the finally releases the button.
    expect(DEPOSIT_HANDLER).toMatch(/if \(!depositSucceeded\) \{\s*setIsDepositingUsdc\(false\);/);
  });

  it('no mutation retry or replay: exactly one deposit POST, sign, send, confirm', () => {
    expect(DEPOSIT_HANDLER.split("fetch('/api/agent/deposit'").length - 1).toBe(1);
    expect(DEPOSIT_HANDLER.split('signTransaction(').length - 1).toBe(1);
    expect(DEPOSIT_HANDLER.split('sendRawTransaction(').length - 1).toBe(1);
    expect(DEPOSIT_HANDLER.split('confirmTransactionWithFallback(').length - 1).toBe(1);
    // No loop constructs around the mutation.
    expect(DEPOSIT_HANDLER).not.toMatch(/\b(for|while)\s*\(/);
    expect(DEPOSIT_HANDLER.toLowerCase()).not.toContain('retry');
  });

  it('transaction amount formula unchanged (exact production rounding)', () => {
    expect(DEPOSIT_HANDLER).toContain('const amount = Math.ceil(usdcDeficit * 100) / 100;');
  });
});
