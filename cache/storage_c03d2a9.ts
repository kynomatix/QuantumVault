import {
  labStrategies, labOptimizationRuns, labOptimizationResults, labInsightsReports,
  type LabStrategy, type InsertLabStrategy,
  type LabOptimizationRun, type InsertLabRun,
  type LabOptResult, type InsertLabResult,
  type LabBacktestResult, type LabJobProgress, type LabOptimizationConfig, type LabJobResult,
  type LabCheckpoint, type LabInsightsReport,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, inArray, isNull, and, or, asc, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

const MAX_CONCURRENT_JOBS = 1;

export interface LabJob {
  id: string;
  config: LabOptimizationConfig;
  progress: LabJobProgress;
  results: LabBacktestResult[];
  abortSignal: { aborted: boolean };
  listeners: Set<(progress: LabJobProgress) => void>;
  runId?: number;
  walletAddress?: string;
  lastUpdated: number;
}

export interface ILabStorage {
  createStrategy(data: InsertLabStrategy): Promise<LabStrategy>;
  getStrategies(walletAddress?: string): Promise<LabStrategy[]>;
  getStrategy(id: number): Promise<LabStrategy | undefined>;
  updateStrategy(id: number, data: Partial<InsertLabStrategy>): Promise<LabStrategy | undefined>;
  deleteStrategy(id: number): Promise<void>;

  createRun(data: InsertLabRun): Promise<LabOptimizationRun>;
  getRuns(strategyId?: number): Promise<LabOptimizationRun[]>;
  getRun(id: number): Promise<LabOptimizationRun | undefined>;
  completeRun(id: number, totalConfigsTested: number): Promise<void>;
  finalizeSuccessfulRun(id: number, totalConfigsTested: number, checkpoint: LabCheckpoint): Promise<void>;
  failRun(id: number): Promise<void>;
  pauseRun(id: number): Promise<void>;
  resumeRun(id: number): Promise<void>;
  deleteRun(id: number): Promise<void>;
  deleteResult(resultId: number): Promise<void>;
  clearStrategyResults(strategyId: number): Promise<number>;
  saveCheckpoint(runId: number, checkpoint: LabCheckpoint): Promise<void>;
  getCheckpoint(runId: number): Promise<LabCheckpoint | null>;

  saveResults(runId: number, results: LabBacktestResult[]): Promise<void>;
  saveComboResults(runId: number, results: LabBacktestResult[], isPartial?: boolean): Promise<void>;
  getRunResults(runId: number): Promise<LabOptResult[]>;
  getResult(resultId: number): Promise<LabOptResult | undefined>;
  getAllResultsForStrategy(strategyId: number): Promise<{ strategy: LabStrategy | undefined; totalRuns: number; totalResults: number; results: LabOptResult[] }>;

  createJob(config: LabOptimizationConfig, options?: { forRunId?: number; hasActiveWorker?: boolean }): LabJob;
  getJob(id: string): LabJob | undefined;
  forceEvictAllJobs(): number;
  forceEvictJobsByWallet(walletAddress: string): number;
  getJobByRunId(runId: number): LabJob | undefined;
  updateProgress(id: string, progress: LabJobProgress): void;
  setResults(id: string, results: LabBacktestResult[]): void;
  getJobResult(id: string): LabJobResult | undefined;
  cancelJob(id: string): void;

  saveInsightsReport(strategyId: number, reportData: any, totalResults: number, totalRuns: number): Promise<LabInsightsReport>;
  getLatestInsightsReport(strategyId: number): Promise<LabInsightsReport | undefined>;
  getInsightsReports(strategyId: number): Promise<LabInsightsReport[]>;

  getTopResultsForStrategy(strategyId: number, limit?: number): Promise<any[]>;

  getQueuedRuns(walletAddress: string): Promise<LabOptimizationRun[]>;
  getNextQueueOrder(walletAddress: string): Promise<number>;
  reorderQueue(walletAddress: string, orderedIds: number[]): Promise<void>;
  cancelQueuedRun(id: number, walletAddress: string): Promise<boolean>;
  claimNextQueuedRun(walletAddress?: string): Promise<LabOptimizationRun | null>;
  hasActiveRun(walletAddress?: string): Promise<boolean>;
  hasActiveOrPausedRun(): Promise<boolean>;
  getHeatmapBulkResults(walletAddress: string): Promise<{ runId: number; strategyId: number; resultId: number; ticker: string; timeframe: string; netProfitPercent: number; winRatePercent: number; maxDrawdownPercent: number; profitFactor: number; totalTrades: number; params: any }[]>;
  getHeatmapCells(walletAddress: string): Promise<{ cells: any[]; runsTotal: number }>;
  getCompletedRunCount(walletAddress: string): Promise<number>;
  deduplicateStrategyResults(strategyId: number): Promise<number>;
}

export class LabDatabaseStorage implements ILabStorage {
  private jobs: Map<string, LabJob>;
  public interruptedRunIds: number[] = [];

  constructor() {
    this.jobs = new Map();
    this.backfillOwnership().then(() => this.cleanupStaleRuns());
  }

  private async backfillOwnership(): Promise<void> {
    const DEFAULT_OWNER = "BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41";
    try {
      const unownedStrategies = await db.select({ id: labStrategies.id })
        .from(labStrategies).where(isNull(labStrategies.userId));
      if (unownedStrategies.length > 0) {
        await db.update(labStrategies).set({ userId: DEFAULT_OWNER }).where(isNull(labStrategies.userId));
        console.log(`[QuantumLab] Backfill: assigned ${unownedStrategies.length} unowned strategies to ${DEFAULT_OWNER.slice(0, 8)}...`);
      }
      const unownedRuns = await db.select({ id: labOptimizationRuns.id })
        .from(labOptimizationRuns).where(isNull(labOptimizationRuns.userId));
      if (unownedRuns.length > 0) {
        await db.update(labOptimizationRuns).set({ userId: DEFAULT_OWNER }).where(isNull(labOptimizationRuns.userId));
        console.log(`[QuantumLab] Backfill: assigned ${unownedRuns.length} unowned runs to ${DEFAULT_OWNER.slice(0, 8)}...`);
      }
    } catch (err: any) {
      console.log(`[QuantumLab] Ownership backfill error: ${err.message}`);
    }
  }

  private async cleanupStaleRuns(): Promise<void> {
    try {
      const staleRuns = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.status, "running"));
      for (const run of staleRuns) {
        const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
        const hasComboCheckpoint = cp?.completedCombos?.length > 0;
        const hasMidComboCheckpoint = cp?.currentCombo && cp?.currentIteration != null && cp.currentIteration >= 0;
        const hasAnyCheckpoint = hasComboCheckpoint || hasMidComboCheckpoint;

        const savedResults = await db.select({ id: labOptimizationResults.id })
          .from(labOptimizationResults)
          .where(eq(labOptimizationResults.runId, run.id))
          .limit(1);
        const hasPersistedResults = savedResults.length > 0;

        const hasConfigSnapshot = !!cp?.configSnapshot;
        const canResume = hasAnyCheckpoint || hasPersistedResults || hasConfigSnapshot;
        const newStatus = canResume ? "paused" : "failed";
        await db.update(labOptimizationRuns).set({
          status: newStatus,
          ...(!canResume ? { completedAt: new Date() } : {}),
        }).where(eq(labOptimizationRuns.id, run.id));

        const detail = hasComboCheckpoint
          ? `${cp.completedCombos.length} combos checkpointed`
          : hasMidComboCheckpoint
            ? `mid-combo ${cp.currentCombo} at ${cp.currentStage} iter ${cp.currentIteration}`
            : hasPersistedResults
              ? `has persisted results in DB`
              : hasConfigSnapshot
                ? `config snapshot only (no progress)`
                : "";
        console.log(`[QuantumLab] Stale run ${run.id} → ${newStatus}${detail ? ` (${detail})` : ""}`);
        if (canResume) {
          this.interruptedRunIds.push(run.id);
        }
      }
      if (staleRuns.length > 0) {
        console.log(`[QuantumLab] Processed ${staleRuns.length} stale run(s) from previous session`);
      }

      const failedRuns = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.status, "failed"));
      let recovered = 0;
      for (const run of failedRuns) {
        const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
        const hasCheckpoint = cp?.completedCombos?.length > 0 || (cp?.currentCombo && cp?.currentIteration != null);
        const hasConfigSnapshot = !!cp?.configSnapshot;
        const savedResults = await db.select({ id: labOptimizationResults.id })
          .from(labOptimizationResults)
          .where(eq(labOptimizationResults.runId, run.id))
          .limit(1);
        if (hasCheckpoint || savedResults.length > 0 || hasConfigSnapshot) {
          await db.update(labOptimizationRuns).set({
            status: "paused",
            completedAt: null,
          }).where(eq(labOptimizationRuns.id, run.id));
          const reason = hasCheckpoint ? "checkpoint" : savedResults.length > 0 ? "results" : "config snapshot";
          console.log(`[QuantumLab] Recovered failed run ${run.id} → paused (has ${reason})`);
          this.interruptedRunIds.push(run.id);
          recovered++;
        }
      }
      if (recovered > 0) {
        console.log(`[QuantumLab] Recovered ${recovered} failed run(s) with salvageable data`);
      }
    } catch (err: any) {
      console.log(`[QuantumLab] Stale run cleanup error: ${err.message}`);
    }
  }

  async createStrategy(data: InsertLabStrategy): Promise<LabStrategy> {
    const [strategy] = await db.insert(labStrategies).values(data).returning();
    return strategy;
  }

  async getStrategies(walletAddress?: string): Promise<LabStrategy[]> {
    if (walletAddress) {
      return db.select().from(labStrategies)
        .where(eq(labStrategies.userId, walletAddress))
        .orderBy(desc(labStrategies.createdAt));
    }
    return db.select().from(labStrategies).orderBy(desc(labStrategies.createdAt));
  }

  async getStrategy(id: number): Promise<LabStrategy | undefined> {
    const [strategy] = await db.select().from(labStrategies).where(eq(labStrategies.id, id));
    return strategy;
  }

  async updateStrategy(id: number, data: Partial<InsertLabStrategy>): Promise<LabStrategy | undefined> {
    const [strategy] = await db.update(labStrategies).set(data).where(eq(labStrategies.id, id)).returning();
    return strategy;
  }

  async deleteStrategy(id: number): Promise<void> {
    await db.delete(labStrategies).where(eq(labStrategies.id, id));
  }

  async createRun(data: InsertLabRun): Promise<LabOptimizationRun> {
    const [run] = await db.insert(labOptimizationRuns).values(data).returning();
    return run;
  }

  async getRuns(strategyId?: number, userId?: string): Promise<LabOptimizationRun[]> {
    const conditions = [];
    if (strategyId) conditions.push(eq(labOptimizationRuns.strategyId, strategyId));
    if (userId) conditions.push(eq(labOptimizationRuns.userId, userId));
    if (conditions.length > 0) {
      return db.select().from(labOptimizationRuns).where(and(...conditions)).orderBy(desc(labOptimizationRuns.createdAt));
    }
    return db.select().from(labOptimizationRuns).orderBy(desc(labOptimizationRuns.createdAt));
  }

  async getRun(id: number): Promise<LabOptimizationRun | undefined> {
    const [run] = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.id, id));
    return run;
  }

  async completeRun(id: number, totalConfigsTested: number): Promise<void> {
    await db.update(labOptimizationRuns).set({
      status: "complete",
      totalConfigsTested,
      completedAt: new Date(),
    }).where(eq(labOptimizationRuns.id, id));
  }

  async finalizeSuccessfulRun(id: number, totalConfigsTested: number, checkpoint: LabCheckpoint): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.update(labOptimizationRuns).set({
        status: "complete",
        totalConfigsTested,
        completedAt: new Date(),
      }).where(eq(labOptimizationRuns.id, id));
      await tx.update(labOptimizationRuns).set({
        checkpoint: checkpoint as any,
      }).where(eq(labOptimizationRuns.id, id));
    });
  }

  async failRun(id: number): Promise<void> {
    const savedResults = await db.select({ id: labOptimizationResults.id })
      .from(labOptimizationResults)
      .where(eq(labOptimizationResults.runId, id))
      .limit(1);
    if (savedResults.length > 0) {
      await db.update(labOptimizationRuns).set({
        status: "paused",
      }).where(eq(labOptimizationRuns.id, id));
      console.log(`[QuantumLab] failRun(${id}) → paused instead (has saved results)`);
      return;
    }
    const [run] = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.id, id));
    if (run) {
      const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
      if (cp?.completedCombos?.length > 0 || (cp?.currentCombo && cp?.currentIteration != null)) {
        await db.update(labOptimizationRuns).set({
          status: "paused",
        }).where(eq(labOptimizationRuns.id, id));
        console.log(`[QuantumLab] failRun(${id}) → paused instead (has checkpoint)`);
        return;
      }
    }
    await db.update(labOptimizationRuns).set({
      status: "failed",
      completedAt: new Date(),
    }).where(eq(labOptimizationRuns.id, id));
  }

  async pauseRun(id: number): Promise<void> {
    await db.update(labOptimizationRuns).set({
      status: "paused",
    }).where(eq(labOptimizationRuns.id, id));
  }

  async resumeRun(id: number): Promise<void> {
    await db.update(labOptimizationRuns).set({
      status: "running",
    }).where(eq(labOptimizationRuns.id, id));
  }

  async saveCheckpoint(runId: number, checkpoint: LabCheckpoint): Promise<void> {
    await db.update(labOptimizationRuns).set({
      checkpoint: checkpoint as any,
    }).where(eq(labOptimizationRuns.id, runId));
  }

  async getCheckpoint(runId: number): Promise<LabCheckpoint | null> {
    const [run] = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.id, runId));
    if (!run?.checkpoint) return null;
    return run.checkpoint as unknown as LabCheckpoint;
  }

  async deleteRun(id: number): Promise<void> {
    await db.delete(labOptimizationResults).where(eq(labOptimizationResults.runId, id));
    await db.delete(labOptimizationRuns).where(eq(labOptimizationRuns.id, id));
  }

  async deleteResult(resultId: number): Promise<void> {
    await db.delete(labOptimizationResults).where(eq(labOptimizationResults.id, resultId));
  }

  async clearStrategyResults(strategyId: number): Promise<number> {
    const runs = await db.select({ id: labOptimizationRuns.id })
      .from(labOptimizationRuns)
      .where(eq(labOptimizationRuns.strategyId, strategyId));
    if (runs.length === 0) return 0;
    const runIds = runs.map(r => r.id);
    await db.transaction(async (tx) => {
      await tx.delete(labOptimizationResults).where(inArray(labOptimizationResults.runId, runIds));
      await tx.delete(labOptimizationRuns).where(inArray(labOptimizationRuns.id, runIds));
      await tx.delete(labInsightsReports).where(eq(labInsightsReports.strategyId, strategyId));
    });
    return runs.length;
  }

  async saveResults(runId: number, results: LabBacktestResult[]): Promise<void> {
    if (results.length === 0) return;
    const insertData: InsertLabResult[] = results.map((r, idx) => ({
      runId,
      ticker: r.ticker,
      timeframe: r.timeframe,
      rank: idx + 1,
      netProfitPercent: r.netProfitPercent,
      winRatePercent: r.winRatePercent,
      maxDrawdownPercent: r.maxDrawdownPercent,
      profitFactor: r.profitFactor,
      totalTrades: r.totalTrades,
      params: r.params,
      trades: r.trades,
      equityCurve: r.equityCurve,
    }));

    const batchSize = 50;
    for (let i = 0; i < insertData.length; i += batchSize) {
      const batch = insertData.slice(i, i + batchSize);
      await db.insert(labOptimizationResults).values(batch);
    }
  }

  async saveComboResults(runId: number, results: LabBacktestResult[], isPartial = false): Promise<void> {
    if (results.length === 0) return;
    const combo = results[0];
    const comboKey = `${combo.ticker}|${combo.timeframe}`;

    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: labOptimizationResults.id, ticker: labOptimizationResults.ticker, timeframe: labOptimizationResults.timeframe })
        .from(labOptimizationResults)
        .where(eq(labOptimizationResults.runId, runId));
      const existingForCombo = existing.filter(r => `${r.ticker}|${r.timeframe}` === comboKey);

      if (existingForCombo.length > 0) {
        const idsToDelete = existingForCombo.map(r => r.id);
        await tx.delete(labOptimizationResults).where(inArray(labOptimizationResults.id, idsToDelete));
        console.log(`[QuantumLab] Combo ${comboKey} run ${runId}: ${isPartial ? "updating" : "replaced"} ${idsToDelete.length} ${isPartial ? "partial" : ""} results with ${results.length} ${isPartial ? "partial" : "final"} results`);
      }

      const otherCount = existing.length - existingForCombo.length;
      const startRank = otherCount + 1;
      const insertData: InsertLabResult[] = results.map((r, idx) => ({
        runId,
        ticker: r.ticker,
        timeframe: r.timeframe,
        rank: startRank + idx,
        netProfitPercent: r.netProfitPercent,
        winRatePercent: r.winRatePercent,
        maxDrawdownPercent: r.maxDrawdownPercent,
        profitFactor: r.profitFactor,
        totalTrades: r.totalTrades,
        params: r.params,
        trades: r.trades,
        equityCurve: r.equityCurve,
      }));

      const batchSize = 50;
      for (let i = 0; i < insertData.length; i += batchSize) {
        const batch = insertData.slice(i, i + batchSize);
        await tx.insert(labOptimizationResults).values(batch);
      }
    });
  }

  async getRunResults(runId: number): Promise<LabOptResult[]> {
    return db.select().from(labOptimizationResults).where(eq(labOptimizationResults.runId, runId)).orderBy(labOptimizationResults.rank);
  }

  async getResult(resultId: number): Promise<LabOptResult | undefined> {
    const rows = await db.select().from(labOptimizationResults).where(eq(labOptimizationResults.id, resultId)).limit(1);
    return rows[0];
  }

  async getAllResultsForStrategy(strategyId: number): Promise<{ strategy: LabStrategy | undefined; totalRuns: number; totalResults: number; results: LabOptResult[] }> {
    const strategy = await this.getStrategy(strategyId);
    const runs = await db.select().from(labOptimizationRuns)
      .where(eq(labOptimizationRuns.strategyId, strategyId));
    const completedRuns = runs.filter(r => r.status === "complete" || r.status === "paused");
    if (completedRuns.length === 0) {
      return { strategy, totalRuns: 0, totalResults: 0, results: [] };
    }
    const runIds = completedRuns.map(r => r.id);
    const results = await db.select().from(labOptimizationResults)
      .where(inArray(labOptimizationResults.runId, runIds))
      .orderBy(labOptimizationResults.runId, labOptimizationResults.rank);
    return { strategy, totalRuns: completedRuns.length, totalResults: results.length, results };
  }

  createJob(config: LabOptimizationConfig, options?: { forRunId?: number; hasActiveWorker?: boolean }): LabJob {
    const STALE_TIMEOUT_MS = 5 * 60 * 1000;
    const now = Date.now();
    const forRunId = options?.forRunId;
    const hasActiveWorker = options?.hasActiveWorker ?? false;

    if (forRunId) {
      const existingJob = this.getJobByRunId(forRunId);
      if (existingJob && existingJob.progress.status !== "complete" && existingJob.progress.status !== "error") {
        console.log(`[QuantumLab] Reusing existing job ${existingJob.id} for run ${forRunId}`);
        return existingJob;
      }
    }

    const activeJobs = Array.from(this.jobs.values()).filter(
      (j) => j.progress.status !== "complete" && j.progress.status !== "error"
    );
    for (const staleJob of activeJobs) {
      const isStaleByTime = now - staleJob.lastUpdated > STALE_TIMEOUT_MS;
      const isOrphanedJob = !hasActiveWorker && staleJob.progress.status !== "fetching";
      if (isStaleByTime || isOrphanedJob) {
        const reason = isStaleByTime
          ? `stale (last updated ${Math.round((now - staleJob.lastUpdated) / 1000)}s ago)`
          : `orphaned (no active worker, status: ${staleJob.progress.status})`;
        console.log(`[QuantumLab] Evicting ${reason} job ${staleJob.id}`);
        staleJob.progress.status = "error";
        staleJob.progress.stage = `Evicted: ${reason}`;
        this.scheduleCleanup(staleJob.id, "error");
      }
    }
    const reallyActive = Array.from(this.jobs.values()).filter(
      (j) => j.progress.status !== "complete" && j.progress.status !== "error"
    );
    if (reallyActive.length >= MAX_CONCURRENT_JOBS) {
      const blockingJob = reallyActive[0];
      const err = new Error(`Maximum concurrent jobs limit reached (${MAX_CONCURRENT_JOBS}). Please wait for the current job to finish.`);
      (err as any).blockingJobId = blockingJob.id;
      (err as any).blockingRunId = blockingJob.runId;
      throw err;
    }

    const id = randomUUID();
    const job: LabJob = {
      id,
      config,
      progress: {
        jobId: id,
        status: "fetching",
        stage: "Initializing...",
        current: 0,
        total: 0,
        percent: 0,
        elapsed: 0,
      },
      results: [],
      abortSignal: { aborted: false },
      listeners: new Set(),
      lastUpdated: now,
    };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id: string): LabJob | undefined {
    return this.jobs.get(id);
  }

  forceEvictAllJobs(): number {
    let evicted = 0;
    for (const [id, job] of Array.from(this.jobs.entries())) {
      if (job.progress.status !== "complete" && job.progress.status !== "error") {
        console.log(`[QuantumLab] Force-evicting job ${id} (status: ${job.progress.status})`);
        job.progress.status = "error";
        job.progress.stage = "Force-evicted by admin";
        this.scheduleCleanup(id, "error");
        evicted++;
      }
    }
    return evicted;
  }

  forceEvictJobsByWallet(walletAddress: string): number {
    let evicted = 0;
    for (const [id, job] of Array.from(this.jobs.entries())) {
      if (job.progress.status !== "complete" && job.progress.status !== "error" && job.walletAddress === walletAddress) {
        console.log(`[QuantumLab] Force-evicting job ${id} for wallet ${walletAddress}`);
        job.progress.status = "error";
        job.progress.stage = "Force-evicted by user";
        this.scheduleCleanup(id, "error");
        evicted++;
      }
    }
    return evicted;
  }

  getJobByRunId(runId: number): LabJob | undefined {
    for (const job of Array.from(this.jobs.values())) {
      if (job.runId === runId) return job;
    }
    return undefined;
  }

  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleCleanup(id: string, status?: string): void {
    if (this.cleanupTimers.has(id)) {
      clearTimeout(this.cleanupTimers.get(id)!);
      this.cleanupTimers.delete(id);
    }
    const ttl = status === "complete" ? 30_000 : status === "error" ? 15_000 : 30_000;
    const timer = setTimeout(() => {
      this.jobs.delete(id);
      this.cleanupTimers.delete(id);
    }, ttl);
    this.cleanupTimers.set(id, timer);
  }

  updateProgress(id: string, progress: LabJobProgress): void {
    const job = this.jobs.get(id);
    if (job) {
      job.progress = progress;
      job.lastUpdated = Date.now();
      for (const listener of Array.from(job.listeners)) {
        try { listener(progress); } catch {}
      }
      if (progress.status === "complete" || progress.status === "error") {
        this.scheduleCleanup(id, progress.status);
      }
    }
  }

  setResults(id: string, results: LabBacktestResult[]): void {
    const job = this.jobs.get(id);
    if (job) {
      job.results = results;
    }
  }

  getJobResult(id: string): LabJobResult | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const isFinished = job.progress.status === "complete" || job.progress.status === "error";
    if (job.results.length === 0 && !isFinished) return undefined;

    const bestByCombo: Record<string, LabBacktestResult[]> = {};
    for (const result of job.results) {
      const key = `${result.ticker}|${result.timeframe}`;
      if (!bestByCombo[key]) bestByCombo[key] = [];
      bestByCombo[key].push(result);
    }

    const deepRounds = job.config.deepSearch ? 3 : 0;
    const deepSeedsPerRound = job.config.topK;
    const deepRefinesPerSeed = job.config.refinementsPerSeed;
    const totalSamples = job.config.randomSamples + job.config.topK * job.config.refinementsPerSeed + deepRounds * deepSeedsPerRound * deepRefinesPerSeed;
    const combos = job.config.tickers.length * job.config.timeframes.length;

    return {
      jobId: id,
      runId: job.runId,
      configs: job.results,
      totalConfigsTested: totalSamples * combos,
      bestByCombo,
    };
  }

  cancelJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.abortSignal.aborted = true;
      const cancelProgress: LabJobProgress = {
        ...job.progress,
        status: "error",
        stage: "Cancelled by user",
        error: "Cancelled",
      };
      job.progress = cancelProgress;
      for (const listener of Array.from(job.listeners)) {
        try { listener(cancelProgress); } catch {}
      }
      if (job.runId) {
        this.getCheckpoint(job.runId).then(checkpoint => {
          if (checkpoint && (checkpoint.completedCombos?.length > 0 || (checkpoint.currentCombo && checkpoint.currentIteration != null && checkpoint.currentIteration >= 0))) {
            this.pauseRun(job.runId!).catch(() => {});
            console.log(`[QuantumLab] Job ${id} cancelled with checkpoint → paused`);
          } else {
            this.failRun(job.runId!).catch(() => {});
          }
        }).catch(() => {
          this.failRun(job.runId!).catch(() => {});
        });
      }
      this.scheduleCleanup(id, "error");
    }
  }

  async saveInsightsReport(strategyId: number, reportData: any, totalResults: number, totalRuns: number): Promise<LabInsightsReport> {
    const [report] = await db.insert(labInsightsReports).values({
      strategyId,
      reportData,
      totalResults,
      totalRuns,
    }).returning();
    return report;
  }

  async getLatestInsightsReport(strategyId: number): Promise<LabInsightsReport | undefined> {
    const [report] = await db.select().from(labInsightsReports)
      .where(eq(labInsightsReports.strategyId, strategyId))
      .orderBy(desc(labInsightsReports.createdAt))
      .limit(1);
    return report;
  }

  async getInsightsReports(strategyId: number): Promise<LabInsightsReport[]> {
    return db.select().from(labInsightsReports)
      .where(eq(labInsightsReports.strategyId, strategyId))
      .orderBy(desc(labInsightsReports.createdAt));
  }

  async getTopResultsForStrategy(strategyId: number, limit = 10): Promise<any[]> {
    const runs = await db.select({ id: labOptimizationRuns.id, status: labOptimizationRuns.status }).from(labOptimizationRuns)
      .where(eq(labOptimizationRuns.strategyId, strategyId));
    const completedRuns = runs.filter(r => r.status === "complete" || r.status === "paused").map(r => r.id);
    if (completedRuns.length === 0) return [];
    const results = await db.select({
      id: labOptimizationResults.id,
      runId: labOptimizationResults.runId,
      rank: labOptimizationResults.rank,
      ticker: labOptimizationResults.ticker,
      timeframe: labOptimizationResults.timeframe,
      netProfitPercent: labOptimizationResults.netProfitPercent,
      winRatePercent: labOptimizationResults.winRatePercent,
      maxDrawdownPercent: labOptimizationResults.maxDrawdownPercent,
      profitFactor: labOptimizationResults.profitFactor,
      totalTrades: labOptimizationResults.totalTrades,
      params: labOptimizationResults.params,
    }).from(labOptimizationResults)
      .where(inArray(labOptimizationResults.runId, completedRuns))
      .orderBy(desc(labOptimizationResults.netProfitPercent));
    const withLev = results.map(r => {
      const dd = r.maxDrawdownPercent;
      const lev = dd > 0 ? Math.min(20, Math.max(1, Math.floor((100 / dd) * 0.8))) : 1;
      return { ...r, _levProfit: r.netProfitPercent * lev, _lev: lev };
    });
    withLev.sort((a, b) => b._levProfit - a._levProfit);
    const bestPerCombo = new Map<string, typeof withLev[0]>();
    for (const r of withLev) {
      const key = `${r.ticker}|${r.timeframe}`;
      if (!bestPerCombo.has(key)) bestPerCombo.set(key, r);
    }
    const deduped = Array.from(bestPerCombo.values());
    deduped.sort((a, b) => b._levProfit - a._levProfit);
    return deduped.slice(0, limit).map(r => ({
      id: r.id,
      runId: r.runId,
      rank: r.rank,
      ticker: r.ticker,
      timeframe: r.timeframe,
      netProfitPercent: r.netProfitPercent,
      winRatePercent: r.winRatePercent,
      maxDrawdownPercent: r.maxDrawdownPercent,
      profitFactor: r.profitFactor,
      totalTrades: r.totalTrades,
      params: r.params,
      levProfit: r._levProfit,
      leverage: r._lev,
    }));
  }
  async getQueuedRuns(walletAddress: string): Promise<LabOptimizationRun[]> {
    return db.select().from(labOptimizationRuns)
      .where(and(eq(labOptimizationRuns.status, "queued"), eq(labOptimizationRuns.userId, walletAddress))!)
      .orderBy(asc(labOptimizationRuns.queueOrder));
  }

  async getNextQueueOrder(_walletAddress?: string): Promise<number> {
    const result = await db.select({ maxOrder: sql<number>`COALESCE(MAX(${labOptimizationRuns.queueOrder}), 0)` })
      .from(labOptimizationRuns)
      .where(eq(labOptimizationRuns.status, "queued"));
    return (result[0]?.maxOrder ?? 0) + 1;
  }

  async reorderQueue(walletAddress: string, orderedIds: number[]): Promise<void> {
    const queued = await this.getQueuedRuns(walletAddress);
    const queuedIdSet = new Set(queued.map(r => r.id));
    if (orderedIds.length !== queuedIdSet.size) {
      throw new Error(`Must provide all ${queuedIdSet.size} queued run IDs`);
    }
    for (const id of orderedIds) {
      if (!queuedIdSet.has(id)) {
        throw new Error(`Run ${id} is not in the queue or does not belong to this user`);
      }
    }
    const existingOrders = queued.map(r => r.queueOrder ?? 0).sort((a, b) => a - b);
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(labOptimizationRuns)
          .set({ queueOrder: existingOrders[i] })
          .where(eq(labOptimizationRuns.id, orderedIds[i]));
      }
    });
  }

  async cancelQueuedRun(id: number, walletAddress: string): Promise<boolean> {
    const run = await this.getRun(id);
    if (!run) return false;
    if (run.status !== "queued") return false;
    if (run.userId !== walletAddress) return false;
    await db.update(labOptimizationRuns).set({
      status: "failed",
      completedAt: new Date(),
      queueOrder: null,
      configSnapshot: null,
    }).where(eq(labOptimizationRuns.id, id));
    return true;
  }

  async claimNextQueuedRun(walletAddress?: string): Promise<LabOptimizationRun | null> {
    const walletFilter = walletAddress
      ? sql`AND ${labOptimizationRuns.userId} = ${walletAddress}`
      : sql``;

    const result = await db.execute(sql`
      UPDATE ${labOptimizationRuns}
      SET status = 'running', queue_order = NULL
      WHERE id = (
        SELECT q.id FROM ${labOptimizationRuns} q
        WHERE q.status = 'queued' ${walletFilter}
          AND NOT EXISTS (
            SELECT 1 FROM ${labOptimizationRuns} blocker
            WHERE blocker.status IN ('running', 'paused')
          )
        ORDER BY q.queue_order ASC NULLS LAST, q.id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    const rows = result.rows as any[];
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      strategyId: row.strategy_id,
      tickers: row.tickers,
      timeframes: row.timeframes,
      startDate: row.start_date,
      endDate: row.end_date,
      randomSamples: row.random_samples,
      topK: row.top_k,
      refinementsPerSeed: row.refinements_per_seed,
      minTrades: row.min_trades,
      maxDrawdownCap: row.max_drawdown_cap,
      mode: row.mode,
      status: row.status,
      totalConfigsTested: row.total_configs_tested,
      checkpoint: row.checkpoint,
      queueOrder: row.queue_order,
      configSnapshot: row.config_snapshot,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    } as LabOptimizationRun;
  }

  async hasActiveRun(walletAddress?: string): Promise<boolean> {
    const whereClause = walletAddress
      ? and(eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.userId, walletAddress))!
      : eq(labOptimizationRuns.status, "running");
    const rows = await db.select({ id: labOptimizationRuns.id })
      .from(labOptimizationRuns)
      .where(whereClause)
      .limit(1);
    if (rows.length > 0) return true;
    const activeJobs = Array.from(this.jobs.values()).filter(
      (j) => j.progress.status !== "complete" && j.progress.status !== "error"
    );
    return activeJobs.length > 0;
  }

  async hasActiveOrPausedRun(): Promise<boolean> {
    const rows = await db.select({ id: labOptimizationRuns.id })
      .from(labOptimizationRuns)
      .where(or(eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.status, "paused"))!)
      .limit(1);
    if (rows.length > 0) return true;
    const activeJobs = Array.from(this.jobs.values()).filter(
      (j) => j.progress.status !== "complete" && j.progress.status !== "error"
    );
    return activeJobs.length > 0;
  }

  async getHeatmapBulkResults(walletAddress: string): Promise<{ runId: number; strategyId: number; resultId: number; ticker: string; timeframe: string; netProfitPercent: number; winRatePercent: number; maxDrawdownPercent: number; profitFactor: number; totalTrades: number; params: any }[]> {
    const rows = await db.select({
      runId: labOptimizationResults.runId,
      strategyId: labOptimizationRuns.strategyId,
      resultId: labOptimizationResults.id,
      ticker: labOptimizationResults.ticker,
      timeframe: labOptimizationResults.timeframe,
      netProfitPercent: labOptimizationResults.netProfitPercent,
      winRatePercent: labOptimizationResults.winRatePercent,
      maxDrawdownPercent: labOptimizationResults.maxDrawdownPercent,
      profitFactor: labOptimizationResults.profitFactor,
      totalTrades: labOptimizationResults.totalTrades,
      params: labOptimizationResults.params,
    })
    .from(labOptimizationResults)
    .innerJoin(labOptimizationRuns, eq(labOptimizationResults.runId, labOptimizationRuns.id))
    .where(and(
      eq(labOptimizationRuns.userId, walletAddress),
      or(eq(labOptimizationRuns.status, "complete"), eq(labOptimizationRuns.status, "paused"))!
    ));
    return rows;
  }

  async getHeatmapCells(walletAddress: string): Promise<{ cells: any[]; runsTotal: number }> {
    const rows = await db.execute(sql`
      WITH filtered AS (
        SELECT
          r.id AS result_id,
          r.run_id,
          run.strategy_id,
          r.ticker,
          r.timeframe,
          COALESCE(r.net_profit_percent, 0) AS net_profit_percent,
          COALESCE(r.win_rate_percent, 0) AS win_rate_percent,
          COALESCE(r.max_drawdown_percent, 0) AS max_drawdown_percent,
          COALESCE(r.profit_factor, 0) AS profit_factor,
          COALESCE(r.total_trades, 0) AS total_trades,
          r.params
        FROM lab_optimization_results r
        INNER JOIN lab_optimization_runs run ON run.id = r.run_id
        WHERE run.user_id = ${walletAddress}
          AND run.status IN ('complete', 'paused')
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY ticker, timeframe
            ORDER BY net_profit_percent DESC, result_id DESC
          ) AS rn
        FROM filtered
      )
      SELECT
        ticker,
        timeframe,
        COUNT(*)::int AS total_results,
        MAX(net_profit_percent) AS best_profit,
        MAX(win_rate_percent) AS best_win_rate,
        MAX(profit_factor) AS best_pf,
        MIN(max_drawdown_percent) AS lowest_drawdown,
        AVG(net_profit_percent) AS avg_profit,
        AVG(win_rate_percent) AS avg_win_rate,
        AVG(max_drawdown_percent) AS avg_drawdown,
        AVG(profit_factor) AS avg_pf,
        COUNT(DISTINCT run_id)::int AS runs_count,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', result_id,
              'netProfitPercent', net_profit_percent,
              'winRatePercent', win_rate_percent,
              'maxDrawdownPercent', max_drawdown_percent,
              'profitFactor', profit_factor,
              'totalTrades', total_trades,
              'params', params,
              'runId', run_id,
              'strategyId', strategy_id
            ) ORDER BY net_profit_percent DESC, result_id DESC
          ) FILTER (WHERE rn <= 10),
          '[]'::jsonb
        ) AS top_results
      FROM ranked
      GROUP BY ticker, timeframe
    `);

    const runsCountRow = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM lab_optimization_runs
      WHERE user_id = ${walletAddress}
        AND status IN ('complete', 'paused')
    `);
    const runsTotal = Number(runsCountRow.rows[0]?.cnt) || 0;

    const cells = rows.rows.map((row: any) => {
      let topResults = row.top_results;
      if (typeof topResults === 'string') {
        try { topResults = JSON.parse(topResults); } catch { topResults = []; }
      }
      if (!Array.isArray(topResults)) topResults = [];

      return {
        ticker: row.ticker,
        timeframe: row.timeframe,
        totalConfigs: Number(row.total_results) || 0,
        totalResults: Number(row.total_results) || 0,
        bestProfit: Number(row.best_profit) || 0,
        bestWinRate: Number(row.best_win_rate) || 0,
        bestPF: Number(row.best_pf) || 0,
        lowestDrawdown: Number(row.lowest_drawdown) || 0,
        avgProfit: Number(row.avg_profit) || 0,
        avgWinRate: Number(row.avg_win_rate) || 0,
        avgDrawdown: Number(row.avg_drawdown) || 0,
        avgPF: Number(row.avg_pf) || 0,
        runsCount: Number(row.runs_count) || 0,
        allResults: topResults,
      };
    });

    return { cells, runsTotal };
  }

  async getCompletedRunCount(walletAddress: string): Promise<number> {
    const rows = await db.select({ count: sql<number>`count(*)::int` })
      .from(labOptimizationRuns)
      .where(and(
        eq(labOptimizationRuns.userId, walletAddress),
        or(eq(labOptimizationRuns.status, "complete"), eq(labOptimizationRuns.status, "paused"))!
      ));
    return rows[0]?.count ?? 0;
  }

  async deduplicateStrategyResults(strategyId: number): Promise<number> {
    const rows = await db.execute<{ removed: number }>(sql`
      WITH ranked AS (
        SELECT r.id, r.run_id,
               ROW_NUMBER() OVER (
                 PARTITION BY r.ticker, r.timeframe, r.params, run.start_date, run.end_date
                 ORDER BY r.net_profit_percent DESC, r.id DESC
               ) AS rn
        FROM lab_optimization_results r
        JOIN lab_optimization_runs run ON run.id = r.run_id
        WHERE run.strategy_id = ${strategyId}
          AND run.status = 'complete'
      ),
      deleted AS (
        DELETE FROM lab_optimization_results del
        USING ranked, lab_optimization_runs run
        WHERE del.id = ranked.id
          AND ranked.rn > 1
          AND run.id = del.run_id
          AND run.status = 'complete'
        RETURNING del.id
      )
      SELECT count(*)::int AS removed FROM deleted
    `);
    return rows.rows[0]?.removed ?? 0;
  }
}

export const labStorage = new LabDatabaseStorage();
