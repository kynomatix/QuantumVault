// Agentic Trader Plan §5 / Part B WO-4: the hard guardrail layer (G1–G5) applied to
// every LLM trade decision AFTER zod validation and BEFORE anything executes. The
// LLM's output is a *request*; this module decides what may execute.
//
// PURE MODULE — no imports, no I/O, no adapter/storage/network access. Every input
// it needs (price, ATR, maintenance-margin weight, the adapter's size quantizer) is
// passed in by the caller (decide.ts), so every rule is exhaustively unit-testable
// at its exact boundary.
//
// Clamp-vs-reject policy (WO-4, binding): leverage (G1) and sizePct (G5) are the
// ONLY fields ever clamped — both are pure magnitudes where "less than requested"
// is strictly safer and still the same trade. ALL price-level rules (G2 stop-loss
// side/band/liquidation-buffer, G3 reward:risk floor, G4 fee-aware TP minimum)
// REJECT the cycle instead: a moved stop or take-profit is a *different trade*
// than the model chose, and silently "fixing" it would corrupt the audit trail
// and the model's own trade-history feedback loop.

export type GuardrailAction = "long" | "short" | "flat" | "close";
export type GuardrailTimeframe = "15m" | "1h" | "4h" | "1d";

/** Structural shape of a zod-validated trade decision (decide.ts owns the schema). */
export interface TradeDecisionLike {
  action: GuardrailAction;
  entryType?: "market";
  leverage?: number;
  sizePct?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  confidence: number;
  invalidation: string;
  rationale: string;
}

export interface GuardrailInput {
  /** Current mark price — the market-entry reference for every price-level rule. */
  entryPrice: number;
  /** ATR(14) on the bot's selected timeframe (drives smartLeverageCap). */
  atr14: number;
  /** The bot's configured max leverage (user-set, 1–5). */
  botMaxLeverage: number;
  timeframe: GuardrailTimeframe;
  /** Per-side taker fee rate as a fraction (e.g. 0.0004 = 4 bps). */
  takerFeeRate: number;
  /** adapter.getMaintenanceMarginWeight(market) — liquidation-buffer input. */
  maintenanceMarginWeight: number;
  /** The bot's allocated collateral in USDC. */
  allocatedUsdc: number;
  /** Whether the bot currently holds an open position ('close' contract check). */
  hasOpenPosition: boolean;
  /**
   * Adapter-bound size quantizer (`(sizeBase) => adapter.quantizeOrderSize(market, sizeBase)`),
   * injected as a function so this module stays pure and deterministic per inputs.
   */
  quantizeOrderSize: (sizeBase: number) => number;
  /**
   * risk-based-sizing-spec Phase A. 'discretionary' (default when absent) keeps
   * the model-picked sizePct path byte-identical; 'risk_based' replaces ONLY the
   * G5 margin derivation with confidence-scaled fixed-fractional sizing.
   */
  sizingMode?: "discretionary" | "risk_based";
  /** Risk band: % of the sizing base risked at confidence 1 (min) / 10 (max). Required in risk_based mode; validated here, fail closed. */
  riskMinPct?: number;
  riskMaxPct?: number;
  /**
   * Live tradeable equity in collateral units, read FRESH by the caller at
   * decision time (adapter free collateral for live bots; allocation + cumulative
   * realized PnL for paper bots). Required in risk_based mode. A failed or
   * unreadable equity read MUST be passed as NaN so this module fails closed
   * (risk_equity_unavailable) — never fall back to the static allocation, which
   * would silently re-inflate risk after a drawdown.
   */
  currentEquity?: number;
}

export interface GuardrailViolation {
  /** Which plan-§5 rule fired. CONTRACT = decision-contract violation (§4), not a G-rule. */
  rule: "G1" | "G2" | "G3" | "G4" | "G5" | "CONTRACT";
  code: string;
  message: string;
  /** true ⇒ the cycle is rejected; false ⇒ a recorded clamp, trade still proceeds. */
  fatal: boolean;
}

/** The post-guardrail decision that is allowed to execute (recorded as clampedDecision). */
export interface ClampedDecision {
  action: GuardrailAction;
  entryType?: "market";
  /** Final leverage after G1 (min of requested, bot max, smartLeverageCap, hard ceiling 5). */
  leverage?: number;
  /** Final size after G5 bounding to [10, 90]. */
  sizePct?: number;
  /** Margin committed = allocatedUsdc × sizePct/100 (≤ 90% of allocation by construction). */
  marginUsdc?: number;
  /** Position notional = marginUsdc × leverage. */
  notionalUsdc?: number;
  /** Base-asset order size after the adapter's lot quantization. */
  sizeBase?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  confidence: number;
  invalidation: string;
  rationale: string;
  // --- risk-based sizing audit trail (Phase A amendment 2) — present only when
  // sizingMode === 'risk_based', so every executed size is reconstructible from
  // the decision row alone (base × riskPct/100 = riskBudgetUsd; confidence is
  // stamped above for all modes).
  /** Which sizing path produced marginUsdc/notionalUsdc/sizeBase. */
  sizingMode?: "discretionary" | "risk_based";
  /** Resolved confidence-scaled risk % of base actually used this trade. */
  riskPct?: number;
  /** Sizing base = min(allocatedUsdc, currentEquity) × RISK_BASE_HEADROOM. */
  base?: number;
  /** Promised max loss at the stop = base × riskPct/100. */
  riskBudgetUsd?: number;
}

export type GuardrailResult =
  | { ok: true; clamped: ClampedDecision; violations: GuardrailViolation[] }
  | { ok: false; violations: GuardrailViolation[] };

// --- Constants (plan §5 MVP defaults) -----------------------------------------

/** G1 swing-allowance multiplier k in ddProxy = k × ATR(14)/price (plan B0 primitives). */
export const SMART_LEVERAGE_K = 3;
/** G1 hard leverage ceiling for the MVP — nothing may exceed 5× regardless of config. */
export const LEVERAGE_HARD_CEILING = 5;
/** G3 reward:risk floor (after fees). */
export const RR_FLOOR = 1.2;
/** G4: TP distance must be ≥ this multiple of the round-trip taker fee (as a % move). */
export const TP_FEE_DISTANCE_MULTIPLE = 4;
/** G5 sizePct bounds — margin used is thereby capped at 90% of allocation. */
export const SIZE_PCT_MIN = 10;
export const SIZE_PCT_MAX = 90;
/** G2 SL distance bands from entry, % — timeframe-aware (external audit). */
export const SL_BAND_LTF = { minPct: 0.5, maxPct: 10 } as const;
export const SL_BAND_HTF = { minPct: 1, maxPct: 15 } as const;

// --- risk-based sizing constants (risk-based-sizing-spec Phase A) ---------------

/**
 * MIRROR of the executor's ENTRY_MAX_SLIPPAGE_PCT (0.5%), expressed as a
 * fraction. This module is pure (no imports), so the constant cannot be
 * imported from executor.ts; a sync test in tests/ai-trader/executor.test.ts
 * pins `MAX_ENTRY_SLIPPAGE_FRAC === ENTRY_MAX_SLIPPAGE_PCT / 100` so the two
 * can never drift silently. If the executor bound changes, this changes with it.
 */
export const MAX_ENTRY_SLIPPAGE_FRAC = 0.005;
/**
 * Amendment 3: a stop tighter than this multiple of the max entry slippage is
 * rejected in risk_based mode — a fill slipped the full bound would consume
 * ≥ 1/mult of the entire risk budget before the trade even starts, making the
 * risk promise a lie. 2 × 0.5% ⇒ 1% minimum stop distance.
 * Phase B note: the executor should additionally TIGHTEN its own slippage bound
 * for risk-based entries (slippage directly erodes the risk promise there).
 */
export const RISK_STOP_MIN_SLIPPAGE_MULT = 2;
/** Amendment 1: sizing-base headroom — base = min(allocation, equity) × 0.95, so posted margin leaves room for fees/entry slippage and never rejects on a full-margin post. */
export const RISK_BASE_HEADROOM = 0.95;
/** Post-quantization risk assert tolerance — float noise only, NEVER a real allowance (quantizers round down; anything above this means the quantizer rounded up). */
export const RISK_ASSERT_EPSILON = 1e-6;
/** Valid band for riskMinPct/riskMaxPct (mirrors the API-layer schema; re-validated here, fail closed). */
export const RISK_PCT_MIN = 0.1;
export const RISK_PCT_MAX = 3.0;
/** Confidence scale endpoints for the linear risk interpolation. */
export const RISK_CONF_MIN = 1;
export const RISK_CONF_MAX = 10;

const LTF_TIMEFRAMES: ReadonlySet<GuardrailTimeframe> = new Set(["15m", "1h"]);

// --- Pure helpers ---------------------------------------------------------------

/**
 * G1 volatility-based leverage cap — EXACT formula from the plan's B0 primitives
 * (~L513) and the WO-3 context-builder echo: ddProxy = k × ATR(14)/price;
 * cap = clamp(floor(0.5/ddProxy), 1, 5).  Reuses the platform's existing
 * 50%-effective-drawdown convention.
 *
 * WO-4.1 corrective: non-finite/zero ATR or price now FAILS CLOSED to 1× — an
 * unknown volatility regime must get the SAFEST leverage, not the most
 * permissive. (The original fallback to the hard ceiling matched the WO-3
 * prompt-echo semantics, but the echo is advisory text for the model; this
 * function is the enforcement point and must not reward missing data with 5×.
 * The WO-3 echo remains deliberately divergent — it only tells the model what
 * the *bot max* is, it never executes anything.)
 */
export function smartLeverageCap(atr14: number, price: number): number {
  const ddProxy =
    Number.isFinite(atr14) && Number.isFinite(price) && price > 0
      ? (SMART_LEVERAGE_K * atr14) / price
      : 0;
  if (!(ddProxy > 0)) return 1;
  return Math.min(LEVERAGE_HARD_CEILING, Math.max(1, Math.floor(0.5 / ddProxy)));
}

/**
 * G2 liquidation-price estimate from the maintenance-margin weight (standard
 * cross-venue approximation for an isolated position opened at `entry`):
 *   long:  entry × (1 − 1/L + mmw)
 *   short: entry × (1 + 1/L − mmw)
 * The SL must sit strictly INSIDE this price (closer to entry) or the position
 * would liquidate before the stop fires.
 */
export function estimateLiquidationPrice(
  entryPrice: number,
  side: "long" | "short",
  leverage: number,
  maintenanceMarginWeight: number
): number {
  const inv = 1 / leverage;
  return side === "long"
    ? entryPrice * (1 - inv + maintenanceMarginWeight)
    : entryPrice * (1 + inv - maintenanceMarginWeight);
}

function violation(
  rule: GuardrailViolation["rule"],
  code: string,
  message: string,
  fatal: boolean
): GuardrailViolation {
  return { rule, code, message, fatal };
}

function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// --- The guardrail gate -----------------------------------------------------------

/**
 * Apply G1–G5 to a zod-validated decision. Returns either the clamped decision that
 * may execute (with any non-fatal clamp notes) or `ok:false` with the full violation
 * list (fatal + non-fatal) for the `rejected_guardrails` audit record.
 */
export function applyGuardrails(
  decision: TradeDecisionLike,
  input: GuardrailInput
): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  // ---- Non-entry actions -------------------------------------------------------
  if (decision.action === "flat") {
    return {
      ok: true,
      clamped: {
        action: "flat",
        confidence: decision.confidence,
        invalidation: decision.invalidation,
        rationale: decision.rationale,
      },
      violations,
    };
  }

  if (decision.action === "close") {
    // Decision contract §4: 'close' is only valid with an open position.
    if (!input.hasOpenPosition) {
      violations.push(
        violation(
          "CONTRACT",
          "close_without_position",
          "action 'close' is only valid while a position is open; the bot is flat",
          true
        )
      );
      return { ok: false, violations };
    }
    return {
      ok: true,
      clamped: {
        action: "close",
        confidence: decision.confidence,
        invalidation: decision.invalidation,
        rationale: decision.rationale,
      },
      violations,
    };
  }

  // ---- Entry actions (long/short) ------------------------------------------------
  const side = decision.action;

  // Defensive contract re-checks. The zod schema (decide.ts) already enforces these
  // for long/short; a pure module must still fail closed on bad standalone input.
  for (const field of [
    "entryType",
    "leverage",
    "sizePct",
    "stopLossPrice",
    "takeProfitPrice",
  ] as const) {
    if (decision[field] === undefined || decision[field] === null) {
      violations.push(
        violation(
          "CONTRACT",
          "missing_required_field",
          `'${field}' is required when action is '${side}'`,
          true
        )
      );
    }
  }
  if (!isPositiveFinite(input.entryPrice)) {
    violations.push(
      violation("CONTRACT", "bad_entry_price", "entry (mark) price is not a positive finite number", true)
    );
  }
  if (!isPositiveFinite(input.allocatedUsdc)) {
    violations.push(
      violation("CONTRACT", "bad_allocation", "allocated collateral is not a positive finite number", true)
    );
  }
  if (violations.some((v) => v.fatal)) return { ok: false, violations };

  const entry = input.entryPrice;
  const requestedLeverage = decision.leverage as number;
  const requestedSizePct = decision.sizePct as number;
  const sl = decision.stopLossPrice as number;
  const tp = decision.takeProfitPrice as number;

  // ---- G1: smart leverage clamp (clamp-only, never fatal) -------------------------
  const smartCap = smartLeverageCap(input.atr14, entry);
  const leverageCeiling = Math.max(
    1,
    Math.min(input.botMaxLeverage, smartCap, LEVERAGE_HARD_CEILING)
  );
  const appliedLeverage = Math.min(Math.max(1, Math.floor(requestedLeverage)), leverageCeiling);
  if (appliedLeverage !== requestedLeverage) {
    violations.push(
      violation(
        "G1",
        "leverage_clamped",
        `leverage clamped from ${requestedLeverage} to ${appliedLeverage} (bot max ${input.botMaxLeverage}, smartLeverageCap ${smartCap}, hard ceiling ${LEVERAGE_HARD_CEILING})`,
        false
      )
    );
  }

  // ---- G5: size clamp (clamp-only for the pct bound) -------------------------------
  // In risk_based mode the model's sizePct is IGNORED entirely (size derives from
  // the risk budget), so the clamp note is skipped — recording a clamp of an
  // unused field would corrupt the audit trail. The field is still contract-
  // required above: the model's output contract is unchanged in Phase A.
  const riskBasedMode = input.sizingMode === "risk_based";
  const appliedSizePct = Math.min(Math.max(requestedSizePct, SIZE_PCT_MIN), SIZE_PCT_MAX);
  if (!riskBasedMode && appliedSizePct !== requestedSizePct) {
    violations.push(
      violation(
        "G5",
        "size_pct_clamped",
        `sizePct clamped from ${requestedSizePct} to ${appliedSizePct} (bounds ${SIZE_PCT_MIN}–${SIZE_PCT_MAX})`,
        false
      )
    );
  }

  // ---- G2: stop loss — side, band, liquidation buffer (all reject-only) ------------
  const slOnCorrectSide = side === "long" ? sl < entry : sl > entry;
  if (!slOnCorrectSide) {
    violations.push(
      violation(
        "G2",
        "sl_wrong_side",
        `stopLossPrice ${sl} is not on the loss side of entry ${entry} for a ${side}`,
        true
      )
    );
  } else {
    const band = LTF_TIMEFRAMES.has(input.timeframe) ? SL_BAND_LTF : SL_BAND_HTF;
    const slDistPct = (Math.abs(entry - sl) / entry) * 100;
    if (slDistPct < band.minPct) {
      violations.push(
        violation(
          "G2",
          "sl_too_tight",
          `stop distance ${slDistPct.toFixed(3)}% is below the ${input.timeframe} minimum ${band.minPct}%`,
          true
        )
      );
    } else if (slDistPct > band.maxPct) {
      violations.push(
        violation(
          "G2",
          "sl_too_wide",
          `stop distance ${slDistPct.toFixed(3)}% exceeds the ${input.timeframe} maximum ${band.maxPct}%`,
          true
        )
      );
    }

    // Liquidation buffer — computed with the APPLIED (post-clamp) leverage, since
    // that is the leverage that would actually execute.
    const liq = estimateLiquidationPrice(entry, side, appliedLeverage, input.maintenanceMarginWeight);
    const slInsideLiq = side === "long" ? sl > liq : sl < liq;
    if (!slInsideLiq) {
      violations.push(
        violation(
          "G2",
          "sl_inside_liquidation",
          `stopLossPrice ${sl} is at/beyond the estimated liquidation price ${liq.toFixed(6)} at ${appliedLeverage}× (mmw ${input.maintenanceMarginWeight}) — the position would liquidate before the stop fires`,
          true
        )
      );
    }
  }

  // ---- G3/G4: take profit — side, fee floor, RR floor (all reject-only) -------------
  const tpOnCorrectSide = side === "long" ? tp > entry : tp < entry;
  if (!tpOnCorrectSide) {
    violations.push(
      violation(
        "G3",
        "tp_wrong_side",
        `takeProfitPrice ${tp} is not on the profit side of entry ${entry} for a ${side}`,
        true
      )
    );
  } else {
    const roundTripFeeRate = 2 * input.takerFeeRate; // open + close, as a fraction of price
    const tpDistFrac = Math.abs(tp - entry) / entry;

    // G4: fee-aware minimum move.
    const minTpDistFrac = TP_FEE_DISTANCE_MULTIPLE * roundTripFeeRate;
    if (tpDistFrac < minTpDistFrac) {
      violations.push(
        violation(
          "G4",
          "tp_below_fee_floor",
          `TP distance ${(tpDistFrac * 100).toFixed(3)}% is below ${TP_FEE_DISTANCE_MULTIPLE}× the round-trip taker fee (${(minTpDistFrac * 100).toFixed(3)}%)`,
          true
        )
      );
    }

    // G3: reward:risk ≥ 1.2 after fees. Fees are charged on notional ≈ a price move
    // of roundTripFeeRate × entry. WO-4.1 corrective: fees hurt BOTH sides of the
    // ratio — a TP exit nets reward − feeMove, and an SL exit costs risk + feeMove
    // (the stopped-out trader still pays the round trip). The original formula
    // divided by bare `risk`, understating the true loss and letting marginal
    // trades through:  rrAfterFees = (reward − feeMove) / (risk + feeMove).
    if (slOnCorrectSide) {
      const reward = Math.abs(tp - entry);
      const risk = Math.abs(entry - sl); // > 0, else sl_wrong_side already fired
      const feeMove = entry * roundTripFeeRate;
      const rrAfterFees = (reward - feeMove) / (risk + feeMove);
      if (rrAfterFees < RR_FLOOR) {
        violations.push(
          violation(
            "G3",
            "rr_below_floor",
            `reward:risk after fees ${rrAfterFees.toFixed(3)} is below the ${RR_FLOOR} floor (reward ${reward.toFixed(6)}, risk ${risk.toFixed(6)}, fee move ${feeMove.toFixed(6)} charged on both legs)`,
            true
          )
        );
      }
    }
  }

  if (violations.some((v) => v.fatal)) return { ok: false, violations };

  // ---- G5 (risk_based replacement): confidence-scaled fixed-fractional sizing ------
  // risk-based-sizing-spec Phase A. Replaces ONLY the margin derivation below;
  // G1–G4 above ran verbatim (G1 supplies leverageCeiling = Lmax; the model's
  // requested leverage and sizePct are ignored in this mode). Invariants:
  // fail-safe direction is always UNDER-risking; every failure REJECTS the
  // cycle (fail closed) — there is no fallback to the discretionary path.
  if (riskBasedMode) {
    const riskMin = input.riskMinPct;
    const riskMax = input.riskMaxPct;
    const equity = input.currentEquity;
    const conf = decision.confidence;

    // Fail closed on unusable inputs (invariant: never size off garbage).
    if (!isPositiveFinite(equity)) {
      violations.push(
        violation(
          "G5",
          "risk_equity_unavailable",
          `live equity read is not a positive finite number (${equity}) — failing closed; risk-based sizing never falls back to the static allocation`,
          true
        )
      );
      return { ok: false, violations };
    }
    if (
      typeof riskMin !== "number" || !Number.isFinite(riskMin) ||
      typeof riskMax !== "number" || !Number.isFinite(riskMax) ||
      riskMin < RISK_PCT_MIN || riskMax > RISK_PCT_MAX || riskMin > riskMax ||
      !Number.isFinite(conf)
    ) {
      violations.push(
        violation(
          "G5",
          "risk_params_invalid",
          `risk band [${riskMin}, ${riskMax}] or confidence ${conf} is invalid (band must satisfy ${RISK_PCT_MIN} <= min <= max <= ${RISK_PCT_MAX}) — failing closed`,
          true
        )
      );
      return { ok: false, violations };
    }

    // Stop distance as a fraction of entry (> 0: sl_wrong_side already gated).
    const stopDistFrac = Math.abs(entry - sl) / entry;
    if (!isPositiveFinite(stopDistFrac)) {
      violations.push(
        violation("G5", "risk_params_invalid", `stop distance fraction ${stopDistFrac} is not positive finite — failing closed`, true)
      );
      return { ok: false, violations };
    }

    // Amendment 3: slippage-aware minimum stop. A stop tighter than
    // RISK_STOP_MIN_SLIPPAGE_MULT × the executor's max entry slippage would let
    // a worst-case fill consume >= 1/mult of the risk budget at entry.
    const minStopDistFrac = RISK_STOP_MIN_SLIPPAGE_MULT * MAX_ENTRY_SLIPPAGE_FRAC;
    if (stopDistFrac < minStopDistFrac) {
      violations.push(
        violation(
          "G5",
          "risk_stop_too_tight_for_slippage",
          `stop distance ${(stopDistFrac * 100).toFixed(3)}% is below ${RISK_STOP_MIN_SLIPPAGE_MULT}× the executor's max entry slippage (${(MAX_ENTRY_SLIPPAGE_FRAC * 100).toFixed(2)}%) — a slipped fill would consume too much of the risk budget before the trade starts`,
          true
        )
      );
      return { ok: false, violations };
    }

    // Confidence-scaled risk %, linear between the band endpoints (amendment:
    // confidence is clamped defensively; zod already bounds it 1–10).
    const confClamped = Math.min(Math.max(conf, RISK_CONF_MIN), RISK_CONF_MAX);
    const riskPct =
      riskMin + ((riskMax - riskMin) * (confClamped - RISK_CONF_MIN)) / (RISK_CONF_MAX - RISK_CONF_MIN);

    // Amendment 1: base = min(allocation, live equity) × headroom. min() means a
    // drawdown shrinks risk but a profit surplus never inflates it past the
    // user's allocation; headroom keeps a full-margin post from rejecting on fees.
    const base = Math.min(input.allocatedUsdc, equity) * RISK_BASE_HEADROOM;
    if (!isPositiveFinite(base)) {
      violations.push(
        violation("G5", "risk_params_invalid", `sizing base ${base} is not positive finite — failing closed`, true)
      );
      return { ok: false, violations };
    }

    const riskBudgetUsd = (base * riskPct) / 100;
    let riskNotionalUsdc = riskBudgetUsd / stopDistFrac;

    // Leverage is DERIVED (minimal that fits the notional into base margin),
    // never the model's request: minimal leverage maximizes the liquidation
    // buffer. The tiny epsilon keeps float noise on exact multiples (e.g.
    // notional/base = 3.0000000000004) from bumping leverage a full step up.
    const lMax = leverageCeiling;
    const lRequired = Math.ceil(riskNotionalUsdc / base - 1e-9);
    const riskLeverage = Math.min(Math.max(lRequired, 1), lMax);

    // Margin cap: if even Lmax cannot carry the risk-implied notional, cap the
    // notional at base × Lmax and UNDER-risk (fail-safe direction), flagging it.
    if (riskNotionalUsdc > base * riskLeverage) {
      violations.push(
        violation(
          "G5",
          "risk_capped",
          `risk-implied notional ${riskNotionalUsdc.toFixed(2)} exceeds base ${base.toFixed(2)} × max leverage ${riskLeverage} — capped to ${(base * riskLeverage).toFixed(2)}; trade under-risks its budget`,
          false
        )
      );
      riskNotionalUsdc = base * riskLeverage;
    }
    const riskMarginUsdc = riskNotionalUsdc / riskLeverage;

    // G2 liquidation buffer RE-CHECK at the DERIVED leverage. The first G2 pass
    // used the model's (clamped) requested leverage; the derived leverage can be
    // HIGHER (tight stop + high risk ⇒ more notional), which pulls the estimated
    // liquidation price closer to entry. Same reject-only rule, same code.
    const liqAtDerived = estimateLiquidationPrice(entry, side, riskLeverage, input.maintenanceMarginWeight);
    const slInsideLiqAtDerived = side === "long" ? sl > liqAtDerived : sl < liqAtDerived;
    if (!slInsideLiqAtDerived) {
      violations.push(
        violation(
          "G2",
          "sl_inside_liquidation",
          `stopLossPrice ${sl} is at/beyond the estimated liquidation price ${liqAtDerived.toFixed(6)} at the risk-derived ${riskLeverage}× (mmw ${input.maintenanceMarginWeight}) — the position would liquidate before the stop fires`,
          true
        )
      );
      return { ok: false, violations };
    }

    // Venue lot quantization — round DOWN only; a sub-minimum size REJECTS
    // (never bump up: that would breach the risk budget).
    const riskSizeBase = input.quantizeOrderSize(riskNotionalUsdc / entry);
    if (!isPositiveFinite(riskSizeBase)) {
      violations.push(
        violation(
          "G5",
          "size_quantized_to_zero",
          `order size ${(riskNotionalUsdc / entry).toFixed(8)} quantized to a non-positive lot (${riskSizeBase}) — below the venue's minimum order size; risk-based sizing never bumps up to meet a venue minimum`,
          true
        )
      );
      return { ok: false, violations };
    }

    // Post-quantization assert: the size that will actually execute must still
    // honor the risk budget. Epsilon covers float noise ONLY — a quantizer that
    // rounds UP lands here and the cycle rejects (fail closed).
    const realizedRiskUsd = riskSizeBase * Math.abs(entry - sl);
    if (realizedRiskUsd > riskBudgetUsd * (1 + RISK_ASSERT_EPSILON)) {
      violations.push(
        violation(
          "G5",
          "risk_assert_failed",
          `post-quantization realized risk ${realizedRiskUsd.toFixed(6)} exceeds the risk budget ${riskBudgetUsd.toFixed(6)} — quantizer enlarged the order; failing closed`,
          true
        )
      );
      return { ok: false, violations };
    }

    return {
      ok: true,
      clamped: {
        action: side,
        entryType: "market",
        leverage: riskLeverage,
        // sizePct deliberately omitted: ignored in this mode (executor validates
        // sizeBase/marginUsdc/leverage/SL/TP only; stamping the unused request
        // would misrepresent what sized the trade).
        marginUsdc: riskMarginUsdc,
        notionalUsdc: riskNotionalUsdc,
        sizeBase: riskSizeBase,
        stopLossPrice: sl,
        takeProfitPrice: tp,
        confidence: decision.confidence,
        invalidation: decision.invalidation,
        rationale: decision.rationale,
        // Amendment 2: audit stamps — the executed size is reconstructible from
        // the decision row alone.
        sizingMode: "risk_based",
        riskPct,
        base,
        riskBudgetUsd,
      },
      violations,
    };
  }

  // ---- G5: convert to executable size (discretionary path, byte-identical) --------
  const marginUsdc = (input.allocatedUsdc * appliedSizePct) / 100;
  const notionalUsdc = marginUsdc * appliedLeverage;
  const sizeBase = input.quantizeOrderSize(notionalUsdc / entry);
  if (!isPositiveFinite(sizeBase)) {
    violations.push(
      violation(
        "G5",
        "size_quantized_to_zero",
        `order size ${(notionalUsdc / entry).toFixed(8)} quantized to a non-positive lot (${sizeBase}) — below the venue's minimum order size`,
        true
      )
    );
    return { ok: false, violations };
  }

  return {
    ok: true,
    clamped: {
      action: side,
      entryType: "market",
      leverage: appliedLeverage,
      sizePct: appliedSizePct,
      marginUsdc,
      notionalUsdc,
      sizeBase,
      stopLossPrice: sl,
      takeProfitPrice: tp,
      confidence: decision.confidence,
      invalidation: decision.invalidation,
      rationale: decision.rationale,
    },
    violations,
  };
}
