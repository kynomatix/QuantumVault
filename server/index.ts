import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";
import { ensureSchema, checkUmkStorageSecretHealth, logSecurityConfigSummary, closePool, whenPoolHasHeadroom } from "./db";
import { startPeriodicReconciliation } from "./reconciliation-service";
import { startOrphanedSubaccountCleanup } from "./orphaned-subaccount-cleanup";
import { startSubaccountLeaseRecoveryJob } from "./subaccount-lease-recovery";
import { startPnlSnapshotJob } from "./pnl-snapshot-job";
import { startRetryWorker, queueTradeRetry } from "./trade-retry-service";
import { startProfitShareRetryJob } from "./profit-share-retry-job";
import { startReferralRewardsRetryJob } from "./referral-rewards-retry-job";
import { startPacificaReferralBackfillJob } from "./pacifica-referral-backfill-job";
import { initLeverageCache, setOnCacheRefreshed } from "./leverage-cache-service";
import { initLiveDataSpine, stopLiveDataSpine } from "./live-data-spine/spine-service";
import { logHermesAuthStatus } from "./pricing/hermes-config.js";
import { startPortfolioSnapshotJob } from "./portfolio-snapshot-job";
import { startTelegramDailySummaryJob } from "./telegram-daily-summary-job";
import { recordCriticalError, flushErrorLog } from "./error-log";
import * as os from "node:os";
import { appendTelemetry } from "./telemetry";

// Global crash capture for the admin "Errors" panel. Registered at module load so it catches
// failures from any background job. Both handlers record the error then preserve Node's default
// hard-crash semantics (flush + exit so the platform restarts us into a known-clean state). This
// is the fail-closed choice for a money platform: a possibly-corrupt process must NOT keep
// executing trades. Money paths already fail closed on their own; anything reaching here is, by
// definition, an uncaught invariant we don't want to run on.
process.on("unhandledRejection", (reason: any) => {
  recordCriticalError({
    category: "crash",
    severity: "critical",
    source: "unhandledRejection",
    error: reason,
    message: reason?.message ? String(reason.message) : `Unhandled rejection: ${String(reason)}`,
  });
  console.error("[unhandledRejection]", reason);
  const hardExit = setTimeout(() => process.exit(1), 2000);
  if (typeof hardExit.unref === "function") hardExit.unref();
  flushErrorLog().finally(() => process.exit(1));
});
process.on("uncaughtException", (err: any) => {
  recordCriticalError({
    category: "crash",
    severity: "critical",
    source: "uncaughtException",
    error: err,
    message: err?.message ? String(err.message) : `Uncaught exception: ${String(err)}`,
  });
  console.error("[uncaughtException]", err);
  const hardExit = setTimeout(() => process.exit(1), 2000);
  if (typeof hardExit.unref === "function") hardExit.unref();
  flushErrorLog().finally(() => process.exit(1));
});

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

  // Flash Trade adapter — Phase 1 foundation (markets + prices only).
  // Registered here so getAdapterForBot() resolves for active_protocol='flash' rows.
  // No bot is currently created with active_protocol='flash'; registration is safe
  // and zero-cost. Trading methods throw NotImplemented until Phase 2.
  // Separate try-block: a Flash init failure must not affect Pacifica or Drift.
  try {
    const { FlashAdapter } = await import("./protocol/flash/flash-adapter");
    const { registerAdapter, setAdapterHealth } = await import("./protocol/adapter-registry");
    const flashAdapterInstance = new FlashAdapter();
    registerAdapter(flashAdapterInstance);
    await flashAdapterInstance.initialize();
    setAdapterHealth('flash', 'ready');
    console.log('[Startup] Flash adapter registered and initialized');
  } catch (err: any) {
    console.error('[Startup] Flash adapter initialization failed:', err.message || err);
    try {
      const { setAdapterHealth, listAdapters } = await import("./protocol/adapter-registry");
      if (listAdapters().includes('flash')) {
        setAdapterHealth('flash', 'degraded');
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
import { registerCreatorRoutes } from "./ai-assistant/routes";
import { registerLogAccessRoutes } from "./log-access";

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

// AI Strategy Creator (Task 187) — registered in the MAIN process BEFORE the lab
// proxy because these routes need the Express session + V3 UMK, which the lab CHILD
// process does not have. They read the wallet only from the session (never a token).
registerCreatorRoutes(app, sessionMiddleware as any, () => labSupervisor.labPort);

// Read-only log access for external reviewers/cronjobs (Bearer LOG_READ_TOKEN).
// GET-only, fail-closed when the token is unset, dedicated token ≠ ADMIN_PASSWORD.
registerLogAccessRoutes(app);

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

    // DB pool exhaustion / connection timeout → 503 so clients can retry safely
    const msg = err?.message || "";
    const isPoolPressure =
      msg.includes("Connection terminated") ||
      msg.includes("connection timeout") ||
      msg.includes("timeout exceeded") ||
      msg.includes("too many clients") ||
      msg.includes("Authentication timed out") ||
      msg.includes("Connection acquisition timeout") ||
      msg.includes("ECONNREFUSED");
    if (isPoolPressure) {
      console.warn(`[DB pressure] ${req.method} ${req.path} → 503: ${msg}`);
      res.set("Retry-After", "5");
      return res.status(503).json({ message: "Service temporarily unavailable — please retry in a moment" });
    }

    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.log(`[express error] ${req.method} ${req.path} - ${status} ${message}`);

    // Surface genuine server errors (5xx) in the admin panel. 4xx (client/validation) and the
    // 503 backpressure path above are deliberately excluded so the log stays signal, not noise.
    if (status >= 500) {
      recordCriticalError({
        category: "server_500",
        severity: "error",
        source: "express",
        message: `${req.method} ${req.path} → ${status}: ${message}`,
        detail: err?.stack ? String(err.stack) : undefined,
        context: { method: req.method, path: req.path, status },
      });
    }

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

  // Shutdown MUST end in process.exit(). This process runs dozens of setInterval
  // loops (monitors, scanners, reconcilers, Telegram polling); without an explicit
  // exit the event loop stays alive forever after SIGTERM, and the old instance
  // lingers as a zombie next to the replacement — stacking full app instances
  // (each with a lab child) on the production VM until it is starved. That zombie
  // pile-up was the root cause of the July 17, 2026 all-AI-Traders outage (DB/OKX
  // handshake timeouts, lab boot-loop, healthcheck deaths). Never remove the
  // exit calls or the hard-exit backstop.
  // Death canary: telemetry markers for every process birth and death, so a
  // future "what killed the app?" question is answerable from the log file
  // alone. Also critical for readers of the prod log API: publishing snapshots
  // the workspace INCLUDING logs/telemetry.log, so the prod file starts with
  // dev-workspace history — these [Boot] env= markers let any reader segment
  // process generations and tell workspace lines from live deployment lines.
  const bootEnv = process.env.REPLIT_DEPLOYMENT ? "production" : "workspace";
  appendTelemetry(`[Boot] pid=${process.pid} env=${bootEnv} node=${process.version}`);
  process.on("exit", (code) => {
    // appendTelemetry is fully synchronous (appendFileSync) — safe in 'exit'.
    appendTelemetry(
      `[Lifecycle] exit code=${code} pid=${process.pid} uptime=${Math.round(process.uptime())}s`,
    );
  });

  let shuttingDown = false;
  const shutdownHandler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Main] ${signal} received — shutting down...`);
    appendTelemetry(
      `[Lifecycle] ${signal} received pid=${process.pid} uptime=${Math.round(process.uptime())}s`,
    );
    // Backstop: if any cleanup step below hangs, force-exit anyway. unref'd so
    // it never delays a clean exit.
    const hardExit = setTimeout(() => {
      console.error("[Main] Shutdown grace period (10s) expired — forcing exit");
      process.exit(0);
    }, 10_000);
    if (typeof hardExit.unref === "function") hardExit.unref();
    // Stop the AI Trader monitor FIRST so no tick can start a new venue order
    // that would be cut mid-flight by the exit below.
    try {
      const { stopAiTraderMonitor } = await import("./ai-trader/monitor");
      stopAiTraderMonitor();
    } catch (e) {
      console.warn("[Main] AI Trader monitor stop error (non-fatal):", (e as Error)?.message);
    }
    try {
      stopLiveDataSpine();
    } catch (e) {
      console.warn("[Main] Spine stop error (non-fatal):", (e as Error)?.message);
    }
    await flushErrorLog().catch(() => {});
    await labSupervisor.shutdown();
    await closePool().catch((e) => console.warn("[Main] Pool close error (non-fatal):", e.message));
    try {
      httpServer.close();
    } catch {}
    console.log("[Main] Shutdown complete — exiting");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdownHandler("SIGTERM").catch(() => process.exit(1)));
  process.on("SIGINT", () => shutdownHandler("SIGINT").catch(() => process.exit(1)));

  // Resource telemetry: one compact line per minute so a starved VM is visible
  // in production logs (the July 17 outage had zero memory/load evidence).
  // unref'd — never keeps a shutting-down process alive.
  const logResources = () => {
    try {
      const m = process.memoryUsage();
      const mb = (n: number) => Math.round(n / 1048576);
      const gb = (n: number) => (n / 1073741824).toFixed(2);
      const resourceLine =
        `[Resources] rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB ` +
        `free=${gb(os.freemem())}/${gb(os.totalmem())}GB load1=${os.loadavg()[0].toFixed(2)}`;
      console.log(resourceLine);
      appendTelemetry(resourceLine);
    } catch {}
  };
  logResources();
  const resourceTimer = setInterval(logResources, 60_000);
  if (typeof resourceTimer.unref === "function") resourceTimer.unref();

  // Warm the Vault yield-APY cache from the DB last-good rows BEFORE we accept
  // traffic, so the very first vault read returns real numbers instead of the
  // estimate. DB-only + fail-soft, and bounded by a short timeout so a stalled
  // read can never strand boot. The first read still triggers a live refresh.
  try {
    const { warmYieldTableFromCache } = await import("./vault/yield-oracle");
    await Promise.race([
      warmYieldTableFromCache(),
      new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
    ]);
  } catch (err) {
    console.error("[YieldOracle] cache warm failed:", err);
  }

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
        log('[Staggered startup] Starting subaccount lease-recovery job');
        startSubaccountLeaseRecoveryJob();
      }, 30_000);

      // ~45s+: snapshot / retry jobs. 2026-07-19 incident: these used to be
      // compressed into a 45-87s window; on a slow-Neon-handshake boot they all
      // collided, the pool hit total=8 idle=0 waiting=19 for 64s+, and every
      // job PLUS all dashboard API reads failed on acquire timeouts. Two-layer
      // fix: (1) the window is now spread across ~45s-5min, heaviest jobs last;
      // (2) every deferrable initial run first awaits whenPoolHasHeadroom() —
      // a fixed schedule alone cannot survive a slow-handshake day.
      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting PnL snapshot job');
          startPnlSnapshotJob();
        });
      }, 45_000);

      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting portfolio snapshot job');
          startPortfolioSnapshotJob();
        });
      }, 70_000);

      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting profit share retry job');
          startProfitShareRetryJob();
        });
      }, 120_000);

      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting referral rewards retry job');
          startReferralRewardsRetryJob();
        });
      }, 135_000);

      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting Pacifica referral backfill job');
          startPacificaReferralBackfillJob();
        });
      }, 150_000);

      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting Telegram daily summary job');
          startTelegramDailySummaryJob();
        });
      }, 165_000);

      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting stats consistency monitor');
          import('./stats-consistency-monitor').then(({ startStatsConsistencyMonitor }) => {
            startStatsConsistencyMonitor();
          });
        });
      }, 195_000);

      // ~4min: Task 119 portfolio backfill (one-shot, iterates wallets — the
      // heaviest boot-time DB consumer; used to fire at +45s inside the storm).
      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Running Task 119 portfolio backfill (one-shot)');
          import('./portfolio-snapshot-backfill').then(({ runPortfolioBackfillOnce }) => {
            runPortfolioBackfillOnce().catch(err => console.error('[PortfolioBackfill] error:', err));
          });
        });
      }, 240_000);

      // ~77s: AI Trader monitor (WO-6): startup reconciliation + 15s
      // close-detection tick + graduation sweep. Dynamic import keeps the
      // ai-trader module graph off the boot critical path. Kept early (it
      // reconciles live positions — trading-relevant) but headroom-gated.
      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting AI Trader monitor');
          import('./ai-trader/monitor').then(({ startAiTraderMonitor }) => {
            startAiTraderMonitor();
          }).catch(err => console.error('[AiTraderMonitor] failed to start:', err));
        });
      }, 77_000);

      // Scanner starts slightly later so the monitor is fully initialised first.
      // Shadow mode only — zero trading, zero venue credits. Telemetry is exposed
      // via GET /api/ai-trader/scanner/status (wallet-authed).
      setTimeout(() => {
        log('[Staggered startup] Starting AI Trader scanner (shadow mode)');
        import('./ai-trader/scanner').then(({ startScanner }) => {
          startScanner();
        }).catch(err => console.error('[Scanner] failed to start:', err));
      }, 80_000);

      // Admin error-log retention: prune on startup, then daily. Bounded table
      // (30d age + hard row cap) so the "Errors" tab never balloons. Fail-safe.
      // Delete-heavy — pushed to +5min and headroom-gated (was +77s).
      setTimeout(() => {
        whenPoolHasHeadroom().then(() => {
          log('[Staggered startup] Starting error-log prune job (daily)');
          const runPrune = () => {
            storage.pruneErrors()
              .then(({ deletedByAge, deletedByCap }) => {
                if (deletedByAge || deletedByCap) {
                  log(`[ErrorLogPrune] removed ${deletedByAge} by age + ${deletedByCap} by cap`);
                }
              })
              .catch(err => console.error('[ErrorLogPrune] error:', err));
          };
          runPrune();
          setInterval(runPrune, 24 * 60 * 60 * 1000);
        });
      }, 300_000);

      // Pyth Hermes auth status (one line; warns if unauthenticated past-cutover risk).
      logHermesAuthStatus();

      // ~82s: Live-Data & Monitoring Spine (Phase 0, READ-ONLY shadow mode).
      // Gated by SPINE_ENABLED (default off) — no-op when unset. Uses Pacifica's
      // public prices WS + Pyth Hermes SSE (no Solana RPC), so it is independent
      // of the RPC rate-limit budget; started last as lowest priority.
      setTimeout(() => {
        log('[Staggered startup] Initializing Live-Data Spine (shadow mode)');
        try {
          initLiveDataSpine();
        } catch (err) {
          console.error('[Spine] init failed:', err);
        }
      }, 82_000);

      // ~87s: Oracle Snapshot Recorder (HERMES_EXIT_PLAN Phase 3b, READ-ONLY).
      // Reads on-chain Pyth prices every 5 min via getMultipleAccountsInfo;
      // persists to oracle_price_snapshots table + bounded 26h in-memory ring;
      // shadow-logs [OracleShadow] on-chain vs Hermes for borrow-gate feeds.
      // No gate logic, no money-path changes, no threshold changes.
      // Gated by ORACLE_SNAPSHOT_DISABLED=true (default: enabled).
      setTimeout(() => {
        log('[Staggered startup] Initializing Oracle Snapshot Recorder');
        import('./vault/oracle-snapshot-recorder').then(({ initOracleSnapshotRecorder }) => {
          try {
            initOracleSnapshotRecorder();
          } catch (err) {
            console.error('[OracleSnapshot] init failed:', err);
          }
        }).catch((err) => console.error('[OracleSnapshot] import failed:', err));
      }, 87_000);
    },
  );
})();
