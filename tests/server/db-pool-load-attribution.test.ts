import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

class FakePool {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  options = { max: 8 };

  query(...args: unknown[]) {
    return queryMock(...args);
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
  queryMock.mockReset();
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
  it("suppresses idle state and follows only overlapping SELECT 1 promise lifetimes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    queryMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await import("../../server/db");
    const { formatPoolLoadTags } = await import("../../server/pool-load");

    expect(formatPoolLoadTags()).toBe("");
    expect(vi.getTimerCount()).toBe(4);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenLastCalledWith("SELECT 1");
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb1");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock).toHaveBeenLastCalledWith("SELECT 1");
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb2");
    expect(vi.getTimerCount()).toBe(4);

    first.resolve({ rows: [{ "?column?": 1 }] });
    await flushPromiseChain();
    expect(formatPoolLoadTags()).toBe(" db_maintenance=hb1");

    second.reject(new Error("heartbeat rejected"));
    await flushPromiseChain();
    expect(formatPoolLoadTags()).toBe("");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
