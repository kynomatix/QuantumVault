import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFileSync: vi.fn(), availableParallelism: vi.fn(), setPriority: vi.fn(), getPriority: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: mocks.readFileSync }));
vi.mock("node:os", () => ({ availableParallelism: mocks.availableParallelism, setPriority: mocks.setPriority, getPriority: mocks.getPriority }));
import { getLabResourcePolicy, lowerLabPriority } from "../../server/lab/resource-policy";
import { recommendedPoolSize } from "../../server/lab/worker-pool";

const files = new Map<string, string>();
const v2 = "/sys/fs/cgroup/cpu.max";

beforeEach(() => {
  vi.resetAllMocks();
  files.clear();
  mocks.readFileSync.mockImplementation((path: string) => {
    if (!files.has(path)) throw new Error("EXAMPLE unavailable");
    return files.get(path);
  });
  mocks.availableParallelism.mockReturnValue(8);
  mocks.getPriority.mockReturnValue(19);
  vi.stubEnv("REPLIT_DEPLOYMENT", "1");
  vi.stubEnv("LAB_MAX_WORKERS", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Lab CPU budget", () => {
  it.each([
    ["100000 100000", 1, 1], ["150000 100000", 1.5, 1],
    ["250000 100000", 2.5, 1], ["300000 100000", 3, 2],
    ["480000 100000", 4.8, 3], ["2000000 100000", 20, 6],
  ])("reserves web headroom for cpu.max %s", (text, quota, workers) => {
    files.set(v2, text);
    expect(getLabResourcePolicy()).toMatchObject({ workers, quotaCpus: quota, quotaSource: v2 });
  });

  it("uses the smaller affinity budget", () => {
    files.set(v2, "800000 100000");
    mocks.availableParallelism.mockReturnValue(3);
    expect(getLabResourcePolicy().workers).toBe(2);
  });

  it.each(["max 100000", "", "invalid", "-1 100000", "0 100000", "100000 0", "NaN 100000", "1e5 100000", "100000 100000 extra"])("falls back safely for unavailable quota %s", (text) => {
    files.set(v2, text);
    expect(getLabResourcePolicy()).toMatchObject({ workers: 1, quotaCpus: null, quotaSource: "unavailable" });
    vi.stubEnv("REPLIT_DEPLOYMENT", "");
    expect(getLabResourcePolicy().workers).toBe(6);
  });

  it.each(["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup"])("falls back from unlimited v2 to finite v1 at %s", (dir) => {
    files.set(v2, "max 100000");
    files.set(`${dir}/cpu.cfs_quota_us`, "400000\n");
    files.set(`${dir}/cpu.cfs_period_us`, "100000\n");
    expect(getLabResourcePolicy()).toMatchObject({ workers: 3, quotaCpus: 4, quotaSource: `${dir}/cpu.cfs_quota_us` });
  });

  it("retains development fallback when quota cannot be read", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "0");
    mocks.availableParallelism.mockImplementation(() => { throw new Error("EXAMPLE unsupported"); });
    expect(getLabResourcePolicy().workers).toBe(3);
    mocks.availableParallelism.mockReturnValue(1);
    expect(getLabResourcePolicy().workers).toBe(1);
  });

  it("does not let LAB_MAX_WORKERS defeat production or quota caps", () => {
    vi.stubEnv("LAB_MAX_WORKERS", "6");
    expect(getLabResourcePolicy().workers).toBe(1);
    files.set(v2, "300000 100000");
    expect(getLabResourcePolicy().workers).toBe(2);
    vi.stubEnv("LAB_MAX_WORKERS", "1");
    expect(getLabResourcePolicy()).toMatchObject({ workers: 1, maxWorkers: 1 });
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "2workers", "9007199254740992"])("ignores invalid LAB_MAX_WORKERS %s", (cap) => {
    files.set(v2, "500000 100000");
    vi.stubEnv("LAB_MAX_WORKERS", cap);
    expect(getLabResourcePolicy()).toMatchObject({ workers: 4, maxWorkers: null });
  });

  it("uses quota in development and preserves the empty-work minimum", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "0");
    files.set(v2, "300000 100000");
    expect(recommendedPoolSize(1)).toBe(2);
    expect(recommendedPoolSize(0)).toBe(1);
  });
});

describe("Lab priority", () => {
  it("sets the calling thread's lowest priority and logs its effective value", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    lowerLabPriority("optimizer worker");
    expect(mocks.setPriority).toHaveBeenCalledWith(19);
    expect(mocks.getPriority).toHaveBeenCalledWith();
    expect(log).toHaveBeenCalledWith("[QuantumLab] optimizer worker priority requested=19 effective=19");
  });

  it.each(["set", "get"])("continues when priority %s fails", (operation) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    (operation === "set" ? mocks.setPriority : mocks.getPriority).mockImplementation(() => { throw new Error("EXAMPLE denied"); });
    expect(() => lowerLabPriority("child")).not.toThrow();
    expect(log).toHaveBeenCalledWith("[QuantumLab] child priority requested=19 failed=EXAMPLE denied");
  });
});
