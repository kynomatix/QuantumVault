import { describe, it, expect } from "vitest";
import {
  planBorrowOpen,
  planBorrowClose,
  verifyOpenOutcome,
  verifyCloseOutcome,
  withinToleranceBps,
  absDiff,
  hasSufficientRepayBalance,
  capPositiveCollateralDeposit,
  DEFAULT_DEBT_DUST_RAW,
  positionScaleDecimals,
  positionRawToNativeRaw,
} from "../../server/vault/borrow-engine-core";

describe("borrow-engine-core: plan builders", () => {
  it("planBorrowOpen mints a fresh position and deposits+borrows exactly", () => {
    const plan = planBorrowOpen({ collateralRaw: 1_000_000_000n, debtRaw: 50_000_000n });
    expect(plan.positionId).toBe(0); // 0 => SDK mints the position NFT
    expect(plan.colAmount).toEqual({ kind: "exact", raw: 1_000_000_000n });
    expect(plan.debtAmount).toEqual({ kind: "exact", raw: 50_000_000n });
  });

  it("planBorrowOpen refuses non-positive amounts", () => {
    expect(() => planBorrowOpen({ collateralRaw: 0n, debtRaw: 1n })).toThrow();
    expect(() => planBorrowOpen({ collateralRaw: 1n, debtRaw: 0n })).toThrow();
    expect(() => planBorrowOpen({ collateralRaw: -1n, debtRaw: 1n })).toThrow();
  });

  it("planBorrowClose repays ALL and withdraws ALL for a real position", () => {
    const plan = planBorrowClose(42);
    expect(plan.positionId).toBe(42);
    expect(plan.colAmount).toEqual({ kind: "max" });
    expect(plan.debtAmount).toEqual({ kind: "max" });
  });

  it("planBorrowClose refuses a missing/placeholder positionId", () => {
    expect(() => planBorrowClose(0)).toThrow();
    expect(() => planBorrowClose(-1)).toThrow();
    expect(() => planBorrowClose(1.5)).toThrow();
  });
});

describe("borrow-engine-core: tolerance math", () => {
  it("absDiff is order-independent", () => {
    expect(absDiff(5n, 8n)).toBe(3n);
    expect(absDiff(8n, 5n)).toBe(3n);
    expect(absDiff(7n, 7n)).toBe(0n);
  });

  it("withinToleranceBps honors the band and handles zero expected", () => {
    // 0.5% of 1_000_000 = 5_000
    expect(withinToleranceBps(1_004_000n, 1_000_000n, 50)).toBe(true);
    expect(withinToleranceBps(1_006_000n, 1_000_000n, 50)).toBe(false);
    expect(withinToleranceBps(0n, 0n, 50)).toBe(true);
    expect(withinToleranceBps(1n, 0n, 50)).toBe(false);
    expect(withinToleranceBps(5n, 5n, -1)).toBe(false); // invalid tolerance => false
  });
});

describe("borrow-engine-core: verifyOpenOutcome", () => {
  const base = {
    requestedCollateralRaw: 1_000_000_000n,
    requestedDebtRaw: 50_000_000n,
    usdcDeltaRaw: 50_000_000n,
    observedColRaw: 1_000_000_000n,
    observedDebtRaw: 50_000_000n,
  };

  it("passes when reality matches the request", () => {
    expect(verifyOpenOutcome(base)).toEqual({ ok: true });
  });

  it("fails closed when no USDC was received (no money landed)", () => {
    expect(verifyOpenOutcome({ ...base, usdcDeltaRaw: 0n }).ok).toBe(false);
  });

  it("fails when debt materially exceeds the request", () => {
    const r = verifyOpenOutcome({ ...base, observedDebtRaw: 60_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("debt_exceeds_requested");
  });

  it("tolerates tiny tick-rounding / interest within the band", () => {
    expect(verifyOpenOutcome({ ...base, observedDebtRaw: 50_010_000n }).ok).toBe(true); // +0.02%
  });

  it("flags a collateral mismatch", () => {
    expect(verifyOpenOutcome({ ...base, observedColRaw: 900_000_000n }).reason).toBe("collateral_mismatch");
  });

  it("flags a received-usdc mismatch", () => {
    expect(verifyOpenOutcome({ ...base, usdcDeltaRaw: 40_000_000n }).reason).toBe("received_usdc_mismatch");
  });
});

describe("borrow-engine-core: verifyCloseOutcome", () => {
  it("passes when debt is cleared and collateral returned", () => {
    expect(verifyCloseOutcome({ observedDebtRaw: 0n, collateralDeltaRaw: 1_000_000_000n })).toEqual({ ok: true });
  });

  it("tolerates sub-dust residual debt", () => {
    expect(verifyCloseOutcome({ observedDebtRaw: DEFAULT_DEBT_DUST_RAW, collateralDeltaRaw: 1n }).ok).toBe(true);
  });

  it("fails when debt is not cleared", () => {
    const r = verifyCloseOutcome({ observedDebtRaw: 1_000_000n, collateralDeltaRaw: 1_000_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("debt_not_cleared");
  });

  it("fails closed when no collateral came back", () => {
    const r = verifyCloseOutcome({ observedDebtRaw: 0n, collateralDeltaRaw: 0n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_collateral_returned");
  });
});

describe("borrow-engine-core: hasSufficientRepayBalance", () => {
  it("requires balance >= debt + buffer", () => {
    expect(hasSufficientRepayBalance(50_000_000n, 50_000_000n)).toBe(true);
    expect(hasSufficientRepayBalance(49_999_999n, 50_000_000n)).toBe(false);
    expect(hasSufficientRepayBalance(50_500_000n, 50_000_000n, 1_000_000n)).toBe(false);
    expect(hasSufficientRepayBalance(51_000_000n, 50_000_000n, 1_000_000n)).toBe(true);
  });
});

describe("borrow-engine-core: capPositiveCollateralDeposit", () => {
  it("caps an exact-balance deposit one raw unit below the held balance (the Fluid round-up bug)", () => {
    // The live-reproduced boundary: 0.1 INF held = 100000000 raw -> deposit 99999999.
    expect(capPositiveCollateralDeposit(100_000_000n, 100_000_000n)).toBe(99_999_999n);
  });

  it("never deposits more than requested when the wallet holds extra", () => {
    // Requested < held-1 -> pass the request through untouched (no hidden buffer pull).
    expect(capPositiveCollateralDeposit(100_000_000n, 200_000_000n)).toBe(100_000_000n);
    expect(capPositiveCollateralDeposit(1n, 100_000_000n)).toBe(1n);
  });

  it("caps at held-1 only when the request meets or exceeds the held balance", () => {
    expect(capPositiveCollateralDeposit(200_000_000n, 100_000_000n)).toBe(99_999_999n);
    expect(capPositiveCollateralDeposit(99_999_999n, 100_000_000n)).toBe(99_999_999n);
  });

  it("returns 0n (caller must reject) when nothing can safely be deposited", () => {
    expect(capPositiveCollateralDeposit(0n, 100_000_000n)).toBe(0n);
    expect(capPositiveCollateralDeposit(-5n, 100_000_000n)).toBe(0n);
    expect(capPositiveCollateralDeposit(100_000_000n, 1n)).toBe(0n);
    expect(capPositiveCollateralDeposit(100_000_000n, 0n)).toBe(0n);
  });
});

describe("borrow-engine-core: SDK position-raw -> native scaling", () => {
  it("positionScaleDecimals is max(decimals, 9)", () => {
    expect(positionScaleDecimals(6)).toBe(9); // USDC -> upscaled to 9 dp
    expect(positionScaleDecimals(9)).toBe(9); // INF -> unchanged
    expect(positionScaleDecimals(0)).toBe(9);
    expect(positionScaleDecimals(18)).toBe(18); // >= 9 dp left native
  });

  it("converts the real bug case: USDC debt 9dp -> native 6dp (the 1000x overstatement)", () => {
    // The live row that read as ~$1933: 1_933_233_786 at 9 dp is $1.933233786.
    // CEIL for a liability (never under-report what is owed).
    expect(positionRawToNativeRaw(1_933_233_786n, 6, "ceil")).toBe(1_933_234n); // $1.933234
    // FLOOR is the repay cap (never overshoot true debt -> VaultUserDebtTooLow).
    expect(positionRawToNativeRaw(1_933_233_786n, 6, "floor")).toBe(1_933_233n);
  });

  it("ceil vs floor differ by at most one native unit", () => {
    const positionRaw = 2_000_000_001n; // $2.000000001 at 9 dp
    expect(positionRawToNativeRaw(positionRaw, 6, "ceil")).toBe(2_000_001n);
    expect(positionRawToNativeRaw(positionRaw, 6, "floor")).toBe(2_000_000n);
  });

  it("exact multiples ceil == floor (no spurious +1)", () => {
    expect(positionRawToNativeRaw(2_000_000_000n, 6, "ceil")).toBe(2_000_000n);
    expect(positionRawToNativeRaw(2_000_000_000n, 6, "floor")).toBe(2_000_000n);
  });

  it("collateral at >= 9 dp passes through unscaled (divisor 1)", () => {
    // INF (9 dp): 100_000_000 = 0.1 INF, no scaling either direction.
    expect(positionRawToNativeRaw(100_000_000n, 9, "floor")).toBe(100_000_000n);
    expect(positionRawToNativeRaw(100_000_000n, 9, "ceil")).toBe(100_000_000n);
  });

  it("zero stays zero in both directions", () => {
    expect(positionRawToNativeRaw(0n, 6, "ceil")).toBe(0n);
    expect(positionRawToNativeRaw(0n, 6, "floor")).toBe(0n);
  });

  it("fails closed on invalid decimals or a negative (unreadable) input", () => {
    expect(() => positionRawToNativeRaw(1n, -1, "floor")).toThrow();
    expect(() => positionRawToNativeRaw(1n, 19, "floor")).toThrow();
    expect(() => positionRawToNativeRaw(1n, 6.5, "floor")).toThrow();
    expect(() => positionRawToNativeRaw(-1n, 6, "floor")).toThrow();
  });
});
