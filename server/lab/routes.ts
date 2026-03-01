import type { Express, Request, Response } from "express";
import { labStorage } from "./storage";
import { parsePineScript } from "./pine-parser";
import { runOptimization } from "./optimizer";
import { labOptimizationConfigSchema, insertLabStrategyBodySchema, updateLabStrategyBodySchema, LAB_AVAILABLE_TICKERS, LAB_AVAILABLE_TIMEFRAMES } from "@shared/schema";

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
      if (!results.length) return res.status(404).json({ error: "No results found" });
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
      }

      runOptimization(
        config,
        (progress: any) => labStorage.updateProgress(job.id, progress),
        job.id,
        job.abortSignal
      ).then(async (results: any[]) => {
        console.log(`[QuantumLab] Optimization finished: ${results.length} results`);
        labStorage.setResults(job.id, results);
        if (runId) {
          try {
            await labStorage.saveResults(runId, results);
            const totalSamples = config.randomSamples + config.topK * config.refinementsPerSeed;
            const combos = config.tickers.length * config.timeframes.length;
            await labStorage.completeRun(runId, totalSamples * combos);
            console.log(`[QuantumLab] Run ${runId} saved and completed`);
          } catch (err: any) {
            console.log(`[QuantumLab] Failed to save results to DB: ${err.stack || err.message}`);
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

      res.json({ jobId: job.id, runId });
    } catch (err: any) {
      console.log(`[QuantumLab] Run error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/job/:id/status", (req: Request, res: Response) => {
    const job = labStorage.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job.progress);
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
}
