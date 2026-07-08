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
  const appliedSizePct = Math.min(Math.max(requestedSizePct, SIZE_PCT_MIN), SIZE_PCT_MAX);
  if (appliedSizePct !== requestedSizePct) {
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

  // ---- G5: convert to executable size --------------------------------------------
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
