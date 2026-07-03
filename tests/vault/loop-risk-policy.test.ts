import { describe, expect, it } from "vitest";
import {
  LOOP_RISK_POLICY,
  LOOP_VAULT_ALLOWLIST,
  evaluateLoopOpenRequest,
  type LoopOpenPolicyInput,
} from "../../server/vault/loop/loop-risk-policy";

function goodInput(overrides: Partial<LoopOpenPolicyInput> = {}): LoopOpenPolicyInput {
  return {
    vaultId: 4,
    requestedLeverage: 2,
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
    expect(d.effectiveMaxLeverage).toBe(2);
    expect(d.depegBps).not.toBeNull();
    expect(d.depegBps!).toBeLessThan(LOOP_RISK_POLICY.depegBandBps);
  });

  it("both launch vaults (4 JupSOL, 47 mSOL) are allowlisted at 2x", () => {
    expect(LOOP_VAULT_ALLOWLIST[4]).toEqual({ symbol: "JupSOL", maxLeverage: 2 });
    expect(LOOP_VAULT_ALLOWLIST[47]).toEqual({ symbol: "mSOL", maxLeverage: 2 });
    expect(evaluateLoopOpenRequest(goodInput({ vaultId: 47 })).allowed).toBe(true);
  });

  it("non-allowlisted vault → deny loop_vault_not_allowlisted", () => {
    const d = evaluateLoopOpenRequest(goodInput({ vaultId: 43 })); // INF/USDC borrow vault
    expect(d.allowed).toBe(false);
    expect(d.effectiveMaxLeverage).toBeNull();
    expect(d.reasons.some((r) => r.code === "loop_vault_not_allowlisted" && r.severity === "deny")).toBe(true);
  });

  it("leverage above the per-vault cap → deny loop_leverage_exceeds_cap", () => {
    const d = evaluateLoopOpenRequest(goodInput({ requestedLeverage: 2.5 }));
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.code === "loop_leverage_exceeds_cap")).toBe(true);
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
