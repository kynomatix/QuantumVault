import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolInstances: FakePool[] = [];

class FakePool {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  queryMock = vi.fn(async () => ({ rows: [] }));
  endMock = vi.fn(async () => {});

  constructor(readonly options: Record<string, unknown> = {}) {
    poolInstances.push(this);
  }

  query(...args: unknown[]) {
    return this.queryMock(...args);
  }

  end() {
    return this.endMock();
  }

  on() {
    return this;
  }
}

vi.mock("pg", () => ({
  default: { Pool: FakePool },
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({})),
}));
vi.mock("@shared/schema", () => ({}));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromiseChain() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  poolInstances.length = 0;
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/pool_load_test";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.DATABASE_URL;
});

describe("database keep-warm pool-load attribution", () => {
  it("eagerly establishes and persistently re-establishes the bounded scanner lane without queuing or overlap", async () => {
    const dbModule = await import("../../server/db");
    const { formatPoolLoadTags } = await import("../../server/pool-load");
    const [web, scanner] = poolInstances;
    expect(poolInstances).toHaveLength(2);
    expect(web.options).toMatchObject({ max: 8 });
    expect(scanner.options).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 0,
      application_name: "qv-scanner-candle",
    });
    expect(dbModule.scannerCandlePool).not.toBe(dbModule.pool);

    expect(scanner.queryMock).toHaveBeenCalledTimes(1);
    expect(scanner.queryMock).toHaveBeenLastCalledWith({
      text: "SELECT 1",
      query_timeout: 5_000,
    });
    await flushPromiseChain();
    scanner.queryMock.mockClear();

    const scannerFirst = deferred<unknown>();
    web.queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    scanner.queryMock.mockReturnValueOnce(scannerFirst.promise);

    expect(formatPoolLoadTags()).toBe("");
    expect(vi.getTimerCount()).toBe(4);

    // The lane is empty again: the next heartbeat must actively re-establish
    // it instead of waiting for a real scanner batch.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.queryMock).toHaveBeenCalledTimes(1);
    expect(scanner.queryMock).toHaveBeenLastCalledWith({
      text: "SELECT 1",
      query_timeout: 5_000,
    });
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb0/shb1");

    // A still-pending heartbeat never overlaps itself.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.queryMock).toHaveBeenCalledTimes(1);
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb0/shb1");

    scannerFirst.resolve({ rows: [{ "?column?": 1 }] });
    await flushPromiseChain();
    expect(formatPoolLoadTags()).toBe("");

    // An active max-one lane is never queued behind.
    scanner.totalCount = 1;
    scanner.idleCount = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.queryMock).toHaveBeenCalledTimes(1);

    // Once idle, the same bounded heartbeat retains it.
    scanner.idleCount = 1;
    scanner.queryMock.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.queryMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(4);

    await dbModule.closePool();
    expect(web.endMock).toHaveBeenCalledOnce();
    expect(scanner.endMock).toHaveBeenCalledOnce();
  });
});
