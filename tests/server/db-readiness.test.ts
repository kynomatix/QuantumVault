import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pools: FakePool[] = [];
class FakePool extends EventEmitter {
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;
  query = vi.fn(async (_sql: string) => ({ rows: [] }));
  connect = vi.fn(async () => ({ release: vi.fn() }));
  end = vi.fn(async () => {});
  constructor() { super(); pools.push(this); }
}
vi.mock("pg", () => ({ default: { Pool: FakePool } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock("@shared/schema", () => ({}));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: vi.fn() }));

let server: Server;
let origin: string;
let bootReady: boolean;
let database: typeof import("../../server/db");
let readiness: typeof import("../../server/database-readiness");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.stubEnv("DATABASE_URL", "postgresql://127.0.0.1:1/readiness_test");
  vi.stubEnv("DB_POOL_NAME", "web");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  pools.length = 0;
  database = await import("../../server/db");
  readiness = await import("../../server/database-readiness");
  const runtime = await import("../../server/runtime-deployment-identity");
  bootReady = true;
  const app = express();
  app.get("/health", runtime.createRuntimeHealthHandler(() => bootReady));
  app.get("/api/health", runtime.createRuntimeHealthHandler(() => bootReady));
  app.use(runtime.createRuntimeReadinessMiddleware(() => bootReady, "starting"));
  app.get("/api/work", (_req, res) => { res.json({ served: true }); });
  app.get("/", (_req, res) => { res.send("application"); });
  server = createServer(app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing HTTP test port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database?.closePool();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function health() {
  const response = await fetch(origin + "/api/health");
  expect(response.status).toBe(200);
  return response.json();
}
function failChecks() {
  pools[0].query.mockRejectedValue(new Error("database unavailable"));
}

describe("post-boot database readiness through real db and HTTP handlers", () => {
  it("reports a persistent outage without intercepting post-boot API requests", async () => {
    expect((await health()).ready).toBe(true);
    pools[0].emit("error", new Error("connection lost"));
    expect(readiness.getDatabaseReadiness().lastConnectionErrorAt).not.toBeNull();
    failChecks();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await health()).toMatchObject({ ready: false, reason: expect.stringContaining("Database") });
    const response = await fetch(origin + "/api/work");
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ served: true });
  });

  it("clears degraded readiness on a successful heartbeat query without restarting", async () => {
    const before = await health();
    failChecks();
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await health()).ready).toBe(false);
    pools[0].query.mockResolvedValue({ rows: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await health()).toMatchObject({ ready: true, bootId: before.bootId });
    expect((await health()).reason).toBeUndefined();
    const live = await fetch(origin + "/health");
    expect(live.status).toBe(200);
    const recovered = await live.json();
    expect(recovered.ready).toBe(true);
    expect(recovered.reason).toBeUndefined();
    expect(readiness.getDatabaseReadiness()).toMatchObject({ failedChecks: 0, lastConnectionErrorAt: null });
    expect((await fetch(origin + "/api/work")).status).toBe(200);
  });

  it("does not double count client/pool error events or one transient failed check", async () => {
    const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({})) });
    pools[0].emit("connect", client);
    client.emit("error", new Error("single disconnect"));
    pools[0].emit("error", new Error("same disconnect"));
    expect((await health()).ready).toBe(true);
    failChecks();
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await health()).ready).toBe(true);
    pools[0].query.mockResolvedValue({ rows: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await health()).ready).toBe(true);
    expect(readiness.getDatabaseReadiness().failedChecks).toBe(0);
  });

  it("detects failed checks even when no connection error event is emitted", async () => {
    failChecks();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await health()).toMatchObject({ ready: false, reason: expect.stringContaining("Database") });
  });

  it("keeps liveness HTTP statuses unchanged at boot and after database failure", async () => {
    for (const readyAtBoot of [false, true]) {
      bootReady = readyAtBoot;
      failChecks();
      await vi.advanceTimersByTimeAsync(40_000);
      const live = await fetch(origin + "/health");
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ status: "ok", ready: false, reason: expect.stringContaining("Database") });
      expect((await health()).ready).toBe(false);
      const page = await fetch(origin + "/");
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe(readyAtBoot ? null : "no-store");
      expect(await page.text()).toBe(readyAtBoot ? "application" : "starting");
    }
    // The production entry point uses these same tested handlers before its guard.
    const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    const live = source.indexOf('app.get("/health", createRuntimeHealthHandler(() => appFullyReady))');
    const api = source.indexOf('app.get("/api/health", createRuntimeHealthHandler(() => appFullyReady))');
    const guard = source.indexOf('app.use(createRuntimeReadinessMiddleware(() => appFullyReady, STARTING_PAGE))');
    expect(live).toBeGreaterThan(0);
    expect(api).toBeGreaterThan(live);
    expect(guard).toBeGreaterThan(api);
  });

  it("does not overlap checks or treat duplicate in-flight work as consecutive failures", async () => {
    let rejectCheck!: (reason: Error) => void;
    pools[0].query.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheck = reject; }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pools[0].query).toHaveBeenCalledTimes(1);
    rejectCheck(new Error("database check timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(readiness.getDatabaseReadiness().failedChecks).toBe(1);
    expect((await health()).ready).toBe(true);
    failChecks();
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await health()).ready).toBe(false);
  });
});

describe("base boot admission contract", () => {
  it("keeps API and non-page startup responses unchanged even with degraded DB", async () => {
    bootReady = false;
    failChecks();
    await vi.advanceTimersByTimeAsync(40_000);
    for (const [path, method] of [["/api/work", "GET"], ["/api/auth/nonce", "POST"], ["/other", "POST"]]) {
      const response = await fetch(origin + path, { method });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toEqual({ message: "Server is starting up — please retry shortly" });
    }
    const head = await fetch(origin + "/asset.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(head.headers.get("cache-control")).toBe("no-store");
  });
});
