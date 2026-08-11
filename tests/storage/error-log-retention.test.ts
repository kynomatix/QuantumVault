import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("scanner incident evidence retention (real Postgres)", () => {
  let storage: typeof import("../../server/storage")["storage"];
  let db: typeof import("../../server/db")["db"];
  let ensureSchema: typeof import("../../server/db")["ensureSchema"];
  let errorLog: typeof import("@shared/schema")["errorLog"];
  let scannerIncidentHolds: typeof import("@shared/schema")["scannerIncidentHolds"];
  let scannerIncidentOccurrences: typeof import("@shared/schema")["scannerIncidentOccurrences"];
  const holdId = `scanner-retention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const secondHoldId = `${holdId}-second`;
  const ordinaryFingerprint = `ordinary-${holdId}`;

  beforeAll(async () => {
    ({ storage } = await import("../../server/storage"));
    ({ db, ensureSchema } = await import("../../server/db"));
    ({ errorLog, scannerIncidentHolds, scannerIncidentOccurrences } = await import("@shared/schema"));
    await ensureSchema();
    await db.delete(scannerIncidentOccurrences);
    await db.delete(scannerIncidentHolds);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(scannerIncidentOccurrences).where(eq(scannerIncidentOccurrences.holdId, holdId));
    await db.delete(scannerIncidentOccurrences).where(eq(scannerIncidentOccurrences.holdId, secondHoldId));
    await db.delete(scannerIncidentHolds).where(eq(scannerIncidentHolds.id, holdId));
    await db.delete(scannerIncidentHolds).where(eq(scannerIncidentHolds.id, secondHoldId));
    await db.delete(errorLog).where(eq(errorLog.fingerprint, ordinaryFingerprint));
  });

  it("retains distinct baseline/canary occurrences through ordinary pruning and releases only after matching export", async () => {
    const activated = await storage.activateScannerIncidentHold(holdId);
    expect(activated.outcome).toBe("activated");

    const second = await storage.activateScannerIncidentHold(secondHoldId);
    expect(second).toMatchObject({ outcome: "active_hold_exists", holdId });

    const baseTime = new Date("2026-08-11T00:00:00.000Z");
    const captures = await Promise.all([
      storage.captureScannerIncidentOccurrence({
        eventId: `${holdId}-baseline-a`,
        fingerprint: "identical-fingerprint",
        observedAt: baseTime,
        category: "scanner",
        source: "scanner-sweep",
        summary: "Scanner blackout",
        context: { attempted: 2 },
      }),
      storage.captureScannerIncidentOccurrence({
        eventId: `${holdId}-baseline-b`,
        fingerprint: "identical-fingerprint",
        observedAt: new Date(baseTime.getTime() + 1),
        category: "scanner",
        source: "scanner-sweep",
        summary: "Scanner blackout",
        context: { attempted: 2 },
      }),
    ]);
    expect(captures.every((result) => result.outcome === "captured")).toBe(true);

    const canary = await storage.transitionScannerIncidentHoldToCanary(holdId);
    expect(canary.outcome).toBe("transitioned");
    const repeatedCanary = await storage.transitionScannerIncidentHoldToCanary(holdId);
    expect(repeatedCanary.outcome).toBe("already_canary");
    await expect(storage.captureScannerIncidentOccurrence({
      eventId: `${holdId}-canary-a`,
      fingerprint: "identical-fingerprint",
      observedAt: new Date(baseTime.getTime() + 60_000),
      category: "scanner",
      source: "scanner-sweep",
      summary: "Scanner blackout",
      context: { attempted: 2 },
    })).resolves.toMatchObject({ outcome: "captured", holdId, window: "canary" });

    await storage.recordError({
      fingerprint: ordinaryFingerprint,
      category: "scanner",
      source: "scanner-sweep",
      message: "ordinary row eligible for age pruning",
      lastSeen: new Date("2020-01-01T00:00:00.000Z"),
    });
    const pruned = await storage.pruneErrors({ maxAgeDays: 1, maxRows: 500 });
    expect(pruned.deletedByAge).toBeGreaterThanOrEqual(1);
    const retainedAfterPrune = await db.select().from(scannerIncidentOccurrences)
      .where(eq(scannerIncidentOccurrences.holdId, holdId));
    expect(retainedAfterPrune).toHaveLength(3);

    await expect(storage.releaseScannerIncidentHold(holdId, {
      rowCount: 3,
      digest: "0".repeat(64),
    })).resolves.toMatchObject({ outcome: "invalid_state", state: "canary" });

    const exported = await storage.exportScannerIncidentHold(holdId);
    expect(exported.outcome).toBe("exported");
    if (exported.outcome !== "exported") throw new Error("export did not complete");
    expect(exported.packet.payload.windows).toEqual({
      baseline: { rawOccurrences: 2 },
      canary: { rawOccurrences: 1 },
    });
    expect(exported.packet.payload.fingerprints).toEqual([{
      fingerprint: "identical-fingerprint",
      baseline: 2,
      canary: 1,
      total: 3,
    }]);

    await expect(storage.captureScannerIncidentOccurrence({
      eventId: `${holdId}-after-export`,
      fingerprint: "must-not-append",
      observedAt: new Date(),
      category: "scanner",
      source: "scanner-sweep",
      summary: "after export",
      context: {},
    })).resolves.toEqual({ outcome: "inactive" });

    await expect(storage.releaseScannerIncidentHold(holdId, {
      rowCount: exported.packet.payload.rawRowCount,
      digest: "F".repeat(64),
    })).resolves.toEqual({ outcome: "proof_mismatch" });
    expect(await db.select().from(scannerIncidentOccurrences)
      .where(eq(scannerIncidentOccurrences.holdId, holdId))).toHaveLength(3);

    const released = await storage.releaseScannerIncidentHold(holdId, {
      rowCount: exported.packet.payload.rawRowCount,
      digest: exported.packet.digest,
    });
    expect(released).toMatchObject({ outcome: "released", deletedRows: 3, alreadyReleased: false });
    expect(await db.select().from(scannerIncidentOccurrences)
      .where(eq(scannerIncidentOccurrences.holdId, holdId))).toHaveLength(0);
    await expect(storage.releaseScannerIncidentHold(holdId, {
      rowCount: exported.packet.payload.rawRowCount,
      digest: exported.packet.digest,
    })).resolves.toMatchObject({ outcome: "released", deletedRows: 0, alreadyReleased: true });
  }, 60_000);

  it("frees the database-enforced active slot only after release", async () => {
    const activated = await storage.activateScannerIncidentHold(secondHoldId);
    expect(activated.outcome).toBe("activated");
    const exported = await storage.exportScannerIncidentHold(secondHoldId);
    expect(exported.outcome).toBe("exported");
    if (exported.outcome !== "exported") throw new Error("empty export did not complete");
    await expect(storage.releaseScannerIncidentHold(secondHoldId, {
      rowCount: 0,
      digest: exported.packet.digest,
    })).resolves.toMatchObject({ outcome: "released", deletedRows: 0 });
  });
});
