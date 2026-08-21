import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendTelemetry: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../server/telemetry", () => ({
  appendTelemetry: mocks.appendTelemetry,
}));

vi.mock("../../server/boot-id", () => ({
  SERVER_BOOT_ID: "A1B2C3D4-1111-2222-3333-444455556666",
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  unlinkSync: mocks.unlinkSync,
}));

type MockChild = EventEmitter & {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

const READINESS_FAILED =
  "[LabSupervisor] health event=readiness_poll_failed reason=timeout boot=a1b2c3d4";
const RESTART_SUSPENDED =
  "[LabSupervisor] health event=restart_suspended reason=failure_threshold boot=a1b2c3d4";
const HEALTHY_RESOLUTION =
  "[LabSupervisor] health event=healthy_resolution reason=terminal_state_cleared boot=a1b2c3d4";

describe("LabSupervisor durable terminal-health telemetry", () => {
  const children: MockChild[] = [];
  let supervisor: Awaited<ReturnType<typeof makeSupervisor>> | null = null;

  async function makeSupervisor() {
    const { createLabSupervisor } = await import("../../server/lab/supervisor");
    return createLabSupervisor();
  }

  function latestChild(): MockChild {
    const child = children.at(-1);
    if (!child) throw new Error("expected a spawned child");
    return child;
  }

  async function beginStart() {
    if (!supervisor) throw new Error("supervisor not initialized");
    const promise = supervisor.start();
    const outcome = promise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    return { promise, outcome, child: latestChild() };
  }

  async function failImmediately() {
    const { promise, child } = await beginStart();
    void promise.catch(() => undefined);
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    return child;
  }

  async function failBoundedReadinessPoll() {
    const started = await beginStart();
    await vi.advanceTimersByTimeAsync(300_001);
    const outcome = await started.outcome;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toEqual(new Error("Lab child process health poll timeout"));
    }
    return started.child;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubEnv("SESSION_SECRET", "lab-supervisor-test-secret");
    children.length = 0;
    mocks.appendTelemetry.mockReset();
    mocks.existsSync.mockReset().mockReturnValue(false);
    mocks.readFileSync.mockReset();
    mocks.writeFileSync.mockReset();
    mocks.unlinkSync.mockReset();
    mocks.fetch.mockReset().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mocks.fetch);
    let nextPid = 4100;
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = new EventEmitter() as MockChild;
      child.pid = nextPid++;
      child.unref = vi.fn();
      child.disconnect = vi.fn();
      child.kill = vi.fn(() => true);
      children.push(child);
      return child;
    });
    supervisor = await makeSupervisor();
  });

  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits one sanitized terminal readiness failure after the bounded poll expires", async () => {
    const child = await failBoundedReadinessPoll();

    expect(mocks.fetch).toHaveBeenCalledTimes(36);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(mocks.appendTelemetry.mock.calls).toEqual([[READINESS_FAILED]]);
    expect(supervisor?.getStatus()).toMatchObject({ consecutiveFailures: 1, suspended: false });
  });

  it("emits restart suspension only on entry and preserves the cooldown lifecycle", async () => {
    let thresholdChild: MockChild | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      thresholdChild = await failImmediately();
    }

    expect(supervisor?.getStatus()).toMatchObject({ consecutiveFailures: 8, suspended: true });
    expect(mocks.appendTelemetry.mock.calls).toEqual([[RESTART_SUSPENDED]]);

    thresholdChild?.emit("exit", 1, null);
    expect(mocks.appendTelemetry.mock.calls).toEqual([[RESTART_SUSPENDED]]);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(supervisor?.getStatus()).toMatchObject({ consecutiveFailures: 0, suspended: false });
    expect(children).toHaveLength(9);
  });

  it("emits one resolution only after a durable terminal state", async () => {
    await failBoundedReadinessPoll();

    const recovered = await beginStart();
    recovered.child.emit("message", { type: "ready", port: 5050 });
    await expect(recovered.promise).resolves.toBeUndefined();
    recovered.child.emit("message", { type: "ready", port: 5050 });

    expect(mocks.appendTelemetry.mock.calls).toEqual([
      [READINESS_FAILED],
      [HEALTHY_RESOLUTION],
    ]);

    const cleanSupervisor = await makeSupervisor();
    supervisor = cleanSupervisor;
    const initiallyReady = await beginStart();
    initiallyReady.child.emit("message", { type: "ready", port: 5050 });
    await expect(initiallyReady.promise).resolves.toBeUndefined();
    expect(mocks.appendTelemetry.mock.calls).toEqual([
      [READINESS_FAILED],
      [HEALTHY_RESOLUTION],
    ]);
  });

  it("emits resolution when periodic health reachability returns without a respawn", async () => {
    const initial = await beginStart();
    initial.child.emit("message", { type: "ready", port: 5050 });
    await initial.promise;

    for (let attempt = 0; attempt < 8; attempt++) {
      await failImmediately();
    }
    expect(mocks.appendTelemetry.mock.calls).toEqual([[RESTART_SUSPENDED]]);

    mocks.fetch.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.appendTelemetry.mock.calls).toEqual([
      [RESTART_SUSPENDED],
      [HEALTHY_RESOLUTION],
    ]);
  });

  it("does not emit resolution when restart suspension lifts without a successful probe", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await failImmediately();
    }

    await vi.advanceTimersByTimeAsync(300_000);

    expect(mocks.appendTelemetry.mock.calls).toEqual([[RESTART_SUSPENDED]]);
    expect(supervisor?.getStatus().suspended).toBe(false);
  });

  it("emits readiness failure before suspension when the terminal poll crosses the threshold", async () => {
    for (let attempt = 0; attempt < 7; attempt++) {
      await failImmediately();
    }

    const thresholdChild = await failBoundedReadinessPoll();
    thresholdChild.emit("exit", 1, null);

    expect(mocks.appendTelemetry.mock.calls).toEqual([
      [READINESS_FAILED],
      [RESTART_SUSPENDED],
    ]);
    expect(supervisor?.getStatus().suspended).toBe(true);
  });

  it("telemetry failure never changes readiness rejection suspension or restart behavior", async () => {
    mocks.appendTelemetry.mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });

    const child = await failBoundedReadinessPoll();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(supervisor?.getStatus()).toMatchObject({
      isReady: false,
      consecutiveFailures: 1,
      suspended: false,
    });
  });
});
