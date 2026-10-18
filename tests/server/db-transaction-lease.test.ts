import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient, QueryConfig } from "pg";
import * as schema from "@shared/schema";

// Use the locked Drizzle driver and real pg pool. Inject query failures only on
// our own clients; no backend termination, persistent DDL, or money operations.
describe.each([1, 8])("transaction lease (pool max %i)", (poolMax) => {
  let database: typeof import("../../server/db");
  type Lease = {
    client: PoolClient;
    release: MockInstance<PoolClient["release"]>;
    statements: string[];
  };
  let leases: Lease[];
  let failQuery: ((statement: string) => Error | undefined) | undefined;

  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv("DB_POOL_NAME", "lab"); // One pool, without the scanner warmer.
    vi.stubEnv("DB_POOL_SIZE", String(poolMax));
    vi.stubEnv("DB_CONN_TIMEOUT_MS", "3000");
    const intervals: ReturnType<typeof setInterval>[] = [];
    const originalInterval = globalThis.setInterval;
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const timer = originalInterval(...args);
      intervals.push(timer);
      return timer;
    }) as typeof setInterval);
    try {
      database = await import("../../server/db");
    } finally {
      for (const timer of intervals) clearInterval(timer);
      intervalSpy.mockRestore();
    }
  });

  beforeEach(() => {
    leases = [];
    failQuery = undefined;
    const originalConnect = database.pool.connect.bind(database.pool);
    vi.spyOn(database.pool, "connect").mockImplementation(((callback?: Parameters<typeof database.pool.connect>[0]) => {
      // Preserve pg's callback overload used by pool.query.
      if (callback) return originalConnect(callback);
      return originalConnect().then((client) => {
        const release = vi.spyOn(client, "release");
        const statements: string[] = [];
        // A later lease can reuse this physical client. Restore the previous
        // query spy before binding the driver method again.
        if (vi.isMockFunction(client.query)) vi.mocked(client.query).mockRestore();
        const originalQuery = client.query.bind(client);
        vi.spyOn(client, "query").mockImplementation(((query: string | QueryConfig, ...args: unknown[]) => {
          const statement = typeof query === "string" ? query : query.text;
          statements.push(statement);
          const failure = failQuery?.(statement);
          return failure ? Promise.reject(failure) : Reflect.apply(originalQuery, client, [query, ...args]);
        }) as PoolClient["query"]);
        leases.push({ client, release, statements });
        return client;
      });
    }) as typeof database.pool.connect);
  });

  afterEach(() => {
    // A regressed guard must fail assertions without leaving the test pool hung.
    for (const lease of leases) {
      if (lease.release.mock.calls.length === 0) lease.client.release(true);
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await database?.closePool();
    vi.unstubAllEnvs();
  });

  function expectReleased(lease: Lease, discard: boolean) {
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledWith(discard);
  }

  async function expectQueryFailure(query: Promise<unknown>, driverError: Error & { code: string }) {
    await expect(query).rejects.toMatchObject({
      message: driverError.message,
      code: driverError.code,
      cause: expect.any(Error),
    });
    let current: unknown = await query.catch((error: unknown) => error);
    const seen = new Set<unknown>();
    while (current !== undefined) {
      expect(current).toBeInstanceOf(Error);
      expect(seen.has(current)).toBe(false);
      seen.add(current);
      const error = current as Error & { code?: string; cause?: unknown };
      // Exact driver text excludes appended SQL/params at every cause depth.
      expect(error.message).toBe(driverError.message);
      expect(error.message).not.toMatch(/Failed query:|params:/i);
      expect(error.code).toBe(driverError.code);
      current = error.cause;
    }
  }

  it("failed BEGIN releases exactly once and unblocks a queued checkout without calling the body", async () => {
    const holders = await Promise.all(Array.from({ length: poolMax - 1 }, () => database.pool.connect()));
    const error = Object.assign(new Error("EXAMPLE failed BEGIN"), { code: "08006" });
    let queued: Promise<PoolClient> | undefined;
    failQuery = (statement) => {
      if (statement !== "begin") return;
      queued = database.pool.connect();
      void queued.catch(() => undefined);
      expect(database.pool.waitingCount).toBe(1);
      return error;
    };
    const callback = vi.fn(async () => "unreachable");
    await expectQueryFailure(database.db.transaction(callback), error);
    const failedLease = leases[poolMax - 1];
    expectReleased(failedLease, true);
    expect(failedLease.statements).toEqual(["begin"]);
    expect(callback).not.toHaveBeenCalled();
    const next = await queued!;
    expect(next).not.toBe(failedLease.client);
    next.release(false);
    for (const holder of holders) holder.release(false);
    expect(database.pool.waitingCount).toBe(0);
    expect(database.pool.totalCount - database.pool.idleCount).toBe(0);
  });

  it("callback throw rolls back, discards once, and preserves the thrown object", async () => {
    const error = new Error("EXAMPLE callback failure");
    const callback = vi.fn(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      throw error;
    });
    await expect(database.db.transaction(callback)).rejects.toBe(error);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(leases).toHaveLength(1);
    expect(leases[0].statements).toEqual(["begin", "SELECT 1", "rollback"]);
    expectReleased(leases[0], true);
  });

  it("COMMIT failure rolls back and releases once without replaying the body", async () => {
    const error = Object.assign(new Error("EXAMPLE failed COMMIT"), { code: "40001" });
    failQuery = (statement) => statement === "commit" ? error : undefined;
    const callback = vi.fn(async () => 42);
    await expectQueryFailure(database.db.transaction(callback), error);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(leases).toHaveLength(1);
    expect(leases[0].statements).toEqual(["begin", "commit", "rollback"]);
    expectReleased(leases[0], true);
  });

  it("ROLLBACK failure preserves Drizzle's error precedence and releases once", async () => {
    const callbackError = new Error("EXAMPLE callback failure");
    const rollbackError = Object.assign(new Error("EXAMPLE failed ROLLBACK"), { code: "XX000" });
    failQuery = (statement) => statement === "rollback" ? rollbackError : undefined;
    await expectQueryFailure(database.db.transaction(async () => { throw callbackError; }), rollbackError);
    expect(leases[0].statements).toEqual(["begin", "rollback"]);
    expectReleased(leases[0], true);
  });

  it("successful commit returns the exact value and normally reuses the client", async () => {
    const value = { result: "EXAMPLE" };
    await expect(database.db.transaction(async (tx) => {
      expect((await tx.execute(sql`SELECT 1 AS result`)).rows[0].result).toBe(1);
      return value;
    })).resolves.toBe(value);
    expect(leases).toHaveLength(1);
    expect(leases[0].statements).toEqual(["begin", "SELECT 1 AS result", "commit"]);
    expectReleased(leases[0], false);
    const firstClient = leases[0].client;
    const next = await database.pool.connect();
    expect(next).toBe(firstClient);
    next.release(false);
  });

  it("passes isolation, read-only, and deferrable config unchanged", async () => {
    await database.db.transaction(async (tx) => {
      const result = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_deferrable') AS deferrable`);
      expect(result.rows[0]).toEqual({ isolation: "serializable", read_only: "on", deferrable: "on" });
    }, { isolationLevel: "serializable", accessMode: "read only", deferrable: true });
    expect(leases).toHaveLength(1);
    expect(leases[0].statements[0]).toBe("begin isolation level serializable read only deferrable");
    expectReleased(leases[0], false);
  });

  it("nested transactions use savepoints and one pool client", async () => {
    await expect(database.db.transaction(async (tx) => tx.transaction(async (nested) => {
      await nested.execute(sql`SELECT 2`);
      return nested.transaction(async (inner) => {
        await inner.execute(sql`SELECT 3`);
        return 7;
      });
    }))).resolves.toBe(7);
    expect(leases).toHaveLength(1);
    expect(leases[0].statements).toEqual([
      "begin", "savepoint sp1", "SELECT 2", "savepoint sp2", "SELECT 3",
      "release savepoint sp2", "release savepoint sp1", "commit",
    ]);
    expectReleased(leases[0], false);
  });

  it("a caught nested failure rolls back its savepoint and the outer transaction can commit", async () => {
    const error = new Error("EXAMPLE nested failure");
    await expect(database.db.transaction(async (tx) => {
      await expect(tx.transaction(async () => { throw error; })).rejects.toBe(error);
      await tx.execute(sql`SELECT 1`);
      return "recovered";
    })).resolves.toBe("recovered");
    expect(leases).toHaveLength(1);
    expect(leases[0].statements).toEqual([
      "begin", "savepoint sp1", "rollback to savepoint sp1", "SELECT 1", "commit",
    ]);
    expectReleased(leases[0], false);
  });

  it("explicit tx.rollback preserves Drizzle's rollback error", async () => {
    await expect(database.db.transaction(async (tx) => { tx.rollback(); })).rejects.toThrow("Rollback");
    expect(leases[0].statements).toEqual(["begin", "rollback"]);
    expectReleased(leases[0], true);
  });

  it("failed acquisition propagates unchanged without running the callback or releasing a client", async () => {
    const error = new Error("EXAMPLE checkout failure");
    vi.spyOn(database.pool, "connect").mockRejectedValueOnce(error);
    const callback = vi.fn(async () => 1);
    await expect(database.db.transaction(callback)).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
    expect(leases).toHaveLength(0);
  });

  it("matches the original driver for values, config, nested SQL, and rollback error precedence", async () => {
    type Tx = Parameters<Parameters<typeof database.db.transaction>[0]>[0];
    const callback = async (tx: Tx) => tx.transaction(async (nested) => {
      await nested.execute(sql`SELECT 1`);
      return 11;
    });
    const config = { isolationLevel: "repeatable read" as const, accessMode: "read write" as const };
    const original = drizzle(database.pool, { schema });
    await expect(original.transaction(callback, config)).resolves.toBe(11);
    const originalStatements = [...leases[0].statements];
    // The unguarded pool session calls release() with no discard argument.
    expect(leases[0].release).toHaveBeenCalledTimes(1);
    expect(leases[0].release).toHaveBeenCalledWith();
    await expect(database.db.transaction(callback, config)).resolves.toBe(11);
    expect(leases[1].statements).toEqual(originalStatements);
    expectReleased(leases[1], false);
    const error = Object.assign(new Error("EXAMPLE rollback precedence"), { code: "XX000" });
    failQuery = (statement) => statement === "rollback" ? error : undefined;
    const throwBody = async () => { throw new Error("EXAMPLE body failure"); };
    await expectQueryFailure(original.transaction(throwBody), error);
    const originalFailureStatements = [...leases[2].statements];
    failQuery = undefined;
    await database.pool.query("ROLLBACK"); // Clean the original driver's returned session.
    failQuery = (statement) => statement === "rollback" ? error : undefined;
    await expectQueryFailure(database.db.transaction(throwBody), error);
    expect(leases[3].statements).toEqual(originalFailureStatements);
    expectReleased(leases[3], true);
  });

  it("runs at pool max with nested work and drains a queued transaction without a second checkout", async () => {
    let resume!: () => void;
    let allEntered!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { allEntered = resolve; });
    let bodies = 0;
    const transactions = Array.from({ length: poolMax }, (_, index) => database.db.transaction(async (tx) => {
      if (++bodies === poolMax) allEntered();
      await gate;
      return tx.transaction(async (nested) => {
        const result = await nested.execute(sql`SELECT ${index}::integer AS result`);
        return result.rows[0].result;
      });
    }));
    let queued: Promise<string> | undefined;
    try {
      await Promise.race([entered, Promise.all(transactions)]);
      expect(bodies).toBe(poolMax);
      expect(leases).toHaveLength(poolMax);
      expect(database.pool.totalCount).toBe(poolMax);
      expect(database.pool.idleCount).toBe(0);
      expect(database.pool.waitingCount).toBe(0);
      queued = database.db.transaction(async () => "queued");
      expect(database.pool.waitingCount).toBe(1);
      resume();
      await expect(Promise.all(transactions)).resolves.toEqual(Array.from({ length: poolMax }, (_, index) => index));
      await expect(queued).resolves.toBe("queued");
      expect(leases).toHaveLength(poolMax + 1);
      for (const lease of leases) expectReleased(lease, false);
      expect(database.pool.waitingCount).toBe(0);
      expect(database.pool.idleCount).toBe(poolMax);
    } finally {
      resume();
      await Promise.allSettled([...transactions, ...(queued ? [queued] : [])]);
    }
  });
});
