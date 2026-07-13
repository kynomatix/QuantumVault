// risk-based-sizing-spec Phase A acceptance: the risk_based G5 replacement in
// server/ai-trader/guardrails.ts (pure module — no mocks needed). Covers the
// confidence→riskPct linear map, the min(alloc, equity)×0.95 base (amendment 1),
// audit stamps (amendment 2), the slippage-aware stop floor (amendment 3),
// derived-leverage auto-minimization, the risk_capped under-risk cap, the G2
// liquidation RE-CHECK at derived leverage, quantization fail-closed paths, the
// post-quantization risk assert, every fail-closed input path, and byte-identical
// discretionary behavior when the mode is off.
import { describe, it, expect } from "vitest";
import {
  applyGuardrails,
  MAX_ENTRY_SLIPPAGE_FRAC,
  RISK_STOP_MIN_SLIPPAGE_MULT,
  RISK_BASE_HEADROOM,
  type GuardrailInput,
  type GuardrailResult,
  type TradeDecisionLike,
} from "../../server/ai-trader/guardrails";

// --- Fixtures --------------------------------------------------------------------
// entry 100, ATR 0.1 → smartLeverageCap 5 (never the binding constraint here);
// mmw 0.02 → liq@2x = 52 (far from any SL used); fee 0.0004/side.

function makeInput(overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    entryPrice: 100,
    atr14: 0.1,
    botMaxLeverage: 5,
    timeframe: "15m",
    takerFeeRate: 0.0004,
    maintenanceMarginWeight: 0.02,
    allocatedUsdc: 1000,
    hasOpenPosition: false,
    quantizeOrderSize: (s: number) => s, // identity — quantization cases override
    sizingMode: "risk_based",
    riskMinPct: 0.5,
    riskMaxPct: 1.5,
    currentEquity: 1000,
    ...overrides,
  };
}

function makeLong(overrides: Partial<TradeDecisionLike> = {}): TradeDecisionLike {
  return {
    action: "long",
    entryType: "market",
    leverage: 2,
    sizePct: 50,
    stopLossPrice: 98, // 2% stop — clears the 1% slippage floor and the 0.5% LTF band
    takeProfitPrice: 106,
    confidence: 7,
    invalidation: "loses 98 support",
    rationale: "uptrend continuation",
    ...overrides,
  };
}

function makeShort(overrides: Partial<TradeDecisionLike> = {}): TradeDecisionLike {
  return makeLong({
    action: "short",
    stopLossPrice: 102,
    takeProfitPrice: 94,
    ...overrides,
  });
}

function codes(r: GuardrailResult): string[] {
  return r.violations.map((v) => v.code);
}

function expectOk(r: GuardrailResult): asserts r is Extract<GuardrailResult, { ok: true }> {
  expect(r.ok).toBe(true);
}

const BASE = 1000 * RISK_BASE_HEADROOM; // 950 — default sizing base in these tests

// --- Confidence → riskPct linear map ----------------------------------------------

describe("risk_based sizing — confidence scaling", () => {
  it("confidence 1 risks exactly riskMinPct of base (0.5% of 950 = $4.75 → notional 237.50 at a 2% stop)", () => {
    const r = applyGuardrails(makeLong({ confidence: 1 }), makeInput());
    expectOk(r);
    expect(r.clamped.sizingMode).toBe("risk_based");
    expect(r.clamped.riskPct).toBeCloseTo(0.5, 10);
    expect(r.clamped.base).toBeCloseTo(BASE, 10);
    expect(r.clamped.riskBudgetUsd).toBeCloseTo(4.75, 10);
    expect(r.clamped.notionalUsdc).toBeCloseTo(237.5, 8);
    expect(r.clamped.leverage).toBe(1); // 237.5 fits in 950 margin → minimal leverage
    expect(r.clamped.marginUsdc).toBeCloseTo(237.5, 8);
    expect(r.clamped.sizeBase).toBeCloseTo(2.375, 8);
    expect(r.violations).toEqual([]); // no clamps, no notes
  });

  it("confidence 10 risks exactly riskMaxPct (1.5% of 950 = $14.25 → notional 712.50)", () => {
    const r = applyGuardrails(makeLong({ confidence: 10 }), makeInput());
    expectOk(r);
    expect(r.clamped.riskPct).toBeCloseTo(1.5, 10);
    expect(r.clamped.riskBudgetUsd).toBeCloseTo(14.25, 10);
    expect(r.clamped.notionalUsdc).toBeCloseTo(712.5, 8);
    expect(r.clamped.leverage).toBe(1);
  });

  it("interpolates linearly between the endpoints (confidence 7 → 0.5 + 1.0×(6/9) ≈ 1.1667%)", () => {
    const r = applyGuardrails(makeLong({ confidence: 7 }), makeInput());
    expectOk(r);
    expect(r.clamped.riskPct).toBeCloseTo(0.5 + (1.5 - 0.5) * (6 / 9), 10);
  });

  it("a degenerate band (min === max) is valid and always risks that exact pct", () => {
    const r = applyGuardrails(
      makeLong({ confidence: 4 }),
      makeInput({ riskMinPct: 1.0, riskMaxPct: 1.0 })
    );
    expectOk(r);
    expect(r.clamped.riskPct).toBeCloseTo(1.0, 10);
  });
});

// --- Sizing base: min(allocation, live equity) × headroom (amendment 1) ------------

describe("risk_based sizing — base derivation", () => {
  it("a drawdown shrinks the base: equity 500 halves the notional vs equity 1000", () => {
    const full = applyGuardrails(makeLong({ confidence: 10 }), makeInput({ currentEquity: 1000 }));
    const drawn = applyGuardrails(makeLong({ confidence: 10 }), makeInput({ currentEquity: 500 }));
    expectOk(full);
    expectOk(drawn);
    expect(drawn.clamped.base).toBeCloseTo(500 * RISK_BASE_HEADROOM, 10);
    expect(drawn.clamped.notionalUsdc!).toBeCloseTo(full.clamped.notionalUsdc! / 2, 8);
  });

  it("a profit surplus never inflates past the allocation: equity 2000 sizes identically to equity 1000", () => {
    const atAlloc = applyGuardrails(makeLong(), makeInput({ currentEquity: 1000 }));
    const surplus = applyGuardrails(makeLong(), makeInput({ currentEquity: 2000 }));
    expectOk(atAlloc);
    expectOk(surplus);
    expect(surplus.clamped.base).toBeCloseTo(BASE, 10);
    expect(surplus.clamped.notionalUsdc!).toBeCloseTo(atAlloc.clamped.notionalUsdc!, 10);
  });

  it("applies the 0.95 headroom to the min, not to raw equity (base stamp = 950.00 exactly)", () => {
    const r = applyGuardrails(makeLong(), makeInput());
    expectOk(r);
    expect(r.clamped.base).toBe(Math.min(1000, 1000) * RISK_BASE_HEADROOM);
  });
});

// --- Derived leverage --------------------------------------------------------------

describe("risk_based sizing — derived leverage", () => {
  it("derives the minimal leverage that fits the notional (3% risk, 1% stop → notional 2850 = 3× base)", () => {
    const r = applyGuardrails(
      makeLong({ stopLossPrice: 99, takeProfitPrice: 103 }),
      makeInput({ riskMinPct: 3.0, riskMaxPct: 3.0 })
    );
    expectOk(r);
    expect(r.clamped.leverage).toBe(3);
    expect(r.clamped.notionalUsdc).toBeCloseTo(2850, 6);
    expect(r.clamped.marginUsdc).toBeCloseTo(950, 6);
    expect(codes(r)).not.toContain("risk_capped");
  });

  it("ignores the model's requested leverage entirely (requested 5×, small risk → executes at 1×)", () => {
    const r = applyGuardrails(makeLong({ leverage: 5, confidence: 1 }), makeInput());
    expectOk(r);
    expect(r.clamped.leverage).toBe(1);
  });

  it("float noise on an exact multiple does not bump leverage a full step (epsilon guard)", () => {
    // riskPct 2 → budget 19 → notional 950 exactly = base × 1. Without the
    // −1e-9 epsilon a float wobble in (base × 2)/100/0.02 could ceil to 2.
    const r = applyGuardrails(
      makeLong({ stopLossPrice: 98, takeProfitPrice: 106 }),
      makeInput({ riskMinPct: 2.0, riskMaxPct: 2.0 })
    );
    expectOk(r);
    expect(r.clamped.notionalUsdc).toBeCloseTo(950, 6);
    expect(r.clamped.leverage).toBe(1);
  });

  it("omits sizePct from the clamped decision — the model's size request never reaches the executor", () => {
    const r = applyGuardrails(makeLong(), makeInput());
    expectOk(r);
    expect(r.clamped.sizePct).toBeUndefined();
  });

  it("suppresses the size_pct_clamped audit note (the field is ignored, clamping it would lie)", () => {
    const r = applyGuardrails(makeLong({ sizePct: 95 }), makeInput());
    expectOk(r);
    expect(codes(r)).not.toContain("size_pct_clamped");
  });
});

// --- risk_capped: margin cap under-risks, never over-risks --------------------------

describe("risk_based sizing — risk_capped margin cap", () => {
  it("caps notional at base × Lmax when even max leverage cannot carry the risk-implied notional", () => {
    // botMaxLeverage 1 ⇒ Lmax 1. 3% risk at a 1% stop wants notional 2850 > 950.
    const r = applyGuardrails(
      makeLong({ leverage: 1, stopLossPrice: 99, takeProfitPrice: 103 }),
      makeInput({ botMaxLeverage: 1, riskMinPct: 3.0, riskMaxPct: 3.0 })
    );
    expectOk(r); // non-fatal: the trade proceeds UNDER-risked
    expect(codes(r)).toContain("risk_capped");
    expect(r.violations.find((v) => v.code === "risk_capped")!.fatal).toBe(false);
    expect(r.clamped.leverage).toBe(1);
    expect(r.clamped.notionalUsdc).toBeCloseTo(950, 6);
    expect(r.clamped.marginUsdc).toBeCloseTo(950, 6);
    // Realized risk 9.5 ≤ budget 28.5 — fail-safe direction.
    const realized = r.clamped.sizeBase! * Math.abs(100 - 99);
    expect(realized).toBeLessThanOrEqual(r.clamped.riskBudgetUsd!);
  });

  it("does not flag risk_capped when the notional fits", () => {
    const r = applyGuardrails(makeLong(), makeInput());
    expectOk(r);
    expect(codes(r)).not.toContain("risk_capped");
  });
});

// --- Slippage-aware stop floor (amendment 3) ----------------------------------------

describe("risk_based sizing — slippage-aware stop floor", () => {
  const floorFrac = RISK_STOP_MIN_SLIPPAGE_MULT * MAX_ENTRY_SLIPPAGE_FRAC; // 0.01

  it("rejects a stop just inside the floor (0.99% < 1%)", () => {
    const r = applyGuardrails(
      makeLong({ stopLossPrice: 99.01, takeProfitPrice: 103 }),
      makeInput()
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("risk_stop_too_tight_for_slippage");
    expect(r.violations.find((v) => v.code === "risk_stop_too_tight_for_slippage")!.fatal).toBe(true);
  });

  it("passes a stop exactly at the floor (1.00%)", () => {
    const r = applyGuardrails(
      makeLong({ stopLossPrice: 99, takeProfitPrice: 103 }),
      makeInput()
    );
    expectOk(r);
    expect(Math.abs(100 - 99) / 100).toBeCloseTo(floorFrac, 12);
  });

  it("applies the same floor to shorts", () => {
    const r = applyGuardrails(
      makeShort({ stopLossPrice: 100.99, takeProfitPrice: 97 }),
      makeInput()
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("risk_stop_too_tight_for_slippage");
  });

  it("does NOT apply the floor in discretionary mode (0.99% stop passes the 0.5% LTF band)", () => {
    const r = applyGuardrails(
      makeLong({ stopLossPrice: 99.01, takeProfitPrice: 103 }),
      makeInput({ sizingMode: "discretionary" })
    );
    expectOk(r);
    expect(codes(r)).not.toContain("risk_stop_too_tight_for_slippage");
  });
});

// --- G2 liquidation RE-CHECK at the derived leverage ---------------------------------

describe("risk_based sizing — G2 re-check at derived leverage", () => {
  it("rejects when the DERIVED leverage pulls liquidation inside the stop (first pass at 1× passed)", () => {
    // mmw 0.35: liq@1x = 100×(1−1+0.35) = 35 → first-pass G2 passes (99 > 35).
    // 3% risk at a 1% stop derives 3×: liq@3x = 100×(1−1/3+0.35) ≈ 101.67 → SL 99
    // is BEYOND liquidation → must reject with the same G2 code.
    const r = applyGuardrails(
      makeLong({ leverage: 1, stopLossPrice: 99, takeProfitPrice: 103 }),
      makeInput({ maintenanceMarginWeight: 0.35, riskMinPct: 3.0, riskMaxPct: 3.0 })
    );
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.code === "sl_inside_liquidation");
    expect(v).toBeDefined();
    expect(v!.rule).toBe("G2");
    expect(v!.fatal).toBe(true);
    expect(v!.message).toContain("risk-derived 3×");
  });

  it("passes the re-check when the derived leverage still leaves the stop inside liquidation", () => {
    // Same shape, normal mmw 0.02: liq@3x = 100×(1−1/3+0.02) ≈ 68.67 < 99 → fine.
    const r = applyGuardrails(
      makeLong({ leverage: 1, stopLossPrice: 99, takeProfitPrice: 103 }),
      makeInput({ riskMinPct: 3.0, riskMaxPct: 3.0 })
    );
    expectOk(r);
    expect(r.clamped.leverage).toBe(3);
  });
});

// --- Quantization fail-closed paths ---------------------------------------------------

describe("risk_based sizing — quantization", () => {
  it("rejects when the venue lot floors the size to zero (never bumps up to a venue minimum)", () => {
    const r = applyGuardrails(
      makeLong({ confidence: 1 }), // notional 237.5 → raw size 2.375
      makeInput({ quantizeOrderSize: (s) => Math.floor(s / 10) * 10 }) // lot of 10 → 0
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("size_quantized_to_zero");
  });

  it("honors the budget after a normal round-DOWN quantizer", () => {
    const r = applyGuardrails(
      makeLong({ confidence: 7 }),
      makeInput({ quantizeOrderSize: (s) => Math.floor(s * 100) / 100 })
    );
    expectOk(r);
    const realized = r.clamped.sizeBase! * Math.abs(100 - 98);
    expect(realized).toBeLessThanOrEqual(r.clamped.riskBudgetUsd! * (1 + 1e-6));
  });

  it("rejects with risk_assert_failed when a quantizer rounds UP past the budget", () => {
    // conf 1: budget 4.75, raw size 2.375. Ceil-to-0.01 → 2.38 → realized 4.76 > 4.75.
    const r = applyGuardrails(
      makeLong({ confidence: 1 }),
      makeInput({ quantizeOrderSize: (s) => Math.ceil(s * 100) / 100 })
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("risk_assert_failed");
    expect(r.violations.find((v) => v.code === "risk_assert_failed")!.fatal).toBe(true);
  });
});

// --- Fail-closed input paths ----------------------------------------------------------

describe("risk_based sizing — fail-closed inputs", () => {
  it.each([
    ["NaN", NaN],
    ["zero", 0],
    ["negative", -5],
    ["Infinity", Infinity],
    ["undefined", undefined],
  ])("rejects risk_equity_unavailable when equity is %s (never falls back to allocation)", (_label, equity) => {
    const r = applyGuardrails(makeLong(), makeInput({ currentEquity: equity as number | undefined }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("risk_equity_unavailable");
  });

  it.each([
    ["min > max", 1.5, 0.5],
    ["min below 0.1", 0.05, 1.0],
    ["max above 3.0", 0.5, 3.5],
    ["min NaN", NaN, 1.0],
    ["max undefined", 0.5, undefined],
  ])("rejects risk_params_invalid for band %s", (_label, min, max) => {
    const r = applyGuardrails(
      makeLong(),
      makeInput({ riskMinPct: min as number, riskMaxPct: max as number | undefined })
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("risk_params_invalid");
  });

  it("flat and close actions never require equity in risk_based mode", () => {
    const flat = applyGuardrails(
      { action: "flat", confidence: 5, invalidation: "n/a", rationale: "no edge" },
      makeInput({ currentEquity: undefined })
    );
    expect(flat.ok).toBe(true);
    const close = applyGuardrails(
      { action: "close", confidence: 5, invalidation: "n/a", rationale: "exit" },
      makeInput({ currentEquity: undefined, hasOpenPosition: true })
    );
    expect(close.ok).toBe(true);
  });
});

// --- Discretionary regression: byte-identical when the mode is off ---------------------

describe("discretionary path — unchanged with the feature off", () => {
  it.each([
    ["absent", undefined],
    ["explicit", "discretionary" as const],
  ])("sizingMode %s: sizes from sizePct and stamps NO risk fields", (_label, mode) => {
    const r = applyGuardrails(makeLong(), makeInput({ sizingMode: mode, currentEquity: undefined }));
    expectOk(r);
    expect(r.clamped.sizePct).toBe(50);
    expect(r.clamped.marginUsdc).toBeCloseTo(500, 10); // 1000 × 50%
    expect(r.clamped.notionalUsdc).toBeCloseTo(1000, 10); // × leverage 2
    expect(r.clamped.leverage).toBe(2); // model's request honored (within caps)
    expect(r.clamped.sizingMode).toBeUndefined();
    expect(r.clamped.riskPct).toBeUndefined();
    expect(r.clamped.base).toBeUndefined();
    expect(r.clamped.riskBudgetUsd).toBeUndefined();
  });

  it("still records the size_pct_clamped note in discretionary mode", () => {
    const r = applyGuardrails(
      makeLong({ sizePct: 95 }),
      makeInput({ sizingMode: "discretionary" })
    );
    expectOk(r);
    expect(codes(r)).toContain("size_pct_clamped");
    expect(r.clamped.sizePct).toBe(90);
  });
});

// --- Audit stamps (amendment 2): executed size reconstructible from the row ------------

describe("risk_based sizing — audit stamps", () => {
  it("stamps sizingMode/riskPct/base/riskBudgetUsd consistently: base × riskPct/100 = riskBudgetUsd and sizeBase × stopDist ≤ budget", () => {
    const r = applyGuardrails(
      makeShort({ confidence: 9 }),
      makeInput({ quantizeOrderSize: (s) => Math.floor(s * 1000) / 1000 })
    );
    expectOk(r);
    const c = r.clamped;
    expect(c.sizingMode).toBe("risk_based");
    expect((c.base! * c.riskPct!) / 100).toBeCloseTo(c.riskBudgetUsd!, 10);
    expect(c.sizeBase! * Math.abs(100 - 102)).toBeLessThanOrEqual(c.riskBudgetUsd! * (1 + 1e-6));
    expect(c.confidence).toBe(9);
  });
});
