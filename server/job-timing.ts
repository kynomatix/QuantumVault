import { performance } from "perf_hooks";
import { appendTelemetry } from "./telemetry";
import { SERVER_BOOT_ID } from "./boot-id";

// Fixed names only: no wallet, market, request body or checkpoint payload.
export type JobName =
  | "scanner.sweep" | "scanner.universe" | "scanner.prefetch" | "scanner.evaluate" | "scanner.publish"
  | "candle.batch" | "candle.group" | "candle.admit"
  | "lab.backfill" | "lab.running" | "lab.failed" | "lab.paused" | "lab.complete"
  | "reconcile.tick" | "analytics.seed" | "analytics.metrics";

const active = new Map<number, { name: JobName; started: number }>();
let recent: { name: JobName; durationMs: number }[] = [];
let sequence = 0;
let windowStart = 0;
let lines = 0;
let dropped = 0;

function emit(line: string): void {
  const now = performance.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    lines = 0;
  }
  if (lines >= 120) { dropped++; return; }
  lines++;
  try { console.log(line); appendTelemetry(line); } catch { /* best effort */ }
}

/** Wall time, including awaits; an active job is a lead, not proof of CPU ownership. */
export function startJobTiming(name: JobName): () => void {
  const id = ++sequence;
  const started = performance.now();
  if (active.size < 32) active.set(id, { name, started });
  const prefix = `[JobTiming] pid=${process.pid} boot=${SERVER_BOOT_ID.slice(0, 8)} id=${id} job=${name}`;
  emit(`${prefix} event=start at=${Date.now()}`);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active.delete(id);
    const durationMs = Math.round(performance.now() - started);
    recent.push({ name, durationMs });
    recent.sort((a, b) => b.durationMs - a.durationMs);
    recent = recent.slice(0, 8);
    emit(`${prefix} event=end at=${Date.now()} duration=${durationMs}ms`);
  };
}

export async function timeJob<T>(name: JobName, work: () => Promise<T>): Promise<T> {
  const end = startJobTiming(name);
  try { return await work(); } finally { end(); }
}

export function takeJobTimingStats(): string {
  const now = performance.now();
  const running = [...active.values()].map(({ name, started }) => `${name}:${Math.round(now - started)}ms`);
  const ended = recent.map(({ name, durationMs }) => `${name}:${durationMs}ms`);
  const result = `jobs=${running.join(",") || "none"} recent=${ended.join(",") || "none"} joblog_dropped=${dropped}`;
  recent = [];
  dropped = 0;
  return result;
}
