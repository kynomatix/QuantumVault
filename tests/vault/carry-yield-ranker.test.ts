import { describe, it, expect } from "vitest";
import {
  rankMeasuredYieldDestinations,
} from "../../server/vault/carry-yield-ranker";
import type { YieldAsset } from "../../server/vault/yield-assets";
import type { YieldApyEntry, YieldTable } from "../../server/vault/yield-oracle";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
function asset(key: string, overrides: Partial<YieldAsset> = {}): YieldAsset {
  return {
    key,
    displayName: `Asset ${key}`,
    mint: `${key}Mint11111111111111111111111111111111`,
    decimals: 6,
    route: "jupiter",
    valuation: "market_quote",
    defaultEligible: false,
    riskClass: "stable",
    mayLoseValue: false,
    apyLabel: "~10%",
    tag: "tag",
    riskNote: "note",
    enabled: true,
    ...overrides,
  };
}

function entry(overrides: Partial<YieldApyEntry> = {}): YieldApyEntry {
  return {
    apy: 8,
    apyBase: 8,
    apyReward: null,
    method: "defillama",
    asOf: 1_700_000_000_000,
    ...overrides,
  };
}

describe("rankMeasuredYieldDestinations", () => {
  it("ranks measured assets by APY descending", () => {
    const table: YieldTable = {
      a: entry({ apy: 5, method: "defillama" }),
      b: entry({ apy: 9, method: "trailing" }),
      c: entry({ apy: 7, method: "defillama_cached" }),
    };
    const { ranked, excluded } = rankMeasuredYieldDestinations(table, [
      asset("a"),
      asset("b"),
      asset("c"),
    ]);
    expect(excluded).toHaveLength(0);
    expect(ranked.map((r) => r.assetKey)).toEqual(["b", "c", "a"]);
    expect(ranked[0].apyPct).toBe(9);
    expect(ranked[0].method).toBe("trailing");
  });

  it("breaks ties deterministically by asset key", () => {
    const table: YieldTable = {
      zeta: entry({ apy: 6 }),
      alpha: entry({ apy: 6 }),
      mid: entry({ apy: 6 }),
    };
    const { ranked } = rankMeasuredYieldDestinations(table, [
      asset("zeta"),
      asset("alpha"),
      asset("mid"),
    ]);
    expect(ranked.map((r) => r.assetKey)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("excludes an accruing (self-measuring) asset with reason 'accruing'", () => {
    const table: YieldTable = {
      perena_usd_star: entry({ apy: null, apyBase: null, method: "accruing" }),
    };
    const { ranked, excluded } = rankMeasuredYieldDestinations(table, [
      asset("perena_usd_star"),
    ]);
    expect(ranked).toHaveLength(0);
    expect(excluded).toEqual([
      { assetKey: "perena_usd_star", displayName: "Asset perena_usd_star", reason: "accruing" },
    ]);
  });

  it("excludes an unavailable asset with reason 'unavailable'", () => {
    const table: YieldTable = {
      x: entry({ apy: null, apyBase: null, method: "unavailable" }),
    };
    const { ranked, excluded } = rankMeasuredYieldDestinations(table, [asset("x")]);
    expect(ranked).toHaveLength(0);
    expect(excluded[0]).toMatchObject({ assetKey: "x", reason: "unavailable" });
  });

  it("excludes an asset with no table entry (cold cache) as 'no_data'", () => {
    const { ranked, excluded } = rankMeasuredYieldDestinations({}, [asset("y")]);
    expect(ranked).toHaveLength(0);
    expect(excluded[0]).toMatchObject({ assetKey: "y", reason: "no_data" });
  });

  it("NEVER ranks off the apyLabel — a measured-method row with a null APY is excluded", () => {
    const table: YieldTable = {
      // method says defillama but the number is null → must NOT be ranked.
      z: entry({ apy: null, apyBase: null, method: "defillama" }),
    };
    const { ranked, excluded } = rankMeasuredYieldDestinations(table, [
      asset("z", { apyLabel: "~12%" }),
    ]);
    expect(ranked).toHaveLength(0);
    expect(excluded[0]).toMatchObject({ assetKey: "z", reason: "unavailable" });
  });

  it("carries display/risk metadata onto ranked entries", () => {
    const table: YieldTable = { f: entry({ apy: 11, asOf: 1234 }) };
    const { ranked } = rankMeasuredYieldDestinations(table, [
      asset("f", { displayName: "OnRe ONyc", riskClass: "float", mayLoseValue: true }),
    ]);
    expect(ranked[0]).toMatchObject({
      assetKey: "f",
      displayName: "OnRe ONyc",
      apyPct: 11,
      asOf: 1234,
      riskClass: "float",
      mayLoseValue: true,
    });
  });

  it("partitions a mixed table into ranked + excluded", () => {
    const table: YieldTable = {
      good: entry({ apy: 8 }),
      building: entry({ apy: null, method: "accruing" }),
      // 'missing' has no entry at all.
    };
    const { ranked, excluded } = rankMeasuredYieldDestinations(table, [
      asset("good"),
      asset("building"),
      asset("missing"),
    ]);
    expect(ranked.map((r) => r.assetKey)).toEqual(["good"]);
    expect(excluded.map((e) => e.reason).sort()).toEqual(["accruing", "no_data"]);
  });

  it("returns empty result for no enabled assets", () => {
    expect(rankMeasuredYieldDestinations({ a: entry() }, [])).toEqual({
      ranked: [],
      excluded: [],
    });
  });
});
