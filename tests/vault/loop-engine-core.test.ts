import { describe, expect, it } from "vitest";
import {
  DEFAULT_LST_COLLATERAL_DUST_RAW,
  DEFAULT_SOL_DEBT_DUST_RAW,
  computeLoopOpenAmounts,
  planLoopClose,
  planLoopOpen,
  planLoopPartialUnwind,
  verifyLoopCloseOutcome,
  verifyLoopOpenOutcome,
  verifyLoopPartialUnwindOutcome,
} from "../../server/vault/borrow-engine-core";

describe("computeLoopOpenAmounts", () => {
  it("2x on 0.05 SOL → flash 0.05, total swap 0.10 (probe-proven sizing)", () => {
    const { flashLamports, totalSwapLamports } = computeLoopOpenAmounts(50_000_000n, 2);
    expect(flashLamports).toBe(50_000_000n);
    expect(totalSwapLamports).toBe(100_000_000n);
  });

  it("fractional leverage sizes via basis points, total = principal + flash exactly", () => {
    const { flashLamports, totalSwapLamports } = computeLoopOpenAmounts(1_000_000_000n, 1.5);
    expect(flashLamports).toBe(500_000_000n);
    expect(totalSwapLamports).toBe(1_500_000_000n);
  });

  it("rejects principal <= 0, leverage <= 1, > 10, non-finite", () => {
    expect(() => computeLoopOpenAmounts(0n, 2)).toThrow();
    expect(() => computeLoopOpenAmounts(-1n, 2)).toThrow();
    expect(() => computeLoopOpenAmounts(1_000_000n, 1)).toThrow();
    expect(() => computeLoopOpenAmounts(1_000_000n, 11)).toThrow();
    expect(() => computeLoopOpenAmounts(1_000_000n, NaN)).toThrow();
    expect(() => computeLoopOpenAmounts(1_000_000n, Infinity)).toThrow();
  });

  it("rejects a flash leg that rounds to zero (dust principal at tiny over-1 leverage)", () => {
    expect(() => computeLoopOpenAmounts(1n, 1.0001)).toThrow();
  });
});

describe("planLoopOpen / planLoopClose / planLoopPartialUnwind", () => {
  it("open: positive deposit + positive borrow, positionId 0 mints", () => {
    const p = planLoopOpen({ lstCollateralRaw: 90_000_000n, wsolDebtRaw: 50_000_000n });
    expect(p).toEqual({
      positionId: 0,
      colAmount: { kind: "exact", raw: 90_000_000n },
      debtAmount: { kind: "exact", raw: 50_000_000n },
    });
  });

  it("open: reuses a verified-empty positionId when given", () => {
    const p = planLoopOpen({ lstCollateralRaw: 1n, wsolDebtRaw: 1n, positionId: 7 });
    expect(p.positionId).toBe(7);
  });

  it("open: rejects non-positive legs and negative positionId", () => {
    expect(() => planLoopOpen({ lstCollateralRaw: 0n, wsolDebtRaw: 1n })).toThrow();
    expect(() => planLoopOpen({ lstCollateralRaw: 1n, wsolDebtRaw: 0n })).toThrow();
    expect(() => planLoopOpen({ lstCollateralRaw: 1n, wsolDebtRaw: 1n, positionId: -1 })).toThrow();
    expect(() => planLoopOpen({ lstCollateralRaw: 1n, wsolDebtRaw: 1n, positionId: 1.5 })).toThrow();
  });

  it("close: MAX repay + MAX withdraw, requires a real positionId", () => {
    expect(planLoopClose(12)).toEqual({
      positionId: 12,
      colAmount: { kind: "max" },
      debtAmount: { kind: "max" },
    });
    expect(() => planLoopClose(0)).toThrow();
    expect(() => planLoopClose(-3)).toThrow();
  });

  it("partial unwind: NEGATIVE legs for both repay and withdraw", () => {
    const p = planLoopPartialUnwind(9, { repayWsolRaw: 25_000_000n, withdrawLstRaw: 45_000_000n });
    expect(p).toEqual({
      positionId: 9,
      colAmount: { kind: "exact", raw: -45_000_000n },
      debtAmount: { kind: "exact", raw: -25_000_000n },
    });
  });

  it("partial unwind: rejects positionId 0 and non-positive amounts", () => {
    expect(() => planLoopPartialUnwind(0, { repayWsolRaw: 1n, withdrawLstRaw: 1n })).toThrow();
    expect(() => planLoopPartialUnwind(1, { repayWsolRaw: 0n, withdrawLstRaw: 1n })).toThrow();
    expect(() => planLoopPartialUnwind(1, { repayWsolRaw: 1n, withdrawLstRaw: 0n })).toThrow();
  });
});

describe("verifyLoopOpenOutcome", () => {
  const base = {
    flashDebtRaw: 50_000_000n,
    minCollateralRaw: 89_000_000n,
    observedDebtRaw: 50_100_000n, // ~0.2% over (interest tick / rounding)
    observedColRaw: 90_000_000n, // above minOut (positive slippage)
  };

  it("debt ~= flash leg within tolerance AND collateral >= minOut → ok", () => {
    expect(verifyLoopOpenOutcome(base)).toEqual({ ok: true });
  });

  it("collateral below the swap minOut floor → fail (no tolerance-equality)", () => {
    const r = verifyLoopOpenOutcome({ ...base, observedColRaw: 88_999_999n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("loop_collateral_below_min_out");
  });

  it("debt exceeding the flash leg beyond tolerance → fail (dangerous direction)", () => {
    const r = verifyLoopOpenOutcome({ ...base, observedDebtRaw: 52_000_000n }); // +4%
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("loop_debt_exceeds_flash_leg");
  });

  it("debt far below the flash leg → fail loop_debt_mismatch", () => {
    const r = verifyLoopOpenOutcome({ ...base, observedDebtRaw: 40_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("loop_debt_mismatch");
  });
});

describe("verifyLoopCloseOutcome", () => {
  it("debt+collateral cleared to dust AND SOL returned → ok", () => {
    expect(
      verifyLoopCloseOutcome({ observedDebtRaw: 0n, observedColRaw: 0n, solDeltaLamports: 49_000_000n }),
    ).toEqual({ ok: true });
    expect(
      verifyLoopCloseOutcome({
        observedDebtRaw: DEFAULT_SOL_DEBT_DUST_RAW,
        observedColRaw: DEFAULT_LST_COLLATERAL_DUST_RAW,
        solDeltaLamports: 1n,
      }),
    ).toEqual({ ok: true });
  });

  it("no SOL returned → fail (never mark closed without wallet proof)", () => {
    const r = verifyLoopCloseOutcome({ observedDebtRaw: 0n, observedColRaw: 0n, solDeltaLamports: 0n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("loop_no_sol_returned");
  });

  it("debt above SOL dust → fail; collateral above LST dust → fail", () => {
    expect(
      verifyLoopCloseOutcome({
        observedDebtRaw: DEFAULT_SOL_DEBT_DUST_RAW + 1n,
        observedColRaw: 0n,
        solDeltaLamports: 1n,
      }).reason,
    ).toBe("loop_debt_not_cleared");
    expect(
      verifyLoopCloseOutcome({
        observedDebtRaw: 0n,
        observedColRaw: DEFAULT_LST_COLLATERAL_DUST_RAW + 1n,
        solDeltaLamports: 1n,
      }).reason,
    ).toBe("loop_collateral_not_emptied");
  });

  it("SOL dust constant is 9dp-scaled (NOT the USDC-6dp constant)", () => {
    expect(DEFAULT_SOL_DEBT_DUST_RAW).toBe(100_000n);
  });
});

describe("verifyLoopPartialUnwindOutcome", () => {
  // Proportional 50% unwind of a 2x position: debt 50→25, col 90→45.
  const base = {
    debtBeforeRaw: 50_000_000n,
    debtAfterRaw: 25_000_000n,
    repayRequestedRaw: 25_000_000n,
    colBeforeRaw: 90_000_000n,
    colAfterRaw: 45_000_000n,
    withdrawRequestedRaw: 45_000_000n,
  };

  it("proportional unwind (ratio preserved) → ok", () => {
    expect(verifyLoopPartialUnwindOutcome(base)).toEqual({ ok: true });
  });

  it("ratio slightly worse from rounding (within tolerance) → ok", () => {
    // debtAfter 25.05 vs proportional 25 → ratio +0.2%, inside 0.5% tolerance
    expect(
      verifyLoopPartialUnwindOutcome({ ...base, debtAfterRaw: 25_050_000n, repayRequestedRaw: 24_950_000n }).ok,
    ).toBe(true);
  });

  it("ratio WORSENED beyond tolerance → fail loop_ratio_worsened", () => {
    // Withdrew far more collateral than debt repaid: debt 50→45, col 90→45
    const r = verifyLoopPartialUnwindOutcome({
      ...base,
      debtAfterRaw: 45_000_000n,
      repayRequestedRaw: 5_000_000n,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("loop_ratio_worsened");
  });

  it("collateral emptied on a PARTIAL unwind → fail (must be verified as a full close)", () => {
    const r = verifyLoopPartialUnwindOutcome({ ...base, colAfterRaw: 0n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("loop_partial_unwind_emptied_collateral");
  });

  it("debt not reduced / delta mismatch → fail closed", () => {
    expect(verifyLoopPartialUnwindOutcome({ ...base, debtAfterRaw: 50_000_000n }).reason).toBe(
      "loop_debt_not_reduced",
    );
    expect(verifyLoopPartialUnwindOutcome({ ...base, debtAfterRaw: 30_000_000n }).reason).toBe(
      "loop_debt_delta_mismatch",
    );
  });

  it("collateral not reduced / delta mismatch → fail closed", () => {
    expect(verifyLoopPartialUnwindOutcome({ ...base, colAfterRaw: 90_000_000n }).reason).toBe(
      "loop_collateral_not_reduced",
    );
    expect(verifyLoopPartialUnwindOutcome({ ...base, colAfterRaw: 55_000_000n }).reason).toBe(
      "loop_collateral_delta_mismatch",
    );
  });
});
