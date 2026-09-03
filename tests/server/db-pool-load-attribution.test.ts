import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolInstances: FakePool[] = [];

class FakePool {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  queryMock = vi.fn(async () => ({ rows: [] }));
  connectMock = vi.fn(async () => ({ release: vi.fn() }));
  endMock = vi.fn(async () => {});

  constructor(readonly options: Record<string, unknown> = {}) {
    poolInstances.push(this);
  }

  query(...args: unknown[]) {
    return this.queryMock(...args);
  }

  connect(...args: unknown[]) {
    return this.connectMock(...args);
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
  it("establishes only a missing scanner connection and never probes an idle max-one lane", async () => {
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

    expect(scanner.connectMock).toHaveBeenCalledTimes(1);
    expect(scanner.queryMock).not.toHaveBeenCalled();
    await flushPromiseChain();
    scanner.connectMock.mockClear();

    const scannerFirst = deferred<{ release: () => void }>();
    const firstRelease = vi.fn();
    web.queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    scanner.connectMock.mockReturnValueOnce(scannerFirst.promise);

    expect(formatPoolLoadTags()).toBe("");
    expect(vi.getTimerCount()).toBe(4);

    // The lane is physically empty: the next heartbeat establishes a client
    // without issuing a maintenance query.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.connectMock).toHaveBeenCalledTimes(1);
    expect(scanner.queryMock).not.toHaveBeenCalled();
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb0/shb1");

    // A still-pending heartbeat never overlaps itself.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.connectMock).toHaveBeenCalledTimes(1);
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb0/shb1");

    scannerFirst.resolve({ release: firstRelease });
    await flushPromiseChain();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("warm_connect outcome=success elapsed=20000ms"),
    );
    expect(formatPoolLoadTags()).toBe("");

    // An active max-one lane is never queued behind.
    scanner.totalCount = 1;
    scanner.idleCount = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.connectMock).toHaveBeenCalledTimes(1);

    // idleTimeoutMillis=0 retains a healthy idle client without a maintenance
    // checkout or query that could steal the sole lane from a boundary batch.
    scanner.idleCount = 1;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.connectMock).toHaveBeenCalledTimes(1);
    expect(scanner.queryMock).not.toHaveBeenCalled();

    // If pg removes a dead idle client, the next cadence establishes a new
    // physical connection and releases it immediately, still without SQL.
    scanner.totalCount = 0;
    scanner.idleCount = 0;
    const replacementRelease = vi.fn();
    scanner.connectMock.mockResolvedValueOnce({ release: replacementRelease });
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromiseChain();
    expect(scanner.connectMock).toHaveBeenCalledTimes(2);
    expect(replacementRelease).toHaveBeenCalledOnce();
    expect(scanner.queryMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(4);

    await dbModule.closePool();
    expect(web.endMock).toHaveBeenCalledOnce();
    expect(scanner.endMock).toHaveBeenCalledOnce();
  });
});
