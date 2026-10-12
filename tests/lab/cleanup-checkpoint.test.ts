import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { cleanupProjection, resetCheckpointAttempts, completedCheckpointNeedsTrim, slimCompletedCheckpoint } from "../../server/lab/cleanup-checkpoint";

const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) : null;
afterAll(async () => { await pool?.end(); });

describe.runIf(hasDb)("Lab cleanup SQL preserves checkpoint recovery semantics", () => {
  const cases = [
    null, {}, [], { completedCombos: [] }, { completedCombos: ["EXAMPLE"] },
    { currentCombo: "EXAMPLE", currentIteration: 0 },
    { currentCombo: "EXAMPLE", currentIteration: -1 },
    { currentCombo: "EXAMPLE", currentIteration: "0" },
    { currentCombo: "", currentIteration: null },
    { configSnapshot: {} }, { configSnapshot: { type: "EXAMPLE" } },
    { userCancelled: true, resourceError: true },
    { userCancelled: false, resourceError: 0 },
    { completedCombos: "EXAMPLE" }, { completedCombos: { length: "2" } },
    { completedCombos: ["EXAMPLE"], configSnapshot: { type: "" }, topResults: Array(1000).fill("EXAMPLE"), autoResumeAttempts: 5 },
  ];
  it.each(cases.map((checkpoint, index) => ({ checkpoint, index })))("matches original JavaScript rules for case $index", async ({ checkpoint }) => {
    const fallback = { type: "EXAMPLE-FALLBACK" };
    const fields = Object.entries(cleanupProjection).map(([key, value]) => sql`${value} as ${sql.identifier(key)}`);
    const statement = sql`with lab_optimization_runs(id, checkpoint, config_snapshot) as
      (values (1, ${JSON.stringify(checkpoint)}::jsonb, ${JSON.stringify(fallback)}::jsonb))
      select ${sql.join(fields, sql`, `)}, ${resetCheckpointAttempts} as reset,
      ${completedCheckpointNeedsTrim} as trim, ${slimCompletedCheckpoint} as slim from lab_optimization_runs`;
    const query = new PgDialect().sqlToQuery(statement);
    const result = (await pool!.query(query.sql, query.params)).rows[0];
    const cp: any = checkpoint && typeof checkpoint === "object" ? checkpoint : null;
    expect(result.checkpointObject).toBe(cp !== null);
    expect(result.comboLength > 0).toBe(!!(cp?.completedCombos?.length > 0));
    expect(result.currentCombo).toBe(!!cp?.currentCombo);
    expect(result.currentIteration).toEqual(cp?.currentIteration ?? null);
    expect(result.configSnapshot).toBe(!!cp?.configSnapshot);
    expect(result.userCancelled).toBe(!!cp?.userCancelled);
    expect(result.resourceError).toBe(!!cp?.resourceError);
    expect(result.trim).toBe(!!(cp && (cp.completedCombos || cp.currentCombo || cp.currentIteration != null)));
    const type = cp?.configSnapshot?.type || fallback.type || null;
    expect(result.slim).toEqual(type ? { configSnapshot: { type } } : null);
    const reset = cp && !Array.isArray(cp) ? { ...cp, autoResumeAttempts: 0 } : checkpoint;
    expect(result.reset).toEqual(reset);
    expect("topResults" in result).toBe(false);
  });
});
