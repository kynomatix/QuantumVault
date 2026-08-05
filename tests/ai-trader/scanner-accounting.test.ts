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
  type ScannerAttemptDisposition,
} from "../../server/ai-trader/scanner";

const ALL_TERMINAL: ScannerAttemptDisposition[] = [
  "scanned",
  "feed-health-skipped",
  "venue-closed",
  "timeout-skipped",
  "primary-cache-degraded",
  "error",
  "abandoned",
];

describe("scanner attempt terminal accounting", () => {
  it("reconciles a mixed terminal population exactly once", () => {
    const ledger = new ScannerAttemptLedger();
    const keys = ALL_TERMINAL.map((_, index) => `pacifica|15m|M${index}-PERP`);
    keys.forEach((key) => ledger.intend(key));
    ALL_TERMINAL.forEach((disposition, index) => {
      expect(ledger.finalize(keys[index], disposition)).toBe(true);
    });

    expect(ledger.reconcile()).toEqual({
      attempted: 7,
      scanned: 1,
      feedHealthSkipped: 1,
      venueClosed: 1,
      timeoutSkipped: 1,
      primaryCacheDegraded: 1,
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
    const parent = between("// Parent fetch failure is non-fatal", "const candidate = evaluateCandidate");
    expect(parent).toContain("parentCacheDegradedCount++");
    expect(parent).not.toContain("primary-cache-degraded");

    const abandoned = between("if (!settledInTime)", "const accounting = sweepLedger.reconcile");
    expect(abandoned).toContain('finishAttempt(m, "abandoned")');
    expect(abandoned).not.toContain("errorCount += abandoned.length");
  });
});
