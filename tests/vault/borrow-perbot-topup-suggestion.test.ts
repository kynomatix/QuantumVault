import { describe, it, expect } from "vitest";
import {
  computePerbotTopUpSuggestion,
  derivePerbotTopUpSuggestion,
} from "../../server/vault/borrow-health";
import type {
  BorrowVaultConfig,
  LivePositionHealth,
} from "../../server/vault/jupiter-lend-borrow-route";

// ---------------------------------------------------------------------------
// Fixtures mirror borrow-perbot-health.test.ts: collateral priced at $1 with 9
// decimals, USDC debt at 6 decimals, liquidation threshold 0.80. The DEFEND
// math targets LTV 0.5 (PERBOT_CARVE_DEFAULT_TARGET_LTV): required collateral
// USD = debtUsd / 0.5, additional = required - currentCollateralUsd.
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

function live(
  collTokens: number,
  debtUsd: number,
  overrides: Partial<LivePositionHealth> = {},
): LivePositionHealth {
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
    ...overrides,
  };
}

describe("computePerbotTopUpSuggestion", () => {
  it("suggests 0 when already below target LTV", () => {
    // coll $100, debt $40 → LTV 0.40 < 0.50
    const s = computePerbotTopUpSuggestion({
      debtUsd: 40,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
    });
    expect(s).not.toBeNull();
    expect(s!.suggestedCollateralRaw).toBe(0n);
    expect(s!.targetLtv).toBe(0.5);
  });

  it("suggests 0 exactly at target LTV", () => {
    // coll $100, debt $50 → LTV 0.50
    const s = computePerbotTopUpSuggestion({
      debtUsd: 50,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
    });
    expect(s!.suggestedCollateralRaw).toBe(0n);
  });

  it("sizes the shortfall to restore 0.5 LTV (urgent)", () => {
    // coll $100, debt $64 → required $128, additional $28 → 28 tokens
    const s = computePerbotTopUpSuggestion({
      debtUsd: 64,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
    });
    expect(s!.suggestedCollateralRaw).toBe(28_000_000_000n);
    expect(s!.suggestedCollateralTokens).toBeCloseTo(28, 6);
    expect(s!.suggestedCollateralUsd).toBeCloseTo(28, 6);
  });

  it("sizes the shortfall in the liquidation band", () => {
    // coll $100, debt $80 → required $160, additional $60 → 60 tokens
    const s = computePerbotTopUpSuggestion({
      debtUsd: 80,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
    });
    expect(s!.suggestedCollateralRaw).toBe(60_000_000_000n);
  });

  it("honours a custom target LTV", () => {
    // coll $100, debt $50, target 0.4 → required $125, additional $25
    const s = computePerbotTopUpSuggestion({
      debtUsd: 50,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      targetLtv: 0.4,
    });
    expect(s!.suggestedCollateralRaw).toBe(25_000_000_000n);
    expect(s!.targetLtv).toBe(0.4);
  });

  it("converts additional USD to tokens at the collateral price", () => {
    // price $2/token, coll $100 (50 tokens), debt $100 → required $200,
    // additional $100 → 50 tokens
    const s = computePerbotTopUpSuggestion({
      debtUsd: 100,
      collateralValueUsd: 100,
      collateralPriceUsd: 2,
      collateralDecimals: 9,
    });
    expect(s!.suggestedCollateralRaw).toBe(50_000_000_000n);
  });

  it("rounds the raw amount UP (never just-misses the target)", () => {
    // 6-dp token at $3, additional $1 → 0.333333... tokens → 333333.33 raw → 333334
    const s = computePerbotTopUpSuggestion({
      debtUsd: 1.5, // required $3 at 0.5
      collateralValueUsd: 2, // additional $1
      collateralPriceUsd: 3,
      collateralDecimals: 6,
    });
    expect(s!.suggestedCollateralRaw).toBe(333_334n);
  });

  it("fails closed (null) on unreadable facts", () => {
    const base = {
      debtUsd: 64,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
    };
    expect(computePerbotTopUpSuggestion({ ...base, collateralPriceUsd: 0 })).toBeNull();
    expect(computePerbotTopUpSuggestion({ ...base, collateralPriceUsd: -1 })).toBeNull();
    expect(computePerbotTopUpSuggestion({ ...base, debtUsd: -1 })).toBeNull();
    expect(computePerbotTopUpSuggestion({ ...base, collateralValueUsd: NaN })).toBeNull();
    expect(computePerbotTopUpSuggestion({ ...base, collateralDecimals: 19 })).toBeNull();
    expect(computePerbotTopUpSuggestion({ ...base, targetLtv: 0 })).toBeNull();
    expect(computePerbotTopUpSuggestion({ ...base, targetLtv: 1.5 })).toBeNull();
  });

  it("suggests 0 for a zero-debt position", () => {
    const s = computePerbotTopUpSuggestion({
      debtUsd: 0,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
    });
    expect(s!.suggestedCollateralRaw).toBe(0n);
  });
});

describe("derivePerbotTopUpSuggestion", () => {
  it("fails closed when vault or live is unreadable", () => {
    expect(derivePerbotTopUpSuggestion(live(100, 64), null)).toBeNull();
    expect(derivePerbotTopUpSuggestion(null, vault())).toBeNull();
  });

  it("derives the same shortfall the health read would imply (urgent)", () => {
    // coll 100 tokens ($100), debt $64 → additional 28 tokens
    const s = derivePerbotTopUpSuggestion(live(100, 64), vault());
    expect(s!.suggestedCollateralRaw).toBe(28_000_000_000n);
  });

  it("fails closed when the liquidation oracle price is unreadable", () => {
    const s = derivePerbotTopUpSuggestion(
      live(100, 64),
      vault({ oraclePriceLiquidateUsd: 0 }),
    );
    expect(s).toBeNull();
  });

  it("fails closed on unparseable on-chain amounts", () => {
    const bad = live(100, 64, { collateralRaw: "not-a-number" });
    expect(derivePerbotTopUpSuggestion(bad, vault())).toBeNull();
  });

  it("suggests 0 for a healthy position", () => {
    const s = derivePerbotTopUpSuggestion(live(100, 40), vault());
    expect(s!.suggestedCollateralRaw).toBe(0n);
  });
});
