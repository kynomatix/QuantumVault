// Core-route request tracing + server self-stats (2026-07-20 stuck-dashboard
// incident). During the recurrence there was NO way to tell, from production
// evidence, whether the browser stopped sending dashboard requests, sent them
// and they hung, or they answered with the wrong data. This module closes the
// server half of that gap:
//
//  - [ReqTrace] one line per traced request into the telemetry log: request
//    id, method, path, status (or ABORTED when the client went away before
//    the response finished), duration, hashed wallet, boot id. Slow requests
//    (>= SLOW_MS) and 5xx also mirror to console.
//  - [SelfStats] one line per minute: event-loop lag, open TCP connections,
//    active libuv handles, RSS, in-flight traced requests. Correlated with
//    ReqTrace this discriminates "server went deaf" (lag/handles/conns climb,
//    requests hang or vanish) from "client went silent" (server idle and
//    healthy, zero incoming traced requests).
//
// Bounded by design: traced routes are the low-QPS dashboard set, with a
// per-minute line cap (drops counted, never silently). Wallet identity is a
// sha256 prefix — never the full address, never cookies/tokens/bodies.

import type { Express } from "express";
import type { Server } from "http";
import crypto from "crypto";
import { monitorEventLoopDelay } from "perf_hooks";
import { appendTelemetry } from "./telemetry";
import { SERVER_BOOT_ID } from "./boot-id";

const TRACED_EXACT = new Set([
  "/api/positions",
  "/api/trading-bots",
  "/api/total-equity",
  "/api/auth/status",
  "/api/auth/session",
  "/api/client-telemetry",
]);
const TRACED_PREFIXES = ["/api/ai-trader"];

const MAX_LINES_PER_MIN = 240;
const SLOW_MS = 3_000;

let inFlight = 0;
let tracedThisMin = 0;
let droppedThisMin = 0;
let minuteStart = Date.now();

export function isTracedPath(path: string): boolean {
  if (TRACED_EXACT.has(path)) return true;
  return TRACED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

function hashWallet(w: unknown): string {
  if (typeof w !== "string" || w.length === 0) return "-";
  return crypto.createHash("sha256").update(w).digest("hex").slice(0, 8);
}

function rollMinuteWindow(now: number): void {
  if (now - minuteStart < 60_000) return;
  if (droppedThisMin > 0) {
    appendTelemetry(`[ReqTrace] rate-cap dropped=${droppedThisMin} lines last minute`);
  }
  minuteStart = now;
  tracedThisMin = 0;
  droppedThisMin = 0;
}

/** In-flight traced-request count (exposed for the self-stats line). */
export function getInFlightTracedCount(): number {
  return inFlight;
}

export function registerRequestTrace(app: Express): void {
  app.use((req, res, next) => {
    if (!isTracedPath(req.path)) return next();

    const start = Date.now();
    const reqId = crypto.randomBytes(4).toString("hex");
    inFlight++;
    let settled = false;

    const settle = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
      const now = Date.now();
      const durationMs = now - start;
      rollMinuteWindow(now);
      if (tracedThisMin >= MAX_LINES_PER_MIN) {
        droppedThisMin++;
        return;
      }
      tracedThisMin++;
      const wallet = hashWallet(
        (req.query.wallet as string | undefined) ||
          (req.headers["x-wallet-address"] as string | undefined) ||
          (req as { session?: { walletAddress?: string } }).session?.walletAddress,
      );
      const status = aborted ? "ABORTED" : String(res.statusCode);
      const slow = durationMs >= SLOW_MS ? " SLOW" : "";
      const line = `[ReqTrace] ${reqId} ${req.method} ${req.path} ${status} ${durationMs}ms w=${wallet} boot=${SERVER_BOOT_ID.slice(0, 8)}${slow}`;
      appendTelemetry(line);
      if (aborted || durationMs >= SLOW_MS || res.statusCode >= 500) {
        console.log(line);
      }
    };

    res.on("finish", () => settle(false));
    // 'close' after 'finish' is a no-op (settled guard); 'close' BEFORE
    // 'finish' means the client went away mid-response — the exact signature
    // of a hung/abandoned dashboard read we need to see.
    res.on("close", () => settle(!res.writableFinished));
    next();
  });
}

/**
 * Once-a-minute server vitals into telemetry + console. unref'd — must never
 * hold the process alive (zombie-shutdown gotcha).
 */
export function startSelfStats(httpServer: Server): void {
  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
  const timer = setInterval(() => {
    try {
      httpServer.getConnections((err, conns) => {
        let handles = -1;
        try {
          const getActiveHandles = (
            process as unknown as { _getActiveHandles?: () => unknown[] }
          )._getActiveHandles;
          if (typeof getActiveHandles === "function") {
            handles = getActiveHandles.call(process).length;
          }
        } catch {
          // private API — best-effort only
        }
        const p50 = Math.round(eld.percentile(50) / 1e6);
        const max = Math.round(eld.max / 1e6);
        eld.reset();
        const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
        const line = `[SelfStats] elp50=${p50}ms elmax=${max}ms conns=${err ? -1 : conns} handles=${handles} rss=${rssMb}MB inflight=${inFlight} boot=${SERVER_BOOT_ID.slice(0, 8)}`;
        console.log(line);
        appendTelemetry(line);
      });
    } catch {
      // vitals must never affect the app
    }
  }, 60_000);
  timer.unref();
}

/** Test-only: reset the per-minute counters. */
export function __resetRequestTraceForTests(): void {
  inFlight = 0;
  tracedThisMin = 0;
  droppedThisMin = 0;
  minuteStart = Date.now();
}
