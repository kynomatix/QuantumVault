// Client-state telemetry (2026-07-20 stuck-dashboard incident).
//
// Production kept getting a stuck/false-empty dashboard 15-30 min after each
// publish, with ZERO client-side evidence: nothing could prove whether the
// browser stopped sending requests, sent them and they hung, or rendered
// empty on good data. This module closes the client half of that gap:
//
//  - Edge-triggered EVENTS (wallet present/absent, probe verdicts,
//    sessionConnected flips, window errors, visibility/online changes) go
//    into a small capped ring buffer, deduped, and flush to
//    POST /api/client-telemetry (bounded server-side, log-only).
//  - A 60s HEARTBEAT (visible tabs only) carries a snapshot: last probe
//    verdict, last seen server boot id, and a per-section React Query status
//    summary (status/fetchStatus/data age). The heartbeat's ABSENCE while
//    other clients keep reporting is itself the signal that this browser
//    went silent — we never try to make it "survive" a deaf server.
//  - A failed flush puts events back in the (capped) buffer, so the incident
//    timeline is delivered on the first successful POST after recovery.
//  - pagehide flushes what's left via sendBeacon.
//
// Bounded by design: ring cap ~50, 30 events/min (drops counted), one POST
// per 10s minimum. Wallet identity is a shortened form, never full address,
// never cookies/tokens. No window/DOM access at import time — safe to import
// in node test environments; hooks arm in initClientTelemetry().

import { getActiveWalletAddress, queryClient } from "./queryClient";
import {
  onSessionVerdict,
  getLastSessionVerdict,
  getLastKnownBootId,
} from "./session-probe";

const RING_CAP = 50;
const DEDUPE_MS = 5_000;
const MIN_FLUSH_GAP_MS = 10_000;
const FLUSH_DEBOUNCE_MS = 2_000;
const HEARTBEAT_MS = 60_000;
const MAX_EVENTS_PER_MIN = 30;
const POST_TIMEOUT_MS = 8_000;

interface TelEvent {
  t: number;
  type: string;
  d?: string;
}

const ring: TelEvent[] = [];
const lastByType = new Map<string, { d?: string; at: number }>();
let eventsThisMin = 0;
let minuteStart = Date.now();
let droppedThisMin = 0;
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight = false;
let initialized = false;

function shortWallet(): string {
  const w = getActiveWalletAddress();
  return w ? `${w.slice(0, 4)}..${w.slice(-4)}` : "-";
}

/**
 * Record a client state-transition event. Deduped per type+detail (5s), rate
 * capped per minute (drops surface as a `tel-dropped` event, never silently).
 * Multiple useWallet instances reporting the SAME value collapse via dedupe;
 * instances reporting ALTERNATING values flap through — which is exactly the
 * per-instance divergence evidence we want captured.
 */
export function recordClientEvent(type: string, d?: string): void {
  const now = Date.now();
  const prev = lastByType.get(type);
  if (prev && prev.d === d && now - prev.at < DEDUPE_MS) return;
  lastByType.set(type, { d, at: now });

  if (now - minuteStart >= 60_000) {
    if (droppedThisMin > 0) {
      ring.push({ t: now, type: "tel-dropped", d: String(droppedThisMin) });
      droppedThisMin = 0;
    }
    minuteStart = now;
    eventsThisMin = 0;
  }
  eventsThisMin++;
  if (eventsThisMin > MAX_EVENTS_PER_MIN) {
    droppedThisMin++;
    return;
  }

  ring.push({ t: now, type, d });
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  scheduleFlush();
}

/** Compact per-section React Query health for the heartbeat line. */
function querySummary(): string {
  try {
    const parts: string[] = [];
    for (const key of ["positions", "tradingBots", "trades", "healthMetrics"]) {
      const queries = queryClient.getQueryCache().findAll({ queryKey: [key] });
      if (queries.length === 0) {
        parts.push(`${key}:none`);
        continue;
      }
      const newest = queries.reduce((a, b) =>
        b.state.dataUpdatedAt > a.state.dataUpdatedAt ? b : a,
      );
      const ageS = newest.state.dataUpdatedAt
        ? Math.round((Date.now() - newest.state.dataUpdatedAt) / 1000)
        : -1;
      const observers =
        typeof newest.getObserversCount === "function" ? newest.getObserversCount() : -1;
      parts.push(
        `${key}:${newest.state.status}/${newest.state.fetchStatus}/${ageS}s/o${observers}`,
      );
    }
    return parts.join(",");
  } catch {
    return "summary-error";
  }
}

function heartbeatSnapshot(): Record<string, unknown> {
  const verdict = getLastSessionVerdict();
  return {
    vis: typeof document !== "undefined" ? document.visibilityState : "?",
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    verdict: verdict?.kind ?? "none",
    boot: getLastKnownBootId() ?? "-",
    q: querySummary(),
  };
}

async function flush(kind: string): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;
  lastFlushAt = Date.now();
  const events = ring.splice(0, ring.length);
  try {
    const res = await fetch("/api/client-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ w: shortWallet(), kind, hb: heartbeatSnapshot(), ev: events }),
      credentials: "omit",
      signal:
        typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? AbortSignal.timeout(POST_TIMEOUT_MS)
          : undefined,
    });
    if (!res.ok) throw new Error(`http-${res.status}`);
  } catch {
    // Server unreachable (possibly the incident itself): put the events back,
    // capped — they are delivered on the first successful flush afterwards,
    // giving us the incident-onset timeline post-recovery.
    ring.unshift(...events);
    if (ring.length > RING_CAP) ring.splice(RING_CAP);
  } finally {
    flushInFlight = false;
  }
}

function scheduleFlush(): void {
  if (!initialized || flushTimer) return;
  const sinceLast = Date.now() - lastFlushAt;
  const wait = Math.max(FLUSH_DEBOUNCE_MS, MIN_FLUSH_GAP_MS - sinceLast);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush("ev");
  }, wait);
}

/** Arm listeners + heartbeat. Idempotent; call once from the client entry. */
export function initClientTelemetry(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  onSessionVerdict((v) => {
    const detail =
      v.kind === "signature-required"
        ? `${v.kind}:${v.reason}`
        : v.kind === "server-unavailable"
          ? `${v.kind}:${v.detail}`
          : v.kind;
    recordClientEvent("verdict", detail);
  });

  window.addEventListener("error", (e) => {
    recordClientEvent("window-error", String(e?.message ?? "unknown").slice(0, 200));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason as
      | { message?: string }
      | string
      | undefined;
    const msg =
      typeof reason === "string" ? reason : (reason?.message ?? String(reason ?? "unknown"));
    recordClientEvent("unhandled-rejection", msg.slice(0, 200));
  });
  document.addEventListener("visibilitychange", () => {
    recordClientEvent("visibility", document.visibilityState);
  });
  window.addEventListener("online", () => recordClientEvent("net", "online"));
  window.addEventListener("offline", () => recordClientEvent("net", "offline"));

  window.addEventListener("pagehide", () => {
    try {
      const events = ring.splice(0, ring.length);
      events.push({ t: Date.now(), type: "pagehide" });
      const body = new Blob(
        [JSON.stringify({ w: shortWallet(), kind: "bye", ev: events })],
        { type: "application/json" },
      );
      navigator.sendBeacon?.("/api/client-telemetry", body);
    } catch {
      // best-effort
    }
  });

  heartbeatTimer = setInterval(() => {
    // Visible tabs only: a backgrounded tab going quiet is expected, not
    // evidence. (Browsers throttle hidden-tab timers anyway.)
    if (document.visibilityState === "visible") void flush("hb");
  }, HEARTBEAT_MS);

  recordClientEvent("tel-boot");
  // Immediate baseline flush so every page load is visible in telemetry.
  void flush("hello");
}

/** Test-only: reset module state between unit tests. */
export function __resetClientTelemetryForTests(): void {
  ring.length = 0;
  lastByType.clear();
  eventsThisMin = 0;
  droppedThisMin = 0;
  minuteStart = Date.now();
  lastFlushAt = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  flushInFlight = false;
  initialized = false;
}

/** Test-only: expose internals for assertions. */
export function __getClientTelemetryStateForTests(): {
  ring: readonly TelEvent[];
  initialized: boolean;
} {
  return { ring, initialized };
}

/** Test-only: run one flush cycle deterministically. */
export function __flushClientTelemetryForTests(kind = "test"): Promise<void> {
  return flush(kind);
}
