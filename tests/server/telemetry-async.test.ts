/**
 * TELEM-ASYNC-01 — async-queue writer tests.
 *
 * These tests exercise the queue, drainer, rotation, bounds, recovery, flush,
 * VITEST guard, no-throw contract, and cross-process line-integrity invariant
 * introduced in the server/telemetry.ts rewrite.
 *
 * All tests use a per-test tmpdir (via __setLogPathsForTests) so the live
 * logs/telemetry.log is never touched.  appendTelemetry itself is a VITEST
 * no-op; __appendForTests bypasses the guard to exercise queue mechanics.
 *
 * afterEach design: vi.restoreAllMocks() then __resetTelemetryForTests()
 * (which increments the drainer generation) is called BEFORE any flush, so
 * stale drainers from previous tests become inert and cannot resolve flush
 * resolvers that belong to the next test.  No flushTelemetry in afterEach —
 * each test that needs a flush does it within the test itself before reading.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import {
  appendTelemetry,
  appendTelemetrySync,
  flushTelemetry,
  __resetTelemetryForTests,
  __getTelemetryStateForTests,
  __setLogPathsForTests,
  __resetLogPathsForTests,
  __appendForTests,
  __appendSyncForTests,
  __setMaxBytesForTests,
  __resetMaxBytesForTests,
  __setQueueBoundsForTests,
  __resetQueueBoundsForTests,
} from "../../server/telemetry";

let tmpDir: string;
let logFile: string;
let rotatedFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "telem-test-"));
  logFile = path.join(tmpDir, "telemetry.log");
  rotatedFile = path.join(tmpDir, "telemetry.log.1");
  __resetTelemetryForTests();
  __setLogPathsForTests(tmpDir, logFile, rotatedFile);
});

afterEach(() => {
  // Restore mocks first, then reset state (increments generation → stale
  // drainers become inert).  No flushTelemetry here — each test flushes itself.
  vi.restoreAllMocks();
  __resetTelemetryForTests();
  __resetLogPathsForTests();
  __resetMaxBytesForTests();
  __resetQueueBoundsForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: ORDERING ─────────────────────────────────────────────────────────

describe("ORDERING — enqueue order is preserved in the output file", () => {
  it("five lines appear in the file in the exact order they were enqueued", async () => {
    const lines = ["line-A", "line-B", "line-C", "line-D", "line-E"];
    for (const l of lines) __appendForTests(l);
    await flushTelemetry(5000);

    const content = fs.readFileSync(logFile, "utf8");
    const written = content.trim().split("\n");
    expect(written).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i++) {
      expect(written[i]).toContain(lines[i]);
    }
    // Verify timestamps are non-decreasing (wall-clock order preserved).
    const ts = written.map((l) => l.slice(0, 24));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i] >= ts[i - 1]).toBe(true);
    }
  });
});

// ── Test 2: NO TORN LINES ─────────────────────────────────────────────────────

describe("NO TORN LINES — output contains only whole, well-formed lines", () => {
  it("200 lines enqueued in burst produce only complete lines in the file", async () => {
    for (let i = 0; i < 200; i++) __appendForTests(`msg-${i}`);
    await flushTelemetry(10_000);

    const content = fs.readFileSync(logFile, "utf8");
    // File must end with exactly one newline.
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Each line must start with an ISO-8601 timestamp (written at enqueue time).
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      // No embedded newline or carriage-return inside a line.
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\r");
    }
  });
});

// ── Test 3: ROTATION ─────────────────────────────────────────────────────────

describe("ROTATION — file rotates at MAX_BYTES with no line loss", () => {
  it("rotates to .log.1 and continues writing; all accepted lines survive", async () => {
    // Use a small cap.  Rotation check fires BEFORE each write batch: if
    // the file is already at/over _maxBytes from a prior write, it rotates.
    // Therefore rotation requires at least two separate write batches:
    //   Batch 1 → file grows past cap.
    //   Batch 2 → stat sees overfull file → rotate → write to fresh file.
    __setMaxBytesForTests(200);

    // Batch 1: one line ~130 bytes (timestamp 24 + space 1 + 100 content + 1 newline).
    // After flush the file is ~126 bytes (< 200 → no rotation yet).
    __appendForTests("a".repeat(100));
    await flushTelemetry(3000);

    // Batch 2: another line.  Stat sees ~126 bytes < 200 → no rotation.
    // File grows to ~252 bytes total after this write.
    __appendForTests("b".repeat(100));
    await flushTelemetry(3000);

    // Batch 3: stat now sees ~252 bytes ≥ 200 → rename to .log.1 → write fresh.
    __appendForTests("c".repeat(10));
    await flushTelemetry(3000);

    expect(fs.existsSync(rotatedFile)).toBe(true);
    expect(fs.existsSync(logFile)).toBe(true);

    // Every accepted line must appear in one of the two files.
    const current = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const rotated = fs.existsSync(rotatedFile) ? fs.readFileSync(rotatedFile, "utf8") : "";
    const allContent = rotated + current;
    expect(allContent).toContain("a".repeat(100));
    expect(allContent).toContain("b".repeat(100));
    expect(allContent).toContain("c".repeat(10));

    // All physical lines must still be whole (no torn lines across the rotation boundary).
    const allLines = allContent.split("\n").filter((l) => l.length > 0);
    for (const line of allLines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
  });
});

// ── Test 4: QUEUE BOUNDS ─────────────────────────────────────────────────────

describe("QUEUE BOUNDS — overflow drops and does not grow memory unbounded", () => {
  it("droppedLines increments for overflow; queue stays at or below MAX_QUEUE_LINES", () => {
    // MAX_QUEUE_LINES = 5.  Push one line first — the drainer starts and
    // synchronously takes it (queue.splice(0)) before yielding at the first
    // await (fs.promises.mkdir).  All subsequent synchronous pushes land in
    // the queue while the drainer is suspended at that first await.
    __setQueueBoundsForTests(5, 999_999);
    __appendForTests("first"); // drainer takes this one synchronously, queue→[]

    // Push 100 more — all synchronous, all before the drainer's mkdir resolves.
    // Lines 1–5 fill the queue to max; lines 6–100 (95 lines) are dropped.
    for (let i = 0; i < 100; i++) __appendForTests(`overflow-${i}`);

    const state = __getTelemetryStateForTests();
    expect(state.queueLength).toBeLessThanOrEqual(5);
    expect(state.droppedLines).toBe(95);
  });
});

// ── Test 5: DROPPED COUNTER + RECOVERY ───────────────────────────────────────

describe("DROPPED COUNTER + RECOVERY — one summary line emits after recovery", () => {
  it("droppedLines is accurate; exactly one recovery summary is written", async () => {
    __setQueueBoundsForTests(3, 999_999);

    // First appendFile call rejects; subsequent calls use the real fs.
    // Capture the real appendFile BEFORE the spy wraps it so the fallback
    // implementation calls through to the actual fs, not the spy itself.
    const realAppendFile = fs.promises.appendFile;
    let failCallCount = 0;
    vi.spyOn(fs.promises, "appendFile").mockImplementation(
      async function (
        this: unknown,
        ...args: Parameters<typeof fs.promises.appendFile>
      ) {
        if (failCallCount < 1) {
          failCallCount++;
          throw new Error("mock disk full");
        }
        return (realAppendFile as Function).apply(fs.promises, args);
      },
    );

    // Push first line → drainer starts, takes it synchronously, yields at mkdir.
    __appendForTests("r-line1");
    // Synchronously fill the queue while the drainer is suspended.
    // (r-line1 was taken from the queue, so there is room for 3 more)
    __appendForTests("r-line2"); // queue=[r2] (1/3)
    __appendForTests("r-line3"); // queue=[r2,r3] (2/3)
    __appendForTests("r-line4"); // queue=[r2,r3,r4] (3/3 — at max)
    __appendForTests("r-line5"); // queue full → DROPPED → droppedLines=1

    // Wait past the 200ms retry backoff so the drainer can succeed on retry.
    await new Promise<void>((r) => setTimeout(r, 600));
    await flushTelemetry(5000);

    const state = __getTelemetryStateForTests();
    expect(state.droppedLines).toBeGreaterThan(0);

    // File must contain exactly one recovery summary.
    const content = fs.readFileSync(logFile, "utf8");
    const recoveryLines = content
      .split("\n")
      .filter((l) => l.includes("[Telemetry] writer recovered"));
    expect(recoveryLines).toHaveLength(1);
    // failures=N where N ≥ 1
    expect(recoveryLines[0]).toMatch(/failures=[1-9]\d*/);
    expect(recoveryLines[0]).toMatch(/dropped=\d+/);
  });
});

// ── Test 6: EXIT PATH ────────────────────────────────────────────────────────

describe("EXIT PATH — appendTelemetrySync is independent of the async queue", () => {
  it("sync write is immediate and leaves the queue untouched", async () => {
    // __appendSyncForTests bypasses the VITEST guard for the synchronous path,
    // simulating the process.on('exit') call in a test environment.
    __appendSyncForTests("sync-exit-marker");

    // File must be written synchronously before this assertion.
    expect(fs.existsSync(logFile)).toBe(true);
    const immediate = fs.readFileSync(logFile, "utf8");
    expect(immediate).toContain("sync-exit-marker");
    expect(immediate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z sync-exit-marker\n$/);

    // Queue must be untouched by the sync write.
    const state = __getTelemetryStateForTests();
    expect(state.queueLength).toBe(0);
    expect(state.drainerRunning).toBe(false);

    // Async queue still works alongside the sync writer.
    __appendForTests("async-alongside");
    await flushTelemetry(5000);

    const after = fs.readFileSync(logFile, "utf8");
    expect(after).toContain("sync-exit-marker");
    expect(after).toContain("async-alongside");

    // Both lines must be whole (no tearing at the sync/async boundary).
    const lines = after.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
  });

  it("appendTelemetrySync (production guard) is a no-op under VITEST", () => {
    // The production export has a VITEST guard — must not write in tests.
    appendTelemetrySync("should-be-suppressed");
    expect(fs.existsSync(logFile)).toBe(false);
  });
});

// ── Test 7: FLUSH ─────────────────────────────────────────────────────────────

describe("FLUSH — flushTelemetry resolves correctly in both healthy and stalled states", () => {
  it("resolves immediately when the queue is already empty", async () => {
    const t0 = Date.now();
    await flushTelemetry(2000);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("resolves within timeoutMs when the fs promise stalls indefinitely", async () => {
    // Make appendFile hang forever so the drainer never finishes on its own.
    vi.spyOn(fs.promises, "appendFile").mockImplementation(
      () => new Promise<void>(() => {}),
    );

    __appendForTests("stall-line");

    const t0 = Date.now();
    await flushTelemetry(300); // 300 ms budget
    const elapsed = Date.now() - t0;

    // Must resolve without hanging (well under 2 s).
    expect(elapsed).toBeLessThan(2000);
    // Must have waited close to the budget (not resolved instantly).
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });
});

// ── Test 8: VITEST GUARD ─────────────────────────────────────────────────────

describe("VITEST GUARD — appendTelemetry is a no-op under the test runner", () => {
  it("does not enqueue, does not touch the file, drainer stays idle", () => {
    // process.env.VITEST is set by the vitest runner.
    expect(process.env.VITEST).toBeTruthy();

    appendTelemetry("should-be-suppressed");

    const state = __getTelemetryStateForTests();
    expect(state.queueLength).toBe(0);
    expect(state.drainerRunning).toBe(false);
    expect(fs.existsSync(logFile)).toBe(false);
  });
});

// ── Test 9: NO THROW ─────────────────────────────────────────────────────────

describe("NO THROW — telemetry swallows all errors regardless of fs state", () => {
  it("__appendForTests (async path) never throws even if the directory is unwritable", () => {
    __setLogPathsForTests(
      "/root/no-permission/telem",
      "/root/no-permission/telem/tel.log",
      "/root/no-permission/telem/tel.log.1",
    );
    // The function must return without throwing; the drainer will fail silently.
    expect(() => {
      __appendForTests("should-not-throw");
    }).not.toThrow();
    // afterEach's __resetTelemetryForTests() increments the generation so the
    // stuck retry-drainer becomes inert and cannot interfere with later tests.
  });

  it("appendTelemetrySync (via __appendSyncForTests) never throws if directory is unwritable", () => {
    __setLogPathsForTests(
      "/root/no-permission/telem",
      "/root/no-permission/telem/tel.log",
      "/root/no-permission/telem/tel.log.1",
    );
    expect(() => {
      __appendSyncForTests("sync-no-throw");
    }).not.toThrow();
  });
});

// ── Test 10: CROSS-PROCESS INTEGRITY ─────────────────────────────────────────

describe("CROSS-PROCESS INTEGRITY — each enqueued line is an atomic physical line", () => {
  it("one enqueued line produces one complete line under the 4KB O_APPEND boundary", async () => {
    const CONTENT = "cross-process-integrity-check";
    __appendForTests(CONTENT);
    await flushTelemetry(5000);

    const content = fs.readFileSync(logFile, "utf8");

    // File must end with a newline (well-formed for O_APPEND appenders).
    expect(content.endsWith("\n")).toBe(true);

    // All physical lines must be whole (no torn / embedded newlines).
    const allLines = content.split("\n").filter((l) => l.length > 0);
    for (const l of allLines) {
      expect(l).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(l).not.toContain("\r");
    }

    // The content we pushed must appear in exactly one line (not split or duplicated).
    const matching = allLines.filter((l) => l.includes(CONTENT));
    expect(matching).toHaveLength(1);

    const line = matching[0];

    // Must be under the POSIX O_APPEND atomic write boundary (4096 bytes).
    // Individual lines well under 4KB ensure concurrent multi-PID appends
    // (main server + Lab child) cannot interleave within a single line.
    const byteLen = Buffer.byteLength(line + "\n", "utf8");
    expect(byteLen).toBeLessThan(4096);
  });

  it("many enqueued lines are each whole lines; batch write does not split any entry", async () => {
    const count = 50;
    for (let i = 0; i < count; i++) __appendForTests(`batch-line-${i}`);
    await flushTelemetry(5000);

    const content = fs.readFileSync(logFile, "utf8");
    expect(content.endsWith("\n")).toBe(true);

    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(count);

    for (const line of lines) {
      // Every line must start with a timestamp and be individually under 4KB.
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(Buffer.byteLength(line + "\n", "utf8")).toBeLessThan(4096);
    }
  });
});
