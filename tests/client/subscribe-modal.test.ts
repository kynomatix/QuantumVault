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
  normalizeSolRequirement,
  applyConfirmedSolDeposit,
  reconcileRefreshedSolRequirement,
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

/** The handleSolDeposit function body, as it appears in production source. */
const SOL_HANDLER = (() => {
  const start = MODAL_SRC.indexOf('const handleSolDeposit');
  const end = MODAL_SRC.indexOf('const handleUsdcDeposit');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('handleSolDeposit boundaries not found in SubscribeBotModal.tsx');
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

// ═══════════════════════════════════════════════════════════════════════════════
// WO-15C.4 — Isolate confirmed SOL deposits from read-only refresh failures
// ═══════════════════════════════════════════════════════════════════════════════

// ── WO-15C.4 tests 1–3: confirmed-SOL-deposit optimistic transition ──────────

describe('applyConfirmedSolDeposit — confirmed deposit eliminates the deficit (WO-15C.4 #1–3)', () => {
  it('#1 a confirmed deposit of the exact deficit immediately eliminates it', () => {
    const prev = normalizeSolRequirement({ required: 0.025, current: 0.01 });
    expect(prev).not.toBeNull();
    expect(prev!.deficit).toBeCloseTo(0.015, 12);
    expect(prev!.canCreate).toBe(false);
    // Production flow: amount = solRequirement.deficit, then the optimistic apply.
    const after = applyConfirmedSolDeposit(prev, prev!.deficit);
    expect(after).not.toBeNull();
    expect(after!.deficit).toBe(0);
    expect(after!.canCreate).toBe(true);
  });

  it('#2 explicit zero previous balance is valid and participates in the sum', () => {
    const prev = normalizeSolRequirement({ required: 0.025, current: 0 });
    expect(prev).not.toBeNull();
    expect(prev!.deficit).toBe(0.025);
    const after = applyConfirmedSolDeposit(prev, 0.025);
    expect(after!.current).toBe(0.025);
    expect(after!.deficit).toBe(0);
    expect(after!.canCreate).toBe(true);
  });

  it('#2 fractional SOL amounts are handled without float-dust deficit residue', () => {
    // Binary-float hostile values: current + deficit must land within the
    // sub-lamport epsilon of required, and the residual must NOT keep the CTA.
    const prev = normalizeSolRequirement({ required: 0.02, current: 0.005 });
    const after = applyConfirmedSolDeposit(prev, prev!.deficit);
    expect(after!.deficit).toBe(0);
    expect(after!.canCreate).toBe(true);
  });

  it('#2 a zero-amount confirmation is valid and does not advance the balance', () => {
    const prev = normalizeSolRequirement({ required: 0.025, current: 0.01 });
    const after = applyConfirmedSolDeposit(prev, 0);
    expect(after!.current).toBe(0.01);
    expect(after!.deficit).toBeCloseTo(0.015, 12);
    expect(after!.canCreate).toBe(false);
  });

  it('#3 missing previous state does not fabricate a balance', () => {
    expect(applyConfirmedSolDeposit(null, 0.025)).toBeNull();
  });

  it('#3 malformed previous state fails safe to null', () => {
    expect(applyConfirmedSolDeposit({ required: NaN, current: 0.01, deficit: 0, canCreate: false }, 0.02)).toBeNull();
    expect(applyConfirmedSolDeposit({ required: 0.025, current: Infinity, deficit: 0, canCreate: false }, 0.02)).toBeNull();
    expect(applyConfirmedSolDeposit({ required: -1, current: 0.01, deficit: 0, canCreate: false }, 0.02)).toBeNull();
    expect(applyConfirmedSolDeposit(normalizeSolRequirement('nonsense'), 0.02)).toBeNull();
  });

  it('#3 malformed confirmed amount never advances the balance (fail safe)', () => {
    const prev = normalizeSolRequirement({ required: 0.025, current: 0.01 });
    for (const bad of [NaN, Infinity, -0.01]) {
      const after = applyConfirmedSolDeposit(prev, bad);
      expect(after).not.toBeNull();
      expect(after!.current).toBe(0.01);
      expect(after!.canCreate).toBe(false);
    }
  });

  it('derived fields are recomputed, never trusted from the input', () => {
    // Input claims canCreate=true with an outstanding deficit — recomputation wins.
    const lying = { required: 0.025, current: 0.01, deficit: 0, canCreate: true };
    const normalized = normalizeSolRequirement(lying);
    expect(normalized!.deficit).toBeCloseTo(0.015, 12);
    expect(normalized!.canCreate).toBe(false);
  });
});

// ── WO-15C.4 tests 4–5: stale-refresh reconciliation ─────────────────────────

describe('reconcileRefreshedSolRequirement — stale-read guard (WO-15C.4 #4–5)', () => {
  const confirmed = applyConfirmedSolDeposit(
    normalizeSolRequirement({ required: 0.025, current: 0.01 }),
    0.015,
  );

  it('#4 a stale LOWER refresh cannot resurrect the eliminated deficit', () => {
    // Server snapshot predates the deposit: still reports current=0.01.
    const reconciled = reconcileRefreshedSolRequirement(confirmed, {
      required: 0.025, current: 0.01, deficit: 0.015, canCreate: false,
    });
    expect(reconciled!.current).toBeCloseTo(0.025, 12);
    expect(reconciled!.deficit).toBe(0);
    expect(reconciled!.canCreate).toBe(true);
  });

  it('#4 stale derived fields (deficit/canCreate) from the wire are ignored', () => {
    // Even a self-consistent stale snapshot cannot re-open the CTA because
    // current is reconciled by max() and the derived fields are recomputed.
    const reconciled = reconcileRefreshedSolRequirement(confirmed, {
      required: 0.025, current: 0, deficit: 0.025, canCreate: false,
    });
    expect(reconciled!.deficit).toBe(0);
    expect(reconciled!.canCreate).toBe(true);
  });

  it('#5 a genuinely higher refreshed balance is adopted', () => {
    const reconciled = reconcileRefreshedSolRequirement(confirmed, {
      required: 0.025, current: 0.05, deficit: 0, canCreate: true,
    });
    expect(reconciled!.current).toBe(0.05);
    expect(reconciled!.canCreate).toBe(true);
  });

  it('a missing/malformed refresh payload keeps the confirmed state', () => {
    expect(reconcileRefreshedSolRequirement(confirmed, undefined)).toEqual(confirmed);
    expect(reconcileRefreshedSolRequirement(confirmed, null)).toEqual(confirmed);
    expect(reconcileRefreshedSolRequirement(confirmed, { required: 'x', current: 0.01 })).toEqual(confirmed);
    expect(reconcileRefreshedSolRequirement(confirmed, { required: 0.025, current: NaN })).toEqual(confirmed);
  });

  it('null previous state is established by a valid refresh (recomputed)', () => {
    const reconciled = reconcileRefreshedSolRequirement(null, {
      required: 0.025, current: 0.03, deficit: 99, canCreate: false,
    });
    expect(reconciled!.current).toBe(0.03);
    expect(reconciled!.deficit).toBe(0);
    expect(reconciled!.canCreate).toBe(true);
  });

  it('null previous + malformed refresh stays null (never fabricates)', () => {
    expect(reconcileRefreshedSolRequirement(null, undefined)).toBeNull();
    expect(reconcileRefreshedSolRequirement(null, { junk: true })).toBeNull();
  });

  it('a changed (raised) requirement from the server is honored', () => {
    // required is server-authoritative; only `current` gets the monotonic guard.
    const reconciled = reconcileRefreshedSolRequirement(confirmed, {
      required: 0.05, current: 0.025, deficit: 0.025, canCreate: false,
    });
    expect(reconciled!.required).toBe(0.05);
    expect(reconciled!.current).toBeCloseTo(0.025, 12);
    expect(reconciled!.canCreate).toBe(false);
  });
});

// ── WO-15C.4 tests 6–8: notification reachability (structural) ───────────────

describe('SOL deposit — refresh failures cannot reach the failure toast (WO-15C.4 #6–8)', () => {
  it('#6/#7 the post-confirmation refresh lives OUTSIDE the transaction try/catch', () => {
    // The refresh block starts after the transaction-phase finally closes.
    const refreshIdx = SOL_HANDLER.indexOf('if (solDepositSucceeded) {');
    const txCatchIdx = SOL_HANDLER.indexOf('} catch (error: any) {');
    const txFinallyIdx = SOL_HANDLER.indexOf('} finally {');
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(txCatchIdx).toBeGreaterThan(-1);
    expect(txFinallyIdx).toBeGreaterThan(txCatchIdx);
    expect(refreshIdx).toBeGreaterThan(txFinallyIdx);
    // The refresh fetch itself sits inside the isolated block.
    const refreshBlock = SOL_HANDLER.slice(refreshIdx);
    expect(refreshBlock).toContain("fetch('/api/agent/balance'");
    // And the transaction try block no longer contains any balance refresh.
    const txBlock = SOL_HANDLER.slice(0, txCatchIdx);
    expect(txBlock).not.toContain("fetch('/api/agent/balance'");
  });

  it('#6 the refresh block swallows its own failures (own catch, no toast call inside)', () => {
    const refreshBlock = SOL_HANDLER.slice(SOL_HANDLER.indexOf('if (solDepositSucceeded) {'));
    expect(refreshBlock).toContain('} catch {');
    expect(refreshBlock).not.toContain("title: 'SOL Deposit Failed'");
    expect(refreshBlock).not.toContain('toast(');
  });

  it('#7 a non-200 refresh cannot reverse the outcome (ok-gated, no throw branch)', () => {
    const refreshBlock = SOL_HANDLER.slice(SOL_HANDLER.indexOf('if (solDepositSucceeded) {'));
    expect(refreshBlock).toContain('if (balanceRes.ok) {');
    expect(refreshBlock).not.toContain('throw');
    // The refresh result is wired through the stale-read guard.
    expect(refreshBlock).toContain('setSolRequirement(prev => reconcileRefreshedSolRequirement(prev, data.botCreationSolRequirement))');
  });

  it('#8 the failure toast has exactly ONE call site — the transaction-phase catch', () => {
    expect(MODAL_SRC.split("title: 'SOL Deposit Failed'").length - 1).toBe(1);
    const failureIdx = SOL_HANDLER.indexOf("title: 'SOL Deposit Failed'");
    const refreshIdx = SOL_HANDLER.indexOf('if (solDepositSucceeded) {');
    expect(failureIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(failureIdx);
    // The catch still shows the destructive toast with a description.
    const catchBlock = SOL_HANDLER.slice(SOL_HANDLER.indexOf('} catch (error: any) {'), SOL_HANDLER.indexOf('} finally {'));
    expect(catchBlock).toContain("title: 'SOL Deposit Failed'");
    expect(catchBlock).toContain('error.message');
    expect(catchBlock).toContain("variant: 'destructive'");
  });

  it('the success toast has exactly one call site, before the optimistic transition', () => {
    expect(SOL_HANDLER.split("toast({ title: 'SOL deposited successfully!' })").length - 1).toBe(1);
    const succeededIdx = SOL_HANDLER.indexOf('solDepositSucceeded = true');
    const successToastIdx = SOL_HANDLER.indexOf("toast({ title: 'SOL deposited successfully!' })");
    const optimisticIdx = SOL_HANDLER.indexOf('applyConfirmedSolDeposit(prev, amount)');
    expect(succeededIdx).toBeGreaterThan(-1);
    expect(successToastIdx).toBeGreaterThan(succeededIdx);
    expect(optimisticIdx).toBeGreaterThan(successToastIdx);
  });
});

// ── WO-15C.4 tests 9–12: cardinality, no-replay, busy-state, bounded refresh ─

describe('SOL deposit — transaction contract and busy-state (WO-15C.4 #9–12)', () => {
  it('#9 exactly one deposit POST, signing, submission, and confirmation path', () => {
    expect(SOL_HANDLER.split("fetch('/api/agent/deposit-sol'").length - 1).toBe(1);
    expect(SOL_HANDLER.split('signTransaction(').length - 1).toBe(1);
    expect(SOL_HANDLER.split('sendRawTransaction(').length - 1).toBe(1);
    expect(SOL_HANDLER.split('confirmTransactionWithFallback(').length - 1).toBe(1);
  });

  it('#10 no transaction retry, replay, loop, or duplicate submission', () => {
    expect(SOL_HANDLER).not.toMatch(/\b(for|while)\s*\(/);
    expect(SOL_HANDLER.toLowerCase()).not.toContain('retry');
    expect(SOL_HANDLER).not.toContain('setInterval');
    expect(SOL_HANDLER).not.toContain('setTimeout(');
    // The whole modal still submits the SOL deposit from exactly one site.
    expect(MODAL_SRC.split("fetch('/api/agent/deposit-sol'").length - 1).toBe(1);
  });

  it('#11 the deposit button stays suppressed through the bounded refresh', () => {
    // Transaction-phase finally releases the busy flag ONLY on failure.
    expect(SOL_HANDLER).toMatch(/if \(!solDepositSucceeded\) \{\s*setIsDepositingSol\(false\);/);
    // The refresh block has its own finally that releases when the bounded read settles.
    const refreshBlock = SOL_HANDLER.slice(SOL_HANDLER.indexOf('if (solDepositSucceeded) {'));
    expect(refreshBlock).toMatch(/\} finally \{[\s\S]*?setIsDepositingSol\(false\);/);
    // The button itself is disabled while isDepositingSol is held.
    expect(MODAL_SRC).toContain('disabled={isDepositingSol}');
  });

  it('#12 the post-confirmation refresh is bounded to 8 seconds', () => {
    const refreshBlock = SOL_HANDLER.slice(SOL_HANDLER.indexOf('if (solDepositSucceeded) {'));
    const fetchLine = refreshBlock.split('\n').find((l) => l.includes("fetch('/api/agent/balance'"));
    expect(fetchLine).toBeDefined();
    expect(fetchLine!).toContain('AbortSignal.timeout(8_000)');
  });

  it('the USDC-path SOL-requirement refresh uses the same stale-read guard', () => {
    // A refresh after a USDC deposit can also land seconds after a confirmed
    // SOL deposit — it must go through the same reconciliation, never a raw set.
    expect(DEPOSIT_HANDLER).toContain('setSolRequirement(prev => reconcileRefreshedSolRequirement(prev, data.botCreationSolRequirement))');
    // No raw (unguarded) setSolRequirement writes remain outside the modal-open load.
    expect(MODAL_SRC.split('setSolRequirement(data.botCreationSolRequirement)').length - 1).toBe(0);
  });
});
