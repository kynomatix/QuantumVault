import { describe, it, expect } from "vitest";
import {
  buildBorrowExposureContext,
  type BorrowExposureRow,
} from "../../server/vault/borrow-exposure-context";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

function row(over: Partial<BorrowExposureRow>): BorrowExposureRow {
  return {
    status: "active",
    collateralMint: JITOSOL,
    collateralAssetKey: "jitosol",
    debtAssetKey: "usdc",
    debtMint: USDC,
    debtAmountRaw: "0",
    updatedAt: new Date(),
    healthAsOf: new Date(),
    ...over,
  };
}

describe("buildBorrowExposureContext", () => {
  it("empty book → ok, zero exposure (bootstrap)", () => {
    const r = buildBorrowExposureContext([], JITOSOL, USDC);
    expect(r.ok).toBe(true);
    expect(r.exposure).toEqual({ aggregateDebtUsd: 0, collateralDebtUsd: 0 });
    expect(r.stats.countedRows).toBe(0);
  });

  it("sums valid USDC debt; collateral filter is by mint", () => {
    const rows = [
      row({ collateralMint: JITOSOL, debtAmountRaw: "1000000000" }), // $1,000 jitoSOL
      row({ collateralMint: MSOL, collateralAssetKey: "msol", debtAmountRaw: "500000000" }), // $500 mSOL
    ];
    const r = buildBorrowExposureContext(rows, JITOSOL, USDC);
    expect(r.ok).toBe(true);
    expect(r.exposure!.aggregateDebtUsd).toBeCloseTo(1500, 6);
    expect(r.exposure!.collateralDebtUsd).toBeCloseTo(1000, 6); // only jitoSOL
  });

  it("excludes terminal (closed/failed) rows", () => {
    const rows = [
      row({ status: "closed", debtAmountRaw: "999000000" }),
      row({ status: "failed", debtAmountRaw: "999000000" }),
      row({ debtAmountRaw: "2000000" }), // $2 active
    ];
    const r = buildBorrowExposureContext(rows, JITOSOL, USDC);
    expect(r.ok).toBe(true);
    expect(r.stats.skippedTerminal).toBe(2);
    expect(r.exposure!.aggregateDebtUsd).toBeCloseTo(2, 6);
  });

  it("fail closed: unparseable debt", () => {
    const r = buildBorrowExposureContext([row({ debtAmountRaw: "not-a-number" })], JITOSOL, USDC);
    expect(r.ok).toBe(false);
    expect(r.exposure).toBeUndefined();
    expect(r.reasons[0].code).toBe("exposure_row_unreadable_debt");
  });

  it("fail closed: negative debt", () => {
    const r = buildBorrowExposureContext([row({ debtAmountRaw: "-5" })], JITOSOL, USDC);
    expect(r.ok).toBe(false);
    expect(r.reasons[0].code).toBe("exposure_row_unreadable_debt");
  });

  it("fail closed: debt not the verified USDC mint", () => {
    const r = buildBorrowExposureContext(
      [row({ debtMint: "SomeOtherMint1111111111111111111111111111111", debtAmountRaw: "1000000" })],
      JITOSOL,
      USDC,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons[0].code).toBe("exposure_non_usdc_debt");
  });

  it("fail closed: debt asset key not usdc", () => {
    const r = buildBorrowExposureContext([row({ debtAssetKey: "usdt", debtAmountRaw: "1000000" })], JITOSOL, USDC);
    expect(r.ok).toBe(false);
    expect(r.reasons[0].code).toBe("exposure_non_usdc_debt");
  });

  it("fail closed: missing collateral identity", () => {
    const r = buildBorrowExposureContext([row({ collateralMint: "", debtAmountRaw: "1000000" })], JITOSOL, USDC);
    expect(r.ok).toBe(false);
    expect(r.reasons[0].code).toBe("exposure_row_missing_collateral");
  });

  it("fail closed: unresolved USDC mint", () => {
    const r = buildBorrowExposureContext([row({ debtAmountRaw: "1000000" })], JITOSOL, "");
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === "exposure_usdc_mint_unresolved")).toBe(true);
  });

  it("staleness: enforced only when a budget is supplied, only for open rows", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const openStale = row({ debtAmountRaw: "1000000", healthAsOf: old, updatedAt: old });
    // No budget → stale ignored.
    expect(buildBorrowExposureContext([openStale], JITOSOL, USDC).ok).toBe(true);
    // Budget 5min → stale open row fails closed.
    const r = buildBorrowExposureContext([openStale], JITOSOL, USDC, { maxStalenessMs: 5 * 60 * 1000 });
    expect(r.ok).toBe(false);
    expect(r.reasons[0].code).toBe("exposure_cache_stale");
  });

  it("staleness: a zero-debt (pending) row is never stale", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const pendingOld = row({ status: "pending", debtAmountRaw: "0", healthAsOf: old, updatedAt: old });
    const r = buildBorrowExposureContext([pendingOld], JITOSOL, USDC, { maxStalenessMs: 5 * 60 * 1000 });
    expect(r.ok).toBe(true);
  });

  it("concentration inputs: collateralDebtUsd never exceeds aggregate", () => {
    const rows = [
      row({ collateralMint: JITOSOL, debtAmountRaw: "3000000" }),
      row({ collateralMint: JITOSOL, debtAmountRaw: "1000000" }),
      row({ collateralMint: MSOL, collateralAssetKey: "msol", debtAmountRaw: "1000000" }),
    ];
    const r = buildBorrowExposureContext(rows, JITOSOL, USDC);
    expect(r.ok).toBe(true);
    expect(r.exposure!.collateralDebtUsd).toBeLessThanOrEqual(r.exposure!.aggregateDebtUsd);
    expect(r.exposure!.collateralDebtUsd).toBeCloseTo(4, 6);
    expect(r.exposure!.aggregateDebtUsd).toBeCloseTo(5, 6);
  });
});
