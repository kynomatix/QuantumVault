// Explicit auth/session recovery state machine (2026-07-20 incident).
//
// The incident: the scanner degraded the DB pool, core reads 401'd/timed out
// against a half-established session, and the loose boolean interplay
// (sessionConnected / authError / sessionExpired latch) collapsed every
// failure mode into "session expired — sign in again" while the user's 7-day
// cookie was perfectly valid. This module replaces guessing with one
// authoritative, wallet-bound probe and an explicit verdict union:
//
//   valid               — cookie valid AND UMK security session present
//                         (server auto-restores from storage if it can)
//   signature-required  — the server AUTHORITATIVELY said sign in again:
//                           cookie-invalid  (401 — no express session)
//                           wallet-mismatch (403 — session pinned elsewhere)
//                           umk-missing     (200, hasSession:false — restore failed)
//   server-unavailable  — network / timeout / 5xx: says NOTHING about the
//                         session; auto-retried with bounded backoff and on
//                         online/focus/recovery events. NEVER latches
//                         session-expired, NEVER triggers a signature.
//   no-wallet           — wallet adapter has no publicKey right now (mobile
//                         MWA drops it transiently); probe is a no-op.
//
// Rules enforced here:
// - A stray core-read 401/403 is EVIDENCE, recorded (endpoint, status,
//   wallet-match, boot id, timestamp) — only a probe verdict is a VERDICT.
// - Only authoritative invalid latches the session-expired banner.
// - A signature is only ever requested from a user gesture elsewhere; this
//   module never calls signMessage.
//
// No window/DOM access at import time: event hooks are armed lazily on the
// first probe so the module is safe to import in node test environments.

import { safeResponseJson } from "./safe-fetch";
import { getActiveWalletAddress, walletAuthHeaders } from "./queryClient";
import {
  reportCoreAuthFailure,
  reportCoreAuthSuccess,
  setAuthRejectionArbiter,
  registerRecoveryListener,
} from "./server-health";

export type SignatureRequiredReason =
  | "umk-missing"
  | "cookie-invalid"
  | "wallet-mismatch";

export type SessionProbeVerdict =
  | { kind: "valid"; walletAddress: string; restored: boolean; bootId: string | null }
  | {
      kind: "signature-required";
      reason: SignatureRequiredReason;
      walletAddress: string;
      bootId: string | null;
    }
  | { kind: "server-unavailable"; walletAddress: string; detail: string }
  | { kind: "no-wallet" };

export interface AuthRejectionEvidence {
  endpoint: string;
  status: number;
  requestWallet: string | null;
  activeWallet: string | null;
  walletMatch: boolean;
  lastKnownBootId: string | null;
  at: number;
}

const EVIDENCE_CAP = 20;
const PROBE_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 60_000;

const evidence: AuthRejectionEvidence[] = [];
let lastKnownBootId: string | null = null;
let lastVerdict: SessionProbeVerdict | null = null;
let probeInFlight: Promise<SessionProbeVerdict> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let hooksArmed = false;

type VerdictListener = (v: SessionProbeVerdict) => void;
const verdictListeners = new Set<VerdictListener>();

/** Subscribe to probe verdicts (useWallet drives its state from these). */
export function onSessionVerdict(cb: VerdictListener): () => void {
  verdictListeners.add(cb);
  return () => verdictListeners.delete(cb);
}

function emitVerdict(v: SessionProbeVerdict): SessionProbeVerdict {
  lastVerdict = v;
  verdictListeners.forEach((l) => {
    try {
      l(v);
    } catch {
      // a broken listener must never break the probe pipeline
    }
  });
  return v;
}

function maybeReprobe(_why: string): void {
  // Only re-probe when the open question is server availability. An
  // authoritative verdict (valid / signature-required) is settled — a new
  // probe runs only when new evidence (a core 401) or a caller asks for one.
  if (lastVerdict?.kind !== "server-unavailable") return;
  if (!getActiveWalletAddress()) return;
  void probeSession();
}

let unsubRecovery: (() => void) | null = null;
const onlineHandler = () => maybeReprobe("online");
const focusHandler = () => maybeReprobe("focus");

function armAutoRetryHooks(): void {
  if (hooksArmed) return;
  hooksArmed = true;
  // Recovery edge (degraded→healthy): some other core read got through, the
  // server is back — settle the session question immediately.
  unsubRecovery = registerRecoveryListener(() => maybeReprobe("recovery"));
  if (typeof window !== "undefined") {
    window.addEventListener("online", onlineHandler);
    window.addEventListener("focus", focusHandler);
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_CAP_MS);
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    maybeReprobe("backoff");
  }, delay);
  (retryTimer as { unref?: () => void }).unref?.();
}

/**
 * Run ONE authoritative wallet-bound session probe (single-flight). GET
 * /api/auth/session both checks and self-heals: the server attempts a UMK
 * restore from storage before answering, so hasSession:false is a genuine
 * "signature required", not a race.
 */
export async function probeSession(): Promise<SessionProbeVerdict> {
  const wallet = getActiveWalletAddress();
  if (!wallet) return emitVerdict({ kind: "no-wallet" });
  if (probeInFlight) return probeInFlight;
  armAutoRetryHooks();

  probeInFlight = (async (): Promise<SessionProbeVerdict> => {
    try {
      let res: Response;
      try {
        res = await fetch("/api/auth/session", {
          credentials: "include",
          headers: walletAuthHeaders(),
          signal:
            typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
              ? AbortSignal.timeout(PROBE_TIMEOUT_MS)
              : undefined,
        });
      } catch (err) {
        const detail =
          (err as Error | undefined)?.name === "TimeoutError" ? "timeout" : "network";
        scheduleRetry();
        return emitVerdict({ kind: "server-unavailable", walletAddress: wallet, detail });
      }

      // Wallet switched while the probe was in flight — this verdict belongs
      // to a wallet that is no longer active. Discard it.
      if (getActiveWalletAddress() !== wallet) {
        return emitVerdict({ kind: "no-wallet" });
      }

      if (res.status === 401 || res.status === 403) {
        // The server ANSWERED and rejected: authoritative.
        retryAttempt = 0;
        reportCoreAuthFailure();
        return emitVerdict({
          kind: "signature-required",
          reason: res.status === 403 ? "wallet-mismatch" : "cookie-invalid",
          walletAddress: wallet,
          bootId: lastKnownBootId,
        });
      }
      if (!res.ok) {
        // 5xx (or other non-auth failure): inconclusive — NOT "UMK missing".
        scheduleRetry();
        return emitVerdict({
          kind: "server-unavailable",
          walletAddress: wallet,
          detail: `http-${res.status}`,
        });
      }

      let data: { hasSession?: boolean; restored?: boolean; bootId?: string } | null = null;
      try {
        data = await safeResponseJson(res);
      } catch {
        scheduleRetry();
        return emitVerdict({
          kind: "server-unavailable",
          walletAddress: wallet,
          detail: "bad-body",
        });
      }
      if (data?.bootId) lastKnownBootId = String(data.bootId);

      if (data?.hasSession) {
        retryAttempt = 0;
        // Authoritative valid: clear the session-expired latch. queryClient's
        // recovery listener refetches every errored query on this edge, so
        // the dashboard recovers without a reload or user tap.
        reportCoreAuthSuccess();
        return emitVerdict({
          kind: "valid",
          walletAddress: wallet,
          restored: !!data.restored,
          bootId: lastKnownBootId,
        });
      }

      // 200 + hasSession:false — the server tried to restore the UMK and
      // could not. Authoritative: a signature is genuinely required.
      retryAttempt = 0;
      reportCoreAuthFailure();
      return emitVerdict({
        kind: "signature-required",
        reason: "umk-missing",
        walletAddress: wallet,
        bootId: lastKnownBootId,
      });
    } finally {
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

// Arbiter for core-read 401/403s (registered with coreFetch): record the
// evidence, discard stale-wallet noise, and let ONE authoritative probe
// decide. Registration is side-effect-only module state — no DOM access.
setAuthRejectionArbiter(({ endpoint, status, requestWallet }) => {
  const activeWallet = getActiveWalletAddress();
  evidence.push({
    endpoint,
    status,
    requestWallet,
    activeWallet,
    walletMatch: !requestWallet || !activeWallet || requestWallet === activeWallet,
    lastKnownBootId,
    at: Date.now(),
  });
  if (evidence.length > EVIDENCE_CAP) evidence.splice(0, evidence.length - EVIDENCE_CAP);

  // A rejection for a request stamped with a DIFFERENT wallet than the active
  // one is a wallet-switch race, not a session problem for the active wallet.
  if (requestWallet && activeWallet && requestWallet !== activeWallet) return;
  void probeSession();
});

/** Recorded core-read auth rejections (newest last, capped). */
export function getAuthRejectionEvidence(): readonly AuthRejectionEvidence[] {
  return evidence;
}

export function getLastSessionVerdict(): SessionProbeVerdict | null {
  return lastVerdict;
}

export function getLastKnownBootId(): string | null {
  return lastKnownBootId;
}

/** Test-only: reset module state between unit tests. */
export function __resetSessionProbeForTests(): void {
  evidence.length = 0;
  lastKnownBootId = null;
  lastVerdict = null;
  probeInFlight = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempt = 0;
  verdictListeners.clear();
  unsubRecovery?.();
  unsubRecovery = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("online", onlineHandler);
    window.removeEventListener("focus", focusHandler);
  }
  hooksArmed = false;
}
