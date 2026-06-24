import { describe, it, expect } from "vitest";
import {
  decodeVaultConfig,
  decodeFactorToFraction,
  decodePenaltyToFraction,
  decodeRateToFraction,
  decode1e15,
  previewBorrow,
  type BorrowVaultConfig,
} from "../../server/vault/jupiter-lend-borrow-route";
import { BORROW_PREVIEW_ASSUMPTIONS } from "../../server/vault/borrow-preview-assumptions";

/**
 * Raw REST vault object captured from the live INF→USDC vault (id 43, 2026-06-24).
 * Addresses are placeholders — decoding never validates them as pubkeys, and these
 * tests are pure (no network, no RPC).
 */
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

describe("scaled-fixed-point decoders (confirmed on the live INF vault)", () => {
  it("decodes collateralFactor / liquidationThreshold ÷1000", () => {
    expect(decodeFactorToFraction("750")).toBeCloseTo(0.75, 6);
    expect(decodeFactorToFraction("800")).toBeCloseTo(0.8, 6);
  });
  it("decodes liquidationPenalty ÷10000 (bps)", () => {
    expect(decodePenaltyToFraction("500")).toBeCloseTo(0.05, 6);
  });
  it("decodes borrowRate ÷10000 to an APR fraction", () => {
    expect(decodeRateToFraction("466")).toBeCloseTo(0.0466, 6);
  });
  it("decodes 1e15-scaled utilization / oracle price", () => {
    expect(decode1e15("405783379446790")).toBeCloseTo(0.4058, 3);
    expect(decode1e15("98865597964440443")).toBeCloseTo(98.8656, 3);
  });
});

describe("decodeVaultConfig", () => {
  it("decodes the INF vault into a money-ready config", () => {
    const c = decodeVaultConfig(RAW_INF);
    expect(c).not.toBeNull();
    const cfg = c as BorrowVaultConfig;
    expect(cfg.vaultId).toBe(43);
    expect(cfg.collateralSymbol).toBe("INF");
    expect(cfg.collateralDecimals).toBe(9);
    expect(cfg.debtSymbol).toBe("USDC");
    expect(cfg.debtDecimals).toBe(6);
    expect(cfg.maxLtv).toBeCloseTo(0.75, 6);
    expect(cfg.liquidationThreshold).toBeCloseTo(0.8, 6);
    expect(cfg.liquidationPenalty).toBeCloseTo(0.05, 6);
    expect(cfg.borrowApr).toBeCloseTo(0.0466, 6);
    expect(cfg.utilization).toBeCloseTo(0.4058, 3);
    expect(cfg.oraclePriceLiquidateUsd).toBeCloseTo(98.8656, 3);
  });

  it("returns null for a non-USDC-borrow vault (fail closed)", () => {
    const notUsdc = { ...RAW_INF, borrowToken: { ...RAW_INF.borrowToken, symbol: "SOL" } };
    expect(decodeVaultConfig(notUsdc)).toBeNull();
  });

  it("returns null when a required risk field is missing (fail closed)", () => {
    const missing = { ...RAW_INF, liquidationThreshold: "" };
    expect(decodeVaultConfig(missing)).toBeNull();
  });

  it("returns null for a malformed object (fail closed)", () => {
    expect(decodeVaultConfig(null)).toBeNull();
    expect(decodeVaultConfig({})).toBeNull();
  });
});

describe("previewBorrow projection", () => {
  const cfg = decodeVaultConfig(RAW_INF) as BorrowVaultConfig;
  const INF = (n: number) => BigInt(n) * BigInt(1e9);
  const USDC = (n: number) => BigInt(n) * BigInt(1e6);

  it("projects LTV, health factor, and liquidation price for a safe borrow", () => {
    // 100 INF (~$9886) collateral, borrow 5000 USDC.
    const p = previewBorrow(cfg, INF(100), USDC(5000));
    expect(p.ok).toBe(true);
    expect(p.collateralValueUsd).toBeCloseTo(9886.56, 1);
    expect(p.ltv as number).toBeCloseTo(0.5057, 3);
    expect(p.healthFactor as number).toBeGreaterThan(1); // safe
    expect(p.healthFactor as number).toBeCloseTo(1.5818, 2);
    expect(p.liquidationPriceUsd as number).toBeCloseTo(62.5, 2); // debt / (col * liqThr)
  });

  it("flags a borrow above the suggested-safe LTV as a preview_assumption (not protocol)", () => {
    const p = previewBorrow(cfg, INF(100), USDC(5000));
    const safe = p.hints.find((h) => h.code === "above_suggested_safe_ltv");
    expect(safe?.source).toBe("preview_assumption");
    // LTV 0.51 is under the 0.75 protocol max, so no protocol-reject hint.
    expect(p.hints.find((h) => h.code === "exceeds_protocol_max_ltv")).toBeUndefined();
  });

  it("flags a borrow above the protocol max LTV as a protocol fact", () => {
    // 8000 USDC against 100 INF → LTV ~0.81 > 0.75 protocol max, HF < 1.
    const p = previewBorrow(cfg, INF(100), USDC(8000));
    const proto = p.hints.find((h) => h.code === "exceeds_protocol_max_ltv");
    expect(proto?.source).toBe("protocol");
    expect(p.healthFactor as number).toBeLessThan(1); // liquidatable territory
  });

  it("reports no debt as health-factor null (no liquidation risk)", () => {
    const p = previewBorrow(cfg, INF(100), USDC(0));
    expect(p.ok).toBe(true);
    expect(p.healthFactor).toBeNull();
    expect(p.liquidationPriceUsd).toBeNull();
  });

  it("fails closed on zero collateral", () => {
    const p = previewBorrow(cfg, BigInt(0), USDC(5000));
    expect(p.ok).toBe(false);
    expect(p.ltv).toBeNull();
  });

  it("caps max borrow by the protocol max-LTV factor", () => {
    const p = previewBorrow(cfg, INF(100), USDC(1000));
    // collateralValueUsd * maxLtv = 9886.56 * 0.75 ≈ 7414.92 USDC, under live borrowable.
    expect(Number(p.maxBorrowUsdcRaw) / 1e6).toBeCloseTo(7414.92, 0);
  });
});

describe("BORROW_PREVIEW_ASSUMPTIONS are inert, owner-pending, never a money gate", () => {
  it("every assumption is tagged preview_only_not_money_gate and ownerPending", () => {
    const all = Object.values(BORROW_PREVIEW_ASSUMPTIONS);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(a.enforcement).toBe("preview_only_not_money_gate");
      expect(a.ownerPending).toBe(true);
      expect(typeof a.value).toBe("number");
      expect(a.note.length).toBeGreaterThan(0);
    }
  });

  it("the suggested safe LTV is a conservative fraction (0,1)", () => {
    const v = BORROW_PREVIEW_ASSUMPTIONS.suggestedSafeLtv.value;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });
});
