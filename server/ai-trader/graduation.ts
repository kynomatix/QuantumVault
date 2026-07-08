// AI Trader — paper-graduation evaluator (WO-6, docs/AGENTIC_TRADER_PLAN.md §2e).
//
// PURE MODULE by design: no storage, no adapters, no bot imports. The shape is
// bot-type-agnostic (GraduationTradeRecord is just {closedAt, netPnl}) so the
// evaluator can later wrap regular tradingBots (Phase 4 platform rollout)
// without changes. The WO-6 monitor is the only caller today.
//
// §2e criteria (defaults / hard floors — floors are enforced server-side at
// creation time in WO-7; sanitizeGraduationCriteria here is defense-in-depth
// so a tampered/legacy jsonb row can never make graduation EASIER than the
// floors allow):
//   - Paper period:        30 days default / 7-day floor
//   - Closed trades:       ≥10 (LTF 15m/1h) or ≥5 (HTF 4h/1d) — stored per-bot
//                          as minTrades; absolute floor 3
//   - Net paper PnL:       > 0 after fees+slippage (minNetPnl, floor 0)
//   - Max paper drawdown:  ≤30% of paper allocation default / 50% ceiling —
//                          MARK-TO-MARKET (open-position MTM included via
//                          openPositionMtm, so a windfall + huge floating loss
//                          cannot graduate)
//   - Profit factor:       ≥1.1 default / 1.0 absolute floor (blocks the
//                          one-lucky-trade record)

export interface GraduationCriteria {
  periodDays: number;
  minTrades: number;
  minNetPnl: number;
  maxDrawdownPct: number;
  /** Optional (older rows may lack it) — defaults to 1.1. */
  minProfitFactor?: number;
}

/** One closed paper round trip. netPnl is AFTER fees + slippage. */
export interface GraduationTradeRecord {
  closedAt: Date | number;
  netPnl: number;
}

export type GraduationVerdict = "in_trial" | "graduated" | "failed";

export interface GraduationEvaluation {
  verdict: GraduationVerdict;
  periodElapsed: boolean;
  /** Days elapsed since trial start (fractional). */
  daysElapsed: number;
  tradeCount: number;
  netPnl: number;
  /** Gross wins / gross losses. Infinity when there are wins and no losses; 0 when no wins. */
  profitFactor: number;
  /** Worst peak-to-trough equity drop as % of allocation (MTM: includes openPositionMtm). */
  maxDrawdownPct: number;
  /** True when every §2e criterion is met (independent of periodElapsed). */
  criteriaMet: boolean;
  /** Human-readable list of criteria currently NOT met (empty ⇒ criteriaMet). */
  failures: string[];
  /** The floored/sanitized criteria the evaluation actually used. */
  criteria: Required<GraduationCriteria>;
}

export const DEFAULT_MIN_PROFIT_FACTOR = 1.1;

// Hard floors (§2e "floors enforced server-side"). Sanitization can only make
// criteria STRICTER (or equal), never looser.
export const GRADUATION_FLOORS = {
  minPeriodDays: 7,
  minTrades: 3,
  minNetPnl: 0,
  maxDrawdownPctCeiling: 50,
  minProfitFactor: 1.0,
} as const;

function finite(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Clamp a (possibly hostile/legacy) criteria jsonb to the §2e floors. Every
 * clamp direction makes graduation HARDER or equal — never easier.
 */
export function sanitizeGraduationCriteria(raw: unknown): Required<GraduationCriteria> {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<GraduationCriteria>;
  return {
    periodDays: Math.max(GRADUATION_FLOORS.minPeriodDays, finite(c.periodDays, 30)),
    minTrades: Math.max(GRADUATION_FLOORS.minTrades, Math.round(finite(c.minTrades, 10))),
    minNetPnl: Math.max(GRADUATION_FLOORS.minNetPnl, finite(c.minNetPnl, 0)),
    maxDrawdownPct: Math.min(
      GRADUATION_FLOORS.maxDrawdownPctCeiling,
      Math.max(1, finite(c.maxDrawdownPct, 30))
    ),
    minProfitFactor: Math.max(
      GRADUATION_FLOORS.minProfitFactor,
      finite(c.minProfitFactor, DEFAULT_MIN_PROFIT_FACTOR)
    ),
  };
}

function toMs(t: Date | number): number {
  return t instanceof Date ? t.getTime() : t;
}

export interface EvaluateGraduationInput {
  criteria: unknown;
  /** Closed trades since trial start (any order; sorted internally). */
  trades: GraduationTradeRecord[];
  trialStartedAt: Date | number;
  /** Paper allocation in USDC — the drawdown denominator. Must be > 0. */
  allocation: number;
  /** Unrealized PnL of the currently-open paper position (0 / omitted when flat). */
  openPositionMtm?: number;
  now?: number;
}

/**
 * Evaluate the §2e paper record. Plan-exact verdict semantics:
 *   - period not yet elapsed → 'in_trial' (never an early fail — a mid-trial
 *     drawdown breach WILL fail at period end because max drawdown is monotone,
 *     but the verdict itself only lands once the period is over)
 *   - period elapsed + all criteria met → 'graduated'
 *   - period elapsed + any criterion missed → 'failed' (restart trial to retry)
 *
 * Fail-closed: invalid allocation or non-finite trade PnL throws rather than
 * producing a verdict from garbage.
 */
export function evaluateGraduation(input: EvaluateGraduationInput): GraduationEvaluation {
  const criteria = sanitizeGraduationCriteria(input.criteria);
  const now = input.now ?? Date.now();
  const allocation = input.allocation;
  if (!Number.isFinite(allocation) || allocation <= 0) {
    throw new Error(`evaluateGraduation: invalid allocation ${allocation}`);
  }
  const openMtm = finite(input.openPositionMtm, 0);

  const trades = [...input.trades].sort((a, b) => toMs(a.closedAt) - toMs(b.closedAt));

  let grossWins = 0;
  let grossLosses = 0;
  let netPnl = 0;
  for (const t of trades) {
    if (!Number.isFinite(t.netPnl)) {
      throw new Error(`evaluateGraduation: non-finite trade netPnl ${t.netPnl}`);
    }
    netPnl += t.netPnl;
    if (t.netPnl >= 0) grossWins += t.netPnl;
    else grossLosses += -t.netPnl;
  }

  // Profit factor: wins / losses. No losses: wins > 0 ⇒ Infinity (passes any
  // threshold); no wins either ⇒ 0 (fails — an empty record is not a good one).
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  // Equity curve from allocation, MTM at the end (open-position unrealized).
  // Drawdown is measured as % of ALLOCATION (§2e "of paper allocation"), not
  // of the running peak.
  let equity = allocation;
  let peak = allocation;
  let maxDrawdownPct = 0;
  const applyPoint = (e: number) => {
    if (e > peak) peak = e;
    const ddPct = ((peak - e) / allocation) * 100;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  };
  for (const t of trades) {
    equity += t.netPnl;
    applyPoint(equity);
  }
  applyPoint(equity + openMtm);

  const daysElapsed = Math.max(0, (now - toMs(input.trialStartedAt)) / 86_400_000);
  const periodElapsed = daysElapsed >= criteria.periodDays;

  const failures: string[] = [];
  if (trades.length < criteria.minTrades) {
    failures.push(`closed trades ${trades.length} < required ${criteria.minTrades}`);
  }
  if (!(netPnl > criteria.minNetPnl)) {
    failures.push(`net PnL ${netPnl.toFixed(2)} not > ${criteria.minNetPnl}`);
  }
  if (!(profitFactor >= criteria.minProfitFactor)) {
    failures.push(
      `profit factor ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : profitFactor} < ${criteria.minProfitFactor}`
    );
  }
  if (!(maxDrawdownPct <= criteria.maxDrawdownPct)) {
    failures.push(`max drawdown ${maxDrawdownPct.toFixed(1)}% > ${criteria.maxDrawdownPct}%`);
  }
  const criteriaMet = failures.length === 0;

  const verdict: GraduationVerdict = !periodElapsed
    ? "in_trial"
    : criteriaMet
      ? "graduated"
      : "failed";

  return {
    verdict,
    periodElapsed,
    daysElapsed,
    tradeCount: trades.length,
    netPnl,
    profitFactor,
    maxDrawdownPct,
    criteriaMet,
    failures,
    criteria,
  };
}

/**
 * Go-live gate (WO-7 uses this; defined here so the rule lives beside the
 * evaluator): a bot may flip paperMode→false ONLY from these states.
 */
export function canGoLive(graduationState: string): { ok: true } | { ok: false; error: string } {
  if (graduationState === "graduated" || graduationState === "waived") return { ok: true };
  return {
    ok: false,
    error:
      graduationState === "failed"
        ? "Paper trial failed — restart the trial and pass it before going live."
        : "Paper trial still in progress — the bot must graduate before going live.",
  };
}
