import type { Express, Request, Response } from "express";
import { labStorage } from "./storage";
import { parsePineScript } from "./pine-parser";
import { labOptimizationConfigSchema, insertLabStrategyBodySchema, updateLabStrategyBodySchema, LAB_AVAILABLE_TICKERS, LAB_AVAILABLE_TIMEFRAMES, type LabCheckpoint, type LabOptimizationConfig, type LabBacktestResult, labOptimizationRuns, labOptimizationResults } from "@shared/schema";
import { getCacheStats, clearCandleCache } from "./candle-store";
import { fetchOHLCV } from "./datafeed";
import { Worker } from "worker_threads";
import { resolve, dirname } from "path";
import type { OHLCV } from "./engine";
import { db } from "../db";
import { eq } from "drizzle-orm";

export function registerLabRoutes(app: Express): void {

  app.get("/api/lab/tickers", (_req: Request, res: Response) => {
    res.json(LAB_AVAILABLE_TICKERS);
  });

  app.get("/api/lab/timeframes", (_req: Request, res: Response) => {
    res.json(LAB_AVAILABLE_TIMEFRAMES);
  });

  app.post("/api/lab/parse-pine", (req: Request, res: Response) => {
    try {
      const { code } = req.body;
      if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Pine Script code is required" });
      }
      const result = parsePineScript(code);
      res.json(result);
    } catch (err: any) {
      console.log(`[QuantumLab] Parse error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies", async (_req: Request, res: Response) => {
    try {
      const list = await labStorage.getStrategies();
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies/:id", async (req: Request, res: Response) => {
    try {
      const strategy = await labStorage.getStrategy(parseInt(req.params.id));
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      res.json(strategy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/strategies", async (req: Request, res: Response) => {
    try {
      const parsed = insertLabStrategyBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { name, pineScript, description, parsedInputs, groups, strategySettings } = parsed.data;
      const strategy = await labStorage.createStrategy({
        name,
        pineScript,
        description: description ?? null,
        parsedInputs: parsedInputs ?? {},
        groups: groups ?? null,
        strategySettings: strategySettings ?? null,
      });
      res.json(strategy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/lab/strategies/:id", async (req: Request, res: Response) => {
    try {
      const parsed = updateLabStrategyBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const strategy = await labStorage.updateStrategy(parseInt(req.params.id), parsed.data);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      res.json(strategy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/strategies/:id", async (req: Request, res: Response) => {
    try {
      await labStorage.deleteStrategy(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies/:id/all-results", async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.id);
      if (isNaN(strategyId)) return res.status(400).json({ error: "Invalid strategy ID" });
      const data = await labStorage.getAllResultsForStrategy(strategyId);
      if (!data.strategy) return res.status(404).json({ error: "Strategy not found" });
      const lite = req.query.lite === "1";
      if (lite) {
        const slimResults = data.results.map(r => ({
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
          trades: ((r.trades as any[]) ?? []).map((t: any) => ({
            direction: t.direction,
            pnlPercent: t.pnlPercent,
            pnlDollar: t.pnlDollar,
            exitReason: t.exitReason,
            barsHeld: t.barsHeld,
          })),
        }));
        return res.json({ strategy: data.strategy, totalRuns: data.totalRuns, totalResults: data.totalResults, results: slimResults });
      }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs", async (req: Request, res: Response) => {
    try {
      const strategyId = req.query.strategyId ? parseInt(req.query.strategyId as string) : undefined;
      const runs = await labStorage.getRuns(strategyId);
      res.json(runs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs/:id", async (req: Request, res: Response) => {
    try {
      const run = await labStorage.getRun(parseInt(req.params.id));
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.json(run);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs/:id/job", (req: Request, res: Response) => {
    const runId = parseInt(req.params.id);
    const job = labStorage.getJobByRunId(runId);
    if (!job) return res.status(404).json({ error: "No active job for this run" });
    res.json({ jobId: job.id });
  });

  app.post("/api/lab/runs/:id/fail", async (req: Request, res: Response) => {
    try {
      const runId = parseInt(req.params.id);
      const run = await labStorage.getRun(runId);
      if (!run) return res.status(404).json({ error: "Run not found" });
      if (run.status === "complete" || run.status === "paused") {
        return res.json({ ok: true, status: run.status });
      }
      const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
      const hasCheckpoint = cp?.completedCombos?.length > 0 || (cp?.currentCombo && cp?.currentIteration != null);
      const savedResults = await labStorage.getRunResults(runId);
      const hasResults = savedResults.length > 0;
      if (hasCheckpoint || hasResults) {
        await labStorage.pauseRun(runId);
        console.log(`[QuantumLab] Run ${runId} fail request → paused instead (has ${hasCheckpoint ? "checkpoint" : ""}${hasResults ? " results" : ""})`);
        res.json({ ok: true, status: "paused" });
      } else {
        await labStorage.failRun(runId);
        res.json({ ok: true, status: "failed" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs/:id/results", async (req: Request, res: Response) => {
    try {
      const results = await labStorage.getRunResults(parseInt(req.params.id));
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/runs/:id", async (req: Request, res: Response) => {
    try {
      await labStorage.deleteRun(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  function createWorker(workerDataPayload: any): Worker {
    const isProd = typeof (globalThis as any).__ESBUILD_CJS_BUNDLE__ !== "undefined";
    if (isProd) {
      const workerPath = resolve(dirname(process.argv[1] || __filename), "optimizer-worker.cjs");
      return new Worker(workerPath, { workerData: workerDataPayload });
    }
    return new Worker(
      `require('tsx/cjs'); require('${resolve(process.cwd(), "server", "lab", "optimizer-worker.ts").replace(/\\/g, "/")}');`,
      { eval: true, workerData: workerDataPayload }
    );
  }

  let activeWorker: Worker | null = null;

  async function fetchAllCandles(
    config: LabOptimizationConfig,
    onProgress: (msg: string) => void
  ): Promise<Record<string, OHLCV[]>> {
    const candlesByCombo: Record<string, OHLCV[]> = {};
    for (const ticker of config.tickers) {
      for (const tf of config.timeframes) {
        const key = `${ticker}|${tf}`;
        onProgress(`Fetching data for ${ticker.split("/")[0]} ${tf}`);
        try {
          const candles = await fetchOHLCV(ticker, tf, config.startDate, config.endDate, onProgress);
          candlesByCombo[key] = candles;
        } catch (err: any) {
          console.log(`[QuantumLab] Failed to fetch data for ${ticker} ${tf}: ${err.message}`);
          candlesByCombo[key] = [];
        }
      }
    }
    return candlesByCombo;
  }

  function startOptimizationJob(
    config: LabOptimizationConfig,
    job: ReturnType<typeof labStorage.createJob>,
    runId: number | undefined,
    resumeCheckpoint?: LabCheckpoint,
    prefetchedCandles?: Record<string, OHLCV[]>
  ) {
    const completedCombos: string[] = resumeCheckpoint?.completedCombos ? [...resumeCheckpoint.completedCombos] : [];

    const doStart = async () => {
      let candlesByCombo: Record<string, OHLCV[]>;
      if (prefetchedCandles) {
        candlesByCombo = prefetchedCandles;
      } else {
        const fetchStart = Date.now();
        labStorage.updateProgress(job.id, {
          jobId: job.id, status: "fetching", stage: "Fetching candle data...",
          current: 0, total: 0, percent: 0, elapsed: 0,
        });
        candlesByCombo = await fetchAllCandles(config, (msg) => {
          labStorage.updateProgress(job.id, {
            jobId: job.id, status: "fetching", stage: msg,
            current: 0, total: 0, percent: 0, elapsed: Date.now() - fetchStart,
          });
        });
      }

      const worker = createWorker({
        jobId: job.id,
        config: {
          tickers: config.tickers,
          timeframes: config.timeframes,
          randomSamples: config.randomSamples,
          topK: config.topK,
          refinementsPerSeed: config.refinementsPerSeed,
          minTrades: config.minTrades,
          maxDrawdownCap: config.maxDrawdownCap,
          parsedInputs: config.parsedInputs,
        },
        candlesByCombo,
        resumeCheckpoint,
      });

      activeWorker = worker;

      worker.on("message", async (msg: any) => {
        switch (msg.type) {
          case "progress":
            labStorage.updateProgress(job.id, msg.data);
            break;

          case "partial-checkpoint":
            if (!runId) break;
            try {
              if (msg.results.length > 0) {
                await labStorage.saveComboResults(runId, msg.results, true);
              }
              const checkpoint: LabCheckpoint = {
                completedCombos: [...completedCombos],
                configSnapshot: config,
                currentCombo: msg.combo,
                currentStage: msg.stage,
                currentIteration: msg.iteration,
              };
              await labStorage.saveCheckpoint(runId, checkpoint);
            } catch (err: any) {
              console.log(`[QuantumLab] Partial checkpoint error: ${err.message}`);
            }
            break;

          case "combo-complete":
            completedCombos.push(msg.combo);
            if (!runId) break;
            try {
              if (msg.results.length > 0) {
                await labStorage.saveComboResults(runId, msg.results);
              }
              const checkpoint: LabCheckpoint = {
                completedCombos: [...completedCombos],
                configSnapshot: config,
                currentCombo: undefined,
                currentStage: undefined,
                currentIteration: undefined,
                partialResults: undefined,
              };
              await labStorage.saveCheckpoint(runId, checkpoint);
              console.log(`[QuantumLab] Checkpoint saved: ${completedCombos.length} combos done (run ${runId})`);
            } catch (err: any) {
              console.log(`[QuantumLab] Checkpoint save error: ${err.message}`);
            }
            break;

          case "done": {
            const results = msg.results as LabBacktestResult[];
            if (job.abortSignal.aborted) {
              console.log(`[QuantumLab] Job ${job.id} was cancelled with ${results.length} results found`);
              labStorage.setResults(job.id, results);
              if (runId) {
                await labStorage.pauseRun(runId).catch(() => {});
              }
            } else {
              console.log(`[QuantumLab] Optimization finished: ${results.length} new results`);
              labStorage.setResults(job.id, results);
              if (runId) {
                try {
                  const totalSamples = config.randomSamples + config.topK * config.refinementsPerSeed;
                  const combos = config.tickers.length * config.timeframes.length;
                  await labStorage.completeRun(runId, totalSamples * combos);
                  await labStorage.saveCheckpoint(runId, { completedCombos: [], configSnapshot: config });
                  console.log(`[QuantumLab] Run ${runId} completed`);
                } catch (err: any) {
                  console.log(`[QuantumLab] Failed to complete run: ${err.stack || err.message}`);
                }
              }
            }
            activeWorker = null;
            break;
          }

          case "error":
            console.log(`[QuantumLab] Worker error: ${msg.message}`);
            labStorage.updateProgress(job.id, {
              jobId: job.id, status: "error", stage: `Error: ${msg.message}`,
              current: 0, total: 0, percent: 0, elapsed: 0, error: msg.message,
            });
            if (runId) {
              try {
                const savedResults = await labStorage.getRunResults(runId);
                const cp = await labStorage.getCheckpoint(runId);
                const hasCheckpoint = cp?.completedCombos?.length || (cp?.currentCombo && cp?.currentIteration != null);
                if (savedResults.length > 0 || hasCheckpoint) {
                  await labStorage.pauseRun(runId);
                  console.log(`[QuantumLab] Run ${runId} error but has progress → paused`);
                } else {
                  await labStorage.failRun(runId);
                }
              } catch {}
            }
            activeWorker = null;
            break;
        }
      });

      worker.on("error", async (err: Error) => {
        console.log(`[QuantumLab] Worker thread error: ${err.message}`);
        labStorage.updateProgress(job.id, {
          jobId: job.id, status: "error", stage: `Worker error: ${err.message}`,
          current: 0, total: 0, percent: 0, elapsed: 0, error: err.message,
        });
        if (runId) {
          try {
            const savedResults = await labStorage.getRunResults(runId);
            const cp = await labStorage.getCheckpoint(runId);
            const hasCheckpoint = cp?.completedCombos?.length || (cp?.currentCombo && cp?.currentIteration != null);
            if (savedResults.length > 0 || hasCheckpoint) {
              await labStorage.pauseRun(runId);
              console.log(`[QuantumLab] Worker error but run ${runId} has progress → paused`);
            } else {
              await labStorage.failRun(runId);
            }
          } catch { await labStorage.failRun(runId).catch(() => {}); }
        }
        activeWorker = null;
      });

      worker.on("exit", async (code: number) => {
        if (code !== 0 && activeWorker === worker) {
          console.log(`[QuantumLab] Worker exited with code ${code}`);
          if (runId) {
            try {
              const savedResults = await labStorage.getRunResults(runId);
              const cp = await labStorage.getCheckpoint(runId);
              const hasCheckpoint = cp?.completedCombos?.length || (cp?.currentCombo && cp?.currentIteration != null);
              if (savedResults.length > 0 || hasCheckpoint) {
                await labStorage.pauseRun(runId);
                console.log(`[QuantumLab] Worker exit(${code}) but run ${runId} has progress → paused`);
              } else {
                await labStorage.failRun(runId);
              }
            } catch { await labStorage.failRun(runId).catch(() => {}); }
          }
          activeWorker = null;
        }
      });
    };

    doStart().catch(async (err: any) => {
      console.log(`[QuantumLab] Failed to start optimization: ${err.message}`);
      labStorage.updateProgress(job.id, {
        jobId: job.id, status: "error", stage: `Error: ${err.message}`,
        current: 0, total: 0, percent: 0, elapsed: 0, error: err.message,
      });
      if (runId) {
        await labStorage.failRun(runId).catch(() => {});
      }
    });
  }

  app.post("/api/lab/run-optimization", async (req: Request, res: Response) => {
    try {
      const parsed = labOptimizationConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      const config = parsed.data;
      const job = labStorage.createJob(config);

      let runId: number | undefined;
      if (config.strategyId) {
        const run = await labStorage.createRun({
          strategyId: config.strategyId,
          tickers: config.tickers,
          timeframes: config.timeframes,
          startDate: config.startDate,
          endDate: config.endDate,
          randomSamples: config.randomSamples,
          topK: config.topK,
          refinementsPerSeed: config.refinementsPerSeed,
          minTrades: config.minTrades,
          maxDrawdownCap: config.maxDrawdownCap,
          mode: config.mode,
          status: "running",
        });
        runId = run.id;
        job.runId = runId;
        await labStorage.saveCheckpoint(runId, { completedCombos: [], configSnapshot: config });
      }

      startOptimizationJob(config, job, runId);

      res.json({ jobId: job.id, runId });
    } catch (err: any) {
      console.log(`[QuantumLab] Run error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/runs/:id/resume", async (req: Request, res: Response) => {
    try {
      const runId = parseInt(req.params.id);
      const run = await labStorage.getRun(runId);
      if (!run) return res.status(404).json({ error: "Run not found" });
      if (run.status === "running") {
        const existingJob = labStorage.getJobByRunId(runId);
        if (existingJob) {
          return res.json({ jobId: existingJob.id, runId, alreadyRunning: true });
        }
      }
      if (run.status !== "paused") return res.status(400).json({ error: `Run is ${run.status}, not paused` });

      const checkpoint = await labStorage.getCheckpoint(runId);
      if (!checkpoint?.configSnapshot) return res.status(400).json({ error: "No checkpoint data found for this run" });

      if (checkpoint.currentCombo && !checkpoint.partialResults?.length) {
        const dbResults = await labStorage.getRunResults(runId);
        const comboResults = dbResults.filter(r => `${r.ticker}|${r.timeframe}` === checkpoint.currentCombo);
        if (comboResults.length > 0) {
          checkpoint.partialResults = comboResults.map(r => ({
            ticker: r.ticker,
            timeframe: r.timeframe,
            netProfitPercent: r.netProfitPercent,
            winRatePercent: r.winRatePercent,
            maxDrawdownPercent: r.maxDrawdownPercent,
            profitFactor: r.profitFactor,
            totalTrades: r.totalTrades,
            params: r.params as Record<string, any>,
            trades: (r.trades as any[]) ?? [],
            equityCurve: (r.equityCurve as any[]) ?? [],
          }));
          console.log(`[QuantumLab] Loaded ${comboResults.length} partial results from DB for combo ${checkpoint.currentCombo}`);
        }
      }

      const config = checkpoint.configSnapshot;
      if ((checkpoint as any).autoResumeAttempts) {
        (checkpoint as any).autoResumeAttempts = 0;
        await labStorage.saveCheckpoint(runId, checkpoint);
      }
      const job = labStorage.createJob(config);
      job.runId = runId;

      await labStorage.resumeRun(runId);
      console.log(`[QuantumLab] Resuming run ${runId} — ${checkpoint.completedCombos.length} combos already done${checkpoint.currentCombo ? `, mid-combo ${checkpoint.currentCombo} at iter ${checkpoint.currentIteration}` : ""}`);

      startOptimizationJob(config, job, runId, checkpoint);

      res.json({ jobId: job.id, runId, resumedFrom: checkpoint.completedCombos.length });
    } catch (err: any) {
      console.log(`[QuantumLab] Resume error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/job/:id/progress", (req: Request, res: Response) => {
    const job = labStorage.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    const sendProgress = (progress: any) => {
      try {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      } catch {}
    };

    sendProgress(job.progress);

    const heartbeat = setInterval(() => {
      try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 15000);

    job.listeners.add(sendProgress);

    req.on("close", () => {
      clearInterval(heartbeat);
      job.listeners.delete(sendProgress);
    });
  });

  app.get("/api/lab/job/:id/results", (req: Request, res: Response) => {
    const results = labStorage.getJobResult(req.params.id);
    if (!results) {
      return res.status(404).json({ error: "Results not found" });
    }
    res.json(results);
  });

  app.post("/api/lab/jobs/force-clear", async (req: Request, res: Response) => {
    if (activeWorker) {
      activeWorker.postMessage({ type: "abort" });
      try { activeWorker.terminate(); } catch {}
      activeWorker = null;
    }
    const evicted = labStorage.forceEvictAllJobs();
    const staleRuns = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.status, "running"));
    for (const run of staleRuns) {
      const savedResults = await db.select({ id: labOptimizationResults.id })
        .from(labOptimizationResults)
        .where(eq(labOptimizationResults.runId, run.id))
        .limit(1);
      if (savedResults.length > 0) {
        await labStorage.pauseRun(run.id);
        console.log(`[QuantumLab] Force-clear: run ${run.id} → paused (has results)`);
      } else {
        await labStorage.failRun(run.id);
        console.log(`[QuantumLab] Force-clear: run ${run.id} → failed`);
      }
    }
    console.log(`[QuantumLab] Force-clear complete: ${evicted} in-memory jobs evicted, ${staleRuns.length} DB runs cleaned`);
    res.json({ success: true, evictedJobs: evicted, cleanedRuns: staleRuns.length });
  });

  app.post("/api/lab/job/:id/cancel", async (req: Request, res: Response) => {
    const job = labStorage.getJob(req.params.id);
    if (activeWorker) {
      activeWorker.postMessage({ type: "abort" });
    }
    labStorage.cancelJob(req.params.id);
    if (job?.runId && activeWorker) {
      setTimeout(async () => {
        try {
          const run = await labStorage.getRun(job.runId!);
          if (run && run.status === "running") {
            await labStorage.pauseRun(job.runId!);
            console.log(`[QuantumLab] Cancel safety net: run ${job.runId} → paused`);
          }
        } catch {}
      }, 5000);
    }
    res.json({ success: true });
  });

  app.get("/api/lab/export/csv/:id", (req: Request, res: Response) => {
    const results = labStorage.getJobResult(req.params.id);
    if (!results) {
      return res.status(404).json({ error: "Results not found" });
    }

    const headers = ["Rank", "Ticker", "Timeframe", "Net Profit %", "Win Rate %", "Max Drawdown %", "Profit Factor", "Total Trades", "Parameters"];
    const rows = results.configs.map((config, idx) => [
      idx + 1,
      config.ticker,
      config.timeframe,
      config.netProfitPercent,
      config.winRatePercent,
      config.maxDrawdownPercent,
      config.profitFactor,
      config.totalTrades,
      JSON.stringify(config.params),
    ]);

    const csv = [headers.join(","), ...rows.map(row => row.join(","))].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="optimization_results_${req.params.id}.csv"`);
    res.send(csv);
  });

  app.get("/api/lab/heatmap", async (_req: Request, res: Response) => {
    try {
      const runs = await labStorage.getRuns();
      const completedRuns = runs.filter(r => r.status === "complete" || r.status === "paused");
      if (completedRuns.length === 0) {
        return res.json({ cells: [], tickers: [], timeframes: [], runs: 0 });
      }

      const cellMap = new Map<string, { ticker: string; timeframe: string; results: any[] }>();

      for (const run of completedRuns) {
        const results = await labStorage.getRunResults(run.id);
        for (const r of results) {
          const key = `${r.ticker}|${r.timeframe}`;
          if (!cellMap.has(key)) {
            cellMap.set(key, { ticker: r.ticker, timeframe: r.timeframe, results: [] });
          }
          cellMap.get(key)!.results.push({
            runId: run.id,
            strategyId: run.strategyId,
            rank: r.rank,
            netProfitPercent: r.netProfitPercent,
            winRatePercent: r.winRatePercent,
            maxDrawdownPercent: r.maxDrawdownPercent,
            profitFactor: r.profitFactor,
            totalTrades: r.totalTrades,
            params: r.params,
          });
        }
      }

      const tickers = new Set<string>();
      const timeframes = new Set<string>();
      const cells: any[] = [];

      for (const [, cell] of cellMap) {
        tickers.add(cell.ticker);
        timeframes.add(cell.timeframe);
        const sorted = cell.results.sort((a: any, b: any) => b.netProfitPercent - a.netProfitPercent);
        const best = sorted[0];
        const avgProfit = sorted.reduce((s: number, r: any) => s + r.netProfitPercent, 0) / sorted.length;
        const avgWinRate = sorted.reduce((s: number, r: any) => s + r.winRatePercent, 0) / sorted.length;
        const avgDrawdown = sorted.reduce((s: number, r: any) => s + r.maxDrawdownPercent, 0) / sorted.length;
        const avgPF = sorted.reduce((s: number, r: any) => s + r.profitFactor, 0) / sorted.length;
        cells.push({
          ticker: cell.ticker,
          timeframe: cell.timeframe,
          totalConfigs: sorted.length,
          bestProfit: best.netProfitPercent,
          bestWinRate: Math.max(...sorted.map((r: any) => r.winRatePercent)),
          bestPF: Math.max(...sorted.map((r: any) => r.profitFactor)),
          lowestDrawdown: Math.min(...sorted.map((r: any) => r.maxDrawdownPercent)),
          avgProfit,
          avgWinRate,
          avgDrawdown,
          avgPF,
          runsCount: new Set(sorted.map((r: any) => r.runId)).size,
          allResults: sorted.map((r: any) => ({
            netProfitPercent: r.netProfitPercent,
            winRatePercent: r.winRatePercent,
            maxDrawdownPercent: r.maxDrawdownPercent,
            profitFactor: r.profitFactor,
            totalTrades: r.totalTrades,
            params: r.params,
            runId: r.runId,
            strategyId: r.strategyId,
          })),
        });
      }

      const tfOrder = ["1m", "5m", "15m", "30m", "1h", "1H", "2h", "2H", "4h", "4H", "8h", "8H", "12h", "12H", "1d", "1D"];
      const sortedTimeframes = [...timeframes].sort((a, b) => tfOrder.indexOf(a) - tfOrder.indexOf(b));
      const sortedTickers = [...tickers].sort();

      res.json({ cells, tickers: sortedTickers, timeframes: sortedTimeframes, runs: completedRuns.length });
    } catch (err: any) {
      console.log(`[QuantumLab] Heatmap error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/cache/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await getCacheStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/cache", async (_req: Request, res: Response) => {
    try {
      const deleted = await clearCandleCache();
      res.json({ success: true, deletedRows: deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const MAX_AUTO_RESUME_ATTEMPTS = 2;

  setTimeout(async () => {
    try {
      const interruptedIds = (labStorage as any).interruptedRunIds as number[] | undefined;
      if (!interruptedIds || interruptedIds.length === 0) return;

      const latestId = Math.max(...interruptedIds);
      const run = await labStorage.getRun(latestId);
      if (!run || run.status !== "paused") return;

      const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
      if (!cp?.configSnapshot) return;
      const hasComboCheckpoint = cp?.completedCombos?.length > 0;
      const hasMidComboCheckpoint = cp?.currentCombo && cp?.currentIteration != null;
      if (!hasComboCheckpoint && !hasMidComboCheckpoint) return;

      const crashCount = (cp.autoResumeAttempts as number) ?? 0;
      if (crashCount >= MAX_AUTO_RESUME_ATTEMPTS) {
        console.log(`[QuantumLab] Skipping auto-resume for run ${run.id} — crashed ${crashCount} times (max ${MAX_AUTO_RESUME_ATTEMPTS}). Manual resume required.`);
        return;
      }

      cp.autoResumeAttempts = crashCount + 1;
      await labStorage.saveCheckpoint(run.id, cp);

      const checkpoint: LabCheckpoint = cp;
      const config = checkpoint.configSnapshot!;

      if (checkpoint.currentCombo && !checkpoint.partialResults?.length) {
        const dbResults = await labStorage.getRunResults(run.id);
        const comboResults = dbResults.filter(r => `${r.ticker}|${r.timeframe}` === checkpoint.currentCombo);
        if (comboResults.length > 0) {
          checkpoint.partialResults = comboResults.map(r => ({
            ticker: r.ticker,
            timeframe: r.timeframe,
            netProfitPercent: r.netProfitPercent,
            winRatePercent: r.winRatePercent,
            maxDrawdownPercent: r.maxDrawdownPercent,
            profitFactor: r.profitFactor,
            totalTrades: r.totalTrades,
            params: r.params as Record<string, any>,
            trades: (r.trades as any[]) ?? [],
            equityCurve: (r.equityCurve as any[]) ?? [],
          }));
        }
      }

      const job = labStorage.createJob(config);
      job.runId = run.id;
      await labStorage.resumeRun(run.id);
      const detail = hasComboCheckpoint
        ? `${cp.completedCombos.length} combos done`
        : `mid-combo ${cp.currentCombo} at iter ${cp.currentIteration}`;
      console.log(`[QuantumLab] Auto-resuming run ${run.id} (${detail}, attempt ${crashCount + 1}/${MAX_AUTO_RESUME_ATTEMPTS})`);
      startOptimizationJob(config, job, run.id, checkpoint);
    } catch (err: any) {
      console.log(`[QuantumLab] Auto-resume error: ${err.message}`);
    }
  }, 5000);

  const gracefulShutdown = async (signal: string) => {
    console.log(`[QuantumLab] ${signal} received — pausing active jobs...`);
    if (activeWorker) {
      activeWorker.postMessage({ type: "abort" });
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            activeWorker?.once("exit", () => resolve());
          }),
          new Promise<void>(resolve => setTimeout(resolve, 2000)),
        ]);
        activeWorker?.terminate();
      } catch {}
      activeWorker = null;
    }
    const allJobs = (labStorage as any).jobs as Map<string, any> | undefined;
    if (!allJobs || allJobs.size === 0) return;
    const pausePromises: Promise<void>[] = [];
    for (const [jobId, job] of allJobs) {
      if (job.abortSignal && !job.abortSignal.aborted && job.progress?.status !== "complete" && job.progress?.status !== "error") {
        job.abortSignal.aborted = true;
        if (job.runId) {
          pausePromises.push(
            labStorage.pauseRun(job.runId)
              .then(() => console.log(`[QuantumLab] Job ${jobId} (run ${job.runId}) → paused on ${signal}`))
              .catch((err: any) => console.log(`[QuantumLab] Failed to pause run ${job.runId} on ${signal}: ${err.message}`))
          );
        }
      }
    }
    if (pausePromises.length > 0) {
      await Promise.race([
        Promise.allSettled(pausePromises),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    }
  };

  process.on("SIGTERM", () => { gracefulShutdown("SIGTERM").catch(() => {}); });
  process.on("SIGINT", () => { gracefulShutdown("SIGINT").catch(() => {}); });
}
