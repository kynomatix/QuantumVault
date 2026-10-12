import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const MAX_BYTES = 4096;
const SAMPLE_TIMEOUT_MS = 1500;
type ReadText = (path: string) => Promise<string>;
type Counters = { usage: bigint | null; periods: bigint | null; throttled: bigint | null; throttleUsec: bigint | null };
type Sample = {
  at: number; source: string; version: number; scope: string;
  counters: Counters; quota: string; period: string; pressure: string;
};

// procfs/sysfs files have no useful stat size. Read at most 4 KiB plus one
// overflow byte, asynchronously, even if a mount behaves unexpectedly.
async function readText(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_BYTES ? "" : buffer.toString("utf8", 0, length).trim();
  } finally { await file.close(); }
}

function counter(value: string | undefined): bigint | null {
  return value && /^\d{1,24}$/.test(value) ? BigInt(value) : null;
}

function statFields(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\n/).map((line) => line.trim().split(/\s+/)).filter((pair) => pair.length === 2));
}

function membership(text: string, controller: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^\d+:([^:]*):(\/.*)$/.exec(line);
    if (!match || (controller ? !match[1].split(",").includes(controller) : match[1] !== "")) continue;
    const path = match[2];
    if (path.length <= 256 && !path.split("/").some((part) => part === ".." || part === ".")) return path === "/" ? "" : path;
  }
  return null;
}

function directories(mounts: string[], path: string | null): Array<{ path: string; scope: string }> {
  return path
    ? [...mounts.map((mount) => ({ path: mount + path, scope: "self" })), ...mounts.map((mount) => ({ path: mount, scope: "mount" }))]
    : mounts.map((mount) => ({ path: mount, scope: path === "" ? "self" : "mount" }));
}

async function collect(read: ReadText): Promise<Sample> {
  const safeRead = async (path: string) => {
    try { const text = await read(path); return Buffer.byteLength(text) <= MAX_BYTES ? text : ""; } catch { return ""; }
  };
  const [groups, psi] = await Promise.all([safeRead("/proc/self/cgroup"), safeRead("/proc/pressure/cpu")]);
  const pressureMatch = /^some\s+avg10=(\d+(?:\.\d+)?)\b/m.exec(psi);
  const pressure = pressureMatch && Number(pressureMatch[1]) <= 100 ? Number(pressureMatch[1]).toFixed(2) : "na";
  for (const dir of directories(["/sys/fs/cgroup"], membership(groups, ""))) {
    const stat = statFields(await safeRead(`${dir.path}/cpu.stat`));
    const usage = counter(stat.usage_usec);
    if (usage === null) continue;
    const max = (await safeRead(`${dir.path}/cpu.max`)).trim().split(/\s+/);
    return {
      at: performance.now(), source: dir.path, version: 2, scope: dir.scope, pressure,
      counters: { usage, periods: counter(stat.nr_periods), throttled: counter(stat.nr_throttled), throttleUsec: counter(stat.throttled_usec) },
      quota: max.length === 2 && (max[0] === "max" || counter(max[0]) !== null) ? max[0] : "na",
      period: max.length === 2 && counter(max[1]) !== null && BigInt(max[1]) > 0n ? max[1] : "na",
    };
  }
  const mounts = ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup/cpuacct,cpu", "/sys/fs/cgroup"];
  let cpu: { path: string; scope: string; stat: Record<string, string> } | null = null;
  for (const dir of directories(mounts, membership(groups, "cpu"))) {
    const stat = statFields(await safeRead(`${dir.path}/cpu.stat`));
    if (counter(stat.nr_throttled) !== null || counter(stat.nr_periods) !== null) { cpu = { ...dir, stat }; break; }
  }
  let acct: { path: string; scope: string; usage: bigint } | null = null;
  const acctMounts = ["/sys/fs/cgroup/cpuacct", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup/cpuacct,cpu", "/sys/fs/cgroup"];
  for (const dir of directories(acctMounts, membership(groups, "cpuacct"))) {
    const ns = counter(await safeRead(`${dir.path}/cpuacct.usage`));
    if (ns !== null) { acct = { ...dir, usage: ns / 1000n }; break; }
  }
  const [quota, period] = cpu ? await Promise.all([
    safeRead(`${cpu.path}/cpu.cfs_quota_us`), safeRead(`${cpu.path}/cpu.cfs_period_us`),
  ]) : ["", ""];
  const throttleNs = counter(cpu?.stat.throttled_time);
  return {
    at: performance.now(), source: `${cpu?.path ?? ""}|${acct?.path ?? ""}`, version: cpu || acct ? 1 : 0,
    scope: cpu && acct && cpu.scope === "self" && acct.scope === "self" ? "self" : "mount", pressure,
    counters: { usage: acct?.usage ?? null, periods: counter(cpu?.stat.nr_periods), throttled: counter(cpu?.stat.nr_throttled), throttleUsec: throttleNs === null ? null : throttleNs / 1000n },
    quota: quota === "-1" ? "max" : counter(quota) !== null ? quota : "na",
    period: counter(period) !== null && BigInt(period) > 0n ? period : "na",
  };
}

function delta(current: bigint | null, previous: bigint | null | undefined): string {
  return current !== null && previous != null && current >= previous ? String(current - previous) : "na";
}

/** One bounded, fail-silent read batch per minute; a stuck syscall cannot pile up batches. */
export function createCpuAccountingProbe(read: ReadText = readText): { sample(): Promise<string> } {
  let previous: Sample | null = null;
  let inFlight: Promise<Sample | null> | null = null;
  return {
    async sample(): Promise<string> {
      if (inFlight) return "cg_state=pending";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const operation = collect(read).catch(() => null);
        inFlight = operation;
        void operation.then(() => { inFlight = null; });
        const current = await Promise.race([
          operation,
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SAMPLE_TIMEOUT_MS); timer.unref?.(); }),
        ]);
        if (!current) return "cg_state=timeout";
        if (!current.version) { previous = null; return `cg_state=unavailable psi_cpu_some_avg10=${current.pressure}`; }
        const before = previous?.source === current.source && previous.version === current.version ? previous : null;
        previous = current;
        return `cg_state=${before ? "ok" : "baseline"} cg_version=${current.version} cg_scope=${current.scope} cg_interval=${before ? Math.round(current.at - before.at) : "na"}ms cg_usage_usec=${delta(current.counters.usage, before?.counters.usage)} cg_nr_periods=${delta(current.counters.periods, before?.counters.periods)} cg_nr_throttled=${delta(current.counters.throttled, before?.counters.throttled)} cg_throttled_usec=${delta(current.counters.throttleUsec, before?.counters.throttleUsec)} cg_quota_usec=${current.quota} cg_period_usec=${current.period} psi_cpu_some_avg10=${current.pressure}`;
      } catch { return "cg_state=unavailable"; }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
