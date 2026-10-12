import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sample: vi.fn(), append: vi.fn() }));
vi.mock("../../server/cpu-accounting", () => ({ createCpuAccountingProbe: () => ({ sample: mocks.sample }) }));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: mocks.append }));
import { startSelfStats } from "../../server/request-trace";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocks.sample.mockReset(); mocks.append.mockReset(); });

function start() {
  const server = Object.assign(new EventEmitter(), { getConnections: (cb: (error: null, count: number) => void) => cb(null, 3) });
  startSelfStats(server as never);
  return server;
}

describe("SelfStats accounting integration", () => {
  it("takes an initial baseline and enriches the existing line once per minute", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.sample.mockResolvedValue("cg_state=ok cg_usage_usec=5000");
    const server = start();
    expect(mocks.sample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.sample).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("[SelfStats] pid=");
    expect(line).toContain("conns=3");
    expect(line).toContain("cg_state=ok cg_usage_usec=5000");
    expect(mocks.append).toHaveBeenCalledWith(line);
    server.emit("close");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.sample).toHaveBeenCalledTimes(2);
  });

  it("discards a pending enrichment when the HTTP server closes", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let finish!: (line: string) => void;
    mocks.sample.mockResolvedValueOnce("cg_state=baseline").mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const server = start();
    await vi.advanceTimersByTimeAsync(60_000);
    server.emit("close");
    finish("cg_state=ok");
    await Promise.resolve();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
