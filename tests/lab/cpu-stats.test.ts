import { afterEach, describe, expect, it, vi } from "vitest";
import { startLabCpuStats } from "../../server/lab/cpu-stats";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Lab child CPU line", () => {
  it("includes startup CPU, then actual interval deltas, and stops on cleanup", async () => {
    vi.useFakeTimers();
    let uptime = 125;
    let cpu = { user: 1_000_000, system: 250_000 };
    vi.spyOn(process, "uptime").mockImplementation(() => uptime);
    vi.spyOn(process, "cpuUsage").mockImplementation(() => cpu);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = startLabCpuStats();
    expect(log.mock.calls[0][0]).toContain("phase=loaded uptime=125000ms interval=125000ms cpu_user=1000ms cpu_system=250ms cpu=1.0%");
    uptime = 185;
    cpu = { user: 1_500_000, system: 350_000 };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.mock.calls[1][0]).toContain("phase=interval uptime=185000ms interval=60000ms cpu_user=500ms cpu_system=100ms cpu=1.0%");
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("keeps a logging failure from affecting the child", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("closed pipe"); });
    const stop = startLabCpuStats();
    expect(stop).toBeTypeOf("function");
    stop();
  });
});
