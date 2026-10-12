import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const fake = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock("../../server/db", () => ({ db: fake }));
vi.mock("../../server/job-timing", () => ({ startJobTiming: () => () => {}, timeJob: async (_: string, fn: () => Promise<unknown>) => fn() }));

describe("paged Lab startup recovery", () => {
  it("preserves running/failed/paused eligibility, resets in SQL, and never selects full JSON", async () => {
    const { labOptimizationRuns, labOptimizationResults } = await import("../../shared/schema");
    const { cleanupProjection } = await import("../../server/lab/cleanup-checkpoint");
    const { LabDatabaseStorage, labStorage } = await import("../../server/lab/storage");
    await labStorage.initPromise;
    type Row = { id: number; status: string; comboLength: number; currentCombo: boolean; currentIteration: number | null; configSnapshot: boolean; userCancelled: boolean; resourceError: boolean; checkpointObject: boolean; checkpointStoredBytes: number };
    const row = (id: number, status: string, patch: Partial<Row> = {}): Row => ({ id, status, comboLength: 0, currentCombo: false, currentIteration: null, configSnapshot: false, userCancelled: false, resourceError: false, checkpointObject: true, checkpointStoredBytes: 100, ...patch });
    const runs: Row[] = [
      row(1, "running", { currentCombo: true, currentIteration: 0 }),
      row(2, "running", { currentCombo: true, currentIteration: -1 }),
      row(3, "running", { checkpointObject: false }), // persisted result only
      row(4, "failed", { configSnapshot: true, resourceError: true }),
      row(5, "failed", { configSnapshot: true, userCancelled: true }),
      row(6, "paused", { configSnapshot: true, resourceError: true }),
      row(7, "paused", { configSnapshot: true, userCancelled: true }),
      row(8, "paused", { currentCombo: true, currentIteration: -1 }),
      row(9, "paused"), // persisted results alone do not recover paused runs
      ...Array.from({ length: 205 }, (_, i) => row(10 + i, "paused", { comboLength: 1 })),
      row(300, "complete"),
    ];
    const selections: { projection: any; table: any; where?: any; direction?: any; limit?: number }[] = [];
    const updates: { id: number; patch: any }[] = [];
    const dialect = new PgDialect();
    fake.select.mockImplementation((projection: any) => {
      const request: any = { projection };
      selections.push(request);
      const getRows = () => {
        const where = dialect.sqlToQuery(request.where);
        if (where.sql.includes("is null")) return [];
        if (request.table === labOptimizationResults) return [3, 9].includes(where.params[0] as number) ? [{ id: 1 }] : [];
        const [status, after, through] = where.params as [string, number?, number?];
        let selected = runs.filter((run) => run.status === status && (after === undefined || run.id > after) && (through === undefined || run.id <= through));
        selected.sort((a, b) => request.direction && dialect.sqlToQuery(request.direction).sql.includes("desc") ? b.id - a.id : a.id - b.id);
        selected = selected.slice(0, request.limit);
        return selected.map((run) => projection === cleanupProjection ? { ...run } : { id: run.id });
      };
      const chain: any = {
        from: (table: any) => { request.table = table; return chain; },
        where: (where: any) => { request.where = where; return chain; },
        orderBy: (direction: any) => { request.direction = direction; return chain; },
        limit: (limit: number) => { request.limit = limit; return Promise.resolve(getRows()); },
        then: (resolve: any, reject: any) => Promise.resolve(getRows()).then(resolve, reject),
      };
      return chain;
    });
    fake.update.mockImplementation(() => ({ set: (patch: any) => ({ where: async (where: any) => {
      const { params } = dialect.sqlToQuery(where);
      for (const id of params as number[]) {
        const run = runs.find((r) => r.id === id)!;
        updates.push({ id, patch });
        if (patch.status) run.status = patch.status;
      }
    } }) }));
    // Module singleton saw empty mocks before fixture installation; this
    // explicit instance owns the controlled startup sequence.
    const storage = new LabDatabaseStorage();
    await storage.initPromise;
    expect(runs.find((r) => r.id === 1)?.status).toBe("paused");
    expect(runs.find((r) => r.id === 2)?.status).toBe("paused"); // failed phase accepts negative mid-combo
    expect(runs.find((r) => r.id === 3)?.status).toBe("paused");
    expect(runs.find((r) => r.id === 5)?.status).toBe("failed");
    expect(storage.interruptedRunIds).toEqual([1, 3, 2, 4, 8, ...Array.from({ length: 205 }, (_, i) => 10 + i)]);
    expect(new Set(storage.interruptedRunIds).size).toBe(storage.interruptedRunIds.length);
    expect(updates.find((u) => u.id === 2 && u.patch.status === "failed")?.patch.completedAt).toBeInstanceOf(Date);
    expect(updates.find((u) => u.id === 2 && u.patch.status === "paused")?.patch.completedAt).toBeNull();
    expect(updates.find((u) => u.id === 3)?.patch.checkpoint).toBeUndefined();
    for (const update of updates.filter((u) => u.patch.checkpoint)) expect(update.patch.checkpoint).toHaveProperty("queryChunks");
    const recoveryPages = selections.filter((r) => r.projection === cleanupProjection);
    expect(recoveryPages.filter((r) => dialect.sqlToQuery(r.where).params[0] === "paused").length).toBeGreaterThanOrEqual(3);
    expect(recoveryPages.every((r) => r.limit === 100)).toBe(true);
    expect(selections.every((r) => r.projection && !("checkpoint" in r.projection) && !("configSnapshot" in r.projection && r.projection.configSnapshot === labOptimizationRuns.configSnapshot))).toBe(true);
  });
});
