import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";
import { startPeriodicReconciliation } from "./reconciliation-service";
import { startOrphanedSubaccountCleanup } from "./orphaned-subaccount-cleanup";
import { startPnlSnapshotJob } from "./pnl-snapshot-job";
import { startRetryWorker } from "./trade-retry-service";
import { startProfitShareRetryJob } from "./profit-share-retry-job";
import { startPortfolioSnapshotJob } from "./portfolio-snapshot-job";

const app = express();
const httpServer = createServer(app);

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

app.use(
  express.json({
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
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
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

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      log(`serving on port ${port}`);
      
      // Cleanup orphaned pending trades on startup
      // Note: These are marked as needs_review since we can't verify Drift execution status
      // A future improvement would be to check on-chain fills before marking status
      try {
        const orphanedTrades = await storage.getOrphanedPendingTrades(2);
        if (orphanedTrades.length > 0) {
          log(`Found ${orphanedTrades.length} orphaned pending trades, marking for review`);
          for (const trade of orphanedTrades) {
            await storage.updateBotTrade(trade.id, {
              status: "needs_review",
              errorMessage: "Trade interrupted by server restart - verify on Drift if executed",
            });
            log(`Marked trade ${trade.id} as needs_review (orphaned during restart)`);
          }
        }
      } catch (error) {
        console.error("Error cleaning up orphaned trades:", error);
      }
      
      // Start periodic position reconciliation (syncs DB with on-chain Drift positions)
      startPeriodicReconciliation();
      
      // Start orphaned subaccount cleanup (retries closing subaccounts that failed during bot deletion)
      startOrphanedSubaccountCleanup();
      
      // Start PnL snapshot job for marketplace time-based metrics (7d/30d/90d)
      startPnlSnapshotJob();
      
      // Start trade retry worker for rate-limited trade recovery
      startRetryWorker();
      
      // Start profit share retry job for IOU failover system
      startProfitShareRetryJob();
      
      // Start portfolio snapshot job for daily performance tracking
      startPortfolioSnapshotJob();
    },
  );
})();
