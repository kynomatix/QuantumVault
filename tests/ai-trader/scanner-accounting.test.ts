import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../server/ai-trader/context-builder", () => ({
  marketToDatafeedTicker: (market: string) => market.replace("-PERP", "/USDT"),
}));

vi.mock("../../server/protocol/flash/flash-markets", () => ({
  getFlashMarketSpecs: vi.fn(async () => []),
}));

vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: vi.fn(),
}));

vi.mock("../../server/ai-trader/session-context", () => ({
  getSessionContext: vi.fn(() => ({ label: "test" })),
}));

import {
  ScannerAttemptLedger,
  countParentCacheDegradation,
  formatScannerSweepAccountingLine,
  settleUnexpectedScannerDispatch,
  createScannerSweepManifest,
  type ScannerAttemptDisposition,
} from "../../server/ai-trader/scanner";

const ALL_TERMINAL: ScannerAttemptDisposition[] = [
  "scanned",
  "feed-health-skipped",
  "venue-closed",
  "timeout-skipped",
  "primary-cache-degraded",
  "parent-inconclusive",
  "error",
  "abandoned",
];

describe("scanner attempt terminal accounting", () => {
  const manifest = (dispositions: ScannerAttemptDisposition[], completed = true) => {
    const ledger = new ScannerAttemptLedger();
    dispositions.forEach((disposition, index) => {
      const key = `flash|15m|M${index}`;
      ledger.intend(key);
      if (disposition !== undefined) ledger.finalize(key, disposition);
    });
    return createScannerSweepManifest({
      generation: 1, boundaryTimeframes: ["15m"], startedAt: 1, finishedAt: 2,
      accounting: ledger.reconcile(), budgetSkippedUnits: 0,
      parentCacheDegraded: false, candidatesByProtocol: new Map(), completed,
    });
  };

  it("publishes a tradable manifest when every attempt has one terminal", () => {
    expect(manifest(["scanned", "venue-closed"]).verdict).toBe("tradable");
  });

  it("tolerates timeout feed-health primary-cache and parent-inconclusive terminals", () => {
    expect(manifest(["timeout-skipped", "feed-health-skipped", "primary-cache-degraded", "parent-inconclusive"]).verdict)
      .toBe("tradable");
  });

  it("rejects unclassified abandoned and unreconciled generations", () => {
    expect(manifest(["abandoned"]).verdict).toBe("diagnostic_only");
    expect(manifest([], false).diagnosticReasons).toContain("interrupted");
    const unclassifiedLedger = new ScannerAttemptLedger();
    unclassifiedLedger.intend("flash|15m|UNFINISHED");
    const unclassified = createScannerSweepManifest({
      generation: 2, boundaryTimeframes: ["15m"], startedAt: 1, finishedAt: 2,
      accounting: unclassifiedLedger.reconcile(), budgetSkippedUnits: 0,
      parentCacheDegraded: false, candidatesByProtocol: new Map(), completed: true,
    });
    expect(unclassified.verdict).toBe("diagnostic_only");
    expect(unclassified.diagnosticReasons).toEqual(expect.arrayContaining([
      "accounting_invalid", "unclassified_attempt",
    ]));
    const unreconciled = createScannerSweepManifest({
      generation: 3, boundaryTimeframes: ["15m"], startedAt: 1, finishedAt: 2,
      accounting: { ...unclassified.accounting, unclassified: 0, accountingValid: false },
      budgetSkippedUnits: 0, parentCacheDegraded: false,
      candidatesByProtocol: new Map(), completed: true,
    });
    expect(unreconciled.diagnosticReasons).toEqual(["accounting_invalid"]);
  });
  it("reconciles a mixed terminal population exactly once", () => {
    const ledger = new ScannerAttemptLedger();
    const keys = ALL_TERMINAL.map((_, index) => `pacifica|15m|M${index}-PERP`);
    keys.forEach((key) => ledger.intend(key));
    ALL_TERMINAL.forEach((disposition, index) => {
      expect(ledger.finalize(keys[index], disposition)).toBe(true);
    });

    expect(ledger.reconcile()).toEqual({
      attempted: 8,
      scanned: 1,
      feedHealthSkipped: 1,
      venueClosed: 1,
      timeoutSkipped: 1,
      primaryCacheDegraded: 1,
      parentInconclusive: 1,
      errors: 1,
      abandoned: 1,
      unclassified: 0,
      accountingValid: true,
    });
  });

  it("deletion red control surfaces a missing terminal classification", () => {
    const ledger = new ScannerAttemptLedger();
    const keys = ["flash|15m|BTC-PERP", "flash|15m|ETH-PERP"];
    keys.forEach((key) => ledger.intend(key));
    ledger.finalize(keys[0], "scanned");

    expect(ledger.reconcile()).toMatchObject({
      attempted: 2,
      scanned: 1,
      unclassified: 1,
      accountingValid: false,
    });
  });

  it("late settlement cannot replace or double-count abandonment", () => {
    const ledger = new ScannerAttemptLedger();
    const key = "pacifica|1h|SOL-PERP";
    ledger.intend(key);

    expect(ledger.finalize(key, "abandoned")).toBe(true);
    expect(ledger.finalize(key, "timeout-skipped")).toBe(false);
    expect(ledger.finalize(key, "scanned")).toBe(false);
    expect(ledger.reconcile()).toMatchObject({
      attempted: 1,
      scanned: 0,
      timeoutSkipped: 0,
      errors: 0,
      abandoned: 1,
      unclassified: 0,
      accountingValid: true,
    });
  });

  it("does not admit a terminal result for an unknown attempt", () => {
    const ledger = new ScannerAttemptLedger();
    expect(ledger.finalize("not-intended", "scanned")).toBe(false);
    expect(ledger.reconcile()).toMatchObject({ attempted: 0, scanned: 0, accountingValid: true });
  });

  it("keeps budget-gated units outside attempted and serializes the gate separately", () => {
    const ledger = new ScannerAttemptLedger();
    const admitted = "flash|15m|BTC-PERP";
    ledger.intend(admitted);
    ledger.finalize(admitted, "scanned");

    // Two whole protocol/timeframe units were budget-gated, so their markets
    // were never admitted to the terminal ledger.
    const accounting = ledger.reconcile();
    const total = formatScannerSweepAccountingLine("TOTAL", accounting, {
      parentCacheDegraded: 0,
      budgetSkippedUnits: 2,
      candidates: 0,
      durationMs: 240_000,
      fetchBudgetMs: 240_000,
    });

    expect(accounting).toMatchObject({ attempted: 1, scanned: 1, unclassified: 0 });
    expect(total).toContain("1 attempted, 1 scanned");
    expect(total).toContain("2 budget-gated units");
  });

  it("settles and logs an unexpected dispatch error exactly once", () => {
    const ledger = new ScannerAttemptLedger();
    const key = "pacifica|15m|SOL-PERP";
    ledger.intend(key);

    expect(settleUnexpectedScannerDispatch(ledger, key, new Error("evaluator exploded"), false))
      .toEqual({ disposition: "error", finalized: true, shouldLog: true });
    expect(settleUnexpectedScannerDispatch(ledger, key, new Error("late duplicate"), false))
      .toEqual({ disposition: "error", finalized: false, shouldLog: false });
    expect(ledger.reconcile()).toMatchObject({ attempted: 1, errors: 1, unclassified: 0 });
  });

  it("keeps parent cache degradation auxiliary to one parent-inconclusive terminal", () => {
    const ledger = new ScannerAttemptLedger();
    const key = "flash|15m|ETH-PERP";
    ledger.intend(key);
    const parentCacheDegraded = countParentCacheDegradation(0, {
      name: "CacheDegradedError",
    });
    expect(ledger.finalize(key, "parent-inconclusive")).toBe(true);
    expect(ledger.finalize(key, "scanned")).toBe(false);
    expect(ledger.finalize(key, "error")).toBe(false);
    const accounting = ledger.reconcile();
    const options = {
      parentCacheDegraded,
      budgetSkippedUnits: 0,
      candidates: 0,
      durationMs: 1_000,
      fetchBudgetMs: 240_000,
      errorMessage: "outer failure",
    };

    expect(accounting).toMatchObject({
      attempted: 1,
      scanned: 0,
      primaryCacheDegraded: 0,
      parentInconclusive: 1,
      errors: 0,
      unclassified: 0,
      accountingValid: true,
    });
    expect(formatScannerSweepAccountingLine("TOTAL", accounting, options))
      .toContain("0 primary-cache-degraded, 1 parent-inconclusive, 1 parent-cache-degraded");
    expect(formatScannerSweepAccountingLine("ABORT", accounting, options))
      .toContain("0 primary-cache-degraded, 1 parent-inconclusive, 1 parent-cache-degraded");
  });
});

describe("scanner runSweep seam pins", () => {
  const source = readFileSync(new URL("../../server/ai-trader/scanner.ts", import.meta.url), "utf8");

  function between(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  }

  it("classifies the existing negative-cache early return", () => {
    expect(between("// Feed health check:", "// Venue-hours gate:"))
      .toContain('finishAttempt(market, "feed-health-skipped")');
  });

  it("classifies a newly empty feed as error rather than feed-health-skipped", () => {
    const empty = between("if (bars.length === 0)", "// Track freshness");
    expect(empty).toContain('finishAttempt(market, "error")');
    expect(empty).not.toContain('finishAttempt(market, "feed-health-skipped")');
  });

  it("keeps parent cache degradation auxiliary and abandonment exclusive", () => {
    const parentFetch = between("// Fetch parent-TF bars", "const evaluation = evaluateCandidateResult");
    const budgetNull = parentFetch.indexOf("if (remainingMs < 5_000)");
    const abortSignal = parentFetch.indexOf("signal: tfAbort.signal");
    const failureCounter = parentFetch.indexOf("countParentCacheDegradation(");
    const caughtNull = parentFetch.indexOf("parentBars = null;", failureCounter);

    expect(budgetNull).toBeGreaterThanOrEqual(0);
    expect(parentFetch.indexOf("parentBars = null;", budgetNull)).toBeGreaterThan(budgetNull);
    expect(abortSignal).toBeGreaterThan(budgetNull);
    expect(failureCounter).toBeGreaterThan(abortSignal);
    expect(caughtNull).toBeGreaterThan(failureCounter);
    expect(parentFetch).not.toContain("primary-cache-degraded");
    expect(source.indexOf("const evaluation = evaluateCandidateResult"))
      .toBeGreaterThan(source.indexOf("parentBars = null;", failureCounter));

    const evaluation = between("const evaluation = evaluateCandidateResult", "})().catch((err) =>");
    const parentInconclusiveBranch = between(
      'evaluation.kind === "parent_inconclusive"',
      'const candidate = evaluation.kind === "candidate"',
    );
    expect(parentInconclusiveBranch).toContain('finishAttempt(market, "parent-inconclusive")');
    expect(parentInconclusiveBranch).toContain("return;");
    expect(parentInconclusiveBranch).not.toContain('finishAttempt(market, "scanned")');

    const abandoned = between("if (!settledInTime)", "const accounting = sweepLedger.reconcile");
    expect(abandoned).toContain('finishAttempt(m, "abandoned")');
    expect(abandoned).not.toContain("errorCount += abandoned.length");
  });

  it("publishes parent-inconclusive through boundary and sweep accounting", () => {
    expect(source).toContain("parentInconclusiveCount: accounting.parentInconclusive");
    expect(source).toContain("parentInconclusive: sweepAccounting.parentInconclusive");
    expect(source).toContain("${accounting.parentInconclusive} parent-inconclusive");
    expect(source).toContain("marketsFresh remains a subset of successfully scanned attempts");
  });

  it("wires behavioral helpers into the three reviewed runSweep seams", () => {
    expect(source).toContain('formatScannerSweepAccountingLine("TOTAL"');
    expect(source).toContain('formatScannerSweepAccountingLine("ABORT"');
    expect(source).toContain("settleUnexpectedScannerDispatch(");
    expect(source).toContain("countParentCacheDegradation(");
  });
});
