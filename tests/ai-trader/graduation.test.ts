// WO-6 acceptance: unit tests for server/ai-trader/graduation.ts — the pure
// §2e paper-graduation evaluator. No mocks needed (pure module by design).
// Covers: criteria sanitization floors (clamps can only make graduation
// harder), the plan-exact verdict semantics (fail ONLY at period end),
// mark-to-market drawdown (open-position MTM counts), profit-factor edge
// cases (no losses ⇒ Infinity, no wins ⇒ 0), drawdown measured as % of
// ALLOCATION, fail-closed throws on garbage inputs, and the canGoLive gate.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  sanitizeGraduationCriteria,
  evaluateGraduation,
  canGoLive,
  GRADUATION_FLOORS,
  DEFAULT_MIN_PROFIT_FACTOR,
  QUALIFICATION_ERA_REGISTRY,
  buildQualificationEraObject,
  canonicalEraDecimal,
  computeQualificationEraDigest,
  qualificationEraDecisionPatch,
  qualificationEraMutationPatch,
  validateQualificationEraDeclarationChanges,
  type QualificationEraComponent,
  type QualificationEraRegistry,
  type GraduationTradeRecord,
} from "../../server/ai-trader/graduation";
import type { AiTraderBot } from "@shared/schema";

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z
const DAY = 86_400_000;

const CRITERIA = {
  periodDays: 7,
  minTrades: 3,
  minNetPnl: 0,
  maxDrawdownPct: 30,
  minProfitFactor: 1.1,
};

function trade(daysAgo: number, netPnl: number): GraduationTradeRecord {
  return { closedAt: NOW - daysAgo * DAY, netPnl };
}

describe("sanitizeGraduationCriteria", () => {
  it("returns the §2e defaults for missing/garbage input", () => {
    for (const raw of [undefined, null, "junk", 42, {}]) {
      const c = sanitizeGraduationCriteria(raw);
      expect(c).toEqual({
        periodDays: 30,
        minTrades: 10,
        minNetPnl: 0,
        maxDrawdownPct: 30,
        minProfitFactor: DEFAULT_MIN_PROFIT_FACTOR,
      });
    }
  });

  it("clamps every field to its floor/ceiling — never looser", () => {
    const c = sanitizeGraduationCriteria({
      periodDays: 1, // below 7-day floor
      minTrades: 0, // below 3 floor
      minNetPnl: -500, // below 0 floor
      maxDrawdownPct: 95, // above 50 ceiling
      minProfitFactor: 0.2, // below 1.0 floor
    });
    expect(c.periodDays).toBe(GRADUATION_FLOORS.minPeriodDays);
    expect(c.minTrades).toBe(GRADUATION_FLOORS.minTrades);
    expect(c.minNetPnl).toBe(GRADUATION_FLOORS.minNetPnl);
    expect(c.maxDrawdownPct).toBe(GRADUATION_FLOORS.maxDrawdownPctCeiling);
    expect(c.minProfitFactor).toBe(GRADUATION_FLOORS.minProfitFactor);
  });

  it("keeps stricter-than-default values untouched", () => {
    const c = sanitizeGraduationCriteria({
      periodDays: 60,
      minTrades: 25,
      minNetPnl: 100,
      maxDrawdownPct: 10,
      minProfitFactor: 2.0,
    });
    expect(c).toEqual({ periodDays: 60, minTrades: 25, minNetPnl: 100, maxDrawdownPct: 10, minProfitFactor: 2.0 });
  });

  it("replaces non-finite fields with defaults (then floors)", () => {
    const c = sanitizeGraduationCriteria({ periodDays: NaN, minTrades: Infinity as unknown as number });
    expect(c.periodDays).toBe(30);
    expect(c.minTrades).toBe(10);
  });
});

describe("evaluateGraduation — verdict semantics", () => {
  it("stays 'in_trial' before the period elapses even when every criterion is met", () => {
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(3, 50), trade(2, 40), trade(1, -20), trade(0.5, 30)],
      trialStartedAt: NOW - 4 * DAY, // 4 of 7 days
      allocation: 1000,
      now: NOW,
    });
    expect(r.criteriaMet).toBe(true);
    expect(r.periodElapsed).toBe(false);
    expect(r.verdict).toBe("in_trial");
  });

  it("graduates when the period elapsed and all criteria pass", () => {
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(6, 50), trade(4, 40), trade(2, -20), trade(1, 30)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(r.verdict).toBe("graduated");
    expect(r.tradeCount).toBe(4);
    expect(r.netPnl).toBe(100);
    expect(r.profitFactor).toBeCloseTo(120 / 20, 6);
    expect(r.failures).toEqual([]);
  });

  it("fails at period end when there are too few trades", () => {
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(5, 50), trade(3, 40)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(r.verdict).toBe("failed");
    expect(r.failures.some((f) => f.includes("closed trades 2"))).toBe(true);
  });

  it("fails on non-positive net PnL", () => {
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(6, 50), trade(4, -30), trade(2, -20)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(r.netPnl).toBe(0);
    expect(r.verdict).toBe("failed");
    expect(r.failures.some((f) => f.includes("net PnL"))).toBe(true);
  });

  it("fails on profit factor below the threshold (blocks the one-lucky-trade record)", () => {
    // 3 trades, net positive, but PF = 105/100 = 1.05 < 1.1.
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(6, 105), trade(4, -60), trade(2, -40)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(r.profitFactor).toBeCloseTo(1.05, 6);
    expect(r.verdict).toBe("failed");
    expect(r.failures.some((f) => f.includes("profit factor"))).toBe(true);
  });

  it("fails on max drawdown breach — measured as % of ALLOCATION, not of peak", () => {
    // Equity: 1000 → 1500 (+500 win) → 1150 (−350 loss). Drop 350 from peak
    // = 35% of the 1000 allocation (only 23.3% of the 1500 peak — the
    // allocation denominator is the binding one).
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(6, 500), trade(4, -350), trade(2, 10)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(r.maxDrawdownPct).toBeCloseTo(35, 6);
    expect(r.verdict).toBe("failed");
    expect(r.failures.some((f) => f.includes("max drawdown"))).toBe(true);
  });

  it("counts open-position MTM against drawdown (windfall + floating loss cannot graduate)", () => {
    const base = {
      criteria: CRITERIA,
      trades: [trade(6, 100), trade(4, 50), trade(2, 30)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    };
    // Flat: clean graduate.
    expect(evaluateGraduation(base).verdict).toBe("graduated");
    // Same record but a −400 floating loss right now: peak 1180 → MTM 780 is
    // a 40%-of-allocation drop ⇒ failed.
    const r = evaluateGraduation({ ...base, openPositionMtm: -400 });
    expect(r.maxDrawdownPct).toBeCloseTo(40, 6);
    expect(r.verdict).toBe("failed");
  });

  it("profit factor is Infinity with wins and no losses (passes), 0 with no trades (fails)", () => {
    const wins = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(6, 10), trade(4, 20), trade(2, 30)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(wins.profitFactor).toBe(Infinity);
    expect(wins.verdict).toBe("graduated");

    const empty = evaluateGraduation({
      criteria: CRITERIA,
      trades: [],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(empty.profitFactor).toBe(0);
    expect(empty.verdict).toBe("failed");
  });

  it("sorts trades internally — out-of-order input yields the same drawdown", () => {
    const ordered = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(6, 500), trade(4, -350), trade(2, 10)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    const shuffled = evaluateGraduation({
      criteria: CRITERIA,
      trades: [trade(2, 10), trade(6, 500), trade(4, -350)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(shuffled.maxDrawdownPct).toBeCloseTo(ordered.maxDrawdownPct, 10);
  });

  it("accepts Date objects for closedAt/trialStartedAt", () => {
    const r = evaluateGraduation({
      criteria: CRITERIA,
      trades: [
        { closedAt: new Date(NOW - 6 * DAY), netPnl: 20 },
        { closedAt: new Date(NOW - 4 * DAY), netPnl: 20 },
        { closedAt: new Date(NOW - 2 * DAY), netPnl: 20 },
      ],
      trialStartedAt: new Date(NOW - 8 * DAY),
      allocation: 1000,
      now: NOW,
    });
    expect(r.verdict).toBe("graduated");
  });

  it("throws (fail closed) on invalid allocation and non-finite trade PnL", () => {
    expect(() =>
      evaluateGraduation({ criteria: CRITERIA, trades: [], trialStartedAt: NOW - 8 * DAY, allocation: 0, now: NOW })
    ).toThrow(/invalid allocation/);
    expect(() =>
      evaluateGraduation({ criteria: CRITERIA, trades: [], trialStartedAt: NOW - 8 * DAY, allocation: NaN, now: NOW })
    ).toThrow(/invalid allocation/);
    expect(() =>
      evaluateGraduation({
        criteria: CRITERIA,
        trades: [{ closedAt: NOW - DAY, netPnl: NaN }],
        trialStartedAt: NOW - 8 * DAY,
        allocation: 1000,
        now: NOW,
      })
    ).toThrow(/non-finite trade netPnl/);
  });

  it("sanitizes hostile criteria before evaluating (loose jsonb cannot ease the floors)", () => {
    // 2 trades with periodDays:1/minTrades:1 in the row — floors force 7d/3
    // trades, so this record cannot graduate.
    const r = evaluateGraduation({
      criteria: { periodDays: 1, minTrades: 1, minNetPnl: -100, maxDrawdownPct: 99, minProfitFactor: 0 },
      trades: [trade(6, 10), trade(2, 10)],
      trialStartedAt: NOW - 8 * DAY,
      allocation: 1000,
      now: NOW,
    });
    expect(r.criteria.minTrades).toBe(3);
    expect(r.verdict).toBe("failed");
  });
});

describe("canGoLive", () => {
  it("allows an exact graduated era and keeps waiver separate", () => {
    expect(canGoLive("graduated", "ERA", "ERA")).toEqual({ ok: true });
    expect(canGoLive("waived")).toEqual({ ok: true });
  });

  it("fails closed for missing and stale graduated eras", () => {
    expect(canGoLive("graduated", null, null).ok).toBe(false);
    expect(canGoLive("graduated", "CURRENT", "OLD").ok).toBe(false);
  });

  it("blocks 'in_trial' and 'failed' with distinct messages", () => {
    const trial = canGoLive("in_trial");
    expect(trial.ok).toBe(false);
    if (!trial.ok) expect(trial.error).toMatch(/still in progress/);
    const failed = canGoLive("failed");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toMatch(/failed/);
    const junk = canGoLive("something_else");
    expect(junk.ok).toBe(false);
  });
});

const ERA_BOT = {
  protocol: "pacifica",
  marketSource: "scanner",
  market: "btc-perp",
  timeframe: "15m",
  mode: "auto",
  riskProfile: "guarded",
  model: "anthropic/claude-opus-4.8",
  sizingMode: "risk_based",
  riskMinPct: "0.50",
  riskMaxPct: "1.50",
  allocatedUsdc: "00100.00",
  maxLeverage: 3,
  stopPolicy: "static",
} as AiTraderBot;

function provenance(finality: "forming" | "finalized" = "finalized") {
  return { source: "okx", venue: "okx", basis: "perp", proxy: "direct", finality };
}

describe("qualification era identity", () => {
  it("canonicalizes decimal representations without floating-point conversion", () => {
    expect(canonicalEraDecimal("0.50")).toBe("0.5");
    expect(canonicalEraDecimal(".5")).toBe("0.5");
    expect(canonicalEraDecimal("-0.000")).toBe("0");
    expect(() => canonicalEraDecimal("1e3")).toThrow(/malformed/);
  });

  it("is deterministic and binds venue/basis while grouping admitted finality", () => {
    const base = { candleProvenance: { selected: provenance("forming"), parent: provenance() } };
    const finalized = { candleProvenance: { selected: provenance("finalized"), parent: provenance() } };
    expect(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest: base }))
      .toBe(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest: finalized }));
    const gate = { candleProvenance: { selected: { ...provenance(), source: "gate", venue: "gate" }, parent: provenance() } };
    expect(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest: gate }))
      .not.toBe(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest: finalized }));
    const spot = { candleProvenance: { selected: { ...provenance(), basis: "spot" }, parent: provenance() } };
    expect(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest: spot }))
      .not.toBe(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest: finalized }));
    expect(buildQualificationEraObject({ bot: ERA_BOT, contextDigest: finalized }).bot.allocatedUsdc).toBe("100");
  });

  it("binds scanner identity to the strategy while retaining the exact reviewed provenance shape", () => {
    const contextDigest = {
      candleProvenance: {
        selected: provenance("forming"),
        parent: provenance("finalized"),
      },
    };
    const identity = buildQualificationEraObject({ bot: ERA_BOT, contextDigest });

    expect(identity).toEqual({
      schemaVersion: 1,
      components: {
        scanner_capability_policy: 3,
        accepted_candle_provenance: 1,
        prompt_context_schema: 3,
        session_policy: 1,
        guardrail_risk_policy: 4,
        paper_execution_simulator: 3,
      },
      bot: {
        protocol: "pacifica",
        marketSource: "scanner",
        market: "SCANNER_DYNAMIC",
        timeframe: "15m",
        mode: "auto",
        riskProfile: "guarded",
        model: "anthropic/claude-opus-4.8",
        sizingMode: "risk_based",
        riskMinPct: "0.5",
        riskMaxPct: "1.5",
        allocatedUsdc: "100",
        maxLeverage: 3,
        stopPolicy: "static",
      },
      scannerPick: {
        timeframe: "15m",
        marketSource: "scanner",
        selected: {
          source: "okx",
          venue: "okx",
          basis: "perp",
          proxy: "direct",
          finalityClass: "forming_or_finalized",
        },
        parent: {
          source: "okx",
          venue: "okx",
          basis: "perp",
          proxy: "direct",
          finalityClass: "forming_or_finalized",
        },
      },
      candleProvenance: {
        selected: {
          source: "okx",
          venue: "okx",
          basis: "perp",
          proxy: "direct",
          finalityClass: "forming_or_finalized",
        },
        parent: {
          source: "okx",
          venue: "okx",
          basis: "perp",
          proxy: "direct",
          finalityClass: "forming_or_finalized",
        },
      },
    });
    expect(Object.keys(identity.scannerPick!)).toEqual(["timeframe", "marketSource", "selected", "parent"]);

    const scannerOtherMarket = { ...ERA_BOT, market: "SOL-PERP" } as AiTraderBot;
    expect(computeQualificationEraDigest({ bot: ERA_BOT, contextDigest }))
      .toBe(computeQualificationEraDigest({ bot: scannerOtherMarket, contextDigest }));

    const fixed = { ...ERA_BOT, marketSource: "fixed" } as AiTraderBot;
    const fixedOtherMarket = { ...fixed, market: "SOL-PERP" } as AiTraderBot;
    expect(computeQualificationEraDigest({ bot: fixed, contextDigest }))
      .not.toBe(computeQualificationEraDigest({ bot: fixedOtherMarket, contextDigest }));
  });

  it("keeps scanner market picks inside one era while every other material mutation still invalidates", () => {
    expect(qualificationEraMutationPatch(ERA_BOT, { autoNext: false }, "test")).toBeNull();
    expect(qualificationEraMutationPatch(ERA_BOT, { market: " BTC-PERP ", riskMinPct: ".5" }, "test")).toBeNull();
    expect(qualificationEraMutationPatch(ERA_BOT, { market: "SOL-PERP" }, "test")).toBeNull();

    const fixed = { ...ERA_BOT, marketSource: "fixed" } as AiTraderBot;
    expect(qualificationEraMutationPatch(fixed, { market: "SOL-PERP" }, "test"))
      .toMatchObject({ graduationState: "in_trial", currentQualificationEraDigest: null });
    expect(qualificationEraMutationPatch(ERA_BOT, { market: "SOL-PERP", timeframe: "1h" }, "test"))
      .toMatchObject({ graduationState: "in_trial", currentQualificationEraDigest: null });
    expect(qualificationEraMutationPatch(fixed, { marketSource: "scanner", market: "SOL-PERP" }, "test"))
      .toMatchObject({ graduationState: "in_trial", currentQualificationEraDigest: null });
    expect(qualificationEraMutationPatch(ERA_BOT, { marketSource: "fixed", market: "SOL-PERP" }, "test"))
      .toMatchObject({ graduationState: "in_trial", currentQualificationEraDigest: null });
    expect(qualificationEraMutationPatch(ERA_BOT, { model: "different/model" }, "test"))
      .toMatchObject({ graduationState: "in_trial", currentQualificationEraDigest: null });
  });

  it("preserves an explicit waiver while rebinding era identity and its original invalidation cause", () => {
    const trialStartedAt = new Date(NOW - DAY);
    const waived = {
      ...ERA_BOT,
      graduationState: "waived",
      currentQualificationEraDigest: "OLD",
      qualificationEraInvalidationReason: null,
      trialStartedAt,
    } as AiTraderBot;
    expect(qualificationEraMutationPatch(waived, { model: "different/model" }, "material_bot_settings_changed"))
      .toMatchObject({
        graduationState: "waived",
        currentQualificationEraDigest: null,
        qualificationEraInvalidationReason: "material_bot_settings_changed",
      });

    const invalidated = {
      ...waived,
      currentQualificationEraDigest: null,
      qualificationEraInvalidationReason: "material_bot_settings_changed",
    } as AiTraderBot;
    expect(qualificationEraDecisionPatch(invalidated, "NEW")).toMatchObject({
      graduationState: "waived",
      currentQualificationEraDigest: "NEW",
      qualificationEraInvalidationReason: "material_bot_settings_changed",
      trialStartedAt,
    });
  });

  it("fails closed on malformed integer identity", () => {
    expect(() => computeQualificationEraDigest({
      bot: { ...ERA_BOT, maxLeverage: Number.NaN },
      contextDigest: { candleProvenance: { selected: provenance(), parent: provenance() } },
    })).toThrow(/integer is malformed/);
  });
});

function cloneRegistry(): QualificationEraRegistry {
  return JSON.parse(JSON.stringify(QUALIFICATION_ERA_REGISTRY)) as QualificationEraRegistry;
}

describe("qualification era forgotten-declaration gate", () => {
  const components = Object.keys(QUALIFICATION_ERA_REGISTRY) as QualificationEraComponent[];

  it("declares paper/live isolation cleanup as reviewed no-bumps for affected policies", () => {
    expect(QUALIFICATION_ERA_REGISTRY.scanner_capability_policy).toMatchObject({
      materialVersion: 3,
      decisionGeneration: 25,
      decision: "no_bump",
    });
    expect(QUALIFICATION_ERA_REGISTRY.prompt_context_schema).toMatchObject({
      materialVersion: 3,
      decisionGeneration: 4,
      decision: "no_bump",
    });
    expect(QUALIFICATION_ERA_REGISTRY.guardrail_risk_policy).toMatchObject({
      materialVersion: 4,
      decisionGeneration: 15,
      decision: "no_bump",
    });
    expect(QUALIFICATION_ERA_REGISTRY.paper_execution_simulator).toMatchObject({
      materialVersion: 3,
      decisionGeneration: 12,
      decision: "no_bump",
    });
    expect(QUALIFICATION_ERA_REGISTRY.accepted_candle_provenance).toMatchObject({
      materialVersion: 1,
      decisionGeneration: 7,
      decision: "no_bump",
    });
  });

  for (const component of components) {
    const changedPath = QUALIFICATION_ERA_REGISTRY[component].ownerPaths[0];
    it(`${component}: rejects silence`, () => {
      const base = cloneRegistry();
      const current = cloneRegistry();
      delete (current[component] as any).decision;
      expect(validateQualificationEraDeclarationChanges({ base, current, changedPaths: [changedPath] })).not.toEqual([]);
    });
    it(`${component}: rejects stale generation`, () => {
      expect(validateQualificationEraDeclarationChanges({ base: cloneRegistry(), current: cloneRegistry(), changedPaths: [changedPath] })).not.toEqual([]);
    });
    it(`${component}: rejects bump with unchanged version`, () => {
      const base = cloneRegistry();
      const current = cloneRegistry();
      current[component].decisionGeneration += 1;
      current[component].decision = "bump";
      expect(validateQualificationEraDeclarationChanges({ base, current, changedPaths: [changedPath] })).not.toEqual([]);
    });
    it(`${component}: accepts one declared bump`, () => {
      const base = cloneRegistry();
      const current = cloneRegistry();
      for (const affected of components.filter((candidate) =>
        current[candidate].ownerPaths.includes(changedPath))) {
        current[affected].decisionGeneration += 1;
        current[affected].materialVersion += 1;
        current[affected].decision = "bump";
      }
      expect(validateQualificationEraDeclarationChanges({ base, current, changedPaths: [changedPath] })).toEqual([]);
    });
    it(`${component}: accepts one reviewed no_bump`, () => {
      const base = cloneRegistry();
      const current = cloneRegistry();
      for (const affected of components.filter((candidate) =>
        current[candidate].ownerPaths.includes(changedPath))) {
        current[affected].decisionGeneration += 1;
        current[affected].decision = "no_bump";
      }
      expect(validateQualificationEraDeclarationChanges({ base, current, changedPaths: [changedPath] })).toEqual([]);
    });
  }

  it("binds the real changed-path inventory to the base registry", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const mergeBase = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
    const changedPaths = execFileSync("git", ["diff", "--name-only", mergeBase, "HEAD"], { cwd: root, encoding: "utf8" })
      .trim().split(/\r?\n/).filter(Boolean);
    const source = execFileSync("git", ["show", `${mergeBase}:server/ai-trader/graduation.ts`], { cwd: root, encoding: "utf8" });
    const beginMarker = "QV_QUALIFICATION_ERA_REGISTRY_LITERAL_BEGIN";
    const endMarker = "QV_QUALIFICATION_ERA_REGISTRY_LITERAL_END";
    const hasBegin = source.includes(beginMarker);
    const hasEnd = source.includes(endMarker);
    let base: QualificationEraRegistry | null = null;
    if (hasBegin || hasEnd) {
      expect(hasBegin && hasEnd, "base registry markers must be complete").toBe(true);
      const match = /QV_QUALIFICATION_ERA_REGISTRY_LITERAL_BEGIN[\s\S]*?=\s*(\{[\s\S]*\})\s*as const satisfies QualificationEraRegistry;[\s\S]*?QV_QUALIFICATION_ERA_REGISTRY_LITERAL_END/.exec(source);
      expect(match, "base registry literal must be parseable").not.toBeNull();
      base = JSON.parse(match![1]) as QualificationEraRegistry;
    }
    const currentSource = readFileSync(resolve(root, "server/ai-trader/graduation.ts"), "utf8");
    expect(currentSource).toContain(beginMarker);
    expect(currentSource).toContain(endMarker);
    expect(validateQualificationEraDeclarationChanges({ base, current: QUALIFICATION_ERA_REGISTRY, changedPaths })).toEqual([]);
  });
});
