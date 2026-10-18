import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgPreparedQuery } from "drizzle-orm/node-postgres/session";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { sanitizeDbError } from "../../server/db-error-sanitize";

const queryText = 'insert into "EXAMPLE_private_records" ("value") values ($1)';
const params = ["EXAMPLE_wallet_address", "EXAMPLE_encrypted_key_blob", "EXAMPLE_signature", "EXAMPLE_api_key", "EXAMPLE_webhook_secret"];
const driverMessage = 'duplicate key value violates unique constraint "EXAMPLE_unique"';

function driverError(code = "23505") {
  const error = new pg.DatabaseError(driverMessage, 0, "error");
  Object.assign(error, {
    code, severity: "ERROR", constraint: "EXAMPLE_unique", table: "EXAMPLE_records",
    column: "EXAMPLE_value", routine: "EXAMPLE_routine",
    // None of these driver/wrapper diagnostics may survive the boundary.
    detail: params.join(","), hint: params[1], internalQuery: queryText,
    where: params[2], query: queryText, params,
    toJSON: () => ({ private: params[3] }),
    [inspect.custom]: () => params[4],
  });
  error.stack = `${error.name}: ${error.message}\n${queryText}\n${params.join(",")}`;
  return error;
}

function expectSafe(error: unknown, forbidden = [queryText, ...params]) {
  expect(error).toBeInstanceOf(Error);
  const failure = error as Error;
  const renderings = [failure.message, failure.stack!, String(failure), JSON.stringify(failure), inspect(failure), inspect(failure, { showHidden: true })];
  for (const rendering of renderings) {
    for (const value of forbidden) expect(rendering).not.toContain(value);
  }
  for (let current: any = failure; current; current = current.cause) {
    expect(current).not.toHaveProperty("query");
    expect(current).not.toHaveProperty("params");
    expect(current).not.toHaveProperty("detail");
    expect(current).not.toHaveProperty("internalQuery");
    expect(Object.keys(current).sort()).toEqual(["code", "column", "constraint", "routine", "severity", "table"]);
  }
}

describe("database error sanitization", () => {
  it.each(["23505", "23503", "42P01", "57014"])("preserves SQLSTATE %s without retaining SQL or parameters", code => {
    const originalCause = driverError(code);
    const original = new DrizzleQueryError(queryText, params, originalCause);
    const clean = sanitizeDbError(original) as Error & { code: string; cause: Error };
    expect(clean).toBeInstanceOf(DrizzleQueryError);
    expect(clean.cause).toBeInstanceOf(pg.DatabaseError);
    expect(clean.cause).not.toBe(originalCause);
    expect(clean).toMatchObject({ message: driverMessage, name: originalCause.name, code,
      severity: "ERROR", constraint: "EXAMPLE_unique", table: "EXAMPLE_records", column: "EXAMPLE_value", routine: "EXAMPLE_routine" });
    expect(clean.cause).toMatchObject({ message: driverMessage, code });
    expectSafe(clean);
    expect(original.query).toBe(queryText);
    expect(originalCause.detail).toBe(params.join(","));
  });

  it("keeps nested causes walkable for the audit and fixed-yield SQLSTATE classifiers", () => {
    const driver = driverError("57014");
    const middle = new DrizzleQueryError(queryText, params, driver);
    const clean = sanitizeDbError(new DrizzleQueryError(queryText, params, middle)) as any;
    expect(clean.code ?? clean.cause?.code).toBe("57014");
    const codes: string[] = [];
    for (let current = clean; current; current = current.cause) codes.push(current.code);
    expect(codes).toEqual(["57014", "57014", "57014"]);
    expect(clean.cause).toBeInstanceOf(DrizzleQueryError);
    expect(clean.cause.cause).toBeInstanceOf(pg.DatabaseError);
    expectSafe(clean);
  });

  it("drops primitive and cyclic causes instead of retaining uninspectable diagnostics", () => {
    const driver = driverError();
    Object.defineProperty(driver, "cause", { value: driver, configurable: true });
    expectSafe(sanitizeDbError(new DrizzleQueryError(queryText, params, driver)));
    const missingDriver = sanitizeDbError(new DrizzleQueryError(queryText, params, params[0] as unknown as Error)) as Error;
    expect(missingDriver.message).toBe("Database query failed");
    for (const rendering of [String(missingDriver), missingDriver.stack!, JSON.stringify(missingDriver), inspect(missingDriver)]) {
      for (const value of [queryText, ...params]) expect(rendering).not.toContain(value);
    }
  });

  it.each([new TypeError("EXAMPLE application failure"), driverError(), null, undefined, "EXAMPLE rejection"])("passes non-wrapper errors through unchanged (%#)", error => {
    expect(sanitizeDbError(error)).toBe(error);
  });
});

const records = pgTable("EXAMPLE_private_records", { value: text("value") });

describe("real Drizzle execution with a database-free fake client", () => {
  function fakeClient() {
    const query = vi.fn(async (config: { text: string }) => {
      if (/^(begin|commit|rollback|savepoint|release savepoint)/i.test(config.text)) return { rows: [], rowCount: 0 };
      throw driverError();
    });
    const client = { query, release: vi.fn() };
    // The driver only calls query() on this path; never construct a real pg pool.
    return { client: client as unknown as pg.PoolClient, query, release: client.release };
  }

  async function expectQueryFailure(run: () => PromiseLike<unknown>) {
    let failure: unknown;
    try { await run(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DrizzleQueryError);
    expect(failure).toMatchObject({ message: driverMessage, code: "23505" });
    expectSafe(failure, ["EXAMPLE_private_records", ...params]);
  }

  it("sanitizes raw execute, mapped builders, returning writes, prepared and relational queries", async () => {
    const fake = fakeClient();
    const db = drizzle(fake.client, { schema: { records } });
    await expectQueryFailure(() => db.execute(sql`select ${params[0]} from ${records}`));
    await expectQueryFailure(() => db.select().from(records).where(eq(records.value, params[1])));
    await expectQueryFailure(() => db.insert(records).values({ value: params[2] }).returning());
    await expectQueryFailure(() => db.update(records).set({ value: params[3] }).returning());
    await expectQueryFailure(() => db.delete(records).where(eq(records.value, params[4])));
    const prepared = db.select().from(records).where(eq(records.value, sql.placeholder("value"))).prepare("EXAMPLE_prepared");
    await expectQueryFailure(() => prepared.execute({ value: params[0] }));
    // all() exists on the adapter; select.prepare() exposes only its base type.
    await expectQueryFailure(() => (prepared as unknown as NodePgPreparedQuery<any>).all({ value: params[1] }));
    await expectQueryFailure(() => db.query.records.findMany({ where: eq(records.value, params[2]) }));
    expect(fake.query).toHaveBeenCalledTimes(8);
  });

  it("covers independent pool sessions, leased transactions and nested savepoints", async () => {
    for (let lane = 0; lane < 2; lane++) {
      const fake = fakeClient();
      // Drizzle recognizes a pool by its prototype constructor name.
      class ExamplePool {
        query = fake.query;
        connect = vi.fn(async () => fake.client);
      }
      const pool = new ExamplePool();
      const db = drizzle(pool as unknown as pg.Pool);
      await expectQueryFailure(() => db.execute(sql`select ${params[0]} from ${records}`));
      await expectQueryFailure(() => db.transaction(tx => tx.transaction(nested => nested.execute(sql`select ${params[1]} from ${records}`))));
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(fake.release).toHaveBeenCalledTimes(1);
      expect(fake.query.mock.calls.map(([config]) => config.text)).toEqual([
        expect.stringContaining("EXAMPLE_private_records"), "begin", "savepoint sp1",
        expect.stringContaining("EXAMPLE_private_records"), "rollback to savepoint sp1", "rollback",
      ]);
      // server/db.ts also creates client-bound Drizzle sessions after leasing.
      await expectQueryFailure(() => drizzle(fake.client).transaction(tx => tx.execute(sql`select ${params[2]} from ${records}`)));
    }
  });

  it("preserves successful query results and transaction-body application errors", async () => {
    const result = { rows: [{ value: "EXAMPLE" }], rowCount: 1 };
    const query = vi.fn(async () => result);
    const db = drizzle({ query } as unknown as pg.PoolClient);
    expect(await db.execute(sql`select 1`)).toBe(result);
    const applicationError = new TypeError("EXAMPLE application failure");
    await expect(db.transaction(async () => { throw applicationError; })).rejects.toBe(applicationError);
  });
});
