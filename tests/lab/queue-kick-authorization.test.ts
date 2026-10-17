import { createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_PASSWORD = "EXAMPLE";
const LAB_SECRET = "REDACTED";
const API_TOKEN = "CHANGEME";
const routeSource = readFileSync("server/lab/routes.ts", "utf8");
const clientSource = readFileSync("client/src/pages/QuantumLab.tsx", "utf8");

function section(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error("Route fixture boundaries changed");
  return source.slice(start, end);
}
function compile(source: string) {
  return transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
  }).outputText;
}

// Execute production auth, active-worker clearing, startup and route code with seams
// instead of importing the Lab's migrations, scheduler and real worker processes.
const authSource = section(routeSource, "  const authenticateLab =", '  app.get("/api/lab/tickers"');
const clearSource = section(routeSource, "  function clearActiveWorker(", "  let keepAliveTimer");
const startSource = section(routeSource, "  function startOptimizationJob(", "  async function autoRetryAfterCrash");
const kickSource = section(routeSource, "  const requireQueueKickAuth =", "  let schedulerRunning =");

function harness(active = true, starting = false) {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => queueMicrotask(() => worker.emit("exit"))),
    terminate: vi.fn(),
  });
  const makeJob = (id: string, walletAddress: string, runId: number, status: string) => ({
    id, walletAddress, runId, progress: { status }, lastUpdated: Date.now(), abortSignal: { aborted: false },
  });
  const jobs = new Map([
    ["job-a", makeJob("job-a", "wallet-a", 1, "running")],
    ["job-b", makeJob("job-b", "wallet-b", 2, "queued")],
    ["job-c", makeJob("job-c", "wallet-a", 3, "fetching")],
    ["job-d", makeJob("job-d", "wallet-b", 4, "complete")],
  ]);
  const labStorage = {
    jobs, getJob: (id: string) => jobs.get(id),
    pauseRun: vi.fn(async (_id: number) => {}),
    saveCheckpoint: vi.fn(async () => {}),
    forceEvictAllJobs: vi.fn(() => {
      let count = 0;
      for (const job of jobs.values()) if (!["complete", "error"].includes(job.progress.status)) {
        job.progress.status = "error"; count++;
      }
      return count;
    }),
    updateProgress: vi.fn((id: string, progress: { status: string }) => {
      const job = jobs.get(id)!; job.progress = progress; job.lastUpdated = Date.now();
    }),
  };
  // Candle fetching is an in-memory stage of a DB run whose status is running.
  const dbRows = [...jobs.values()].map(job => ({
    id: job.runId, status: job.progress.status === "fetching" ? "running" : job.progress.status,
  }));
  const query = {
    from: vi.fn(() => query), where: vi.fn(() => query),
    limit: vi.fn(async () => [{ id: 1, walletAddress: "wallet-a", tokenHash: createHash("sha256").update(API_TOKEN).digest("hex") }]),
    then: (resolve: (value: any[]) => unknown) => Promise.resolve(dbRows).then(resolve),
  };
  const update = { set: vi.fn(() => update), where: vi.fn(async () => {}) };
  const db = { select: vi.fn(() => query), update: vi.fn(() => update) };
  const runtime = { activeWorker: active ? worker : null, workerStarting: starting, activeJobId: "job-a" as string | null };
  const pumpQueue = vi.fn();
  const stopKeepAlive = vi.fn();
  const createWorkerPool = vi.fn();
  const fetchAllCandles = vi.fn(async (_config: any, _progress: (message: string) => void) => ({}));
  const dependencies = {
    app: { post: (_path: string, ...registered: any[]) => { handlers = registered; } },
    labStorage, db, runtime, pumpQueue, stopKeepAlive, createWorkerPool, fetchAllCandles,
    stopWorkerWatchdog: vi.fn(), stopStartupWatchdog: vi.fn(), startStartupWatchdog: vi.fn(),
    createHash, timingSafeEqual, eq: vi.fn(), userApiTokens: { tokenHash: "EXAMPLE", id: "EXAMPLE" },
    labOptimizationRuns: { id: "EXAMPLE", status: "EXAMPLE" },
  };
  let handlers: any[] = [];
  const control = new Function(...Object.keys(dependencies), compile(`
    let activeWorker = runtime.activeWorker;
    let workerStarting = runtime.workerStarting;
    let activeJobId = runtime.activeJobId;
    let lastWorkerMessageTime = 0;
    let lastRunStartedAt = 0;
    let pumpQueueRunning = true;
    ${clearSource}
    ${authSource}
    ${startSource}
    ${kickSource}
    return {
      getState: () => ({ activeWorker, workerStarting, activeJobId, pumpQueueRunning }),
      setActive: (worker, jobId) => { activeWorker = worker; activeJobId = jobId; workerStarting = false; },
      start: startOptimizationJob,
    };
  `))(...Object.values(dependencies));

  async function request(body: unknown, headers: Record<string, string> = {}, session?: { walletAddress: string }) {
    const req = { body, headers, session };
    const response = {
      locals: {}, statusCode: 200, body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      json(value: any) { this.body = value; return this; },
    };
    expect(handlers).toHaveLength(2);
    for (const handler of handlers) {
      let advanced = false;
      await handler(req, response, () => { advanced = true; });
      if (!advanced) break;
    }
    return response;
  }
  return { worker, jobs, labStorage, db, dbRows, pumpQueue, stopKeepAlive, createWorkerPool, fetchAllCandles, request, ...control };
}

function expectUntouched(h: ReturnType<typeof harness>, statuses = ["running", "queued", "fetching", "complete"]) {
  expect(h.labStorage.pauseRun).not.toHaveBeenCalled();
  expect(h.labStorage.forceEvictAllJobs).not.toHaveBeenCalled();
  expect(h.labStorage.updateProgress).not.toHaveBeenCalled();
  expect(h.worker.postMessage).not.toHaveBeenCalled();
  expect(h.worker.terminate).not.toHaveBeenCalled();
  expect(h.stopKeepAlive).not.toHaveBeenCalled();
  expect(h.pumpQueue).not.toHaveBeenCalled();
  expect(h.getState().pumpQueueRunning).toBe(true);
  expect([...h.jobs.values()].map(job => job.progress.status)).toEqual(statuses);
  expect([...h.jobs.values()].every(job => !job.abortSignal.aborted)).toBe(true);
}
function expectOnlyActivePaused(h: ReturnType<typeof harness>) {
  expect(h.labStorage.pauseRun.mock.calls).toEqual([[1]]);
  expect(h.labStorage.forceEvictAllJobs).not.toHaveBeenCalled();
  expect([...h.jobs.values()].map(job => job.progress.status)).toEqual(["error", "queued", "fetching", "complete"]);
  expect([...h.jobs.values()].map(job => job.abortSignal.aborted)).toEqual([true, false, false, false]);
  expect(h.pumpQueue).toHaveBeenCalledOnce();
}
function clientCall(h: ReturnType<typeof harness>, walletAddress = "wallet-a") {
  const fetch = vi.fn(async (path: string, options: any) => {
    expect(path).toBe("/api/lab/queue/kick");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("include");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    const result = await h.request(JSON.parse(options.body), {}, { walletAddress });
    return { ok: result.statusCode < 400, json: async () => result.body };
  });
  const mutation = section(clientSource, "  const kickQueueMutation = useMutation({", "    onSuccess:");
  const expression = mutation.slice(mutation.indexOf("mutationFn:") + "mutationFn:".length).trim().replace(/,$/, "");
  return new Function("fetch", compile(`return (${expression});`))(fetch);
}

beforeEach(() => {
  vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
  vi.stubEnv("LAB_AUTH_SECRET", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Lab force-kick authorization", () => {
  it("retains admin global recovery without requiring Lab credentials", async () => {
    vi.stubEnv("LAB_AUTH_SECRET", LAB_SECRET);
    vi.stubEnv("ADMIN_PASSWORD", `  ${ADMIN_PASSWORD}  `);
    const h = harness();
    const response = await h.request({ force: true }, { authorization: `Bearer   ${ADMIN_PASSWORD}  ` });
    expect(response.statusCode).toBe(200);
    expect(response.body.force).toBe(true);
    expect(h.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "abort" });
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(h.labStorage.pauseRun.mock.calls).toEqual([[1], [2], [3]]);
    expect(h.labStorage.forceEvictAllJobs).toHaveBeenCalledOnce();
    expect(h.pumpQueue).toHaveBeenCalledOnce();
    expect(h.getState()).toMatchObject({ activeWorker: null, activeJobId: null, pumpQueueRunning: false });
    expect(console.log).toHaveBeenCalledWith("[QuantumLab] Platform admin force queue kick authorized");
  });

  it.each(["session", "trusted headers", "API token"])("allows %s Lab auth to stop only its own healthy active run", async kind => {
    const h = harness();
    let headers: Record<string, string> = {};
    let session: { walletAddress: string } | undefined = { walletAddress: "wallet-a" };
    if (kind === "trusted headers") {
      vi.stubEnv("LAB_AUTH_SECRET", LAB_SECRET);
      headers = { "x-lab-auth": LAB_SECRET, "x-lab-wallet": "wallet-a" }; session = undefined;
    } else if (kind === "API token") {
      headers = { authorization: `Bearer ${API_TOKEN}` }; session = undefined;
    }
    expect((await h.request({ force: true }, headers, session)).statusCode).toBe(200);
    expectOnlyActivePaused(h);
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith("[QuantumLab] User force queue kick authorized (run=1, reason=owner)");
  });

  it.each([240_000, 300_000])("allows another user's server-stale active run at age %i, preserving all other jobs", async age => {
    const h = harness(); h.jobs.get("job-a")!.lastUpdated = Date.now() - age;
    expect((await h.request({ force: true }, {}, { walletAddress: "wallet-b" })).statusCode).toBe(200);
    expectOnlyActivePaused(h);
    expect(console.log).toHaveBeenCalledWith("[QuantumLab] User force queue kick authorized (run=1, reason=server-stale)");
  });

  it.each([0, 239_999])("rejects another user's healthy active run at age %i before finally", async age => {
    const h = harness(); h.jobs.get("job-a")!.lastUpdated = Date.now() - age;
    expect((await h.request({ force: true }, {}, { walletAddress: "wallet-b" })).statusCode).toBe(403);
    expectUntouched(h);
    expect(h.getState().activeWorker).toBe(h.worker);
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it.each([undefined, null, NaN, 0, Infinity])("fails closed when server progress time is unknown: %s", async lastUpdated => {
    const h = harness(); (h.jobs.get("job-a") as any).lastUpdated = lastUpdated;
    expect((await h.request({ force: true, lastHeartbeat: 1, runId: 2, walletAddress: "wallet-a" }, {}, { walletAddress: "wallet-b" })).statusCode).toBe(403);
    expectUntouched(h);
  });

  it.each(["complete", "error", "missing run", "missing active", "no worker", "future timestamp"])("rejects invalid active state: %s", async condition => {
    const h = harness();
    if (["complete", "error"].includes(condition)) h.jobs.get("job-a")!.progress.status = condition;
    if (condition === "missing run") (h.jobs.get("job-a") as any).runId = undefined;
    if (condition === "missing active") h.setActive(h.worker, "missing");
    if (condition === "no worker") h.setActive(null, "job-a");
    if (condition === "future timestamp") h.jobs.get("job-a")!.lastUpdated = Date.now() + 300_000;
    const statuses = [...h.jobs.values()].map(job => job.progress.status);
    expect((await h.request({ force: true }, {}, { walletAddress: "wallet-b" })).statusCode).toBe(403);
    expectUntouched(h, statuses);
  });

  it.each(["missing identity", "wrong secret", "missing wallet", "wrong bearer", "malformed bearer"])("rejects %s with 403 and no queue mutations", async kind => {
    const h = harness();
    let headers: Record<string, string> = {};
    if (kind === "wrong secret" || kind === "missing wallet") {
      vi.stubEnv("LAB_AUTH_SECRET", LAB_SECRET);
      headers = kind === "missing wallet" ? { "x-lab-auth": LAB_SECRET } : { "x-lab-auth": "EXAMPLE", "x-lab-wallet": "wallet-a" };
    } else if (kind === "wrong bearer") {
      headers = { authorization: "Bearer REDACTED" };
      // An actual database lookup miss, rather than the harness's valid token row.
      h.db.select().limit.mockResolvedValueOnce([]);
    } else if (kind === "malformed bearer") headers = { authorization: `Basic ${ADMIN_PASSWORD}` };
    const response = await h.request({ force: true }, headers);
    expect(response.statusCode).toBe(403);
    expect(response.body.error).toBe("Force stop requires an authenticated Lab user or platform admin");
    expectUntouched(h);
    expect(console.warn).toHaveBeenCalledWith("[QuantumLab] Refused force queue kick: Lab authentication required");
  });

  it.each([undefined, "", "   "])("keeps Lab own-run recovery available without configured admin password: %s", async password => {
    if (password === undefined) delete process.env.ADMIN_PASSWORD;
    else vi.stubEnv("ADMIN_PASSWORD", password);
    const h = harness();
    expect((await h.request({ force: true }, {}, { walletAddress: "wallet-a" })).statusCode).toBe(200);
    expectOnlyActivePaused(h);
  });

  it("logs decisions without credentials", async () => {
    const h = harness(); await h.request({ force: true }, { authorization: `Bearer ${ADMIN_PASSWORD}` });
    await harness().request({ force: true }, {}, { walletAddress: "wallet-b" });
    const logs = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().join(" ");
    for (const credential of [ADMIN_PASSWORD, API_TOKEN, LAB_SECRET]) expect(logs).not.toContain(credential);
  });

  it("does not clear or terminate a successor worker while waiting for the old one", async () => {
    const h = harness();
    const successor = { terminate: vi.fn() };
    h.worker.postMessage.mockImplementationOnce(() => queueMicrotask(() => {
      h.setActive(successor, "job-c"); h.worker.emit("exit");
    }));
    expect((await h.request({ force: true }, {}, { walletAddress: "wallet-a" })).statusCode).toBe(200);
    expectOnlyActivePaused(h);
    expect(h.getState().activeWorker).toBe(successor);
    expect(h.getState().activeJobId).toBe("job-c");
    expect(successor.terminate).not.toHaveBeenCalled();
    expect(h.stopKeepAlive).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("cancels stalled startup safely when candle fetching later %ss", async outcome => {
    const h = harness(false);
    let finish!: (value: any) => void;
    const pending = new Promise<any>((resolve, reject) => { finish = outcome === "resolve" ? resolve : reject; });
    h.fetchAllCandles.mockReturnValueOnce(pending);
    h.start({}, h.jobs.get("job-a"), 1);
    await Promise.resolve(); await Promise.resolve();
    expect(h.fetchAllCandles).toHaveBeenCalledOnce();
    expect((await h.request({ force: true }, {}, { walletAddress: "wallet-a" })).statusCode).toBe(200);
    expectOnlyActivePaused(h);
    const successor = {};
    h.setActive(successor, "job-c");
    finish(outcome === "resolve" ? {} : new Error("fetch failed"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.createWorkerPool).not.toHaveBeenCalled();
    expect(h.getState().activeWorker).toBe(successor);
    expect(h.labStorage.pauseRun.mock.calls).toEqual([[1]]);
  });

  it("uses the UI heartbeat threshold and the existing server progress clock", () => {
    expect(clientSource).toContain("heartbeatAge > 240_000");
    expect(clientSource).toContain("runAge > 300_000");
    const storageSource = readFileSync("server/lab/storage.ts", "utf8");
    const updateProgress = section(storageSource, "  updateProgress(id: string, progress: LabJobProgress): void {", "  setResults(id:");
    expect(updateProgress).toContain("job.lastUpdated = Date.now()");
  });

  it("retains ordinary orphan cleanup and preserves live jobs", async () => {
    const h = harness(false); h.dbRows[3].status = "failed"; h.jobs.get("job-d")!.progress.status = "running";
    const response = await h.request({ force: false }, {}, { walletAddress: "wallet-b" });
    expect(response.statusCode).toBe(200); expect(response.body.force).toBe(false);
    expect([...h.jobs.values()].map(job => job.progress.status)).toEqual(["running", "queued", "fetching", "error"]);
    expect(h.labStorage.pauseRun).not.toHaveBeenCalled();
    expect(h.labStorage.forceEvictAllJobs).not.toHaveBeenCalled();
    expect(h.worker.terminate).not.toHaveBeenCalled(); expect(h.pumpQueue).toHaveBeenCalledOnce();
  });

  it.each([undefined, false, "true", 1, null])("keeps force=%s on the ordinary authenticated path", async force => {
    const h = harness(); const response = await h.request({ force }, {}, { walletAddress: "wallet-b" });
    expect(response.statusCode).toBe(200); expect(response.body.force).toBe(false);
    expect(h.labStorage.pauseRun).not.toHaveBeenCalled(); expect(h.worker.postMessage).not.toHaveBeenCalled();
    expect(h.pumpQueue).toHaveBeenCalledOnce();
  });

  it("still requires Lab authentication on an ordinary kick", async () => {
    const h = harness(); expect((await h.request({ force: false })).statusCode).toBe(401); expectUntouched(h);
  });

  it("preserves trusted-header and API-token ordinary kicks", async () => {
    vi.stubEnv("LAB_AUTH_SECRET", LAB_SECRET);
    expect((await harness().request({}, { "x-lab-auth": LAB_SECRET, "x-lab-wallet": "wallet-a" })).statusCode).toBe(200);
    vi.stubEnv("LAB_AUTH_SECRET", "");
    expect((await harness().request({}, { authorization: `Bearer ${API_TOKEN}` })).statusCode).toBe(200);
  });

  it("runs the existing client call shape for ordinary kicks and own-run force", async () => {
    const h = harness(); const call = clientCall(h);
    expect(await call()).toMatchObject({ success: true, force: false });
    expect(await call(false)).toMatchObject({ success: true, force: false });
    expect(await call(true)).toMatchObject({ success: true, force: true });
    expect(h.labStorage.pauseRun.mock.calls).toEqual([[1]]);
  });

  it("runs the client stale recovery and surfaces healthy-run refusal", async () => {
    const healthy = harness(); await expect(clientCall(healthy, "wallet-b")(true)).rejects.toThrow("your active run or a stale active run");
    expectUntouched(healthy);
    const stale = harness(); stale.jobs.get("job-a")!.lastUpdated = Date.now() - 240_001;
    expect(await clientCall(stale, "wallet-b")(true)).toMatchObject({ success: true, force: true });
    expectOnlyActivePaused(stale);
  });
});
