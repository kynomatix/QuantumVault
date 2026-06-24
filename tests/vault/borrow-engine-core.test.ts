import { describe, it, expect } from "vitest";
import {
  planBorrowOpen,
  planBorrowClose,
  verifyOpenOutcome,
  verifyCloseOutcome,
  withinToleranceBps,
  absDiff,
  hasSufficientRepayBalance,
  DEFAULT_DEBT_DUST_RAW,
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
