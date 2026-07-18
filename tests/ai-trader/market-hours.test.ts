// Venue trading-hours gate for the AI Trader scanner (Pyth 429 mitigation,
// 2026-07-18). Two invariants under test:
//
// 1. Every non-crypto base in NON_CRYPTO_PYTH_MAP is EXPLICITLY classified as
//    either an equity (NYSE session) or 24×5 (FX/metals/oil). A future equity
//    added to the map but not to EQUITY_PYTH_BASES would silently fall through
//    to the 24×5 rule and keep burning the shared Pyth rate budget overnight.
//
// 2. isNonCryptoMarketOpen() session boundaries: NYSE 09:30–16:00 ET Mon–Fri
//    (+30min post-close grace), FX/metals closed Fri 17:00 ET → Sun 17:00 ET,
//    crypto always open. Dates below are July 2026 (EDT, UTC-4) — the
//    Intl/America-New_York implementation handles DST, so ET wall-clock math
//    in the comments is the source of truth.

import { describe, it, expect } from "vitest";
import {
  isNonCryptoMarketOpen,
  getNonCryptoSessionClassification,
} from "../../server/lab/datafeed";

describe("non-crypto session classification", () => {
  it("classifies every NON_CRYPTO_PYTH_MAP base as exactly one of equity or 24×5", () => {
    const { allBases, equities, fx24x5 } = getNonCryptoSessionClassification();
    const equitySet = new Set(equities);
    const fxSet = new Set(fx24x5);

    const unclassified = allBases.filter((b) => !equitySet.has(b) && !fxSet.has(b));
    expect(unclassified).toEqual([]);

    const doubleClassified = allBases.filter((b) => equitySet.has(b) && fxSet.has(b));
    expect(doubleClassified).toEqual([]);

    // Both sets must only contain real map keys (no orphan classifications).
    const baseSet = new Set(allBases);
    expect(equities.filter((b) => !baseSet.has(b))).toEqual([]);
    expect(fx24x5.filter((b) => !baseSet.has(b))).toEqual([]);
  });
});

describe("isNonCryptoMarketOpen", () => {
  const cases: Array<[string, string, boolean, string]> = [
    ["NVDA/USDT", "2026-07-17T14:00:00Z", true, "Fri 10:00 ET — NYSE open"],
    ["NVDA/USDT", "2026-07-17T13:00:00Z", false, "Fri 09:00 ET — pre-market"],
    ["NVDA/USDT", "2026-07-17T13:30:00Z", true, "Fri 09:30 ET — opening bell"],
    ["NVDA/USDT", "2026-07-17T20:15:00Z", true, "Fri 16:15 ET — post-close grace"],
    ["NVDA/USDT", "2026-07-17T20:45:00Z", false, "Fri 16:45 ET — grace over"],
    ["NVDA/USDT", "2026-07-18T15:00:00Z", false, "Saturday — closed"],
    ["SPY/USDT", "2026-07-19T15:00:00Z", false, "Sunday — closed"],
    ["SPY/USDT", "2026-07-20T13:35:00Z", true, "Mon 09:35 ET — open"],
    ["EUR/USDT", "2026-07-17T14:00:00Z", true, "FX Fri daytime — open"],
    ["EUR/USDT", "2026-07-17T21:30:00Z", false, "FX Fri 17:30 ET — weekend close"],
    ["XAU/USDT", "2026-07-18T15:00:00Z", false, "metals Saturday — closed"],
    ["EURUSD/USDT", "2026-07-19T20:00:00Z", false, "FX Sun 16:00 ET — still closed"],
    ["EURUSD/USDT", "2026-07-19T22:00:00Z", true, "FX Sun 18:00 ET — reopened"],
    ["CRUDEOIL/USDT", "2026-07-18T03:00:00Z", false, "oil Fri 23:00 ET — closed"],
    ["BTC/USDT", "2026-07-18T15:00:00Z", true, "crypto — always open"],
    ["1MPEPE/USDT", "2026-07-18T15:00:00Z", true, "crypto multiplier prefix — always open"],
  ];

  for (const [symbol, iso, want, label] of cases) {
    it(`${symbol} @ ${iso} → ${want} (${label})`, () => {
      expect(isNonCryptoMarketOpen(symbol, new Date(iso))).toBe(want);
    });
  }
});
