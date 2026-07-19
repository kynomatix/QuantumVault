// Subsystem load tags for the shared DB pool heartbeat.
//
// The pool heartbeat in server/db.ts logs total/idle/waiting every 30s, but
// when the pool runs hot that line cannot say WHO is holding the slots
// (2026-07-19 incident follow-up: scanner-vs-dashboard interference was only
// provable by timing correlation). Subsystems register a cheap snapshot
// callback here; the heartbeat appends each tag to its telemetry line so a
// starved pool is attributable at a glance, e.g.:
//   [DB Pool] total=8 idle=0 waiting=2 max=8 candles=r3/rq5/w2/wq1
//
// This module deliberately imports nothing so any module (including db.ts
// itself) can import it without cycles.

export type PoolLoadSnapshot = Record<string, number>;

const tags = new Map<string, () => PoolLoadSnapshot>();

/** Register a subsystem's load snapshot. Re-registering a name replaces it. */
export function registerPoolLoadTag(name: string, snapshot: () => PoolLoadSnapshot): void {
  tags.set(name, snapshot);
}

/**
 * Format all registered tags for the heartbeat line. Returns "" when nothing
 * is registered or every counter is zero (keeps the quiet-state line short).
 */
export function formatPoolLoadTags(): string {
  const parts: string[] = [];
  for (const [name, fn] of tags) {
    let snap: PoolLoadSnapshot;
    try {
      snap = fn();
    } catch {
      continue; // a broken snapshot must never break the heartbeat
    }
    const entries = Object.entries(snap);
    if (entries.length === 0 || entries.every(([, v]) => v === 0)) continue;
    parts.push(`${name}=${entries.map(([k, v]) => `${k}${v}`).join("/")}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
