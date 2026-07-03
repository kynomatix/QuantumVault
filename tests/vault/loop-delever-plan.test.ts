import { describe, expect, it } from "vitest";
import {
  DEFAULT_LST_COLLATERAL_DUST_RAW,
  DEFAULT_SOL_DEBT_DUST_RAW,
  planLoopDeleverToHold,
  planLoopHoldExit,
  sizeLoopDeleverWithdraw,
  verifyLoopDeleverToHoldOutcome,
} from "../../server/vault/borrow-engine-core";
import { VAULT_INTERNAL_EVENT_TYPES, isVaultInternalEvent } from "../../server/equity-events-util";

describe("planLoopDeleverToHold", () => {
  it("repays MAX debt and withdraws EXACTLY the sized LST (negative exact col)", () => {
    const plan = planLoopDeleverToHold(42, { withdrawLstRaw: 805_600_000n });
    expect(plan.positionId).toBe(42);
    expect(plan.colAmount).toEqual({ kind: "exact", raw: -805_600_000n });
    expect(plan.debtAmount).toEqual({ kind: "max" });
  });

  it("rejects a zero/negative withdraw and a fake positionId", () => {
    expect(() => planLoopDeleverToHold(42, { withdrawLstRaw: 0n })).toThrow();
    expect(() => planLoopDeleverToHold(42, { withdrawLstRaw: -1n })).toThrow();
    expect(() => planLoopDeleverToHold(0, { withdrawLstRaw: 1n })).toThrow();
    expect(() => planLoopDeleverToHold(-3, { withdrawLstRaw: 1n })).toThrow();
    expect(() => planLoopDeleverToHold(1.5, { withdrawLstRaw: 1n })).toThrow();
  });
});

describe("planLoopHoldExit", () => {
  it("withdraws ALL collateral with an explicit zero-debt leg (no flash needed)", () => {
    const plan = planLoopHoldExit(7);
    expect(plan.positionId).toBe(7);
    expect(plan.colAmount).toEqual({ kind: "max" });
    expect(plan.debtAmount).toEqual({ kind: "exact", raw: 0n });
  });

  it("rejects a fake positionId", () => {
    expect(() => planLoopHoldExit(0)).toThrow();
    expect(() => planLoopHoldExit(-1)).toThrow();
    expect(() => planLoopHoldExit(2.5)).toThrow();
  });
});

describe("sizeLoopDeleverWithdraw", () => {
  const base = {
    flashPaybackRaw: 1_000_000_000n, // 1 SOL
    solPerLst: 1.25,
    sizingMarginBps: 70,
    liveCollateralRaw: 2_000_000_000n, // 2 LST
  };

  it("exact bigint ceil math: 1 SOL payback at 1.25 SOL/LST with 70bps margin", () => {
    const r = sizeLoopDeleverWithdraw(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // W = ceil(1e9 * 10070 * 1e9 / (10000 * 1.25e9)) = 805_600_000
    expect(r.withdrawLstRaw).toBe(805_600_000n);
    expect(r.remainingColRaw).toBe(2_000_000_000n - 805_600_000n);
  });

  it("rounds UP when the division is not exact (never under-covers the payback)", () => {
    const r = sizeLoopDeleverWithdraw({ ...base, flashPaybackRaw: 1_000_000_001n });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // floor would be 805_600_000.8056 → must round to 805_600_001
    expect(r.withdrawLstRaw).toBe(805_600_001n);
    // sanity: withdrawn LST at worst-case rate covers payback
    const worstOutFloat = Number(r.withdrawLstRaw) * (base.solPerLst / (1 + base.sizingMarginBps / 10_000));
    expect(worstOutFloat).toBeGreaterThanOrEqual(Number(1_000_000_001n));
  });

  it("fails closed on an unreadable or non-positive rate", () => {
    expect(sizeLoopDeleverWithdraw({ ...base, solPerLst: NaN })).toEqual({ ok: false, reason: "delever_rate_unreadable" });
    expect(sizeLoopDeleverWithdraw({ ...base, solPerLst: 0 })).toEqual({ ok: false, reason: "delever_rate_unreadable" });
    expect(sizeLoopDeleverWithdraw({ ...base, solPerLst: -1 })).toEqual({ ok: false, reason: "delever_rate_unreadable" });
    expect(sizeLoopDeleverWithdraw({ ...base, solPerLst: Infinity })).toEqual({ ok: false, reason: "delever_rate_unreadable" });
  });

  it("rejects margin outside 0..2000 bps and non-integer margin", () => {
    expect(sizeLoopDeleverWithdraw({ ...base, sizingMarginBps: -1 }).ok).toBe(false);
    expect(sizeLoopDeleverWithdraw({ ...base, sizingMarginBps: 2_001 }).ok).toBe(false);
    expect(sizeLoopDeleverWithdraw({ ...base, sizingMarginBps: 50.5 }).ok).toBe(false);
    expect(sizeLoopDeleverWithdraw({ ...base, sizingMarginBps: 0 }).ok).toBe(true);
    expect(sizeLoopDeleverWithdraw({ ...base, sizingMarginBps: 2_000 }).ok).toBe(true);
  });

  it("rejects a non-positive payback or collateral", () => {
    expect(sizeLoopDeleverWithdraw({ ...base, flashPaybackRaw: 0n }).ok).toBe(false);
    expect(sizeLoopDeleverWithdraw({ ...base, liveCollateralRaw: 0n }).ok).toBe(false);
  });

  it("refuses when the withdrawal would EMPTY the collateral (that is a close)", () => {
    const r = sizeLoopDeleverWithdraw({ ...base, liveCollateralRaw: 805_600_000n });
    expect(r).toEqual({ ok: false, reason: "delever_would_empty_collateral" });
  });

  it("refuses when the remainder would be dust (default LST dust floor)", () => {
    const r = sizeLoopDeleverWithdraw({
      ...base,
      liveCollateralRaw: 805_600_000n + DEFAULT_LST_COLLATERAL_DUST_RAW,
    });
    expect(r).toEqual({ ok: false, reason: "delever_remainder_below_dust" });
  });

  it("honors a caller-supplied minRemainingColRaw floor", () => {
    const ok = sizeLoopDeleverWithdraw({ ...base, minRemainingColRaw: 1_000_000_000n });
    expect(ok.ok).toBe(true);
    const bad = sizeLoopDeleverWithdraw({ ...base, minRemainingColRaw: 1_200_000_000n });
    expect(bad).toEqual({ ok: false, reason: "delever_remainder_below_dust" });
  });

  it("gates on the vault's withdrawable window when provided", () => {
    const bad = sizeLoopDeleverWithdraw({ ...base, withdrawableCollateralRaw: 800_000_000n });
    expect(bad).toEqual({ ok: false, reason: "delever_exceeds_withdrawable" });
    const ok = sizeLoopDeleverWithdraw({ ...base, withdrawableCollateralRaw: 805_600_000n });
    expect(ok.ok).toBe(true);
  });
});

describe("verifyLoopDeleverToHoldOutcome", () => {
  it("passes when debt is cleared and collateral remains supplied", () => {
    expect(
      verifyLoopDeleverToHoldOutcome({ observedDebtRaw: 0n, observedColRaw: 1_000_000_000n }),
    ).toEqual({ ok: true });
    expect(
      verifyLoopDeleverToHoldOutcome({
        observedDebtRaw: DEFAULT_SOL_DEBT_DUST_RAW,
        observedColRaw: DEFAULT_LST_COLLATERAL_DUST_RAW + 1n,
      }),
    ).toEqual({ ok: true });
  });

  it("fails when debt is NOT cleared", () => {
    const r = verifyLoopDeleverToHoldOutcome({
      observedDebtRaw: DEFAULT_SOL_DEBT_DUST_RAW + 1n,
      observedColRaw: 1_000_000_000n,
    });
    expect(r).toEqual({ ok: false, reason: "loop_delever_debt_not_cleared" });
  });

  it("fails when the collateral was emptied (that was a close, not a hold)", () => {
    const r = verifyLoopDeleverToHoldOutcome({
      observedDebtRaw: 0n,
      observedColRaw: DEFAULT_LST_COLLATERAL_DUST_RAW,
    });
    expect(r).toEqual({ ok: false, reason: "loop_delever_collateral_emptied" });
  });

  it("honors custom dust thresholds", () => {
    expect(
      verifyLoopDeleverToHoldOutcome({
        observedDebtRaw: 500n,
        observedColRaw: 2_000n,
        debtDustRaw: 1_000n,
        collateralDustRaw: 1_000n,
      }),
    ).toEqual({ ok: true });
  });
});

describe("net-deposited classifier", () => {
  it("loop_delever_hold is a vault-internal event (excluded from net-deposited)", () => {
    expect(VAULT_INTERNAL_EVENT_TYPES.has("loop_delever_hold")).toBe(true);
    expect(isVaultInternalEvent("loop_delever_hold")).toBe(true);
  });
});
