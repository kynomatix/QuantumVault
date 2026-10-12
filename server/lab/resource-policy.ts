import { readFileSync } from "node:fs";
import { availableParallelism, getPriority, setPriority } from "node:os";

export const LAB_PRIORITY = 19;
const MAX_POOL_SIZE = 6;

export interface LabResourcePolicy {
  workers: number;
  availableCpus: number;
  quotaCpus: number | null;
  quotaSource: string;
  maxWorkers: number | null;
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

function quotaCpus(quota: string, period: string): number | null {
  if (!/^\d+$/.test(quota) || !/^\d+$/.test(period)) return null;
  const q = Number(quota), p = Number(period);
  const cpus = q / p;
  return Number.isSafeInteger(q) && Number.isSafeInteger(p) && q > 0 && p > 0
    && Number.isFinite(cpus) && cpus > 0 ? cpus : null;
}

export function getLabResourcePolicy(): LabResourcePolicy {
  let availableCpus = 4;
  try { availableCpus = availableParallelism(); } catch {}

  const v2Path = "/sys/fs/cgroup/cpu.max";
  const v2 = readText(v2Path).split(/\s+/);
  let quota = v2.length === 2 ? quotaCpus(v2[0], v2[1]) : null;
  let quotaSource = quota === null ? "unavailable" : v2Path;
  if (quota === null) {
    // v1 mounts commonly use cpu, cpu,cpuacct, or the cgroup root itself.
    for (const dir of ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup"]) {
      quota = quotaCpus(readText(`${dir}/cpu.cfs_quota_us`), readText(`${dir}/cpu.cfs_period_us`));
      if (quota !== null) { quotaSource = `${dir}/cpu.cfs_quota_us`; break; }
    }
  }

  const rawMax = process.env.LAB_MAX_WORKERS?.trim() ?? "";
  const parsedMax = /^\d+$/.test(rawMax) ? Number(rawMax) : NaN;
  const maxWorkers = Number.isSafeInteger(parsedMax) && parsedMax > 0 ? parsedMax : null;
  const budget = quota === null ? availableCpus : Math.min(availableCpus, quota);
  // Keep the existing one-worker floor. Below two CPUs, nice 19 favors the
  // web process but cannot provide a dedicated CPU reservation.
  const target = quota === null && process.env.REPLIT_DEPLOYMENT === "1"
    ? 1 : Math.floor(budget - 1);
  const workers = Math.max(1, Math.min(MAX_POOL_SIZE, target, maxWorkers ?? MAX_POOL_SIZE));
  return { workers, availableCpus, quotaCpus: quota, quotaSource, maxWorkers };
}

export function lowerLabPriority(role: string): void {
  try {
    // pid 0 targets the calling thread on Linux; do this in every optimizer
    // thread as well as the Lab child, never in the live web process.
    setPriority(LAB_PRIORITY);
    const effective = getPriority();
    console.log(`[QuantumLab] ${role} priority requested=${LAB_PRIORITY} effective=${effective}`);
  } catch (error) {
    console.log(`[QuantumLab] ${role} priority requested=${LAB_PRIORITY} failed=${error instanceof Error ? error.message : String(error)}`);
  }
}
