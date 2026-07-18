/**
 * Read-only log access API (Task: external LLM / cronjob log visibility).
 *
 * Purpose: let the owner hand a single READ-ONLY token to external reviewers
 * (Gemini CLI, OpenRouter models) and cronjobs so they can see production
 * logs directly instead of relying on copy/pasted excerpts.
 *
 * Security contract:
 *  - Auth: `Authorization: Bearer <LOG_READ_TOKEN>` — a DEDICATED secret,
 *    deliberately NOT ADMIN_PASSWORD. If this token leaks, the blast radius
 *    is "can read logs", never "can act". Rotate by changing the secret.
 *  - Fail closed: 503 when LOG_READ_TOKEN is unset.
 *  - Constant-time compare (sha256 + timingSafeEqual — no length leak).
 *  - GET-only routes with zero side effects. No DB writes anywhere.
 *  - Best-effort redaction pass over every text payload (secret-looking
 *    key=value pairs, bearer tokens, long api-key shapes). The underlying
 *    sources are already policy-scrubbed (error_log context is "NEVER
 *    secrets"; fingerprint normalization strips volatile ids) — this is a
 *    second net, not the primary defense.
 *  - Bounded output: row limits capped at 500, telemetry tail capped at
 *    2000 lines / ~1 MB per response.
 *  - Simple in-memory rate limit (per-process): 120 requests / 5 min.
 *
 * Endpoints (all under /api/logs, all GET):
 *  - /api/logs/summary    — cron-friendly health digest (JSON)
 *  - /api/logs/errors     — error_log rows (JSON or ?format=text)
 *  - /api/logs/telemetry  — tail of logs/telemetry.log(+.1) (plain text)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";

const TELEMETRY_FILE = path.join("logs", "telemetry.log");
const TELEMETRY_ROTATED = path.join("logs", "telemetry.log.1");

const MAX_TELEMETRY_LINES = 2000;
const DEFAULT_TELEMETRY_LINES = 300;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB hard cap on telemetry payloads
const MAX_ERROR_ROWS = 500;
const MAX_WINDOW_HOURS = 24 * 30; // 30 days

// ---------------------------------------------------------------------------
// Redaction (best-effort second net — sources are already policy-scrubbed)
// ---------------------------------------------------------------------------

// Order matters: bearer tokens first (so "Authorization: Bearer <jwt>" is
// scrubbed before the generic key=value pass could consume the word "Bearer"
// as the value), then multi-word phrase keys, then generic key=value pairs.
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*/gi;
// Mnemonics / seed phrases are multiple space-separated words — redact the
// whole tail of the segment, not just the first token.
const PHRASE_KEY_RE = /\b(mnemonic|seed[_-]?phrase)\b(["']?\s*[:=]\s*)([^"'\n,;]{4,})/gi;
// Generic secret-looking key=value / key: value pairs (single-token values).
const KEY_VALUE_RE =
  /\b(api[_-]?key|apikey|secret|password|passwd|token|auth(?:orization)?|private[_-]?key|session[_-]?id|cookie)\b(["']?\s*[:=]\s*)(["']?)[^\s"'&,;]{6,}/gi;
// Common API-key shapes (OpenAI/OpenRouter/Stripe-style prefixes).
const KEY_SHAPE_RE = /\b(sk|rk|pk|sk-or|or)-[A-Za-z0-9\-_]{16,}\b/g;

export function redactSensitive(text: string): string {
  let out = text;
  out = out.replace(BEARER_RE, (_m, prefix) => `${prefix}[REDACTED]`);
  out = out.replace(PHRASE_KEY_RE, (_m, key, sep) => `${key}${sep}[REDACTED]`);
  out = out.replace(KEY_VALUE_RE, (_m, key, sep, quote) => `${key}${sep}${quote}[REDACTED]`);
  out = out.replace(KEY_SHAPE_RE, "[REDACTED-KEY]");
  return out;
}

// ---------------------------------------------------------------------------
// Auth + rate limit
// ---------------------------------------------------------------------------

function tokenMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_REQUESTS = 120;
let rateWindowStart = 0;
let rateCount = 0;

function rateLimited(): boolean {
  const now = Date.now();
  if (now - rateWindowStart > RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateCount = 0;
  }
  rateCount++;
  return rateCount > RATE_MAX_REQUESTS;
}

function requireLogReadAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.LOG_READ_TOKEN;
  if (!expected || expected.length < 16) {
    // Fail closed; also reject trivially short tokens as misconfiguration.
    return res.status(503).json({ error: "Log access disabled - LOG_READ_TOKEN not configured (min 16 chars)" });
  }
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!provided || !tokenMatches(provided, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (rateLimited()) {
    return res.status(429).json({ error: "Rate limit exceeded (120 requests / 5 min)" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHours(raw: unknown, fallback: number): number {
  const n = parseFloat(String(raw ?? ""));
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_WINDOW_HOURS);
}

function readTelemetryTail(lines: number, grep?: string): string {
  let raw = "";
  for (const file of [TELEMETRY_ROTATED, TELEMETRY_FILE]) {
    try {
      raw += fs.readFileSync(file, "utf8");
    } catch {
      // Missing file is normal (fresh boot / not yet rotated).
    }
  }
  let all = raw.split("\n").filter((l) => l.length > 0);
  if (grep) {
    const needle = grep.toLowerCase();
    all = all.filter((l) => l.toLowerCase().includes(needle));
  }
  const tail = all.slice(-lines);
  let text = tail.join("\n");
  if (text.length > MAX_RESPONSE_BYTES) {
    text = text.slice(text.length - MAX_RESPONSE_BYTES);
    const firstNewline = text.indexOf("\n");
    if (firstNewline > 0) text = text.slice(firstNewline + 1);
    text = "[...truncated to 1 MB...]\n" + text;
  }
  return text;
}

function errorRowToText(e: {
  lastSeen: Date | string;
  severity: string;
  category: string;
  count: number;
  resolved: boolean;
  source: string | null;
  message: string;
  detail: string | null;
}): string {
  const ts = new Date(e.lastSeen).toISOString();
  const flags = e.resolved ? " [resolved]" : "";
  const src = e.source ? ` src=${e.source}` : "";
  const detail = e.detail ? ` — ${e.detail}` : "";
  return `${ts} [${e.severity}/${e.category}] x${e.count}${flags}${src} ${e.message}${detail}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerLogAccessRoutes(app: Express): void {
  // Cron-friendly digest: counts by category/severity in the window, the most
  // recent unresolved errors, and telemetry liveness. A cronjob can alert on
  // `unresolvedInWindow > 0` or on specific categories.
  app.get("/api/logs/summary", requireLogReadAuth, async (req, res) => {
    try {
      const hours = parseHours(req.query.hours, 24);
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const [stats, recentUnresolved] = await Promise.all([
        storage.getErrorStats(since),
        storage.listErrors({ resolved: false, since, limit: 10 }),
      ]);
      const unresolvedInWindow = stats.reduce((s, r) => s + (r.unresolved ?? 0), 0);

      let telemetry: { present: boolean; bytes: number; lastLineAt: string | null } = {
        present: false,
        bytes: 0,
        lastLineAt: null,
      };
      try {
        const { size } = fs.statSync(TELEMETRY_FILE);
        const tail = readTelemetryTail(1);
        const tsMatch = tail.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
        telemetry = { present: true, bytes: size, lastLineAt: tsMatch ? tsMatch[1] : null };
      } catch {
        // No telemetry file yet.
      }

      res.json({
        serverTime: new Date().toISOString(),
        windowHours: hours,
        uptimeSeconds: Math.round(process.uptime()),
        errorStats: stats,
        unresolvedInWindow,
        recentUnresolved: recentUnresolved.map((e) => ({
          lastSeen: e.lastSeen,
          severity: e.severity,
          category: e.category,
          count: e.count,
          source: e.source,
          message: redactSensitive(e.message),
        })),
        telemetry,
      });
    } catch (error) {
      console.error("[LogAccess] summary failed:", error);
      res.status(500).json({ error: "Failed to build log summary" });
    }
  });

  // error_log rows (deduped, fingerprinted, policy: context never holds secrets).
  // ?hours=24&category=crash&severity=critical&resolved=false&limit=100&format=text
  app.get("/api/logs/errors", requireLogReadAuth, async (req, res) => {
    try {
      const hours = parseHours(req.query.hours, 24);
      const resolvedRaw = req.query.resolved as string | undefined;
      const rows = await storage.listErrors({
        category: (req.query.category as string) || undefined,
        severity: (req.query.severity as string) || undefined,
        resolved: resolvedRaw === undefined || resolvedRaw === "all" ? undefined : resolvedRaw === "true",
        since: new Date(Date.now() - hours * 3600 * 1000),
        limit: Math.min(parseInt(req.query.limit as string) || 100, MAX_ERROR_ROWS),
        offset: parseInt(req.query.offset as string) || 0,
      });

      if ((req.query.format as string) === "text") {
        const text = rows.map((e) => redactSensitive(errorRowToText(e))).join("\n");
        res.type("text/plain").send(text.length ? text + "\n" : "(no errors in window)\n");
        return;
      }

      res.json(
        rows.map((e) => ({
          id: e.id,
          firstSeen: e.firstSeen,
          lastSeen: e.lastSeen,
          severity: e.severity,
          category: e.category,
          source: e.source,
          count: e.count,
          resolved: e.resolved,
          message: redactSensitive(e.message),
          detail: e.detail ? redactSensitive(e.detail) : null,
          context: e.context ? JSON.parse(redactSensitive(JSON.stringify(e.context))) : null,
        })),
      );
    } catch (error) {
      console.error("[LogAccess] errors failed:", error);
      res.status(500).json({ error: "Failed to fetch errors" });
    }
  });

  // Tail of the local telemetry file(s) — the same lines the console emits,
  // surviving deployment-log rollover. Plain text (LLM/CLI friendly).
  // ?lines=300 (max 2000) &grep=substring (case-insensitive)
  app.get("/api/logs/telemetry", requireLogReadAuth, (req, res) => {
    try {
      const lines = Math.min(
        Math.max(parseInt(req.query.lines as string) || DEFAULT_TELEMETRY_LINES, 1),
        MAX_TELEMETRY_LINES,
      );
      const grep = typeof req.query.grep === "string" && req.query.grep.length > 0 ? req.query.grep : undefined;
      const text = redactSensitive(readTelemetryTail(lines, grep));
      res.type("text/plain").send(text.length ? text + "\n" : "(telemetry log empty)\n");
    } catch (error) {
      console.error("[LogAccess] telemetry failed:", error);
      res.status(500).json({ error: "Failed to read telemetry" });
    }
  });

  console.log("[LogAccess] Read-only log routes registered under /api/logs/* (enabled:", Boolean(process.env.LOG_READ_TOKEN), ")");
}
