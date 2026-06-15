// Phase 1 (Task #200) — fairness + queue-position math for the single shared
// lab worker. These exercise the PURE ordering module that storage.ts mirrors in
// SQL (claim ORDER BY) and delegates to (jobs-ahead count), so the semantics are
// locked without needing a database.

import { describe, it, expect } from "vitest";
import {
  compareQueueClaim,
  countJobsAhead,
  type QueueCensusRun,
  type QueueClaimRun,
} from "../../server/lab/queue-order";

describe("queue-order: compareQueueClaim (claim fairness)", () => {
  it("claims a MANUAL run before an AGENT run even when the manual run was created later", () => {
    // The agent enqueued first (lower queue_order); the person enqueued after
    // (higher queue_order). The person must still go first.
    const agent: QueueClaimRun = { agentOwned: true, queueOrder: 5, id: 1 };
    const manual: QueueClaimRun = { agentOwned: false, queueOrder: 6, id: 2 };
    const queue = [agent, manual].sort(compareQueueClaim);
    expect(queue[0]).toBe(manual);
    expect(compareQueueClaim(manual, agent)).toBeLessThan(0);
  });

  it("orders within a tier by queue_order (NULLS LAST) then id", () => {
    const a: QueueClaimRun = { agentOwned: false, queueOrder: 1, id: 10 };
    const b: QueueClaimRun = { agentOwned: false, queueOrder: 2, id: 9 };
    const c: QueueClaimRun = { agentOwned: false, queueOrder: null, id: 3 }; // null sorts last
    const sorted = [c, b, a].sort(compareQueueClaim);
    expect(sorted.map((r) => r.id)).toEqual([10, 9, 3]);
  });

  it("treats null/undefined agentOwned as manual (sorts before agent)", () => {
    const manualish: QueueClaimRun = { agentOwned: null, queueOrder: 9, id: 4 };
    const agent: QueueClaimRun = { agentOwned: true, queueOrder: 1, id: 5 };
    expect(compareQueueClaim(manualish, agent)).toBeLessThan(0);
  });
});

describe("queue-order: countJobsAhead (queue-position math)", () => {
  const census: QueueCensusRun[] = [
    { id: 1, status: "running", agentOwned: false, queueOrder: null }, // occupies the worker
    { id: 2, status: "queued", agentOwned: false, queueOrder: 6 }, // manual queued
    { id: 3, status: "queued", agentOwned: false, queueOrder: 7 }, // manual queued
    { id: 4, status: "queued", agentOwned: true, queueOrder: 5 }, // agent queued (earlier slot)
    { id: 5, status: "queued", agentOwned: true, queueOrder: 8 }, // agent queued (later slot)
  ];

  it("counts every manual queued run ahead of an AGENT run, plus the active run", () => {
    const agentTarget: QueueClaimRun = { agentOwned: true, queueOrder: 5, id: 4 };
    // ahead: running #1 + manual #2 + manual #3 = 3. Agent #5 is behind; the
    // target (#4) never counts itself.
    expect(countJobsAhead(agentTarget, census)).toBe(3);
  });

  it("does NOT count behind-tier agent runs ahead of a MANUAL run", () => {
    const manualTarget: QueueClaimRun = { agentOwned: false, queueOrder: 7, id: 3 };
    // ahead: running #1 + manual #2 (order 6 < 7) = 2. Agent #4 has a LOWER
    // queue_order but a higher tier, so it does NOT block the person's run.
    expect(countJobsAhead(manualTarget, census)).toBe(2);
  });

  it("a brand-new agent run at the tail sits behind everything queued/active", () => {
    const tail: QueueClaimRun = {
      agentOwned: true,
      queueOrder: Number.MAX_SAFE_INTEGER,
      id: Number.MAX_SAFE_INTEGER,
    };
    expect(countJobsAhead(tail, census)).toBe(5); // 1 running + 4 queued
  });
});
