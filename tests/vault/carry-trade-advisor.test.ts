import { describe, it, expect } from "vitest";
import { decideCarryTrade } from "../../server/vault/carry-trade-advisor";
import { BORROW_RISK_POLICY } from "../../server/vault/borrow-risk-policy";
import type { RankedYieldDestination } from "../../server/vault/carry-yield-ranker";
import type { BotBorrowHealthSummary, BorrowHealthBand } from "../../server/vault/borrow-health";

// ---------------------------------------------------------------------------
// Fixtures. The decision engine reads only headline.{band,actionBlocked} from
// the health summary and the top of rankedYields.
// ---------------------------------------------------------------------------
const HAIRCUT = BORROW_RISK_POLICY.carryAdvisor.spreadHaircutPct; // 1.0
const MIN_PARK = BORROW_RISK_POLICY.carryAdvisor.minParkNetSpreadPct; // 1.0

function health(
  band: BorrowHealthBand,
  actionBlocked = band === "unavailable",
): BotBorrowHealthSummary {
  return {
    applicable: true,
    positions: [],
    headline: { band, healthFactor: band === "healthy" ? 3 : 1.2, actionBlocked },
  };
}

function yld(apyPct: number, key = "kamino_usdc"): RankedYieldDestination {
  return {
    assetKey: key,
    displayName: `Asset ${key}`,
    apyPct,
    method: "defillama",
    asOf: 1_700_000_000_000,
    riskClass: "stable",
    mayLoseValue: false,
  };
}

describe("decideCarryTrade", () => {
  it("returns unavailable when health is actionBlocked (unreadable)", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(20)],
      borrowApr: 0.05,
      healthSummary: health("unavailable", true),
      debtUsd: 100,
    });
    expect(rec.action).toBe("unavailable");
    expect(rec.reason).toBe("unavailable_health");
    expect(rec.blockedBy).toBe("health");
  });

  it("health override: liquidation → repay even with a huge positive spread", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(50)],
      borrowApr: 0.05,
      healthSummary: health("liquidation"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("repay");
    expect(rec.reason).toBe("repay_health_liquidation");
  });

  it("health override: urgent → repay", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(50)],
      borrowApr: 0.05,
      healthSummary: health("urgent"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("repay");
    expect(rec.reason).toBe("repay_health_urgent");
  });

  it("health override: nudge → repay (health always overrides carry)", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(50)],
      borrowApr: 0.05,
      healthSummary: health("nudge"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("repay");
    expect(rec.reason).toBe("repay_health_nudge");
  });

  it("healthy + no debt → hold (nothing to carry)", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(20)],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 0,
    });
    expect(rec.action).toBe("hold");
    expect(rec.reason).toBe("hold_no_debt");
  });

  it("healthy + debt + unreadable borrow APR → unavailable (fail closed)", () => {
    for (const badApr of [null, NaN, -0.01]) {
      const rec = decideCarryTrade({
        rankedYields: [yld(20)],
        borrowApr: badApr as number | null,
        healthSummary: health("healthy"),
        debtUsd: 100,
      });
      expect(rec.action).toBe("unavailable");
      expect(rec.reason).toBe("unavailable_borrow_apr");
      expect(rec.blockedBy).toBe("borrow_apr");
    }
  });

  it("healthy + debt + no measured yield → hold (never park off an estimate)", () => {
    const rec = decideCarryTrade({
      rankedYields: [],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("hold");
    expect(rec.reason).toBe("hold_yield_unavailable");
    expect(rec.bestAsset).toBeNull();
  });

  it("positive carry above the minimum → park to the best vault", () => {
    // apy 8% − borrow 5% = 3% gross − 1% haircut = 2% net >= 1% min → park.
    const rec = decideCarryTrade({
      rankedYields: [yld(8, "kamino_usdc")],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("park");
    expect(rec.reason).toBe("park_positive_carry");
    expect(rec.bestAsset?.assetKey).toBe("kamino_usdc");
    expect(rec.grossSpreadPct).toBeCloseTo(3, 9);
    expect(rec.netSpreadPct).toBeCloseTo(2, 9);
  });

  it("negative net carry → repay", () => {
    // apy 5.5% − borrow 5% = 0.5% gross − 1% haircut = -0.5% net <= 0 → repay.
    const rec = decideCarryTrade({
      rankedYields: [yld(5.5)],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("repay");
    expect(rec.reason).toBe("repay_negative_carry");
    expect(rec.netSpreadPct).toBeCloseTo(-0.5, 9);
  });

  it("thin positive net carry (0 < net < min) → hold", () => {
    // apy 6.5% − borrow 5% = 1.5% gross − 1% haircut = 0.5% net, in (0, 1) → hold.
    const rec = decideCarryTrade({
      rankedYields: [yld(6.5)],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("hold");
    expect(rec.reason).toBe("hold_thin_spread");
    expect(rec.netSpreadPct).toBeCloseTo(0.5, 9);
  });

  it("boundary: net spread exactly == minimum → park (inclusive)", () => {
    // gross = min + haircut = 2% → net exactly 1% == min.
    const apy = (MIN_PARK + HAIRCUT) + 5; // borrow 5% below
    const rec = decideCarryTrade({
      rankedYields: [yld(apy)],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.netSpreadPct).toBeCloseTo(MIN_PARK, 9);
    expect(rec.action).toBe("park");
  });

  it("boundary: net spread exactly 0 → repay (inclusive of zero)", () => {
    // gross == haircut → net 0.
    const apy = HAIRCUT + 5; // borrow 5%
    const rec = decideCarryTrade({
      rankedYields: [yld(apy)],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.netSpreadPct).toBeCloseTo(0, 9);
    expect(rec.action).toBe("repay");
  });

  it("converts the borrow APR fraction to percent correctly", () => {
    // borrowApr 0.0466 → 4.66%; apy 10% → gross 5.34% − 1% = 4.34% net → park.
    const rec = decideCarryTrade({
      rankedYields: [yld(10)],
      borrowApr: 0.0466,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.grossSpreadPct).toBeCloseTo(5.34, 6);
    expect(rec.netSpreadPct).toBeCloseTo(4.34, 6);
    expect(rec.action).toBe("park");
  });

  it("never embeds an executable amount in the recommendation", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(8)],
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    // The recommendation surface has no amount/raw field the UI could submit blindly.
    expect(Object.keys(rec).sort()).toEqual(
      [
        "action",
        "bestAsset",
        "activeAsset",
        "blockedBy",
        "grossSpreadPct",
        "haircutPct",
        "message",
        "netSpreadPct",
        "reason",
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // Parked-vault awareness: when the bot is ALREADY parked somewhere, the carry
  // is judged on THAT vault, not on a better one it is not in.
  // -------------------------------------------------------------------------
  describe("when the bot is already parked", () => {
    it("regression: carry uses the PARKED vault's APY, not the best ranked vault", () => {
      // Best vault shows 50% but the bot is parked in a 6% vault. apy 6% − borrow
      // 5% = 1% gross − 1% haircut = 0% net <= 0 → repay. (If it wrongly used the
      // 50% best, it would say park.)
      const rec = decideCarryTrade({
        rankedYields: [yld(50, "onyc"), yld(6, "perena_usd")],
        currentParked: { assetKey: "perena_usd", displayName: "Perena USD*" },
        borrowApr: 0.05,
        healthSummary: health("healthy"),
        debtUsd: 100,
      });
      expect(rec.activeAsset?.assetKey).toBe("perena_usd");
      expect(rec.activeAsset?.isParked).toBe(true);
      expect(rec.activeAsset?.apyPct).toBeCloseTo(6, 9);
      // bestAsset is still reported for context, but the math used the parked vault.
      expect(rec.bestAsset?.assetKey).toBe("onyc");
      expect(rec.grossSpreadPct).toBeCloseTo(1, 9);
      expect(rec.netSpreadPct).toBeCloseTo(0, 9);
      expect(rec.action).toBe("repay");
      expect(rec.reason).toBe("repay_negative_carry");
    });

    it("parked with a healthy edge → HOLD (keep funds where they are), not park", () => {
      // Parked in a 10% vault, borrow 5% → 5% gross − 1% = 4% net >= 1% → hold.
      const rec = decideCarryTrade({
        rankedYields: [yld(50, "onyc"), yld(10, "perena_usd")],
        currentParked: { assetKey: "perena_usd", displayName: "Perena USD*" },
        borrowApr: 0.05,
        healthSummary: health("healthy"),
        debtUsd: 100,
      });
      expect(rec.action).toBe("hold");
      expect(rec.reason).toBe("hold_positive_carry");
      expect(rec.activeAsset?.isParked).toBe(true);
      expect(rec.activeAsset?.assetKey).toBe("perena_usd");
      expect(rec.netSpreadPct).toBeCloseTo(4, 9);
    });

    it("parked with a thin edge → hold (thin spread)", () => {
      // Parked 6.5% vault, borrow 5% → 1.5% gross − 1% = 0.5% net in (0,1) → hold.
      const rec = decideCarryTrade({
        rankedYields: [yld(50, "onyc"), yld(6.5, "perena_usd")],
        currentParked: { assetKey: "perena_usd", displayName: "Perena USD*" },
        borrowApr: 0.05,
        healthSummary: health("healthy"),
        debtUsd: 100,
      });
      expect(rec.action).toBe("hold");
      expect(rec.reason).toBe("hold_thin_spread");
      expect(rec.activeAsset?.isParked).toBe(true);
      expect(rec.netSpreadPct).toBeCloseTo(0.5, 9);
    });

    it("parked but the parked vault's yield is unmeasured → hold (fail closed)", () => {
      // Bot parked in an asset that is NOT in rankedYields → can't measure → hold.
      const rec = decideCarryTrade({
        rankedYields: [yld(50, "onyc")],
        currentParked: { assetKey: "perena_usd", displayName: "Perena USD*" },
        borrowApr: 0.05,
        healthSummary: health("healthy"),
        debtUsd: 100,
      });
      expect(rec.action).toBe("hold");
      expect(rec.reason).toBe("hold_parked_yield_unavailable");
      expect(rec.activeAsset?.assetKey).toBe("perena_usd");
      expect(rec.activeAsset?.isParked).toBe(true);
      expect(rec.activeAsset?.apyPct).toBeNull();
      expect(rec.grossSpreadPct).toBeNull();
      expect(rec.netSpreadPct).toBeNull();
    });

    it("parked but NO debt → hold_no_debt (debt gate fires before parked logic)", () => {
      const rec = decideCarryTrade({
        rankedYields: [yld(50, "onyc"), yld(6, "perena_usd")],
        currentParked: { assetKey: "perena_usd", displayName: "Perena USD*" },
        borrowApr: 0.05,
        healthSummary: health("healthy"),
        debtUsd: 0,
      });
      expect(rec.action).toBe("hold");
      expect(rec.reason).toBe("hold_no_debt");
    });

    it("parked but health is below healthy → repay (health overrides parked logic)", () => {
      const rec = decideCarryTrade({
        rankedYields: [yld(6, "perena_usd")],
        currentParked: { assetKey: "perena_usd", displayName: "Perena USD*" },
        borrowApr: 0.05,
        healthSummary: health("urgent"),
        debtUsd: 100,
      });
      expect(rec.action).toBe("repay");
      expect(rec.reason).toBe("repay_health_urgent");
    });

    it("parked in the SAME asset that is also the best vault → uses it, holds", () => {
      // Only one vault, the bot is parked in it. 8% − 5% = 3% − 1% = 2% net → hold.
      const rec = decideCarryTrade({
        rankedYields: [yld(8, "onyc")],
        currentParked: { assetKey: "onyc", displayName: "OnRe ONyc" },
        borrowApr: 0.05,
        healthSummary: health("healthy"),
        debtUsd: 100,
      });
      expect(rec.action).toBe("hold");
      expect(rec.reason).toBe("hold_positive_carry");
      expect(rec.activeAsset?.assetKey).toBe("onyc");
      expect(rec.activeAsset?.isParked).toBe(true);
    });
  });

  it("not parked (currentParked null) behaves exactly as before → park to best", () => {
    const rec = decideCarryTrade({
      rankedYields: [yld(8, "kamino_usdc")],
      currentParked: null,
      borrowApr: 0.05,
      healthSummary: health("healthy"),
      debtUsd: 100,
    });
    expect(rec.action).toBe("park");
    expect(rec.reason).toBe("park_positive_carry");
    expect(rec.activeAsset?.assetKey).toBe("kamino_usdc");
    expect(rec.activeAsset?.isParked).toBe(false);
  });
});
