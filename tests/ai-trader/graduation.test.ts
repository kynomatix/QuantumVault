// WO-6 acceptance: unit tests for server/ai-trader/graduation.ts — the pure
// §2e paper-graduation evaluator. No mocks needed (pure module by design).
// Covers: criteria sanitization floors (clamps can only make graduation
// harder), the plan-exact verdict semantics (fail ONLY at period end),
// mark-to-market drawdown (open-position MTM counts), profit-factor edge
// cases (no losses ⇒ Infinity, no wins ⇒ 0), drawdown measured as % of
// ALLOCATION, fail-closed throws on garbage inputs, and the canGoLive gate.
import { describe, it, expect } from "vitest";
import {
  sanitizeGraduationCriteria,
  evaluateGraduation,
  canGoLive,
  GRADUATION_FLOORS,
  DEFAULT_MIN_PROFIT_FACTOR,
  type GraduationTradeRecord,
} from "../../server/ai-trader/graduation";

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
  it("allows 'graduated' and 'waived' only", () => {
    expect(canGoLive("graduated")).toEqual({ ok: true });
    expect(canGoLive("waived")).toEqual({ ok: true });
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
