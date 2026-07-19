// Central capture helper for the admin "Errors" panel.
//
// Design goals (anti-flood):
//   1. EXPLICIT critical-only capture — callers decide what's worth recording. This is NOT a
//      console.* firehose. Only crashes/500s, failed-after-retry trades, fund-safety events,
//      failed webhooks for active users, and security/decryption failures should call in here.
//   2. DEDUP via fingerprint — repeats collapse onto one row (count++) at the DB layer.
//   3. IN-MEMORY COALESCING — a tight error loop is batched in memory and flushed on a timer,
//      so we never hammer the DB even when the same error fires hundreds of times a second.
//   4. NOISE DENYLIST — known-benign chatter (residual Drift, RPC failover, recovered 429,
//      "ws error: null") is dropped for the broad auto-capture categories.
//
// Hard rule: this module must NEVER throw and never recurse. Logging failures are swallowed —
// surfacing an error must never break the money path that produced it.

import { createHash } from "crypto";
import { storage, type ErrorLogInput } from "./storage";

export type ErrorCategory =
  | "crash"
  | "server_500"
  | "trade_failed"
  | "fund_safety"
  | "webhook_failed"
  | "security"
  // Market-scanner sweep health: blackouts, materially-partial sweeps, budget
  // overruns, abandoned (hung) dispatches. Deliberately its OWN category so the
  // crash/server_500 NOISE_PATTERNS denylist (which drops anything matching
  // /429|rate.?limit/) can never swallow a real scanner incident whose message
  // happens to mention a rate-limited upstream.
  | "scanner";

export type ErrorSeverity = "critical" | "error";

export interface RecordErrorOptions {
  category: ErrorCategory;
  severity?: ErrorSeverity;
  source?: string;
  message?: string;
  detail?: string;
  context?: Record<string, unknown>;
  /** Convenience: pass a caught error/reason and we extract message + stack. */
  error?: unknown;
  /** Override the computed fingerprint (rarely needed). */
  fingerprint?: string;
}

const MAX_MESSAGE = 500;
const MAX_DETAIL = 4000;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER_KEYS = 200; // safety cap on distinct in-flight fingerprints

// Noise denylist — applied ONLY to the broad auto-capture buckets (crash / server_500).
// Explicit domain categories (trade_failed, fund_safety, webhook_failed, security) bypass this:
// the caller already decided the event is critical, so we never second-guess it.
const NOISE_PATTERNS: RegExp[] = [
  /ws error:\s*null/i,
  /DriftClient has no user/i, // residual Drift chatter
  /drift.*(subscription|subscribe|decode|account update)/i, // residual decode/subscribe noise from the retired Drift adapter (narrow: don't swallow real crashes that merely mention "drift")
  /failover|switching rpc|rpc switch/i, // normal RPC failover
  /\b429\b|rate.?limit/i, // recovered Pacifica rate-limits (real failures are recorded as trade_failed)
  /Connection terminated|connection timeout|too many clients|ECONNREFUSED/i, // DB backpressure → already a 503
];

function truncate(s: string, n: number): string {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Strip volatile bits so near-identical errors collapse onto one fingerprint.
function normalize(msg: string): string {
  return (msg || "")
    .replace(/0x[a-fA-F0-9]{6,}/g, "0x…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…uuid")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, "…b58") // base58 (Solana addrs / sigs)
    .replace(/-?\d[\d,]*\.?\d*/g, "#") // numbers / amounts
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isNoise(haystack: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(haystack));
}

type Pending = { input: ErrorLogInput; pendingCount: number };
const buffer = new Map<string, Pending>();
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

/** Fire-and-forget. Records a critical error for the admin panel. Never throws. */
export function recordCriticalError(opts: RecordErrorOptions): void {
  try {
    let message = opts.message ?? "";
    let detail = opts.detail;
    if (opts.error !== undefined && opts.error !== null) {
      const e = opts.error as any;
      if (!message) message = e?.message ? String(e.message) : String(e);
      if (!detail && e?.stack) detail = String(e.stack);
    }
    if (!message) return;

    // Noise filter applies only to the broad auto-capture buckets.
    const broad = opts.category === "crash" || opts.category === "server_500";
    if (broad && isNoise(`${message}\n${detail ?? ""}`)) return;

    message = truncate(message, MAX_MESSAGE);
    detail = detail ? truncate(detail, MAX_DETAIL) : undefined;

    const fingerprint =
      opts.fingerprint ??
      createHash("sha256")
        .update(`${opts.category}|${opts.source ?? ""}|${normalize(message)}`)
        .digest("hex")
        .slice(0, 32);

    const now = new Date();
    const existing = buffer.get(fingerprint);
    if (existing) {
      existing.pendingCount += 1;
      existing.input.message = message;
      existing.input.detail = detail ?? null;
      if (opts.context) existing.input.context = opts.context;
      if (opts.severity) existing.input.severity = opts.severity;
      existing.input.lastSeen = now;
    } else {
      if (buffer.size >= MAX_BUFFER_KEYS) {
        // A storm of *distinct* fingerprints — flush and, if still saturated, drop this one.
        void flushErrorLog();
        if (buffer.size >= MAX_BUFFER_KEYS) return;
      }
      buffer.set(fingerprint, {
        pendingCount: 1,
        input: {
          fingerprint,
          category: opts.category,
          severity: opts.severity ?? "error",
          source: opts.source ?? null,
          message,
          detail: detail ?? null,
          context: opts.context ?? null,
          lastSeen: now,
        },
      });
    }
    scheduleFlush();
  } catch {
    // Logging must never break the caller.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushErrorLog();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive just for the flush timer.
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

/** Persist all buffered errors. Safe to call manually (e.g. on shutdown). Never throws. */
export async function flushErrorLog(): Promise<void> {
  if (flushing || buffer.size === 0) return;
  flushing = true;
  const batch = Array.from(buffer.values());
  buffer.clear();
  try {
    for (const p of batch) {
      try {
        await storage.recordError({ ...p.input, count: p.pendingCount });
      } catch {
        // Drop on persistent DB failure — never let logging break anything.
      }
    }
  } finally {
    flushing = false;
  }
}
