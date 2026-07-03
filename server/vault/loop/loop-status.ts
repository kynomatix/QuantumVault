/**
 * SOL Loop Vault P3 (T106): observation-gate instrumentation — pure helpers
 * for the admin status route (/api/admin/loop/status).
 *
 * The P3 gate is "a full week of unattended correct management on test funds,
 * incl. at least one forced deleverage" (plan §5). This module turns the
 * persisted telemetry (tick heartbeats + decision journal) into the gate
 * check: expected-vs-actual tick coverage, max coverage gap, and whether a
 * deleverage with a reason has been observed. Pure functions — the route does
 * the fetching; everything here is deterministic and unit-tested.
 *
 * Telemetry only: nothing in this module is ever a money gate.
 */

import type { LoopPolicyDecision } from "@shared/schema";

// ---------------------------------------------------------------------------
// Tick coverage
// ---------------------------------------------------------------------------

export interface TickCoverage {
  /** Heartbeats observed inside the window. */
  count: number;
  /** Heartbeats a perfectly-scheduled tick would have produced. */
  expected: number;
  /** min(100, count/expected × 100), rounded to 1 decimal. 100 when expected=0. */
  coveragePct: number;
  /** Largest silence in ms: between adjacent beats, window-start→first beat, last beat→now. */
  maxGapMs: number;
  /** Most recent heartbeat, null when the window is empty. */
  lastBeatAt: Date | null;
  /** Gate verdict: maxGapMs ≤ allowedGapMs AND at least one beat in the window. */
  ok: boolean;
}

/**
 * Compute coverage for one tick cadence from ASCENDING heartbeat timestamps.
 *
 * The leading gap is measured from window start, so a dead scheduler shows a
 * full-window gap instead of vacuously passing on an empty list. Restart
 * blips are tolerated via allowedGapMs (callers pass a multiple of the
 * interval, e.g. 5× — a deploy restart pauses ticks for ~2 min).
 */
export function computeTickCoverage(opts: {
  beatsAsc: Date[];
  intervalMs: number;
  windowMs: number;
  allowedGapMs: number;
  now: Date;
}): TickCoverage {
  const { beatsAsc, intervalMs, windowMs, allowedGapMs, now } = opts;
  const windowStart = now.getTime() - windowMs;
  const times = beatsAsc.map((d) => d.getTime()).filter((t) => t >= windowStart && t <= now.getTime());

  const expected = intervalMs > 0 ? Math.floor(windowMs / intervalMs) : 0;
  const count = times.length;

  let maxGapMs: number;
  if (count === 0) {
    maxGapMs = windowMs;
  } else {
    maxGapMs = times[0] - windowStart; // leading silence
    for (let i = 1; i < count; i++) {
      const gap = times[i] - times[i - 1];
      if (gap > maxGapMs) maxGapMs = gap;
    }
    const trailing = now.getTime() - times[count - 1];
    if (trailing > maxGapMs) maxGapMs = trailing;
  }

  const coveragePct = expected <= 0
    ? 100
    : Math.round(Math.min(100, (count / expected) * 100) * 10) / 10;

  return {
    count,
    expected,
    coveragePct,
    maxGapMs,
    lastBeatAt: count > 0 ? new Date(times[count - 1]) : null,
    ok: count > 0 && maxGapMs <= allowedGapMs,
  };
}

// ---------------------------------------------------------------------------
// Decision-journal gate checks
// ---------------------------------------------------------------------------

export interface DecisionGateSummary {
  /** Decisions in the window, by action. */
  byAction: Record<string, number>;
  /** Decisions that EXECUTED (details.executed === true). */
  executedCount: number;
  /**
   * Executed MONEY decisions missing an audit anchor (no signature and no
   * operationId in details). Self-heals (executor found the position already
   * flat/cleared on-chain and stamped state "without a transaction" — that
   * phrase in verifyWarning is the marker) are excluded. Must be 0 for the gate.
   */
  executedMissingAnchor: number;
  /** ≥1 executed deleverage (reduce | unwind_to_hold) with a non-empty reason. */
  forcedDeleverageSeen: boolean;
  /** Newest decision in the window, null when empty. */
  lastDecisionAt: Date | null;
}

const MONEY_ACTIONS = new Set(["reduce", "unwind_to_hold", "relever", "close"]);

export function summarizeDecisionsForGate(decisions: LoopPolicyDecision[]): DecisionGateSummary {
  const byAction: Record<string, number> = {};
  let executedCount = 0;
  let executedMissingAnchor = 0;
  let forcedDeleverageSeen = false;
  let lastDecisionAt: Date | null = null;

  for (const d of decisions) {
    byAction[d.action] = (byAction[d.action] ?? 0) + 1;
    if (!lastDecisionAt || d.createdAt > lastDecisionAt) lastDecisionAt = d.createdAt;

    const details = (d.details ?? {}) as Record<string, unknown>;
    if (details.executed !== true) continue;
    executedCount++;

    if (MONEY_ACTIONS.has(d.action)) {
      const hasAnchor = typeof details.signature === "string" || typeof details.operationId === "string";
      // Structured flag (executor result → journal) is primary; the prose
      // match is a fallback for rows journaled before the flag existed.
      const selfHealNoTx = details.selfHeal === true
        || (typeof details.verifyWarning === "string"
          && details.verifyWarning.includes("without a transaction"));
      if (!hasAnchor && !selfHealNoTx) executedMissingAnchor++;
    }

    if ((d.action === "reduce" || d.action === "unwind_to_hold") && d.reason.trim().length > 0) {
      forcedDeleverageSeen = true;
    }
  }

  return { byAction, executedCount, executedMissingAnchor, forcedDeleverageSeen, lastDecisionAt };
}
