// QuantumLab Sandbox Agent — toolkit contract (Phase A, contract-first).
//
// This is the SINGLE source of truth for everything the sandbox agent can do
// (docs/LAB_AGENT_SANDBOX_PLAN.md §3, §4). The agent's whole world is the method
// menu below; it may call NOTHING outside it.
//
// Rules this file enforces by being the contract:
//  - Stable, semantic DTOs only — never raw `lab_*` table rows, raw status
//    strings, or raw heatmap arrays. Lab-internal renames must not reach the agent.
//  - Versioned: the agent declares the toolkit major version it expects.
//  - Typed end-to-end from Zod (no hand-written drift).
//  - This module imports NO lab internals. The current-lab adapter (Phase A T4)
//    is the only thing coupled to today's lab plumbing, behind this contract.
//
// Implementation is phased: the schemas for the FULL §4 menu live here now
// (contract-first), but Phase A only wires the deterministic read/run/refine/
// cancel surface. LLM-backed methods (createStrategyFromText, improve, …) return
// a typed `not_implemented` ToolkitError until their phase lands.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Major version of the toolkit contract. The agent declares the major it expects. */
export const LAB_AGENT_TOOLKIT_VERSION = 1 as const;
export type LabAgentToolkitVersion = typeof LAB_AGENT_TOOLKIT_VERSION;

// ---------------------------------------------------------------------------
// Stable enums (the DTO side — internal lab strings are mapped to these in T3)
// ---------------------------------------------------------------------------

/**
 * Stable run lifecycle. Internal lab statuses (`running`, `complete`, `error`,
 * job-progress `fetching|baseline|random_search|refinement|retrying`, checkpoint
 * `userCancelled`, …) are mapped onto THIS enum by the DTO mappers. The agent
 * only ever sees these values.
 */
export const runStatusEnum = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stopped",
  "paused",
]);
export type RunStatus = z.infer<typeof runStatusEnum>;

/** Set of statuses that mean "no more work will happen on this run." */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "stopped",
]);

/**
 * Optimization stages the agent can request, in honing order. `deep` maps to the
 * lab's `deepSearch:true` (3 honing rounds); `coordinate` is the optional
 * coordinate tune. The core rule (§6): exhaust random → refine → deep before any
 * paid `improve`.
 */
export const optimizationStageEnum = z.enum(["random", "refine", "deep", "coordinate"]);
export type OptimizationStage = z.infer<typeof optimizationStageEnum>;

/** Bounded error vocabulary — the agent never sees a raw error string/stack. */
export const toolkitErrorCodeEnum = z.enum([
  "not_found",
  "invalid_input",
  "conflict", // idempotency-key reused with different args
  "forbidden", // wallet-scope / capability violation
  "rate_limited",
  "queue_full",
  "lab_unavailable",
  "not_implemented", // method exists in the contract but not wired this phase
  "internal",
]);
export type ToolkitErrorCode = z.infer<typeof toolkitErrorCodeEnum>;

// ---------------------------------------------------------------------------
// DTOs (output shapes)
// ---------------------------------------------------------------------------

export const toolkitErrorDtoSchema = z.object({
  code: toolkitErrorCodeEnum,
  message: z.string(),
  /** True if the caller may retry the same request (with the same idempotency key). */
  retryable: z.boolean(),
});
export type ToolkitErrorDto = z.infer<typeof toolkitErrorDtoSchema>;

export const strategyDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  /** Whether any optimization results exist for this strategy. */
  hasResults: z.boolean(),
  /** Most recent run id, if any. */
  latestRunId: z.number().int().nullable(),
  createdAt: z.string(), // ISO
});
export type StrategyDto = z.infer<typeof strategyDtoSchema>;

export const strategyMatchDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  /** Fuzzy-match confidence 0..1 (e.g. "Flux" → "FLUX MOMENTUM"). */
  score: z.number().min(0).max(1),
});
export type StrategyMatchDto = z.infer<typeof strategyMatchDtoSchema>;

export const templateDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export type TemplateDto = z.infer<typeof templateDtoSchema>;

/** Compact out-of-sample summary — the robustness story, not the full curve. */
export const oosSummaryDtoSchema = z.object({
  fraction: z.number(), // holdout fraction actually used
  netProfitPercent: z.number().nullable(),
  winRatePercent: z.number().nullable(),
  maxDrawdownPercent: z.number().nullable(),
  sharpeRatio: z.number().nullable(),
  totalTrades: z.number().int().nullable(),
});
export type OosSummaryDto = z.infer<typeof oosSummaryDtoSchema>;

/**
 * One ranked combo result. HEADLINE numbers only — no `trades[]` / `equityCurve[]`
 * (huge; would blow the chat model's context). A detail accessor can be added in a
 * later phase if needed.
 */
export const backtestResultDtoSchema = z.object({
  /** Stable id of this saved result row — pass to refineFrom to quick-hone THIS exact result. */
  resultId: z.number().int(),
  runId: z.number().int(),
  ticker: z.string(),
  timeframe: z.string(),
  rank: z.number().int(),
  netProfitPercent: z.number(),
  winRatePercent: z.number(),
  maxDrawdownPercent: z.number(),
  profitFactor: z.number(),
  sharpeRatio: z.number().nullable(),
  totalTrades: z.number().int(),
  /**
   * Leverage sized from this result's max drawdown (floor((100/maxDD)*0.8), at least
   * 1x, capped at the venue max for the ticker). Same basis as the deploy risk card.
   */
  suggestedLeverage: z.number(),
  /** netProfitPercent times suggestedLeverage: a simple "profit at that leverage" estimate. */
  leveragedNetProfitPercent: z.number(),
  /**
   * OOS-aware durability score for this result (higher = steadier): blends in-sample
   * and out-of-sample quality and penalizes Sharpe decay. Lets the agent show a
   * robustness view ALONGSIDE the post-leverage profit order, so a high-profit
   * curve-fit stands out (high profit rank, low robustness rank).
   */
  robustnessScore: z.number(),
  /**
   * 1-based position of this result within the returned set when ordered by
   * robustnessScore (1 = most robust of the set). The list itself stays ordered by
   * post-leverage profit; this field carries the SECOND, robustness ordering in the
   * same payload so the user can see both at once.
   */
  robustnessRank: z.number().int(),
  /** Tuned parameter set for this combo. */
  params: z.record(z.string(), z.unknown()),
  /**
   * OOS summary, or null when the run carried NO holdout. A null here means the
   * result is UNVALIDATED, not good (§6) — the agent must treat it as such.
   */
  oos: oosSummaryDtoSchema.nullable(),
});
export type BacktestResultDto = z.infer<typeof backtestResultDtoSchema>;

export const topResultsDtoSchema = z.object({
  strategyId: z.number().int(),
  runId: z.number().int().nullable(),
  /**
   * How `results` are ordered. "lab_objective" = the lab's CURRENT internal rank
   * (profit / win-rate-weighted, NOT robustness — see
   * docs/QUANTUMLAB_ACCURACY_DIAGNOSIS.md). "robustness" is reserved for when the
   * adapter re-ranks by the §6 view (OOS sufficiency + drawdown + Sharpe). The DTO
   * states which ordering was actually applied so the agent never assumes robustness.
   */
  rankedBy: z.enum(["lab_objective", "robustness"]),
  results: z.array(backtestResultDtoSchema),
});
export type TopResultsDto = z.infer<typeof topResultsDtoSchema>;

/** Bounded heatmap: discrete cells, not a raw 2-D array. May be truncated. */
export const heatmapCellDtoSchema = z.object({
  x: z.union([z.number(), z.string()]),
  y: z.union([z.number(), z.string()]),
  metric: z.number(),
});
export const heatmapDtoSchema = z.object({
  strategyId: z.number().int(),
  xParam: z.string(),
  yParam: z.string(),
  metricName: z.string(),
  cells: z.array(heatmapCellDtoSchema),
  truncated: z.boolean(),
});
export type HeatmapDto = z.infer<typeof heatmapDtoSchema>;

export const runStatusDtoSchema = z.object({
  runId: z.number().int(),
  status: runStatusEnum,
  /** Current stage when running (mapped from job progress), else null. */
  stage: optimizationStageEnum.nullable(),
  /** 0..100 when known, else null. */
  progressPct: z.number().min(0).max(100).nullable(),
  /** Jobs ahead of this run in the single shared queue, when queued. */
  jobsAhead: z.number().int().nullable(),
  totalConfigsTested: z.number().int().nullable(),
  /** Holdout fraction used; null = run carried no OOS (results are unvalidated, §6). */
  oosFraction: z.number().nullable(),
  startedAt: z.string().nullable(), // ISO
  completedAt: z.string().nullable(), // ISO
  /** Human-safe failure reason when status is failed; never a raw stack. */
  errorReason: z.string().nullable(),
  /** Stable correlation id for the agent task that owns this run, if any. */
  correlationId: z.string().nullable(),
});
export type RunStatusDto = z.infer<typeof runStatusDtoSchema>;

export const queuePositionDtoSchema = z.object({
  /** Number of jobs ahead of the caller in the single platform-wide queue. */
  jobsAhead: z.number().int(),
  /** Whether this wallet already holds an active run (one-active-run gate, §7). */
  hasActiveRun: z.boolean(),
  /**
   * True when this wallet has its OWN manual (user-driven) run running or queued
   * ahead of the agent on the single shared worker. Manual runs always claim
   * first (Task #200 fairness), so this drives the "waiting on your manual run"
   * copy. Optional so older callers/DTOs stay valid.
   */
  waitingOnManualRun: z.boolean().optional(),
});
export type QueuePositionDto = z.infer<typeof queuePositionDtoSchema>;

export const insightsReportDtoSchema = z.object({
  strategyId: z.number().int(),
  generatedAt: z.string(), // ISO
  /** Plain-language summary the chat layer can relay. */
  summary: z.string(),
  /** Optional structured extras (param sensitivity, directional bias). Bounded. */
  paramSensitivity: z.array(z.object({ param: z.string(), impact: z.number() })).nullable(),
  directionalBias: z.string().nullable(),
});
export type InsightsReportDto = z.infer<typeof insightsReportDtoSchema>;

export const createStrategyResultDtoSchema = z.object({
  strategyId: z.number().int(),
  name: z.string(),
});
export type CreateStrategyResultDto = z.infer<typeof createStrategyResultDtoSchema>;

/** Result of queueing (or re-queueing) async work on the shared worker. */
export const runQueuedDtoSchema = z.object({
  runId: z.number().int(),
  /** Stable correlation id for retries/resume. */
  correlationId: z.string(),
  status: runStatusEnum,
  /** True when an existing run was returned for a reused idempotency key. */
  idempotent: z.boolean(),
  jobsAhead: z.number().int().nullable(),
});
export type RunQueuedDto = z.infer<typeof runQueuedDtoSchema>;

// ---------------------------------------------------------------------------
// Method I/O schemas
// ---------------------------------------------------------------------------
// Wallet is NOT a method argument — it is bound by the toolkit caller context and
// enforced on every call (cross-wallet-leak guard, §8). Inputs below are exactly
// what the agent supplies.

const idempotencyKey = z.string().min(1).max(128);

// ---- Read (lab:read) ----
export const listStrategiesInput = z.object({}).strict();
export const findStrategyInput = z.object({ query: z.string().min(1) }).strict();
export const listTemplatesInput = z.object({}).strict();
export const getTopResultsInput = z.object({
  strategyId: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).optional(),
  // Optional server-side filter. When the user asks about a SPECIFIC timeframe
  // or asset, pass it here so that exact combo is returned deterministically,
  // even if it ranks low by robustness. Without it the final slice can drop a
  // freshly run combo and the agent reports a stale older one instead.
  timeframe: z.string().min(1).max(8).optional(),
  ticker: z.string().min(1).max(16).optional(),
}).strict();
export const getHeatmapInput = z.object({ strategyId: z.number().int().positive() }).strict();
export const getInsightsReportInput = z.object({
  strategyId: z.number().int().positive(),
}).strict();
export const getRunStatusInput = z.object({ runId: z.number().int().positive() }).strict();
export const getQueuePositionInput = z.object({}).strict();

// ---- Write (lab:write) ----
// createStrategyFromText is SYNC: it drafts + persists a strategy and returns its
// id immediately — it does NOT queue a run, so there is nothing to dedupe and the
// adapter ignores any key. The orchestrator only injects idempotency on the ASYNC
// (run-queuing) path, so this field MUST be optional or the real agent path (brain
// emits no key) would fail contract validation before the LLM call.
export const createStrategyFromTextInput = z.object({
  prompt: z.string().min(1),
  name: z.string().optional(),
  idempotencyKey: idempotencyKey.optional(),
}).strict();

export const createStrategyFromTemplateInput = z.object({
  templateId: z.string().min(1),
  tweaks: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey,
}).strict();

export const runOptimizationInput = z.object({
  strategyId: z.number().int().positive(),
  /** Cross-asset by design (SOL / ETH / ARB) — robustness, not a single spike (§6). */
  symbols: z.array(z.string().min(1)).min(1),
  /** 1H minimum; 2H/4H+ recommended (§6). Enforced in the adapter, not here. */
  timeframes: z.array(z.string().min(1)).min(1),
  /** Honing order; default exhausts the cheap deterministic pipeline (§6). */
  stages: z.array(optimizationStageEnum).min(1).default(["random", "refine", "deep"]),
  /** Holdout fraction (0..0.9). The adapter sets a default and re-threads on refine (§6). */
  outOfSampleFraction: z.number().min(0).max(0.9).optional(),
  /** When true, the adapter drops any symbol already backtested for this strategy so a
   *  "test on more/new tickers" request never re-covers ground. Set it for new-market
   *  requests; leave it off to deliberately re-run a specific ticker. */
  excludeTestedTickers: z.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  idempotencyKey,
}).strict();

export const refineFromInput = z.object({
  /**
   * Refine a whole finished run around its best params — the heavier hone
   * (coordinate tune + insights + DEEP search). Provide EITHER this or resultId.
   */
  runId: z.number().int().positive().optional(),
  /**
   * Quick, targeted hone of ONE specific saved result (its `resultId` from
   * getTopResults). The server looks up that result's EXACT saved params and seeds
   * them with DEEP SEARCH OFF — the per-row "refresh" the UI offers. Repeatable.
   */
  resultId: z.number().int().positive().optional(),
  idempotencyKey,
}).strict().refine(
  (v) => (v.runId == null) !== (v.resultId == null),
  { message: "Provide exactly one of runId or resultId." },
);

// generateInsights is a SYNCHRONOUS, side-effect-free compute (no LLM, no persist):
// it derives insights from the strategy's EXISTING backtest results, so it is a
// read with no run to queue and therefore needs no idempotencyKey.
export const generateInsightsInput = z.object({
  strategyId: z.number().int().positive(),
}).strict();

export const improveInput = z.object({
  strategyId: z.number().int().positive(),
  /** Insights report text or a weaknesses description (≤ MAX_IDEA_CHARS upstream). */
  insightsOrWeaknesses: z.string().min(1),
  idempotencyKey,
}).strict();

export const cancelRunInput = z.object({
  runId: z.number().int().positive(),
}).strict();

// ---------------------------------------------------------------------------
// Method registry (capability bound) + I/O map
// ---------------------------------------------------------------------------

/**
 * The complete, closed menu. Capability-bounding (§8) checks calls against this
 * list — the agent can invoke nothing else. Read vs write mirrors
 * PROGRAMMATIC_API_PLAN.md scopes so the same permission model graduates later.
 */
export const LAB_AGENT_TOOLKIT_METHODS = {
  read: [
    "listStrategies",
    "findStrategy",
    "listTemplates",
    "getTopResults",
    "getHeatmap",
    "getInsightsReport",
    // generateInsights is a pure read: it computes a report from existing results
    // synchronously (no LLM, no persist), so it needs the read capability, not write.
    "generateInsights",
    "getRunStatus",
    "getQueuePosition",
  ],
  write: [
    "createStrategyFromText",
    "createStrategyFromTemplate",
    "runOptimization",
    "refineFrom",
    "improve",
    "cancelRun",
  ],
} as const;

export type LabReadMethod = (typeof LAB_AGENT_TOOLKIT_METHODS.read)[number];
export type LabWriteMethod = (typeof LAB_AGENT_TOOLKIT_METHODS.write)[number];
export type LabAgentToolkitMethod = LabReadMethod | LabWriteMethod;

/** All method names as a flat, readonly list — for the capability-bound check. */
export const ALL_LAB_AGENT_TOOLKIT_METHODS: readonly LabAgentToolkitMethod[] = [
  ...LAB_AGENT_TOOLKIT_METHODS.read,
  ...LAB_AGENT_TOOLKIT_METHODS.write,
];

export function isLabAgentToolkitMethod(name: string): name is LabAgentToolkitMethod {
  return (ALL_LAB_AGENT_TOOLKIT_METHODS as readonly string[]).includes(name);
}

/** Methods backed by an LLM call — deferred past Phase A (return `not_implemented`). */
export const LLM_BACKED_METHODS: readonly LabAgentToolkitMethod[] = [
  "createStrategyFromText",
  "improve",
];

/** Canonical input/output Zod schema pair for each method. */
export const LAB_AGENT_TOOLKIT_IO = {
  // read
  listStrategies: { input: listStrategiesInput, output: z.array(strategyDtoSchema) },
  findStrategy: { input: findStrategyInput, output: z.array(strategyMatchDtoSchema) },
  listTemplates: { input: listTemplatesInput, output: z.array(templateDtoSchema) },
  getTopResults: { input: getTopResultsInput, output: topResultsDtoSchema },
  getHeatmap: { input: getHeatmapInput, output: heatmapDtoSchema },
  getInsightsReport: { input: getInsightsReportInput, output: insightsReportDtoSchema },
  getRunStatus: { input: getRunStatusInput, output: runStatusDtoSchema },
  getQueuePosition: { input: getQueuePositionInput, output: queuePositionDtoSchema },
  // write
  createStrategyFromText: { input: createStrategyFromTextInput, output: createStrategyResultDtoSchema },
  createStrategyFromTemplate: { input: createStrategyFromTemplateInput, output: createStrategyResultDtoSchema },
  runOptimization: { input: runOptimizationInput, output: runQueuedDtoSchema },
  refineFrom: { input: refineFromInput, output: runQueuedDtoSchema },
  generateInsights: { input: generateInsightsInput, output: insightsReportDtoSchema },
  improve: { input: improveInput, output: runQueuedDtoSchema },
  cancelRun: { input: cancelRunInput, output: runStatusDtoSchema },
} as const satisfies Record<LabAgentToolkitMethod, { input: z.ZodTypeAny; output: z.ZodTypeAny }>;

export type LabAgentToolkitInput<M extends LabAgentToolkitMethod> =
  z.infer<(typeof LAB_AGENT_TOOLKIT_IO)[M]["input"]>;
export type LabAgentToolkitOutput<M extends LabAgentToolkitMethod> =
  z.infer<(typeof LAB_AGENT_TOOLKIT_IO)[M]["output"]>;

/**
 * A toolkit call either succeeds with a typed DTO or fails with a typed
 * ToolkitErrorDto — never a thrown raw error (§3).
 */
export type ToolkitResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolkitErrorDto };
