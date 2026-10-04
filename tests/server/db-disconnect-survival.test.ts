import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import type { Socket } from "node:net";

type ConnectedClient = PoolClient & { connection: { stream: Socket } };

// Exercise real pg clients and the real db module against the test database.
// Destroy only our own sockets: no production access, DDL, or backend killing.
describe.each(["web", "lab"])("database disconnect survival (%s)", (poolName) => {
  let database: typeof import("../../server/db");
  let intervals: ReturnType<typeof setInterval>[];
  let errors: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv("DB_POOL_NAME", poolName);
    intervals = [];
    const original = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const timer = original(...args);
      intervals.push(timer);
      return timer;
    }) as typeof setInterval);
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    database = await import("../../server/db");
    await database.pool.query("SELECT 1");
  });

  afterAll(async () => {
    for (const timer of intervals) clearInterval(timer);
    await database?.closePool();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function disconnect(client: PoolClient) {
    // Do not install an error listener in the test: it would hide the regression.
    expect(client.listenerCount("error")).toBeGreaterThan(0);
    (client as ConnectedClient).connection.stream.destroy(new Error("simulated database disconnect"));
  }

  it("survives a checked-out client loss between queries and reconnects", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("SELECT 1");
      disconnect(client);
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(
        expect.stringContaining("Client connection error:"), "simulated database disconnect",
      ));
      await expect(client.query("SELECT 1")).rejects.toThrow();
    } finally {
      client.release(true);
    }
    expect((await database.pool.query("SELECT 1 AS recovered")).rows[0].recovered).toBe(1);
  });

  it("rejects an interrupted query and serves the next query without replay", async () => {
    const client = await database.pool.connect();
    try {
      const pending = expect(client.query("SELECT pg_sleep(10)")).rejects.toThrow();
      disconnect(client);
      await pending;
    } finally {
      client.release(true);
    }
    expect((await database.pool.query("SELECT 1 AS recovered")).rows[0].recovered).toBe(1);
  });

  it("also protects the scanner pool and its Lab alias", async () => {
    expect(database.scannerCandlePool === database.pool).toBe(poolName === "lab");
    const client = await database.scannerCandlePool.connect();
    try {
      await client.query("SELECT 1");
      disconnect(client);
      await vi.waitFor(() => expect((client as ConnectedClient).connection.stream.destroyed).toBe(true));
      await expect(client.query("SELECT 1")).rejects.toThrow();
    } finally {
      client.release(true);
    }
    expect((await database.scannerCandlePool.query("SELECT 1 AS recovered")).rows[0].recovered).toBe(1);
  });

  it("evicts a disconnected idle client and replaces it", async () => {
    const client = await database.pool.connect();
    await client.query("SELECT 1");
    client.release();
    const removed = new Promise<void>((resolve) => database.pool.once("remove", () => resolve()));
    disconnect(client);
    await removed;
    const replacement = await database.pool.connect();
    try {
      expect(replacement).not.toBe(client);
      expect((await replacement.query("SELECT 1 AS recovered")).rows[0].recovered).toBe(1);
    } finally {
      replacement.release();
    }
  });

  it("rejects a disconnected Drizzle transaction without replaying its callback", async () => {
    let client: PoolClient | undefined;
    let ready!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const capture = (acquired: PoolClient) => { client = acquired; };
    database.pool.once("acquire", capture);
    const callback = vi.fn(async (tx: Parameters<Parameters<typeof database.db.transaction>[0]>[0]) => {
      await tx.execute(sql`SELECT 1`);
      ready();
      await gate;
      await tx.execute(sql`SELECT 1`);
    });
    const transaction = database.db.transaction(callback);
    const rejected = expect(transaction).rejects.toThrow();
    await started;
    try {
      disconnect(client!);
      await vi.waitFor(() => expect((client as ConnectedClient).connection.stream.destroyed).toBe(true));
    } finally {
      resume();
      database.pool.removeListener("acquire", capture);
    }
    await rejected;
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await database.pool.query("SELECT 1 AS recovered")).rows[0].recovered).toBe(1);
  });
});
