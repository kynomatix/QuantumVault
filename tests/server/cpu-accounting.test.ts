import { afterEach, describe, expect, it, vi } from "vitest";
import { createCpuAccountingProbe } from "../../server/cpu-accounting";

afterEach(() => vi.useRealTimers());

function reader(files: Record<string, string>) {
  return vi.fn(async (path: string) => {
    if (!(path in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files[path];
  });
}

describe("bounded cgroup accounting", () => {
  it("reports v2 interval deltas, quota and PSI rather than cumulative counters", async () => {
    const files = {
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/cpu.stat": "usage_usec 100000\nnr_periods 100\nnr_throttled 5\nthrottled_usec 20000",
      "/sys/fs/cgroup/cpu.max": "50000 100000",
      "/proc/pressure/cpu": "some avg10=12.34 avg60=2.0 avg300=1.0 total=10000\nfull avg10=0.00",
    };
    const probe = createCpuAccountingProbe(reader(files));
    expect(await probe.sample()).toContain("cg_state=baseline");
    files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 160000\nnr_periods 110\nnr_throttled 9\nthrottled_usec 24000";
    const line = await probe.sample();
    for (const field of ["cg_scope=self", "cg_version=2", "cg_usage_usec=60000", "cg_nr_periods=10", "cg_nr_throttled=4", "cg_throttled_usec=4000", "cg_quota_usec=50000", "cg_period_usec=100000", "psi_cpu_some_avg10=12.34"]) expect(line).toContain(field);
    expect(line.length).toBeLessThan(600);
  });

  it("uses the process's nested cgroup before a readable parent mount", async () => {
    const read = reader({
      "/proc/self/cgroup": "0::/tenant/web",
      "/sys/fs/cgroup/tenant/web/cpu.stat": "usage_usec 10",
      "/sys/fs/cgroup/tenant/web/cpu.max": "max 100000",
      "/sys/fs/cgroup/cpu.stat": "usage_usec 9999",
    });
    const line = await createCpuAccountingProbe(read).sample();
    expect(line).toContain("cg_scope=self");
    expect(line).toContain("cg_quota_usec=max");
    expect(line).toContain("cg_nr_throttled=na");
    expect(read).not.toHaveBeenCalledWith("/sys/fs/cgroup/cpu.stat");
  });

  it("converts v1 nanoseconds to microseconds with separate cpuacct mounts", async () => {
    const files = {
      "/proc/self/cgroup": "2:cpu:/web\n3:cpuacct:/web",
      "/sys/fs/cgroup/cpu/web/cpu.stat": "nr_periods 10\nnr_throttled 2\nthrottled_time 9000000",
      "/sys/fs/cgroup/cpuacct/web/cpuacct.usage": "9007199254740993000",
      "/sys/fs/cgroup/cpu/web/cpu.cfs_quota_us": "-1",
      "/sys/fs/cgroup/cpu/web/cpu.cfs_period_us": "100000",
    };
    const probe = createCpuAccountingProbe(reader(files));
    await probe.sample();
    files["/sys/fs/cgroup/cpuacct/web/cpuacct.usage"] = "9007199254742993000";
    files["/sys/fs/cgroup/cpu/web/cpu.stat"] = "nr_periods 12\nnr_throttled 3\nthrottled_time 10000000";
    const line = await probe.sample();
    for (const field of ["cg_version=1", "cg_scope=self", "cg_usage_usec=2000", "cg_nr_periods=2", "cg_nr_throttled=1", "cg_throttled_usec=1000", "cg_quota_usec=max", "psi_cpu_some_avg10=na"]) expect(line).toContain(field);
  });

  it("marks mount fallbacks and counter resets as unknown instead of negative or zero", async () => {
    const files = { "/sys/fs/cgroup/cpu.stat": "usage_usec 100\nnr_throttled 10", "/sys/fs/cgroup/cpu.max": "max 100000" };
    const probe = createCpuAccountingProbe(reader(files));
    expect(await probe.sample()).toContain("cg_scope=mount");
    files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 2\nnr_throttled 1";
    const line = await probe.sample();
    expect(line).toContain("cg_usage_usec=na");
    expect(line).toContain("cg_nr_throttled=na");
  });

  it("fails silently on missing, oversized or malformed counters while retaining readable PSI", async () => {
    const read = reader({
      "/sys/fs/cgroup/cpu.stat": "usage_usec 5\n" + "x".repeat(4096),
      "/proc/pressure/cpu": "some avg10=3.50 avg60=0.00",
      "/sys/fs/cgroup/cpu/cpu.stat": "nr_periods invalid\nnr_throttled -1",
    });
    expect(await createCpuAccountingProbe(read).sample()).toBe("cg_state=unavailable psi_cpu_some_avg10=3.50");
    expect(read.mock.calls.length).toBeLessThan(25);
  });

  it("bounds waiting and does not start another batch while a read is stuck", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<string>(() => {}));
    const probe = createCpuAccountingProbe(read);
    const first = probe.sample();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await first).toBe("cg_state=timeout");
    expect(await probe.sample()).toBe("cg_state=pending");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("establishes a fresh baseline after the accounting source changes", async () => {
    const files: Record<string, string> = { "/proc/self/cgroup": "0::/one", "/sys/fs/cgroup/one/cpu.stat": "usage_usec 10", "/sys/fs/cgroup/two/cpu.stat": "usage_usec 9000" };
    const probe = createCpuAccountingProbe(reader(files));
    await probe.sample();
    files["/proc/self/cgroup"] = "0::/two";
    expect(await probe.sample()).toContain("cg_state=baseline");
  });
});
