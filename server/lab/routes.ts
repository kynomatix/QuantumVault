import type { Express, Request, Response } from "express";
import { labStorage } from "./storage";
import { parsePineScript } from "./pine-parser";
import { runOptimization, type OptimizationCallbacks } from "./optimizer";
import { labOptimizationConfigSchema, insertLabStrategyBodySchema, updateLabStrategyBodySchema, LAB_AVAILABLE_TICKERS, LAB_AVAILABLE_TIMEFRAMES, type LabCheckpoint, type LabOptimizationConfig } from "@shared/schema";
import { getCacheStats, clearCandleCache } from "./candle-store";

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
      await labStorage.failRun(runId);
      res.json({ ok: true });
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

  function startOptimizationJob(
    config: LabOptimizationConfig,
    job: ReturnType<typeof labStorage.createJob>,
    runId: number | undefined,
    resumeCheckpoint?: LabCheckpoint
  ) {
    const completedCombos: string[] = resumeCheckpoint?.completedCombos ? [...resumeCheckpoint.completedCombos] : [];

    const callbacks: OptimizationCallbacks = {
      onProgress: (progress: any) => labStorage.updateProgress(job.id, progress),
      onComboCheckpoint: async (completedCombo: string, comboResults: any[]) => {
        if (!runId) return;
        completedCombos.push(completedCombo);
        try {
          if (comboResults.length > 0) {
            await labStorage.saveComboResults(runId, comboResults);
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
      },
      onPartialCheckpoint: async (combo: string, stage: "random" | "refine", iteration: number, partialResults: any[]) => {
        if (!runId) return;
        try {
          if (partialResults.length > 0) {
            await labStorage.saveComboResults(runId, partialResults, true);
          }
          const checkpoint: LabCheckpoint = {
            completedCombos: [...completedCombos],
            configSnapshot: config,
            currentCombo: combo,
            currentStage: stage,
            currentIteration: iteration,
          };
          await labStorage.saveCheckpoint(runId, checkpoint);
        } catch (err: any) {
          console.log(`[QuantumLab] Partial checkpoint error: ${err.message}`);
        }
      },
    };

    runOptimization(
      config,
      callbacks.onProgress,
      job.id,
      job.abortSignal,
      callbacks,
      resumeCheckpoint
    ).then(async (results: any[]) => {
      if (job.abortSignal.aborted) {
        console.log(`[QuantumLab] Job ${job.id} was cancelled with ${results.length} results found`);
        if (results.length > 0) {
          labStorage.setResults(job.id, results);
          if (runId) {
            try {
              const byCombo = new Map<string, any[]>();
              for (const r of results) {
                const k = `${r.ticker}|${r.timeframe}`;
                if (!byCombo.has(k)) byCombo.set(k, []);
                byCombo.get(k)!.push(r);
              }
              for (const [comboKey, comboResults] of byCombo) {
                await labStorage.saveComboResults(runId, comboResults);
              }
              await labStorage.pauseRun(runId);
              console.log(`[QuantumLab] Cancelled run ${runId}: saved ${results.length} results across ${byCombo.size} combos → paused`);
            } catch (err: any) {
              console.log(`[QuantumLab] Failed to save cancelled results: ${err.message}`);
            }
          }
        } else {
          if (runId) {
            await labStorage.pauseRun(runId).catch(() => {});
          }
        }
        return;
      }
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
    }).catch(async (err: any) => {
      console.log(`[QuantumLab] Optimization error: ${err.stack || err.message}`);
      labStorage.updateProgress(job.id, {
        jobId: job.id,
        status: "error",
        stage: `Error: ${err.message}`,
        current: 0,
        total: 0,
        percent: 0,
        elapsed: 0,
        error: err.message,
      });
      if (runId) {
        try { await labStorage.failRun(runId); } catch {}
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

  app.post("/api/lab/job/:id/cancel", (req: Request, res: Response) => {
    labStorage.cancelJob(req.params.id);
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
          top5: sorted.slice(0, 5).map((r: any) => ({
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

      const tfOrder = ["15m", "30m", "1h", "2h", "4h", "1d"];
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
}
