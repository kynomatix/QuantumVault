/**
 * Vendored keeper policy tests (P3 T101).
 *
 * Ported from `docs/qntsol/keeper/test/nav-policy.test.ts` (the policy-relevant
 * half; nav/allocation tests stay with the un-vendored reference library).
 * Converted node:test → vitest. Behaviour must stay identical to the pristine
 * reference — if these diverge, the vendored copy drifted.
 */
import { describe, expect, it } from "vitest";
import {
  decideDeleverage,
  evaluateOracle,
  type DeleveragePolicyParams,
} from "../../server/vault/loop/keeper";
import type { VenueState } from "../../server/vault/loop/keeper";

const st = (v: string, over: Partial<VenueState> = {}): [string, VenueState] => [
  v,
  {
    venue: v, borrowRateApy: 0.05, stakingYieldApy: 0.08, netCarryApy: 0.03,
    borrowLiquiditySol: 1e6, isFixedRate: false, paused: false, ...over,
  },
];

const policyParams: DeleveragePolicyParams = {
  healthReduceMultiple: 1.25,
  healthUnwindMultiple: 1.1,
  carryReduceApy: 0.005,
  reduceStep: 0.25,
};

const oracleParams = {
  maxAgeSeconds: { stakePool: 600, sanctum: 120, pythEma: 60 },
  sanityBand: 0.01,
};

describe("keeper deleverage reflex (vendored)", () => {
  it("healthy position does nothing", () => {
    const d = decideDeleverage(
      [{ venue: "jupiter", positionId: "p1", healthFactor: 2.0, liquidationFloor: 1.0 }],
      new Map([st("jupiter")]),
      policyParams,
    );
    expect(d[0].action).toBe("none");
    expect(d[0].reason).toBe("healthy");
  });

  it("reduce band then unwind band, with reason strings", () => {
    const positions = [
      { venue: "jupiter", positionId: "reduceMe", healthFactor: 1.2, liquidationFloor: 1.0 },
      { venue: "jupiter", positionId: "unwindMe", healthFactor: 1.05, liquidationFloor: 1.0 },
    ];
    const d = decideDeleverage(positions, new Map([st("jupiter")]), policyParams);
    expect(d[0].action).toBe("reduce");
    expect(d[0].fraction).toBe(0.25);
    expect(d[0].reason).toContain("reduce bound");
    expect(d[1].action).toBe("unwind");
    expect(d[1].fraction).toBe(1);
    expect(d[1].reason).toContain("unwind bound");
  });

  it("negative carry reduces variable positions but not fixed rate ones", () => {
    const positions = [
      { venue: "jupiter", positionId: "var", healthFactor: 2.0, liquidationFloor: 1.0 },
      { venue: "loopscale", positionId: "fix", healthFactor: 2.0, liquidationFloor: 1.0 },
    ];
    const states = new Map([
      st("jupiter", { netCarryApy: -0.02 }),
      st("loopscale", { netCarryApy: -0.02, isFixedRate: true }),
    ]);
    const d = decideDeleverage(positions, states, policyParams);
    expect(d.find((x) => x.positionId === "var")!.action).toBe("reduce");
    expect(d.find((x) => x.positionId === "fix")!.action).toBe("none");
  });

  it("carry below the (positive) floor reduces even when carry is still positive", () => {
    const d = decideDeleverage(
      [{ venue: "jupiter", positionId: "thin", healthFactor: 2.0, liquidationFloor: 1.0 }],
      new Map([st("jupiter", { netCarryApy: 0.004 })]),
      policyParams,
    );
    expect(d[0].action).toBe("reduce");
    expect(d[0].reason).toContain("below floor");
  });

  it("missing venue state means no carry-based action (health bands still apply)", () => {
    const d = decideDeleverage(
      [{ venue: "jupiter", positionId: "p1", healthFactor: 2.0, liquidationFloor: 1.0 }],
      new Map(),
      policyParams,
    );
    expect(d[0].action).toBe("none");
  });

  it("policy params are sanity checked", () => {
    expect(() =>
      decideDeleverage([], new Map(), { ...policyParams, healthUnwindMultiple: 1.5 }),
    ).toThrow();
  });

  it("health band beats carry: unwind wins over a carry reduce", () => {
    const d = decideDeleverage(
      [{ venue: "jupiter", positionId: "p1", healthFactor: 1.05, liquidationFloor: 1.0 }],
      new Map([st("jupiter", { netCarryApy: -0.05 })]),
      policyParams,
    );
    expect(d[0].action).toBe("unwind");
    expect(d[0].fraction).toBe(1);
  });
});

describe("keeper oracle sanity band (vendored)", () => {
  it("agreement inside band marks at min of fair and market", () => {
    const v = evaluateOracle(
      [
        { source: "stakePool", priceSol: 1.1, ageSeconds: 10 },
        { source: "sanctum", priceSol: 1.098, ageSeconds: 10 },
        { source: "pythEma", priceSol: 1.101, ageSeconds: 10 },
      ],
      oracleParams,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.markPriceSol).toBe(1.098);
  });

  it("stale primary fails closed", () => {
    const v = evaluateOracle(
      [
        { source: "stakePool", priceSol: 1.1, ageSeconds: 9999 },
        { source: "pythEma", priceSol: 1.1, ageSeconds: 10 },
      ],
      oracleParams,
    );
    expect(v.ok).toBe(false);
  });

  it("cross check outside the band fails closed (depeg or manipulation)", () => {
    const v = evaluateOracle(
      [
        { source: "stakePool", priceSol: 1.1, ageSeconds: 10 },
        { source: "pythEma", priceSol: 1.0, ageSeconds: 10 },
      ],
      oracleParams,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("deviates");
  });

  it("no fresh cross check fails closed rather than trusting primary alone", () => {
    const v = evaluateOracle(
      [{ source: "stakePool", priceSol: 1.1, ageSeconds: 10 }],
      oracleParams,
    );
    expect(v.ok).toBe(false);
  });

  it("stale cross checks are ignored, not trusted", () => {
    const v = evaluateOracle(
      [
        { source: "stakePool", priceSol: 1.1, ageSeconds: 10 },
        { source: "sanctum", priceSol: 0.5, ageSeconds: 9999 },
      ],
      oracleParams,
    );
    // The wildly-off reading is stale, so it is excluded — leaving NO fresh
    // cross check, which fails closed (not ok), rather than marking off it.
    expect(v.ok).toBe(false);
  });
});
