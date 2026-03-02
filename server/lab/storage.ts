import {
  labStrategies, labOptimizationRuns, labOptimizationResults,
  type LabStrategy, type InsertLabStrategy,
  type LabOptimizationRun, type InsertLabRun,
  type LabOptResult, type InsertLabResult,
  type LabBacktestResult, type LabJobProgress, type LabOptimizationConfig, type LabJobResult,
  type LabCheckpoint,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, inArray } from "drizzle-orm";
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
}

export interface ILabStorage {
  createStrategy(data: InsertLabStrategy): Promise<LabStrategy>;
  getStrategies(): Promise<LabStrategy[]>;
  getStrategy(id: number): Promise<LabStrategy | undefined>;
  updateStrategy(id: number, data: Partial<InsertLabStrategy>): Promise<LabStrategy | undefined>;
  deleteStrategy(id: number): Promise<void>;

  createRun(data: InsertLabRun): Promise<LabOptimizationRun>;
  getRuns(strategyId?: number): Promise<LabOptimizationRun[]>;
  getRun(id: number): Promise<LabOptimizationRun | undefined>;
  completeRun(id: number, totalConfigsTested: number): Promise<void>;
  failRun(id: number): Promise<void>;
  pauseRun(id: number): Promise<void>;
  resumeRun(id: number): Promise<void>;
  deleteRun(id: number): Promise<void>;
  saveCheckpoint(runId: number, checkpoint: LabCheckpoint): Promise<void>;
  getCheckpoint(runId: number): Promise<LabCheckpoint | null>;

  saveResults(runId: number, results: LabBacktestResult[]): Promise<void>;
  saveComboResults(runId: number, results: LabBacktestResult[], isPartial?: boolean): Promise<void>;
  getRunResults(runId: number): Promise<LabOptResult[]>;

  createJob(config: LabOptimizationConfig): LabJob;
  getJob(id: string): LabJob | undefined;
  getJobByRunId(runId: number): LabJob | undefined;
  updateProgress(id: string, progress: LabJobProgress): void;
  setResults(id: string, results: LabBacktestResult[]): void;
  getJobResult(id: string): LabJobResult | undefined;
  cancelJob(id: string): void;
}

export class LabDatabaseStorage implements ILabStorage {
  private jobs: Map<string, LabJob>;

  constructor() {
    this.jobs = new Map();
    this.cleanupStaleRuns();
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

        const canResume = hasAnyCheckpoint || hasPersistedResults;
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
              : "";
        console.log(`[QuantumLab] Stale run ${run.id} → ${newStatus}${detail ? ` (${detail})` : ""}`);
      }
      if (staleRuns.length > 0) {
        console.log(`[QuantumLab] Processed ${staleRuns.length} stale run(s) from previous session`);
      }

      const failedRuns = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.status, "failed"));
      let recovered = 0;
      for (const run of failedRuns) {
        const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
        const hasCheckpoint = cp?.completedCombos?.length > 0 || (cp?.currentCombo && cp?.currentIteration != null);
        const savedResults = await db.select({ id: labOptimizationResults.id })
          .from(labOptimizationResults)
          .where(eq(labOptimizationResults.runId, run.id))
          .limit(1);
        if (hasCheckpoint || savedResults.length > 0) {
          await db.update(labOptimizationRuns).set({
            status: "paused",
            completedAt: null,
          }).where(eq(labOptimizationRuns.id, run.id));
          console.log(`[QuantumLab] Recovered failed run ${run.id} → paused (has ${hasCheckpoint ? "checkpoint" : ""}${savedResults.length > 0 ? " results" : ""})`);
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

  async getStrategies(): Promise<LabStrategy[]> {
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

  async getRuns(strategyId?: number): Promise<LabOptimizationRun[]> {
    if (strategyId) {
      return db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.strategyId, strategyId)).orderBy(desc(labOptimizationRuns.createdAt));
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
    const existing = await db.select({ id: labOptimizationResults.id, ticker: labOptimizationResults.ticker, timeframe: labOptimizationResults.timeframe })
      .from(labOptimizationResults)
      .where(eq(labOptimizationResults.runId, runId));
    const existingForCombo = existing.filter(r => `${r.ticker}|${r.timeframe}` === comboKey);

    if (existingForCombo.length > 0) {
      if (!isPartial) {
        const idsToDelete = existingForCombo.map(r => r.id);
        await db.delete(labOptimizationResults).where(inArray(labOptimizationResults.id, idsToDelete));
        console.log(`[QuantumLab] Combo ${comboKey} run ${runId}: replaced ${idsToDelete.length} partial results with ${results.length} final results`);
      } else {
        const idsToDelete = existingForCombo.map(r => r.id);
        await db.delete(labOptimizationResults).where(inArray(labOptimizationResults.id, idsToDelete));
        console.log(`[QuantumLab] Combo ${comboKey} run ${runId}: updating ${results.length} partial results`);
      }
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
      await db.insert(labOptimizationResults).values(batch);
    }
  }

  async getRunResults(runId: number): Promise<LabOptResult[]> {
    return db.select().from(labOptimizationResults).where(eq(labOptimizationResults.runId, runId)).orderBy(labOptimizationResults.rank);
  }

  createJob(config: LabOptimizationConfig): LabJob {
    const activeJobs = Array.from(this.jobs.values()).filter(
      (j) => j.progress.status !== "complete" && j.progress.status !== "error"
    );
    if (activeJobs.length >= MAX_CONCURRENT_JOBS) {
      throw new Error(`Maximum concurrent jobs limit reached (${MAX_CONCURRENT_JOBS}). Please wait for the current job to finish.`);
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
    };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id: string): LabJob | undefined {
    return this.jobs.get(id);
  }

  getJobByRunId(runId: number): LabJob | undefined {
    for (const job of Array.from(this.jobs.values())) {
      if (job.runId === runId) return job;
    }
    return undefined;
  }

  private scheduleCleanup(id: string): void {
    setTimeout(() => {
      this.jobs.delete(id);
    }, 5 * 60 * 1000);
  }

  updateProgress(id: string, progress: LabJobProgress): void {
    const job = this.jobs.get(id);
    if (job) {
      job.progress = progress;
      for (const listener of Array.from(job.listeners)) {
        try { listener(progress); } catch {}
      }
      if (progress.status === "complete" || progress.status === "error") {
        this.scheduleCleanup(id);
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

    const totalSamples = job.config.randomSamples + job.config.topK * job.config.refinementsPerSeed;
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
      this.scheduleCleanup(id);
    }
  }
}

export const labStorage = new LabDatabaseStorage();
