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

import { createHash } from "node:crypto";
import type { AiTraderBot } from "@shared/schema";

export type QualificationEraComponent =
  | "scanner_capability_policy"
  | "accepted_candle_provenance"
  | "prompt_context_schema"
  | "session_policy"
  | "guardrail_risk_policy"
  | "paper_execution_simulator";

export type QualificationEraDecision = "bump" | "no_bump";

export interface QualificationEraRegistryEntry {
  materialVersion: number;
  decisionGeneration: number;
  decision: QualificationEraDecision;
  ownerPaths: readonly string[];
}

export type QualificationEraRegistry = Record<QualificationEraComponent, QualificationEraRegistryEntry>;

// QV_QUALIFICATION_ERA_REGISTRY_LITERAL_BEGIN
export const QUALIFICATION_ERA_REGISTRY = {
  "scanner_capability_policy": {
    "materialVersion": 1,
    "decisionGeneration": 10,
    "decision": "no_bump",
    "ownerPaths": ["server/ai-trader/scanner.ts", "server/ai-trader/scanner-capabilities.ts", "server/ai-trader/market-admission.ts", "server/ai-trader/multiplier-market-quarantine.ts", "server/ai-trader/monitor.ts", "server/ai-trader/routes.ts"]
  },
  "accepted_candle_provenance": {
    "materialVersion": 1,
    "decisionGeneration": 3,
    "decision": "no_bump",
    "ownerPaths": ["server/lab/datafeed.ts", "server/lab/candle-store.ts", "server/ai-trader/context-builder.ts"]
  },
  "prompt_context_schema": {
    "materialVersion": 3,
    "decisionGeneration": 3,
    "decision": "bump",
    "ownerPaths": ["server/ai-trader/context-builder.ts", "server/ai-trader/decide.ts"]
  },
  "session_policy": {
    "materialVersion": 1,
    "decisionGeneration": 1,
    "decision": "no_bump",
    "ownerPaths": ["server/ai-trader/session-context.ts"]
  },
  "guardrail_risk_policy": {
    "materialVersion": 4,
    "decisionGeneration": 10,
    "decision": "bump",
    "ownerPaths": ["server/ai-trader/guardrails.ts", "server/ai-trader/executor.ts", "server/ai-trader/routes.ts"]
  },
  "paper_execution_simulator": {
    "materialVersion": 2,
    "decisionGeneration": 6,
    "decision": "no_bump",
    "ownerPaths": ["server/ai-trader/paper-math.ts", "server/ai-trader/monitor.ts"]
  }
} as const satisfies QualificationEraRegistry;
// QV_QUALIFICATION_ERA_REGISTRY_LITERAL_END

const QUALIFICATION_ERA_COMPONENTS = Object.freeze([
  "scanner_capability_policy",
  "accepted_candle_provenance",
  "prompt_context_schema",
  "session_policy",
  "guardrail_risk_policy",
  "paper_execution_simulator",
] as const);

export interface QualificationEraInput {
  bot: Pick<
    AiTraderBot,
    | "protocol"
    | "marketSource"
    | "market"
    | "timeframe"
    | "mode"
    | "riskProfile"
    | "model"
    | "sizingMode"
    | "riskMinPct"
    | "riskMaxPct"
    | "allocatedUsdc"
    | "maxLeverage"
    | "stopPolicy"
  >;
  contextDigest?: Record<string, unknown> | null;
}

export interface QualificationEraObject {
  schemaVersion: 1;
  components: Record<QualificationEraComponent, number>;
  bot: Record<string, string | number>;
  scannerPick: Record<string, string | Record<string, string> | null> | null;
  candleProvenance: {
    selected: Record<string, string> | null;
    parent: Record<string, string> | null;
  };
}

function canonicalIdentifier(value: unknown, casing: "upper" | "lower"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("qualification era identifier is missing");
  }
  const trimmed = value.trim();
  return casing === "upper" ? trimmed.toUpperCase() : trimmed.toLowerCase();
}

function canonicalEraInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("qualification era integer is malformed");
  }
  return parsed;
}

export function canonicalEraDecimal(value: unknown): string {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^([+-]?)(\d*?)(?:\.(\d*))?$/.exec(raw);
  if (!match || (!match[2] && !match[3])) throw new Error("qualification era decimal is malformed");
  const negative = match[1] === "-";
  const integer = (match[2] || "0").replace(/^0+(?=\d)/, "") || "0";
  const fraction = (match[3] || "").replace(/0+$/, "");
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function canonicalProvenance(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const finality = canonicalIdentifier(source.finality, "lower");
  return {
    source: canonicalIdentifier(source.source, "lower"),
    venue: canonicalIdentifier(source.venue, "lower"),
    basis: canonicalIdentifier(source.basis, "lower"),
    proxy: canonicalIdentifier(source.proxy, "lower"),
    finalityClass:
      finality === "forming" || finality === "finalized" ? "forming_or_finalized" : finality,
  };
}

export function buildQualificationEraObject(input: QualificationEraInput): QualificationEraObject {
  const digest = input.contextDigest ?? {};
  const provenance =
    digest.candleProvenance && typeof digest.candleProvenance === "object"
      ? (digest.candleProvenance as Record<string, unknown>)
      : {};
  const selected = canonicalProvenance(provenance.selected);
  const parent = canonicalProvenance(provenance.parent);
  const components = {} as Record<QualificationEraComponent, number>;
  for (const component of QUALIFICATION_ERA_COMPONENTS) {
    components[component] = QUALIFICATION_ERA_REGISTRY[component].materialVersion;
  }
  const bot = input.bot;
  const marketSource = canonicalIdentifier(bot.marketSource, "lower");
  const market = canonicalIdentifier(bot.market, "upper");
  const timeframe = canonicalIdentifier(bot.timeframe, "lower");
  return {
    schemaVersion: 1,
    components,
    bot: {
      protocol: canonicalIdentifier(bot.protocol, "lower"),
      marketSource,
      market,
      timeframe,
      mode: canonicalIdentifier(bot.mode, "lower"),
      riskProfile: canonicalIdentifier(bot.riskProfile, "lower"),
      model: canonicalIdentifier(bot.model, "lower"),
      sizingMode: canonicalIdentifier(bot.sizingMode, "lower"),
      riskMinPct: canonicalEraDecimal(bot.riskMinPct),
      riskMaxPct: canonicalEraDecimal(bot.riskMaxPct),
      allocatedUsdc: canonicalEraDecimal(bot.allocatedUsdc),
      maxLeverage: canonicalEraInteger(bot.maxLeverage),
      stopPolicy: canonicalIdentifier(bot.stopPolicy, "lower"),
    },
    scannerPick:
      marketSource === "scanner"
        ? { market, timeframe, marketSource, selected, parent }
        : null,
    candleProvenance: { selected, parent },
  };
}

export function computeQualificationEraDigest(input: QualificationEraInput): string {
  const canonical = JSON.stringify(buildQualificationEraObject(input));
  return createHash("sha256").update(canonical, "utf8").digest("hex").toUpperCase();
}

const MATERIAL_BOT_FIELDS = Object.freeze([
  "protocol",
  "marketSource",
  "market",
  "timeframe",
  "mode",
  "riskProfile",
  "model",
  "sizingMode",
  "riskMinPct",
  "riskMaxPct",
  "allocatedUsdc",
  "maxLeverage",
  "stopPolicy",
] as const);

export function qualificationEraMutationPatch(
  bot: AiTraderBot,
  updates: Record<string, unknown>,
  reason: string,
): Record<string, unknown> | null {
  const canonicalField = (field: typeof MATERIAL_BOT_FIELDS[number], value: unknown): string | number => {
    if (field === "market") return canonicalIdentifier(value, "upper");
    if (field === "riskMinPct" || field === "riskMaxPct" || field === "allocatedUsdc") {
      return canonicalEraDecimal(value);
    }
    if (field === "maxLeverage") return canonicalEraInteger(value);
    return canonicalIdentifier(value, "lower");
  };
  const changed = MATERIAL_BOT_FIELDS.some(
    (field) => Object.prototype.hasOwnProperty.call(updates, field) &&
      canonicalField(field, updates[field]) !== canonicalField(field, bot[field]),
  );
  if (!changed) return null;
  return {
    currentQualificationEraDigest: null,
    graduatedQualificationEraDigest: null,
    qualificationEraInvalidationReason: reason,
    graduationState: bot.graduationState === "waived" ? "waived" : "in_trial",
    graduatedAt: null,
    trialStartedAt: new Date(),
  };
}

export function qualificationEraDecisionPatch(
  bot: AiTraderBot,
  digest: string,
): Record<string, unknown> | null {
  if (bot.currentQualificationEraDigest === digest) return null;
  const resumesInvalidatedEra =
    bot.currentQualificationEraDigest === null &&
    typeof bot.qualificationEraInvalidationReason === "string" &&
    bot.qualificationEraInvalidationReason.length > 0;
  return {
    currentQualificationEraDigest: digest,
    graduatedQualificationEraDigest: null,
    qualificationEraInvalidationReason:
      resumesInvalidatedEra
        ? bot.qualificationEraInvalidationReason
        : bot.currentQualificationEraDigest === null
          ? "qualification_era_initialized"
          : "qualification_era_changed",
    graduationState: bot.graduationState === "waived" ? "waived" : "in_trial",
    graduatedAt: null,
    trialStartedAt: resumesInvalidatedEra && bot.trialStartedAt ? bot.trialStartedAt : new Date(),
  };
}

export function validateQualificationEraDeclarationChanges(input: {
  base: QualificationEraRegistry | null;
  current: QualificationEraRegistry;
  changedPaths: readonly string[];
}): string[] {
  const errors: string[] = [];
  for (const component of QUALIFICATION_ERA_COMPONENTS) {
    const current = input.current[component];
    if (!current || !Number.isInteger(current.materialVersion) || current.materialVersion < 1 ||
        !Number.isInteger(current.decisionGeneration) || current.decisionGeneration < 1 ||
        (current.decision !== "bump" && current.decision !== "no_bump")) {
      errors.push(`${component}: malformed registry entry`);
      continue;
    }
    const base = input.base?.[component];
    if (!input.base) {
      if (current.materialVersion !== 1 || current.decisionGeneration !== 1) {
        errors.push(`${component}: bootstrap must start at version/generation 1`);
      }
      continue;
    }
    if (!base) {
      errors.push(`${component}: missing base registry entry`);
      continue;
    }
    const affected = current.ownerPaths.some((path) => input.changedPaths.includes(path));
    if (!affected) continue;
    if (current.decisionGeneration !== base.decisionGeneration + 1) {
      errors.push(`${component}: changed owner requires decisionGeneration + 1`);
    }
    if (current.decision === "bump" && current.materialVersion !== base.materialVersion + 1) {
      errors.push(`${component}: bump requires materialVersion + 1`);
    }
    if (current.decision === "no_bump" && current.materialVersion !== base.materialVersion) {
      errors.push(`${component}: no_bump requires unchanged materialVersion`);
    }
  }
  return errors;
}

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
export function canGoLive(
  graduationState: string,
  currentQualificationEraDigest?: string | null,
  graduatedQualificationEraDigest?: string | null,
): { ok: true } | { ok: false; error: string } {
  if (graduationState === "waived") return { ok: true };
  if (graduationState === "graduated") {
    if (!currentQualificationEraDigest || !graduatedQualificationEraDigest) {
      return { ok: false, error: "Qualification era is unknown — complete a new paper trial before going live." };
    }
    if (currentQualificationEraDigest !== graduatedQualificationEraDigest) {
      return { ok: false, error: "Qualification era is stale — complete a new paper trial under the current behavior before going live." };
    }
    return { ok: true };
  }
  return {
    ok: false,
    error:
      graduationState === "failed"
        ? "Paper trial failed — restart the trial and pass it before going live."
        : "Paper trial still in progress — the bot must graduate before going live.",
  };
}
