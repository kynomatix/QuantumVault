// QuantumLab Sandbox Agent — current-lab adapter (Phase A, T4).
//
// The ONLY module coupled to today's lab plumbing. It implements the toolkit
// adapter seam by reading the live lab storage and translating rows through the
// T3 DTO mappers; the harness then re-validates every result against the
// contract. Swapping the lab implementation later means writing a sibling
// adapter — the harness and the contract stay put.
//
// Phase A scope (docs/LAB_AGENT_SANDBOX_PLAN.md): the deterministic READ surface
// plus the idempotent CONTROL tools (runOptimization / refineFrom / cancelRun, T5)
// are wired. The following return a typed `not_implemented` for honesty:
//   - listTemplates / createStrategyFromTemplate — no template registry exists yet;
//   - getHeatmap — the lab's heatmap is a strategy-level ticker×timeframe grid,
//     NOT the per-run x/y-parameter sweep this contract defines; faking axes
//     would be dishonest;
//   - createStrategyFromText / improve / generateInsights — LLM-backed, later phase.
//
// Control tools ALWAYS queue (status:"queued" + queueOrder + a full configSnapshot
// the worker can resume) and kick the scheduler via an injected onRunQueued hook;
// they never spawn the inline worker fast-path (that is just an optimization the
// scheduler subsumes). Idempotency is keyed on (wallet, taskId, idempotencyKey)
// with the DB partial-UNIQUE index as the race backstop. The main process cannot
// reach the lab child's worker, so cancelRun fully handles only QUEUED runs and
// defers running-run cancellation to the T6 reconciler.
//
// Live job progress lives only in the lab CHILD process, so this main-process
// adapter reads run state from the DB run row + checkpoint (the §7b "DB is the
// source of truth" stance). progressPct is null when no live job is visible.

import type { ILabStorage } from "../lab/storage";
import type {
  LabOptResult,
  LabOptimizationConfig,
  LabOptimizationRun,
  LabPineInput,
  InsertLabRun,
} from "@shared/schema";
import type {
  LabAgentToolkitInput,
  LabAgentToolkitOutput,
  StrategyDto,
  RunQueuedDto,
  OptimizationStage,
} from "@shared/lab-agent-contract";
import { TERMINAL_RUN_STATUSES } from "@shared/lab-agent-contract";
import {
  toStrategyDto,
  toStrategyMatchDto,
  toBacktestResultDto,
  toInsightsReportDto,
  toRunStatusDto,
  toQueuePositionDto,
  type LiveProgress,
} from "./dto-mappers";
import { LabAgentToolkit, ToolkitError } from "./toolkit";
import type { LabAgentAdapter, ToolkitContext } from "./toolkit";
import { DEFAULT_LAB_SLIPPAGE } from "../lab/friction";
import { randomUUID } from "crypto";

/** The subset of lab storage this adapter reads. Keeps the coupling explicit. */
export type AdapterStorage = Pick<
  ILabStorage,
  | "getStrategies"
  | "getStrategy"
  | "getRuns"
  | "getRun"
  | "getTopResultsForStrategy"
  | "getJobByRunId"
  | "getLatestInsightsReport"
  | "getJobsAheadCount"
  | "hasActiveRun"
  | "createRun"
  | "getNextQueueOrder"
  | "getAgentRun"
  | "markAgentRunCancelled"
>;

/** Default out-of-sample holdout for agent runs when the caller omits one (§7b validity). */
const DEFAULT_AGENT_OOS_FRACTION = 0.2;

/** Minimum timeframe the agent may backtest: sub-hour bars overfit and burn data budget. */
const MIN_TIMEFRAME_MINUTES = 60;

/** The lab's own optimizer defaults; agent runs inherit them so behavior matches the UI path. */
const LAB_RANDOM_SAMPLES = 900;
const LAB_TOPK = 20;
const LAB_REFINEMENTS_PER_SEED = 60;
const LAB_MIN_TRADES = 10;
const LAB_MAX_DRAWDOWN_CAP = 85;
const LAB_MIN_AVG_BARS_HELD = 1;

/** Parse a lab timeframe ("45m","1h","4h","1d","1w") to minutes; null if unrecognized. */
function parseTimeframeMinutes(tf: string): number | null {
  const m = /^(\d+)\s*([mhdw])$/i.exec(tf.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const mult = unit === "m" ? 1 : unit === "h" ? 60 : unit === "d" ? 1440 : 10080;
  return n * mult;
}

/** Reject any timeframe below the 1H floor (or unparseable) with a typed invalid_input. */
function assertTimeframesAllowed(timeframes: string[]): void {
  for (const tf of timeframes) {
    const mins = parseTimeframeMinutes(tf);
    if (mins == null) {
      throw new ToolkitError("invalid_input", `Unrecognized timeframe '${tf}'.`, false);
    }
    if (mins < MIN_TIMEFRAME_MINUTES) {
      throw new ToolkitError(
        "invalid_input",
        `Timeframe '${tf}' is below the 1H minimum for robust backtests.`,
        false,
      );
    }
  }
}

/**
 * Translate the contract's abstract stage list into the lab's REAL config knobs
 * (§6 honing order). `random` is mandatory (enforced by the caller); `refine`
 * drives topK + refinementsPerSeed; `deep` → deepSearch; `coordinate` →
 * coordinateTune. We invent no knobs the worker ignores.
 */
function mapStagesToKnobs(stages: OptimizationStage[]): {
  randomSamples: number;
  topK: number;
  refinementsPerSeed: number;
  deepSearch: boolean;
  coordinateTune: boolean;
} {
  const refine = stages.includes("refine");
  return {
    randomSamples: LAB_RANDOM_SAMPLES,
    topK: refine ? LAB_TOPK : 1,
    refinementsPerSeed: refine ? LAB_REFINEMENTS_PER_SEED : 0,
    deepSearch: stages.includes("deep"),
    coordinateTune: stages.includes("coordinate"),
  };
}

/** YYYY-MM-DD `daysAgo` days before now (UTC). */
function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().split("T")[0];
}

/**
 * Sentinel queueOrder used to ask "how many jobs are in the system right now"
 * (i.e. everything would be ahead of a brand-new queue entry). getJobsAheadCount
 * counts running/paused + queued runs with queueOrder strictly below this.
 */
const QUEUE_TAIL = Number.MAX_SAFE_INTEGER;

/** Cap on how many fuzzy strategy matches we hand back. */
const MAX_STRATEGY_MATCHES = 25;

/**
 * Deterministic fuzzy score 0..1 for a strategy name vs a query. Exact > prefix
 * > substring > token overlap. Never exceeds the substring tier for partial
 * token hits, so an exact/prefix match always sorts first.
 */
function scoreStrategyMatch(name: string, query: string): number {
  const n = name.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (!n || !q) return 0;
  if (n === q) return 1;
  if (n.startsWith(q)) return 0.9;
  if (n.includes(q)) return 0.75;
  const nameTokens = n.split(/\s+/).filter(Boolean);
  const queryTokens = q.split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return 0;
  let matched = 0;
  for (const t of queryTokens) {
    if (nameTokens.some((x) => x === t || x.includes(t))) matched++;
  }
  return matched > 0 ? Math.min(0.7, 0.35 + 0.2 * matched) : 0;
}

export class CurrentLabAdapter implements LabAgentAdapter {
  /**
   * @param storage      the lab storage subset this adapter touches.
   * @param onRunQueued  OPTIONAL scheduler kick, called with a freshly QUEUED run
   *   id. No-op in Phase A / tests (the toolkit is dormant). When the toolkit is
   *   mounted (Phase B) this MUST trigger the live queue pump, or an idle system
   *   could leave an agent-queued run unstarted until the next manual run. Wiring
   *   it through the constructor (not an import) avoids a circular dep on the
   *   scheduler and keeps this module side-effect-free at import time.
   */
  constructor(
    private readonly storage: AdapterStorage,
    private readonly onRunQueued?: (runId: number) => void,
  ) {}

  // -------------------------------------------------------------------------
  // Reads (fully wired)
  // -------------------------------------------------------------------------

  async listStrategies(
    ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"listStrategies">,
  ): Promise<LabAgentToolkitOutput<"listStrategies">> {
    const wallet = ctx.walletAddress;
    const strategies = await this.storage.getStrategies(wallet);
    // One query for all of the wallet's runs (ordered newest-first); the first
    // run seen per strategy is its latest.
    const runs = await this.storage.getRuns(undefined, wallet);
    const latestByStrategy = new Map<number, number>();
    for (const r of runs) {
      if (r.strategyId != null && !latestByStrategy.has(r.strategyId)) {
        latestByStrategy.set(r.strategyId, r.id);
      }
    }
    // hasResults is a per-strategy existence check. Bounded by strategy count;
    // a single aggregate query could replace this if the list ever grows large.
    const out: StrategyDto[] = await Promise.all(
      strategies.map(async (s) => {
        const top = await this.storage.getTopResultsForStrategy(s.id, 1);
        return toStrategyDto(s, {
          hasResults: top.length > 0,
          latestRunId: latestByStrategy.get(s.id) ?? null,
        });
      }),
    );
    return out;
  }

  async findStrategy(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"findStrategy">,
  ): Promise<LabAgentToolkitOutput<"findStrategy">> {
    const strategies = await this.storage.getStrategies(ctx.walletAddress);
    return strategies
      .map((s) => ({ s, score: scoreStrategyMatch(s.name, input.query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_STRATEGY_MATCHES)
      .map((x) => toStrategyMatchDto(x.s, x.score));
  }

  async getTopResults(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"getTopResults">,
  ): Promise<LabAgentToolkitOutput<"getTopResults">> {
    const strategy = await this.storage.getStrategy(input.strategyId);
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy ${input.strategyId} not found.`, false);
    }
    const rows = await this.storage.getTopResultsForStrategy(input.strategyId, input.limit ?? 10);
    // The OOS holdout fraction is a per-RUN property and these top results span
    // multiple runs, so resolve each row's fraction from its own run. A null
    // fraction means that run carried no holdout → the result is UNVALIDATED.
    const runs = await this.storage.getRuns(input.strategyId);
    const oosByRun = new Map<number, number | null>();
    for (const r of runs) oosByRun.set(r.id, r.oosFraction ?? null);
    const results = rows.map((row: LabOptResult) =>
      toBacktestResultDto(row, { oosFraction: oosByRun.get(row.runId) ?? null }),
    );
    // Strategy-level set spanning runs → top-level runId is null; each result
    // carries its own runId. Ranked by the lab's current objective (honest; not
    // robustness — see docs/QUANTUMLAB_ACCURACY_DIAGNOSIS.md).
    return {
      strategyId: input.strategyId,
      runId: null,
      rankedBy: "lab_objective",
      results,
    };
  }

  async getInsightsReport(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"getInsightsReport">,
  ): Promise<LabAgentToolkitOutput<"getInsightsReport">> {
    const strategy = await this.storage.getStrategy(input.strategyId);
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy ${input.strategyId} not found.`, false);
    }
    const report = await this.storage.getLatestInsightsReport(input.strategyId);
    if (!report) {
      throw new ToolkitError("not_found", `No insights report for strategy ${input.strategyId} yet.`, false);
    }
    return toInsightsReportDto(report);
  }

  async getRunStatus(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"getRunStatus">,
  ): Promise<LabAgentToolkitOutput<"getRunStatus">> {
    const run = await this.storage.getRun(input.runId);
    if (!run || run.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Run ${input.runId} not found.`, false);
    }
    // Live progress is only present if this process holds the in-memory job
    // (child-only today); otherwise we report purely from the DB row + checkpoint.
    const job = this.storage.getJobByRunId(input.runId);
    const progress: LiveProgress | null = job
      ? {
          status: job.progress.status,
          stage: job.progress.stage,
          percent: job.progress.percent,
          error: job.progress.error,
        }
      : null;
    let jobsAhead: number | null = null;
    if (run.status === "queued" && run.queueOrder != null) {
      jobsAhead = await this.storage.getJobsAheadCount(run.queueOrder);
    }
    return toRunStatusDto(run, { progress, jobsAhead });
  }

  async getQueuePosition(
    ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"getQueuePosition">,
  ): Promise<LabAgentToolkitOutput<"getQueuePosition">> {
    const hasActiveRun = await this.storage.hasActiveRun(ctx.walletAddress);
    const jobsAhead = await this.storage.getJobsAheadCount(QUEUE_TAIL);
    return toQueuePositionDto({ jobsAhead, hasActiveRun });
  }

  // -------------------------------------------------------------------------
  // Not implemented this phase (honest typed failures, not fabricated data)
  // -------------------------------------------------------------------------

  async listTemplates(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"listTemplates">,
  ): Promise<LabAgentToolkitOutput<"listTemplates">> {
    throw new ToolkitError("not_implemented", "Strategy templates are not available via the agent yet.", false);
  }

  async getHeatmap(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"getHeatmap">,
  ): Promise<LabAgentToolkitOutput<"getHeatmap">> {
    throw new ToolkitError(
      "not_implemented",
      "Per-run parameter heatmaps are not available via the agent yet.",
      false,
    );
  }

  async createStrategyFromText(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"createStrategyFromText">,
  ): Promise<LabAgentToolkitOutput<"createStrategyFromText">> {
    throw new ToolkitError("not_implemented", "AI strategy generation is not available in this phase.", false);
  }

  async createStrategyFromTemplate(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"createStrategyFromTemplate">,
  ): Promise<LabAgentToolkitOutput<"createStrategyFromTemplate">> {
    throw new ToolkitError("not_implemented", "Strategy templates are not available via the agent yet.", false);
  }

  async runOptimization(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"runOptimization">,
  ): Promise<LabAgentToolkitOutput<"runOptimization">> {
    const taskId = this.requireTaskId(ctx);
    if (!input.stages.includes("random")) {
      throw new ToolkitError("invalid_input", "Every optimization must start with the 'random' stage.", false);
    }
    assertTimeframesAllowed(input.timeframes);
    const strategy = await this.storage.getStrategy(input.strategyId);
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy ${input.strategyId} not found.`, false);
    }
    const parsedInputs = (strategy.parsedInputs as LabPineInput[] | null) ?? [];
    if (parsedInputs.length === 0) {
      throw new ToolkitError("invalid_input", "Strategy has no parameters to optimize.", false);
    }
    const settings = (strategy.strategySettings ?? {}) as Record<string, any>;
    const isNative = settings.nativeEngine === true;
    const knobs = mapStagesToKnobs(input.stages);
    const oosFraction = input.outOfSampleFraction ?? DEFAULT_AGENT_OOS_FRACTION;
    const slippage = DEFAULT_LAB_SLIPPAGE;
    const startDate = input.startDate ?? isoDaysAgo(365);
    const endDate = input.endDate ?? isoDaysAgo(0);

    const config: LabOptimizationConfig = {
      pineScript: strategy.pineScript ?? "",
      parsedInputs,
      tickers: input.symbols,
      timeframes: input.timeframes,
      startDate,
      endDate,
      randomSamples: knobs.randomSamples,
      topK: knobs.topK,
      refinementsPerSeed: knobs.refinementsPerSeed,
      minTrades: LAB_MIN_TRADES,
      maxDrawdownCap: LAB_MAX_DRAWDOWN_CAP,
      minAvgBarsHeld: LAB_MIN_AVG_BARS_HELD,
      mode: "sweep",
      strategyId: input.strategyId,
      engineType: isNative ? settings.engineType : undefined,
      useInsights: false,
      deepSearch: knobs.deepSearch,
      coordinateTune: knobs.coordinateTune,
      outOfSampleFraction: oosFraction,
      slippage,
    };
    // Native engines key off engineType; the stored pine script is irrelevant and
    // the live route strips it, so we mirror that to keep the snapshot honest.
    if (isNative) delete (config as Partial<LabOptimizationConfig>).pineScript;

    const { run, idempotent, correlationId } = await this.idempotentEnqueue(
      ctx,
      taskId,
      input.idempotencyKey,
      ({ correlationId, queueOrder }) => ({
        strategyId: input.strategyId,
        userId: ctx.walletAddress,
        tickers: input.symbols,
        timeframes: input.timeframes,
        startDate,
        endDate,
        randomSamples: knobs.randomSamples,
        topK: knobs.topK,
        refinementsPerSeed: knobs.refinementsPerSeed,
        minTrades: LAB_MIN_TRADES,
        maxDrawdownCap: LAB_MAX_DRAWDOWN_CAP,
        mode: "sweep",
        status: "queued",
        queueOrder,
        oosFraction,
        slippage,
        configSnapshot: { type: "new", config } as any,
        agentTaskId: taskId,
        agentIdempotencyKey: input.idempotencyKey,
        agentCorrelationId: correlationId,
        agentOwned: true,
      }),
    );
    return this.toRunQueued(run, idempotent, correlationId);
  }

  async refineFrom(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"refineFrom">,
  ): Promise<LabAgentToolkitOutput<"refineFrom">> {
    const taskId = this.requireTaskId(ctx);
    const source = await this.storage.getRun(input.runId);
    if (!source || source.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Run ${input.runId} not found.`, false);
    }
    const strategy = source.strategyId != null ? await this.storage.getStrategy(source.strategyId) : undefined;
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy for run ${input.runId} not found.`, false);
    }
    const parsedInputs = (strategy.parsedInputs as LabPineInput[] | null) ?? [];
    if (parsedInputs.length === 0) {
      throw new ToolkitError("invalid_input", "Strategy has no parameters to refine.", false);
    }
    const srcTickers = Array.isArray(source.tickers) ? (source.tickers as string[]) : [];
    const srcTimeframes = Array.isArray(source.timeframes) ? (source.timeframes as string[]) : [];
    const ticker = srcTickers[0];
    const timeframe = srcTimeframes[0];
    if (!ticker || !timeframe) {
      throw new ToolkitError("invalid_input", "Source run has no ticker/timeframe to refine from.", false);
    }
    // Recover the source run's own config from its snapshot (checkpoint first,
    // then the queued snapshot), falling back to the run columns. This is the
    // GOOD refine path: it re-threads the OOS holdout + slippage rather than
    // dropping them like the server/index.ts fallback (which blanked the OOS col).
    const srcConfig: Partial<LabOptimizationConfig> | null =
      (source.checkpoint && typeof source.checkpoint === "object"
        ? ((source.checkpoint as any).configSnapshot as Partial<LabOptimizationConfig> | undefined)
        : undefined)
      ?? (source.configSnapshot && typeof source.configSnapshot === "object"
        ? ((source.configSnapshot as any).config as Partial<LabOptimizationConfig> | undefined)
        : undefined)
      ?? null;
    const settings = (strategy.strategySettings ?? {}) as Record<string, any>;
    const isNative = settings.nativeEngine === true;
    const oosFraction = srcConfig?.outOfSampleFraction ?? source.oosFraction ?? DEFAULT_AGENT_OOS_FRACTION;
    const slippage = srcConfig?.slippage ?? source.slippage ?? DEFAULT_LAB_SLIPPAGE;
    const startDate = srcConfig?.startDate ?? source.startDate ?? isoDaysAgo(365);
    const endDate = srcConfig?.endDate ?? source.endDate ?? isoDaysAgo(0);
    const randomSamples = srcConfig?.randomSamples ?? source.randomSamples ?? LAB_RANDOM_SAMPLES;
    const topK = srcConfig?.topK ?? source.topK ?? LAB_TOPK;
    const refinementsPerSeed = srcConfig?.refinementsPerSeed ?? source.refinementsPerSeed ?? LAB_REFINEMENTS_PER_SEED;
    const minTrades = srcConfig?.minTrades ?? source.minTrades ?? LAB_MIN_TRADES;
    const maxDrawdownCap = srcConfig?.maxDrawdownCap ?? source.maxDrawdownCap ?? LAB_MAX_DRAWDOWN_CAP;

    const config: LabOptimizationConfig = {
      pineScript: strategy.pineScript ?? "",
      parsedInputs,
      tickers: [ticker],
      timeframes: [timeframe],
      startDate,
      endDate,
      randomSamples,
      topK,
      refinementsPerSeed,
      minTrades,
      maxDrawdownCap,
      minAvgBarsHeld: srcConfig?.minAvgBarsHeld ?? LAB_MIN_AVG_BARS_HELD,
      mode: "sweep",
      strategyId: strategy.id,
      engineType: isNative ? settings.engineType : undefined,
      // Refine = the deep/coordinate honing pass that consumes prior insights.
      useInsights: true,
      deepSearch: true,
      coordinateTune: true,
      outOfSampleFraction: oosFraction,
      slippage,
    };
    if (isNative) delete (config as Partial<LabOptimizationConfig>).pineScript;

    const { run, idempotent, correlationId } = await this.idempotentEnqueue(
      ctx,
      taskId,
      input.idempotencyKey,
      ({ correlationId, queueOrder }) => ({
        strategyId: strategy.id,
        userId: ctx.walletAddress,
        tickers: [ticker],
        timeframes: [timeframe],
        startDate,
        endDate,
        randomSamples,
        topK,
        refinementsPerSeed,
        minTrades,
        maxDrawdownCap,
        mode: "sweep",
        status: "queued",
        queueOrder,
        oosFraction,
        slippage,
        // sourceRunId lets the live route's dup-check also see agent refines.
        configSnapshot: { type: "new", config, sourceRunId: input.runId } as any,
        agentTaskId: taskId,
        agentIdempotencyKey: input.idempotencyKey,
        agentCorrelationId: correlationId,
        agentOwned: true,
      }),
    );
    return this.toRunQueued(run, idempotent, correlationId);
  }

  async generateInsights(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"generateInsights">,
  ): Promise<LabAgentToolkitOutput<"generateInsights">> {
    throw new ToolkitError("not_implemented", "Insights generation is not available in this phase.", false);
  }

  async improve(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"improve">,
  ): Promise<LabAgentToolkitOutput<"improve">> {
    throw new ToolkitError("not_implemented", "AI improvement is not available in this phase.", false);
  }

  async cancelRun(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"cancelRun">,
  ): Promise<LabAgentToolkitOutput<"cancelRun">> {
    const run = await this.storage.getRun(input.runId);
    if (!run || run.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Run ${input.runId} not found.`, false);
    }
    if (!run.agentOwned) {
      throw new ToolkitError(
        "forbidden",
        "This run was not started by the agent and cannot be cancelled here.",
        false,
      );
    }
    const current = toRunStatusDto(run);
    // Already terminal (complete/failed/cancelled) → cancel is an idempotent
    // no-op; report the real current status rather than pretending we acted.
    if (TERMINAL_RUN_STATUSES.has(current.status)) {
      return current;
    }
    // Queued runs have no worker yet → terminal-mark them here (CAS on queued).
    if (run.status === "queued") {
      const cancelled = await this.storage.markAgentRunCancelled(run.id);
      if (cancelled) {
        const updated = await this.storage.getRun(run.id);
        return toRunStatusDto(updated ?? run);
      }
      // Lost the CAS race: the worker claimed it between our read and write.
      // Fall through to the running-run path below (honest — we can't stop it).
    }
    // Running/paused: the worker lives in the lab CHILD process; the main process
    // can't stop it. Cooperative cancellation of a live run is the T6 reconciler's
    // job, so surface a conflict rather than silently "succeeding".
    throw new ToolkitError(
      "conflict",
      "This run is already executing; live cancellation is handled by the reconciler (not available in this phase).",
      false,
    );
  }

  // -------------------------------------------------------------------------
  // Control-tool internals (idempotency + queueing)
  // -------------------------------------------------------------------------

  /** Control writes need an owning task so the (wallet, taskId, key) idempotency scope exists. */
  private requireTaskId(ctx: ToolkitContext): number {
    if (ctx.taskId == null) {
      throw new ToolkitError("forbidden", "Control operations require an owning agent task.", false);
    }
    return ctx.taskId;
  }

  /**
   * Idempotent enqueue keyed on (wallet, taskId, idempotencyKey). On a retry the
   * existing run is returned untouched (idempotent:true). Otherwise it inserts a
   * fresh QUEUED run and kicks the scheduler. The DB partial-UNIQUE index is the
   * race backstop: a concurrent duplicate insert throws 23505 → we reselect and
   * return the winner, so a double-submit never double-queues.
   */
  private async idempotentEnqueue(
    ctx: ToolkitContext,
    taskId: number,
    idempotencyKey: string,
    build: (meta: { correlationId: string; queueOrder: number }) => InsertLabRun,
  ): Promise<{ run: LabOptimizationRun; idempotent: boolean; correlationId: string }> {
    const existing = await this.storage.getAgentRun(ctx.walletAddress, taskId, idempotencyKey);
    if (existing) {
      return { run: existing, idempotent: true, correlationId: existing.agentCorrelationId ?? "" };
    }
    const correlationId = ctx.correlationId ?? randomUUID();
    const queueOrder = await this.storage.getNextQueueOrder(ctx.walletAddress);
    try {
      const run = await this.storage.createRun(build({ correlationId, queueOrder }));
      this.onRunQueued?.(run.id);
      return { run, idempotent: false, correlationId };
    } catch (e) {
      if ((e as any)?.code === "23505") {
        const raced = await this.storage.getAgentRun(ctx.walletAddress, taskId, idempotencyKey);
        if (raced) {
          return { run: raced, idempotent: true, correlationId: raced.agentCorrelationId ?? correlationId };
        }
      }
      throw e;
    }
  }

  /** Shape a freshly-queued (or idempotently-returned) run into the contract DTO. */
  private async toRunQueued(
    run: LabOptimizationRun,
    idempotent: boolean,
    correlationId: string,
  ): Promise<RunQueuedDto> {
    let jobsAhead: number | null = null;
    if (run.status === "queued" && run.queueOrder != null) {
      jobsAhead = await this.storage.getJobsAheadCount(run.queueOrder);
    }
    const status = toRunStatusDto(run, { jobsAhead }).status;
    return {
      runId: run.id,
      correlationId: run.agentCorrelationId ?? correlationId,
      status,
      idempotent,
      jobsAhead: status === "queued" ? jobsAhead : null,
    };
  }
}

/** Build a toolkit adapter over an explicit storage (used in tests + wiring). */
export function createCurrentLabAdapter(
  storage: AdapterStorage,
  onRunQueued?: (runId: number) => void,
): LabAgentAdapter {
  return new CurrentLabAdapter(storage, onRunQueued);
}

/**
 * Production binding to the live lab storage singleton. The import is lazy so
 * that merely importing this module has no DB side effects until the toolkit is
 * actually wired into the running server (keeps Phase A dormant). `onRunQueued`
 * is the scheduler kick; it stays undefined (no-op) until Phase B mounts the
 * toolkit and passes the live queue pump.
 */
export async function createLiveLabAgentToolkit(
  onRunQueued?: (runId: number) => void,
): Promise<LabAgentToolkit> {
  const { labStorage } = await import("../lab/storage");
  return new LabAgentToolkit(createCurrentLabAdapter(labStorage, onRunQueued));
}
