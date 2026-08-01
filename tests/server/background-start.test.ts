import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendTelemetryMock, recordCriticalErrorMock } = vi.hoisted(() => ({
  appendTelemetryMock: vi.fn(),
  recordCriticalErrorMock: vi.fn(),
}));

vi.mock("../../server/telemetry", () => ({
  appendTelemetry: appendTelemetryMock,
}));

vi.mock("../../server/error-log", () => ({
  recordCriticalError: recordCriticalErrorMock,
}));

import { startObservedBackgroundComponent } from "../../server/background-start";

const successInput = () => ({
  component: "ai-trader-monitor" as const,
  announce: vi.fn(),
  loadAndStart: vi.fn(async () => {}),
});
beforeEach(() => {
  appendTelemetryMock.mockReset();
  recordCriticalErrorMock.mockReset();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("startObservedBackgroundComponent", () => {
  it("reports a rejecting beforeStart and never announces or loads", async () => {
    const caught = Object.assign(new Error("Bearer qv_live_do_not_persist"), {
      code: "ECONNREFUSED",
    });
    const beforeStart = vi.fn(async () => {
      throw caught;
    });
    const announce = vi.fn();
    const loadAndStart = vi.fn(async () => {});

    await expect(startObservedBackgroundComponent({
      component: "ai-trader-monitor",
      beforeStart,
      announce,
      loadAndStart,
    })).resolves.toBeUndefined();

    expect(beforeStart).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
    expect(loadAndStart).not.toHaveBeenCalled();
    expect(appendTelemetryMock).toHaveBeenCalledWith(
      "[Startup] ai-trader-monitor failed to start failure=db_connection",
    );
    expect(recordCriticalErrorMock).toHaveBeenCalledWith({
      category: "crash",
      severity: "error",
      source: "ai-trader-monitor-startup",
      message: "ai-trader-monitor failed to start",
      context: { failureClass: "db_connection" },
    });
  });

  it("reports an announcement throw and does not load", async () => {
    const announce = vi.fn(() => {
      throw new TypeError("announcement detail must not persist");
    });
    const loadAndStart = vi.fn(async () => {});

    await expect(startObservedBackgroundComponent({
      component: "scanner",
      announce,
      loadAndStart,
    })).resolves.toBeUndefined();

    expect(loadAndStart).not.toHaveBeenCalled();
    expect(appendTelemetryMock).toHaveBeenCalledWith(
      "[Startup] scanner failed to start failure=type_error",
    );
  });

  it("reports a rejected dynamic load without retrying", async () => {
    const input = successInput();
    input.loadAndStart.mockRejectedValueOnce(Object.assign(new Error("private module path"), {
      code: "ERR_MODULE_NOT_FOUND",
    }));

    await expect(startObservedBackgroundComponent(input)).resolves.toBeUndefined();

    expect(input.announce).toHaveBeenCalledTimes(1);
    expect(input.loadAndStart).toHaveBeenCalledTimes(1);
    expect(appendTelemetryMock).toHaveBeenCalledWith(
      "[Startup] ai-trader-monitor failed to start failure=module_not_found",
    );
  });

  it("reports a synchronous start throw without retrying", async () => {
    const announce = vi.fn();
    const loadAndStart = vi.fn(() => {
      throw new RangeError("private range detail");
    });

    await expect(startObservedBackgroundComponent({
      component: "scanner",
      announce,
      loadAndStart,
    })).resolves.toBeUndefined();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(loadAndStart).toHaveBeenCalledTimes(1);
    expect(appendTelemetryMock).toHaveBeenCalledWith(
      "[Startup] scanner failed to start failure=range_error",
    );
  });

  it("preserves successful ordering and starts exactly once", async () => {
    const order: string[] = [];
    const beforeStart = vi.fn(async () => { order.push("before"); });
    const announce = vi.fn(() => { order.push("announce"); });
    const loadAndStart = vi.fn(async () => { order.push("start"); });

    await startObservedBackgroundComponent({
      component: "ai-trader-monitor",
      beforeStart,
      announce,
      loadAndStart,
    });

    expect(order).toEqual(["before", "announce", "start"]);
    expect(beforeStart).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(loadAndStart).toHaveBeenCalledTimes(1);
    expect(appendTelemetryMock).not.toHaveBeenCalled();
    expect(recordCriticalErrorMock).not.toHaveBeenCalled();
  });

  it.each([
    ["module_not_found", { code: "ERR_MODULE_NOT_FOUND" }],
    ["timeout", { name: "TimeoutError" }],
    ["timeout", { code: "ETIMEDOUT" }],
    ["type_error", new TypeError("private")],
    ["range_error", new RangeError("private")],
    ["db_connection", { code: "EPIPE" }],
    ["db_connection", { code: "08006" }],
    ["other", { code: "not-closed-enum", message: "private" }],
  ] as const)("classifies %s from closed structural fields", async (failureClass, failure) => {
    const input = successInput();
    input.loadAndStart.mockRejectedValueOnce(failure);

    await startObservedBackgroundComponent(input);

    expect(recordCriticalErrorMock).toHaveBeenCalledWith(expect.objectContaining({
      context: { failureClass },
    }));
  });

  it("persists no raw error text or reversible derivative", async () => {
    const raw = "Bearer qv_live_do_not_persist";
    const caught = Object.assign(new Error(raw), { code: "ETIMEDOUT", url: raw });
    const input = successInput();
    input.loadAndStart.mockRejectedValueOnce(caught);

    await startObservedBackgroundComponent(input);

    const persisted = JSON.stringify([
      vi.mocked(console.error).mock.calls,
      appendTelemetryMock.mock.calls,
      recordCriticalErrorMock.mock.calls,
    ]);
    const derivatives = [
      raw,
      Buffer.from(raw, "utf8").toString("base64"),
      Buffer.from(raw, "utf8").toString("hex"),
      encodeURIComponent(raw),
    ];
    for (const derivative of derivatives) expect(persisted).not.toContain(derivative);
  });

  it("classifies a revoked object as other without letting reflection escape", async () => {
    const input = successInput();
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    input.loadAndStart.mockRejectedValueOnce(revocable.proxy);

    await expect(startObservedBackgroundComponent(input)).resolves.toBeUndefined();

    expect(recordCriticalErrorMock).toHaveBeenCalledWith(expect.objectContaining({
      context: { failureClass: "other" },
    }));
  });

  it("contains failures from every reporting sink and never retries start", async () => {
    const input = successInput();
    input.loadAndStart.mockRejectedValueOnce(new Error("private"));
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("console sink failed");
    });
    appendTelemetryMock.mockImplementation(() => {
      throw new Error("telemetry sink failed");
    });
    recordCriticalErrorMock.mockImplementation(() => {
      throw new Error("database sink failed");
    });

    await expect(startObservedBackgroundComponent(input)).resolves.toBeUndefined();

    expect(input.loadAndStart).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(appendTelemetryMock).toHaveBeenCalledTimes(1);
    expect(recordCriticalErrorMock).toHaveBeenCalledTimes(1);
  });
});
