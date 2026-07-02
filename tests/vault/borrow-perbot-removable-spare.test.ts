import { describe, it, expect } from "vitest";
import {
  computePerbotRemovableSpare,
  derivePerbotRemovableSpare,
} from "../../server/vault/borrow-health";
import type {
  BorrowVaultConfig,
  LivePositionHealth,
} from "../../server/vault/jupiter-lend-borrow-route";

// ---------------------------------------------------------------------------
// Fixtures mirror borrow-perbot-topup-suggestion.test.ts: collateral priced at
// $1 with 9 decimals, USDC debt at 6 decimals. The REMOVE math is the exact
// mirror of the top-up shortfall against target LTV 0.5
// (PERBOT_CARVE_DEFAULT_TARGET_LTV): required collateral USD = debtUsd / 0.5,
// spare = currentCollateralUsd - required, rounded DOWN and capped at the live
// raw collateral.
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

describe("computePerbotRemovableSpare", () => {
  it("reports 0 spare at exactly the target LTV", () => {
    // coll $100, debt $50 → required $100 → spare $0
    const s = computePerbotRemovableSpare({
      debtUsd: 50,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: 100_000_000_000n,
    });
    expect(s).not.toBeNull();
    expect(s!.removableRaw).toBe(0n);
    expect(s!.targetLtv).toBe(0.5);
  });

  it("reports 0 spare above the target LTV (never negative)", () => {
    // coll $100, debt $64 → required $128 → spare negative → 0
    const s = computePerbotRemovableSpare({
      debtUsd: 64,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: 100_000_000_000n,
    });
    expect(s!.removableRaw).toBe(0n);
  });

  it("sizes the spare below the target LTV", () => {
    // coll $100, debt $40 → required $80 → spare $20 → 20 tokens
    const s = computePerbotRemovableSpare({
      debtUsd: 40,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: 100_000_000_000n,
    });
    expect(s!.removableRaw).toBe(20_000_000_000n);
    expect(s!.removableTokens).toBeCloseTo(20, 6);
    expect(s!.removableUsd).toBeCloseTo(20, 6);
  });

  it("zero debt makes the ENTIRE live collateral spare — exact raw pass-through", () => {
    // A raw amount chosen so a float round-trip would corrupt it.
    const exactRaw = 123_456_789_123_456_789n;
    const s = computePerbotRemovableSpare({
      debtUsd: 0,
      collateralValueUsd: 123_456_789.123,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: exactRaw,
    });
    expect(s!.removableRaw).toBe(exactRaw);
  });

  it("caps the spare at the live raw collateral (never more than held)", () => {
    // Oracle values imply $60 spare but the position only holds 50 tokens raw.
    const s = computePerbotRemovableSpare({
      debtUsd: 20,
      collateralValueUsd: 100, // implies 100 tokens at $1 — inconsistent on purpose
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: 50_000_000_000n,
    });
    expect(s!.removableRaw).toBe(50_000_000_000n);
  });

  it("converts spare USD to tokens at the collateral price", () => {
    // price $2/token, coll $100 (50 tokens), debt $20 → required $40 → spare $60 → 30 tokens
    const s = computePerbotRemovableSpare({
      debtUsd: 20,
      collateralValueUsd: 100,
      collateralPriceUsd: 2,
      collateralDecimals: 9,
      collateralRaw: 50_000_000_000n,
    });
    expect(s!.removableRaw).toBe(30_000_000_000n);
  });

  it("rounds the raw amount DOWN (remainder can never pass the target)", () => {
    // 6-dp token at $3, spare $1 → 0.333333... tokens → 333333.33 raw → 333333
    const s = computePerbotRemovableSpare({
      debtUsd: 1.5, // required $3 at 0.5
      collateralValueUsd: 4, // spare $1
      collateralPriceUsd: 3,
      collateralDecimals: 6,
      collateralRaw: 10_000_000n,
    });
    expect(s!.removableRaw).toBe(333_333n);
  });

  it("honours a custom target LTV", () => {
    // coll $100, debt $40, target 0.8 → required $50 → spare $50
    const s = computePerbotRemovableSpare({
      debtUsd: 40,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: 100_000_000_000n,
      targetLtv: 0.8,
    });
    expect(s!.removableRaw).toBe(50_000_000_000n);
    expect(s!.targetLtv).toBe(0.8);
  });

  it("fails closed (null) on unreadable facts", () => {
    const base = {
      debtUsd: 40,
      collateralValueUsd: 100,
      collateralPriceUsd: 1,
      collateralDecimals: 9,
      collateralRaw: 100_000_000_000n,
    };
    expect(computePerbotRemovableSpare({ ...base, collateralPriceUsd: 0 })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, collateralPriceUsd: -1 })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, debtUsd: -1 })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, collateralValueUsd: NaN })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, collateralDecimals: 19 })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, collateralRaw: -1n })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, targetLtv: 0 })).toBeNull();
    expect(computePerbotRemovableSpare({ ...base, targetLtv: 1.5 })).toBeNull();
  });
});

describe("derivePerbotRemovableSpare", () => {
  it("fails closed when vault or live is unreadable", () => {
    expect(derivePerbotRemovableSpare(live(100, 40), null)).toBeNull();
    expect(derivePerbotRemovableSpare(null, vault())).toBeNull();
  });

  it("derives the same spare the health read would imply", () => {
    // coll 100 tokens ($100), debt $40 → spare 20 tokens
    const s = derivePerbotRemovableSpare(live(100, 40), vault());
    expect(s!.removableRaw).toBe(20_000_000_000n);
  });

  it("fails closed when the liquidation oracle price is unreadable", () => {
    const s = derivePerbotRemovableSpare(
      live(100, 40),
      vault({ oraclePriceLiquidateUsd: 0 }),
    );
    expect(s).toBeNull();
  });

  it("fails closed on unparseable on-chain amounts", () => {
    const bad = live(100, 40, { collateralRaw: "not-a-number" });
    expect(derivePerbotRemovableSpare(bad, vault())).toBeNull();
  });

  it("reports 0 spare for a position at/above target", () => {
    expect(derivePerbotRemovableSpare(live(100, 50), vault())!.removableRaw).toBe(0n);
    expect(derivePerbotRemovableSpare(live(100, 64), vault())!.removableRaw).toBe(0n);
  });

  it("zero-debt position: whole live collateral is spare, exact raw", () => {
    const l = live(100, 0, { collateralRaw: "123456789123456789" });
    const s = derivePerbotRemovableSpare(l, vault());
    expect(s!.removableRaw).toBe(123_456_789_123_456_789n);
  });

  it("mirror check: topping up the removed spare restores exactly the target", () => {
    // Start below target: coll $100, debt $40 → spare 20. After removing 20 the
    // remainder is coll $80, debt $40 → LTV exactly 0.5 (the target).
    const s = derivePerbotRemovableSpare(live(100, 40), vault());
    const remainderTokens = 100 - s!.removableTokens;
    expect((40 / remainderTokens)).toBeCloseTo(0.5, 9);
  });
});
