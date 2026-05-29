import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";
import { ensureSchema, checkUmkStorageSecretHealth, logSecurityConfigSummary } from "./db";
import { startPeriodicReconciliation } from "./reconciliation-service";
import { startOrphanedSubaccountCleanup } from "./orphaned-subaccount-cleanup";
import { startPnlSnapshotJob } from "./pnl-snapshot-job";
import { startRetryWorker, queueTradeRetry } from "./trade-retry-service";
import { startProfitShareRetryJob } from "./profit-share-retry-job";
import { startReferralRewardsRetryJob } from "./referral-rewards-retry-job";
import { startPacificaReferralBackfillJob } from "./pacifica-referral-backfill-job";
import { initLeverageCache, setOnCacheRefreshed } from "./leverage-cache-service";
import { startPortfolioSnapshotJob } from "./portfolio-snapshot-job";
import { startTelegramDailySummaryJob } from "./telegram-daily-summary-job";

async function trySyncMarketRegistry(): Promise<void> {
  try {
    const { getDefaultAdapter } = await import("./protocol/adapter-registry");
    const { updateMarketCache } = await import("./market-registry");
    const adapter = getDefaultAdapter();
    const markets = await adapter.getMarkets();
    if (markets.length > 0) {
      updateMarketCache(markets);
    }
  } catch (err: any) {
    console.warn('[Startup] Market registry sync skipped:', err.message || err);
  }
}

async function initializeProtocolAdapter(): Promise<void> {
  try {
    const { PacificaAdapter } = await import("./protocol/pacifica/pacifica-adapter");
    const { registerAdapter, setAdapterHealth } = await import("./protocol/adapter-registry");
    const { updateMarketCache } = await import("./market-registry");
    // Task 143: thread builder code & referral identifier. Values are public
    // identifiers (not secrets) locked in with Pacifica; env vars are overrides
    // for testing / future migrations. If both are blanked the helpers become
    // no-ops and orders ship without builder_code (status quo).
    const adapter = new PacificaAdapter({
      builderCode: process.env.PACIFICA_BUILDER_CODE ?? 'QuantumVault',
      referralAddress: process.env.PACIFICA_REFERRAL_ADDRESS ?? 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
    });
    registerAdapter(adapter);
    await adapter.initialize();
    const markets = await adapter.getMarkets();
    if (markets.length > 0) {
      updateMarketCache(markets);
    }
    setAdapterHealth('pacifica', 'ready');
    console.log('[Startup] Pacifica adapter registered and initialized');
  } catch (err: any) {
    console.error('[Startup] Pacifica adapter initialization failed:', err.message || err);
    try {
      const { setAdapterHealth } = await import("./protocol/adapter-registry");
      setAdapterHealth('pacifica', 'degraded');
    } catch { }
  }

  // Group D item 17 (April 17, 2026): register DriftAdapter alongside Pacifica.
  // Separate try-block so a Drift initialization failure cannot take down Pacifica
  // (which carries the entire live trading load: $200K+ volume, 9 active bots).
  // Bots route to this adapter only when their row has active_protocol='drift'
  // — enforced by the schema CHECK constraint (item 18) and the NOT NULL column.
  // Registration alone is safe: any bot with active_protocol='drift' resolves
  // here through getAdapterForBot(); the prior null-fallback bandaid for dormant
  // legacy rows was removed alongside item 18 closeout (rows backfilled to 'drift').
  //
  // initialize() is wrapped in a hard timeout: if Drift's RPC failover or SDK
  // load hangs, the bounded race rejects so the rest of startup (route binding,
  // server.listen) is not blocked. Adapter is marked degraded on timeout —
  // future calls to getAdapter('drift') still return the registered instance,
  // they just hit an uninitialized DriftClient and surface a real error rather
  // than silently waiting forever.
  const DRIFT_INIT_TIMEOUT_MS = 30_000;
  try {
    const { DriftAdapter } = await import("./protocol/drift/drift-adapter");
    const { registerAdapter, setAdapterHealth } = await import("./protocol/adapter-registry");
    const driftAdapter = new DriftAdapter();
    registerAdapter(driftAdapter);
    await Promise.race([
      driftAdapter.initialize(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`DriftAdapter.initialize() timed out after ${DRIFT_INIT_TIMEOUT_MS}ms`)),
          DRIFT_INIT_TIMEOUT_MS,
        ),
      ),
    ]);
    setAdapterHealth('drift', 'ready');
    console.log('[Startup] Drift adapter registered and initialized');
  } catch (err: any) {
    console.error('[Startup] Drift adapter initialization failed:', err.message || err);
    try {
      const { setAdapterHealth, listAdapters } = await import("./protocol/adapter-registry");
      if (listAdapters().includes('drift')) {
        setAdapterHealth('drift', 'degraded');
      }
    } catch { }
  }
}
import { createLabSupervisor, getLabAuthSecret } from "./lab/supervisor";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const httpServer = createServer(app);
const labSupervisor = createLabSupervisor();

export function getLabSupervisor() {
  return labSupervisor;
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Health check endpoint - must respond quickly for deployment health checks
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// UNIVERSAL early request logging - captures ALL requests before any processing
app.use((req, res, next) => {
  // Log ALL POST requests to /api/ routes
  if (req.method === 'POST' && req.path.startsWith('/api/')) {
    console.log(`[UNIVERSAL-LOG] ${req.method} ${req.path} - Origin: ${req.headers.origin} - Content-Type: ${req.headers['content-type']}`);
  }
  // Extra verbose for execution endpoints
  if (req.path.includes('enable-execution') || req.path.includes('revoke-execution')) {
    console.log(`[early-log] ${req.method} ${req.path} - Content-Type: ${req.headers['content-type']} - Cookie: ${req.headers.cookie?.slice(0, 50)}...`);
  }
  next();
});

// Lab proxy — runs BEFORE the JSON body parser so request bodies are
// forwarded as-is (no double-parse). Session middleware is applied inline
// to extract the wallet address for the trusted header.
import { sessionMiddleware } from "./session";

const labProxy = createProxyMiddleware({
  target: `http://127.0.0.1:5050`,
  router: () => `http://127.0.0.1:${labSupervisor.labPort}`,
  changeOrigin: false,
  selfHandleResponse: false,
  timeout: 300_000,
  proxyTimeout: 3_600_000,
  on: {
    proxyReq: (proxyReq, _req) => {
      proxyReq.removeHeader("x-lab-auth");
      proxyReq.removeHeader("x-lab-wallet");

      const req = _req as any;
      const walletAddress = req.session?.walletAddress;
      if (walletAddress) {
        proxyReq.setHeader("x-lab-wallet", walletAddress);
      }
      proxyReq.setHeader("x-lab-auth", getLabAuthSecret());
    },
    error: (err, _req, res) => {
      console.error(`[LabProxy] Proxy error: ${err.message}`);
      if (res && "writeHead" in res && !res.headersSent) {
        const body = JSON.stringify({
          error: "QuantumLab service unavailable",
          message: "The lab process is starting up or temporarily unavailable. Please try again.",
        });
        (res as any).writeHead(503, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        (res as any).end(body);
      }
    },
  },
});

import { db } from "./db";
import { labOptimizationRuns, labStrategies, labOptimizationConfigSchema } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

const labQueueBodyParser = express.json({ limit: "10mb" });

app.post("/api/lab/run-optimization", (req: Request, res: Response, next: NextFunction) => {
  if (labSupervisor.isReady) return next();
  sessionMiddleware(req, res, (err) => {
    if (err) return next(err);
    labQueueBodyParser(req, res, async () => {
      try {
        const walletAddress = (req as any).session?.walletAddress;
        if (!walletAddress) return res.status(401).json({ error: "Not authenticated" });
        const parsed = labOptimizationConfigSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
        const config = parsed.data;
        if (!config.strategyId) return res.status(400).json({ error: "strategyId is required for queuing" });

        const orderResult = await db.select({ maxOrder: sql<number>`COALESCE(MAX(${labOptimizationRuns.queueOrder}), 0)` })
          .from(labOptimizationRuns).where(eq(labOptimizationRuns.status, "queued"));
        const queueOrder = (orderResult[0]?.maxOrder ?? 0) + 1;

        const [run] = await db.insert(labOptimizationRuns).values({
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
          queueOrder,
          configSnapshot: { type: "new", config } as any,
        }).returning();

        console.log(`[LabQueue] Lab not ready — queued run ${run.id} directly (order: ${queueOrder})`);
        res.json({ queued: true, runId: run.id, queueOrder });
      } catch (e: any) {
        console.error(`[LabQueue] Direct queue failed: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });
  });
});

app.post("/api/lab/runs/:id/refine", (req: Request, res: Response, next: NextFunction) => {
  if (labSupervisor.isReady) return next();
  sessionMiddleware(req, res, (err) => {
    if (err) return next(err);
    labQueueBodyParser(req, res, async () => {
      try {
        const walletAddress = (req as any).session?.walletAddress;
        if (!walletAddress) return res.status(401).json({ error: "Not authenticated" });
        const runId = parseInt(req.params.id);
        const { ticker, timeframe } = req.body;
        if (!ticker || !timeframe) return res.status(400).json({ error: "ticker and timeframe required" });

        const [sourceRun] = await db.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.id, runId));
        if (!sourceRun) return res.status(404).json({ error: "Source run not found" });
        if (sourceRun.userId !== walletAddress) return res.status(403).json({ error: "Not your run" });

        const [strategy] = await db.select().from(labStrategies).where(eq(labStrategies.id, sourceRun.strategyId));
        if (!strategy) return res.status(404).json({ error: "Strategy not found" });

        const parsedInputs = strategy.parsedInputs as any[];
        if (!parsedInputs?.length) return res.status(400).json({ error: "Strategy has no parsed inputs" });

        const sourceConfig = sourceRun.checkpoint && typeof sourceRun.checkpoint === "object"
          ? (sourceRun.checkpoint as any).configSnapshot : null;
        const randomSamples = sourceConfig?.randomSamples ?? sourceRun.randomSamples ?? 2000;
        const topK = sourceConfig?.topK ?? sourceRun.topK ?? 30;
        const refinementsPerSeed = sourceConfig?.refinementsPerSeed ?? sourceRun.refinementsPerSeed ?? 60;

        const config = {
          pineScript: strategy.pineScript,
          parsedInputs,
          tickers: [ticker],
          timeframes: [timeframe],
          startDate: sourceConfig?.startDate ?? sourceRun.startDate ?? new Date(Date.now() - 365*24*60*60*1000).toISOString().split("T")[0],
          endDate: sourceConfig?.endDate ?? sourceRun.endDate ?? new Date().toISOString().split("T")[0],
          randomSamples, topK, refinementsPerSeed,
          minTrades: sourceConfig?.minTrades ?? sourceRun.minTrades ?? 10,
          maxDrawdownCap: sourceConfig?.maxDrawdownCap ?? sourceRun.maxDrawdownCap ?? 85,
          mode: "sweep" as const,
          strategyId: sourceRun.strategyId,
          useInsights: true,
          coordinateTune: true,
        };

        const orderResult = await db.select({ maxOrder: sql<number>`COALESCE(MAX(${labOptimizationRuns.queueOrder}), 0)` })
          .from(labOptimizationRuns).where(eq(labOptimizationRuns.status, "queued"));
        const queueOrder = (orderResult[0]?.maxOrder ?? 0) + 1;

        const [newRun] = await db.insert(labOptimizationRuns).values({
          strategyId: sourceRun.strategyId,
          userId: walletAddress,
          tickers: [ticker],
          timeframes: [timeframe],
          startDate: config.startDate,
          endDate: config.endDate,
          randomSamples, topK, refinementsPerSeed,
          minTrades: config.minTrades,
          maxDrawdownCap: config.maxDrawdownCap,
          mode: "sweep",
          status: "queued",
          queueOrder,
          configSnapshot: {
            type: "refine", config, sourceRunId: runId,
            targetTicker: ticker, targetTimeframe: timeframe,
          } as any,
        }).returning();

        console.log(`[LabQueue] Lab not ready — queued refine run ${newRun.id} for ${ticker} ${timeframe} (order: ${queueOrder})`);
        res.json({ queued: true, runId: newRun.id, queueOrder });
      } catch (e: any) {
        console.error(`[LabQueue] Direct refine queue failed: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });
  });
});

app.post("/api/lab/job/:id/cancel", (req: Request, res: Response, next: NextFunction) => {
  if (labSupervisor.isReady) return next();
  sessionMiddleware(req, res, async (err) => {
    if (err) return next(err);
    const walletAddress = (req as any).session?.walletAddress;
    if (!walletAddress) return res.status(401).json({ error: "Not authenticated" });
    try {
      const runningRuns = await db.select().from(labOptimizationRuns)
        .where(eq(labOptimizationRuns.status, sql`'running'`));
      const userRun = runningRuns.find(r => r.userId === walletAddress);
      if (userRun) {
        await db.update(labOptimizationRuns)
          .set({ status: "paused" })
          .where(eq(labOptimizationRuns.id, userRun.id));
        console.log(`[LabCancel] Lab not ready — force-paused run ${userRun.id} for ${walletAddress}`);
      }
      res.json({ success: true });
    } catch (e: any) {
      console.error(`[LabCancel] Direct cancel failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
});

app.use("/api/lab", (req: Request, res: Response, next: NextFunction) => {
  sessionMiddleware(req, res, (err) => {
    if (err) return next(err);
    if (!labSupervisor.isReady) {
      return res.status(503).json({
        error: "QuantumLab service unavailable",
        message: "The lab process is starting up. Please try again shortly.",
      });
    }
    req.url = req.originalUrl;
    labProxy(req, res, next);
  });
});

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const jsonStr = JSON.stringify(capturedJsonResponse);
        if (jsonStr.length > 500) {
          logLine += ` :: [${jsonStr.length} bytes]`;
        } else {
          logLine += ` :: ${jsonStr}`;
        }
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await ensureSchema();
  await checkUmkStorageSecretHealth();
  await logSecurityConfigSummary();

  try {
    const { db: appDb } = await import("./db");
    const { pendingProfitShares } = await import("@shared/schema");
    const { isNull, sql: drizzleSql } = await import("drizzle-orm");
    const updated = await appDb.update(pendingProfitShares)
      .set({ protocolSubaccountId: drizzleSql`CAST(${pendingProfitShares.driftSubaccountId} AS text)` })
      .where(isNull(pendingProfitShares.protocolSubaccountId));
    if (updated.rowCount && updated.rowCount > 0) {
      console.log(`[Startup] Backfilled ${updated.rowCount} pending_profit_shares.protocol_subaccount_id from drift_subaccount_id`);
    }
  } catch (bfErr: any) {
    console.warn('[Startup] protocol_subaccount_id backfill skipped:', bfErr.message);
  }

  await initializeProtocolAdapter();

  labSupervisor.start().catch((err) => {
    console.error(`[LabSupervisor] Initial start failed: ${err.message}`);
  });

  await registerRoutes(httpServer, app);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    // Log body-parser errors to help debug JSON parsing issues
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      console.log(`[body-parser error] ${req.method} ${req.path} - ${err.message}`);
      return res.status(400).json({ error: 'Invalid JSON body', details: err.message });
    }
    
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    
    console.log(`[express error] ${req.method} ${req.path} - ${status} ${message}`);
    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // Validate SERVER_EXECUTION_KEY format on startup
  const serverKey = process.env.SERVER_EXECUTION_KEY;
  if (!serverKey) {
    console.error('[SECURITY] SERVER_EXECUTION_KEY is not set! Execution authorization will fail.');
  } else {
    console.log(`[SECURITY] SERVER_EXECUTION_KEY: length=${serverKey.length} (expected 64 hex chars)`);
    if (serverKey.length !== 64) {
      console.error(`[SECURITY] SERVER_EXECUTION_KEY has wrong length! Got ${serverKey.length}, expected 64`);
    } else if (!/^[0-9a-fA-F]+$/.test(serverKey)) {
      console.error('[SECURITY] SERVER_EXECUTION_KEY contains non-hex characters!');
    } else {
      console.log('[SECURITY] SERVER_EXECUTION_KEY format is valid');
    }
  }

  const shutdownHandler = async () => {
    console.log("[Main] Shutting down (lab process will continue running)...");
    await labSupervisor.shutdown();
    httpServer.close();
  };
  process.on("SIGTERM", () => shutdownHandler().catch(() => process.exit(1)));
  process.on("SIGINT", () => shutdownHandler().catch(() => process.exit(1)));

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      log(`serving on port ${port}`);
      
      // Staggered startup: services start in sequence with delays to avoid RPC rate-limit bursts

      // Immediately: orphaned trade cleanup — queue interrupted trades for retry
      const OPEN_STALENESS_MS = 5 * 60 * 1000;
      const CLOSE_STALENESS_MS = 30 * 60 * 1000;
      try {
        const orphanedTrades = await storage.getOrphanedPendingTrades(2);
        if (orphanedTrades.length > 0) {
          log(`Found ${orphanedTrades.length} orphaned pending trades, queueing for retry`);
          for (const trade of orphanedTrades) {
            const rawSide = trade.side.toLowerCase();
            if (rawSide !== "long" && rawSide !== "short" && rawSide !== "close") {
              await storage.updateBotTrade(trade.id, {
                status: "failed",
                errorMessage: `Trade interrupted by server restart — unrecognized side '${trade.side}', cannot retry`,
              });
              log(`Trade ${trade.id} has unrecognized side '${trade.side}', marked failed`);
              continue;
            }
            const normalizedSide = rawSide as "long" | "short" | "close";
            const isClose = normalizedSide === "close";
            const tradeAge = Date.now() - new Date(trade.executedAt).getTime();
            const maxAge = isClose ? CLOSE_STALENESS_MS : OPEN_STALENESS_MS;

            if (tradeAge > maxAge) {
              const ageMin = Math.round(tradeAge / 60000);
              await storage.updateBotTrade(trade.id, {
                status: "failed",
                errorMessage: `Trade interrupted by server restart and too stale to retry (age: ${ageMin}min, limit: ${Math.round(maxAge / 60000)}min)`,
              });
              log(`Trade ${trade.id} too stale to retry (${ageMin}min old, side=${trade.side}) — marked failed`);
              continue;
            }

            const bot = await storage.getTradingBotById(trade.tradingBotId);
            const wallet = await storage.getWallet(trade.walletAddress);
            if (!bot || !wallet) {
              await storage.updateBotTrade(trade.id, {
                status: "failed",
                errorMessage: "Trade interrupted by server restart — bot or wallet not found for retry",
              });
              log(`Trade ${trade.id} cannot retry — bot or wallet not found, marked failed`);
              continue;
            }

            if (bot.driftSubaccountId == null && !bot.protocolSubaccountId) {
              await storage.updateBotTrade(trade.id, {
                status: "failed",
                errorMessage: "Trade interrupted by server restart — bot has no subaccount context (neither drift nor protocol), cannot safely retry",
              });
              log(`Trade ${trade.id} cannot retry — bot ${bot.id} missing both driftSubaccountId and protocolSubaccountId, marked failed`);
              continue;
            }

            try {
              const retryJobId = await queueTradeRetry({
                botId: trade.tradingBotId,
                walletAddress: trade.walletAddress,
                agentPublicKey: bot.agentPublicKey || wallet.agentPublicKey || "",
                market: trade.market,
                side: normalizedSide,
                size: parseFloat(trade.size),
                subAccountId: bot.driftSubaccountId ?? 0,
                protocolSubaccountId: bot.protocolSubaccountId ?? undefined,
                reduceOnly: isClose,
                slippageBps: wallet.slippageBps || 50,
                priority: isClose ? "critical" : "normal",
                lastError: "Trade interrupted by server restart",
                originalTradeId: trade.id,
                webhookPayload: trade.webhookPayload,
                entryPrice: undefined,
              });
              log(`Queued orphaned trade ${trade.id} for ${isClose ? "critical" : "normal"} retry (job ${retryJobId})`);
            } catch (retryErr) {
              await storage.updateBotTrade(trade.id, {
                status: "failed",
                errorMessage: `Trade interrupted by server restart — failed to queue retry: ${retryErr}`,
              });
              log(`Failed to queue retry for trade ${trade.id}: ${retryErr}`);
            }
          }
        }
      } catch (error) {
        console.error("Error cleaning up orphaned trades:", error);
      }

      // ~5s: trade retry worker (recovers in-flight trades soonest)
      setTimeout(() => {
        log('[Staggered startup] Starting retry worker');
        startRetryWorker();
      }, 5_000);

      // ~15s: periodic position reconciliation (important but can wait a few seconds)
      setTimeout(() => {
        log('[Staggered startup] Starting periodic reconciliation');
        startPeriodicReconciliation();
      }, 15_000);

      setTimeout(() => {
        log('[Staggered startup] Syncing market registry');
        trySyncMarketRegistry().catch(err => console.error('Failed to sync market registry:', err));
      }, 15_000);

      // ~20s: leverage cache (single batch RPC call to read perp market accounts)
      setTimeout(async () => {
        log('[Staggered startup] Initializing leverage cache');
        const { invalidateMarketCache } = await import('./market-liquidity-service');
        setOnCacheRefreshed(() => {
          invalidateMarketCache();
          log('[LeverageCache] Market cache invalidated after leverage/status refresh');
        });
        initLeverageCache().catch(err => console.error('Failed to initialize leverage cache:', err));
      }, 20_000);

      // ~30s: orphaned subaccount cleanup (low priority, on-chain calls)
      setTimeout(() => {
        log('[Staggered startup] Starting orphaned subaccount cleanup');
        startOrphanedSubaccountCleanup();
      }, 30_000);

      // ~45s: periodic snapshot/retry jobs (don't need to run immediately)
      setTimeout(() => {
        log('[Staggered startup] Starting PnL snapshot job');
        startPnlSnapshotJob();
        log('[Staggered startup] Running Task 119 portfolio backfill (one-shot)');
        import('./portfolio-snapshot-backfill').then(({ runPortfolioBackfillOnce }) => {
          runPortfolioBackfillOnce().catch(err => console.error('[PortfolioBackfill] error:', err));
        });
        log('[Staggered startup] Starting portfolio snapshot job');
        startPortfolioSnapshotJob();
        log('[Staggered startup] Starting profit share retry job');
        startProfitShareRetryJob();
        log('[Staggered startup] Starting referral rewards retry job');
        startReferralRewardsRetryJob();
        log('[Staggered startup] Starting Pacifica referral backfill job');
        startPacificaReferralBackfillJob();
        log('[Staggered startup] Starting Telegram daily summary job');
        startTelegramDailySummaryJob();
        log('[Staggered startup] Starting stats consistency monitor');
        import('./stats-consistency-monitor').then(({ startStatsConsistencyMonitor }) => {
          startStatsConsistencyMonitor();
        });
      }, 45_000);
    },
  );
})();
