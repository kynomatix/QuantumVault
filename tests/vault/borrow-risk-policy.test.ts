import { describe, it, expect } from "vitest";
import { decodeVaultConfig, type BorrowVaultConfig } from "../../server/vault/jupiter-lend-borrow-route";
import {
  evaluateBorrowRequest,
  computeCarryProfitFee,
  BORROW_RISK_POLICY,
  type BorrowPolicyInput,
} from "../../server/vault/borrow-risk-policy";

/** Live INF→USDC vault snapshot (id 43, 2026-06-24). Pure — no network. */
const RAW_INF = {
  id: 43,
  address: "VaultAddrPlaceholder1111111111111111111111",
  oracle: "OracleAddrPlaceholder111111111111111111111",
  supplyToken: { address: "INFmintPlaceholder11111111111111111111111", symbol: "INF", decimals: 9, price: "99.249552485649" },
  borrowToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, price: "1" },
  collateralFactor: "750",
  liquidationThreshold: "800",
  liquidationPenalty: "500",
  borrowRate: "466",
  supplyRate: "0",
  borrowFee: "0",
  borrowLimitUtilization: "405783379446790",
  minimumBorrowing: "1034775",
  borrowable: "5838249171951",
  withdrawable: "11610714005191",
  oraclePriceLiquidate: "98865597964440443",
  oraclePriceOperate: "98865597964440443",
};

const baseConfig = (): BorrowVaultConfig => {
  const c = decodeVaultConfig(RAW_INF);
  if (!c) throw new Error("INF config failed to decode");
  return c;
};

/** A fully valid, allowed borrow: 100 INF (~$9,886) collateral, borrow 1,000 USDC (~10% LTV). */
const validInput = (over: Partial<BorrowPolicyInput> = {}): BorrowPolicyInput => ({
  scope: "account",
  walletAddress: "OwnerWallet1111111111111111111111111111111",
  isOwnerWallet: true,
  isBorrowAllowlisted: true,
  collateralAllowlisted: true,
  collateralMint: "INFmintPlaceholder11111111111111111111111",
  collateralSymbol: "INF",
  collateralRaw: 100_000_000_000n, // 100 INF
  existingDebtRaw: 0n,
  requestedDebtRaw: 1_000_000_000n, // 1,000 USDC
  vault: baseConfig(),
  exposure: { aggregateDebtUsd: 0, collateralDebtUsd: 0 },
  oracle: { publishAgeSec: 30, priceMove1hAbs: 0.02 },
  ...over,
});

const codes = (d: ReturnType<typeof evaluateBorrowRequest>) => d.reasons.map((r) => r.code);
const denied = (d: ReturnType<typeof evaluateBorrowRequest>) =>
  d.reasons.filter((r) => r.severity === "deny").map((r) => r.code);

describe("BORROW_RISK_POLICY ratified constants", () => {
  it("encodes the owner's Decision Wall numbers", () => {
    expect(BORROW_RISK_POLICY.recommendedMaxLtv).toBe(0.5);
    expect(BORROW_RISK_POLICY.hardMaxLtv).toBe(0.9);
    expect(BORROW_RISK_POLICY.circuitBreakers.borrowAprCeiling).toBe(0.15);
    expect(BORROW_RISK_POLICY.circuitBreakers.utilizationCeiling).toBe(0.9);
    expect(BORROW_RISK_POLICY.circuitBreakers.aggregateExposureCapUsd).toBe(50_000);
    expect(BORROW_RISK_POLICY.circuitBreakers.perCollateralConcentrationMax).toBe(0.5);
    expect(BORROW_RISK_POLICY.circuitBreakers.oracleMaxAgeSec).toBe(120);
    expect(BORROW_RISK_POLICY.circuitBreakers.priceMove1hCeiling).toBe(0.15);
    expect(BORROW_RISK_POLICY.alerts.healthFactorNudge).toBe(1.6);
    expect(BORROW_RISK_POLICY.alerts.healthFactorUrgent).toBe(1.3);
    expect(BORROW_RISK_POLICY.fee.carryProfitShareBps).toBe(1000);
  });
});

describe("evaluateBorrowRequest — valid path", () => {
  it("allows a conservative owner borrow well under the cap", () => {
    const d = evaluateBorrowRequest(validInput());
    expect(d.allowed).toBe(true);
    expect(denied(d)).toHaveLength(0);
    expect(d.projectedLtv).toBeCloseTo(0.1012, 3);
    expect(d.effectiveMaxLtv).toBe(0.75); // min(0.90 backstop, 0.75 protocol) = protocol ceiling
    expect(d.projectedHealthFactor).not.toBeNull();
    expect(d.projectedHealthFactor as number).toBeGreaterThan(BORROW_RISK_POLICY.alerts.healthFactorNudge);
  });

  it("reports a max-additional-debt hint bounded by the protocol max LTV", () => {
    const d = evaluateBorrowRequest(validInput());
    // 0.75 * ~$9,886 collateral ≈ $7,415 → ~7.415e9 raw (6 decimals).
    const maxUsd = Number(d.maxAllowedAdditionalDebtRaw) / 1e6;
    expect(maxUsd).toBeCloseTo(0.75 * (d.collateralValueUsd as number), 0);
  });
});

describe("evaluateBorrowRequest — hard denies", () => {
  it("denies borrowing above the protocol's own max LTV ceiling (75% for INF)", () => {
    const d = evaluateBorrowRequest(validInput({ requestedDebtRaw: 7_600_000_000n })); // ~77% LTV, over INF's 75%
    expect(d.allowed).toBe(false);
    expect(denied(d)).toContain("exceeds_max_ltv");
    const r = d.reasons.find((x) => x.code === "exceeds_max_ltv");
    expect(r?.facts?.bound).toBe("protocol_max_ltv");
  });

  it("allows borrowing above the recommended 50% up to the protocol max, with a warning", () => {
    // ~60% LTV: denied by the old 30% force; now allowed (under INF's 75%) but warned.
    const d = evaluateBorrowRequest(validInput({ requestedDebtRaw: 5_900_000_000n }));
    expect(d.allowed).toBe(true);
    expect(denied(d)).toHaveLength(0);
    expect(codes(d)).toContain("above_recommended_ltv");
  });

  it("denies a non-account scope (MVP is account-only)", () => {
    const d = evaluateBorrowRequest(validInput({ scope: "bot" }));
    expect(denied(d)).toContain("scope_not_supported");
  });

  it("denies a wallet that is neither owner nor allowlisted", () => {
    const d = evaluateBorrowRequest(validInput({ isOwnerWallet: false, isBorrowAllowlisted: false }));
    expect(denied(d)).toContain("not_borrow_allowlisted");
  });

  it("denies a collateral not on the launch allowlist", () => {
    const d = evaluateBorrowRequest(validInput({ collateralAllowlisted: false }));
    expect(denied(d)).toContain("collateral_not_allowlisted");
  });

  it("denies a zero / negative borrow", () => {
    expect(denied(evaluateBorrowRequest(validInput({ requestedDebtRaw: 0n })))).toContain("non_positive_borrow");
  });

  it("denies below the protocol minimum borrow", () => {
    const d = evaluateBorrowRequest(validInput({ requestedDebtRaw: 500_000n })); // 0.5 USDC < 1.03 min
    expect(denied(d)).toContain("below_protocol_minimum");
  });

  it("denies more than the pool can currently lend", () => {
    const d = evaluateBorrowRequest(
      validInput({ collateralRaw: 300_000_000_000_000n, requestedDebtRaw: 6_000_000_000_000n }),
    );
    expect(denied(d)).toContain("exceeds_live_borrowable");
  });

  it("denies when the borrow APR is above the ceiling", () => {
    const d = evaluateBorrowRequest(validInput({ vault: { ...baseConfig(), borrowApr: 0.2 } }));
    expect(denied(d)).toContain("borrow_apr_too_high");
  });

  it("denies when pool utilization is above the ceiling", () => {
    const d = evaluateBorrowRequest(validInput({ vault: { ...baseConfig(), utilization: 0.95 } }));
    expect(denied(d)).toContain("utilization_too_high");
  });

  it("denies when the platform aggregate exposure cap would be exceeded", () => {
    const d = evaluateBorrowRequest(
      validInput({ exposure: { aggregateDebtUsd: 49_500, collateralDebtUsd: 0 } }),
    );
    expect(denied(d)).toContain("aggregate_exposure_cap");
  });

  it("denies a stale or unreadable oracle (fail closed)", () => {
    expect(denied(evaluateBorrowRequest(validInput({ oracle: { publishAgeSec: null, priceMove1hAbs: 0.02 } })))).toContain(
      "oracle_unreadable",
    );
    expect(denied(evaluateBorrowRequest(validInput({ oracle: { publishAgeSec: 300, priceMove1hAbs: 0.02 } })))).toContain(
      "oracle_stale",
    );
  });

  it("freezes on unreadable or excessive 1h price volatility (fail closed)", () => {
    expect(denied(evaluateBorrowRequest(validInput({ oracle: { publishAgeSec: 30, priceMove1hAbs: null } })))).toContain(
      "price_move_unreadable",
    );
    expect(denied(evaluateBorrowRequest(validInput({ oracle: { publishAgeSec: 30, priceMove1hAbs: 0.2 } })))).toContain(
      "price_volatility_freeze",
    );
  });

  it("warns (no longer denies) opening a loan in the urgent health band, but still denies past the protocol max", () => {
    // Low liquidation threshold so an allowed (under the protocol max) LTV still yields thin health.
    const lowLiq = { ...baseConfig(), maxLtv: 0.34, liquidationThreshold: 0.35 };
    const warned = evaluateBorrowRequest(validInput({ vault: lowLiq, requestedDebtRaw: 2_900_000_000n }));
    expect(warned.allowed).toBe(true); // ~29% LTV, health ~1.19 → danger-zone WARNING, not a deny
    expect(codes(warned)).toContain("health_below_urgent");
    expect(denied(warned)).not.toContain("health_below_urgent");
    expect(denied(warned)).not.toContain("exceeds_max_ltv");

    // Pushing past the protocol's own max LTV is still refused (the hard ceiling holds).
    const blocked = evaluateBorrowRequest(validInput({ vault: lowLiq, requestedDebtRaw: 3_400_000_000n }));
    expect(blocked.allowed).toBe(false);
    expect(denied(blocked)).toContain("exceeds_max_ltv");
  });

  it("denies opening a loan at or below the liquidation health floor (the ONE hard health deny)", () => {
    // maxLtv 0.6 keeps the request under the protocol ceiling, but a low 0.40
    // liquidation threshold means ~50% LTV already lands health at or below 1.0.
    const fragile = { ...baseConfig(), maxLtv: 0.6, liquidationThreshold: 0.4 };
    const d = evaluateBorrowRequest(validInput({ vault: fragile, requestedDebtRaw: 5_000_000_000n }));
    expect(d.allowed).toBe(false);
    expect(d.projectedHealthFactor as number).toBeLessThanOrEqual(BORROW_RISK_POLICY.alerts.liquidation);
    expect(denied(d)).toContain("health_below_liquidation");
    // Under the protocol ceiling, so liquidation — not the LTV cap — is the binding floor.
    expect(denied(d)).not.toContain("exceeds_max_ltv");
  });
});

describe("evaluateBorrowRequest — concentration bootstrap", () => {
  it("does NOT deny a single-asset book even above the concentration floor", () => {
    // 1,000 INF (~$98,865) collateral, borrow 12,000 USDC → 100% concentrated but first asset.
    const d = evaluateBorrowRequest(
      validInput({ collateralRaw: 1_000_000_000_000n, requestedDebtRaw: 12_000_000_000n }),
    );
    expect(codes(d)).not.toContain("concentration_cap");
    expect(d.allowed).toBe(true);
  });

  it("denies once another collateral exists and the book is sizable", () => {
    const d = evaluateBorrowRequest(
      validInput({
        collateralRaw: 1_000_000_000_000n,
        requestedDebtRaw: 1_000_000_000n,
        exposure: { aggregateDebtUsd: 30_000, collateralDebtUsd: 25_000 },
      }),
    );
    expect(denied(d)).toContain("concentration_cap");
  });
});

describe("evaluateBorrowRequest — input sanity (fail closed, never throws)", () => {
  it("denies (not allows, not throws) when vault rate facts are NaN", () => {
    const d = evaluateBorrowRequest(
      validInput({
        vault: { ...baseConfig(), borrowApr: Number.NaN, utilization: Number.NaN, liquidationThreshold: Number.NaN },
      }),
    );
    expect(d.allowed).toBe(false);
    expect(denied(d)).toContain("invalid_inputs");
    const r = d.reasons.find((x) => x.code === "invalid_inputs");
    expect(r?.facts?.fields).toEqual(expect.arrayContaining(["liquidationThreshold", "borrowApr", "utilization"]));
  });

  it("denies an Infinity oracle price", () => {
    const d = evaluateBorrowRequest(validInput({ vault: { ...baseConfig(), oraclePriceLiquidateUsd: Infinity } }));
    expect(denied(d)).toContain("invalid_inputs");
  });

  it("denies negative exposure numbers", () => {
    const d = evaluateBorrowRequest(
      validInput({ exposure: { aggregateDebtUsd: -1, collateralDebtUsd: -5 } }),
    );
    expect(denied(d)).toContain("invalid_inputs");
    expect((d.reasons.find((x) => x.code === "invalid_inputs")?.facts?.fields as string[])).toEqual(
      expect.arrayContaining(["exposure.aggregateDebtUsd", "exposure.collateralDebtUsd"]),
    );
  });

  it("denies (does not throw) on an unparseable raw string from the vault", () => {
    const d = evaluateBorrowRequest(
      validInput({ vault: { ...baseConfig(), minimumBorrowingRaw: "not-a-number", borrowableUsdcRaw: "" } }),
    );
    expect(denied(d)).toContain("invalid_inputs");
    expect((d.reasons.find((x) => x.code === "invalid_inputs")?.facts?.fields as string[])).toEqual(
      expect.arrayContaining(["minimumBorrowingRaw", "borrowableUsdcRaw"]),
    );
  });

  it("nulls the max-additional-debt hint whenever the request is denied", () => {
    const d = evaluateBorrowRequest(validInput({ requestedDebtRaw: 7_600_000_000n })); // over the protocol max LTV
    expect(d.allowed).toBe(false);
    expect(d.maxAllowedAdditionalDebtRaw).toBeNull();
  });

  it("denies an impossible exposure where one collateral exceeds the aggregate", () => {
    const d = evaluateBorrowRequest(
      validInput({ exposure: { aggregateDebtUsd: 1_000, collateralDebtUsd: 5_000 } }),
    );
    expect(d.allowed).toBe(false);
    expect((d.reasons.find((x) => x.code === "invalid_inputs")?.facts?.fields as string[])).toEqual(
      expect.arrayContaining(["exposure.collateralDebtUsd>aggregateDebtUsd"]),
    );
  });

  it("denies when projected debt overflows to non-finite (does not skip LTV/health)", () => {
    // 10^400 raw → Number() === Infinity → projected debt unreadable.
    const d = evaluateBorrowRequest(validInput({ existingDebtRaw: 10n ** 400n }));
    expect(d.allowed).toBe(false);
    expect(denied(d)).toContain("debt_unreadable");
    expect(d.projectedDebtUsd).toBeNull();
  });
});

describe("computeCarryProfitFee", () => {
  it("takes the default 10% of positive net carry", () => {
    expect(computeCarryProfitFee(100)).toBeCloseTo(10, 6);
  });
  it("is zero for zero or negative carry", () => {
    expect(computeCarryProfitFee(0)).toBe(0);
    expect(computeCarryProfitFee(-50)).toBe(0);
  });
  it("honors a custom share", () => {
    expect(computeCarryProfitFee(100, 2000)).toBeCloseTo(20, 6);
  });
  it("is zero for a non-finite input", () => {
    expect(computeCarryProfitFee(Number.NaN)).toBe(0);
  });
});
