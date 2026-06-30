import { describe, it, expect } from "vitest";
import {
  classifyBorrowHealthBand,
  computePerBotPositionHealth,
  summarizeBotBorrowHealth,
  type PerBotPositionHealth,
} from "../../server/vault/borrow-health";
import type {
  BorrowVaultConfig,
  LivePositionHealth,
} from "../../server/vault/jupiter-lend-borrow-route";

// ---------------------------------------------------------------------------
// Fixtures. A stable-ish collateral priced at $1 with 9 decimals, USDC debt at
// 6 decimals, liquidation threshold 0.80. HF = (collUsd * 0.8) / debtUsd, so
// with 100 collateral tokens (collUsd $100): debt $40 → HF 2.0 (healthy),
// $50 → 1.6 (nudge), $64 → 1.25 (urgent), $80 → 1.0 (liquidation).
// ---------------------------------------------------------------------------
function vault(overrides: Partial<BorrowVaultConfig> = {}): BorrowVaultConfig {
  return {
    vaultId: 43,
    vaultAddress: "VaultAddr",
    oracleAddress: "OracleAddr",
    collateralMint: "InfMint",
    collateralSymbol: "INF",
    collateralDecimals: 9,
    debtMint: "UsdcMint",
    debtSymbol: "USDC",
    debtDecimals: 6,
    maxLtv: 0.75,
    liquidationThreshold: 0.8,
    liquidationPenalty: 0.05,
    borrowApr: 0.0466,
    supplyApr: 0.02,
    borrowFee: 0,
    utilization: 0.5,
    oraclePriceLiquidateUsd: 1,
    oraclePriceOperateUsd: 1,
    marketPriceUsd: 1,
    borrowableUsdcRaw: "1000000000",
    withdrawableCollateralRaw: "1000000000",
    minimumBorrowingRaw: "1000000",
    ...overrides,
  };
}

/** Live position with `collTokens` collateral and `debtUsd` USDC debt. */
function live(collTokens: number, debtUsd: number): LivePositionHealth {
  const collateralRaw = BigInt(Math.round(collTokens * 1e9)).toString();
  const debtRaw = BigInt(Math.round(debtUsd * 1e6)).toString();
  return {
    vaultId: 43,
    positionId: 7,
    collateralRaw,
    debtRaw,
    maxRepayNativeRaw: debtRaw,
    liquidatable: false,
    tick: 0,
    oraclePriceUsd: 1,
  };
}

function pos(overrides: Partial<PerBotPositionHealth>): PerBotPositionHealth {
  return {
    borrowPositionId: "p",
    venuePositionId: 7,
    collateralAssetKey: "inf",
    collateralMint: "InfMint",
    status: "available",
    collateralValueUsd: 100,
    debtUsd: 40,
    ltv: 0.4,
    healthFactor: 2.0,
    liquidatable: false,
    band: "healthy",
    ...overrides,
  };
}

const compute = (l: LivePositionHealth | null, v: BorrowVaultConfig | null) =>
  computePerBotPositionHealth({
    borrowPositionId: "p1",
    venuePositionId: 7,
    collateralAssetKey: "inf",
    collateralMint: "InfMint",
    live: l,
    vault: v,
  });

describe("classifyBorrowHealthBand", () => {
  it("no debt is always healthy (no liquidation risk)", () => {
    expect(classifyBorrowHealthBand(null, false)).toBe("healthy");
    expect(classifyBorrowHealthBand(0.1, false)).toBe("healthy");
  });
  it("debt with an unreadable HF fails closed to unavailable", () => {
    expect(classifyBorrowHealthBand(null, true)).toBe("unavailable");
    expect(classifyBorrowHealthBand(Infinity, true)).toBe("unavailable");
    expect(classifyBorrowHealthBand(NaN, true)).toBe("unavailable");
  });
  it("bands match the enforced thresholds (1.0 / 1.3 / 1.6)", () => {
    expect(classifyBorrowHealthBand(2.0, true)).toBe("healthy");
    expect(classifyBorrowHealthBand(1.61, true)).toBe("healthy");
    expect(classifyBorrowHealthBand(1.6, true)).toBe("nudge");
    expect(classifyBorrowHealthBand(1.31, true)).toBe("nudge");
    expect(classifyBorrowHealthBand(1.3, true)).toBe("urgent");
    expect(classifyBorrowHealthBand(1.01, true)).toBe("urgent");
    expect(classifyBorrowHealthBand(1.0, true)).toBe("liquidation");
    expect(classifyBorrowHealthBand(0.5, true)).toBe("liquidation");
  });
});

describe("computePerBotPositionHealth (fail closed)", () => {
  it("unreadable vault config → unavailable", () => {
    const r = compute(live(100, 40), null);
    expect(r.status).toBe("unavailable");
    expect(r.band).toBe("unavailable");
    expect(r.healthFactor).toBeNull();
    expect(r.reason).toMatch(/vault/i);
  });
  it("unreadable live position → unavailable", () => {
    const r = compute(null, vault());
    expect(r.status).toBe("unavailable");
    expect(r.band).toBe("unavailable");
  });
  it("debt present but unreadable collateral price → unavailable", () => {
    const r = compute(live(100, 40), vault({ oraclePriceLiquidateUsd: 0 }));
    expect(r.status).toBe("unavailable");
    expect(r.band).toBe("unavailable");
  });
  it("zero debt is healthy even when the price is unreadable", () => {
    const r = compute(live(100, 0), vault({ oraclePriceLiquidateUsd: 0 }));
    expect(r.status).toBe("available");
    expect(r.band).toBe("healthy");
    expect(r.healthFactor).toBeNull();
    expect(r.ltv).toBeNull(); // value unreadable, but no liq risk
  });
  it("zero debt with a readable price → healthy, HF null, LTV 0", () => {
    const r = compute(live(100, 0), vault());
    expect(r.status).toBe("available");
    expect(r.band).toBe("healthy");
    expect(r.healthFactor).toBeNull();
    expect(r.ltv).toBe(0);
    expect(r.collateralValueUsd).toBe(100);
  });
  it("computes a healthy position's HF + LTV", () => {
    const r = compute(live(100, 40), vault());
    expect(r.status).toBe("available");
    expect(r.collateralValueUsd).toBe(100);
    expect(r.debtUsd).toBe(40);
    expect(r.healthFactor).toBeCloseTo(2.0, 6);
    expect(r.ltv).toBeCloseTo(0.4, 6);
    expect(r.band).toBe("healthy");
  });
  it("classifies nudge / urgent / liquidation by debt level", () => {
    expect(compute(live(100, 50), vault()).band).toBe("nudge"); // HF 1.6
    expect(compute(live(100, 64), vault()).band).toBe("urgent"); // HF 1.25
    expect(compute(live(100, 80), vault()).band).toBe("liquidation"); // HF 1.0
  });
  it("invalid vault decimals → unavailable", () => {
    const r = compute(live(100, 40), vault({ debtDecimals: 99 }));
    expect(r.status).toBe("unavailable");
  });
  it("protocol liquidatable flag DOMINATES a computed-healthy HF", () => {
    // HF computes to a healthy 2.0, but the protocol marks it liquidatable
    // (price/threshold/timing drift). Fail closed: report liquidation anyway.
    const r = compute({ ...live(100, 40), liquidatable: true }, vault());
    expect(r.status).toBe("available");
    expect(r.healthFactor).toBeCloseTo(2.0, 6); // computed HF still surfaced
    expect(r.liquidatable).toBe(true);
    expect(r.band).toBe("liquidation"); // band overridden to worst
  });
  it("a zero-debt position is healthy even if liquidatable is spuriously set", () => {
    const r = compute({ ...live(100, 0), liquidatable: true }, vault());
    expect(r.status).toBe("available");
    expect(r.band).toBe("healthy"); // no debt = no liquidation risk
    expect(r.healthFactor).toBeNull();
  });
});

describe("summarizeBotBorrowHealth (headline = worst)", () => {
  it("empty → not applicable, nothing blocked", () => {
    const s = summarizeBotBorrowHealth([]);
    expect(s.applicable).toBe(false);
    expect(s.headline.band).toBe("healthy");
    expect(s.headline.actionBlocked).toBe(false);
    expect(s.headline.healthFactor).toBeNull();
  });
  it("single healthy position", () => {
    const s = summarizeBotBorrowHealth([pos({ healthFactor: 2.0, band: "healthy" })]);
    expect(s.applicable).toBe(true);
    expect(s.headline.band).toBe("healthy");
    expect(s.headline.healthFactor).toBeCloseTo(2.0, 6);
    expect(s.headline.actionBlocked).toBe(false);
  });
  it("worst-of-many drives the headline band + lowest HF", () => {
    const s = summarizeBotBorrowHealth([
      pos({ borrowPositionId: "a", healthFactor: 2.0, band: "healthy" }),
      pos({ borrowPositionId: "b", healthFactor: 1.25, band: "urgent" }),
    ]);
    expect(s.headline.band).toBe("urgent");
    expect(s.headline.healthFactor).toBeCloseTo(1.25, 6);
    expect(s.headline.actionBlocked).toBe(false);
  });
  it("any unavailable position blocks the headline (fail closed)", () => {
    const s = summarizeBotBorrowHealth([
      pos({ borrowPositionId: "a", healthFactor: 2.0, band: "healthy" }),
      pos({
        borrowPositionId: "b",
        status: "unavailable",
        healthFactor: null,
        band: "unavailable",
        reason: "unreadable",
      }),
    ]);
    expect(s.headline.band).toBe("unavailable");
    expect(s.headline.actionBlocked).toBe(true);
    // headline HF still reports the worst readable one (the healthy 2.0).
    expect(s.headline.healthFactor).toBeCloseTo(2.0, 6);
  });
  it("a zero-debt (HF null) position does not lower the headline HF", () => {
    const s = summarizeBotBorrowHealth([
      pos({ borrowPositionId: "a", healthFactor: null, debtUsd: 0, ltv: 0, band: "healthy" }),
      pos({ borrowPositionId: "b", healthFactor: 1.6, band: "nudge" }),
    ]);
    expect(s.headline.band).toBe("nudge");
    expect(s.headline.healthFactor).toBeCloseTo(1.6, 6);
  });
});
