import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => ({ outcome: "inactive" as const })),
  record: vi.fn(async () => undefined),
}));

vi.mock("../../server/storage", () => ({
  storage: {
    captureScannerIncidentOccurrence: storageMocks.capture,
    recordError: storageMocks.record,
  },
}));

import {
  buildScannerIncidentExport,
  createScannerIncidentCaptureInput,
  normalizeScannerIncidentHoldId,
} from "../../server/ai-trader/scanner-incident-evidence";
import { flushErrorLog, recordCriticalError } from "../../server/error-log";

describe("scanner incident evidence", () => {
  beforeEach(async () => {
    await flushErrorLog();
    vi.clearAllMocks();
  });

  it("sanitizes summary/context to the explicit allowlist", () => {
    const input = createScannerIncidentCaptureInput({
      eventId: "event-1",
      observedAt: new Date("2026-08-11T00:00:00.000Z"),
      fingerprint: "abc123",
      source: "unexpected-source",
      message: "failure token=top-secret wallet 8ro9s9jR9xJwnBkk99kcTFKsJ3mQVXK5Av7N3xXJDWiN",
      context: {
        attempted: 4,
        accountingValid: false,
        symbol: "BTC-PERP",
        abandonedMarkets: ["BTC-PERP", "SOL-PERP"],
        walletAddress: "must-not-survive",
        rawPayload: { secret: true },
      },
    });

    expect(input.source).toBe("scanner");
    expect(input.summary).toContain("token=[redacted]");
    expect(input.summary).toContain("[base58]");
    expect(input.context).toEqual({
      abandonedMarkets: ["BTC-PERP", "SOL-PERP"],
      accountingValid: false,
      attempted: 4,
      symbol: "BTC-PERP",
    });
    expect(JSON.stringify(input)).not.toContain("walletAddress");
    expect(JSON.stringify(input)).not.toContain("rawPayload");
  });

  it("retains the bounded scanner diagnostic context emitted by producers", () => {
    const input = createScannerIncidentCaptureInput({
      fingerprint: "diagnostic-context",
      message: "Scanner partial sweep",
      context: {
        uptimeSec: 123,
        boundaryTfs: ["4h", "15m", "4h", "invalid", "1d", "1h", "15m"],
        venueClosed: 2,
        skippedByTimeout: 3,
        primaryCacheDegraded: 1,
      },
    });

    expect(input.context).toEqual({
      boundaryTfs: ["4h", "15m", "1d", "1h"],
      primaryCacheDegraded: 1,
      skippedByTimeout: 3,
      uptimeSec: 123,
      venueClosed: 2,
    });
  });

  it("drops malformed and unlisted diagnostic lookalikes without widening context retention", () => {
    const input = createScannerIncidentCaptureInput({
      fingerprint: "malformed-diagnostic-context",
      message: "Scanner partial sweep",
      context: {
        uptimeSec: "123",
        venueClosed: false,
        skippedByTimeout: Number.NaN,
        primaryCacheDegraded: Number.POSITIVE_INFINITY,
        boundaryTfs: "15m",
        uptimeSecRaw: 123,
        boundaryTimeframes: ["15m"],
        account: "must-not-survive",
        walletAddress: "must-not-survive",
        apiToken: "must-not-survive",
        nestedPayload: { boundaryTfs: ["15m"] },
      },
    });

    expect(input.context).toEqual({});
  });

  it("captures every accepted scanner call before ordinary fingerprint coalescing", async () => {
    recordCriticalError({
      category: "scanner",
      source: "scanner-sweep",
      message: "Scanner blackout: 0 of 10 markets scanned",
      context: { attempted: 10, scanned: 0 },
    });
    recordCriticalError({
      category: "scanner",
      source: "scanner-sweep",
      message: "Scanner blackout: 0 of 11 markets scanned",
      context: { attempted: 11, scanned: 0 },
    });

    expect(storageMocks.capture).toHaveBeenCalledTimes(2);
    const first = storageMocks.capture.mock.calls[0][0];
    const second = storageMocks.capture.mock.calls[1][0];
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.observedAt).toBeInstanceOf(Date);
    expect(second.observedAt).toBeInstanceOf(Date);
    expect(first.fingerprint).toBe(second.fingerprint);

    await flushErrorLog();
    expect(storageMocks.record).toHaveBeenCalledTimes(1);
    expect(storageMocks.record.mock.calls[0][0].count).toBe(2);
  });

  it("contains capture failures and leaves ordinary recording available", async () => {
    storageMocks.capture.mockRejectedValueOnce(new Error("capture database unavailable"));
    expect(() => recordCriticalError({
      category: "scanner",
      source: "scanner-sweep",
      message: "Scanner partial sweep",
    })).not.toThrow();
    await Promise.resolve();
    await flushErrorLog();
    expect(storageMocks.record).toHaveBeenCalledTimes(1);
  });

  it("builds one deterministic digest and independent counts for both windows", () => {
    const common = {
      holdId: "scanner-canary-2026-08-11",
      fingerprint: "same-fingerprint",
      category: "scanner" as const,
      source: "scanner-sweep",
      summary: "Scanner blackout",
      context: { attempted: 2 },
    };
    const rows = [
      { ...common, eventId: "event-b", window: "canary" as const, observedAt: new Date("2026-08-11T00:15:00Z") },
      { ...common, eventId: "event-a", window: "baseline" as const, observedAt: new Date("2026-08-11T00:00:00Z") },
    ];
    const first = buildScannerIncidentExport(common.holdId, rows);
    const second = buildScannerIncidentExport(common.holdId, [...rows].reverse());

    expect(first).toEqual(second);
    expect(first.payload.rawRowCount).toBe(2);
    expect(first.payload.windows).toEqual({
      baseline: { rawOccurrences: 1 },
      canary: { rawOccurrences: 1 },
    });
    expect(first.payload.fingerprints).toEqual([{
      fingerprint: "same-fingerprint",
      baseline: 1,
      canary: 1,
      total: 2,
    }]);
    expect(first.digest).toMatch(/^[0-9A-F]{64}$/);
  });

  it("accepts only bounded canonical hold identities", () => {
    expect(normalizeScannerIncidentHoldId(" Scanner-Canary.2026_08_11 ")).toBe("scanner-canary.2026_08_11");
    expect(normalizeScannerIncidentHoldId("ab")).toBeNull();
    expect(normalizeScannerIncidentHoldId("../../escape")).toBeNull();
    expect(normalizeScannerIncidentHoldId("contains spaces")).toBeNull();
  });
});
