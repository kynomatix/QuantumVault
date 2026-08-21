// Request-trace middleware unit tests (2026-07-20 stuck-dashboard incident).
//
// Pins the middleware's contract:
//   - only the low-QPS dashboard route set is traced (path matching);
//   - a response that closes BEFORE finishing is reported ABORTED (the
//     signature of a hung/abandoned dashboard read);
//   - the in-flight counter is settled exactly once per request even when
//     both 'finish' and 'close' fire (they always both fire in Node).
//
// appendTelemetry is vitest-guarded (no file writes in tests), so assertions
// use the console mirror (5xx / SLOW / ABORTED lines) and the in-flight
// counter.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";

import {
  isTracedPath,
  registerRequestTrace,
  getInFlightTracedCount,
  __resetRequestTraceForTests,
  __createRequestTraceCollectorForTests,
  __formatRequestTraceSubspansForTests,
  recordRequestSubspan,
  REQUEST_TRACE_SUBSPAN_LABELS,
} from "../../server/request-trace";

type Handler = (req: unknown, res: unknown, next: () => void) => void;

function captureMiddleware(): Handler {
  let handler: Handler | undefined;
  const fakeApp = { use: (h: Handler) => (handler = h) };
  registerRequestTrace(fakeApp as never);
  if (!handler) throw new Error("middleware not registered");
  return handler;
}

function fakeReq(path: string) {
  return { path, method: "GET", query: {}, headers: {} };
}

function fakeRes(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    writableFinished: boolean;
  };
  res.statusCode = statusCode;
  res.writableFinished = false;
  return res;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetRequestTraceForTests();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetRequestTraceForTests();
  logSpy.mockRestore();
});

describe("isTracedPath — dashboard route set only", () => {
  it("traces the core dashboard reads and the telemetry endpoint", () => {
    for (const p of [
      "/api/positions",
      "/api/trading-bots",
      "/api/total-equity",
      "/api/auth/status",
      "/api/auth/session",
      "/api/client-telemetry",
      "/api/ai-trader",
      "/api/ai-trader/bots/7",
    ]) {
      expect(isTracedPath(p), p).toBe(true);
    }
  });

  it("does NOT trace high-QPS or unrelated routes", () => {
    for (const p of [
      "/api/webhook/tradingview/abc",
      "/api/lab/runs",
      "/api/positions/extra", // exact-match set, not prefix
      "/api/ai-traders", // prefix must respect the segment boundary
      "/assets/index-abc.js",
    ]) {
      expect(isTracedPath(p), p).toBe(false);
    }
  });
});

describe("middleware — settle-once + aborted detection", () => {
  it("passes untraced paths straight through without tracking", () => {
    const mw = captureMiddleware();
    const next = vi.fn();
    mw(fakeReq("/api/lab/runs"), fakeRes(200), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getInFlightTracedCount()).toBe(0);
  });

  it("tracks in-flight and settles once on finish (close afterwards is a no-op)", () => {
    const mw = captureMiddleware();
    const res = fakeRes(200);
    mw(fakeReq("/api/positions"), res, vi.fn());
    expect(getInFlightTracedCount()).toBe(1);

    res.writableFinished = true;
    res.emit("finish");
    expect(getInFlightTracedCount()).toBe(0);
    res.emit("close"); // Node always fires close after finish
    expect(getInFlightTracedCount()).toBe(0);
  });

  it("close BEFORE finish → ABORTED mirrored to console", () => {
    const mw = captureMiddleware();
    const res = fakeRes(200);
    mw(fakeReq("/api/trading-bots"), res, vi.fn());

    res.emit("close"); // client went away; writableFinished still false
    expect(getInFlightTracedCount()).toBe(0);
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[ReqTrace]"));
    expect(line).toBeDefined();
    expect(line).toContain("ABORTED");
    expect(line).toContain("/api/trading-bots");
  });

  it("5xx responses mirror to console; 2xx do not", () => {
    const mw = captureMiddleware();

    const ok = fakeRes(200);
    mw(fakeReq("/api/positions"), ok, vi.fn());
    ok.writableFinished = true;
    ok.emit("finish");
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("[ReqTrace]"))).toBe(false);

    const boom = fakeRes(503);
    mw(fakeReq("/api/positions"), boom, vi.fn());
    boom.writableFinished = true;
    boom.emit("finish");
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[ReqTrace]"));
    expect(line).toContain("503");
  });

  it("wallet identity in the trace line is hashed, never the raw address", () => {
    const mw = captureMiddleware();
    const res = fakeRes(500);
    const wallet = "WaLLetActive1111111111111111111111111111111";
    mw({ ...fakeReq("/api/positions"), query: { wallet } }, res, vi.fn());
    res.writableFinished = true;
    res.emit("finish");
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[ReqTrace]"));
    expect(line).toBeDefined();
    expect(line).not.toContain(wallet);
    expect(line).toMatch(/w=[0-9a-f]{8}/);
  });
});

describe("request-scoped subspan collector", () => {
  it("records deterministic fields and derives unattributed time from top-level spans only", () => {
    const harness = __createRequestTraceCollectorForTests();
    harness.run(() => {
      recordRequestSubspan("snapshotDbBotsMs", 90);
      recordRequestSubspan("snapshotWaitMs", 100);
      recordRequestSubspan("snapshotVenueMs", 95);
      recordRequestSubspan("snapshotCreator", 1);
    });
    expect(harness.snapshot()).toEqual({
      snapshotDbBotsMs: 90,
      snapshotWaitMs: 100,
      snapshotVenueMs: 95,
      snapshotCreator: 1,
    });
    expect(harness.settle(140)).toBe(
      " snapshotWaitMs=100 snapshotDbBotsMs=90 snapshotVenueMs=95 snapshotCreator=1 unattributedMs=40",
    );
  });

  it("rejects dynamic, nonfinite, negative, duplicate, and non-one flag values", () => {
    const harness = __createRequestTraceCollectorForTests();
    harness.run(() => {
      recordRequestSubspan("botOwnedLoadMs", 1.6);
      recordRequestSubspan("botOwnedLoadMs", 99);
      recordRequestSubspan("snapshotCreator", 0);
      recordRequestSubspan("snapshotCreator", 1);
      recordRequestSubspan("botDecisionReadMs", Number.NaN);
      recordRequestSubspan("botVenueMarkMs", -1);
      recordRequestSubspan("dynamicSecret" as never, 8);
    });
    expect(harness.snapshot()).toEqual({ botOwnedLoadMs: 2, snapshotCreator: 1 });
  });

  it("seals once and ignores late recorder calls", () => {
    const harness = __createRequestTraceCollectorForTests();
    harness.run(() => recordRequestSubspan("snapshotWaitMs", 10));
    expect(harness.settle(25)).toBe(" snapshotWaitMs=10 unattributedMs=15");
    harness.run(() => recordRequestSubspan("snapshotVenueMs", 20));
    expect(harness.snapshot()).toEqual({ snapshotWaitMs: 10 });
  });

  it("caps formatter output through the pure seam", () => {
    const fields = REQUEST_TRACE_SUBSPAN_LABELS.map((label) => [label, Number.MAX_SAFE_INTEGER] as const);
    const formatted = __formatRequestTraceSubspansForTests(fields, Number.MAX_SAFE_INTEGER, 96);
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(96);
    expect(formatted).toMatch(/^ botOwnedLoadMs=/);
  });

  it("keeps empty collectors byte-identical and isolates overlapping ALS contexts", async () => {
    expect(__createRequestTraceCollectorForTests().settle(50)).toBe("");
    const first = __createRequestTraceCollectorForTests();
    const second = __createRequestTraceCollectorForTests();
    await Promise.all([
      first.run(async () => { await Promise.resolve(); recordRequestSubspan("botOwnedLoadMs", 3); }),
      second.run(async () => { await Promise.resolve(); recordRequestSubspan("snapshotWaitMs", 7); }),
    ]);
    expect(first.snapshot()).toEqual({ botOwnedLoadMs: 3 });
    expect(second.snapshot()).toEqual({ snapshotWaitMs: 7 });
  });
});
