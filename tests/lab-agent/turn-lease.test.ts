// Phase C turn-lease CAS acceptance test (T1).
//
// Exercises the real Postgres-backed claimTurnLease/releaseTurnLease against a
// throwaway lab_agent_tasks row: the single-flight winner gets the row, a
// concurrent loser gets undefined, release is CAS-on-token (a wrong token
// no-ops), and an expired lease can be reclaimed by a new holder. Skipped when
// DATABASE_URL is absent so the suite still runs in a DB-less environment.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;
const WALLET = "lease-test-" + Math.random().toString(36).slice(2);

describe.skipIf(!HAS_DB)("turn-lease CAS (claimTurnLease / releaseTurnLease)", () => {
  let taskId = 0;
  let labStorage: typeof import("../../server/lab/storage")["labStorage"];
  let db: typeof import("../../server/db")["db"];
  let labAgentTasks: typeof import("@shared/schema")["labAgentTasks"];

  beforeAll(async () => {
    ({ labStorage } = await import("../../server/lab/storage"));
    ({ db } = await import("../../server/db"));
    ({ labAgentTasks } = await import("@shared/schema"));
    const [row] = await db
      .insert(labAgentTasks)
      .values({ walletAddress: WALLET, status: "active", mode: "chat" })
      .returning();
    taskId = row.id;
  });

  afterAll(async () => {
    if (taskId) await db.delete(labAgentTasks).where(eq(labAgentTasks.id, taskId));
  });

  it("winner gets the row, a concurrent loser gets undefined", async () => {
    const now = new Date();
    const win = await labStorage.claimTurnLease(taskId, "token-A", 60_000, now);
    expect(win).toBeDefined();
    expect(win!.turnLease).toBe("token-A");

    const lose = await labStorage.claimTurnLease(taskId, "token-B", 60_000, now);
    expect(lose).toBeUndefined();
  });

  it("release is CAS-on-token: wrong token no-ops, correct token frees", async () => {
    // Wrong token must NOT free the lease still held by token-A.
    await labStorage.releaseTurnLease(taskId, "token-WRONG");
    const stillHeld = await labStorage.claimTurnLease(taskId, "token-C", 60_000, new Date());
    expect(stillHeld).toBeUndefined();

    // Correct token frees it; the next claim then wins.
    await labStorage.releaseTurnLease(taskId, "token-A");
    const reclaimed = await labStorage.claimTurnLease(taskId, "token-C", 60_000, new Date());
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.turnLease).toBe("token-C");

    await labStorage.releaseTurnLease(taskId, "token-C");
  });

  it("an expired lease can be reclaimed by a new holder", async () => {
    // Claim "in the past" with a short lease so it is already expired.
    const past = new Date(Date.now() - 10 * 60_000);
    const first = await labStorage.claimTurnLease(taskId, "token-OLD", 1_000, past);
    expect(first).toBeDefined();
    expect(first!.turnLease).toBe("token-OLD");

    // A fresh claim at real now() sees the expired lease and takes it over.
    const second = await labStorage.claimTurnLease(taskId, "token-NEW", 60_000, new Date());
    expect(second).toBeDefined();
    expect(second!.turnLease).toBe("token-NEW");

    await labStorage.releaseTurnLease(taskId, "token-NEW");
  });
});
