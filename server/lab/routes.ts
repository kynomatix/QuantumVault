import type { Express, Request, Response } from "express";
import { labStorage } from "./storage";
import { parsePineScript } from "./pine-parser";
import { compilePine, runPineParityTest, type PineEngineConfig } from "./pine/index";
import { labOptimizationConfigSchema, insertLabStrategyBodySchema, updateLabStrategyBodySchema, LAB_AVAILABLE_TICKERS, LAB_AVAILABLE_TIMEFRAMES, type LabCheckpoint, type LabOptimizationConfig, type LabBacktestResult, labOptimizationRuns, labOptimizationResults } from "@shared/schema";
import { getCacheStats, clearCandleCache } from "./candle-store";
import { fetchOHLCV } from "./datafeed";
import { Worker } from "worker_threads";
import { resolve, dirname } from "path";
import type { OHLCV } from "./engine";
import { WorkerPool, recommendedPoolSize } from "./worker-pool";
import { hashStringToSeed } from "./rng";
import { db } from "../db";
import { eq, or, and, inArray, desc, sql } from "drizzle-orm";
import { createHash, timingSafeEqual } from "crypto";
import { userApiTokens } from "@shared/schema";

let labCleanup: ((reason: string) => Promise<void>) | null = null;

export function getLabCleanup(): ((reason: string) => Promise<void>) | null {
  return labCleanup;
}

function unwrapCheckpointConfig(cpConfigSnapshot: any): LabOptimizationConfig | null {
  if (!cpConfigSnapshot || typeof cpConfigSnapshot !== "object") return null;
  if (Array.isArray(cpConfigSnapshot.tickers)) return cpConfigSnapshot as LabOptimizationConfig;
  if (cpConfigSnapshot.config && Array.isArray(cpConfigSnapshot.config.tickers)) {
    return cpConfigSnapshot.config as LabOptimizationConfig;
  }
  return null;
}

async function extractConfigForResume(checkpoint: any, runId: number): Promise<LabOptimizationConfig | null> {
  let config = unwrapCheckpointConfig(checkpoint?.configSnapshot);
  if (config) return config;
  console.log(`[QuantumLab] Checkpoint configSnapshot missing/corrupt for run ${runId}, falling back to run record`);
  try {
    const run = await labStorage.getRun(runId);
    if (run?.configSnapshot) {
      const snap = run.configSnapshot as any;
      config = unwrapCheckpointConfig(snap);
      if (!config && snap.config) config = snap.config as LabOptimizationConfig;
      if (!config && Array.isArray(snap.tickers)) config = snap as LabOptimizationConfig;
      if (config) {
        checkpoint.configSnapshot = config;
        await labStorage.saveCheckpoint(runId, checkpoint);
        console.log(`[QuantumLab] Recovered config from run record for run ${runId} (tickers: ${config.tickers?.length})`);
      }
    }
  } catch (err: any) {
    console.log(`[QuantumLab] Failed to recover config for run ${runId}: ${err.message}`);
  }
  return config;
}

export function registerLabRoutes(app: Express): void {

  (async () => {
    try {
      const { sql } = await import("drizzle-orm");
      // SBR strategies: set nativeEngine + engineType by name (safe across dev/prod where IDs differ)
      await db.execute(sql`UPDATE lab_strategies SET strategy_settings = strategy_settings || '{"nativeEngine": true, "engineType": "sbr"}'::jsonb WHERE name ILIKE '%SBR%'`);
      // Adaptive Regime strategies: set nativeEngine + engineType:"ar38" by name
      await db.execute(sql`UPDATE lab_strategies SET strategy_settings = strategy_settings || '{"nativeEngine": true, "engineType": "ar38"}'::jsonb WHERE name ILIKE '%Adaptive Regime%'`);
      // Z-Score strategies: no native engine exists — remove nativeEngine flag if wrongly set
      await db.execute(sql`UPDATE lab_strategies SET strategy_settings = strategy_settings - 'nativeEngine' WHERE name ILIKE '%Z-Score%' AND (strategy_settings ? 'nativeEngine')`);

      // Copy Flux Momentum (id=1) from BuhE wallet to AqTT wallet if not already there
      await db.execute(sql`
        INSERT INTO lab_strategies (user_id, name, description, pine_script, parsed_inputs, groups, strategy_settings, created_at)
        SELECT
          'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
          name, description, pine_script, parsed_inputs, groups, strategy_settings, NOW()
        FROM lab_strategies
        WHERE id = 1
        AND NOT EXISTS (
          SELECT 1 FROM lab_strategies
          WHERE user_id = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'
          AND name = (SELECT name FROM lab_strategies WHERE id = 1)
        )
      `);

      // Cancel stuck runs 512 and 513 — run 512 is in a crash-retry loop (AVAX/USDT combo,
      // exit code 1, stalling watchdog) causing DB connection exhaustion across all background
      // tasks. Run 513 is queued behind it and would inherit the same problem.
      await db.execute(sql`
        UPDATE lab_optimization_runs
        SET status = 'failed', completed_at = NOW()
        WHERE id IN (512, 513) AND status IN ('running', 'paused', 'queued')
      `);

      // Import best NEAR/2h and ICP/2h results from dev into production.
      // Each migration file holds the full run metadata + single best result (rank=1).
      // The sentinel mode='imported' makes the NOT EXISTS guard unique and idempotent.
      const { readFileSync } = await import("fs");
      const { join, dirname } = await import("path");
      const { fileURLToPath } = await import("url");
      const __dir = dirname(fileURLToPath(import.meta.url));

      const migrationFiles = [
        join(__dir, "migrations", "near_2h_best.json"),
        join(__dir, "migrations", "icp_2h_best.json"),
      ];

      for (const file of migrationFiles) {
        const data = JSON.parse(readFileSync(file, "utf-8"));

        // Step 1: insert stub run (idempotent — guarded by user_id + tickers + mode='imported')
        await db.execute(sql`
          INSERT INTO lab_optimization_runs
            (user_id, strategy_id, tickers, timeframes, start_date, end_date,
             random_samples, top_k, refinements_per_seed, min_trades, max_drawdown_cap,
             mode, status, total_configs_tested, created_at, completed_at)
          SELECT
            ${data.user_id}, ${data.strategy_id},
            ${JSON.stringify(data.tickers)}::jsonb, ${JSON.stringify(data.timeframes)}::jsonb,
            ${data.start_date}, ${data.end_date},
            ${data.random_samples}, ${data.top_k}, ${data.refinements_per_seed},
            ${data.min_trades}, ${data.max_drawdown_cap},
            'imported', 'complete', ${data.total_configs_tested}, NOW(), NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM lab_optimization_runs
            WHERE user_id = ${data.user_id}
              AND tickers = ${JSON.stringify(data.tickers)}::jsonb
              AND mode = 'imported'
          )
        `);

        // Compute Sharpe ratio from trades for migration imports (mirrors storage.ts logic)
        const importTrades: any[] = Array.isArray(data.trades) ? data.trades : [];
        let importSharpe = 0;
        if (importTrades.length >= 2) {
          const returns = importTrades.map((t: any) => Number(t?.pnlPercent ?? 0));
          const n = returns.length;
          const mean = returns.reduce((s, r) => s + r, 0) / n;
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
          const stdDev = Math.sqrt(variance);
          importSharpe = stdDev > 0 ? Math.round((mean / stdDev) * 100) / 100 : 0;
        }

        // Step 2: insert result linked to that run (idempotent — guarded by run_id + ticker + rank)
        await db.execute(sql`
          INSERT INTO lab_optimization_results
            (run_id, ticker, timeframe, rank, net_profit_percent, win_rate_percent,
             max_drawdown_percent, profit_factor, total_trades, sharpe_ratio, params, trades, equity_curve)
          SELECT
            r.id,
            ${data.ticker}, ${data.timeframe}, ${data.rank},
            ${data.net_profit_percent}, ${data.win_rate_percent}, ${data.max_drawdown_percent},
            ${data.profit_factor}, ${data.total_trades}, ${importSharpe},
            ${JSON.stringify(data.params)}::jsonb,
            ${JSON.stringify(data.trades)}::jsonb,
            ${JSON.stringify(data.equity_curve)}::jsonb
          FROM lab_optimization_runs r
          WHERE r.user_id = ${data.user_id}
            AND r.tickers = ${JSON.stringify(data.tickers)}::jsonb
            AND r.mode = 'imported'
          AND NOT EXISTS (
            SELECT 1 FROM lab_optimization_results res
            WHERE res.run_id = r.id AND res.ticker = ${data.ticker} AND res.rank = ${data.rank}
          )
        `);
      }
    } catch (e) {}
  })();

  const requireLabAuth = async (req: any, res: any, next: any) => {
    const labSecret = process.env.LAB_AUTH_SECRET;
    if (labSecret) {
      const inboundSecret = req.headers["x-lab-auth"];
      if (inboundSecret !== labSecret) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const walletAddress = req.headers["x-lab-wallet"] as string | undefined;
      if (!walletAddress) {
        return res.status(401).json({ error: "Wallet not connected" });
      }
      req.walletAddress = walletAddress;
      return next();
    }

    // Bearer token auth — for AI agents (Claude/MCP) and external automation.
    // Header: `Authorization: Bearer qv_<token>`. Token is matched by SHA-256
    // hash against user_api_tokens. The token's wallet becomes the request's
    // wallet for the rest of the lab pipeline (per-user scoping is preserved).
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) {
        try {
          const tokenHash = createHash("sha256").update(token).digest("hex");
          const [row] = await db.select().from(userApiTokens).where(eq(userApiTokens.tokenHash, tokenHash)).limit(1);
          // Even though the DB lookup is by hash equality, re-verify the
          // candidate's stored hash with a constant-time compare. This makes
          // the validation step explicitly resistant to timing attacks on the
          // secret material.
          const candidateHash = row?.tokenHash || "";
          const a = Buffer.from(tokenHash, "hex");
          const b = Buffer.from(candidateHash.padEnd(tokenHash.length, "0").slice(0, tokenHash.length), "hex");
          const equal = a.length === b.length && timingSafeEqual(a, b);
          if (!row || !equal) {
            return res.status(401).json({ error: "Invalid API token" });
          }
          // Update lastUsedAt asynchronously (don't block the request).
          db.update(userApiTokens).set({ lastUsedAt: new Date() }).where(eq(userApiTokens.id, row.id)).catch(() => {});
          req.walletAddress = row.walletAddress;
          (req as any).apiTokenId = row.id;
          return next();
        } catch (err: any) {
          console.log(`[QuantumLab] Bearer auth error: ${err.message}`);
          return res.status(500).json({ error: "Auth lookup failed" });
        }
      }
    }

    const walletAddress = req.session?.walletAddress;
    if (!walletAddress) {
      return res.status(401).json({ error: "Wallet not connected" });
    }
    req.walletAddress = walletAddress;
    next();
  };

  app.get("/api/lab/tickers", (_req: Request, res: Response) => {
    res.json(LAB_AVAILABLE_TICKERS);
  });

  app.get("/api/lab/timeframes", (_req: Request, res: Response) => {
    res.json(LAB_AVAILABLE_TIMEFRAMES);
  });

  app.post("/api/lab/parse-pine", requireLabAuth, (req: Request, res: Response) => {
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

  app.get("/api/lab/debug-compiler/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const { labStrategies } = await import("@shared/schema");
      const [strat] = await db.select().from(labStrategies).where(eq(labStrategies.id, id));
      if (!strat?.pineScript) return res.status(404).json({ error: "Strategy not found" });
      const plan = compilePine(strat.pineScript);
      const candles: any[] = [];
      for (let i = 0; i < 500; i++) {
        const p = 100 + Math.sin(i * 0.1) * 20 + Math.random() * 5;
        candles.push({time: Date.now() - (500-i) * 86400000, open: p, high: p*1.03, low: p*0.97, close: p*(0.98+Math.random()*0.04), volume: 1000+Math.random()*5000});
      }
      const config: PineEngineConfig = { initialCapital: 100, commissionPercent: 0.05, slippageTicks: 1, defaultQtyType: "cash", defaultQtyValue: 100 };
      const parity = runPineParityTest(plan, candles, {}, "TEST/USDT", "1d", config);
      res.json({ strategyId: id, name: strat.name, scriptLength: strat.pineScript.length, astStmts: plan.ast.length, ...parity });
    } catch (err: any) {
      res.status(500).json({ error: err.message, stack: err.stack?.substring(0, 500) });
    }
  });

  app.get("/api/lab/strategies", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const list = await labStorage.getStrategies((req as any).walletAddress);
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategy = await labStorage.getStrategy(parseInt(req.params.id));
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      if (strategy.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(strategy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/strategies", requireLabAuth, async (req: Request, res: Response) => {
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
        userId: (req as any).walletAddress,
      });
      res.json(strategy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/lab/strategies/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategy = await labStorage.getStrategy(parseInt(req.params.id));
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      if (strategy.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = updateLabStrategyBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const updated = await labStorage.updateStrategy(parseInt(req.params.id), parsed.data);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/strategies/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategy = await labStorage.getStrategy(parseInt(req.params.id));
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      if (strategy.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      await labStorage.deleteStrategy(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/strategies/:id/results", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.id);
      if (isNaN(strategyId)) return res.status(400).json({ error: "Invalid strategy ID" });
      const strategy = await labStorage.getStrategy(strategyId);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      if (strategy.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      const cleared = await labStorage.clearStrategyResults(strategyId);
      res.json({ success: true, runsCleared: cleared });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies/:id/top-results", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.id);
      if (isNaN(strategyId)) return res.status(400).json({ error: "Invalid strategy ID" });
      const strategy = await labStorage.getStrategy(strategyId);
      if (strategy?.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
      const results = await labStorage.getTopResultsForStrategy(strategyId, limit);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies/:id/all-results", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.id);
      if (isNaN(strategyId)) return res.status(400).json({ error: "Invalid strategy ID" });
      const data = await labStorage.getAllResultsForStrategy(strategyId);
      if (!data.strategy) return res.status(404).json({ error: "Strategy not found" });
      if (data.strategy.userId && data.strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
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
          sharpeRatio: r.sharpeRatio,
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

  app.post("/api/lab/strategies/:id/insights-report", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.id);
      if (isNaN(strategyId)) return res.status(400).json({ error: "Invalid strategy ID" });
      const strategy = await labStorage.getStrategy(strategyId);
      if (strategy?.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { reportData, totalResults, totalRuns } = req.body;
      if (!reportData || typeof reportData !== "object") return res.status(400).json({ error: "reportData is required" });
      if (!reportData.paramSensitivity || !Array.isArray(reportData.paramSensitivity)) return res.status(400).json({ error: "reportData must contain paramSensitivity array" });
      const report = await labStorage.saveInsightsReport(strategyId, reportData, totalResults ?? 0, totalRuns ?? 0);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/strategies/:id/insights-reports", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.id);
      if (isNaN(strategyId)) return res.status(400).json({ error: "Invalid strategy ID" });
      const strategy = await labStorage.getStrategy(strategyId);
      if (strategy?.userId && strategy.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Access denied" });
      }
      const reports = await labStorage.getInsightsReports(strategyId);
      res.json(reports);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const strategyId = req.query.strategyId ? parseInt(req.query.strategyId as string) : undefined;
      const walletAddress = (req as any).walletAddress;
      const runs = await labStorage.getRuns(strategyId, walletAddress);
      res.json(runs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const verifyRunOwnership = async (req: any, res: any): Promise<any | null> => {
    const runId = parseInt(req.params.id);
    const run = await labStorage.getRun(runId);
    if (!run) { res.status(404).json({ error: "Run not found" }); return null; }
    if (run.userId && run.userId !== req.walletAddress) { res.status(403).json({ error: "Access denied" }); return null; }
    return run;
  };

  app.get("/api/lab/runs/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const run = await verifyRunOwnership(req, res);
      if (!run) return;
      res.json(run);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs/:id/job", requireLabAuth, async (req: Request, res: Response) => {
    const run = await verifyRunOwnership(req, res);
    if (!run) return;
    const runId = parseInt(req.params.id);
    const job = labStorage.getJobByRunId(runId);
    if (job) return res.json({ jobId: job.id });
    if (run.status === "running" || run.status === "paused") {
      return res.status(202).json({ pending: true, status: run.status });
    }
    return res.status(404).json({ error: "No active job for this run" });
  });

  app.post("/api/lab/runs/:id/fail", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const run = await verifyRunOwnership(req, res);
      if (!run) return;
      const runId = parseInt(req.params.id);
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
        pumpQueue();
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/runs/:id/results", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const run = await verifyRunOwnership(req, res);
      if (!run) return;
      const results = await labStorage.getRunResults(parseInt(req.params.id));
      const slim = results.map(r => ({
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
        sharpeRatio: r.sharpeRatio,
        params: r.params,
      }));
      res.json(slim);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/results/:resultId", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const resultId = parseInt(req.params.resultId);
      if (isNaN(resultId)) return res.status(400).json({ error: "Invalid result ID" });
      const result = await labStorage.getResult(resultId);
      if (!result) return res.status(404).json({ error: "Result not found" });
      const run = await labStorage.getRun(result.runId);
      if (run && run.userId && run.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Not authorized" });
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/results/:resultId", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const resultId = parseInt(req.params.resultId);
      if (isNaN(resultId)) return res.status(400).json({ error: "Invalid result ID" });
      const result = await labStorage.getResult(resultId);
      if (!result) return res.status(404).json({ error: "Result not found" });
      const run = await labStorage.getRun(result.runId);
      if (run && run.userId && run.userId !== (req as any).walletAddress) {
        return res.status(403).json({ error: "Not authorized" });
      }
      await labStorage.deleteResult(resultId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/runs/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const run = await verifyRunOwnership(req, res);
      if (!run) return;
      await labStorage.deleteRun(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const WORKER_MAX_OLD_GEN_SIZE_MB = parseInt(process.env.LAB_WORKER_MAX_OLD_GEN_MB || "512", 10);

  function isOOMError(err: Error | string): boolean {
    const msg = typeof err === "string" ? err : (err.message || "");
    const code = typeof err === "object" ? (err as any).code : "";
    return code === "ERR_WORKER_OUT_OF_MEMORY"
      || msg.includes("ERR_WORKER_OUT_OF_MEMORY")
      || msg.includes("heap allocation")
      || msg.includes("JavaScript heap out of memory")
      || msg.includes("Allocation failed");
  }

  function spawnRawWorker(workerDataPayload: any): Worker {
    const isProd = typeof (globalThis as any).__ESBUILD_CJS_BUNDLE__ !== "undefined";
    const resourceLimits = {
      maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_SIZE_MB,
    };
    if (isProd) {
      const workerPath = resolve(dirname(process.argv[1] || __filename), "optimizer-worker.cjs");
      return new Worker(workerPath, { workerData: workerDataPayload, resourceLimits });
    }
    return new Worker(
      `require('tsx/cjs'); require('${resolve(process.cwd(), "server", "lab", "optimizer-worker.ts").replace(/\\/g, "/")}');`,
      { eval: true, workerData: workerDataPayload, resourceLimits }
    );
  }

  function createWorkerPool(args: {
    jobId: string;
    config: any;
    candlesByCombo: Record<string, OHLCV[]>;
    resumeCheckpoint?: LabCheckpoint;
  }): WorkerPool {
    // T001a/b: derive deterministic master seed from jobId so re-runs of the
    // same job are reproducible. Combo-level RNG inside the worker means the
    // result for a given (jobSeed, combo) is identical regardless of pool size.
    const randomSeed = hashStringToSeed(args.jobId);
    return new WorkerPool(spawnRawWorker, {
      jobId: args.jobId,
      config: args.config,
      candlesByCombo: args.candlesByCombo,
      resumeCheckpoint: args.resumeCheckpoint,
      randomSeed,
    });
  }

  let activeWorker: WorkerPool | null = null;
  let lastWorkerOOM = false;
  let workerStarting = false;
  let lastWorkerMessageTime = 0;
  let lastRunStartedAt = 0;
  let workerWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  const WORKER_WATCHDOG_INTERVAL = 30_000;
  const WORKER_STALL_THRESHOLD = 180_000;

  function startWorkerWatchdog() {
    stopWorkerWatchdog();
    workerWatchdogTimer = setInterval(() => {
      if (!activeWorker || workerStarting) return;
      const now = Date.now();
      const silenceMs = lastWorkerMessageTime ? now - lastWorkerMessageTime : 0;
      if (silenceMs > WORKER_STALL_THRESHOLD) {
        console.log(`[QuantumLab] Watchdog: worker stalled (no message for ${Math.round(silenceMs / 1000)}s > ${WORKER_STALL_THRESHOLD / 1000}s threshold). Terminating.`);
        try { activeWorker.terminate(); } catch {}
      }
    }, WORKER_WATCHDOG_INTERVAL);
  }

  function stopWorkerWatchdog() {
    if (workerWatchdogTimer) {
      clearInterval(workerWatchdogTimer);
      workerWatchdogTimer = null;
    }
  }

  // --- Startup-stall watchdog -------------------------------------------------
  // The candle-prefetch phase (fetchAllCandles) runs on the lab MAIN thread with
  // workerStarting=true and activeWorker=null. If that fetch HANGS (network
  // stall, OKX paging wedge, event-loop starvation) instead of throwing, the
  // doStart() promise never settles, so doStart().catch() never fires and
  // workerStarting stays latched true forever. While latched, EVERY other
  // recovery path is gated off: pumpQueue, unifiedScheduler, and the worker
  // watchdog all bail when workerStarting is true. The lab then wedges until a
  // manual process restart. This watchdog is the ONLY recovery timer that is NOT
  // gated by workerStarting: it detects a startup that has made no progress for
  // too long and forces the SAME recovery a thrown fetch error would have
  // (clear the latch, evict the job, pause + auto-resume the run).
  let startupWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  const STARTUP_WATCHDOG_INTERVAL = 30_000;
  const STARTUP_STALL_THRESHOLD = 150_000; // no job progress for 2.5 min pre-worker

  function startStartupWatchdog(jobId: string, runId: number | undefined) {
    stopStartupWatchdog();
    startupWatchdogTimer = setInterval(() => {
      // Only relevant while wedged in the pre-worker startup phase.
      if (activeWorker || !workerStarting) { stopStartupWatchdog(); return; }
      const job = labStorage.getJob(jobId);
      if (!job) {
        // Job vanished (force-evicted / cleaned up) while we're STILL latched in
        // pre-worker startup. Without this branch the latch would stay stuck and
        // re-wedge the lab. Clear it and let the queue re-pump (a paused run is
        // picked back up via interruptedRunIds; nothing eligible is a no-op).
        console.log(`[QuantumLab] Startup watchdog: job ${jobId} gone while still latched in startup — clearing latch and repumping.`);
        stopStartupWatchdog();
        clearActiveWorker();
        setTimeout(() => pumpQueue(), 1000);
        return;
      }
      const stalledMs = Date.now() - job.lastUpdated;
      if (stalledMs <= STARTUP_STALL_THRESHOLD) return; // still fetching/progressing
      const reason = `Startup stalled: no progress for ${Math.round(stalledMs / 1000)}s before worker spawned`;
      console.log(`[QuantumLab] Startup watchdog: job ${jobId} (run ${runId ?? "n/a"}) wedged in startup — worker never spawned, ${reason}. Forcing recovery.`);
      stopStartupWatchdog();
      labStorage.updateProgress(jobId, {
        jobId, status: "error", stage: `Error: ${reason}`,
        current: 0, total: 0, percent: 0, elapsed: 0, error: reason,
      });
      clearActiveWorker(); // resets workerStarting=false → ungates pumpQueue/scheduler/watchdog
      if (runId) {
        labStorage.pauseRun(runId)
          .then(() => autoRetryAfterCrash(runId, jobId, reason))
          .catch(() => { labStorage.failRun(runId).catch(() => {}); });
      } else {
        setTimeout(() => pumpQueue(), 1000);
      }
    }, STARTUP_WATCHDOG_INTERVAL);
  }

  function stopStartupWatchdog() {
    if (startupWatchdogTimer) {
      clearInterval(startupWatchdogTimer);
      startupWatchdogTimer = null;
    }
  }

  function clearActiveWorker() {
    activeWorker = null;
    workerStarting = false;
    lastWorkerMessageTime = 0;
    stopKeepAlive();
    stopWorkerWatchdog();
    stopStartupWatchdog();
  }

  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  const keepAlivePingUrl = (() => {
    const replitDomains = process.env.REPLIT_DOMAINS;
    const replitDevDomain = process.env.REPLIT_DEV_DOMAIN;
    const replSlug = process.env.REPL_SLUG;
    const replOwner = process.env.REPL_OWNER;

    if (replitDomains) {
      return `https://${replitDomains.split(",")[0]}/health`;
    }
    if (replitDevDomain) {
      return `https://${replitDevDomain}/health`;
    }
    if (replSlug && replOwner) {
      return `https://${replSlug}.${replOwner}.repl.co/health`;
    }
    return `http://127.0.0.1:${process.env.PORT || "5000"}/health`;
  })();

  function hasWorkPending(): boolean {
    return !!activeWorker || workerStarting || labStorage.interruptedRunIds.length > 0;
  }

  let keepAlivePingCount = 0;
  function startKeepAlive() {
    if (keepAliveTimer) return;
    const isExternal = keepAlivePingUrl.startsWith("https://");
    console.log(`[QuantumLab] Keep-alive started → ${isExternal ? "EXTERNAL" : "LOCAL"} ping: ${keepAlivePingUrl}`);
    keepAlivePingCount = 0;
    keepAliveTimer = setInterval(() => {
      if (!hasWorkPending()) {
        console.log(`[QuantumLab] Keep-alive stopped (no work pending, ${keepAlivePingCount} pings sent)`);
        stopKeepAlive();
        return;
      }
      keepAlivePingCount++;
      fetch(keepAlivePingUrl).catch((err) => {
        console.log(`[QuantumLab] Keep-alive ping #${keepAlivePingCount} failed: ${err.message}`);
      });
    }, 25_000);
  }
  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

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
    prefetchedCandles?: Record<string, OHLCV[]>,
    guidedInsights?: import("@shared/schema").GuidedInsights,
    guidedInsightsPerCombo?: Record<string, import("@shared/schema").GuidedInsights>,
    processOrdersOnClose?: boolean,
  ) {
    workerStarting = true;
    lastRunStartedAt = Date.now();
    startStartupWatchdog(job.id, runId);
    const completedCombos: string[] = resumeCheckpoint?.completedCombos ? [...resumeCheckpoint.completedCombos] : [];
    let checkpointState: Partial<LabCheckpoint> = resumeCheckpoint ? { ...resumeCheckpoint } : {};
    let checkpointWriteChain: Promise<void> = Promise.resolve();
    let pendingCheckpoint: any = null;
    let checkpointWriteInFlight = false;

    const doStart = async () => {
      // Write an initial heartbeat IMMEDIATELY so the orphan scheduler doesn't kill
      // the run while we're fetching candles (which can take 30-60s for cold caches).
      // This is also what protects a resumed run whose checkpoint heartbeat is stale.
      if (runId) {
        try {
          checkpointState.lastHeartbeat = Date.now();
          const initHb: LabCheckpoint = { completedCombos: [...completedCombos], configSnapshot: config, ...checkpointState } as LabCheckpoint;
          await labStorage.saveCheckpoint(runId, initHb);
        } catch {}
      }

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

      const worker = createWorkerPool({
        jobId: job.id,
        config: {
          tickers: config.tickers,
          timeframes: config.timeframes,
          randomSamples: config.randomSamples,
          topK: config.topK,
          refinementsPerSeed: config.refinementsPerSeed,
          minTrades: config.minTrades,
          maxDrawdownCap: config.maxDrawdownCap,
          minAvgBarsHeld: config.minAvgBarsHeld ?? 1,
          parsedInputs: config.parsedInputs,
          processOrdersOnClose,
          guidedInsights,
          guidedInsightsPerCombo,
          deepSearch: config.deepSearch ?? false,
          coordinateTune: config.coordinateTune ?? false,
          pineScript: config.pineScript,
          strategyId: config.strategyId,
          engineType: config.engineType,
        },
        candlesByCombo,
        resumeCheckpoint,
      });
      console.log(`[QuantumLab] Spawned worker pool size=${worker.poolSize} for job ${job.id}`);

      activeWorker = worker;
      workerStarting = false;
      stopStartupWatchdog();
      lastWorkerOOM = false;
      lastWorkerMessageTime = Date.now();
      startKeepAlive();
      startWorkerWatchdog();

      if (runId) {
        checkpointWriteChain = checkpointWriteChain.then(async () => {
          try {
            checkpointState.lastHeartbeat = Date.now();
            const hbCheckpoint: LabCheckpoint = { completedCombos: [...completedCombos], configSnapshot: config, ...checkpointState } as LabCheckpoint;
            await labStorage.saveCheckpoint(runId!, hbCheckpoint);
          } catch {}
        });
      }

      let doneReceived = false;
      let comboPersistFailure: string | null = null;

      worker.on("message", async (msg: any) => {
        lastWorkerMessageTime = Date.now();
        switch (msg.type) {
          case "progress":
            if (msg.data.status === "complete") break;
            labStorage.updateProgress(job.id, msg.data);
            break;

          case "best-discovery":
            if (!runId) break;
            checkpointWriteChain = checkpointWriteChain.then(async () => {
              try {
                const existing = checkpointState.bestDiscovery;
                if (!existing || existing.combo !== msg.combo || msg.score > existing.score) {
                  checkpointState.bestDiscovery = {
                    combo: msg.combo,
                    stage: msg.stage,
                    deepRound: msg.deepRound,
                    score: msg.score,
                    params: msg.params,
                  };
                  const checkpoint: LabCheckpoint = {
                    completedCombos: [...completedCombos],
                    configSnapshot: config,
                    ...checkpointState,
                  } as LabCheckpoint;
                  await labStorage.saveCheckpoint(runId!, checkpoint);
                }
              } catch (err: any) {
                console.log(`[QuantumLab] Best-discovery checkpoint warning: ${err.message}`);
              }
            });
            break;

          case "partial-checkpoint":
            if (!runId || doneReceived) break;
            pendingCheckpoint = msg;
            if (!checkpointWriteInFlight) {
              checkpointWriteInFlight = true;
              checkpointWriteChain = checkpointWriteChain.then(async () => {
                while (pendingCheckpoint) {
                  const cp = pendingCheckpoint;
                  pendingCheckpoint = null;
                  if (job.abortSignal.aborted || doneReceived) break;
                  try {
                    // Do NOT persist lite/partial results to lab_optimization_results.
                    // They lack trades/equityCurve and would surface as empty rows in
                    // the UI. Instead store them in checkpoint state for resume.
                    checkpointState = {
                      ...checkpointState,
                      currentCombo: cp.combo,
                      currentStage: cp.stage,
                      currentIteration: cp.iteration,
                      currentDeepRound: cp.deepRound,
                      refineSeeds: cp.refineSeeds,
                      coordinateCompleted: cp.coordinateCompleted,
                      partialResults: Array.isArray(cp.results) ? cp.results : undefined,
                      lastHeartbeat: Date.now(),
                    };
                    const checkpoint: LabCheckpoint = {
                      completedCombos: [...completedCombos],
                      configSnapshot: config,
                      ...checkpointState,
                    } as LabCheckpoint;
                    await labStorage.saveCheckpoint(runId!, checkpoint);
                  } catch (err: any) {
                    console.log(`[QuantumLab] Partial checkpoint error: ${err.message}`);
                  }
                }
                checkpointWriteInFlight = false;
              });
            }
            break;

          case "combo-complete":
            completedCombos.push(msg.combo);
            if (msg.disposition) {
              // Record the worker's per-combo terminal disposition in the
              // checkpoint state so it persists across resume and the
              // completion invariant can tell a legit-empty combo apart from a
              // real coverage gap.
              checkpointState.comboDispositions = {
                ...(checkpointState.comboDispositions ?? {}),
                [msg.combo]: msg.disposition,
              };
            }
            if (!runId) break;
            checkpointWriteChain = checkpointWriteChain.then(async () => {
              if (job.abortSignal.aborted) return;
              try {
                if (msg.results.length > 0) {
                  try {
                    await labStorage.saveComboResults(runId!, msg.results);
                  } catch (saveErr: any) {
                    // Hard failure persisting full combo results (e.g. invariant
                    // check in saveComboResults). Pause the run immediately and
                    // abort the worker so we never silently advance to a
                    // "complete" state with missing data.
                    comboPersistFailure = comboPersistFailure ?? `${msg.combo}: ${saveErr.message}`;
                    console.log(`[QuantumLab] combo-complete save failed for ${msg.combo} (run ${runId}): ${saveErr.message}`);
                    try { await labStorage.pauseRun(runId!); } catch {}
                    labStorage.updateProgress(job.id, {
                      jobId: job.id, status: "error",
                      stage: `Persist failed for ${msg.combo}: ${saveErr.message}`,
                      current: 0, total: 0, percent: 0, elapsed: 0, error: saveErr.message,
                    });
                    if (activeWorker) {
                      try { activeWorker.postMessage({ type: "abort" }); } catch {}
                      try { activeWorker.terminate(); } catch {}
                      clearActiveWorker();
                    }
                    return;
                  }
                }
                checkpointState = {
                  comboDispositions: checkpointState.comboDispositions,
                  currentCombo: undefined,
                  currentStage: undefined,
                  currentIteration: undefined,
                  partialResults: undefined,
                  bestDiscovery: undefined,
                  lastHeartbeat: Date.now(),
                };
                const checkpoint: LabCheckpoint = {
                  completedCombos: [...completedCombos],
                  configSnapshot: config,
                  ...checkpointState,
                } as LabCheckpoint;
                (checkpoint as any).autoResumeAttempts = 0;
                await labStorage.saveCheckpoint(runId!, checkpoint);
                console.log(`[QuantumLab] Checkpoint saved: ${completedCombos.length} combos done (run ${runId})`);
              } catch (err: any) {
                console.log(`[QuantumLab] Checkpoint save error: ${err.message}`);
              }
            });
            break;

          case "done": {
            doneReceived = true;
            pendingCheckpoint = null;
            clearActiveWorker();
            await checkpointWriteChain.catch(() => {});
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
                // If any combo-complete save failed mid-run, refuse to finalize.
                if (comboPersistFailure) {
                  const invMsg = `Run paused: combo persist failure (${comboPersistFailure}). Will not finalize as complete.`;
                  console.log(`[QuantumLab] ${invMsg} (run ${runId})`);
                  try { await labStorage.pauseRun(runId); } catch {}
                  labStorage.updateProgress(job.id, {
                    jobId: job.id, status: "error", stage: invMsg,
                    current: 0, total: 0, percent: 0, elapsed: 0, error: invMsg,
                  });
                  clearActiveWorker();
                  setTimeout(() => pumpQueue(), 1000);
                  break;
                }
                // Completion invariant: (a) every expected combo (ticker × tf)
                // must have at least one persisted row with a non-empty
                // equityCurve, and (b) no persisted row with totalTrades > 0
                // may be missing trades/equityCurve. If either fails, pause
                // the run instead of marking it complete.
                try {
                  const persisted = await labStorage.getRunResults(runId);
                  const bad = persisted.filter(r => {
                    if ((r.totalTrades ?? 0) === 0) return false;
                    const ec = r.equityCurve as any[] | null | undefined;
                    const tr = r.trades as any[] | null | undefined;
                    return !Array.isArray(ec) || ec.length === 0 || !Array.isArray(tr) || tr.length === 0;
                  });
                  if (bad.length > 0) {
                    const sample = bad.slice(0, 3).map(r => `${r.ticker}|${r.timeframe}#${r.rank}`).join(", ");
                    const invMsg = `Completion invariant failed: ${bad.length}/${persisted.length} results missing trades/equityCurve (e.g. ${sample}). Pausing run for investigation.`;
                    console.log(`[QuantumLab] ${invMsg} (run ${runId})`);
                    try { await labStorage.pauseRun(runId); } catch {}
                    labStorage.updateProgress(job.id, {
                      jobId: job.id, status: "error", stage: invMsg,
                      current: 0, total: 0, percent: 0, elapsed: 0, error: invMsg,
                    });
                    clearActiveWorker();
                    setTimeout(() => pumpQueue(), 1000);
                    break;
                  }
                  // Per-combo coverage. Every expected combo must reach a known
                  // terminal state. A combo is fine when EITHER it persisted ≥1
                  // row with a non-empty equityCurve, OR the worker reported a
                  // legitimate empty disposition for it:
                  //   - "data-unavailable": no candles could be fetched
                  //   - "no-trades": no parameter set met the trade filters
                  // Only flag combos the worker never accounted for (a genuine
                  // gap), or that it reported as "ok" yet left no usable rows
                  // (results produced but lost on persist). Both are real
                  // failures and pause the run (fail closed). Legitimately empty
                  // combos must NOT pause — that was the ORE pause→pump spam loop.
                  const expectedCombos = new Set<string>();
                  for (const ticker of config.tickers) {
                    for (const tf of config.timeframes) {
                      expectedCombos.add(`${ticker}|${tf}`);
                    }
                  }
                  const goodCombos = new Set<string>();
                  for (const r of persisted) {
                    const ec = r.equityCurve as any[] | null | undefined;
                    if (Array.isArray(ec) && ec.length > 0) {
                      goodCombos.add(`${r.ticker}|${r.timeframe}`);
                    }
                  }
                  const dispositions = checkpointState.comboDispositions ?? {};
                  const emptyCombos: string[] = [];   // legit no-data / no-trades
                  const problemCombos: string[] = []; // never reported, or lost rows
                  expectedCombos.forEach(k => {
                    if (goodCombos.has(k)) return;
                    const disp = dispositions[k];
                    if (disp && (disp.status === "data-unavailable" || disp.status === "no-trades")) {
                      emptyCombos.push(k);
                    } else {
                      problemCombos.push(k);
                    }
                  });
                  if (emptyCombos.length > 0) {
                    const sample = emptyCombos.slice(0, 8).map(k => `${k} (${dispositions[k]?.status ?? "empty"})`).join(", ");
                    console.log(`[QuantumLab] Run ${runId}: ${emptyCombos.length}/${expectedCombos.size} combos produced no results — ${sample}`);
                  }
                  if (problemCombos.length > 0) {
                    const sample = problemCombos.slice(0, 5).join(", ");
                    const invMsg = `Completion invariant failed: ${problemCombos.length}/${expectedCombos.size} combos have no result and no terminal disposition (e.g. ${sample}). Pausing run for investigation.`;
                    console.log(`[QuantumLab] ${invMsg} (run ${runId})`);
                    try { await labStorage.pauseRun(runId); } catch {}
                    labStorage.updateProgress(job.id, {
                      jobId: job.id, status: "error", stage: invMsg,
                      current: 0, total: 0, percent: 0, elapsed: 0, error: invMsg,
                    });
                    clearActiveWorker();
                    setTimeout(() => pumpQueue(), 1000);
                    break;
                  }
                } catch (invErr: any) {
                  // Fail closed: if the completion invariant itself errors (e.g.
                  // a transient DB read failure), we cannot verify coverage, so
                  // we must NOT mark the run successful. Pause for investigation
                  // (bounded by MAX_AUTO_RESUME_ATTEMPTS) instead of falling
                  // through to finalizeSuccessfulRun.
                  const invMsg = `Completion invariant check errored: ${invErr.message}. Pausing run for investigation.`;
                  console.log(`[QuantumLab] ${invMsg} (run ${runId})`);
                  try { await labStorage.pauseRun(runId); } catch {}
                  labStorage.updateProgress(job.id, {
                    jobId: job.id, status: "error", stage: invMsg,
                    current: 0, total: 0, percent: 0, elapsed: 0, error: invMsg,
                  });
                  clearActiveWorker();
                  setTimeout(() => pumpQueue(), 1000);
                  break;
                }
                try {
                  let totalConfigsTested: number;
                  if (msg.totalConfigsTested !== undefined) {
                    totalConfigsTested = msg.totalConfigsTested;
                  } else {
                    const totalSamples = config.randomSamples + config.topK * config.refinementsPerSeed;
                    const combos = config.tickers.length * config.timeframes.length;
                    totalConfigsTested = totalSamples * combos;
                  }
                  const finalCheckpoint: LabCheckpoint = { completedCombos: [], configSnapshot: config };
                  await labStorage.finalizeSuccessfulRun(runId, totalConfigsTested, finalCheckpoint);
                  console.log(`[QuantumLab] Run ${runId} completed`);
                  if (config.strategyId) {
                    labStorage.deduplicateStrategyResults(config.strategyId, runId).then(removed => {
                      if (removed > 0) console.log(`[QuantumLab] Dedup: removed ${removed} duplicate results for strategy ${config.strategyId}`);
                    }).catch(err => console.log(`[QuantumLab] Dedup error for strategy ${config.strategyId}: ${err.message}`));
                  }
                } catch (err: any) {
                  console.log(`[QuantumLab] Failed to complete run: ${err.stack || err.message}`);
                  try {
                    await labStorage.pauseRun(runId);
                  } catch {}
                  labStorage.updateProgress(job.id, {
                    jobId: job.id, status: "error", stage: `DB finalization failed: ${err.message}`,
                    current: 0, total: 0, percent: 0, elapsed: 0, error: err.message,
                  });
                  setTimeout(() => pumpQueue(), 1000);
                  break;
                }
              }
              labStorage.updateProgress(job.id, {
                jobId: job.id, status: "complete", stage: "Optimization complete",
                current: 0, total: 0, percent: 100, elapsed: 0,
              });
            }
            clearActiveWorker();
            setTimeout(() => pumpQueue(), 1000);
            break;
          }

          case "error": {
            clearActiveWorker();
            await checkpointWriteChain.catch(() => {});
            const isResource = msg.isResourceError || isOOMError(msg.message || "");
            const errorLabel = isResource ? "Resource limit exceeded" : "Error";
            console.log(`[QuantumLab] Worker error (resource=${isResource}): ${msg.message}`);
            labStorage.updateProgress(job.id, {
              jobId: job.id, status: "error", stage: `${errorLabel}: ${msg.message}`,
              current: 0, total: 0, percent: 0, elapsed: 0, error: msg.message,
            });
            if (runId) {
              try {
                await labStorage.pauseRun(runId);
                if (isResource) {
                  const cpData = await labStorage.getCheckpoint(runId);
                  if (cpData) { cpData.resourceError = true; await labStorage.saveCheckpoint(runId, cpData); }
                  console.log(`[QuantumLab] Run ${runId} resource error → paused (no auto-retry)`);
                  setTimeout(() => pumpQueue(), 1000);
                  break;
                }
                console.log(`[QuantumLab] Run ${runId} error → paused, will auto-retry`);
                autoRetryAfterCrash(runId, job.id, msg.message);
                break;
              } catch {}
            }
            setTimeout(() => pumpQueue(), 1000);
            break;
          }
        }
      });

      worker.on("error", async (err: Error) => {
        clearActiveWorker();
        await checkpointWriteChain.catch(() => {});
        const oom = isOOMError(err);
        if (oom) lastWorkerOOM = true;
        const errorLabel = oom ? "Resource limit exceeded" : "Worker error";
        console.log(`[QuantumLab] Worker thread error (oom=${oom}): ${err.message}`);
        labStorage.updateProgress(job.id, {
          jobId: job.id, status: "error", stage: `${errorLabel}: ${err.message}`,
          current: 0, total: 0, percent: 0, elapsed: 0, error: err.message,
        });
        if (runId) {
          try {
            await labStorage.pauseRun(runId);
            if (oom) {
              const cpData = await labStorage.getCheckpoint(runId);
              if (cpData) { cpData.resourceError = true; await labStorage.saveCheckpoint(runId, cpData); }
              console.log(`[QuantumLab] Worker OOM run ${runId} → paused (no auto-retry)`);
              setTimeout(() => pumpQueue(), 1000);
              return;
            }
            console.log(`[QuantumLab] Worker error run ${runId} → paused, will auto-retry`);
            autoRetryAfterCrash(runId, job.id, err.message);
            return;
          } catch { await labStorage.failRun(runId).catch(() => {}); }
        }
        setTimeout(() => pumpQueue(), 1000);
      });

      worker.on("exit", async (code: number) => {
        if (code !== 0 && activeWorker === worker) {
          clearActiveWorker();
          await checkpointWriteChain.catch(() => {});
          const exitMsg = `Worker exited with code ${code}`;
          const oom = lastWorkerOOM;
          console.log(`[QuantumLab] ${exitMsg} (oom=${oom})`);
          if (runId) {
            try {
              const currentRun = await labStorage.getRun(runId);
              if (currentRun?.status === "complete" || currentRun?.status === "completed" || currentRun?.status === "failed") {
                console.log(`[QuantumLab] Worker exit(${code}) run ${runId} — already ${currentRun.status}, ignoring`);
                setTimeout(() => pumpQueue(), 1000);
                return;
              }
              await labStorage.pauseRun(runId);
              if (oom) {
                const cpData = await labStorage.getCheckpoint(runId);
                if (cpData) { cpData.resourceError = true; await labStorage.saveCheckpoint(runId, cpData); }
                labStorage.updateProgress(job.id, {
                  jobId: job.id, status: "error", stage: `Resource limit exceeded: ${exitMsg}`,
                  current: 0, total: 0, percent: 0, elapsed: 0, error: exitMsg,
                });
                console.log(`[QuantumLab] Worker OOM exit run ${runId} → paused (no auto-retry)`);
                setTimeout(() => pumpQueue(), 1000);
                return;
              }
              console.log(`[QuantumLab] Worker exit(${code}) run ${runId} → paused, will auto-retry`);
              autoRetryAfterCrash(runId, job.id, exitMsg);
              return;
            } catch { await labStorage.failRun(runId).catch(() => {}); }
          }
          setTimeout(() => pumpQueue(), 1000);
        }
      });
    };

    doStart().catch(async (err: any) => {
      console.log(`[QuantumLab] Failed to start optimization: ${err.message}`);
      labStorage.updateProgress(job.id, {
        jobId: job.id, status: "error", stage: `Error: ${err.message}`,
        current: 0, total: 0, percent: 0, elapsed: 0, error: err.message,
      });
      clearActiveWorker();
      if (runId) {
        try {
          await labStorage.pauseRun(runId);
          autoRetryAfterCrash(runId, job.id, err.message);
        } catch { await labStorage.failRun(runId).catch(() => {}); }
      }
    });
  }

  let pendingRetryRunId: number | null = null;
  let retryGeneration = 0;

  async function autoRetryAfterCrash(runId: number, oldJobId: string, errorMsg: string) {
    if (pendingRetryRunId === runId) {
      console.log(`[QuantumLab] Auto-retry already pending for run ${runId}, skipping duplicate`);
      return;
    }
    const myGeneration = retryGeneration;
    pendingRetryRunId = runId;

    try {
      const run = await labStorage.getRun(runId);
      if (!run || run.status !== "paused") {
        setTimeout(() => pumpQueue(), 1000);
        return;
      }

      const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
      if (cp?.userCancelled) {
        setTimeout(() => pumpQueue(), 1000);
        return;
      }
      const crashCount = (cp?.autoResumeAttempts as number) ?? 0;
      if (crashCount >= MAX_AUTO_RESUME_ATTEMPTS) {
        console.log(`[QuantumLab] Auto-retry exhausted for run ${runId} (${crashCount}/${MAX_AUTO_RESUME_ATTEMPTS}). Manual resume required.`);
        await labStorage.failRun(runId, true);
        labStorage.updateProgress(oldJobId, {
          jobId: oldJobId, status: "error", stage: `Failed after ${crashCount} retries: ${errorMsg}`,
          current: 0, total: 0, percent: 0, elapsed: 0, error: `Failed after ${crashCount} retries: ${errorMsg}`,
        });
        setTimeout(() => pumpQueue(), 1000);
        return;
      }

      cp.autoResumeAttempts = crashCount + 1;
      await labStorage.saveCheckpoint(runId, cp);

      const retryIn = 3;
      const attempt = crashCount + 1;
      console.log(`[QuantumLab] Auto-retry run ${runId} in ${retryIn}s (attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS})`);
      labStorage.updateProgress(oldJobId, {
        jobId: oldJobId, status: "retrying", stage: `Retrying in ${retryIn}s (attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS})...`,
        current: 0, total: 0, percent: 0, elapsed: 0,
      });

      await new Promise(resolve => setTimeout(resolve, retryIn * 1000));

      if (myGeneration !== retryGeneration) {
        console.log(`[QuantumLab] Auto-retry aborted after delay for run ${runId} — generation changed (${myGeneration} → ${retryGeneration})`);
        labStorage.updateProgress(oldJobId, { jobId: oldJobId, status: "error", stage: "Retry aborted (superseded)", current: 0, total: 0, percent: 0, elapsed: 0 });
        setTimeout(() => pumpQueue(), 1000);
        return;
      }

      const freshRun = await labStorage.getRun(runId);
      if (!freshRun || freshRun.status !== "paused") {
        console.log(`[QuantumLab] Auto-retry aborted — run ${runId} status changed to ${freshRun?.status}`);
        labStorage.updateProgress(oldJobId, { jobId: oldJobId, status: "error", stage: "Retry aborted (status changed)", current: 0, total: 0, percent: 0, elapsed: 0 });
        setTimeout(() => pumpQueue(), 1000);
        return;
      }
      const freshCp = freshRun.checkpoint && typeof freshRun.checkpoint === "object" ? freshRun.checkpoint as any : null;
      if (freshCp?.userCancelled) {
        console.log(`[QuantumLab] Auto-retry aborted — run ${runId} was cancelled during delay`);
        labStorage.updateProgress(oldJobId, { jobId: oldJobId, status: "error", stage: "Retry aborted (cancelled)", current: 0, total: 0, percent: 0, elapsed: 0 });
        setTimeout(() => pumpQueue(), 1000);
        return;
      }

      if (activeWorker || workerStarting) {
        console.log(`[QuantumLab] Auto-retry skipped — another worker already active/starting`);
        labStorage.updateProgress(oldJobId, { jobId: oldJobId, status: "error", stage: "Retry skipped (worker busy)", current: 0, total: 0, percent: 0, elapsed: 0 });
        return;
      }

      const safeCp = cp ?? { completedCombos: [], configSnapshot: null } as any;
      const hasProgress = safeCp.completedCombos?.length > 0 || (safeCp.currentCombo && safeCp.currentIteration != null);
      const checkpoint: LabCheckpoint = freshCp ?? safeCp;
      const config = await extractConfigForResume(checkpoint, runId);
      if (!config) {
        console.log(`[QuantumLab] Auto-retry: unrecoverable config for run ${runId}, failing`);
        await labStorage.failRun(runId, true);
        setTimeout(() => pumpQueue(), 1000);
        return;
      }
      checkpoint.configSnapshot = config;

      if (hasProgress && checkpoint.currentCombo && !checkpoint.partialResults?.length) {
        const dbResults = await labStorage.getRunResults(runId);
        const comboResults = dbResults.filter(r => `${r.ticker}|${r.timeframe}` === checkpoint.currentCombo);
        if (comboResults.length > 0) {
          checkpoint.partialResults = comboResults.map(r => ({
            ticker: r.ticker, timeframe: r.timeframe,
            netProfitPercent: r.netProfitPercent, winRatePercent: r.winRatePercent,
            maxDrawdownPercent: r.maxDrawdownPercent, profitFactor: r.profitFactor,
            totalTrades: r.totalTrades, params: r.params as Record<string, any>,
            trades: (r.trades as any[]) ?? [], equityCurve: (r.equityCurve as any[]) ?? [],
          }));
        }
      }

      let retryPooc: boolean | undefined;
      if (freshRun.strategyId) {
        const strat = await labStorage.getStrategy(freshRun.strategyId);
        if (strat?.strategySettings && typeof strat.strategySettings === "object") {
          retryPooc = (strat.strategySettings as any).processOrdersOnClose;
          if ((strat.strategySettings as any).nativeEngine) {
            delete config.pineScript;
            config.engineType = (strat.strategySettings as any).engineType;
          }
        }
        if (!config.pineScript && strat?.pineScript && !(strat.strategySettings as any)?.nativeEngine) {
          config.pineScript = strat.pineScript;
        }
      }

      const claimed = await labStorage.claimPausedRunForResume(runId);
      if (!claimed) {
        console.log(`[QuantumLab] Auto-retry: failed to claim run ${runId} (already running or status changed)`);
        labStorage.updateProgress(oldJobId, { jobId: oldJobId, status: "error", stage: "Retry skipped (claim failed)", current: 0, total: 0, percent: 0, elapsed: 0 });
        setTimeout(() => pumpQueue(), 1000);
        return;
      }

      let startedOk = false;
      try {
        const newJob = labStorage.createJob(config, { forRunId: runId, hasActiveWorker: false });
        newJob.runId = runId;
        newJob.walletAddress = freshRun.userId ?? undefined;

        labStorage.updateProgress(oldJobId, {
          jobId: oldJobId, status: "retrying", stage: `Retrying...`,
          current: 0, total: 0, percent: 0, elapsed: 0, newJobId: newJob.id,
        });

        const resumeCheckpoint = hasProgress
          ? checkpoint
          : { completedCombos: [], configSnapshot: config, autoResumeAttempts: checkpoint.autoResumeAttempts } as LabCheckpoint;
        const detail = hasProgress
          ? (checkpoint.completedCombos?.length
            ? `${checkpoint.completedCombos.length} combos done`
            : `mid-combo ${checkpoint.currentCombo} at iter ${checkpoint.currentIteration}`)
          : "from scratch";
        console.log(`[QuantumLab] Auto-retrying run ${runId} (${detail}, attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS})`);
        startOptimizationJob(config, newJob, runId, resumeCheckpoint, undefined, undefined, undefined, retryPooc);
        startedOk = true;
      } finally {
        if (!startedOk) {
          console.log(`[QuantumLab] Auto-retry: startup failed for run ${runId}, rolling back claim`);
          await labStorage.pauseRun(runId).catch(() => {});
          setTimeout(() => pumpQueue(), 1000);
        }
      }
    } catch (err: any) {
      console.log(`[QuantumLab] Auto-retry error: ${err.message}`);
      labStorage.updateProgress(oldJobId, { jobId: oldJobId, status: "error", stage: `Retry error: ${err.message}`, current: 0, total: 0, percent: 0, elapsed: 0, error: err.message });
      setTimeout(() => pumpQueue(), 1000);
    } finally {
      pendingRetryRunId = null;
    }
  }

  function extractGuidedInsights(rd: any): import("@shared/schema").GuidedInsights | null {
    if (!rd?.paramSensitivity || !Array.isArray(rd.paramSensitivity)) return null;
    const result: import("@shared/schema").GuidedInsights = {
      paramSensitivity: rd.paramSensitivity.map((ps: any) => ({
        name: ps.name, type: ps.type, impactScore: ps.impactScore ?? 0,
        bestBucket: ps.bestBucket ? { rangeMin: ps.bestBucket.rangeMin, rangeMax: ps.bestBucket.rangeMax } : { rangeMin: 0, rangeMax: 0 },
      })),
    };
    if (rd.topBottomConfigs?.top && Array.isArray(rd.topBottomConfigs.top) && rd.topBottomConfigs.top.length > 0) {
      result.topConfigs = rd.topBottomConfigs.top.map((c: any) => ({ params: c.params, score: c.netProfitPercent ?? 0 }));
    }
    return result;
  }

  async function computeGuidedInsightsForConfig(strategyId: number, tickers: string[], timeframes: string[]): Promise<{
    guidedInsights?: import("@shared/schema").GuidedInsights;
    guidedInsightsPerCombo?: Record<string, import("@shared/schema").GuidedInsights>;
  }> {
    const allReports = await labStorage.getInsightsReports(strategyId);
    let guidedInsights: import("@shared/schema").GuidedInsights | undefined;
    let guidedInsightsPerCombo: Record<string, import("@shared/schema").GuidedInsights> | undefined;

    const perComboMap: Record<string, import("@shared/schema").GuidedInsights> = {};
    for (const t of tickers) {
      for (const tf of timeframes) {
        const key = `${t}|${tf}`;
        const matchingReport = allReports.find(r => {
          const rd = r.reportData as any;
          return rd?.filter?.ticker === t && rd?.filter?.timeframe === tf;
        });
        if (matchingReport) {
          const insights = extractGuidedInsights(matchingReport.reportData as any);
          if (insights) perComboMap[key] = insights;
        }
      }
    }
    if (Object.keys(perComboMap).length > 0) guidedInsightsPerCombo = perComboMap;

    const latestGeneral = allReports.find(r => !(r.reportData as any)?.filter?.ticker) ?? allReports[0];
    if (latestGeneral) {
      guidedInsights = extractGuidedInsights(latestGeneral.reportData as any) ?? undefined;
    }

    return { guidedInsights, guidedInsightsPerCombo };
  }

  let pumpQueueRunning = false;
  async function pumpQueue() {
    if (pumpQueueRunning) {
      console.log(`[QuantumLab] pumpQueue: already running, skipping`);
      return;
    }
    pumpQueueRunning = true;
    try {
      if (activeWorker || workerStarting) {
        console.log(`[QuantumLab] pumpQueue: worker still active/starting, skipping until it finishes`);
        return;
      }

      const activeJobs = Array.from((labStorage as any).jobs?.values?.() ?? []).filter(
        (j: any) => j.progress?.status !== "complete" && j.progress?.status !== "error"
      );
      if (activeJobs.length > 0) {
        console.log(`[QuantumLab] pumpQueue: ${activeJobs.length} in-memory job(s) still active, skipping`);
        return;
      }

      if (labStorage.interruptedRunIds.length > 0) {
        console.log(`[QuantumLab] pumpQueue: ${labStorage.interruptedRunIds.length} interrupted run(s) pending — resuming paused runs before new ones`);
        pumpQueueRunning = false;
        await resumeNextInterruptedRun();
        return;
      }

      const claimed = await labStorage.claimNextQueuedRun();
      if (!claimed) {
        console.log(`[QuantumLab] pumpQueue: no eligible queued runs`);
        return;
      }

      console.log(`[QuantumLab] pumpQueue: claimed run ${claimed.id} (strategy ${claimed.strategyId})`);

      const snapshot = claimed.configSnapshot as any;
      if (!snapshot) {
        console.log(`[QuantumLab] pumpQueue: run ${claimed.id} has no config snapshot, marking failed`);
        await labStorage.failRun(claimed.id);
        setTimeout(() => pumpQueue(), 100);
        return;
      }

      const snapshotType: "new" | "refine" = snapshot.type === "refine" ? "refine" : "new";
      const unwrapped = unwrapCheckpointConfig(snapshot) ?? (snapshot.config || snapshot);
      const config: LabOptimizationConfig = unwrapped as LabOptimizationConfig;
      if (!Array.isArray(config.tickers)) {
        console.log(`[QuantumLab] pumpQueue: run ${claimed.id} has invalid config (no tickers), marking failed`);
        await labStorage.failRun(claimed.id);
        setTimeout(() => pumpQueue(), 100);
        return;
      }
      const processOrdersOnClose: boolean | undefined = snapshot.processOrdersOnClose;
      const guidedInsights: import("@shared/schema").GuidedInsights | undefined = snapshot.guidedInsights;
      const guidedInsightsPerCombo: Record<string, import("@shared/schema").GuidedInsights> | undefined = snapshot.guidedInsightsPerCombo;

      if (claimed.strategyId) {
        const strat = await labStorage.getStrategy(claimed.strategyId);
        if ((strat?.strategySettings as any)?.nativeEngine) {
          delete config.pineScript;
          config.engineType = (strat.strategySettings as any).engineType;
        } else if (!config.pineScript && strat?.pineScript) {
          config.pineScript = strat.pineScript;
        }
      }

      if (snapshotType === "refine") {
        config.coordinateTune = true;
        config.useInsights = true;
        console.log(`[QuantumLab] pumpQueue: dispatching REFINE run ${claimed.id} (source=${snapshot.sourceRunId}, ${snapshot.targetTicker}|${snapshot.targetTimeframe})`);
      } else {
        console.log(`[QuantumLab] pumpQueue: dispatching NEW run ${claimed.id}`);
      }

      let job: any;
      try {
        job = labStorage.createJob(config, { hasActiveWorker: !!activeWorker });
        job.runId = claimed.id;
        job.walletAddress = claimed.userId ?? undefined;
        await labStorage.saveCheckpoint(claimed.id, { completedCombos: [], configSnapshot: config });
        startOptimizationJob(config, job, claimed.id, undefined, undefined, guidedInsights, guidedInsightsPerCombo, processOrdersOnClose);
        console.log(`[QuantumLab] pumpQueue: started run ${claimed.id} (type=${snapshotType})`);
      } catch (startErr: any) {
        console.log(`[QuantumLab] pumpQueue: failed to start run ${claimed.id}: ${startErr.message} — requeueing`);
        const requeueOrder = await labStorage.getNextQueueOrder(claimed.userId ?? "system");
        await db.update(labOptimizationRuns).set({
          status: "queued",
          queueOrder: requeueOrder,
        }).where(eq(labOptimizationRuns.id, claimed.id)).catch(() => {});
        console.log(`[QuantumLab] pumpQueue: run ${claimed.id} requeued (order: ${requeueOrder}), will retry in 5s`);
        setTimeout(() => pumpQueue(), 5000);
      }
    } catch (err: any) {
      console.log(`[QuantumLab] pumpQueue error: ${err.message}`);
    } finally {
      pumpQueueRunning = false;
    }
  }

  app.post("/api/lab/run-optimization", requireLabAuth, async (req: Request, res: Response) => {
    let config: LabOptimizationConfig | undefined;
    let walletAddress: string | undefined;
    let processOrdersOnClose: boolean | undefined;
    try {
      const parsed = labOptimizationConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      config = parsed.data;
      walletAddress = (req as any).walletAddress;

      const isBusy = await labStorage.hasActiveOrPausedRun();

      if (config.strategyId) {
        const strategy = await labStorage.getStrategy(config.strategyId);
        if (strategy?.strategySettings && typeof strategy.strategySettings === "object") {
          processOrdersOnClose = (strategy.strategySettings as any).processOrdersOnClose;
          if ((strategy.strategySettings as any).nativeEngine) {
            delete config.pineScript;
            config.engineType = (strategy.strategySettings as any).engineType;
            console.log(`[QuantumLab] Strategy ${config.strategyId} has nativeEngine=true, engineType=${config.engineType}`);
          }
        }
      }

      if (isBusy && config.strategyId) {
        const queueOrder = await labStorage.getNextQueueOrder(walletAddress);
        let snapshotInsights: any = {};
        if (config.useInsights) {
          try {
            const computed = await Promise.race([
              computeGuidedInsightsForConfig(config.strategyId, config.tickers, config.timeframes),
              new Promise<{ guidedInsights: undefined; guidedInsightsPerCombo: undefined }>((_, reject) =>
                setTimeout(() => reject(new Error("insights timeout")), 5000)
              ),
            ]);
            if (computed.guidedInsights) snapshotInsights.guidedInsights = computed.guidedInsights;
            if (computed.guidedInsightsPerCombo) snapshotInsights.guidedInsightsPerCombo = computed.guidedInsightsPerCombo;
          } catch {
            console.log(`[QuantumLab] Queue: insights computation skipped (timeout/error)`);
          }
        }
        const run = await labStorage.createRun({
          strategyId: config.strategyId,
          userId: walletAddress,
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
          status: "queued",
        });
        await db.update(labOptimizationRuns).set({
          queueOrder,
          configSnapshot: { type: "new", config, processOrdersOnClose, ...snapshotInsights } as any,
        }).where(eq(labOptimizationRuns.id, run.id));
        console.log(`[QuantumLab] Queued new run ${run.id} (order: ${queueOrder})`);
        setTimeout(() => pumpQueue(), 500);
        return res.json({ queued: true, runId: run.id, queueOrder });
      }

      const job = labStorage.createJob(config, { hasActiveWorker: !!activeWorker });
      job.walletAddress = walletAddress;

      let guidedInsights: import("@shared/schema").GuidedInsights | undefined;
      let guidedInsightsPerCombo: Record<string, import("@shared/schema").GuidedInsights> | undefined;
      if (config.useInsights && config.strategyId) {
        const allReports = await labStorage.getInsightsReports(config.strategyId);

        function extractInsights(rd: any): import("@shared/schema").GuidedInsights | null {
          if (!rd?.paramSensitivity || !Array.isArray(rd.paramSensitivity)) return null;
          const result: import("@shared/schema").GuidedInsights = {
            paramSensitivity: rd.paramSensitivity.map((ps: any) => ({
              name: ps.name,
              type: ps.type,
              impactScore: ps.impactScore ?? 0,
              bestBucket: ps.bestBucket ? { rangeMin: ps.bestBucket.rangeMin, rangeMax: ps.bestBucket.rangeMax } : { rangeMin: 0, rangeMax: 0 },
            })),
          };
          if (rd.topBottomConfigs?.top && Array.isArray(rd.topBottomConfigs.top) && rd.topBottomConfigs.top.length > 0) {
            result.topConfigs = rd.topBottomConfigs.top.map((c: any) => ({
              params: c.params,
              score: c.netProfitPercent ?? 0,
            }));
          }
          return result;
        }

        const perComboMap: Record<string, import("@shared/schema").GuidedInsights> = {};
        for (const t of config.tickers) {
          for (const tf of config.timeframes) {
            const key = `${t}|${tf}`;
            const matchingReport = allReports.find(r => {
              const rd = r.reportData as any;
              return rd?.filter?.ticker === t && rd?.filter?.timeframe === tf;
            });
            if (matchingReport) {
              const insights = extractInsights(matchingReport.reportData as any);
              if (insights) {
                perComboMap[key] = insights;
                console.log(`[QuantumLab] Guided mode: found focused report for ${key}`);
              }
            }
          }
        }

        if (Object.keys(perComboMap).length > 0) {
          guidedInsightsPerCombo = perComboMap;
          console.log(`[QuantumLab] Guided mode: ${Object.keys(perComboMap).length} focused reports loaded`);
        }

        const latestGeneral = allReports.find(r => !(r.reportData as any)?.filter?.ticker) ?? allReports[0];
        if (latestGeneral) {
          const fallback = extractInsights(latestGeneral.reportData as any);
          if (fallback) {
            guidedInsights = fallback;
            console.log(`[QuantumLab] Guided mode: fallback report loaded (${(latestGeneral.reportData as any)?.filter ? "filtered" : "general"}) with ${fallback.paramSensitivity.length} params, ${fallback.topConfigs?.length ?? 0} top configs`);
          }
        }
      }

      let runId: number | undefined;
      if (config.strategyId) {
        const run = await labStorage.createRun({
          strategyId: config.strategyId,
          userId: walletAddress,
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

      startOptimizationJob(config, job, runId, undefined, undefined, guidedInsights, guidedInsightsPerCombo, processOrdersOnClose);

      res.json({ jobId: job.id, runId });
    } catch (err: any) {
      console.log(`[QuantumLab] Run error: ${err.message}`);
      if ((err as any).blockingJobId && config.strategyId) {
        console.log(`[QuantumLab] Concurrency conflict — auto-queuing run`);
        try {
          const queueOrder = await labStorage.getNextQueueOrder(walletAddress);
          let snapshotInsights: any = {};
          if (config.useInsights) {
            const computed = await computeGuidedInsightsForConfig(config.strategyId, config.tickers, config.timeframes);
            if (computed.guidedInsights) snapshotInsights.guidedInsights = computed.guidedInsights;
            if (computed.guidedInsightsPerCombo) snapshotInsights.guidedInsightsPerCombo = computed.guidedInsightsPerCombo;
          }
          const run = await labStorage.createRun({
            strategyId: config.strategyId,
            userId: walletAddress,
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
            status: "queued",
          });
          await db.update(labOptimizationRuns).set({
            queueOrder,
            configSnapshot: { type: "new", config, processOrdersOnClose, ...snapshotInsights } as any,
          }).where(eq(labOptimizationRuns.id, run.id));
          console.log(`[QuantumLab] Auto-queued run ${run.id} (order: ${queueOrder})`);
          setTimeout(() => pumpQueue(), 500);
          return res.json({ queued: true, runId: run.id, queueOrder });
        } catch (queueErr: any) {
          console.log(`[QuantumLab] Auto-queue fallback failed: ${queueErr.message}`);
        }
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/runs/:id/resume", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const runId = parseInt(req.params.id);
      const run = await verifyRunOwnership(req, res);
      if (!run) return;

      const existingJob = labStorage.getJobByRunId(runId);
      if (existingJob && existingJob.progress.status !== "complete" && existingJob.progress.status !== "error") {
        console.log(`[QuantumLab] Resume request for run ${runId} — already has active job ${existingJob.id}, reconnecting`);
        if (run.status !== "running") {
          await labStorage.resumeRun(runId);
        }
        return res.json({ jobId: existingJob.id, runId, alreadyRunning: true });
      }

      if (run.status === "queued") {
        console.log(`[QuantumLab] Resume request for queued run ${runId} — kicking queue pump`);
        pumpQueue();
        return res.json({ queued: true, runId, message: "Queue pump triggered" });
      }

      if (run.status === "running") {
        console.log(`[QuantumLab] Run ${runId} has status "running" in DB but no active in-memory job — auto-pausing for resume`);
        await labStorage.pauseRun(runId);
      } else if (run.status !== "paused") {
        return res.status(400).json({ error: `Run is ${run.status}, not paused` });
      }

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

      const config = await extractConfigForResume(checkpoint, runId);
      if (!config) {
        return res.status(400).json({ error: "Cannot resume: config is corrupt and unrecoverable" });
      }
      checkpoint.configSnapshot = config;
      if ((checkpoint as any).autoResumeAttempts || (checkpoint as any).userCancelled) {
        (checkpoint as any).autoResumeAttempts = 0;
        (checkpoint as any).userCancelled = false;
        await labStorage.saveCheckpoint(runId, checkpoint);
      }

      let resumeProcessOrdersOnClose: boolean | undefined;
      if (run.strategyId) {
        const strategy = await labStorage.getStrategy(run.strategyId);
        if (strategy?.strategySettings && typeof strategy.strategySettings === "object") {
          resumeProcessOrdersOnClose = (strategy.strategySettings as any).processOrdersOnClose;
          if ((strategy.strategySettings as any).nativeEngine) {
            delete config.pineScript;
            config.engineType = (strategy.strategySettings as any).engineType;
          }
        }
        if (!config.pineScript && strategy?.pineScript && !(strategy?.strategySettings as any)?.nativeEngine) {
          config.pineScript = strategy.pineScript;
        }
      }

      const claimed = await labStorage.claimPausedRunForResume(runId);
      if (!claimed) {
        return res.status(409).json({ error: "Could not claim run — another optimization may be running" });
      }

      let startedOk = false;
      try {
        const job = labStorage.createJob(config, { forRunId: runId, hasActiveWorker: !!activeWorker });
        job.runId = runId;
        job.walletAddress = (req as any).walletAddress;

        console.log(`[QuantumLab] Resuming run ${runId} — ${checkpoint.completedCombos.length} combos already done${checkpoint.currentCombo ? `, mid-combo ${checkpoint.currentCombo} at iter ${checkpoint.currentIteration}` : ""}`);

        startOptimizationJob(config, job, runId, checkpoint, undefined, undefined, undefined, resumeProcessOrdersOnClose);
        startedOk = true;

        res.json({ jobId: job.id, runId, resumedFrom: checkpoint.completedCombos.length });
      } finally {
        if (!startedOk) {
          console.log(`[QuantumLab] Resume: startup failed for run ${runId}, rolling back claim`);
          await labStorage.pauseRun(runId).catch(() => {});
        }
      }
    } catch (err: any) {
      console.log(`[QuantumLab] Resume error: ${err.message}`);
      if ((err as any).blockingJobId) {
        return res.status(409).json({
          error: "Another optimization is already running",
          blockingJobId: (err as any).blockingJobId,
          blockingRunId: (err as any).blockingRunId,
        });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/job/:id/progress", requireLabAuth, (req: Request, res: Response) => {
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
    }, 25000);

    job.listeners.add(sendProgress);

    req.on("close", () => {
      clearInterval(heartbeat);
      job.listeners.delete(sendProgress);
    });
  });

  app.get("/api/lab/job/:id/results", requireLabAuth, (req: Request, res: Response) => {
    const results = labStorage.getJobResult(req.params.id);
    if (!results) {
      return res.status(404).json({ error: "Results not found" });
    }
    res.json(results);
  });

  app.post("/api/lab/runs/:id/retry", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const runId = parseInt(req.params.id);
      const run = await verifyRunOwnership(req, res);
      if (!run) return;
      if (run.status !== "failed") {
        return res.status(400).json({ error: "Only failed runs can be retried" });
      }
      const runSnapshot = run.configSnapshot && typeof run.configSnapshot === "object" ? run.configSnapshot as any : null;
      const checkpoint = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
      const snapshot = runSnapshot ?? checkpoint?.configSnapshot;
      if (!snapshot) {
        return res.status(400).json({ error: "No config snapshot found — cannot retry" });
      }
      const walletAddress = (req as any).walletAddress;
      const queueOrder = await labStorage.getNextQueueOrder(walletAddress);
      const newRun = await labStorage.createRun({
        strategyId: run.strategyId,
        userId: walletAddress,
        tickers: run.tickers as string[],
        timeframes: run.timeframes as string[],
        startDate: run.startDate,
        endDate: run.endDate,
        randomSamples: run.randomSamples,
        topK: run.topK,
        refinementsPerSeed: run.refinementsPerSeed,
        minTrades: run.minTrades,
        maxDrawdownCap: run.maxDrawdownCap ? String(run.maxDrawdownCap) : undefined,
        mode: run.mode ?? undefined,
        status: "queued",
      });
      await db.update(labOptimizationRuns).set({
        queueOrder,
        configSnapshot: snapshot,
      }).where(eq(labOptimizationRuns.id, newRun.id));
      console.log(`[QuantumLab] Retry: created run ${newRun.id} from failed run ${runId} (order: ${queueOrder})`);
      setTimeout(() => pumpQueue(), 500);
      res.json({ queued: true, runId: newRun.id, queueOrder, sourceRunId: runId });
    } catch (err: any) {
      console.error(`[QuantumLab] Retry failed:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  const MAX_AUTO_RESUME_ATTEMPTS = 6;

  app.post("/api/lab/runs/:id/refine", requireLabAuth, async (req: Request, res: Response) => {
    let refineRunId: number | undefined;
    let refineConfig: LabOptimizationConfig | undefined;
    let refineWallet: string | undefined;
    let refineStrategyId: number | undefined;
    let refineTicker: string | undefined;
    let refineTimeframe: string | undefined;
    let refineProcessOrdersOnClose: boolean | undefined;
    try {
      const runId = parseInt(req.params.id);
      refineRunId = runId;
      const run = await verifyRunOwnership(req, res);
      if (!run) return;

      const { ticker: reqTicker, timeframe: reqTimeframe, reportData, seedParams: reqSeedParams } = req.body;
      const seedParams = reqSeedParams && typeof reqSeedParams === "object" && !Array.isArray(reqSeedParams)
        ? (reqSeedParams as Record<string, any>)
        : null;
      const runTickers = Array.isArray(run.tickers) ? run.tickers as string[] : [];
      const runTimeframes = Array.isArray(run.timeframes) ? run.timeframes as string[] : [];
      const ticker = reqTicker || runTickers[0];
      const timeframe = reqTimeframe || runTimeframes[0];
      refineTicker = ticker;
      refineTimeframe = timeframe;
      if (!ticker || !timeframe) {
        return res.status(400).json({ error: "ticker and timeframe are required (and could not be inferred from run)" });
      }

      const strategyId = run.strategyId;
      refineStrategyId = strategyId;
      const strategy = await labStorage.getStrategy(strategyId);
      if (!strategy) {
        return res.status(404).json({ error: "Strategy not found" });
      }

      const walletAddress = (req as any).walletAddress;
      refineWallet = walletAddress;

      if (reportData && typeof reportData === "object" && reportData.paramSensitivity) {
        try {
          await labStorage.saveInsightsReport(strategyId, reportData, reportData.totalResults ?? 0, reportData.totalRuns ?? 0);
          console.log(`[QuantumLab] Refine: saved focused insights report for ${ticker} ${timeframe}`);
        } catch (saveErr: any) {
          console.log(`[QuantumLab] Refine: failed to save insights report: ${saveErr.message}`);
        }
      }

      const sourceConfig = run.checkpoint && typeof run.checkpoint === "object"
        ? (run.checkpoint as any).configSnapshot
        : null;

      const sourceSamples = sourceConfig?.randomSamples ?? run.randomSamples;
      const sourceTopK = sourceConfig?.topK ?? run.topK;
      const sourceRefinements = sourceConfig?.refinementsPerSeed ?? run.refinementsPerSeed;

      const randomSamples = sourceSamples && sourceSamples !== 900 ? sourceSamples : 2000;
      const topK = sourceTopK && sourceTopK !== 20 ? sourceTopK : 30;
      const refinementsPerSeed = sourceRefinements && sourceRefinements !== 60 ? sourceRefinements : 60;

      const parsedInputs = strategy.parsedInputs as any[];
      if (!parsedInputs || parsedInputs.length === 0) {
        return res.status(400).json({ error: "Strategy has no parsed inputs" });
      }

      const isNative = (strategy.strategySettings as any)?.nativeEngine === true;
      const nativeEngineType = (strategy.strategySettings as any)?.engineType as string | undefined;
      const config: LabOptimizationConfig = {
        pineScript: isNative ? undefined : strategy.pineScript,
        parsedInputs,
        tickers: [ticker],
        timeframes: [timeframe],
        startDate: sourceConfig?.startDate ?? run.startDate ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        endDate: sourceConfig?.endDate ?? run.endDate ?? new Date().toISOString().split("T")[0],
        randomSamples,
        topK,
        refinementsPerSeed,
        minTrades: sourceConfig?.minTrades ?? run.minTrades ?? 10,
        maxDrawdownCap: sourceConfig?.maxDrawdownCap ?? run.maxDrawdownCap ?? 85,
        minAvgBarsHeld: sourceConfig?.minAvgBarsHeld ?? (run as any).minAvgBarsHeld ?? 1,
        mode: "sweep",
        strategyId,
        engineType: isNative ? nativeEngineType : undefined,
        useInsights: true,
        coordinateTune: true,
      };

      if (strategy.strategySettings && typeof strategy.strategySettings === "object") {
        refineProcessOrdersOnClose = (strategy.strategySettings as any).processOrdersOnClose;
      }
      refineConfig = config;

      const dupCheck = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${runId + 1000000})`);
        const existing = await tx.select({ id: labOptimizationRuns.id })
          .from(labOptimizationRuns)
          .where(and(
            or(eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.status, "queued"), eq(labOptimizationRuns.status, "paused"))!,
            sql`${labOptimizationRuns.configSnapshot}->>'sourceRunId' = ${String(runId)}`
          )!)
          .limit(1);
        return existing;
      });
      if (dupCheck.length > 0) {
        console.log(`[QuantumLab] Refine: duplicate blocked — refine of run ${runId} already exists as run ${dupCheck[0].id}`);
        return res.json({ queued: true, runId: dupCheck[0].id, queueOrder: 0, duplicate: true });
      }

      const isBusy = await labStorage.hasActiveOrPausedRun();

      if (isBusy) {
        const queueOrder = await labStorage.getNextQueueOrder(walletAddress);
        const computed = await computeGuidedInsightsForConfig(strategyId, [ticker], [timeframe]);
        if (seedParams) {
          const comboKey = `${ticker}|${timeframe}`;
          const perCombo = computed.guidedInsightsPerCombo ?? {};
          const existing = perCombo[comboKey] ?? { paramSensitivity: [] };
          perCombo[comboKey] = { ...existing, topConfigs: [{ params: seedParams, score: Number.MAX_SAFE_INTEGER }] };
          computed.guidedInsightsPerCombo = perCombo;
          console.log(`[QuantumLab] Refine (queued): using caller-supplied seedParams for ${comboKey}`);
        }
        const newRun = await labStorage.createRun({
          strategyId,
          userId: walletAddress,
          tickers: [ticker],
          timeframes: [timeframe],
          startDate: config.startDate,
          endDate: config.endDate,
          randomSamples: config.randomSamples,
          topK: config.topK,
          refinementsPerSeed: config.refinementsPerSeed,
          minTrades: config.minTrades,
          maxDrawdownCap: config.maxDrawdownCap,
          mode: "sweep",
          status: "queued",
        });
        await db.update(labOptimizationRuns).set({
          queueOrder,
          configSnapshot: {
            type: "refine", config, processOrdersOnClose: refineProcessOrdersOnClose, sourceRunId: runId,
            targetTicker: ticker, targetTimeframe: timeframe,
            guidedInsights: computed.guidedInsights,
            guidedInsightsPerCombo: computed.guidedInsightsPerCombo,
          } as any,
        }).where(eq(labOptimizationRuns.id, newRun.id));
        console.log(`[QuantumLab] Queued refine run ${newRun.id} for ${ticker} ${timeframe} (order: ${queueOrder})`);
        setTimeout(() => pumpQueue(), 500);
        return res.json({ queued: true, runId: newRun.id, queueOrder });
      }

      retryGeneration++;
      pendingRetryRunId = null;
      if (activeWorker) {
        activeWorker.postMessage({ type: "abort" });
        try { activeWorker.terminate(); } catch {}
        clearActiveWorker();
      }
      const evicted = labStorage.forceEvictJobsByWallet(walletAddress);
      const staleRuns = await db.select().from(labOptimizationRuns).where(
        and(
          eq(labOptimizationRuns.userId, walletAddress),
          or(eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.status, "paused"))!
        )!
      );
      let clearedConflicts = 0;
      for (const staleRun of staleRuns) {
        const savedResults = await db.select({ id: labOptimizationResults.id })
          .from(labOptimizationResults)
          .where(eq(labOptimizationResults.runId, staleRun.id))
          .limit(1);
        if (savedResults.length > 0) {
          await labStorage.pauseRun(staleRun.id);
        } else {
          await labStorage.failRun(staleRun.id);
        }
        clearedConflicts++;
      }
      if (evicted > 0 || clearedConflicts > 0) {
        console.log(`[QuantumLab] Refine: force-cleared ${evicted} in-memory jobs, ${clearedConflicts} DB runs (wallet-scoped: ${walletAddress})`);
      }

      const job = labStorage.createJob(config, { hasActiveWorker: !!activeWorker });
      job.walletAddress = walletAddress;

      const newRun = await labStorage.createRun({
        strategyId,
        userId: walletAddress,
        tickers: [ticker],
        timeframes: [timeframe],
        startDate: config.startDate,
        endDate: config.endDate,
        randomSamples: config.randomSamples,
        topK: config.topK,
        refinementsPerSeed: config.refinementsPerSeed,
        minTrades: config.minTrades,
        maxDrawdownCap: config.maxDrawdownCap,
        mode: "sweep",
        status: "running",
      });
      job.runId = newRun.id;
      await db.update(labOptimizationRuns).set({
        configSnapshot: {
          type: "refine", config, processOrdersOnClose: refineProcessOrdersOnClose, sourceRunId: runId,
          targetTicker: ticker, targetTimeframe: timeframe,
        } as any,
      }).where(eq(labOptimizationRuns.id, newRun.id));
      await labStorage.saveCheckpoint(newRun.id, { completedCombos: [], configSnapshot: config });

      let guidedInsights: import("@shared/schema").GuidedInsights | undefined;
      let guidedInsightsPerCombo: Record<string, import("@shared/schema").GuidedInsights> | undefined;

      const allReports = await labStorage.getInsightsReports(strategyId);

      function extractInsights(rd: any): import("@shared/schema").GuidedInsights | null {
        if (!rd?.paramSensitivity || !Array.isArray(rd.paramSensitivity)) return null;
        const result: import("@shared/schema").GuidedInsights = {
          paramSensitivity: rd.paramSensitivity.map((ps: any) => ({
            name: ps.name,
            type: ps.type,
            impactScore: ps.impactScore ?? 0,
            bestBucket: ps.bestBucket ? { rangeMin: ps.bestBucket.rangeMin, rangeMax: ps.bestBucket.rangeMax } : { rangeMin: 0, rangeMax: 0 },
          })),
        };
        if (rd.topBottomConfigs?.top && Array.isArray(rd.topBottomConfigs.top) && rd.topBottomConfigs.top.length > 0) {
          result.topConfigs = rd.topBottomConfigs.top.map((c: any) => ({
            params: c.params,
            score: c.netProfitPercent ?? 0,
          }));
        }
        return result;
      }

      const comboKey = `${ticker}|${timeframe}`;
      const matchingReport = allReports.find(r => {
        const rd = r.reportData as any;
        return rd?.filter?.ticker === ticker && rd?.filter?.timeframe === timeframe;
      });
      if (matchingReport) {
        const insights = extractInsights(matchingReport.reportData as any);
        if (insights) {
          guidedInsightsPerCombo = { [comboKey]: insights };
          console.log(`[QuantumLab] Refine: loaded focused insights for ${comboKey}`);
        }
      }

      if (seedParams) {
        const perCombo = guidedInsightsPerCombo ?? {};
        const existing = perCombo[comboKey] ?? { paramSensitivity: [] };
        perCombo[comboKey] = { ...existing, topConfigs: [{ params: seedParams, score: Number.MAX_SAFE_INTEGER }] };
        guidedInsightsPerCombo = perCombo;
        console.log(`[QuantumLab] Refine: using caller-supplied seedParams for ${comboKey}`);
      }

      const latestGeneral = allReports.find(r => !(r.reportData as any)?.filter?.ticker) ?? allReports[0];
      if (latestGeneral) {
        const fallback = extractInsights(latestGeneral.reportData as any);
        if (fallback) {
          guidedInsights = fallback;
        }
      }

      startOptimizationJob(config, job, newRun.id, undefined, undefined, guidedInsights, guidedInsightsPerCombo, refineProcessOrdersOnClose);

      console.log(`[QuantumLab] Refine: started run ${newRun.id} for ${ticker} ${timeframe} (coordinate-tune, ${randomSamples} samples, ${topK} topK, ${refinementsPerSeed} refinements)`);
      res.json({ jobId: job.id, runId: newRun.id });
    } catch (err: any) {
      console.log(`[QuantumLab] Refine error: ${err.message}`);
      if ((err as any).blockingJobId && refineConfig && refineStrategyId && refineTicker && refineTimeframe) {
        console.log(`[QuantumLab] Refine concurrency conflict — auto-queuing`);
        try {
          const queueOrder = await labStorage.getNextQueueOrder(refineWallet ?? "system");
          const computed = await computeGuidedInsightsForConfig(refineStrategyId, [refineTicker], [refineTimeframe]);
          const queuedRun = await labStorage.createRun({
            strategyId: refineStrategyId,
            userId: refineWallet,
            tickers: [refineTicker],
            timeframes: [refineTimeframe],
            startDate: refineConfig.startDate,
            endDate: refineConfig.endDate,
            randomSamples: refineConfig.randomSamples,
            topK: refineConfig.topK,
            refinementsPerSeed: refineConfig.refinementsPerSeed,
            minTrades: refineConfig.minTrades,
            maxDrawdownCap: refineConfig.maxDrawdownCap,
            mode: "sweep",
            status: "queued",
          });
          await db.update(labOptimizationRuns).set({
            queueOrder,
            configSnapshot: {
              type: "refine", config: refineConfig, processOrdersOnClose: refineProcessOrdersOnClose, sourceRunId: refineRunId,
              targetTicker: refineTicker, targetTimeframe: refineTimeframe,
              guidedInsights: computed.guidedInsights,
              guidedInsightsPerCombo: computed.guidedInsightsPerCombo,
            } as any,
          }).where(eq(labOptimizationRuns.id, queuedRun.id));
          console.log(`[QuantumLab] Auto-queued refine run ${queuedRun.id} for ${refineTicker} ${refineTimeframe} (order: ${queueOrder})`);
          setTimeout(() => pumpQueue(), 500);
          return res.json({ queued: true, runId: queuedRun.id, queueOrder });
        } catch (queueErr: any) {
          console.log(`[QuantumLab] Auto-queue refine fallback failed: ${queueErr.message}`);
        }
      }
      res.status(500).json({ error: err.message });
    }
  });

  const QUEUE_CACHE_TTL_MS = 2000;
  const QUEUE_STALE_GRACE_MS = 60_000;
  const queueCache = new Map<string, { data: any; expiresAt: number; cachedAt: number }>();
  const queueInFlight = new Map<string, Promise<any>>();

  async function computeQueuePayload(walletAddress: string) {
    const queued = await labStorage.getQueuedRuns(walletAddress);
    const strategyIds = [...new Set(queued.map(r => r.strategyId))];
    const strategyNames: Record<number, string> = {};
    for (const sid of strategyIds) {
      const strat = await labStorage.getStrategy(sid);
      if (strat) strategyNames[sid] = strat.name;
    }
    const items = queued.map(r => {
      const snapshot = r.configSnapshot as any;
      return {
        id: r.id,
        strategyId: r.strategyId,
        type: snapshot?.type || "new",
        tickers: r.tickers,
        timeframes: r.timeframes,
        strategyName: strategyNames[r.strategyId] || null,
        queueOrder: r.queueOrder,
        createdAt: r.createdAt,
        mode: r.mode,
        sourceRunId: snapshot?.sourceRunId || null,
        targetTicker: snapshot?.targetTicker || null,
        targetTimeframe: snapshot?.targetTimeframe || null,
      };
    });
    let activeRun: any = null;
    const activeRunRows = await db.select().from(labOptimizationRuns)
      .where(and(eq(labOptimizationRuns.userId, walletAddress), inArray(labOptimizationRuns.status, ["running", "paused"])))
      .orderBy(desc(labOptimizationRuns.id)).limit(1);
    if (activeRunRows.length > 0) {
      const ar = activeRunRows[0];
      if (!strategyNames[ar.strategyId]) {
        const strat = await labStorage.getStrategy(ar.strategyId);
        if (strat) strategyNames[ar.strategyId] = strat.name;
      }
      const cp = ar.checkpoint && typeof ar.checkpoint === "object" ? ar.checkpoint as any : null;
      const lastHeartbeat = (cp?.lastHeartbeat as number | undefined) ?? null;
      const createdAtMs = ar.createdAt instanceof Date ? ar.createdAt.getTime() : (ar.createdAt ? new Date(ar.createdAt as any).getTime() : null);
      activeRun = {
        id: ar.id,
        strategyId: ar.strategyId,
        tickers: ar.tickers,
        timeframes: ar.timeframes,
        status: ar.status,
        mode: ar.mode,
        strategyName: strategyNames[ar.strategyId] || null,
        lastHeartbeat,
        createdAtMs,
      };
    }
    return { items, activeRun };
  }

  app.get("/api/lab/queue", requireLabAuth, async (req: Request, res: Response) => {
    const walletAddress = (req as any).walletAddress as string;
    const now = Date.now();
    const cached = queueCache.get(walletAddress);
    if (cached && cached.expiresAt > now) {
      return res.json(cached.data);
    }
    let inFlight = queueInFlight.get(walletAddress);
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const data = await computeQueuePayload(walletAddress);
          queueCache.set(walletAddress, { data, expiresAt: Date.now() + QUEUE_CACHE_TTL_MS, cachedAt: Date.now() });
          return data;
        } finally {
          queueInFlight.delete(walletAddress);
        }
      })();
      queueInFlight.set(walletAddress, inFlight);
    }
    try {
      const data = await inFlight;
      res.json(data);
    } catch (err: any) {
      if (cached && now - cached.cachedAt < QUEUE_STALE_GRACE_MS) {
        console.log(`[QuantumLab] /api/lab/queue refresh failed (${err.message}), serving stale (${Math.round((now - cached.cachedAt) / 1000)}s old)`);
        return res.json({ ...cached.data, stale: true });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/queue/reorder", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const walletAddress = (req as any).walletAddress;
      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: "orderedIds must be an array" });
      }
      await labStorage.reorderQueue(walletAddress, orderedIds);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/lab/queue/:id", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const walletAddress = (req as any).walletAddress;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const cancelled = await labStorage.cancelQueuedRun(id, walletAddress);
      if (!cancelled) {
        return res.status(404).json({ error: "Queued run not found or not owned by you" });
      }
      res.json({ success: true });
      pumpQueue();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/jobs/force-clear", requireLabAuth, async (req: Request, res: Response) => {
    const { jobId, runId: targetRunId } = req.body || {};
    const walletAddress = (req as any).walletAddress as string | undefined;

    retryGeneration++;
    pendingRetryRunId = null;

    let shouldTerminateWorker = false;
    let evicted: number;
    let targetDbRunId: number | undefined;

    if (jobId) {
      const job = labStorage.getJob(jobId);
      if (job && job.progress.status !== "complete" && job.progress.status !== "error") {
        if (walletAddress) {
          let jobOwner = job.walletAddress;
          if (!jobOwner && job.runId) {
            const jobRun = await labStorage.getRun(job.runId);
            if (jobRun?.userId) jobOwner = jobRun.userId;
          }
          if (jobOwner && jobOwner !== walletAddress) {
            return res.status(403).json({ error: "Access denied: job belongs to another user" });
          }
        }
        labStorage.updateProgress(jobId, {
          jobId, status: "error", stage: "Force-evicted by user",
          current: 0, total: 0, percent: 0, elapsed: 0, error: "Force-evicted by user",
        });
        targetDbRunId = job.runId;
        shouldTerminateWorker = true;
        evicted = 1;
      } else {
        evicted = 0;
      }
    } else if (walletAddress) {
      evicted = labStorage.forceEvictJobsByWallet(walletAddress);
      shouldTerminateWorker = evicted > 0;
    } else {
      evicted = labStorage.forceEvictAllJobs();
      shouldTerminateWorker = evicted > 0 || !!activeWorker;
    }

    if (shouldTerminateWorker && activeWorker) {
      activeWorker.postMessage({ type: "abort" });
      try { activeWorker.terminate(); } catch {}
      clearActiveWorker();
    }

    let staleRuns;
    if (targetDbRunId) {
      staleRuns = await db.select().from(labOptimizationRuns).where(
        and(eq(labOptimizationRuns.id, targetDbRunId), eq(labOptimizationRuns.status, "running"))!
      );
    } else if (targetRunId) {
      const whereClause = walletAddress
        ? and(eq(labOptimizationRuns.id, targetRunId), eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.userId, walletAddress))
        : and(eq(labOptimizationRuns.id, targetRunId), eq(labOptimizationRuns.status, "running"));
      staleRuns = await db.select().from(labOptimizationRuns).where(whereClause!);
    } else if (walletAddress) {
      staleRuns = await db.select().from(labOptimizationRuns).where(
        and(eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.userId, walletAddress))!
      );
    } else {
      staleRuns = await db.select().from(labOptimizationRuns).where(
        or(eq(labOptimizationRuns.status, "running"), eq(labOptimizationRuns.status, "paused"))!
      );
    }

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
    setTimeout(() => pumpQueue(), 1000);
  });

  app.post("/api/lab/job/:id/cancel", requireLabAuth, async (req: Request, res: Response) => {
    const job = labStorage.getJob(req.params.id);
    const walletAddress = (req as any).walletAddress;
    if (job?.runId) {
      const run = await labStorage.getRun(job.runId);
      if (run && run.userId && run.userId !== walletAddress) {
        return res.status(403).json({ error: "Not authorized to cancel this run" });
      }
    }
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (activeWorker) {
      activeWorker.postMessage({ type: "abort" });
      const workerRef = activeWorker;
      setTimeout(() => {
        if (activeWorker === workerRef) {
          console.log(`[QuantumLab] Cancel: worker did not exit after grace period, force-terminating`);
          try { workerRef.terminate(); } catch {}
          clearActiveWorker();
          pumpQueue();
        }
      }, 2000);
    }
    labStorage.cancelJob(req.params.id);
    if (job?.runId) {
      try {
        const cp = await labStorage.getCheckpoint(job.runId);
        if (cp) {
          (cp as any).userCancelled = true;
          (cp as any).autoResumeAttempts = MAX_AUTO_RESUME_ATTEMPTS;
          await labStorage.saveCheckpoint(job.runId, cp);
        }
      } catch {}
      if (activeWorker) {
        setTimeout(async () => {
          try {
            const run = await labStorage.getRun(job.runId!);
            if (run && run.status === "running") {
              await labStorage.pauseRun(job.runId!);
              console.log(`[QuantumLab] Cancel safety net: run ${job.runId} → paused (user-cancelled, no auto-resume)`);
            }
            if (run && (run.status === "complete" || run.status === "failed")) {
              pumpQueue();
            }
          } catch {}
        }, 3000);
      } else {
        pumpQueue();
      }
    } else {
      try {
        const allRuns = await labStorage.getRuns();
        const userRun = allRuns.find(r => r.status === "running" && r.userId === walletAddress);
        if (userRun) {
          try {
            const cp = await labStorage.getCheckpoint(userRun.id);
            if (cp) {
              (cp as any).userCancelled = true;
              (cp as any).autoResumeAttempts = MAX_AUTO_RESUME_ATTEMPTS;
              await labStorage.saveCheckpoint(userRun.id, cp);
            }
          } catch {}
          await labStorage.pauseRun(userRun.id);
          console.log(`[QuantumLab] Cancel fallback: no job in memory — force-paused run ${userRun.id} for ${walletAddress}`);
          pumpQueue();
        }
      } catch (e: any) {
        console.error(`[QuantumLab] Cancel fallback error: ${e.message}`);
      }
    }
    res.json({ success: true });
  });

  app.get("/api/lab/export/csv/:id", requireLabAuth, (req: Request, res: Response) => {
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

  app.get("/api/lab/heatmap", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const walletAddress = (req as any).walletAddress;

      const rawStrategyId = req.query.strategyId;
      const parsedStrategyId =
        rawStrategyId != null && rawStrategyId !== "" && rawStrategyId !== "all"
          ? Number(rawStrategyId)
          : undefined;
      const strategyId =
        Number.isInteger(parsedStrategyId as number) && (parsedStrategyId as number) > 0
          ? parsedStrategyId
          : undefined;

      const { cells, runsTotal, strategyIds } = await labStorage.getHeatmapCells(walletAddress, strategyId);

      if (runsTotal === 0) {
        return res.json({ cells: [], tickers: [], timeframes: [], runs: 0, strategyIds });
      }

      const tickers = new Set<string>();
      const timeframes = new Set<string>();
      for (const cell of cells) {
        tickers.add(cell.ticker);
        timeframes.add(cell.timeframe);
      }

      const tfOrder = ["1m", "5m", "15m", "30m", "45m", "45M", "1h", "1H", "2h", "2H", "4h", "4H", "8h", "8H", "12h", "12H", "1d", "1D"];
      const sortedTimeframes = [...timeframes].sort((a, b) => tfOrder.indexOf(a) - tfOrder.indexOf(b));
      const sortedTickers = [...tickers].sort();

      res.json({ cells, tickers: sortedTickers, timeframes: sortedTimeframes, runs: runsTotal, strategyIds });
    } catch (err: any) {
      console.log(`[QuantumLab] Heatmap error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/lab/cache/stats", requireLabAuth, async (_req: Request, res: Response) => {
    try {
      const stats = await getCacheStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/lab/cache", requireLabAuth, async (_req: Request, res: Response) => {
    try {
      const deleted = await clearCandleCache();
      res.json({ success: true, deletedRows: deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/lab/compiler/parity-test", requireLabAuth, async (req: Request, res: Response) => {
    try {
      const { strategyId, ticker, timeframe } = req.body;
      if (!strategyId) return res.status(400).json({ error: "strategyId required" });
      const strategy = await labStorage.getStrategy(strategyId);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      const { compilePine: compilePineFn, runPineParityTest } = await import("./pine/index");
      const plan = compilePineFn(strategy.pineScript);
      const useTicker = ticker || "SOL/USDT:USDT";
      const useTf = timeframe || "4h";
      const candles = await fetchOHLCV(useTicker, useTf, 500);
      if (!candles || candles.length < 50) {
        return res.status(400).json({ error: `Not enough candle data for ${useTicker} ${useTf}` });
      }
      const config = {
        initialCapital: strategy.config?.initialCapital ?? 10000,
        commission: strategy.config?.commission ?? 0.0005,
        positionSize: strategy.config?.positionSize ?? 100,
        processOrdersOnClose: strategy.config?.processOrdersOnClose ?? false,
      };
      const result = runPineParityTest(plan, candles, {}, useTicker, useTf, config);
      console.log(`[Compiler Parity] Strategy ${strategyId} (${strategy.name}): match=${result.match}, path=${result.compiledPath}, speedup=${result.speedup}, diffs=${result.diffs.length > 0 ? result.diffs.join('; ') : 'none'}`);
      res.json({ strategy: strategy.name, ticker: useTicker, timeframe: useTf, bars: candles.length, ...result });
    } catch (err: any) {
      console.log(`[Compiler Parity] Error: ${err.message}`);
      res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
    }
  });

  app.post("/api/lab/queue/kick", requireLabAuth, async (req: Request, res: Response) => {
    const force = req.body?.force === true;
    console.log(`[QuantumLab] Manual queue kick requested (pumpRunning=${pumpQueueRunning}, force=${force}, activeWorker=${!!activeWorker})`);

    const allJobs = (labStorage as any).jobs as Map<string, any> | undefined;

    try {
      if (force) {
        const pausedRunIds: number[] = [];
        if (allJobs) {
          for (const [, job] of Array.from(allJobs.entries())) {
            if (job.runId && job.progress?.status !== "complete" && job.progress?.status !== "error") {
              pausedRunIds.push(job.runId);
            }
          }
        }

        if (activeWorker) {
          console.log(`[QuantumLab] Kick(force): terminating active worker`);
          try { activeWorker.postMessage({ type: "abort" }); } catch {}
          const workerRef = activeWorker;
          await Promise.race([
            new Promise<void>((resolve) => { workerRef.once("exit", () => resolve()); }),
            new Promise<void>(resolve => setTimeout(resolve, 2000)),
          ]);
          try { workerRef.terminate(); } catch {}
          clearActiveWorker();
        }

        for (const runId of pausedRunIds) {
          try {
            await labStorage.pauseRun(runId);
            console.log(`[QuantumLab] Kick(force): paused run ${runId}`);
          } catch (err: any) {
            console.log(`[QuantumLab] Kick(force): failed to pause run ${runId}: ${err.message}`);
          }
        }

        const evicted = labStorage.forceEvictAllJobs();
        console.log(`[QuantumLab] Kick(force): evicted ${evicted} in-memory job(s)`);
      } else {
        if (!activeWorker && !workerStarting && allJobs) {
          const dbRuns = await db.select({ id: labOptimizationRuns.id, status: labOptimizationRuns.status })
            .from(labOptimizationRuns);
          const liveStatusByRun = new Map(dbRuns.map(r => [r.id, r.status]));
          const liveStatuses = new Set(["running", "paused", "queued"]);
          for (const [, job] of Array.from(allJobs.entries())) {
            if (job.progress?.status !== "complete" && job.progress?.status !== "error") {
              const runId: number | undefined = job.runId;
              const dbStatus = runId ? liveStatusByRun.get(runId) : undefined;
              if (!runId || !dbStatus || !liveStatuses.has(dbStatus)) {
                job.progress.status = "error";
                job.progress.stage = "Evicted: orphaned job cleared by unstick";
                console.log(`[QuantumLab] Kick: evicted orphaned in-memory job ${job.id} (runId=${runId ?? "none"}, dbStatus=${dbStatus ?? "missing"})`);
              }
            }
          }
        }
      }
    } finally {
      if (pumpQueueRunning) {
        pumpQueueRunning = false;
        console.log(`[QuantumLab] Kick: reset stuck pumpQueueRunning flag`);
      }
      pumpQueue();
    }

    res.json({ success: true, force, message: force ? "Force-stopped active run; queue unstuck and pump triggered" : "Queue unstuck and pump triggered" });
  });

  let schedulerRunning = false;
  async function unifiedScheduler() {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      if (pumpQueueRunning || workerStarting) return;

      const HEARTBEAT_STALE_MS = 240_000;
      const RUN_STARTUP_GRACE_MS = 120_000;
      const now = Date.now();

      // CRITICAL: skip the DB orphan sweep entirely whenever a worker is alive
      // in this process. Only one worker runs at a time, so any "running" DB row
      // belongs to it. Sweeping here would race the worker (e.g. kill a run that's
      // still fetching candles before its first heartbeat).
      if (activeWorker) {
        const silenceMs = lastWorkerMessageTime ? now - lastWorkerMessageTime : 0;
        if (silenceMs > HEARTBEAT_STALE_MS) {
          console.log(`[QuantumLab] Scheduler: active worker silent for ${Math.round(silenceMs / 1000)}s, watchdog should handle — skipping`);
        }
        return;
      }

      const runningInDb = await db.select().from(labOptimizationRuns).where(
        eq(labOptimizationRuns.status, "running")
      );
      for (const run of runningInDb) {
        const cp = run.checkpoint as any;
        const lastHb = cp?.lastHeartbeat as number | undefined;
        if (lastHb && (now - lastHb) < HEARTBEAT_STALE_MS) {
          continue;
        }
        // Grace baseline survives server restarts: prefer heartbeat, then in-memory
        // dispatch time, then the run's DB createdAt. Without the createdAt fallback,
        // a freshly dispatched run that gets caught by a restart (lastRunStartedAt=0)
        // is killed within seconds even though it just started.
        const createdAtMs = run.createdAt instanceof Date
          ? run.createdAt.getTime()
          : (run.createdAt ? new Date(run.createdAt as any).getTime() : 0);
        const graceBaseline = lastHb ?? Math.max(lastRunStartedAt, createdAtMs);
        if (graceBaseline && (now - graceBaseline) < RUN_STARTUP_GRACE_MS) {
          continue;
        }
        const hasResults = cp?.completedCombos?.length > 0 || (cp?.currentCombo && cp?.currentIteration != null);
        if (hasResults) {
          await labStorage.pauseRun(run.id);
          console.log(`[QuantumLab] Scheduler: orphaned run ${run.id} → paused (heartbeat stale: ${lastHb ? Math.round((now - lastHb) / 1000) + 's ago' : 'none'})`);
          if (!labStorage.interruptedRunIds.includes(run.id)) {
            labStorage.interruptedRunIds.push(run.id);
          }
        } else {
          await labStorage.failRun(run.id);
          console.log(`[QuantumLab] Scheduler: orphaned run ${run.id} → failed (no progress, no heartbeat)`);
        }
        const orphanedJob = labStorage.getJobByRunId(run.id);
        if (orphanedJob && orphanedJob.progress.status !== "complete" && orphanedJob.progress.status !== "error") {
          orphanedJob.progress.status = "error";
          orphanedJob.progress.stage = "Evicted: orphaned by scheduler";
          console.log(`[QuantumLab] Scheduler: evicted in-memory job ${orphanedJob.id} for orphaned run ${run.id}`);
        }
      }

      if (lastWorkerMessageTime && (now - lastWorkerMessageTime) < HEARTBEAT_STALE_MS) {
        return;
      }

      if (lastRunStartedAt && (now - lastRunStartedAt) < RUN_STARTUP_GRACE_MS) {
        return;
      }

      const allPaused = await db.select().from(labOptimizationRuns).where(
        eq(labOptimizationRuns.status, "paused")
      );
      for (const run of allPaused) {
        const cp = run.checkpoint as any;
        const attempts = (cp?.autoResumeAttempts as number) ?? 0;
        if (attempts >= MAX_AUTO_RESUME_ATTEMPTS) {
          await labStorage.failRun(run.id, true);
          console.log(`[QuantumLab] Scheduler: run ${run.id} exhausted ${attempts} resume attempts → failed`);
        } else if (cp?.userCancelled || cp?.resourceError) {
          continue;
        } else if (!labStorage.interruptedRunIds.includes(run.id)) {
          labStorage.interruptedRunIds.push(run.id);
        }
      }

      if (hasWorkPending()) startKeepAlive();

      if (labStorage.interruptedRunIds.length > 0) {
        const resumed = await resumeNextInterruptedRun();
        if (resumed) return;
      }

      pumpQueue();
    } catch (err: any) {
      console.log(`[QuantumLab] Scheduler error: ${err.message}`);
    } finally {
      schedulerRunning = false;
    }
  }

  let initComplete = false;
  setTimeout(async () => {
    await labStorage.initPromise;
    initComplete = true;
    console.log(`[QuantumLab] Unified scheduler starting (runs every 30s)`);
    await unifiedScheduler();
  }, 5000);
  setInterval(async () => {
    if (!initComplete) return;
    await unifiedScheduler();
  }, 30_000);

  async function resumeNextInterruptedRun(): Promise<boolean> {
    if (labStorage.interruptedRunIds.length === 0) return false;
    if (activeWorker || workerStarting) return false;

    const candidateIds = [...labStorage.interruptedRunIds];
    for (const runId of candidateIds) {
      try {
        const run = await labStorage.getRun(runId);
        if (!run) {
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          console.log(`[QuantumLab] Recovery: run ${runId} not found, removed`);
          continue;
        }
        if (run.status === "running") {
          const cp = run.checkpoint as any;
          const lastHb = cp?.lastHeartbeat as number | undefined;
          const hbStale = !lastHb || (Date.now() - lastHb) > 240_000;
          if (hbStale) {
            await labStorage.pauseRun(runId);
            console.log(`[QuantumLab] Recovery: run ${runId} still running with stale heartbeat → paused first`);
          } else {
            labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
            console.log(`[QuantumLab] Recovery: run ${runId} actively running (recent heartbeat), removed from recovery`);
            continue;
          }
        } else if (run.status !== "paused") {
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          console.log(`[QuantumLab] Recovery: run ${runId} no longer paused (status=${run.status}), removed`);
          continue;
        }

        const cp = run.checkpoint && typeof run.checkpoint === "object" ? run.checkpoint as any : null;
        if (cp?.userCancelled) {
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          console.log(`[QuantumLab] Recovery: run ${runId} was user-cancelled, removed`);
          continue;
        }

        if (cp?.resourceError) {
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          console.log(`[QuantumLab] Recovery: run ${runId} was resource/OOM-paused, skipping`);
          continue;
        }

        if (!cp) {
          console.log(`[QuantumLab] Recovery: run ${runId} has null checkpoint, attempting config recovery from run record`);
        }

        const crashCount = (cp?.autoResumeAttempts as number) ?? 0;
        if (crashCount >= MAX_AUTO_RESUME_ATTEMPTS) {
          console.log(`[QuantumLab] Recovery: run ${runId} exhausted auto-resume attempts (${crashCount}/${MAX_AUTO_RESUME_ATTEMPTS}), force-failing`);
          await db.update(labOptimizationRuns).set({
            status: "failed",
            completedAt: new Date(),
          }).where(eq(labOptimizationRuns.id, runId));
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          continue;
        }

        if (activeWorker) {
          console.log(`[QuantumLab] Recovery: worker became active during check, aborting`);
          return false;
        }

        const safeCheckpoint = cp ?? { completedCombos: [], configSnapshot: null } as any;
        const hasProgress = safeCheckpoint.completedCombos?.length > 0 || (safeCheckpoint.currentCombo && safeCheckpoint.currentIteration != null);
        const config = await extractConfigForResume(safeCheckpoint, runId);
        if (!config) {
          console.log(`[QuantumLab] Recovery: unrecoverable config for run ${runId}, failing`);
          await db.update(labOptimizationRuns).set({ status: "failed", completedAt: new Date() }).where(eq(labOptimizationRuns.id, runId));
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          continue;
        }
        safeCheckpoint.configSnapshot = config;
        await labStorage.saveCheckpoint(runId, safeCheckpoint);
        const checkpoint: LabCheckpoint = safeCheckpoint;

        if (hasProgress && checkpoint.currentCombo && !checkpoint.partialResults?.length) {
          const dbResults = await labStorage.getRunResults(runId);
          const comboResults = dbResults.filter(r => `${r.ticker}|${r.timeframe}` === checkpoint.currentCombo);
          if (comboResults.length > 0) {
            checkpoint.partialResults = comboResults.map(r => ({
              ticker: r.ticker, timeframe: r.timeframe,
              netProfitPercent: r.netProfitPercent, winRatePercent: r.winRatePercent,
              maxDrawdownPercent: r.maxDrawdownPercent, profitFactor: r.profitFactor,
              totalTrades: r.totalTrades, params: r.params as Record<string, any>,
              trades: (r.trades as any[]) ?? [], equityCurve: (r.equityCurve as any[]) ?? [],
            }));
          }
        }

        let retryPooc: boolean | undefined;
        if (run.strategyId) {
          const strat = await labStorage.getStrategy(run.strategyId);
          if (strat?.strategySettings && typeof strat.strategySettings === "object") {
            retryPooc = (strat.strategySettings as any).processOrdersOnClose;
            if ((strat.strategySettings as any).nativeEngine) {
              delete config.pineScript;
              config.engineType = (strat.strategySettings as any).engineType;
            }
          }
        }

        const claimed = await labStorage.claimPausedRunForResume(runId);
        if (!claimed) {
          console.log(`[QuantumLab] Recovery: failed to claim run ${runId} (status changed)`);
          labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
          continue;
        }

        let startedOk = false;
        try {
          const newJob = labStorage.createJob(config, { forRunId: runId, hasActiveWorker: false });
          newJob.runId = runId;
          newJob.walletAddress = run.userId ?? undefined;

          const resumeCheckpoint = hasProgress
            ? checkpoint
            : { completedCombos: [], configSnapshot: config, autoResumeAttempts: checkpoint.autoResumeAttempts } as LabCheckpoint;
          const attempt = crashCount + 1;
          const detail = hasProgress
            ? (checkpoint.completedCombos?.length
              ? `${checkpoint.completedCombos.length} combos done`
              : `mid-combo ${checkpoint.currentCombo} at iter ${checkpoint.currentIteration}`)
            : "from scratch";
          console.log(`[QuantumLab] Recovery: auto-resuming run ${runId} (${detail}, attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS})`);
          startOptimizationJob(config, newJob, runId, resumeCheckpoint, undefined, undefined, undefined, retryPooc);
          startedOk = true;
        } finally {
          if (!startedOk) {
            console.log(`[QuantumLab] Recovery: startup failed for run ${runId}, rolling back`);
            await labStorage.pauseRun(runId).catch(() => {});
          }
        }

        labStorage.interruptedRunIds = labStorage.interruptedRunIds.filter(id => id !== runId);
        return true;
      } catch (err: any) {
        console.log(`[QuantumLab] Recovery error for run ${runId}: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  labCleanup = async (reason: string) => {
    console.log(`[QuantumLab] ${reason} — pausing active jobs...`);
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
      clearActiveWorker();
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
              .then(() => console.log(`[QuantumLab] Job ${jobId} (run ${job.runId}) → paused on ${reason}`))
              .catch((err: any) => console.log(`[QuantumLab] Failed to pause run ${job.runId} on ${reason}: ${err.message}`))
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
}
