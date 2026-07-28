import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  ORPHANED_SUBACCOUNT_FAST_RETRY_LIMIT,
  ORPHANED_SUBACCOUNT_SLOW_RETRY_INTERVAL_MS,
  shouldAttemptOrphanCleanup,
} from "../../server/orphaned-subaccount-retry-policy";

describe("orphaned-subaccount cleanup retry policy", () => {
  const now = Date.UTC(2026, 6, 28, 0, 0, 0);

  it.each([0, 1, ORPHANED_SUBACCOUNT_FAST_RETRY_LIMIT - 1])(
    "attempts fast-budget row retryCount=%s immediately",
    (retryCount) => {
      expect(shouldAttemptOrphanCleanup({ retryCount, lastRetryAt: new Date(now) }, now)).toBe(true);
    },
  );

  it("defers an exhausted row only until the slow interval elapses", () => {
    const lastRetryAt = new Date(now - ORPHANED_SUBACCOUNT_SLOW_RETRY_INTERVAL_MS + 1);
    expect(shouldAttemptOrphanCleanup({ retryCount: 5, lastRetryAt }, now)).toBe(false);
    expect(shouldAttemptOrphanCleanup({ retryCount: 500, lastRetryAt }, now)).toBe(false);
  });

  it("retries exhausted rows at and after the slow boundary", () => {
    const atBoundary = new Date(now - ORPHANED_SUBACCOUNT_SLOW_RETRY_INTERVAL_MS);
    expect(shouldAttemptOrphanCleanup({ retryCount: 5, lastRetryAt: atBoundary }, now)).toBe(true);
    expect(shouldAttemptOrphanCleanup({ retryCount: 500, lastRetryAt: atBoundary }, now)).toBe(true);
  });

  it.each([
    { retryCount: 5, lastRetryAt: null },
    { retryCount: 5, lastRetryAt: "not-a-date" },
    { retryCount: 5, lastRetryAt: new Date(now + 1) },
    { retryCount: -1, lastRetryAt: new Date(now) },
    { retryCount: Number.NaN, lastRetryAt: new Date(now) },
  ])("malformed scheduling state never becomes permanent abandonment: %o", (row) => {
    expect(shouldAttemptOrphanCleanup(row, now)).toBe(true);
  });

  it("wires the cleanup worker to slow retries and removes permanent abandonment", () => {
    const source = readFileSync(
      resolve(__dirname, "../../server/orphaned-subaccount-cleanup.ts"),
      "utf8",
    );
    expect(source).toContain("shouldAttemptOrphanCleanup(o, nowMs)");
    expect(source).toContain("remain custody blockers");
    expect(source).not.toMatch(/retryCount\s*[<>]=?\s*5/);
    expect(source).not.toContain("cannot be automatically recovered");
    expect(source).not.toContain("Reset Drift Account");
  });
});
