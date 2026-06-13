// Tests for the Phase A reliability spine (T6): the task state machine
// (task-store.ts) and the DB-as-source-of-truth reconciler (reconciler.ts).
//
// These verify the SPINE, not the lab: legal/illegal transitions, the atomic
// one-active-task leash, wallet scoping, owned-run bookkeeping, and the
// reconciler's activeRun resync, CAS-race-safe cancel, idle-ONLY pause TTL, and
// surfacing (never auto-resuming) interrupted runs — all over a fake storage.

import { describe, it, expect } from "vitest";
import { TaskStore, canTransition } from "../../server/lab-agent/task-store";
import { reconcileTask } from "../../server/lab-agent/reconciler";

const WALLET = "wallet-AAA";
const OTHER = "wallet-BBB";
const NOW = new Date("2026-06-13T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fake storage — implements the TaskStore + Reconciler storage seams.
// ---------------------------------------------------------------------------

function makeFake() {
  let taskSeq = 0;
  const tasks = new Map<number, any>();
  const runs = new Map<number, any>();
  // Run ids that should simulate a queued→running race: markAgentRunCancelled
  // flips them to running and returns false (CAS lost).
  const raceOnCancel = new Set<number>();

  const fake = {
    tasks,
    runs,
    raceOnCancel,

    addTask(partial: Record<string, unknown> = {}) {
      const id = ++taskSeq;
      const row = {
        id, walletAddress: WALLET, status: "active", mode: "chat", goal: null,
        plan: null, memory: null, activeRunId: null, ownedRunIds: [], loopCount: 0,
        spendEstimateUsd: 0, stopReason: null, lastReconciledAt: null,
        awaitingSince: null, cancelRequestedAt: null, toolkitVersion: 1,
        createdAt: NOW, updatedAt: NOW, ...partial,
      };
      tasks.set(id, row);
      return row;
    },
    addRun(r: Record<string, unknown> & { id: number; status: string }) {
      const row = { checkpoint: null, userId: WALLET, ...r };
      runs.set(r.id, row);
      return row;
    },

    async createAgentTaskExclusive(data: any) {
      const existing = [...tasks.values()].find(
        (t) => t.walletAddress === data.walletAddress &&
          ["active", "awaiting_input", "paused"].includes(t.status),
      );
      if (existing) return { conflict: existing };
      const id = ++taskSeq;
      const row = {
        id, walletAddress: data.walletAddress, status: "active", mode: "chat",
        goal: null, plan: null, memory: null, activeRunId: null, ownedRunIds: [],
        loopCount: 0, spendEstimateUsd: 0, stopReason: null, lastReconciledAt: null,
        awaitingSince: null, cancelRequestedAt: null, toolkitVersion: 1,
        createdAt: NOW, updatedAt: NOW, ...data,
      };
      tasks.set(id, row);
      return { created: row };
    },
    async getAgentTask(id: number) {
      return tasks.get(id);
    },
    async updateAgentTask(id: number, patch: any) {
      const cur = tasks.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, updatedAt: new Date() };
      tasks.set(id, next);
      return next;
    },
    async getRunsByIds(ids: number[]) {
      return ids.map((i) => runs.get(i)).filter(Boolean);
    },
    async markAgentRunCancelled(id: number) {
      const r = runs.get(id);
      if (!r) return false;
      if (raceOnCancel.has(id)) {
        runs.set(id, { ...r, status: "running" }); // started mid-cancel
        return false;
      }
      if (r.status !== "queued") return false;
      runs.set(id, { ...r, status: "failed", checkpoint: { userCancelled: true } });
      return true;
    },
  };
  return fake;
}

// ===========================================================================
// task-store.ts
// ===========================================================================

describe("canTransition", () => {
  it("allows legal edges and rejects illegal ones", () => {
    expect(canTransition("active", "awaiting_input")).toBe(true);
    expect(canTransition("active", "completed")).toBe(true);
    expect(canTransition("paused", "active")).toBe(true);
    expect(canTransition("paused", "awaiting_input")).toBe(false);
    expect(canTransition("stopped", "active")).toBe(false);
  });

  it("treats re-asserting the same status as a legal no-op (terminal idempotence)", () => {
    expect(canTransition("stopped", "stopped")).toBe(true);
    expect(canTransition("completed", "completed")).toBe(true);
  });
});

describe("TaskStore.create — one-active-task leash", () => {
  it("creates an active chat task with the toolkit version", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const res = await store.create({ walletAddress: WALLET, goal: "tune SOL", toolkitVersion: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.task.status).toBe("active");
      expect(res.task.mode).toBe("chat");
      expect(res.task.goal).toBe("tune SOL");
      expect(res.task.toolkitVersion).toBe(1);
    }
  });

  it("rejects a second non-terminal task for the same wallet", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    await store.create({ walletAddress: WALLET });
    const res = await store.create({ walletAddress: WALLET });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("active_task_exists");
  });

  it("allows a separate task for a different wallet (leash is per-wallet)", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    await store.create({ walletAddress: WALLET });
    const res = await store.create({ walletAddress: OTHER });
    expect(res.ok).toBe(true);
  });

  it("allows a new task once the prior one is terminal", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const first = await store.create({ walletAddress: WALLET });
    if (!first.ok) throw new Error("setup");
    await store.transition(first.task.id, WALLET, "stopped");
    const res = await store.create({ walletAddress: WALLET });
    expect(res.ok).toBe(true);
  });
});

describe("TaskStore.get — wallet scoping", () => {
  it("returns the task for its owner and hides it from others", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET });
    expect(await store.get(t.id, WALLET)).toBeTruthy();
    expect(await store.get(t.id, OTHER)).toBeUndefined();
    expect(await store.get(9999, WALLET)).toBeUndefined();
  });
});

describe("TaskStore.transition", () => {
  it("sets awaitingSince on entry and clears it on exit", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET });
    const a = await store.transition(t.id, WALLET, "awaiting_input");
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.task.awaitingSince).toEqual(NOW);
    const b = await store.transition(t.id, WALLET, "active");
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.task.awaitingSince).toBeNull();
  });

  it("clears activeRunId when entering a terminal status", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET, activeRunId: 77 });
    const res = await store.transition(t.id, WALLET, "completed");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task.activeRunId).toBeNull();
  });

  it("rejects an illegal transition", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET, status: "stopped" });
    const res = await store.transition(t.id, WALLET, "active");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_transition");
  });

  it("is wallet-scoped and reports not_found", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET });
    const forbidden = await store.transition(t.id, OTHER, "paused");
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.reason).toBe("forbidden");
    const missing = await store.transition(9999, WALLET, "paused");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });
});

describe("TaskStore.requestStop", () => {
  it("marks cancelRequestedAt without changing status and is idempotent", async () => {
    const fake = makeFake();
    const t0 = new Date("2026-06-13T10:00:00.000Z");
    const store = new TaskStore(fake as any, () => t0);
    const t = fake.addTask({ walletAddress: WALLET, status: "active" });
    const r1 = await store.requestStop(t.id, WALLET, "user asked");
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.task.status).toBe("active");
      expect(r1.task.cancelRequestedAt).toEqual(t0);
      expect(r1.task.stopReason).toBe("user asked");
    }
    // Second call keeps the original timestamp (a later clock must not reset it).
    (store as any).clock = () => new Date("2026-06-13T11:00:00.000Z");
    const r2 = await store.requestStop(t.id, WALLET);
    if (r2.ok) expect(r2.task.cancelRequestedAt).toEqual(t0);
  });

  it("is a no-op on a terminal task", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET, status: "stopped" });
    const res = await store.requestStop(t.id, WALLET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task.cancelRequestedAt).toBeNull();
  });
});

describe("TaskStore.addOwnedRun", () => {
  it("dedup-appends owned runs and sets the active pointer", async () => {
    const fake = makeFake();
    const store = new TaskStore(fake as any, () => NOW);
    const t = fake.addTask({ walletAddress: WALLET });
    await store.addOwnedRun(t.id, WALLET, 30, { active: true });
    const again = await store.addOwnedRun(t.id, WALLET, 30);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.task.ownedRunIds).toEqual([30]);
      expect(again.task.activeRunId).toBe(30);
    }
    const added = await store.addOwnedRun(t.id, WALLET, 31);
    if (added.ok) expect(added.task.ownedRunIds).toEqual([30, 31]);
  });
});

// ===========================================================================
// reconciler.ts
// ===========================================================================

describe("reconcileTask — activeRun resync", () => {
  it("returns null for a missing task", async () => {
    const fake = makeFake();
    expect(await reconcileTask(fake as any, 9999)).toBeNull();
  });

  it("clears activeRunId when the owned run finished while away", async () => {
    const fake = makeFake();
    fake.addRun({ id: 30, status: "complete" });
    const t = fake.addTask({ status: "active", activeRunId: 30, ownedRunIds: [30] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.activeRunId).toBeNull();
    expect(res!.buckets.completed).toEqual([30]);
    expect(res!.statusChanged).toBe(false);
    expect(fake.tasks.get(t.id).lastReconciledAt).toEqual(NOW);
  });

  it("keeps activeRunId for a still-running owned run", async () => {
    const fake = makeFake();
    fake.addRun({ id: 31, status: "running" });
    const t = fake.addTask({ status: "active", activeRunId: 31, ownedRunIds: [31] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.activeRunId).toBe(31);
    expect(res!.buckets.running).toEqual([31]);
  });

  it("prefers a running run over a queued one for the active pointer", async () => {
    const fake = makeFake();
    fake.addRun({ id: 40, status: "queued" });
    fake.addRun({ id: 41, status: "running" });
    const t = fake.addTask({ status: "active", ownedRunIds: [40, 41] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.activeRunId).toBe(41);
  });

  it("maps a user-cancelled failed run to the cancelled bucket", async () => {
    const fake = makeFake();
    fake.addRun({ id: 36, status: "failed", checkpoint: { userCancelled: true } });
    const t = fake.addTask({ status: "active", ownedRunIds: [36] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.buckets.cancelled).toEqual([36]);
    expect(res!.buckets.failed).toEqual([]);
  });
});

describe("reconcileTask — cancel semantics", () => {
  it("cancels a queued owned run and cleanly stops the task", async () => {
    const fake = makeFake();
    fake.addRun({ id: 32, status: "queued" });
    const t = fake.addTask({ status: "active", cancelRequestedAt: NOW, ownedRunIds: [32] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.cancelledQueuedRunIds).toEqual([32]);
    expect(res!.status).toBe("stopped");
    expect(res!.activeRunId).toBeNull();
    expect(res!.pendingStop).toBe(false);
    expect(fake.tasks.get(t.id).stopReason).toBe("user_cancelled");
  });

  it("never kills a running owned run — leaves the task pending-stop", async () => {
    const fake = makeFake();
    fake.addRun({ id: 33, status: "running" });
    const t = fake.addTask({ status: "active", cancelRequestedAt: NOW, ownedRunIds: [33] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.pendingStop).toBe(true);
    expect(res!.status).toBe("active");
    expect(res!.activeRunId).toBe(33);
    expect(res!.cancelledQueuedRunIds).toEqual([]);
  });

  it("treats a queued run that raced to running during the CAS as live (pending-stop)", async () => {
    const fake = makeFake();
    fake.addRun({ id: 34, status: "queued" });
    fake.raceOnCancel.add(34); // markAgentRunCancelled will flip it to running, return false
    const t = fake.addTask({ status: "active", cancelRequestedAt: NOW, ownedRunIds: [34] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.cancelledQueuedRunIds).toEqual([]);
    expect(res!.pendingStop).toBe(true);
    expect(res!.status).toBe("active");
    expect(res!.activeRunId).toBe(34);
  });
});

describe("reconcileTask — idle-only pause TTL", () => {
  it("stops an awaiting_input task that idled past the TTL with no live run", async () => {
    const fake = makeFake();
    const t = fake.addTask({
      status: "awaiting_input",
      awaitingSince: new Date(NOW.getTime() - 25 * HOUR),
      ownedRunIds: [],
    });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.status).toBe("stopped");
    expect(fake.tasks.get(t.id).stopReason).toBe("idle_timeout");
  });

  it("never evicts an awaiting_input task while a run is still live", async () => {
    const fake = makeFake();
    fake.addRun({ id: 50, status: "running" });
    const t = fake.addTask({
      status: "awaiting_input",
      awaitingSince: new Date(NOW.getTime() - 25 * HOUR),
      ownedRunIds: [50],
    });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.status).toBe("awaiting_input");
    expect(res!.activeRunId).toBe(50);
  });

  it("leaves a freshly-idle awaiting_input task alone", async () => {
    const fake = makeFake();
    const t = fake.addTask({
      status: "awaiting_input",
      awaitingSince: new Date(NOW.getTime() - 1 * HOUR),
      ownedRunIds: [],
    });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.status).toBe("awaiting_input");
  });
});

describe("reconcileTask — interrupted runs", () => {
  it("surfaces paused owned runs without auto-resuming or counting them live", async () => {
    const fake = makeFake();
    fake.addRun({ id: 35, status: "paused" });
    const t = fake.addTask({ status: "active", activeRunId: 35, ownedRunIds: [35] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.interruptedRunIds).toEqual([35]);
    expect(res!.buckets.paused).toEqual([35]);
    expect(res!.activeRunId).toBeNull(); // paused is NOT live
    // Untouched: still paused (no auto-resume).
    expect(fake.runs.get(35).status).toBe("paused");
  });
});

describe("reconcileTask — terminal task", () => {
  it("only stamps lastReconciledAt and still surfaces paused runs", async () => {
    const fake = makeFake();
    fake.addRun({ id: 60, status: "paused" });
    const t = fake.addTask({ status: "stopped", ownedRunIds: [60] });
    const res = await reconcileTask(fake as any, t.id, { now: NOW });
    expect(res!.statusChanged).toBe(false);
    expect(res!.status).toBe("stopped");
    expect(res!.activeRunId).toBeNull();
    expect(res!.interruptedRunIds).toEqual([60]);
    expect(fake.tasks.get(t.id).lastReconciledAt).toEqual(NOW);
  });
});
