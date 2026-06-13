// QuantumLab Sandbox Agent — current-lab adapter (Phase A, T4).
//
// The ONLY module coupled to today's lab plumbing. It implements the toolkit
// adapter seam by reading the live lab storage and translating rows through the
// T3 DTO mappers; the harness then re-validates every result against the
// contract. Swapping the lab implementation later means writing a sibling
// adapter — the harness and the contract stay put.
//
// Phase A scope (docs/LAB_AGENT_SANDBOX_PLAN.md): the deterministic READ surface
// is fully wired. The following return a typed `not_implemented` for honesty:
//   - listTemplates / createStrategyFromTemplate — no template registry exists yet;
//   - getHeatmap — the lab's heatmap is a strategy-level ticker×timeframe grid,
//     NOT the per-run x/y-parameter sweep this contract defines; faking axes
//     would be dishonest;
//   - runOptimization / refineFrom / cancelRun — control tools land in T5;
//   - createStrategyFromText / improve / generateInsights — LLM-backed, later phase.
//
// Live job progress lives only in the lab CHILD process, so this main-process
// adapter reads run state from the DB run row + checkpoint (the §7b "DB is the
// source of truth" stance). progressPct is null when no live job is visible.

import type { ILabStorage } from "../lab/storage";
import type { LabOptResult } from "@shared/schema";
import type {
  LabAgentToolkitInput,
  LabAgentToolkitOutput,
  StrategyDto,
} from "@shared/lab-agent-contract";
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
>;

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
  constructor(private readonly storage: AdapterStorage) {}

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
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"runOptimization">,
  ): Promise<LabAgentToolkitOutput<"runOptimization">> {
    throw new ToolkitError("not_implemented", "Optimization runs are wired in a later step (Phase A T5).", false);
  }

  async refineFrom(
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"refineFrom">,
  ): Promise<LabAgentToolkitOutput<"refineFrom">> {
    throw new ToolkitError("not_implemented", "Refinement runs are wired in a later step (Phase A T5).", false);
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
    _ctx: ToolkitContext,
    _input: LabAgentToolkitInput<"cancelRun">,
  ): Promise<LabAgentToolkitOutput<"cancelRun">> {
    throw new ToolkitError("not_implemented", "Run cancellation is wired in a later step (Phase A T5).", false);
  }
}

/** Build a toolkit adapter over an explicit storage (used in tests + wiring). */
export function createCurrentLabAdapter(storage: AdapterStorage): LabAgentAdapter {
  return new CurrentLabAdapter(storage);
}

/**
 * Production binding to the live lab storage singleton. The import is lazy so
 * that merely importing this module has no DB side effects until the toolkit is
 * actually wired into the running server (keeps Phase A dormant).
 */
export async function createLiveLabAgentToolkit(): Promise<LabAgentToolkit> {
  const { labStorage } = await import("../lab/storage");
  return new LabAgentToolkit(createCurrentLabAdapter(labStorage));
}
