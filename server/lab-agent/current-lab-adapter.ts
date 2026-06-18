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
  toHeatmapDto,
  toRunStatusDto,
  toQueuePositionDto,
  type LiveProgress,
} from "./dto-mappers";
import { LabAgentToolkit, ToolkitError } from "./toolkit";
import type { LabAgentAdapter, ToolkitContext } from "./toolkit";
import { DEFAULT_LAB_SLIPPAGE } from "../lab/friction";
import { robustnessRank } from "../lab/metrics";
import { randomUUID } from "crypto";

/** The subset of lab storage this adapter reads. Keeps the coupling explicit. */
export type AdapterStorage = Pick<
  ILabStorage,
  | "getStrategies"
  | "getStrategy"
  | "getRuns"
  | "getRun"
  | "getTopResultsForStrategy"
  | "getResult"
  | "getHeatmapCells"
  | "getJobByRunId"
  | "getLatestInsightsReport"
  | "getJobsAheadCount"
  | "walletHasManualRunAhead"
  | "hasActiveRun"
  | "createStrategy"
  | "createRun"
  | "getNextQueueOrder"
  | "getAgentRun"
  | "getAgentRunsForTask"
  | "markAgentRunCancelled"
>;

/** Default out-of-sample holdout for agent runs when the caller omits one (§7b validity). */
const DEFAULT_AGENT_OOS_FRACTION = 0.2;

/**
 * Leash (Task #200): cap how many of a task's backtests may sit in-flight at once.
 * The auto-planner queues one multi-symbol run per phase, so this bounds a runaway
 * loop (or a buggy planner) from flooding the single shared worker. Counted from the
 * DB (authoritative), not the planner's own tally, so it holds across crash/replay.
 */
const MAX_QUEUED_AGENT_BACKTESTS = 3;

/** Raw run statuses that still occupy a worker/queue slot (everything non-terminal). */
const ACTIVE_AGENT_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "paused",
  "fetching",
]);

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

/** Robustness score for a raw lab result row (superset of RankableResult). */
function rankRow(row: any): number {
  return robustnessRank({
    netProfitPercent: row.netProfitPercent,
    winRatePercent: row.winRatePercent,
    maxDrawdownPercent: row.maxDrawdownPercent,
    profitFactor: row.profitFactor,
    totalTrades: row.totalTrades,
    sharpeRatio: row.sharpeRatio ?? undefined,
    is: row.isMetrics ?? undefined,
    oos: row.oosMetrics ?? undefined,
  });
}

/**
 * Deterministic parameter sensitivity (no LLM): for each numeric/scalar param in
 * the result set, group results by that param's value, average net profit per
 * value, and report the SPREAD (max avg − min avg) as the param's impact. A large
 * spread means net profit depends heavily on getting that param right. Params with
 * fewer than 2 distinct values carry no sensitivity signal and are skipped. Returns
 * the top 8 by impact.
 */
function computeParamSensitivity(rows: any[]): { param: string; impact: number }[] {
  // Plain Record (not Map) so iteration via Object.entries/values stays array-based
  // and does not require the --downlevelIteration tsc flag.
  const byParam: Record<string, Record<string, { sum: number; n: number }>> = {};
  for (const row of rows) {
    const params = (row?.params ?? {}) as Record<string, unknown>;
    const net = Number(row?.netProfitPercent ?? 0);
    if (!Number.isFinite(net)) continue;
    for (const [key, val] of Object.entries(params)) {
      if (val == null || typeof val === "object") continue;
      const valueKey = String(val);
      let valueMap = byParam[key];
      if (!valueMap) {
        valueMap = {};
        byParam[key] = valueMap;
      }
      let agg = valueMap[valueKey];
      if (!agg) {
        agg = { sum: 0, n: 0 };
        valueMap[valueKey] = agg;
      }
      agg.sum += net;
      agg.n += 1;
    }
  }
  const out: { param: string; impact: number }[] = [];
  for (const [param, valueMap] of Object.entries(byParam)) {
    const aggs = Object.values(valueMap);
    if (aggs.length < 2) continue;
    let min = Infinity;
    let max = -Infinity;
    for (const { sum, n } of aggs) {
      const avg = sum / n;
      if (avg < min) min = avg;
      if (avg > max) max = avg;
    }
    out.push({ param, impact: Math.round((max - min) * 100) / 100 });
  }
  out.sort((a, b) => b.impact - a.impact);
  return out.slice(0, 8);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${Math.round(n * 100) / 100}%`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return String(Math.round(n * 100) / 100);
}

/**
 * Map a thrown LLM-gateway error to a typed ToolkitError. LlmGatewayError messages
 * are already sanitized at the gateway, so they are safe to relay; any other error
 * collapses to a generic `internal` so no raw text/stack leaks to the agent. The
 * import is lazy to keep this module side-effect-free at import time (Phase A
 * dormancy), matching the lazy `labStorage` import below.
 */
async function mapLlmError(e: unknown): Promise<ToolkitError> {
  const { LlmGatewayError } = await import("../ai-assistant/router");
  if (e instanceof LlmGatewayError) {
    switch (e.status) {
      case 429:
        return new ToolkitError("rate_limited", e.message, true);
      case 400:
        return new ToolkitError("invalid_input", e.message, false);
      case 401:
      case 403:
        return new ToolkitError("conflict", e.message, false);
      default:
        return new ToolkitError("internal", "An AI service error occurred.", false);
    }
  }
  return new ToolkitError("internal", "An unexpected error occurred.", false);
}

/**
 * Recover a run's own optimization config from its checkpoint (preferred) or its
 * queued snapshot. Mirrors refineFrom's recovery so a DERIVED run re-threads the
 * parent's window / holdout / slippage instead of silently defaulting them. Note
 * the deliberate asymmetry: a checkpoint stores the config under `configSnapshot`,
 * whereas the run's `configSnapshot` column wraps it as `{type, config}`.
 */
function recoverRunConfig(run: LabOptimizationRun): Partial<LabOptimizationConfig> | null {
  return (
    (run.checkpoint && typeof run.checkpoint === "object"
      ? ((run.checkpoint as any).configSnapshot as Partial<LabOptimizationConfig> | undefined)
      : undefined)
    ?? (run.configSnapshot && typeof run.configSnapshot === "object"
      ? ((run.configSnapshot as any).config as Partial<LabOptimizationConfig> | undefined)
      : undefined)
    ?? null
  );
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
    /**
     * OPTIONAL BYO-key resolver. Given a wallet, returns its decrypted OpenRouter
     * key as a Buffer (the adapter ALWAYS zeroizes it), or null when the key was
     * deleted or the session is locked between the check and now. Left undefined,
     * the LLM-backed tools (createStrategyFromText / improve) stay not_implemented.
     */
    private readonly resolveLlmKey?: (wallet: string) => Promise<Buffer | null>,
  ) {}

  /**
   * Run an LLM-backed operation with the wallet's BYO OpenRouter key. Resolves the
   * key transiently, hands the callback an immutable string copy, and ALWAYS
   * zeroizes the decrypted buffer in `finally`. Errors are mapped to typed
   * ToolkitErrors so no raw gateway text or stack ever reaches the agent:
   *   - no resolver wired                       → not_implemented (LLM tools dormant)
   *   - resolver returns null (key gone/locked) → conflict (the user must add a key)
   *   - LlmGatewayError 429 → rate_limited; 400 → invalid_input; 401/403 → conflict
   *   - anything else                           → internal (generic, no leak)
   */
  private async withLlmKey<T>(
    wallet: string,
    fn: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    if (!this.resolveLlmKey) {
      throw new ToolkitError(
        "not_implemented",
        "AI features are not available in this phase.",
        false,
      );
    }
    let keyBuf: Buffer | null = null;
    try {
      keyBuf = await this.resolveLlmKey(wallet);
      if (!keyBuf) {
        throw new ToolkitError(
          "conflict",
          "No OpenRouter API key is set, or your session is locked. Add your key and try again.",
          false,
        );
      }
      const apiKey = keyBuf.toString("utf8");
      return await fn(apiKey);
    } catch (e) {
      if (e instanceof ToolkitError) throw e;
      throw await mapLlmError(e);
    } finally {
      if (keyBuf) keyBuf.fill(0);
    }
  }

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
    const limit = input.limit ?? 10;
    const wantTf = input.timeframe?.trim().toLowerCase();
    const wantTk = input.ticker?.trim().toUpperCase();
    const filtering = Boolean(wantTf || wantTk);
    // Re-rank by ROBUSTNESS, not the lab's headline (leveraged-profit) objective.
    // Fetch a wider candidate pool than `limit` so the robustness sort has real
    // choice beyond the lab's own top-by-profit slice, then keep the most robust
    // `limit`. This is what makes the agent recommend durable configs over
    // curve-fits (docs/QUANTUMLAB_ACCURACY_DIAGNOSIS.md). When a specific
    // timeframe/ticker is requested, widen the pool to the strategy's full set
    // first so the requested combo is ALWAYS present (the storage returns one
    // best row per combo), then filter to it; otherwise a freshly run combo can
    // be sliced off and we'd report a stale older one.
    const candidatePool = filtering ? 200 : Math.min(50, limit * 5);
    let rows = await this.storage.getTopResultsForStrategy(input.strategyId, candidatePool);
    if (filtering) {
      rows = rows.filter(
        (r: any) =>
          (!wantTf || String(r.timeframe ?? "").toLowerCase() === wantTf) &&
          (!wantTk || String(r.ticker ?? "").toUpperCase() === wantTk),
      );
    }
    // The OOS holdout fraction is a per-RUN property and these top results span
    // multiple runs, so resolve each row's fraction from its own run. A null
    // fraction means that run carried no holdout → the result is UNVALIDATED.
    const runs = await this.storage.getRuns(input.strategyId);
    const oosByRun = new Map<number, number | null>();
    for (const r of runs) oosByRun.set(r.id, r.oosFraction ?? null);
    // Rank by POST-LEVERAGE performance (leveragedNetProfitPercent), matching the lab's
    // Results tab so the user sees the SAME order in chat as on that tab (rank 1 = highest
    // leveraged return). Each result still carries its out-of-sample metrics so the brain
    // can flag the top leveraged picks that are likely curve-fits. The auto pipeline's
    // separate graduation gate (auto-planner pickRobustResult) is what actually decides
    // what is safe to widen to more assets or treat as proven.
    const ranked = rows
      .map((row: any) => toBacktestResultDto(row, { oosFraction: oosByRun.get(row.runId) ?? null }))
      .sort((a, b) => (b.leveragedNetProfitPercent ?? 0) - (a.leveragedNetProfitPercent ?? 0))
      .slice(0, limit);
    const results = ranked.map((dto, idx) => ({ ...dto, rank: idx + 1 }));
    // Strategy-level set spanning runs → top-level runId is null; each result
    // carries its own runId.
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
      jobsAhead = await this.storage.getJobsAheadCount(run.queueOrder, {
        agentOwned: run.agentOwned === true,
        runId: run.id,
      });
    }
    return toRunStatusDto(run, { progress, jobsAhead });
  }

  async getQueuePosition(
    ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"getQueuePosition">,
  ): Promise<LabAgentToolkitOutput<"getQueuePosition">> {
    const hasActiveRun = await this.storage.hasActiveRun(ctx.walletAddress);
    // An agent run would queue at the tail (behind every manual + agent run).
    const jobsAhead = await this.storage.getJobsAheadCount(QUEUE_TAIL, { agentOwned: true });
    const waitingOnManualRun = await this.storage.walletHasManualRunAhead(ctx.walletAddress);
    return toQueuePositionDto({ jobsAhead, hasActiveRun, waitingOnManualRun });
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
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"getHeatmap">,
  ): Promise<LabAgentToolkitOutput<"getHeatmap">> {
    const strategy = await this.storage.getStrategy(input.strategyId);
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy ${input.strategyId} not found.`, false);
    }
    // The lab's heatmap is a strategy-level ticker×timeframe grid (each cell
    // aggregates that combo's results), so the axes ARE ticker and timeframe and
    // the per-cell metric is its average Sharpe — the most robustness-aligned
    // single number the grid exposes. (This is why the input keys on strategyId,
    // not runId: the grid spans every completed run of the strategy.)
    const { cells } = await this.storage.getHeatmapCells(ctx.walletAddress, input.strategyId);
    const mapped = cells.map((c: any) => ({
      x: String(c.ticker),
      y: String(c.timeframe),
      metric: Number(c.avgSharpe ?? 0),
    }));
    return toHeatmapDto({
      strategyId: input.strategyId,
      xParam: "ticker",
      yParam: "timeframe",
      metricName: "avgSharpe",
      cells: mapped,
    });
  }

  async createStrategyFromText(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"createStrategyFromText">,
  ): Promise<LabAgentToolkitOutput<"createStrategyFromText">> {
    const wallet = ctx.walletAddress;
    // BYO-key LLM draft. withLlmKey resolves + zeroizes the key and maps any
    // gateway error to a typed ToolkitError; with no resolver wired it stays
    // not_implemented (Phase A dormancy).
    const draft = await this.withLlmKey(wallet, async (apiKey) => {
      const { draftStrategy } = await import("../ai-assistant/creator");
      return draftStrategy({ idea: input.prompt, apiKey, walletAddress: wallet });
    });
    // The agent's next move is to backtest this strategy, so a draft that doesn't
    // compile is a dead end that would only fail later in the worker. Fail loud
    // (retryable) rather than persisting a broken, un-runnable strategy.
    if (!draft.compileOk) {
      throw new ToolkitError(
        "internal",
        "The AI drafted a strategy but it failed to compile. Try rephrasing your idea.",
        true,
      );
    }
    const { parsePineScript } = await import("../lab/pine-parser");
    const parsed = parsePineScript(draft.pineScript);
    const name = input.name?.trim() || parsed.strategyName || "AI strategy";
    const strategy = await this.storage.createStrategy({
      name,
      pineScript: draft.pineScript,
      description: null,
      parsedInputs: parsed.inputs,
      groups: parsed.groups ?? null,
      strategySettings: parsed.strategySettings ?? null,
      userId: wallet,
    });
    return { strategyId: strategy.id, name: strategy.name };
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

    // Resolve the SOURCE run and — when a specific result is named — that result's
    // EXACT saved params. resultId is the per-result QUICK hone (mirrors the UI's
    // per-row "refresh"): the server looks up the result's params + its OWN
    // ticker/timeframe (NOT the source run's first combo, which would mis-target a
    // multi-combo run) and seeds them with deep search OFF. runId (no resultId) is
    // the heavier whole-run refine (deep search ON), unchanged.
    const resolved = await (async () => {
      if (input.resultId != null) {
        const result = await this.storage.getResult(input.resultId);
        if (!result) {
          throw new ToolkitError("not_found", `Result ${input.resultId} not found.`, false);
        }
        const run = await this.storage.getRun(result.runId);
        // Wallet isolation rides the parent run; hide a foreign result as not_found.
        if (!run || run.userId !== ctx.walletAddress) {
          throw new ToolkitError("not_found", `Result ${input.resultId} not found.`, false);
        }
        return {
          source: run,
          sourceRunId: result.runId,
          seedParams: (result.params ?? {}) as Record<string, unknown>,
          seedTicker: result.ticker as string,
          seedTimeframe: result.timeframe as string,
        };
      }
      if (input.runId != null) {
        const run = await this.storage.getRun(input.runId);
        if (!run || run.userId !== ctx.walletAddress) {
          throw new ToolkitError("not_found", `Run ${input.runId} not found.`, false);
        }
        return {
          source: run,
          sourceRunId: input.runId,
          seedParams: undefined as Record<string, unknown> | undefined,
          seedTicker: undefined as string | undefined,
          seedTimeframe: undefined as string | undefined,
        };
      }
      // The contract's refine() already guards this; belt-and-suspenders.
      throw new ToolkitError("invalid_input", "Provide a runId or a resultId to refine.", false);
    })();
    const { source, sourceRunId, seedParams, seedTicker, seedTimeframe } = resolved;
    const seeded = seedParams != null;

    const strategy = source.strategyId != null ? await this.storage.getStrategy(source.strategyId) : undefined;
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy for run ${sourceRunId} not found.`, false);
    }
    const parsedInputs = (strategy.parsedInputs as LabPineInput[] | null) ?? [];
    if (parsedInputs.length === 0) {
      throw new ToolkitError("invalid_input", "Strategy has no parameters to refine.", false);
    }
    const srcTickers = Array.isArray(source.tickers) ? (source.tickers as string[]) : [];
    const srcTimeframes = Array.isArray(source.timeframes) ? (source.timeframes as string[]) : [];
    // Seeded mode launches on the SELECTED result's own combo; whole-run mode
    // keeps the source run's first combo (unchanged).
    const ticker = seedTicker ?? srcTickers[0];
    const timeframe = seedTimeframe ?? srcTimeframes[0];
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
    // Holdout-FORWARD: a refine inherits the parent's OOS holdout. If the parent
    // ran with NO holdout, its "best" params were chosen without any out-of-sample
    // validation (overfit-prone), so refining from them would silently propagate an
    // unvalidated result. Reject rather than fabricate a holdout the parent lacked.
    const parentOos = srcConfig?.outOfSampleFraction ?? source.oosFraction ?? null;
    if (parentOos == null || parentOos <= 0) {
      throw new ToolkitError(
        "conflict",
        "Can't refine this run: it ran without an out-of-sample holdout, so its results aren't validated. Start a fresh optimization (which adds a holdout), then refine from that.",
        false,
      );
    }
    const oosFraction = parentOos;
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
      // Refine consumes prior insights + coordinate-tunes. Seeded (per-result)
      // mode is the QUICK hone — deep search OFF — matching the UI's per-row
      // refresh; whole-run mode keeps deep search ON for the heavier pass.
      useInsights: true,
      deepSearch: !seeded,
      coordinateTune: true,
      outOfSampleFraction: oosFraction,
      slippage,
    };
    if (isNative) delete (config as Partial<LabOptimizationConfig>).pineScript;

    // Seeded mode threads the result's EXACT params to the worker the SAME way the
    // UI /refine route does: guidedInsightsPerCombo[combo].topConfigs with a max
    // score so the worker picks it as the coordinate-tune seed. type:"refine" lets
    // pumpQueue force coordinateTune/useInsights while leaving deepSearch:false.
    // Mirror the UI /refine route: pumpQueue reads processOrdersOnClose as a
    // TOP-LEVEL snapshot field (sibling to config) and threads it to the worker's
    // engine. Omitting it would run a process_orders_on_close=true strategy under
    // the wrong Pine fill semantics (close vs next-bar open) — i.e. NOT a faithful
    // mirror of the per-row refresh, and inaccurate results. Applies to BOTH paths.
    const processOrdersOnClose: boolean | undefined = settings.processOrdersOnClose;
    const configSnapshot = seeded
      ? {
          type: "refine",
          config,
          processOrdersOnClose,
          sourceRunId,
          targetTicker: ticker,
          targetTimeframe: timeframe,
          guidedInsightsPerCombo: {
            [`${ticker}|${timeframe}`]: {
              paramSensitivity: [],
              topConfigs: [{ params: seedParams, score: Number.MAX_SAFE_INTEGER }],
            },
          },
        }
      : { type: "new", config, processOrdersOnClose, sourceRunId };

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
        configSnapshot: configSnapshot as any,
        agentTaskId: taskId,
        agentIdempotencyKey: input.idempotencyKey,
        agentCorrelationId: correlationId,
        agentOwned: true,
      }),
    );
    return this.toRunQueued(run, idempotent, correlationId);
  }

  async generateInsights(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"generateInsights">,
  ): Promise<LabAgentToolkitOutput<"generateInsights">> {
    const strategy = await this.storage.getStrategy(input.strategyId);
    if (!strategy || strategy.userId !== ctx.walletAddress) {
      throw new ToolkitError("not_found", `Strategy ${input.strategyId} not found.`, false);
    }
    // Deterministic insights computed from the strategy's existing backtest
    // results — which params actually move net profit, plus a robustness read on
    // the best config. No LLM call, so it costs nothing and never touches the
    // user's key. The LLM-backed `improve` tool consumes this summary downstream.
    const rows = await this.storage.getTopResultsForStrategy(input.strategyId, 50);
    if (rows.length === 0) {
      throw new ToolkitError(
        "conflict",
        "No backtest results yet — run an optimization first, then I can generate insights.",
        false,
      );
    }
    // Describe the most ROBUST config, not the headline curve-fit.
    const best = [...rows].sort((a, b) => rankRow(b) - rankRow(a))[0];
    const paramSensitivity = computeParamSensitivity(rows);
    const oosNote =
      best.oosMetrics && (best.oosMetrics as any).sufficient
        ? "validated out-of-sample"
        : "NOT validated out-of-sample (treat with caution)";
    const parts = [
      `Across ${rows.length} result${rows.length === 1 ? "" : "s"} for "${strategy.name}", the most robust is ` +
        `${best.ticker} ${best.timeframe}: net ${fmtPct(best.netProfitPercent)}, win rate ${fmtPct(best.winRatePercent)}, ` +
        `max drawdown ${fmtPct(best.maxDrawdownPercent)}, profit factor ${fmtNum(best.profitFactor)}, ` +
        `Sharpe ${fmtNum(best.sharpeRatio)} — ${oosNote}.`,
    ];
    if (paramSensitivity.length > 0) {
      parts.push(
        `Net profit is most sensitive to: ${paramSensitivity.slice(0, 3).map((p) => p.param).join(", ")}.`,
      );
    } else {
      parts.push("No single parameter clearly drives net profit across these results.");
    }
    return {
      strategyId: input.strategyId,
      generatedAt: new Date().toISOString(),
      summary: parts.join(" "),
      paramSensitivity: paramSensitivity.length ? paramSensitivity : null,
      directionalBias: null,
    };
  }

  async improve(
    ctx: ToolkitContext,
    input: LabAgentToolkitInput<"improve">,
  ): Promise<LabAgentToolkitOutput<"improve">> {
    const wallet = ctx.walletAddress;
    const taskId = this.requireTaskId(ctx);
    // EARLY idempotent replay: improve pays for an EXPENSIVE LLM pass before it
    // enqueues, so on a /step replay we must short-circuit to the already-queued
    // run BEFORE calling the model again. (A crash STRICTLY between the LLM draft
    // and the enqueue is the one un-deduped gap — rare, and the only alternative is
    // a DB transaction spanning an external LLM call. The common replay path —
    // client re-POSTs /step — is fully covered here.)
    const replay = await this.storage.getAgentRun(wallet, taskId, input.idempotencyKey);
    if (replay) {
      return this.toRunQueued(replay, true, replay.agentCorrelationId ?? "");
    }
    const strategy = await this.storage.getStrategy(input.strategyId);
    if (!strategy || strategy.userId !== wallet) {
      throw new ToolkitError("not_found", `Strategy ${input.strategyId} not found.`, false);
    }
    // Improve must be grounded in real backtest evidence: without results there is
    // nothing to diagnose AND no base run to mirror the new strategy's test against.
    const topRows = await this.storage.getTopResultsForStrategy(input.strategyId, 1);
    if (topRows.length === 0) {
      throw new ToolkitError(
        "conflict",
        "No backtest results yet — run an optimization first so I have something to improve from.",
        false,
      );
    }
    const baseRun = await this.storage.getRun(Number(topRows[0].runId));
    if (!baseRun) {
      throw new ToolkitError("conflict", "The strategy's results have no source run to mirror.", false);
    }
    // BYO-key improvement pass: rewrite the strategy's LOGIC from its weaknesses.
    const improved = await this.withLlmKey(wallet, async (apiKey) => {
      const { improveStrategy } = await import("../ai-assistant/creator");
      return improveStrategy({
        currentPine: strategy.pineScript ?? "",
        insights: input.insightsOrWeaknesses,
        apiKey,
        walletAddress: wallet,
      });
    });
    if (!improved.compileOk) {
      throw new ToolkitError(
        "internal",
        "The AI produced an improved strategy that failed to compile. Try again.",
        true,
      );
    }
    const { parsePineScript } = await import("../lab/pine-parser");
    const parsed = parsePineScript(improved.pineScript);
    if (parsed.inputs.length === 0) {
      throw new ToolkitError("invalid_input", "The improved strategy has no parameters to optimize.", false);
    }
    const newStrategy = await this.storage.createStrategy({
      name: `${strategy.name} (improved)`,
      pineScript: improved.pineScript,
      description: null,
      parsedInputs: parsed.inputs,
      groups: parsed.groups ?? null,
      strategySettings: parsed.strategySettings ?? null,
      userId: wallet,
    });
    // Enqueue a FRESH full optimization for the improved strategy, mirroring the
    // base run's market scope (tickers / timeframes / window) so its results are
    // directly comparable to the original. A fresh random->refine->deep search gets
    // its OWN holdout (default if the base lacked one) — we are NOT propagating the
    // parent's best params, so refine's holdout-forward REJECTION does not apply.
    const srcConfig = recoverRunConfig(baseRun);
    const srcTickers = Array.isArray(baseRun.tickers) ? (baseRun.tickers as string[]) : [];
    const srcTimeframes = Array.isArray(baseRun.timeframes) ? (baseRun.timeframes as string[]) : [];
    const tickers = srcConfig?.tickers?.length ? srcConfig.tickers : srcTickers;
    const timeframes = srcConfig?.timeframes?.length ? srcConfig.timeframes : srcTimeframes;
    if (tickers.length === 0 || timeframes.length === 0) {
      throw new ToolkitError("conflict", "The base run has no market scope to mirror.", false);
    }
    // The improved strategy's fresh run MUST be validated out-of-sample. A base run
    // with NO holdout (null OR 0) must not propagate that gap — fall back to the
    // default so robustness can never be silently lost (mirrors refineFrom's rule).
    const recoveredOos = srcConfig?.outOfSampleFraction ?? baseRun.oosFraction ?? null;
    const oosFraction = recoveredOos != null && recoveredOos > 0 ? recoveredOos : DEFAULT_AGENT_OOS_FRACTION;
    const slippage = srcConfig?.slippage ?? baseRun.slippage ?? DEFAULT_LAB_SLIPPAGE;
    const startDate = srcConfig?.startDate ?? baseRun.startDate ?? isoDaysAgo(365);
    const endDate = srcConfig?.endDate ?? baseRun.endDate ?? isoDaysAgo(0);
    const randomSamples = srcConfig?.randomSamples ?? baseRun.randomSamples ?? LAB_RANDOM_SAMPLES;
    const topK = srcConfig?.topK ?? baseRun.topK ?? LAB_TOPK;
    const refinementsPerSeed = srcConfig?.refinementsPerSeed ?? baseRun.refinementsPerSeed ?? LAB_REFINEMENTS_PER_SEED;
    const minTrades = srcConfig?.minTrades ?? baseRun.minTrades ?? LAB_MIN_TRADES;
    const maxDrawdownCap = srcConfig?.maxDrawdownCap ?? baseRun.maxDrawdownCap ?? LAB_MAX_DRAWDOWN_CAP;

    const config: LabOptimizationConfig = {
      pineScript: improved.pineScript,
      parsedInputs: parsed.inputs,
      tickers,
      timeframes,
      startDate,
      endDate,
      randomSamples,
      topK,
      refinementsPerSeed,
      minTrades,
      maxDrawdownCap,
      minAvgBarsHeld: srcConfig?.minAvgBarsHeld ?? LAB_MIN_AVG_BARS_HELD,
      mode: "sweep",
      strategyId: newStrategy.id,
      // Improved strategies are interpreter (Pine) engines — never native — so the
      // stored pine script IS the source of truth; no engineType.
      engineType: undefined,
      useInsights: false,
      deepSearch: true,
      coordinateTune: true,
      outOfSampleFraction: oosFraction,
      slippage,
    };

    const { run, idempotent, correlationId } = await this.idempotentEnqueue(
      ctx,
      taskId,
      input.idempotencyKey,
      ({ correlationId, queueOrder }) => ({
        strategyId: newStrategy.id,
        userId: wallet,
        tickers,
        timeframes,
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
        configSnapshot: {
          type: "new",
          config,
          improvedFromStrategyId: input.strategyId,
          baseRunId: baseRun.id,
        } as any,
        agentTaskId: taskId,
        agentIdempotencyKey: input.idempotencyKey,
        agentCorrelationId: correlationId,
        agentOwned: true,
      }),
    );
    return this.toRunQueued(run, idempotent, correlationId);
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
    // Max-queued leash (Task #200): refuse a NEW enqueue once this task already has
    // MAX_QUEUED_AGENT_BACKTESTS non-terminal runs in flight. Checked AFTER the
    // idempotent early-return so a /step replay of an already-counted run is never
    // blocked. Counted from the DB so it survives crash/replay and a desynced planner
    // tally. Retryable:false — capacity won't free up by re-issuing the same call.
    const taskRuns = await this.storage.getAgentRunsForTask(ctx.walletAddress, taskId);
    const inFlight = taskRuns.filter((r) => ACTIVE_AGENT_RUN_STATUSES.has(r.status)).length;
    if (inFlight >= MAX_QUEUED_AGENT_BACKTESTS) {
      throw new ToolkitError(
        "conflict",
        `This task already has ${inFlight} backtests in flight (max ${MAX_QUEUED_AGENT_BACKTESTS}). ` +
          "Let them finish before queueing another.",
        false,
      );
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
  resolveLlmKey?: (wallet: string) => Promise<Buffer | null>,
): LabAgentAdapter {
  return new CurrentLabAdapter(storage, onRunQueued, resolveLlmKey);
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
