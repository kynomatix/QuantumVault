// Pure derivation of the dashboard's truthful display state (2026-07-19
// incident): a section may render "no bots / no positions" ONLY after a
// successful (HTTP 200) read for the confirmed active wallet. Every other
// combination — wallet disconnected, connecting, signature pending, auth
// failed, session expired, server down, request failed, still loading — must
// render its own explicit state instead of masquerading as an empty account.
//
// Kept free of React/DOM imports so it is unit-testable as a pure function.

export type DashboardSectionState =
  | "wallet-disconnected" // no wallet public key
  | "wallet-connecting" // adapter negotiating / auto-connecting
  | "signature-required" // wallet connected, sign-in signature pending
  | "auth-failed" // sign-in attempted and failed (gesture retry needed)
  | "session-expired" // server answered 401/403 on a core authed read
  | "server-unavailable" // consecutive network/5xx failures on core reads
  | "request-failed" // this section's read failed (non-degraded, non-auth)
  | "loading" // query disabled-pending or first fetch in flight
  | "stale" // showing last-known-good data that is no longer fresh
  | "empty" // HTTP 200 for the active wallet, genuinely no items
  | "ready"; // HTTP 200 with data

export interface DashboardSectionInputs {
  /** Wallet adapter has a public key. */
  walletConnected: boolean;
  /** Wallet adapter is negotiating a connection. */
  walletConnecting: boolean;
  /** Sign-in signature request is in flight. */
  signingInProgress: boolean;
  /** Automatic sign-in failed; a user-gesture retry is required. */
  authError: boolean;
  /** Backend session is bound to the active wallet. */
  sessionConnected: boolean;
  /** A core authed read returned 401/403 since the last success. */
  sessionExpired: boolean;
  /** Core reads are consistently failing with network/5xx errors. */
  serverDegraded: boolean;
  /** This section's query has succeeded (HTTP 200) at least once and its data is current. */
  querySuccess: boolean;
  /** This section's query is currently in error state. */
  queryError: boolean;
  /** The successful response contained zero items. */
  isEmpty: boolean;
  /** Last-known-good data exists in the cache (may be stale). */
  hasData: boolean;
}

/**
 * Derive what a dashboard data section (bots list, positions list, …) should
 * render. Precedence: wallet-level states first (queries are disabled there),
 * then session validity, then this section's own query outcome. When
 * last-known-good data exists it is preserved and marked stale rather than
 * discarded — but it is never presented as fresh while anything is wrong.
 */
export function deriveDashboardSectionState(i: DashboardSectionInputs): DashboardSectionState {
  // Wallet-level gates: queries are disabled, so "no data" means nothing here.
  if (!i.walletConnected) {
    return i.walletConnecting ? "wallet-connecting" : "wallet-disconnected";
  }
  if (!i.sessionConnected) {
    if (i.signingInProgress) return "signature-required";
    if (i.authError) return "auth-failed";
    // Connected but session not yet bound (auth in flight pre-signature).
    return "wallet-connecting";
  }

  // Session-level: the server explicitly rejected our identity.
  if (i.sessionExpired) {
    return i.hasData ? "stale" : "session-expired";
  }

  // Server-level: reads are consistently failing.
  if (i.serverDegraded) {
    return i.hasData ? "stale" : "server-unavailable";
  }

  // Section-level query outcome.
  if (i.queryError) {
    return i.hasData ? "stale" : "request-failed";
  }
  if (!i.querySuccess) {
    return i.hasData ? "stale" : "loading";
  }

  // HTTP 200 for the confirmed active wallet — the ONLY path allowed to
  // declare a legitimate empty state.
  return i.isEmpty ? "empty" : "ready";
}

/** True when the state must show an explicit problem panel (no data to show). */
export function isBlockedState(s: DashboardSectionState): boolean {
  return (
    s === "session-expired" ||
    s === "server-unavailable" ||
    s === "request-failed" ||
    s === "auth-failed"
  );
}

/** Human-readable label for the stale badge, e.g. "Last updated 14:03:22". */
export function staleDataLabel(dataUpdatedAt: number): string {
  if (!dataUpdatedAt) return "Last update time unknown";
  return `Last updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`;
}
