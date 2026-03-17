import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";
import { ensureSchema } from "./db";
import { startPeriodicReconciliation } from "./reconciliation-service";
import { startOrphanedSubaccountCleanup } from "./orphaned-subaccount-cleanup";
import { startPnlSnapshotJob } from "./pnl-snapshot-job";
import { startRetryWorker, queueTradeRetry } from "./trade-retry-service";
import { startProfitShareRetryJob } from "./profit-share-retry-job";
import { initLeverageCache } from "./leverage-cache-service";
import { startPortfolioSnapshotJob } from "./portfolio-snapshot-job";
import { createLabSupervisor, getLabAuthSecret } from "./lab/supervisor";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const httpServer = createServer(app);
const labSupervisor = createLabSupervisor();

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

            if (bot.driftSubaccountId == null) {
              await storage.updateBotTrade(trade.id, {
                status: "failed",
                errorMessage: "Trade interrupted by server restart — bot has no subaccount ID, cannot safely retry",
              });
              log(`Trade ${trade.id} cannot retry — bot ${bot.id} missing driftSubaccountId, marked failed`);
              continue;
            }

            try {
              const retryJobId = await queueTradeRetry({
                botId: trade.tradingBotId,
                walletAddress: trade.walletAddress,
                agentPrivateKeyEncrypted: wallet.agentPrivateKeyEncrypted || "",
                agentPublicKey: bot.agentPublicKey || wallet.agentPublicKey || "",
                market: trade.market,
                side: normalizedSide,
                size: parseFloat(trade.size),
                subAccountId: bot.driftSubaccountId,
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

      // ~20s: leverage cache (single batch RPC call to read perp market accounts)
      setTimeout(() => {
        log('[Staggered startup] Initializing leverage cache');
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
        log('[Staggered startup] Starting portfolio snapshot job');
        startPortfolioSnapshotJob();
        log('[Staggered startup] Starting profit share retry job');
        startProfitShareRetryJob();
      }, 45_000);
    },
  );
})();
