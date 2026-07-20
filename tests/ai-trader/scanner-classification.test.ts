// tests/ai-trader/scanner-classification.test.ts
//
// Pins the sweep fetch-error classification invariant from the 2026-07-20
// production incident: a CacheDegradedError (DB/cache pressure) must NEVER be
// classified as a feed error. A feed-error verdict puts the market in the
// 30-minute feed-dead exclusion, silently blinding the scanner to it — the
// exact misclassification the incident work order forbids.
//
// classifySweepFetchError is the pure classifier both sweep catch blocks
// (primary fetch + dispatch-level backstop) route through. Ordering:
//   1. sweep-abort + AbortError  → "timeout-skip"   (our budget, not the feed)
//   2. CacheDegradedError        → "cache-degraded" (DB pressure, not the feed)
//   3. everything else           → "feed-error"     (30-min feed-dead)
//
// The datafeed module is deliberately REAL here so the classifier is tested
// against the real CacheDegradedError class and real isAbortError/
// isCacheDegradedError guards — not mock lookalikes. The heavy venue modules
// scanner.ts imports are mocked (same shapes as tests/ai-trader/scanner.test.ts);
// none of them are touched by the classifier.

import { describe, it, expect, vi } from "vitest";

// ─── Module mocks (import-weight only — classifier never calls these) ────────

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

import { classifySweepFetchError } from "../../server/ai-trader/scanner";
import { CacheDegradedError } from "../../server/lab/datafeed";

// Datafeed-style AbortError (datafeed's makeAbortError produces exactly this
// shape; Node's fetch abort also surfaces with name === "AbortError").
function makeAbortError(): Error {
  const e = new Error("Datafeed fetch aborted by caller signal");
  e.name = "AbortError";
  return e;
}

describe("classifySweepFetchError — cache-degraded is NEVER feed-dead", () => {
  it("real CacheDegradedError → cache-degraded (sweep not aborted)", () => {
    const err = new CacheDegradedError("BTC/USDT", "15m", 8000);
    expect(classifySweepFetchError(err, false)).toBe("cache-degraded");
  });

  it("real CacheDegradedError → cache-degraded even while the sweep IS aborted", () => {
    // A degraded read that races the sweep-budget abort must still be counted
    // as DB pressure, not folded into the timeout-skip bucket: it is not an
    // AbortError, so the abort branch must not claim it.
    const err = new CacheDegradedError("ETH/USDT", "1h", 8000);
    expect(classifySweepFetchError(err, true)).toBe("cache-degraded");
  });

  it("duck-typed CacheDegradedError (cross-module instance) → cache-degraded", () => {
    // isCacheDegradedError accepts name-matched objects so a copy of the class
    // from a second module instance (vitest/esbuild dual-registration) still
    // classifies correctly.
    const err = Object.assign(new Error("Candle cache degraded"), {
      name: "CacheDegradedError",
    });
    expect(classifySweepFetchError(err, false)).toBe("cache-degraded");
  });

  it("invariant: CacheDegradedError is never feed-error or timeout-skip under any abort state", () => {
    for (const aborted of [false, true]) {
      const verdict = classifySweepFetchError(
        new CacheDegradedError("SOL/USDT", "4h", 8000),
        aborted,
      );
      expect(verdict).toBe("cache-degraded");
      expect(verdict).not.toBe("feed-error");
      expect(verdict).not.toBe("timeout-skip");
    }
  });
});

describe("classifySweepFetchError — abort and feed-error ordering", () => {
  it("AbortError while the sweep signal is aborted → timeout-skip (never feed-dead)", () => {
    expect(classifySweepFetchError(makeAbortError(), true)).toBe("timeout-skip");
  });

  it("AbortError WITHOUT sweep abort → feed-error (per-call timeout semantics preserved)", () => {
    // Deliberate: fetchOHLCV's internal per-call timeout also surfaces as
    // AbortError. The abort branch is gated on the SWEEP signal state, not
    // err.name alone — when the sweep did not abort, this is the feed's
    // failure to answer inside its own deadline. Pre-existing semantics,
    // pinned so a refactor doesn't quietly widen the abort branch.
    expect(classifySweepFetchError(makeAbortError(), false)).toBe("feed-error");
  });

  it("plain Error → feed-error regardless of sweep abort state", () => {
    expect(classifySweepFetchError(new Error("HTTP 502"), false)).toBe("feed-error");
    expect(classifySweepFetchError(new Error("HTTP 502"), true)).toBe("feed-error");
  });

  it("non-Error throw (string) → feed-error", () => {
    expect(classifySweepFetchError("boom", false)).toBe("feed-error");
    expect(classifySweepFetchError("boom", true)).toBe("feed-error");
  });
});
