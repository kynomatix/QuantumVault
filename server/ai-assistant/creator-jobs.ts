// Async job store for the QuantumLab AI Strategy Creator.
//
// WHY THIS EXISTS: /draft and /improve run a chain of up to ~5 sequential LLM calls
// that can take 1–2 minutes. Holding a single HTTP request open that long gets the
// connection reaped by the Replit dev proxy / prod load balancer — surfacing as
// "stream is not readable", a vanished request, or a reaped server. So the routes
// now start a background job and return 202 immediately; the client polls for the
// result via GET /api/lab/creator/job/:jobId.
//
// MEMORY: the store is strictly bounded — a Map capped at MAX_JOBS with TTL eviction
// of finished jobs, plus a hard stuck-cap that reclaims a job wedged in "running".
// Running jobs are never evicted by the normal TTL (worst-case chain ~7.5 min, each
// LLM call bounded by its own AbortController in router.ts), so a slow-but-live job
// is never pulled out from under a polling client. work() always settles, so there
// is no never-resolving leak path.

import { randomUUID } from "crypto";
import { LlmGatewayError } from "./router";
import type { CreatorDraftResult } from "./creator";

export type CreatorJobKind = "draft" | "improve";
export type CreatorJobStatus = "running" | "done" | "error";

// What the client polls for: the draft/improve result plus the parsed Pine (the
// route computes the parse synchronously inside the job's work closure).
export interface CreatorJobResult extends CreatorDraftResult {
  parse: unknown;
}

interface SanitizedJobError {
  message: string;
  status: number;
}

export interface CreatorJob {
  id: string;
  walletAddress: string;
  kind: CreatorJobKind;
  status: CreatorJobStatus;
  result?: CreatorJobResult;
  error?: SanitizedJobError;
  createdAt: number;
  finishedAt?: number;
}

const MAX_JOBS = 200;
const DONE_TTL_MS = 10 * 60 * 1000; // evict finished (done/error) jobs after 10 min
const STUCK_CAP_MS = 15 * 60 * 1000; // safety net: reclaim a job wedged in "running"

const jobs = new Map<string, CreatorJob>();

// Mirror routes.ts sendError(): never leak raw error text/stack. LlmGatewayError
// messages are already user-safe (rate-limit / upstream wording); everything else
// collapses to the route's fallback string.
function sanitizeJobError(err: unknown, fallback: string): SanitizedJobError {
  if (err instanceof LlmGatewayError) {
    return {
      message: err.message,
      status: err.status && Number.isInteger(err.status) ? err.status : 502,
    };
  }
  return { message: fallback, status: 500 };
}

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of Array.from(jobs.entries())) {
    if (job.status === "running") {
      if (now - job.createdAt > STUCK_CAP_MS) jobs.delete(id);
    } else if (now - (job.finishedAt ?? job.createdAt) > DONE_TTL_MS) {
      jobs.delete(id);
    }
  }
  // If still over the cap, drop the oldest finished jobs (never a running one).
  if (jobs.size > MAX_JOBS) {
    const finished = Array.from(jobs.values())
      .filter((j) => j.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
    for (const j of finished) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(j.id);
    }
  }
}

export function getActiveCreatorJob(walletAddress: string): CreatorJob | undefined {
  for (const job of Array.from(jobs.values())) {
    if (job.walletAddress === walletAddress && job.status === "running") return job;
  }
  return undefined;
}

// Thrown by startCreatorJob when the wallet already has a running job (single-flight).
export class CreatorJobConflictError extends Error {
  constructor(public readonly jobId: string) {
    super("A strategy generation is already running. Let it finish before starting another.");
    this.name = "CreatorJobConflictError";
  }
}

// Start a background job for `walletAddress`. Single-flight per wallet: throws
// CreatorJobConflictError if one is already running. `work` produces the result;
// any rejection is sanitized into job.error using `fallbackMessage`.
export function startCreatorJob(
  walletAddress: string,
  kind: CreatorJobKind,
  fallbackMessage: string,
  work: () => Promise<CreatorJobResult>,
): string {
  sweep();
  const existing = getActiveCreatorJob(walletAddress);
  if (existing) throw new CreatorJobConflictError(existing.id);

  const id = randomUUID();
  jobs.set(id, { id, walletAddress, kind, status: "running", createdAt: Date.now() });

  // Fire-and-forget. We catch everything so this can never raise an unhandled
  // rejection, and work() always settles (every LLM call has its own timeout).
  void (async () => {
    try {
      const result = await work();
      const job = jobs.get(id);
      if (job) {
        job.status = "done";
        job.result = result;
        job.finishedAt = Date.now();
      }
    } catch (err) {
      const job = jobs.get(id);
      if (job) {
        job.status = "error";
        job.error = sanitizeJobError(err, fallbackMessage);
        job.finishedAt = Date.now();
      }
    }
  })();

  return id;
}

export function getCreatorJob(id: string): CreatorJob | undefined {
  return jobs.get(id);
}
