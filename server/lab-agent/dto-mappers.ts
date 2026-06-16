// QuantumLab Sandbox Agent — DTO / status boundary (Phase A, T3).
//
// This is the ONLY place that knows how to turn raw lab plumbing — DB run rows,
// in-memory job-progress objects, result rows, checkpoints — into the stable,
// semantic DTOs the agent speaks (shared/lab-agent-contract.ts).
//
// Hard rules this module enforces:
//  - No raw internal status string EVER reaches the agent. Every status is mapped
//    onto the closed RunStatus enum; an unknown internal value fails safe to a
//    terminal status rather than leaking.
//  - Headline results only — `trades[]` / `equityCurve[]` are dropped here so they
//    can never blow the chat model's context.
//  - Heatmaps are bounded (capped cell count + a `truncated` flag).
//  - Error text is sanitized to a single, human-safe line — never a raw stack.
//
// It is pure (no I/O, no throws): the adapter (T4) fetches the rows, calls these
// mappers, and validates the result against the contract's output zod schema at
// the outer boundary.

import type {
  LabStrategy,
  LabOptimizationRun,
  LabOptResult,
  LabInsightsReport,
  LabOosMetrics,
  LabJobProgress,
  LabCheckpoint,
} from "@shared/schema";
import type {
  RunStatus,
  OptimizationStage,
  RunStatusDto,
  BacktestResultDto,
  TopResultsDto,
  OosSummaryDto,
  StrategyDto,
  StrategyMatchDto,
  QueuePositionDto,
  InsightsReportDto,
  HeatmapDto,
} from "@shared/lab-agent-contract";

const MAX_ERROR_REASON_CHARS = 240;
/** Hard cap on heatmap cells handed to the agent (context-size guard). */
export const MAX_HEATMAP_CELLS = 600;

/** `userCancelled` is written into the checkpoint jsonb but not on the interface. */
type LabCheckpointLoose = LabCheckpoint & { userCancelled?: boolean };

/** The subset of live job progress the boundary reads. */
export type LiveProgress = Pick<LabJobProgress, "status" | "stage" | "percent" | "error">;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString();
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clampPct(n: number | null | undefined): number | null {
  if (n == null || isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clamp01(n: number): number {
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** First line only, stack frames stripped, length-capped. Never a raw stack. */
export function sanitizeErrorReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = String(raw).split("\n")[0].trim();
  if (!firstLine) return null;
  const cleaned = firstLine.replace(/\s+at\s+.*$/, "").trim();
  return (cleaned || firstLine).slice(0, MAX_ERROR_REASON_CHARS);
}

// ---------------------------------------------------------------------------
// Status mapping (the boundary's core job)
// ---------------------------------------------------------------------------

/**
 * Map a persisted DB run status to the stable enum. The DB is the source of
 * truth (§7b). A `failed` run whose checkpoint marks a user cancellation is
 * reported as `cancelled`, not `failed`.
 */
export function mapRunStatusFromDb(
  dbStatus: string,
  checkpoint?: LabCheckpointLoose | null,
): RunStatus {
  switch (dbStatus) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "complete":
      return "completed";
    case "failed":
      return checkpoint?.userCancelled ? "cancelled" : "failed";
    default:
      // Unknown internal status — never leak it; fail safe to a terminal value.
      return "failed";
  }
}

/** Map an in-memory job-progress status to the stable enum. */
export function mapJobProgressStatus(p: Pick<LabJobProgress, "status" | "stage">): RunStatus {
  switch (p.status) {
    case "fetching":
    case "baseline":
    case "random_search":
    case "refinement":
    case "retrying":
      return "running";
    case "complete":
      return "completed";
    case "error":
      return /cancel/i.test(p.stage ?? "") ? "cancelled" : "failed";
    default:
      return "running";
  }
}

/**
 * Resolve the current optimization stage. Prefer the checkpoint's exact
 * `currentStage` (it distinguishes deep/coordinate); fall back to what the live
 * job-progress status implies; else null.
 */
export function mapStage(
  checkpoint?: LabCheckpointLoose | null,
  progress?: Pick<LabJobProgress, "status"> | null,
): OptimizationStage | null {
  const cs = checkpoint?.currentStage;
  if (cs === "random" || cs === "refine" || cs === "deep" || cs === "coordinate") return cs;
  switch (progress?.status) {
    case "random_search":
      return "random";
    case "refinement":
      return "refine";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Row → DTO mappers
// ---------------------------------------------------------------------------

export function toRunStatusDto(
  run: LabOptimizationRun,
  opts?: { progress?: LiveProgress | null; jobsAhead?: number | null; checkpoint?: LabCheckpointLoose | null },
): RunStatusDto {
  const checkpoint = (opts?.checkpoint ?? (run.checkpoint as LabCheckpointLoose | null)) ?? null;
  const status = mapRunStatusFromDb(run.status, checkpoint);
  const isLive = status === "running" || status === "queued";

  return {
    runId: run.id,
    status,
    stage: isLive ? mapStage(checkpoint, opts?.progress ?? null) : null,
    progressPct: isLive ? clampPct(opts?.progress?.percent) : null,
    jobsAhead: status === "queued" ? (opts?.jobsAhead ?? null) : null,
    totalConfigsTested: run.totalConfigsTested ?? null,
    oosFraction: run.oosFraction ?? null,
    startedAt: toIso(run.createdAt),
    completedAt: toIso(run.completedAt),
    errorReason: status === "failed" ? (sanitizeErrorReason(opts?.progress?.error) ?? "Run failed.") : null,
    correlationId: run.agentCorrelationId ?? null,
  };
}

/**
 * Out-of-sample summary. `null` means the run carried NO holdout (unvalidated).
 * When the holdout existed but was inconclusive (`sufficient === false`), the
 * fraction is kept but every metric is null — an honest "ran, but can't conclude."
 */
export function toOosSummaryDto(
  oos: LabOosMetrics | null | undefined,
  fraction: number | null | undefined,
): OosSummaryDto | null {
  if (!oos || !fraction || fraction <= 0) return null;
  if (!oos.sufficient) {
    return {
      fraction,
      netProfitPercent: null,
      winRatePercent: null,
      maxDrawdownPercent: null,
      sharpeRatio: null,
      totalTrades: null,
    };
  }
  return {
    fraction,
    netProfitPercent: oos.netProfitPercent,
    winRatePercent: oos.winRatePercent,
    maxDrawdownPercent: oos.maxDrawdownPercent,
    sharpeRatio: oos.sharpeRatio,
    totalTrades: oos.totalTrades,
  };
}

/** Headline result only — `trades[]` and `equityCurve[]` are intentionally dropped. */
export function toBacktestResultDto(
  row: LabOptResult,
  opts: { oosFraction: number | null | undefined },
): BacktestResultDto {
  return {
    resultId: row.id,
    runId: row.runId,
    ticker: row.ticker,
    timeframe: row.timeframe,
    rank: row.rank,
    netProfitPercent: row.netProfitPercent,
    winRatePercent: row.winRatePercent,
    maxDrawdownPercent: row.maxDrawdownPercent,
    profitFactor: row.profitFactor,
    sharpeRatio: row.sharpeRatio ?? null,
    totalTrades: row.totalTrades,
    params: (row.params ?? {}) as Record<string, unknown>,
    oos: toOosSummaryDto(row.oosMetrics, opts.oosFraction),
  };
}

export function toTopResultsDto(
  strategyId: number,
  runId: number | null,
  rows: LabOptResult[],
  opts: { oosFraction: number | null | undefined },
): TopResultsDto {
  return {
    strategyId,
    runId: runId ?? null,
    // Honest: the current lab ranks by its own objective, not robustness. The
    // adapter switches this to "robustness" only once it actually re-ranks.
    rankedBy: "lab_objective",
    results: rows.map((r) => toBacktestResultDto(r, opts)),
  };
}

export function toStrategyDto(
  s: LabStrategy,
  opts: { hasResults: boolean; latestRunId: number | null },
): StrategyDto {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    hasResults: opts.hasResults,
    latestRunId: opts.latestRunId ?? null,
    createdAt: toIso(s.createdAt) ?? new Date(0).toISOString(),
  };
}

export function toStrategyMatchDto(s: LabStrategy, score: number): StrategyMatchDto {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    score: clamp01(score),
  };
}

export function toQueuePositionDto(input: {
  jobsAhead: number;
  hasActiveRun: boolean;
  waitingOnManualRun?: boolean;
}): QueuePositionDto {
  return {
    jobsAhead: Math.max(0, Math.trunc(input.jobsAhead)),
    hasActiveRun: input.hasActiveRun,
    ...(input.waitingOnManualRun != null ? { waitingOnManualRun: input.waitingOnManualRun } : {}),
  };
}

/** Defensive: insights reportData is the AI Creator's jsonb (shape not fixed yet). */
export function toInsightsReportDto(report: LabInsightsReport): InsightsReportDto {
  const data = (report.reportData ?? {}) as Record<string, unknown>;
  const summary =
    typeof data.summary === "string"
      ? data.summary
      : typeof data.text === "string"
        ? (data.text as string)
        : "";
  const directionalBias = typeof data.directionalBias === "string" ? (data.directionalBias as string) : null;

  let paramSensitivity: { param: string; impact: number }[] | null = null;
  if (Array.isArray(data.paramSensitivity)) {
    const items = (data.paramSensitivity as unknown[])
      .filter(
        (x): x is { param: string; impact: number } =>
          !!x &&
          typeof (x as Record<string, unknown>).param === "string" &&
          typeof (x as Record<string, unknown>).impact === "number",
      )
      .map((x) => ({ param: x.param, impact: x.impact }));
    paramSensitivity = items.length ? items : null;
  }

  return {
    strategyId: report.strategyId,
    generatedAt: toIso(report.createdAt) ?? new Date(0).toISOString(),
    summary,
    paramSensitivity,
    directionalBias,
  };
}

export function toHeatmapDto(input: {
  strategyId: number;
  xParam: string;
  yParam: string;
  metricName: string;
  cells: { x: number | string; y: number | string; metric: number }[];
}): HeatmapDto {
  const capped = input.cells.slice(0, MAX_HEATMAP_CELLS);
  return {
    strategyId: input.strategyId,
    xParam: input.xParam,
    yParam: input.yParam,
    metricName: input.metricName,
    cells: capped,
    truncated: input.cells.length > MAX_HEATMAP_CELLS,
  };
}
