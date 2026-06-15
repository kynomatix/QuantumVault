// Pure, DB-free queue-fairness ordering + jobs-ahead math for the single shared
// QuantumLab worker. This is the SINGLE SOURCE OF TRUTH for the ordering
// semantics so the claim path and the surfaced "N jobs ahead" estimate can never
// disagree:
//   - storage.claimNextQueuedRun mirrors compareQueueClaim() in its SQL ORDER BY.
//   - storage.getJobsAheadCount delegates its counting to countJobsAhead().
//
// FAIRNESS RULE: manual (user-driven) runs ALWAYS claim before agent-owned runs
// on the shared worker. Within the same ownership tier, lower queue_order wins
// (NULLS LAST), then lower id. So a manual run created AFTER an agent run still
// runs first, and the agent never starves a person's own backtest.

export interface QueueClaimRun {
  agentOwned?: boolean | null;
  queueOrder?: number | null;
  id: number;
}

const QUEUE_ORDER_MAX = Number.MAX_SAFE_INTEGER;

// Ownership tier: manual (false/null) = 0 sorts before agent (true) = 1.
function agentTier(r: QueueClaimRun): number {
  return r.agentOwned === true ? 1 : 0;
}

// NULLS LAST for queue_order (an unsequenced queued row sorts after sequenced ones).
function orderKey(r: QueueClaimRun): number {
  return r.queueOrder == null ? QUEUE_ORDER_MAX : r.queueOrder;
}

/**
 * Total order used to claim the next queued run. Mirrors the SQL ORDER BY in
 * storage.claimNextQueuedRun: `(agent_owned IS TRUE) ASC, queue_order ASC NULLS
 * LAST, id ASC`. Negative => `a` sorts before `b` (claimed first).
 */
export function compareQueueClaim(a: QueueClaimRun, b: QueueClaimRun): number {
  const ta = agentTier(a);
  const tb = agentTier(b);
  if (ta !== tb) return ta - tb;
  const oa = orderKey(a);
  const ob = orderKey(b);
  if (oa !== ob) return oa - ob;
  return a.id - b.id;
}

export interface QueueCensusRun extends QueueClaimRun {
  status: string;
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["running", "paused"]);

/**
 * How many runs will be processed before `target` on the single shared worker:
 *   - every ACTIVE (running/paused) run — they occupy/own the worker regardless
 *     of ownership tier; and
 *   - every QUEUED run that sorts strictly before `target` under the claim order.
 *
 * For an AGENT-owned target this therefore counts ALL queued manual runs (they
 * are a lower tier) plus queued agent runs with an earlier slot. For a MANUAL
 * target it counts only manual runs queued ahead — a queued agent run with a
 * lower queue_order does NOT block a person's run. `target` need not appear in
 * `runs`; if it does, it never counts itself.
 */
export function countJobsAhead(target: QueueClaimRun, runs: QueueCensusRun[]): number {
  let count = 0;
  for (const r of runs) {
    if (ACTIVE_STATUSES.has(r.status)) {
      count++;
      continue;
    }
    if (r.status === "queued" && compareQueueClaim(r, target) < 0) count++;
  }
  return count;
}
