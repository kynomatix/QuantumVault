import { describe, expect, it } from "vitest";
import {
  LOOP_RISK_POLICY,
  LOOP_VAULT_ALLOWLIST,
  computeLoopTargetLeverage,
  evaluateLoopOpenRequest,
  maxLeverageForHealthBuffer,
  recoverHopSolReturned,
  type LoopOpenPolicyInput,
} from "../../server/vault/loop/loop-risk-policy";

function goodInput(overrides: Partial<LoopOpenPolicyInput> = {}): LoopOpenPolicyInput {
  return {
    vaultId: 4,
    requestedLeverage: 2,
    liquidationThreshold: 0.85, // HF at 2x = 2·0.85/1 = 1.7, above the 1.3 buffer
    principalLamports: 50_000_000n, // 0.05 SOL
    stakePoolSolPerLst: 1.1,
    marketSolPerLst: 1.1005, // ~4.5 bps off peg
    borrowApr: 0.05,
    utilization: 0.6,
    stakingApy: 0.08,
    ...overrides,
  };
}

describe("evaluateLoopOpenRequest", () => {
  it("allowlisted vault + sane inputs → allowed, no deny reasons", () => {
    const d = evaluateLoopOpenRequest(goodInput());
    expect(d.allowed).toBe(true);
    expect(d.reasons.filter((r) => r.severity === "deny")).toHaveLength(0);
    expect(d.effectiveMaxLeverage).toBe(5);
    expect(d.depegBps).not.toBeNull();
    expect(d.depegBps!).toBeLessThan(LOOP_RISK_POLICY.depegBandBps);
  });

  it("both launch vaults (4 JupSOL, 47 mSOL) are allowlisted with venue-quality caps", () => {
    expect(LOOP_VAULT_ALLOWLIST[4]).toEqual({ symbol: "JupSOL", maxLeverage: 5 });
    expect(LOOP_VAULT_ALLOWLIST[47]).toEqual({ symbol: "mSOL", maxLeverage: 4 });
    expect(evaluateLoopOpenRequest(goodInput({ vaultId: 47 })).allowed).toBe(true);
  });

  it("non-allowlisted vault → deny loop_vault_not_allowlisted", () => {
    const d = evaluateLoopOpenRequest(goodInput({ vaultId: 43 })); // INF/USDC borrow vault
    expect(d.allowed).toBe(false);
    expect(d.effectiveMaxLeverage).toBeNull();
    expect(d.reasons.some((r) => r.code === "loop_vault_not_allowlisted" && r.severity === "deny")).toBe(true);
  });

  it("leverage above the per-vault cap → deny loop_leverage_exceeds_cap", () => {
    const d = evaluateLoopOpenRequest(goodInput({ vaultId: 47, requestedLeverage: 4.5 }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "loop_leverage_exceeds_cap")).toBe(true);
  });

  it("unreadable/out-of-range liquidation threshold → FAIL CLOSED deny", () => {
    for (const lt of [null, NaN, 0, 1, 1.2, -0.5]) {
      const d = evaluateLoopOpenRequest(goodInput({ liquidationThreshold: lt }));
      expect(d.allowed).toBe(false);
      expect(d.reasons.some((r) => r.code === "loop_liquidation_threshold_unreadable" && r.severity === "deny")).toBe(
        true,
      );
    }
  });

  it("requested leverage landing below the min open health buffer → deny loop_health_buffer_violated", () => {
    // LT 0.85 → HF at 2.9x = 2.9·0.85/1.9 ≈ 1.297 < 1.3
    const d = evaluateLoopOpenRequest(goodInput({ requestedLeverage: 2.9 }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "loop_health_buffer_violated" && r.severity === "deny")).toBe(true);
    // 2.8x lands at ≈1.322 ≥ 1.3 → allowed
    expect(evaluateLoopOpenRequest(goodInput({ requestedLeverage: 2.8 })).allowed).toBe(true);
  });

  it("leverage <= 1 or non-finite → deny loop_leverage_invalid", () => {
    for (const lev of [1, 0.5, 0, -2, NaN, Infinity]) {
      const d = evaluateLoopOpenRequest(goodInput({ requestedLeverage: lev }));
      expect(d.allowed).toBe(false);
      expect(d.reasons.some((r) => r.code === "loop_leverage_invalid" || r.code === "loop_leverage_exceeds_cap")).toBe(
        true,
      );
    }
  });

  it("zero/negative principal → deny loop_principal_invalid", () => {
    const d = evaluateLoopOpenRequest(goodInput({ principalLamports: 0n }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "loop_principal_invalid")).toBe(true);
  });

  it("unreadable stake-pool or market rate → FAIL CLOSED deny", () => {
    for (const overrides of [
      { stakePoolSolPerLst: null },
      { stakePoolSolPerLst: NaN },
      { stakePoolSolPerLst: 0 },
      { marketSolPerLst: null },
      { marketSolPerLst: NaN },
      { marketSolPerLst: -1 },
    ] as Partial<LoopOpenPolicyInput>[]) {
      const d = evaluateLoopOpenRequest(goodInput(overrides));
      expect(d.allowed).toBe(false);
      expect(d.depegBps).toBeNull();
      expect(
        d.reasons.some(
          (r) => r.code === "loop_stake_pool_rate_unreadable" || r.code === "loop_market_rate_unreadable",
        ),
      ).toBe(true);
    }
  });

  it("depeg beyond the band → deny loop_depeg_exceeds_band (both directions)", () => {
    // 200 bps discount
    const below = evaluateLoopOpenRequest(goodInput({ stakePoolSolPerLst: 1.1, marketSolPerLst: 1.078 }));
    expect(below.allowed).toBe(false);
    expect(below.reasons.some((r) => r.code === "loop_depeg_exceeds_band")).toBe(true);
    // 200 bps premium
    const above = evaluateLoopOpenRequest(goodInput({ stakePoolSolPerLst: 1.1, marketSolPerLst: 1.122 }));
    expect(above.allowed).toBe(false);
    expect(above.reasons.some((r) => r.code === "loop_depeg_exceeds_band")).toBe(true);
  });

  it("depeg within the band → allowed", () => {
    // ~50 bps
    const d = evaluateLoopOpenRequest(goodInput({ stakePoolSolPerLst: 1.1, marketSolPerLst: 1.1055 }));
    expect(d.allowed).toBe(true);
  });

  it("unreadable borrow APR → FAIL CLOSED deny; APR above ceiling → deny", () => {
    const unread = evaluateLoopOpenRequest(goodInput({ borrowApr: null }));
    expect(unread.allowed).toBe(false);
    expect(unread.reasons.some((r) => r.code === "loop_borrow_apr_unreadable")).toBe(true);

    const high = evaluateLoopOpenRequest(goodInput({ borrowApr: 0.2 }));
    expect(high.allowed).toBe(false);
    expect(high.reasons.some((r) => r.code === "loop_borrow_apr_ceiling")).toBe(true);
  });

  it("unreadable utilization → FAIL CLOSED deny; utilization above ceiling → deny", () => {
    const unread = evaluateLoopOpenRequest(goodInput({ utilization: null }));
    expect(unread.allowed).toBe(false);
    expect(unread.reasons.some((r) => r.code === "loop_utilization_unreadable")).toBe(true);

    const full = evaluateLoopOpenRequest(goodInput({ utilization: 0.95 }));
    expect(full.allowed).toBe(false);
    expect(full.reasons.some((r) => r.code === "loop_utilization_ceiling")).toBe(true);
  });

  it("negative carry → WARN only (open still allowed in P2)", () => {
    const d = evaluateLoopOpenRequest(goodInput({ stakingApy: 0.04, borrowApr: 0.05 }));
    expect(d.allowed).toBe(true);
    const carry = d.reasons.find((r) => r.code === "loop_negative_carry");
    expect(carry).toBeDefined();
    expect(carry!.severity).toBe("warn");
  });

  it("missing staking APY → no carry reason at all (optional input)", () => {
    const d = evaluateLoopOpenRequest(goodInput({ stakingApy: null }));
    expect(d.allowed).toBe(true);
    expect(d.reasons.some((r) => r.code === "loop_negative_carry")).toBe(false);
  });
});

describe("maxLeverageForHealthBuffer", () => {
  it("solves L = minHF/(minHF − LT) for readable LTs", () => {
    // minHF 1.3: LT 0.95 → 1.3/0.35 ≈ 3.714; LT 0.90 → 1.3/0.40 = 3.25
    expect(maxLeverageForHealthBuffer(0.95)!).toBeCloseTo(3.7142857, 5);
    expect(maxLeverageForHealthBuffer(0.9)!).toBeCloseTo(3.25, 10);
  });

  it("fails closed on unreadable/out-of-range LT", () => {
    for (const lt of [null, undefined, NaN, Infinity, 0, 1, 1.5, -0.2]) {
      expect(maxLeverageForHealthBuffer(lt as number | null | undefined)).toBeNull();
    }
  });
});

describe("computeLoopTargetLeverage", () => {
  const good = { vaultId: 4, liquidationThreshold: 0.95, stakingApy: 0.08, borrowApr: 0.05 };

  it("targets the health-buffer max, quantized DOWN to 0.1x, with the HF at that leverage", () => {
    // JupSOL LT 0.95 → healthMax ≈ 3.714 → 3.7x; HF = 3.7·0.95/2.7 ≈ 1.3018
    const t = computeLoopTargetLeverage(good);
    expect(t.leverage).toBe(3.7);
    expect(t.healthAtOpen!).toBeCloseTo((3.7 * 0.95) / 2.7, 10);
    expect(t.healthAtOpen!).toBeGreaterThanOrEqual(LOOP_RISK_POLICY.minOpenHealthFactor);
    // mSOL LT 0.90 → 3.25 → 3.2x
    expect(computeLoopTargetLeverage({ ...good, vaultId: 47, liquidationThreshold: 0.9 }).leverage).toBe(3.2);
  });

  it("binds on the per-vault cap when the LT allows more", () => {
    // mSOL cap 4: LT 0.999 → healthMax = 1.3/(1.3−0.999) ≈ 4.32 > cap → capped at 4x.
    const t = computeLoopTargetLeverage({ ...good, vaultId: 47, liquidationThreshold: 0.999 });
    expect(t.leverage).toBe(4);
  });

  it("fails closed: no target when not allowlisted, LT unreadable, or rates unreadable", () => {
    expect(computeLoopTargetLeverage({ ...good, vaultId: 999 }).reason).toBe("vault_not_allowlisted");
    expect(computeLoopTargetLeverage({ ...good, liquidationThreshold: null }).reason).toBe("lt_unreadable");
    expect(computeLoopTargetLeverage({ ...good, liquidationThreshold: 1.2 }).reason).toBe("lt_unreadable");
    expect(computeLoopTargetLeverage({ ...good, stakingApy: null }).reason).toBe("rates_unreadable");
    expect(computeLoopTargetLeverage({ ...good, borrowApr: null }).reason).toBe("rates_unreadable");
    for (const r of [
      computeLoopTargetLeverage({ ...good, vaultId: 999 }),
      computeLoopTargetLeverage({ ...good, liquidationThreshold: null }),
      computeLoopTargetLeverage({ ...good, stakingApy: null }),
    ]) {
      expect(r.leverage).toBeNull();
      expect(r.healthAtOpen).toBeNull();
    }
  });

  it("UNLEVERED when carry is non-positive: staking APY ≤ borrow APR → null target", () => {
    expect(computeLoopTargetLeverage({ ...good, stakingApy: 0.05, borrowApr: 0.05 }).reason).toBe("carry_nonpositive");
    expect(computeLoopTargetLeverage({ ...good, stakingApy: 0.04, borrowApr: 0.05 }).reason).toBe("carry_nonpositive");
    expect(computeLoopTargetLeverage({ ...good, stakingApy: 0.04, borrowApr: 0.05 }).leverage).toBeNull();
  });

  it("a target LT so low the buffer allows ≤1x → cap_too_low, never a degenerate leverage", () => {
    // LT 0.3 → healthMax = 1.3/1.0 = 1.3 → floor(1.3·10)/10 = 1.3 > 1 → fine;
    // LT 0.1 → 1.3/1.2 ≈ 1.083 → quantized 1.0 → not > 1 → cap_too_low.
    const t = computeLoopTargetLeverage({ ...good, liquidationThreshold: 0.1 });
    expect(t.leverage).toBeNull();
    expect(t.reason).toBe("cap_too_low");
  });
});

// ---------------------------------------------------------------------------
// P4 HOP — recoverHopSolReturned (money-safety: never guess the returned SOL)
// ---------------------------------------------------------------------------
describe("recoverHopSolReturned", () => {
  it("prefers the close leg's own figure when present and positive (string or bigint)", () => {
    expect(recoverHopSolReturned({ closeSolReturnedRaw: "1500" })).toEqual({ ok: true, solReturnedRaw: 1500n });
    expect(recoverHopSolReturned({ closeSolReturnedRaw: 900n })).toEqual({ ok: true, solReturnedRaw: 900n });
  });

  it("trusts the figure even when a baseline is also available (figure wins)", () => {
    const r = recoverHopSolReturned({ closeSolReturnedRaw: "1000", baselineRaw: 5n, agentLamportsNowRaw: 999999n });
    expect(r).toEqual({ ok: true, solReturnedRaw: 1000n });
  });

  it("falls back to the STRICT delta vs the PERSISTED pre-close baseline when no figure", () => {
    const r = recoverHopSolReturned({ closeSolReturnedRaw: null, baselineRaw: 1000n, agentLamportsNowRaw: 1600n });
    expect(r).toEqual({ ok: true, solReturnedRaw: 600n });
  });

  it("uses the delta path when the figure is present-but-unusable (unparseable or ≤0)", () => {
    expect(recoverHopSolReturned({ closeSolReturnedRaw: "not-a-number", baselineRaw: 100n, agentLamportsNowRaw: 450n }))
      .toEqual({ ok: true, solReturnedRaw: 350n });
    expect(recoverHopSolReturned({ closeSolReturnedRaw: "0", baselineRaw: 100n, agentLamportsNowRaw: 450n }))
      .toEqual({ ok: true, solReturnedRaw: 350n });
    expect(recoverHopSolReturned({ closeSolReturnedRaw: -5n, baselineRaw: 100n, agentLamportsNowRaw: 450n }))
      .toEqual({ ok: true, solReturnedRaw: 350n });
  });

  it("FAILS CLOSED when no figure and no persisted baseline (cannot size the reopen)", () => {
    const r = recoverHopSolReturned({ closeSolReturnedRaw: null, baselineRaw: null, agentLamportsNowRaw: 1600n });
    expect(r.ok).toBe(false);
  });

  it("FAILS CLOSED when the current balance is unreadable (never a fresh guess)", () => {
    const r = recoverHopSolReturned({ closeSolReturnedRaw: null, baselineRaw: 1000n, agentLamportsNowRaw: null });
    expect(r.ok).toBe(false);
  });

  it("FAILS CLOSED when the delta is zero or negative (no measurable SOL yet)", () => {
    expect(recoverHopSolReturned({ closeSolReturnedRaw: null, baselineRaw: 1000n, agentLamportsNowRaw: 1000n }).ok).toBe(false);
    expect(recoverHopSolReturned({ closeSolReturnedRaw: null, baselineRaw: 1000n, agentLamportsNowRaw: 400n }).ok).toBe(false);
  });

  it("a fresh POST-close baseline (≈ now) fails closed rather than sizing the reopen to ~0", () => {
    // Simulates the bug the fix prevents: reading the baseline AFTER the close so
    // now − baseline ≈ 0. Must fail closed, never return a near-zero solReturned.
    const postClose = 1600n;
    const r = recoverHopSolReturned({ closeSolReturnedRaw: null, baselineRaw: postClose, agentLamportsNowRaw: postClose });
    expect(r.ok).toBe(false);
  });
});
