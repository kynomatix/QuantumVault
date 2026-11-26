// Personal API tokens for QuantumLab, resolved in the MAIN process (LAB-01 fix).
//
// The Lab runs in a child process behind a proxy that always authenticates with the
// shared LAB_AUTH_SECRET, so the child's own Bearer branch is unreachable. This gate
// restores token access at the proxy, with least privilege:
//   - a session wallet always wins; tokens are consulted only when there is no session;
//   - only an allowlist of read and additive Lab routes accepts a token. Deletes, queue
//     edits, cache clears, cancels and debug routes still need an interactive sign-in;
//   - GET routes need the lab:read scope and POST routes need lab:write;
//   - new optimisation runs are capped per token per rolling 24 hours.
// The resolved wallet is handed to the proxy, which sends it as x-lab-wallet exactly as
// it does for a session wallet.

import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type LabTokenScope = "lab:read" | "lab:write";

interface TokenRoute {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly scope: LabTokenScope;
}

export const LAB_TOKEN_ROUTES: readonly TokenRoute[] = Object.freeze([
  { method: "GET", pattern: /^\/api\/lab\/(?:tickers|timeframes)$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/strategies$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/strategies\/\d{1,9}$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/strategies\/\d{1,9}\/(?:top-results|insights-reports)$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/runs$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/runs\/\d{1,9}$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/runs\/\d{1,9}\/results$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/results\/\d{1,9}$/, scope: "lab:read" },
  { method: "GET", pattern: /^\/api\/lab\/queue$/, scope: "lab:read" },
  { method: "POST", pattern: /^\/api\/lab\/parse-pine$/, scope: "lab:write" },
  { method: "POST", pattern: /^\/api\/lab\/strategies$/, scope: "lab:write" },
  { method: "POST", pattern: /^\/api\/lab\/run-optimization$/, scope: "lab:write" },
]);

const RUN_PATH = /^\/api\/lab\/run-optimization$/;
export const LAB_TOKEN_RUNS_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCOPES: readonly LabTokenScope[] = ["lab:read", "lab:write"];

export interface LabTokenRow {
  readonly id: number;
  readonly walletAddress: string;
  readonly scopes: unknown;
}

export type LabTokenLookup = (tokenHash: string) => Promise<LabTokenRow | undefined>;

export function matchLabTokenRoute(method: string, originalUrl: string): TokenRoute | undefined {
  const path = originalUrl.split("?")[0];
  return LAB_TOKEN_ROUTES.find((route) => route.method === method && route.pattern.test(path));
}

export function createLabApiTokenGate(lookup: LabTokenLookup, now: () => number = Date.now) {
  const runLog = new Map<number, number[]>();

  return async function labApiTokenGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const anyReq = req as any;
    if (anyReq.session?.walletAddress) return next();

    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return next();
    const token = header.slice(7).trim();
    if (!token) return next();

    const route = matchLabTokenRoute(req.method, req.originalUrl);
    if (!route) {
      res.status(403).json({ error: "This QuantumLab action needs an interactive sign-in" });
      return;
    }

    let row: LabTokenRow | undefined;
    try {
      row = await lookup(createHash("sha256").update(token).digest("hex"));
    } catch {
      res.status(500).json({ error: "Auth lookup failed" });
      return;
    }
    if (!row || typeof row.walletAddress !== "string" || !row.walletAddress) {
      res.status(401).json({ error: "Invalid API token" });
      return;
    }

    const scopes = Array.isArray(row.scopes) ? row.scopes : DEFAULT_SCOPES;
    if (!scopes.includes(route.scope)) {
      res.status(403).json({ error: `API token lacks the ${route.scope} scope` });
      return;
    }

    if (RUN_PATH.test(req.originalUrl.split("?")[0])) {
      const t = now();
      const recent = (runLog.get(row.id) ?? []).filter((at) => t - at < DAY_MS);
      if (recent.length >= LAB_TOKEN_RUNS_PER_DAY) {
        runLog.set(row.id, recent);
        res.status(429).json({ error: `API token run limit reached (${LAB_TOKEN_RUNS_PER_DAY} per 24 hours)` });
        return;
      }
      recent.push(t);
      runLog.set(row.id, recent);
    }

    anyReq.labTokenWallet = row.walletAddress;
    anyReq.apiTokenId = row.id;
    next();
  };
}
