import { describe, expect, it, vi } from "vitest";
const telemetry = vi.hoisted(() => vi.fn());
vi.mock("../../server/telemetry", () => ({ appendTelemetry: telemetry }));
import { startJobTiming, takeJobTimingStats, timeJob } from "../../server/job-timing";

describe("bounded job attribution", () => {
  it("retains active names and ends a failed phase once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const end = startJobTiming("scanner.sweep");
    expect(takeJobTimingStats()).toContain("jobs=scanner.sweep:");
    await expect(timeJob("lab.running", async () => { throw new Error("EXAMPLE"); })).rejects.toThrow("EXAMPLE");
    const before = telemetry.mock.calls.length;
    end(); end();
    expect(telemetry.mock.calls.length).toBe(before + 1);
    const stats = takeJobTimingStats();
    expect(stats).toContain("jobs=none");
    expect(stats).toContain("lab.running:");
    expect(stats).toContain("scanner.sweep:");
    expect(telemetry.mock.calls.every(([line]) => !line.includes("EXAMPLE"))).toBe(true);
    vi.restoreAllMocks();
  });
  it("caps event logs and retained summaries during a burst", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = telemetry.mock.calls.length;
    for (let index = 0; index < 200; index++) startJobTiming("candle.group")();
    expect(telemetry.mock.calls.length - before).toBeLessThanOrEqual(120);
    const stats = takeJobTimingStats();
    expect(stats).toContain("jobs=none");
    expect(stats).toMatch(/joblog_dropped=[1-9]\d*/);
    expect(stats.match(/candle.group:/g)?.length).toBeLessThanOrEqual(8);
    vi.restoreAllMocks();
  });
});
