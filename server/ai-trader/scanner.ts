// server/ai-trader/scanner.ts
//
// WO-A: Scanner core (shadow mode — no trading, no schema changes, no UI).
//
// Runs at every 15m UTC boundary + 2s settle. Sweeps all tradable markets on
// Flash + Pacifica through the shared lab datafeed (OKX → Gate → Pyth Benchmarks
// public REST, shared persistent candle cache). Zero LLM calls, zero venue credits.
// Pacifica's 300 credits/60s budget is completely untouched.
//
// Exported surface:
//   startScanner()    — call alongside startAiTraderMonitor() in server startup.
//   stopScanner()     — call alongside stopAiTraderMonitor() in tests/shutdown.
//   getScannerShortlist(protocol)  — current ranked shortlist (empty if no boundary yet).
//   getBoundaryTfs(now)            — pure helper, exported for unit tests.
//   evaluateCandidate(...)         — pure evaluator, exported for unit tests.
//   SCANNER_FEED_EXCLUDE           — the current dead-feed set, exported for status endpoint.
//   getScannerStatus()             — full status blob for the telemetry endpoint.

import type { OHLCV } from "../lab/engine";
import {
  fetchOHLCV,
  prefetchCachedOHLCV,
  completeCachedOHLCVTail,
  isNonCryptoMarketOpen,
  isAbortError,
  isCacheDegradedError,
  setDatafeedIncidentReporter,
  MONEY_CANDLE_POLICY,
  type CandleProvenance,
  type ProvenancedOHLCV,
} from "../lab/datafeed";
import { recordCriticalError } from "../error-log";
import { marketToDatafeedTicker } from "./context-builder";
import { getFlashMarketSpecs } from "../protocol/flash/flash-markets";
import { getAdapter } from "../protocol/adapter-registry";
import { detectWM, type WMFormation } from "./wm-detector";
import { detectPivots, classifyDow, type DowClassification } from "./dow-structure";
import { getSessionContext } from "./session-context";
import { isMultiplierMarketQuarantined } from "./multiplier-market-quarantine";
import { appendTelemetry } from "../telemetry";

// ─── Feed-dead set (module-top const — edit-and-redeploy, no runtime config) ──
//
// These markets are owner-confirmed broken feeds (re-confirmed 2026-07-15 via WO-0):
//   NATGAS-PERP:                  Pyth Benchmarks has no natural-gas history feed
//                                 (datafeed.ts comment ~line 80; deliberately absent from
//                                 NON_CRYPTO_PYTH_MAP).
//   CL-PERP / CRUDEOIL-PERP:     Candle history works (USOILSPOT mapping exists) but the
//                                 live on-chain price path is broken (no Pyth shard-0
//                                 account) — scanner must never pick a market the executor
//                                 cannot price.
//   SPCX-PERP:                   "Symbol SPCX doesn't exist" (re-confirmed dead 2026-07-15).
//   SKHYNIX-PERP / SAMSUNG-PERP / URNM-PERP / COPPER-PERP / BP-PERP:
//                                 No OKX / Gate / Pyth source.
//
// Re-verify with `scripts/scanner-feed-audit.mjs` (WO-0) before EVER removing
// an entry. Whichever of these each venue actually lists is filtered out at
// universe-build time (the set covers all venue spellings).
export const SCANNER_FEED_EXCLUDE = new Set<string>([
  "NATGAS-PERP",
  "CL-PERP",
  "CRUDEOIL-PERP",
  "SPCX-PERP",
  "SKHYNIX-PERP",
  "SAMSUNG-PERP",
  "URNM-PERP",
  "COPPER-PERP",
  "BP-PERP",
]);

// ─── Timeframe constants ──────────────────────────────────────────────────────

const TIMEFRAME_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h":  60 * 60_000,
  "4h":  4  * 60 * 60_000,
  "1d":  24 * 60 * 60_000,
};

const SCANNER_CONSUMPTION_BOUNDARY_MS = 900_000;

export function getScannerConsumptionBoundary(nowMs: number): {
  boundaryStart: Date;
  expiresAt: Date;
} {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("scanner consumption time must be finite");
  }
  const boundaryStartMs =
    Math.floor(nowMs / SCANNER_CONSUMPTION_BOUNDARY_MS) * SCANNER_CONSUMPTION_BOUNDARY_MS;
  return {
    boundaryStart: new Date(boundaryStartMs),
    expiresAt: new Date(boundaryStartMs + SCANNER_CONSUMPTION_BOUNDARY_MS),
  };
}

// Parent TF for Dow trend context (same parent map as context-builder.ts).
// 1d has no parent (null = skip parent check).
const PARENT_TF: Record<string, string | null> = {
  "15m": "1h",
  "1h":  "4h",
  "4h":  "1d",
  "1d":  null,
};

// ─── Configuration ────────────────────────────────────────────────────────────

const INDICATOR_BARS          = 400;          // bars fetched per TF per market
const UNIVERSE_CACHE_TTL_MS   = 60 * 60_000; // 1h universe list cache per protocol
const FEED_HEALTH_TTL_MS      = 30 * 60_000; // 30-min feed-dead TTL (mirrors datafeed negcaches)
const MAX_CONCURRENT_FETCHES  = 3;            // max in-flight fetchOHLCV calls
const FETCH_STAGGER_MS        = 150;          // ≥150ms between consecutive dispatches
const SWEEP_BUDGET_MS         = 55_000;       // abort remaining markets after this
const TOP_K                   = 3;            // max candidates per protocol per boundary
const RING_BUFFER_MAX         = 200;          // max telemetry ring-buffer entries
/** Maximum closed bars allowed after a confirmed neckline break for an unexhausted retest. */
export const MAX_POST_BREAK_RETURN_AGE_BARS = 4;

// Protocols scanned. Flash scanner bots are paper-only today (go-live is Pacifica-only).
const PROTOCOLS = ["flash", "pacifica"] as const;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScannerCandidate {
  protocol: string;
  market: string;
  timeframe: string;
  direction: "long" | "short";
  setup: "W" | "M";
  /**
   * Deterministic score:
   *   100 − necklineDistancePct×40 + (parentAligned ? 20 : 0) − (thinSession ? 10 : 0)
   * Rationale (do NOT tune in v1):
   *   distance dominates within the 0.5% actionable window (max −20 at 0.5%);
   *   parent alignment is the strong secondary signal (+20);
   *   session is a minor penalty (−10 during weekend thin liquidity).
   */
  score: number;
  /**
   * |currentPriceDistFromNeckline| × 100  (percentage, e.g. 0.3 for 0.3% away).
   * Max possible value = 0.5 (at the edge of the NECKLINE_WINDOW actionability gate).
   */
  necklineDistancePct: number;
  /**
   * Parent-TF Dow classification: "HH/HL", "LH/LL", "mixed", or "insufficient".
   * "none" when no parent TF exists (1d primary).
   */
  parentTrend: string;
  evaluatedAt: number;
  /** Provenance of the admitted candle set used for this money-input score. */
  candleProvenance: CandleProvenance | null;
  /** Provenance of the configured parent candle set; null only when no parent TF exists. */
  parentCandleProvenance: CandleProvenance | null;
}

export type ScannerGenerationVerdict = "tradable" | "diagnostic_only";
export type ScannerDiagnosticReason =
  | "interrupted"
  | "accounting_invalid"
  | "unclassified_attempt"
  | "abandoned_attempt"
  | "candidate_provenance_invalid";

export type ScannerCandidateProvenance = Readonly<{
  market: string;
  timeframe: string;
  selected: CandleProvenance;
  requiredParent: CandleProvenance | null;
}>;

export type ScannerSweepManifest = Readonly<{
  generation: number;
  boundaryTimeframes: readonly string[];
  startedAt: number;
  finishedAt: number;
  accounting: Readonly<ScannerAttemptReconciliation>;
  budgetSkippedUnits: number;
  parentCacheDegraded: boolean;
  candidateProvenance: readonly ScannerCandidateProvenance[];
  candidatesByProtocol: ReadonlyMap<string, readonly ScannerCandidate[]>;
  verdict: ScannerGenerationVerdict;
  diagnosticReasons: readonly ScannerDiagnosticReason[];
}>;

export type ScannerAttemptDisposition =
  | "scanned"
  | "feed-health-skipped"
  | "venue-closed"
  | "timeout-skipped"
  | "primary-cache-degraded"
  | "parent-inconclusive"
  | "error"
  | "abandoned";

export interface ScannerAttemptReconciliation {
  attempted: number;
  scanned: number;
  feedHealthSkipped: number;
  venueClosed: number;
  timeoutSkipped: number;
  primaryCacheDegraded: number;
  parentInconclusive: number;
  errors: number;
  abandoned: number;
  unclassified: number;
  accountingValid: boolean;
}

export interface ScannerSweepAccountingLineOptions {
  parentCacheDegraded: number;
  budgetSkippedUnits: number;
  candidates: number;
  durationMs: number;
  fetchBudgetMs?: number;
  errorMessage?: string;
}

export type ScannerSweepCoverageIncident = "blackout" | "partial" | "none";

export interface ScannerSweepIncidentClassification {
  accountingInvalid: boolean;
  coverage: ScannerSweepCoverageIncident;
}

/**
 * Classifies only the durable incident surface. Sweep accounting telemetry is
 * emitted independently before this decision, and manifest tradability is
 * computed independently before incident reporting.
 */
export function classifyScannerSweepIncident(
  accounting: Pick<
    ScannerAttemptReconciliation,
    "attempted" | "scanned" | "timeoutSkipped" | "errors" | "abandoned" | "accountingValid"
  >,
  budgetSkippedUnits: number,
): ScannerSweepIncidentClassification {
  const blackout = accounting.scanned === 0
    && (accounting.attempted > 0 || budgetSkippedUnits > 0);
  return {
    accountingInvalid: !accounting.accountingValid,
    coverage: blackout
      ? "blackout"
      : accounting.errors > 0 || accounting.abandoned > 0
        ? "partial"
        : "none",
  };
}

/**
 * First terminal outcome wins. This keeps an abandoned dispatch terminal even
 * when its underlying promise settles after the bounded teardown window.
 */
export class ScannerAttemptLedger {
  private readonly intended = new Set<string>();
  private readonly terminal = new Map<string, ScannerAttemptDisposition>();

  intend(key: string): void {
    this.intended.add(key);
  }

  finalize(key: string, disposition: ScannerAttemptDisposition): boolean {
    if (!this.intended.has(key) || this.terminal.has(key)) return false;
    this.terminal.set(key, disposition);
    return true;
  }

  reconcile(keys?: readonly string[]): ScannerAttemptReconciliation {
    const selectedKeys = keys ?? [...this.intended];
    const selected = new Set(selectedKeys.filter((key) => this.intended.has(key)));
    const counts: Record<ScannerAttemptDisposition, number> = {
      scanned: 0,
      "feed-health-skipped": 0,
      "venue-closed": 0,
      "timeout-skipped": 0,
      "primary-cache-degraded": 0,
      "parent-inconclusive": 0,
      error: 0,
      abandoned: 0,
    };
    for (const key of selected) {
      const disposition = this.terminal.get(key);
      if (disposition) counts[disposition]++;
    }
    const terminalTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const attempted = selected.size;
    const unclassified = attempted - terminalTotal;
    return {
      attempted,
      scanned: counts.scanned,
      feedHealthSkipped: counts["feed-health-skipped"],
      venueClosed: counts["venue-closed"],
      timeoutSkipped: counts["timeout-skipped"],
      primaryCacheDegraded: counts["primary-cache-degraded"],
      parentInconclusive: counts["parent-inconclusive"],
      errors: counts.error,
      abandoned: counts.abandoned,
      unclassified,
      accountingValid: unclassified === 0 && terminalTotal === attempted,
    };
  }
}

/**
 * Shared TOTAL/ABORT serialization keeps every terminal bucket and auxiliary
 * counter visible on both sweep exit paths.
 */
export function formatScannerSweepAccountingLine(
  kind: "TOTAL" | "ABORT",
  accounting: ScannerAttemptReconciliation,
  options: ScannerSweepAccountingLineOptions,
): string {
  if (kind === "ABORT") {
    const abortCounts =
      `${accounting.attempted} attempted, ${accounting.scanned} scanned, ` +
      `${accounting.feedHealthSkipped} feed-health-skipped, ${accounting.venueClosed} venue-closed, ` +
      `${accounting.timeoutSkipped} timeout-skipped, ${accounting.primaryCacheDegraded} primary-cache-degraded, ` +
      `${accounting.parentInconclusive} parent-inconclusive, ` +
      `${options.parentCacheDegraded} parent-cache-degraded, ${accounting.errors} errors, ` +
      `${accounting.abandoned} abandoned, ${accounting.unclassified} unclassified, ` +
      `accounting=${accounting.accountingValid ? "valid" : "INVALID"}`;
    return `[Scanner] SWEEP ABORT: ${abortCounts}; crashed after ${(options.durationMs / 1000).toFixed(1)}s — ` +
      (options.errorMessage ?? "unknown error");
  }
  const totalCounts =
    `${accounting.attempted} attempted, ${accounting.scanned} scanned, ` +
    `${accounting.feedHealthSkipped} feed-health-skipped, ` +
    `${accounting.timeoutSkipped} skipped-by-timeout, ${accounting.venueClosed} venue-closed, ` +
    `${accounting.errors} errors, ${accounting.abandoned} abandoned, ` +
    `${accounting.primaryCacheDegraded} primary-cache-degraded, ` +
    `${accounting.parentInconclusive} parent-inconclusive, ` +
    `${options.parentCacheDegraded} parent-cache-degraded, ${accounting.unclassified} unclassified, ` +
    `accounting=${accounting.accountingValid ? "valid" : "INVALID"}`;
  return `[Scanner] SWEEP TOTAL: ${totalCounts}, ${options.budgetSkippedUnits} budget-gated units, ` +
    `${options.candidates} candidates in ${(options.durationMs / 1000).toFixed(1)}s ` +
    `(fetch budget ${(options.fetchBudgetMs ?? 0) / 1000}s)`;
}

export interface ScannerBoundaryStats {
  protocol: string;
  timeframe: string;
  sweepStartedAt: number;
  sweepFinishedAt: number;
  durationMs: number;
  marketsAttempted: number;
  marketsScanned: number;
  marketsFresh: number;
  feedHealthSkipped: number;
  marketsClosedSkipped: number;
  marketsSkippedByTimeout: number;
  errorCount: number;
  /** Reads that failed typed with CacheDegradedError (DB/cache pressure) —
   * counted separately: NOT feed-dead, NOT a budget timeout, NOT an error. */
  cacheDegradedCount: number;
  /** Parent-timeframe cache degradation is auxiliary to a scanned primary. */
  parentCacheDegradedCount: number;
  /** Configured parent data was unavailable or not conclusively classifiable. */
  parentInconclusiveCount: number;
  abandonedCount: number;
  unclassifiedCount: number;
  accountingValid: boolean;
  candidateCount: number;
}

export interface ScannerStatus {
  shortlist: Record<string, ScannerCandidate[]>;
  currentGeneration: ScannerGenerationStatus | null;
  lastTradableGeneration: ScannerGenerationStatus | null;
  lastBoundaryStats: ScannerBoundaryStats | null;
  recentHistory: ScannerBoundaryStats[];
  excludedMarkets: string[];
  multiplierQuarantinedMarkets: string[];
  scannerRunning: boolean;
}

export type ScannerGenerationStatus = Omit<ScannerSweepManifest, "candidatesByProtocol"> & {
  candidateCounts: Readonly<Record<string, number>>;
};

// ─── Module state (all bounded) ───────────────────────────────────────────────

// Current ranked shortlist per protocol — replaced wholesale each boundary.
type ScannerPublicationState = Readonly<{
  currentGeneration: ScannerSweepManifest | null;
  lastTradableGeneration: ScannerSweepManifest | null;
}>;

let scannerPublicationState: ScannerPublicationState = Object.freeze({
  currentGeneration: null,
  lastTradableGeneration: null,
});

// Telemetry ring buffer: plain array, push + trim to 200. In-memory only; resets on restart.
const telemetryRing: ScannerBoundaryStats[] = [];

// Universe cache per protocol: { data: market internal symbols[], expiresAt }.
const universeCache = new Map<string, { data: string[]; expiresAt: number }>();
// Successful universe builds replace their protocol's exact quarantine view.
// Status flattens these protocol-scoped sets so stale entries do not accumulate
// across independent cache refreshes.
const multiplierQuarantineByProtocol = new Map<string, Set<string>>();

// Runtime feed-health: datafeed ticker → { failedAt }. 30-min TTL.
// Mirrors datafeed.ts's own negative caches. Closed-market equities/FX drop out
// naturally via the G9 staleness check — do NOT exclude them here statically.
const feedHealthMap = new Map<string, { failedAt: number }>();

// Scheduler state.
// scannerRunning is the AUTHORITATIVE "is the scanner started" flag.
// scannerTimer may be null transiently (between re-arm calls) even while running,
// so it MUST NOT be used as the running/stopped sentinel — that was the recurrence bug.
let scannerRunning = false;
let scannerTimer: ReturnType<typeof setTimeout> | null = null;
let bootCatchUpTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Wedge-proof sweep guard (same pattern as the monitor's tick guard — a plain
 * boolean permanently froze the monitor in prod when one venue call hung).
 * Timestamp + generation: a sweep older than SWEEP_WEDGE_MS is presumed hung
 * (all its awaits are timeout-bounded fetches; a healthy sweep is ≤ ~110s) and
 * a new boundary may override it. Worst case on override is duplicated candle
 * fetches — the shortlist replace at the end is wholesale, so no corruption.
 */
let sweepStartedAt: number | null = null;
let sweepGeneration = 0;
type ScannerSweepOwner = {
  generation: number;
  controller: AbortController;
  children: Set<AbortController>;
};
let activeSweepOwner: ScannerSweepOwner | null = null;
const SWEEP_WEDGE_MS = 5 * 60_000;

class ScannerSweepRevokedError extends Error {
  constructor(readonly generation: number) {
    super(`scanner sweep generation ${generation} no longer owns publication`);
    this.name = "ScannerSweepRevokedError";
  }
}

function ownsScannerSweep(owner: ScannerSweepOwner): boolean {
  return scannerRunning && activeSweepOwner === owner &&
    sweepGeneration === owner.generation && !owner.controller.signal.aborted;
}

function requireScannerSweepOwner(owner: ScannerSweepOwner): void {
  if (!ownsScannerSweep(owner)) throw new ScannerSweepRevokedError(owner.generation);
}

function createSweepChildAbort(owner: ScannerSweepOwner): AbortController {
  const child = new AbortController();
  owner.children.add(child);
  if (owner.controller.signal.aborted) child.abort(owner.controller.signal.reason);
  return child;
}

function releaseSweepChildAbort(owner: ScannerSweepOwner, child: AbortController): void {
  owner.children.delete(child);
}

function revokeScannerSweep(owner: ScannerSweepOwner | null, reason: string): void {
  if (!owner) return;
  if (activeSweepOwner === owner) activeSweepOwner = null;
  if (!owner.controller.signal.aborted) owner.controller.abort(reason);
  for (const child of owner.children) {
    if (!child.signal.aborted) child.abort(reason);
  }
  owner.children.clear();
}

async function withSweepOwnership<T>(owner: ScannerSweepOwner, promise: Promise<T>): Promise<T> {
  if (!ownsScannerSweep(owner)) throw new ScannerSweepRevokedError(owner.generation);
  let onAbort: (() => void) | null = null;
  const revoked = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ScannerSweepRevokedError(owner.generation));
    owner.controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, revoked]);
  } finally {
    if (onAbort) owner.controller.signal.removeEventListener("abort", onAbort);
  }
}
/**
 * Total network-fetch budget for one whole sweep (all protocols, all TFs).
 * Must stay well under SWEEP_WEDGE_MS: the enforced sweep envelope is
 * 240s deadline + 15s drain floor + 8s teardown + 5s margin = 268s
 * (see overrunLimitMs for the authoritative derivation) < 300s wedge
 * window, so the wedge override remains a backstop for truly-hung awaits
 * only — sweeps cannot stack. Abandoned dispatches may settle later in the
 * background (~50s call-chain tail) but never extend the sweep itself.
 */
const SWEEP_FETCH_DEADLINE_TOTAL_MS = 240_000;
/** Per-fetch cap within the sweep budget. */
const SWEEP_PER_FETCH_DEADLINE_MS = 45_000;
/**
 * Minimum drain grace: once a TF's dispatches are in flight, the drain always
 * waits at least this long for them to settle before firing the abort —
 * even past the sweep-global fetch deadline. Aborting instantly at the
 * deadline would abandon healthy near-done fetches and inflate the
 * timeout-skip counts. This floor is PART of the enforced sweep envelope
 * (see overrunLimitMs) — only ONE TF can be draining when the deadline
 * passes, because the TF/market gates stop later units from dispatching.
 */
const SWEEP_DRAIN_FLOOR_MS = 15_000;
/**
 * After the drain cap expires the TF's AbortController fires; aborted
 * dispatches then get this long to unwind cleanly (abort checks + the manual
 * fetch listener make unwind near-instant; this bounds pathological cases —
 * e.g. a wedged DB write — so the sweep still reaches its summary lines).
 * Anything unsettled after this window is ABANDONED and reported by name.
 */
const SWEEP_TEARDOWN_ALLOWANCE_MS = 8_000;
/**
 * Boot catch-up sweep gate: if the next 15m boundary is closer than this,
 * skip the catch-up and just wait for the boundary sweep — double-fetching
 * the whole universe back-to-back wastes datafeed budget for no gain.
 * Must exceed a healthy full-sweep duration (~106-110s observed) so an
 * in-flight catch-up never makes the boundary sweep skip on its claim.
 */
const BOOT_SWEEP_MIN_LEAD_MS = 150_000;
/**
 * How long after startScanner() the boot catch-up sweep may begin. 2026-07-19
 * incident: the catch-up fired immediately at scanner start (boot+86s) — dead
 * center of the staggered-startup DB storm — and degraded to "0 scanned,
 * 89 timeout-skipped" because candle-cache reads waited 46s+ for a pool
 * connection. The delay (plus the pool-headroom gate at execution time) moves
 * the sweep past the boot window entirely.
 */
const BOOT_SWEEP_DELAY_MS = 120_000;

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Determine which timeframes to scan at a given boundary time.
 *
 * Call with the Date at the boundary (timer fires approximately 2s after the
 * UTC 15m boundary — still the same minute, so getUTCMinutes() is reliable).
 *
 *   21:15 UTC → ["15m"]
 *   22:00 UTC → ["15m", "1h"]
 *   00:00 UTC → ["15m", "1h", "4h", "1d"]
 *   04:00 UTC → ["15m", "1h", "4h"]
 */
export function getBoundaryTfs(now: Date): string[] {
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const tfs: string[] = ["15m"];
  if (m === 0) {
    tfs.push("1h");
    if (h % 4 === 0) tfs.push("4h");
    if (h === 0)     tfs.push("1d");
  }
  return tfs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Sweep fetch-error classification (pure, exported for unit tests) ─────────
//
// Ordering is a load-bearing invariant (2026-07-20 incident):
//   1. Sweep-budget cancellation FIRST — our doing, never the feed's fault.
//      Detected via the SWEEP signal state, not err.name alone, because
//      fetchOHLCV's internal per-call timeout also surfaces as AbortError.
//   2. DB/cache pressure SECOND — a CacheDegradedError says nothing about the
//      feed. It must NEVER be classified as feed-dead (30-min exclusion would
//      silently blind that market) and never as a budget timeout or error.
//   3. Everything else = genuine feed error → 30-min feed-dead exclusion.

export type SweepFetchDisposition = "timeout-skip" | "cache-degraded" | "feed-error";

export function classifySweepFetchError(
  err: unknown,
  sweepAborted: boolean,
): SweepFetchDisposition {
  if (sweepAborted && isAbortError(err)) return "timeout-skip";
  if (isCacheDegradedError(err)) return "cache-degraded";
  return "feed-error";
}

export interface UnexpectedDispatchSettlement {
  disposition: ScannerAttemptDisposition;
  finalized: boolean;
  shouldLog: boolean;
}

/**
 * Classify and terminally settle failures that escape a market dispatch's
 * inner fetch handling. The first settlement owns both the count and logging.
 */
export function settleUnexpectedScannerDispatch(
  ledger: ScannerAttemptLedger,
  attemptKey: string,
  err: unknown,
  sweepAborted: boolean,
): UnexpectedDispatchSettlement {
  const classified = classifySweepFetchError(err, sweepAborted);
  const disposition: ScannerAttemptDisposition =
    classified === "timeout-skip"
      ? "timeout-skipped"
      : classified === "cache-degraded"
        ? "primary-cache-degraded"
        : "error";
  const finalized = ledger.finalize(attemptKey, disposition);
  return {
    disposition,
    finalized,
    shouldLog: finalized && disposition === "error",
  };
}

/** Parent-cache degradation is auxiliary; it never replaces the attempt's terminal result. */
export function countParentCacheDegradation(current: number, err: unknown): number {
  return current + (isCacheDegradedError(err) ? 1 : 0);
}

function isAdmissibleScannerProvenance(provenance: CandleProvenance | null): provenance is CandleProvenance {
  return provenance !== null
    && provenance.source !== "unknown"
    && provenance.venue !== "unknown"
    && provenance.basis !== "unknown"
    && provenance.proxy !== "unknown"
    && provenance.finality !== "unknown"
    && provenance.timeSemantic !== "unknown"
    && MONEY_CANDLE_POLICY.acceptedBasis.includes(provenance.basis)
    && MONEY_CANDLE_POLICY.acceptedFinality.includes(provenance.finality)
    && MONEY_CANDLE_POLICY.acceptedProxy.includes(provenance.proxy);
}

export interface ScannerManifestInput {
  generation: number;
  boundaryTimeframes: readonly string[];
  startedAt: number;
  finishedAt: number;
  accounting: ScannerAttemptReconciliation;
  budgetSkippedUnits: number;
  parentCacheDegraded: boolean;
  candidatesByProtocol: ReadonlyMap<string, readonly ScannerCandidate[]>;
  completed: boolean;
}

export function createScannerSweepManifest(input: ScannerManifestInput): ScannerSweepManifest {
  const candidates = [...input.candidatesByProtocol.values()].flatMap((entries) => [...entries]);
  const candidateProvenance = candidates.flatMap((candidate): ScannerCandidateProvenance[] => {
    if (!candidate.candleProvenance) return [];
    return [{
      market: candidate.market,
      timeframe: candidate.timeframe,
      selected: candidate.candleProvenance,
      requiredParent: candidate.parentCandleProvenance,
    }];
  });
  const provenanceValid = candidates.every((candidate) => {
    if (!isAdmissibleScannerProvenance(candidate.candleProvenance)) return false;
    const configuredParent = PARENT_TF[candidate.timeframe] ?? null;
    return configuredParent === null
      ? candidate.parentCandleProvenance === null
      : isAdmissibleScannerProvenance(candidate.parentCandleProvenance);
  });
  const diagnosticReasons: ScannerDiagnosticReason[] = [];
  if (!input.completed) diagnosticReasons.push("interrupted");
  if (!input.accounting.accountingValid) diagnosticReasons.push("accounting_invalid");
  if (input.accounting.unclassified !== 0) diagnosticReasons.push("unclassified_attempt");
  if (input.accounting.abandoned !== 0) diagnosticReasons.push("abandoned_attempt");
  if (!provenanceValid) diagnosticReasons.push("candidate_provenance_invalid");
  return Object.freeze({
    generation: input.generation,
    boundaryTimeframes: Object.freeze([...input.boundaryTimeframes]),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    accounting: Object.freeze({ ...input.accounting }),
    budgetSkippedUnits: input.budgetSkippedUnits,
    parentCacheDegraded: input.parentCacheDegraded,
    candidateProvenance: Object.freeze(candidateProvenance),
    candidatesByProtocol: input.candidatesByProtocol,
    verdict: diagnosticReasons.length === 0 ? "tradable" : "diagnostic_only",
    diagnosticReasons: Object.freeze(diagnosticReasons),
  });
}

export function publishScannerSweepManifest(manifest: ScannerSweepManifest): boolean {
  const current = scannerPublicationState.currentGeneration;
  if (current && manifest.generation < current.generation) return false;
  scannerPublicationState = Object.freeze({
    currentGeneration: manifest,
    lastTradableGeneration:
      manifest.verdict === "tradable" ? manifest : scannerPublicationState.lastTradableGeneration,
  });
  return true;
}

/** Test-only reset for publication-state acceptance cells. */
export function resetScannerPublicationForTest(): void {
  scannerPublicationState = Object.freeze({ currentGeneration: null, lastTradableGeneration: null });
}

// ─── Core evaluator (pure, exported for unit tests) ───────────────────────────
//
// Takes already-fetched bar arrays so tests can pass synthetic fixtures without
// making any network calls. The sweep orchestration handles fetching.

export type ScannerCandidateEvaluation =
  | { kind: "candidate"; candidate: ScannerCandidate }
  | { kind: "no_candidate" }
  | { kind: "parent_inconclusive"; reason: "parent_inconclusive" };

function allParentFieldsFinite(parentBars: readonly OHLCV[]): boolean {
  return parentBars.every((bar) =>
    Number.isFinite(bar.time) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume));
}

export type ScannerFormationLifecycle =
  | { state: "unknown" }
  | { state: "pre_break" }
  | {
      state: "post_break";
      breakIndex: number;
      breakAgeBars: number;
      measuredTarget: number;
      targetExhausted: boolean;
    };

function isFiniteLifecycleFormation(
  formation: WMFormation,
  closedLastIndex: number,
): boolean {
  return (formation.type === "W" || formation.type === "M")
    && Number.isInteger(formation.extreme2.index)
    && formation.extreme2.index >= 0
    && formation.extreme2.index <= closedLastIndex
    && Number.isFinite(formation.neckline.price)
    && formation.neckline.price > 0
    && Number.isFinite(formation.patternHeight)
    && formation.patternHeight > 0;
}

/**
 * Resolve lifecycle facts that neckline distance alone cannot distinguish.
 * A break is confirmed only by a closed candle after the second extreme.
 * Once a break exists, observed highs/lows through the forming candle count
 * toward measured-move exhaustion because a completed excursion cannot become
 * unspent merely because the latest candle is still forming.
 */
export function classifyScannerFormationLifecycle(
  bars: readonly OHLCV[],
  formation: WMFormation,
): ScannerFormationLifecycle {
  if (bars.length < 2) return { state: "unknown" };

  const closedLastIndex = bars.length - 2;
  if (!isFiniteLifecycleFormation(formation, closedLastIndex)) {
    return { state: "unknown" };
  }

  let breakIndex: number | null = null;
  for (let index = formation.extreme2.index + 1; index <= closedLastIndex; index++) {
    const close = bars[index]?.close;
    if (!Number.isFinite(close)) return { state: "unknown" };
    if ((formation.type === "W" && close > formation.neckline.price)
        || (formation.type === "M" && close < formation.neckline.price)) {
      breakIndex = index;
      break;
    }
  }

  if (breakIndex === null) return { state: "pre_break" };

  const measuredTarget = formation.type === "W"
    ? formation.neckline.price + formation.patternHeight
    : formation.neckline.price - formation.patternHeight;
  if (!Number.isFinite(measuredTarget)) return { state: "unknown" };

  let targetExhausted = false;
  for (let index = breakIndex; index < bars.length; index++) {
    const excursion = formation.type === "W" ? bars[index]?.high : bars[index]?.low;
    if (!Number.isFinite(excursion)) return { state: "unknown" };
    if ((formation.type === "W" && excursion >= measuredTarget)
        || (formation.type === "M" && excursion <= measuredTarget)) {
      targetExhausted = true;
      break;
    }
  }

  return {
    state: "post_break",
    breakIndex,
    breakAgeBars: closedLastIndex - breakIndex,
    measuredTarget,
    targetExhausted,
  };
}

export function isActionableScannerFormationLifecycle(
  lifecycle: ScannerFormationLifecycle,
): boolean {
  if (lifecycle.state === "pre_break") return true;
  return lifecycle.state === "post_break"
    && !lifecycle.targetExhausted
    && lifecycle.breakAgeBars <= MAX_POST_BREAK_RETURN_AGE_BARS;
}

/**
 * Typed evaluator seam. A configured parent that cannot be classified is
 * distinct from an ordinary no-candidate result so missing hard-reject input
 * can never be treated as neutral.
 */
export function evaluateCandidateResult(
  market: string,
  protocol: string,
  bars: OHLCV[],
  parentBars: ProvenancedOHLCV[] | null,
  tf: string,
  now: Date,
): ScannerCandidateEvaluation {
  if (bars.length < 2) return { kind: "no_candidate" };

  const tfMs = TIMEFRAME_MS[tf];
  if (!tfMs) return { kind: "no_candidate" };

  // Applicability belongs to the configured primary timeframe, not to whether
  // a nullable parent value happened to reach this function.
  const parentTf = PARENT_TF[tf] ?? null;
  let parentTrend: string = "none";
  let parentClassification: DowClassification | null = null;
  if (parentTf !== null) {
    if (parentBars === null || !allParentFieldsFinite(parentBars)) {
      return { kind: "parent_inconclusive", reason: "parent_inconclusive" };
    }
    const pivots = detectPivots(parentBars);
    const cls: DowClassification = classifyDow(pivots).classification;
    if (cls === "insufficient") {
      return { kind: "parent_inconclusive", reason: "parent_inconclusive" };
    }
    parentTrend = cls;
    parentClassification = cls;
  }

  // ── Step 1: G9 staleness ──────────────────────────────────────────────────
  // bars[bars.length - 1] is the forming bar / most recent. Its .time is the
  // bar-open timestamp in ms. A fresh bar is one whose open is < 2 intervals ago.
  const newestBarTime = bars[bars.length - 1].time;
  const ageMs = now.getTime() - newestBarTime;
  if (ageMs >= 2 * tfMs) return { kind: "no_candidate" };

  // ── Step 2: W/M detection ─────────────────────────────────────────────────
  // detectWM already enforces NECKLINE_WINDOW (0.5%) actionability criterion.
  const wm = detectWM(bars);
  if (!wm) return { kind: "no_candidate" };

  // Distance cannot distinguish a first approach from a spent post-break return.
  // The structural lifecycle gate is deliberately separate from the v1 score.
  const lifecycle = classifyScannerFormationLifecycle(bars, wm);
  if (!isActionableScannerFormationLifecycle(lifecycle)) {
    return { kind: "no_candidate" };
  }

  const setup: "W" | "M" = wm.type;
  const direction: "long" | "short" = setup === "W" ? "long" : "short";

  // necklineDistancePct: |fraction| × 100 → 0–0.5 percentage points.
  // Max value = NECKLINE_WINDOW × 100 = 0.5. Used in score formula as-is.
  const necklineDistancePct = Math.abs(wm.currentPriceDistFromNeckline) * 100;

  // ── Step 3: Parent-TF Dow alignment ──────────────────────────────────────
  // W-bottom (long) is aligned with HH/HL (parent uptrend); M-top (short)
  // with LH/LL (parent downtrend). Opposing alignment is a hard reject.
  // Neutral / mixed / not-applicable → allow (no +20 bonus on the score).
  let parentAligned = false;
  let parentOpposed = false;

  if (parentClassification !== null) {
    const cls = parentClassification;
    if (setup === "W") {
      // Long setup: HH/HL uptrend = aligned; LH/LL downtrend = opposed.
      if (cls === "LH/LL") parentOpposed = true;
      else if (cls === "HH/HL") parentAligned = true;
    } else {
      // Short setup: LH/LL downtrend = aligned; HH/HL uptrend = opposed.
      if (cls === "HH/HL") parentOpposed = true;
      else if (cls === "LH/LL") parentAligned = true;
    }
  }

  if (parentOpposed) return { kind: "no_candidate" };

  // ── Step 4: Session context ───────────────────────────────────────────────
  // "weekend" = thin liquidity (explicitly flagged in session-context.ts description).
  // Score penalty only — not a hard reject. The LLM + guardrails still gate downstream.
  const sessionCtx = getSessionContext(now);
  const thinSession = sessionCtx.label === "weekend";

  // ── Step 5: Deterministic score ───────────────────────────────────────────
  // Score rationale (do not tune in v1):
  //   distance dominates within the 0.5% actionable window (max −20 at 0.5%);
  //   parent alignment is the strong secondary signal (+20);
  //   session is a minor penalty (−10 during weekend thin liquidity).
  // Scoring range: 70 (0.5% away, misaligned-neutral, thin) → 120 (perfect).
  const score =
    100 -
    necklineDistancePct * 40 +
    (parentAligned ? 20 : 0) -
    (thinSession ? 10 : 0);

  return {
    kind: "candidate",
    candidate: {
      protocol,
      market,
      timeframe: tf,
      direction,
      setup,
      score,
      necklineDistancePct,
      parentTrend,
      evaluatedAt: now.getTime(),
      candleProvenance: (bars[bars.length - 1] as OHLCV & { provenance?: CandleProvenance }).provenance ?? null,
      parentCandleProvenance: parentBars?.[parentBars.length - 1]?.provenance ?? null,
    },
  };
}

/** Compatibility wrapper retained for callers that only distinguish candidate/null. */
export function evaluateCandidate(
  market: string,
  protocol: string,
  bars: OHLCV[],
  parentBars: ProvenancedOHLCV[] | null,
  tf: string,
  now: Date,
): ScannerCandidate | null {
  const result = evaluateCandidateResult(market, protocol, bars, parentBars, tf, now);
  return result.kind === "candidate" ? result.candidate : null;
}

// ─── Universe builder (cached 1h per protocol) ───────────────────────────────

export async function buildScannerUniverse(
  protocol: string,
  mayMutate: () => boolean = () => true,
): Promise<string[]> {
  const cached = universeCache.get(protocol);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  let markets: string[] = [];
  try {
    if (protocol === "flash") {
      const specs = getFlashMarketSpecs();
      markets = specs.map((s) => s.internalSymbol);
    } else {
      const adapter = getAdapter(protocol);
      // Race against a hard cap: getMarkets() is bounded only by
      // AbortSignal.timeout inside the adapter — the exact primitive that
      // failed to fire in the 2026-07-18 hung-fetch incident. If it never
      // settles, this await would wedge the whole sweep BEFORE the dispatch
      // loop's own drain cap can protect it. On timeout we throw into the
      // catch below, which falls back to the stale universe cache.
      const all = await Promise.race([
        adapter.getMarkets(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("getMarkets hard-timeout after 20s")), 20_000),
        ),
      ]);
      markets = all.filter((m) => m.isActive).map((m) => m.internalSymbol);
    }
  } catch (err) {
    if (!mayMutate()) return universeCache.get(protocol)?.data ?? [];
    const line = `[Scanner] universe build failed for ${protocol}: ${err instanceof Error ? err.message : err}`;
    console.error(line);
    appendTelemetry(line);
    // Return stale cache if available, else empty. Never throw.
    const stale = universeCache.get(protocol);
    return stale ? stale.data : [];
  }

  // Quarantine unqualified multiplier identities before the sweep constructs
  // attempt keys or performs any candle fetch. Ordinary feed exclusions stay
  // independent and the exhaustive attempt ledger remains unchanged.
  if (!mayMutate()) return markets.filter(
    (market) => !isMultiplierMarketQuarantined(market) && !SCANNER_FEED_EXCLUDE.has(market),
  );
  multiplierQuarantineByProtocol.set(
    protocol,
    new Set(markets.filter(isMultiplierMarketQuarantined)),
  );
  const filtered = markets.filter(
    (market) => !isMultiplierMarketQuarantined(market) && !SCANNER_FEED_EXCLUDE.has(market),
  );

  universeCache.set(protocol, {
    data: filtered,
    expiresAt: Date.now() + UNIVERSE_CACHE_TTL_MS,
  });
  return filtered;
}

// ─── Sweep orchestration ─────────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  if (sweepStartedAt !== null) {
    const ageMs = Date.now() - sweepStartedAt;
    if (ageMs < SWEEP_WEDGE_MS) {
      const skipLine = `[Scanner] SWEEP SKIP: previous sweep still running (${Math.round(ageMs / 1000)}s) — skipping this boundary`;
      console.log(skipLine);
      appendTelemetry(skipLine);
      return;
    }
    // Mirror to telemetry: this fired at 07:45 on 2026-07-18 but only reached
    // the console, so telemetry showed a sweep vanishing with no exit line and
    // an external log reader diagnosed a phantom "silent flag clear".
    const wedgeLine = `[Scanner] SWEEP WEDGE OVERRIDE: previous sweep wedged for ${Math.round(ageMs / 1000)}s — overriding so scanning continues`;
    console.error(wedgeLine);
    appendTelemetry(wedgeLine);
    revokeScannerSweep(activeSweepOwner, "superseded by wedge recovery");
  }
  const gen = ++sweepGeneration;
  const owner: ScannerSweepOwner = {
    generation: gen,
    controller: new AbortController(),
    children: new Set(),
  };
  activeSweepOwner = owner;
  sweepStartedAt = Date.now();
  const sweepBeganAt = sweepStartedAt;
  // Sweep-global fetch deadline: bounds the WHOLE sweep's network time so a
  // degraded-feed sweep finishes comfortably inside SWEEP_WEDGE_MS and two
  // sweeps can never run concurrently in practice. Each dispatch passes the
  // remaining budget into fetchOHLCV (which cuts pagination/fallbacks at the
  // deadline); dispatches with <5s remaining are skipped outright.
  const fetchDeadlineAt = Date.now() + SWEEP_FETCH_DEADLINE_TOTAL_MS;
  const sweepLedger = new ScannerAttemptLedger();
  let boundaryTfs: string[] = [];
  let sweepCandidates = 0;
  let sweepParentCacheDegraded = 0;
  let budgetSkippedUnits = 0;
  const sweepAbandonedMarkets: string[] = [];
  const allCandidatesByProtocol = new Map<string, ScannerCandidate[]>();
  for (const protocol of PROTOCOLS) allCandidatesByProtocol.set(protocol, []);

  try {
    const now = new Date();
    boundaryTfs = getBoundaryTfs(now);

    // Accumulate candidates across all TFs per protocol, then rank and keep top K.
    // Boundary-level candle cache: shared across ALL protocols and TFs in this sweep.
    // Ensures BTC/USDT 15m candles are fetched exactly once even when both Flash and
    // Pacifica list BTC-PERP (both map to the same datafeed ticker via marketToDatafeedTicker).
    const candleCache = new Map<string, ProvenancedOHLCV[]>();
    const candlePrefixes = new Map<string, ProvenancedOHLCV[]>();
    const batchExactMisses = new Set<string>();

    // Resolve both protocol universes once, then collapse their shared
    // datafeed identities before touching the persistent cache. The finite
    // union is the reviewed symbol-set bound; no arbitrary cap is added.
    const universesByProtocol = new Map<string, string[]>();
    for (const protocol of PROTOCOLS) {
      requireScannerSweepOwner(owner);
      const universe = await withSweepOwnership(
        owner,
        buildScannerUniverse(protocol, () => ownsScannerSweep(owner)),
      );
      requireScannerSweepOwner(owner);
      universesByProtocol.set(protocol, universe);
    }
    const sweepTickers = [...new Set(
      [...universesByProtocol.values()].flat().map(marketToDatafeedTicker),
    )];
    const batchTimeframes = [...new Set([
      ...boundaryTfs,
      ...boundaryTfs.map((tf) => PARENT_TF[tf]).filter((tf): tf is string => tf !== null),
    ])];
    for (const tf of batchTimeframes) {
      requireScannerSweepOwner(owner);
      const remainingMs = fetchDeadlineAt - Date.now();
      if (sweepTickers.length === 0 || remainingMs < 5_000) {
        if (sweepTickers.length > 0) {
          const skippedLine = `[Scanner] BATCH PREFETCH SKIP: ${tf} global budget has ${Math.max(0, remainingMs)}ms remaining`;
          console.log(skippedLine);
          appendTelemetry(skippedLine);
        }
        continue;
      }
      const tfMs = TIMEFRAME_MS[tf];
      const endMs = now.getTime();
      const startMs = endMs - (INDICATOR_BARS + 1) * tfMs;
      const batchStartedAt = Date.now();
      try {
        const prefetched = await withSweepOwnership(owner, prefetchCachedOHLCV(
          sweepTickers,
          tf,
          startMs,
          endMs,
          {
            basisPolicy: MONEY_CANDLE_POLICY,
            signal: owner.controller.signal,
            callerClass: "scanner",
          },
        ));
        requireScannerSweepOwner(owner);
        for (const [ticker, bars] of prefetched.complete) candleCache.set(`${ticker}:${tf}`, bars);
        for (const [ticker, bars] of prefetched.prefixes) candlePrefixes.set(`${ticker}:${tf}`, bars);
        for (const ticker of prefetched.exactMisses) batchExactMisses.add(`${ticker}:${tf}`);
        const batchLine =
          `[Scanner] BATCH PREFETCH: ${tf} requested=${sweepTickers.length} ` +
          `complete=${prefetched.complete.size} prefixes=${prefetched.prefixes.size} ` +
          `misses=${prefetched.exactMisses.size} duration=${Date.now() - batchStartedAt}ms`;
        console.log(batchLine);
        appendTelemetry(batchLine);
      } catch (error) {
        requireScannerSweepOwner(owner);
        const fallbackLine =
          `[Scanner] BATCH PREFETCH FALLBACK: ${tf} requested=${sweepTickers.length} ` +
          `duration=${Date.now() - batchStartedAt}ms reason=${error instanceof Error ? error.name : "unknown"}`;
        console.log(fallbackLine);
        appendTelemetry(fallbackLine);
        // No retry. Every symbol on this timeframe follows the existing
        // per-market path, which retains typed cache-degradation semantics.
      }
    }

    for (const protocol of PROTOCOLS) {
      requireScannerSweepOwner(owner);
      // Genuine wall-clock gate: once the sweep-global fetch budget is spent,
      // no further protocol may start dispatching (previously only checked
      // between markets, so a late protocol still burned real time).
      if (Date.now() >= fetchDeadlineAt) {
        budgetSkippedUnits += boundaryTfs.length;
        const gateLine = `[Scanner] BUDGET GATE: sweep fetch budget exhausted — skipping ${protocol} entirely (${boundaryTfs.length} TF unit(s))`;
        console.log(gateLine);
        appendTelemetry(gateLine);
        continue;
      }
      const universe = universesByProtocol.get(protocol) ?? [];

      // Per-protocol budget clock. The budget used to be measured from the GLOBAL
      // sweep start, which let the first protocol (flash) consume the entire 55s on
      // cold sweeps — pacifica's loop then started with the budget already blown and
      // skipped every market ("Scanning 0 Pacifica markets" in the create modal).
      // Each protocol gets its own window, SCALED by how many TFs are due at this
      // boundary: a flat 55s let the (slow, Pyth-heavy) 15m scan eat the whole
      // window at :00 boundaries, so 1h/4h logged "0 scanned" while ~100s of the
      // global 240s budget sat unused (prod evidence: 04:02 and 07:02 SWEEP TOTAL
      // lines with 98–180 skipped-by-timeout). Cap keeps the worst-case dispatch
      // total at SWEEP_FETCH_DEADLINE_TOTAL_MS across all protocols, preserving
      // the ≈290s < 300s wedge-window margin documented on the constant.
      const protocolBudgetMs = Math.min(
        SWEEP_BUDGET_MS * boundaryTfs.length,
        Math.floor(SWEEP_FETCH_DEADLINE_TOTAL_MS / PROTOCOLS.length),
      );
      const protocolStart = Date.now();

      for (const tf of boundaryTfs) {
        requireScannerSweepOwner(owner);
        // Same wall-clock gate per TF: a budget spent mid-protocol must stop
        // the NEXT timeframe from dispatching, not just the next market.
        if (Date.now() >= fetchDeadlineAt) {
          budgetSkippedUnits++;
          const gateLine = `[Scanner] BUDGET GATE: sweep fetch budget exhausted — skipping ${protocol} ${tf}`;
          console.log(gateLine);
          appendTelemetry(gateLine);
          continue;
        }
        const tfStart = Date.now();
        const parentTf = PARENT_TF[tf] ?? null;
        const tfMs = TIMEFRAME_MS[tf];
        const attemptKeyFor = (market: string) => `${protocol}|${tf}|${market}`;
        const attemptKeys = universe.map(attemptKeyFor);
        for (const key of attemptKeys) sweepLedger.intend(key);
        const finishAttempt = (market: string, disposition: ScannerAttemptDisposition): boolean =>
          sweepLedger.finalize(attemptKeyFor(market), disposition);

        let marketsFresh = 0;
        let parentCacheDegradedCount = 0;
        const tfCandidates: ScannerCandidate[] = [];

        // Real cancellation for this TF's dispatches: when the drain cap
        // expires, aborting unwinds retries/backoffs/pagination/in-flight
        // HTTP inside fetchOHLCV instead of leaving them running blind.
        const tfAbort = createSweepChildAbort(owner);

        // Concurrency tracking (module-local to each TF scan, not shared across TFs).
        let inFlight = 0;
        const pendingPromises: Promise<void>[] = [];
        // Names of markets currently in flight — an abandoned dispatch is
        // reported by NAME, not just a count (formal incident requirement).
        const inFlightMarkets = new Set<string>();

        // Per-market fetch + evaluate, dispatched concurrently (max 3 in flight).
        const dispatchMarket = (market: string): Promise<void> => {
          return (async () => {
            requireScannerSweepOwner(owner);
            const ticker = marketToDatafeedTicker(market);

            // Feed health check: skip if recently failed (mirrors datafeed negcaches).
            const health = feedHealthMap.get(ticker);
            if (health && Date.now() - health.failedAt < FEED_HEALTH_TTL_MS) {
              finishAttempt(market, "feed-health-skipped");
              return;
            }

            // Venue-hours gate: equities outside NYSE hours / FX+metals on the
            // weekend can produce no FRESH candles — the fetch only burns the
            // shared Pyth per-IP rate budget (429 retry storms: prod 10:15/10:30
            // UTC sweeps, 2026-07-18) and its backoff burns our sweep budget.
            // G9 staleness would drop these candidates anyway; skipping the
            // fetch changes no decision. Counted separately — a closed venue
            // must NEVER look like a dead feed or a budget timeout.
            if (!isNonCryptoMarketOpen(ticker, now)) {
              finishAttempt(market, "venue-closed");
              return;
            }

            const endMs = now.getTime();
            const startMs = endMs - (INDICATOR_BARS + 1) * tfMs;
            const startDate = new Date(startMs).toISOString();
            const endDate = new Date(endMs).toISOString();

            let bars: ProvenancedOHLCV[] = [];
            let fetchDeadlineTruncated = false;
            try {
              const cacheKey = `${ticker}:${tf}`;
              if (candleCache.has(cacheKey)) {
                bars = candleCache.get(cacheKey)!;
              } else {
                // Min of BOTH clocks: the global sweep deadline AND this
                // protocol's own budget window. Guarding on the global clock
                // alone let a protocol whose window was nearly spent still
                // dispatch doomed 45s fetches that only died at the
                // between-markets budget check (2026-07-19 sweep post-mortem).
                const remainingMs = Math.min(
                  fetchDeadlineAt - Date.now(),
                  protocolStart + protocolBudgetMs - Date.now(),
                );
                if (remainingMs < 5_000) {
                  // Sweep fetch budget exhausted — skip without marking the
                  // feed dead (this is our budget, not the feed's fault).
                  finishAttempt(market, "timeout-skipped");
                  return;
                }
                const perFetchDeadlineMs = Math.min(
                  SWEEP_PER_FETCH_DEADLINE_MS,
                  remainingMs,
                );
                const fetchStartedAt = Date.now();
                const cachedPrefix = candlePrefixes.get(cacheKey);
                const fetchOptions = {
                  basisPolicy: MONEY_CANDLE_POLICY,
                  deadlineMs: perFetchDeadlineMs,
                  signal: tfAbort.signal,
                  callerClass: "scanner" as const,
                };
                bars = cachedPrefix
                  ? await completeCachedOHLCVTail(
                      ticker,
                      tf,
                      startDate,
                      endDate,
                      cachedPrefix,
                      undefined,
                      fetchOptions,
                    )
                  : await fetchOHLCV(ticker, tf, startDate, endDate, undefined, {
                      ...fetchOptions,
                      basisPolicy: fetchOptions.basisPolicy,
                      bypassCache: batchExactMisses.has(cacheKey),
                    });
                requireScannerSweepOwner(owner);
                // If the fetch came back EMPTY after running out its deadline,
                // treat it as a budget timeout, not a dead feed — a truncated
                // fetch is indistinguishable from a dead feed by bars alone.
                fetchDeadlineTruncated =
                  bars.length === 0 &&
                  Date.now() - fetchStartedAt >= perFetchDeadlineMs - 1_000;
                if (!fetchDeadlineTruncated) {
                  candleCache.set(cacheKey, bars);
                  candlePrefixes.delete(cacheKey);
                  batchExactMisses.delete(cacheKey);
                }
              }
            } catch (err) {
              if (!ownsScannerSweep(owner)) return;
              // Ordering rationale lives on classifySweepFetchError (pure,
              // unit-tested): abort-skip first, cache-degraded second (never
              // feed-dead — the next boundary retries naturally), genuine
              // feed error last.
              const disposition = classifySweepFetchError(err, tfAbort.signal.aborted);
              if (disposition === "timeout-skip") {
                finishAttempt(market, "timeout-skipped");
                return;
              }
              if (disposition === "cache-degraded") {
                finishAttempt(market, "primary-cache-degraded");
                return;
              }
              feedHealthMap.set(ticker, { failedAt: Date.now() });
              finishAttempt(market, "error");
              return;
            }

            if (bars.length === 0) {
              if (fetchDeadlineTruncated) {
                // Our sweep budget cut this fetch short — skip WITHOUT the
                // 30-min feed-dead exclusion; the feed may be perfectly fine.
                finishAttempt(market, "timeout-skipped");
                return;
              }
              // Empty = feed dead for this ticker. Mark and skip.
              feedHealthMap.set(ticker, { failedAt: Date.now() });
              finishAttempt(market, "error");
              return;
            }

            // Track freshness (G9 check mirrored here for logging).
            const newestBarTime = bars[bars.length - 1].time;
            const ageMs = now.getTime() - newestBarTime;

            // Fetch parent-TF bars (use cache to avoid duplicate fetches).
            let parentBars: ProvenancedOHLCV[] | null = null;
            if (parentTf) {
              const parentTfMs = TIMEFRAME_MS[parentTf];
              const parentStartMs = endMs - (INDICATOR_BARS + 1) * parentTfMs;
              const parentCacheKey = `${ticker}:${parentTf}`;
              try {
                if (candleCache.has(parentCacheKey)) {
                  parentBars = candleCache.get(parentCacheKey)!;
                } else {
                  // Min of both clocks — same rationale as the primary fetch guard.
                  const remainingMs = Math.min(
                    fetchDeadlineAt - Date.now(),
                    protocolStart + protocolBudgetMs - Date.now(),
                  );
                  if (remainingMs < 5_000) {
                    // The typed evaluator reports a configured parent as inconclusive.
                    parentBars = null;
                  } else {
                    const parentStartDate = new Date(parentStartMs).toISOString();
                    const parentPrefix = candlePrefixes.get(parentCacheKey);
                    const parentFetchOptions = {
                      basisPolicy: MONEY_CANDLE_POLICY,
                      deadlineMs: Math.min(SWEEP_PER_FETCH_DEADLINE_MS, remainingMs),
                      signal: tfAbort.signal,
                      callerClass: "scanner" as const,
                    };
                    parentBars = parentPrefix
                      ? await completeCachedOHLCVTail(
                          ticker,
                          parentTf,
                          parentStartDate,
                          endDate,
                          parentPrefix,
                          undefined,
                          parentFetchOptions,
                        )
                      : await fetchOHLCV(
                          ticker,
                          parentTf,
                          parentStartDate,
                          endDate,
                          undefined,
                          {
                            ...parentFetchOptions,
                            basisPolicy: parentFetchOptions.basisPolicy,
                            bypassCache: batchExactMisses.has(parentCacheKey),
                          },
                        );
                    requireScannerSweepOwner(owner);
                    candleCache.set(parentCacheKey, parentBars);
                    candlePrefixes.delete(parentCacheKey);
                    batchExactMisses.delete(parentCacheKey);
                  }
                }
              } catch (err) {
                if (!ownsScannerSweep(owner)) return;
                // Parent fetch failure is non-fatal, but degraded reads are
                // still counted so DB pressure stays visible in the summary.
                parentCacheDegradedCount = countParentCacheDegradation(
                  parentCacheDegradedCount,
                  err,
                );
                parentBars = null;
              }
            }

            const evaluation = evaluateCandidateResult(market, protocol, bars, parentBars, tf, now);
            if (evaluation.kind === "parent_inconclusive") {
              // marketsFresh remains a subset of successfully scanned attempts;
              // a fresh primary with an inconclusive parent is not counted there.
              finishAttempt(market, "parent-inconclusive");
              return;
            }
            const candidate = evaluation.kind === "candidate" ? evaluation.candidate : null;
            if (finishAttempt(market, "scanned")) {
              if (ageMs < 2 * tfMs) marketsFresh++;
              if (candidate) tfCandidates.push(candidate);
            }
          })().catch((err) => {
            if (!ownsScannerSweep(owner)) return;
            // Dispatches must NEVER reject: a single rejection would blow up
            // the drain's Promise.all and abort the whole sweep. Anything
            // reaching here escaped the inner catches (e.g. an evaluator bug).
            const settlement = settleUnexpectedScannerDispatch(
              sweepLedger,
              attemptKeyFor(market),
              err,
              tfAbort.signal.aborted,
            );
            if (!settlement.shouldLog) return;
            const dispatchErrLine = `[Scanner] DISPATCH ERROR: ${market} ${tf} — ${err instanceof Error ? err.message : err}`;
            console.error(dispatchErrLine);
            appendTelemetry(dispatchErrLine);
          });
        };

        // Dispatch loop: max 3 concurrent + ≥150ms stagger between dispatches.
        for (let i = 0; i < universe.length; i++) {
          requireScannerSweepOwner(owner);
          const market = universe[i];

          // Check BOTH clocks: this protocol's window AND the sweep-global
          // fetch deadline. Prod 2026-07-20 01:04 sweep: the loop only watched
          // the protocol clock, so after the global 240s deadline passed it
          // kept iterating (stagger sleeps + slot waits) for ~13s of pure
          // grind before the drain even started — pushing the sweep to 278s.
          if (Date.now() - protocolStart > protocolBudgetMs || Date.now() >= fetchDeadlineAt) {
            for (let skipped = i; skipped < universe.length; skipped++) {
              finishAttempt(universe[skipped], "timeout-skipped");
            }
            break;
          }

          // Wait for a semaphore slot (busy-wait in 10ms slices). MUST stay
          // budget-bounded: if all 3 in-flight dispatches hang (2026-07-18: a
          // single never-settling OKX fetch), an uncapped wait here would spin
          // forever and the budget check above (only evaluated between
          // markets) could never fire again.
          let slotWaitTimedOut = false;
          while (inFlight >= MAX_CONCURRENT_FETCHES) {
            // Same both-clocks rule as the loop gate above: a slot wait must
            // not outlive the sweep-global fetch deadline either.
            if (Date.now() - protocolStart > protocolBudgetMs || Date.now() >= fetchDeadlineAt) {
              slotWaitTimedOut = true;
              break;
            }
            await sleep(10);
            requireScannerSweepOwner(owner);
          }
          if (slotWaitTimedOut) {
            for (let skipped = i; skipped < universe.length; skipped++) {
              finishAttempt(universe[skipped], "timeout-skipped");
            }
            break;
          }
          inFlight++;
          inFlightMarkets.add(market);
          const p = dispatchMarket(market).finally(() => {
            inFlight--;
            inFlightMarkets.delete(market);
          });
          pendingPromises.push(p);

          // ≥150ms stagger between dispatch initiations (spec: sleep after dispatch).
          // Only pay it when this dispatch can actually hit the network: a market
          // whose primary+parent bars are already in the per-sweep cache (or whose
          // feed is health-skipped) does no fetch, and staggering those burned the
          // 55s budget at multi-TF boundaries (00:00 UTC: ~400 dispatches × 150ms
          // ≈ 60s of pure sleep → Pacifica 4h/1d systematically skipped).
          const staggerTicker = marketToDatafeedTicker(market);
          const staggerHealth = feedHealthMap.get(staggerTicker);
          const healthSkipped = !!staggerHealth && Date.now() - staggerHealth.failedAt < FEED_HEALTH_TTL_MS;
          const venueClosed = !isNonCryptoMarketOpen(staggerTicker, now);
          const fullyCached =
            candleCache.has(`${staggerTicker}:${tf}`) &&
            (!parentTf || candleCache.has(`${staggerTicker}:${parentTf}`));
          if (!healthSkipped && !venueClosed && !fullyCached) {
            await sleep(FETCH_STAGGER_MS);
            requireScannerSweepOwner(owner);
          }
        }

        // Wait for all in-flight fetches to finish — but NEVER unboundedly.
        // Prod incident 2026-07-18 07:30 UTC: one OKX fetch never settled (its
        // AbortSignal.timeout never fired), this Promise.all waited on it
        // forever, and the sweep wedged silently for 900s with no exit line.
        // Drain deadline honours ALL THREE clocks (this protocol's window, the
        // sweep-global fetch budget, the wedge backstop): previously only the
        // wedge clock applied, so one hung fetch let the drain legally sit for
        // ~4 minutes — inside the "240s budget" the summary line claimed.
        const drainDeadlineAt = Math.min(
          protocolStart + protocolBudgetMs,
          fetchDeadlineAt,
          sweepBeganAt + SWEEP_WEDGE_MS - 30_000,
        );
        const drainCapMs = Math.max(SWEEP_DRAIN_FLOOR_MS, drainDeadlineAt - Date.now());
        const drained = await withSweepOwnership(owner, Promise.race([
          Promise.all(pendingPromises).then(() => true),
          sleep(drainCapMs).then(() => false),
        ]));
        requireScannerSweepOwner(owner);
        if (!drained) {
          // REAL cancellation (the fix for the 2026-07-19 incident): abort the
          // TF's signal so every in-flight fetch chain unwinds — retries,
          // backoff sleeps, pagination, and the HTTP calls themselves.
          tfAbort.abort();
          const cancelLine =
            `[Scanner] SWEEP DRAIN CAP: ${inFlight} dispatch(es) still running after ` +
            `${Math.round(drainCapMs / 1000)}s (${protocol} ${tf}) — CANCELLING them (abort signal fired)`;
          console.error(cancelLine);
          appendTelemetry(cancelLine);
          // Bounded teardown: aborted dispatches settle near-instantly via the
          // abort checks; give pathological cases a short window, then abandon.
          const settledInTime = await withSweepOwnership(owner, Promise.race([
            Promise.allSettled(pendingPromises).then(() => true),
            sleep(SWEEP_TEARDOWN_ALLOWANCE_MS).then(() => false),
          ]));
          requireScannerSweepOwner(owner);
          if (!settledInTime) {
            const abandoned = [...inFlightMarkets];
            for (const m of abandoned) {
              if (
                finishAttempt(m, "abandoned") &&
                sweepAbandonedMarkets.length < 20
              ) {
                sweepAbandonedMarkets.push(`${protocol}:${m}:${tf}`);
              }
            }
            const hangLine =
              `[Scanner] SWEEP HANG: ${abandoned.length} dispatch(es) ignored cancellation for ` +
              `${SWEEP_TEARDOWN_ALLOWANCE_MS / 1000}s (${protocol} ${tf}) — abandoning: ${abandoned.join(", ") || "unknown"}`;
            console.error(hangLine);
            appendTelemetry(hangLine);
            // Swallow any late rejection from abandoned promises.
            for (const p of pendingPromises) p.catch(() => {});
          }
        }
        releaseSweepChildAbort(owner, tfAbort);

        const accounting = sweepLedger.reconcile(attemptKeys);

        if (accounting.timeoutSkipped > 0) {
          const timeoutLine = `[Scanner] TIMEOUT: ${accounting.timeoutSkipped} markets skipped (${protocol} ${tf})`;
          console.log(timeoutLine);
          appendTelemetry(timeoutLine);
        }

        if (accounting.venueClosed > 0) {
          const closedLine = `[Scanner] CLOSED: ${accounting.venueClosed} markets skipped (${protocol} ${tf}, venue closed)`;
          console.log(closedLine);
          appendTelemetry(closedLine);
        }

        if (accounting.feedHealthSkipped > 0) {
          const feedHealthLine = `[Scanner] FEED HEALTH: ${accounting.feedHealthSkipped} negative-cache skips (${protocol} ${tf})`;
          console.log(feedHealthLine);
          appendTelemetry(feedHealthLine);
        }

        if (accounting.primaryCacheDegraded > 0 || parentCacheDegradedCount > 0) {
          const degradedLine =
            `[Scanner] CACHE DEGRADED: ${accounting.primaryCacheDegraded} primary-terminal, ` +
            `${parentCacheDegradedCount} parent-auxiliary (${protocol} ${tf}) — no network fallback, retry next boundary`;
          console.log(degradedLine);
          appendTelemetry(degradedLine);
        }

        sweepCandidates += tfCandidates.length;
        sweepParentCacheDegraded += parentCacheDegradedCount;
        requireScannerSweepOwner(owner);

        // Accumulate this TF's candidates into the per-protocol pool.
        const pool = allCandidatesByProtocol.get(protocol)!;
        for (const c of tfCandidates) pool.push(c);

        // Telemetry ring buffer (bounded at 200 entries).
        const tfFinish = Date.now();
        const stats: ScannerBoundaryStats = {
          protocol,
          timeframe: tf,
          sweepStartedAt: tfStart,
          sweepFinishedAt: tfFinish,
          durationMs: tfFinish - tfStart,
          marketsAttempted: accounting.attempted,
          marketsScanned: accounting.scanned,
          marketsFresh,
          feedHealthSkipped: accounting.feedHealthSkipped,
          marketsClosedSkipped: accounting.venueClosed,
          marketsSkippedByTimeout: accounting.timeoutSkipped,
          errorCount: accounting.errors,
          cacheDegradedCount: accounting.primaryCacheDegraded,
          parentCacheDegradedCount,
          parentInconclusiveCount: accounting.parentInconclusive,
          abandonedCount: accounting.abandoned,
          unclassifiedCount: accounting.unclassified,
          accountingValid: accounting.accountingValid,
          candidateCount: tfCandidates.length,
        };
        telemetryRing.push(stats);
        if (telemetryRing.length > RING_BUFFER_MAX) {
          telemetryRing.splice(0, telemetryRing.length - RING_BUFFER_MAX);
        }

        // Per-protocol per-TF log line.
        const candStr = tfCandidates
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_K)
          .map((c) => `${c.market} ${c.setup} ${Math.round(c.score)}`)
          .join(", ");
        const durationSec = ((tfFinish - tfStart) / 1000).toFixed(1);
        const sweepLine =
          `[Scanner] ${protocol} ${tf}: ${accounting.scanned} scanned, ${marketsFresh} fresh, ` +
          `${accounting.parentInconclusive} parent-inconclusive, ` +
          `${tfCandidates.length} candidates${tfCandidates.length > 0 ? ` (${candStr})` : ""} in ${durationSec}s`;
        console.log(sweepLine);
        appendTelemetry(sweepLine);
      } // end TF loop
    } // end protocol loop

    // Rank locally, then publish candidates and their final governing verdict
    // through one atomic replacement before any diagnostic sink is invoked.
    const rankedCandidatesByProtocol = new Map<string, readonly ScannerCandidate[]>();
    for (const protocol of PROTOCOLS) {
      const all = allCandidatesByProtocol.get(protocol) ?? [];
      all.sort((a, b) => b.score - a.score);
      rankedCandidatesByProtocol.set(protocol, Object.freeze(all.slice(0, TOP_K)));
    }

    // One-line sweep summary: total time vs. fetch budget + starvation signal.
    const sweepDurationMs = Date.now() - sweepBeganAt;
    const sweepAccounting = sweepLedger.reconcile();
    requireScannerSweepOwner(owner);
    publishScannerSweepManifest(createScannerSweepManifest({
      generation: gen,
      boundaryTimeframes: boundaryTfs,
      startedAt: sweepBeganAt,
      finishedAt: Date.now(),
      accounting: sweepAccounting,
      budgetSkippedUnits,
      parentCacheDegraded: sweepParentCacheDegraded > 0,
      candidatesByProtocol: rankedCandidatesByProtocol,
      completed: true,
    }));
    const sweepSummary = formatScannerSweepAccountingLine("TOTAL", sweepAccounting, {
      parentCacheDegraded: sweepParentCacheDegraded,
      budgetSkippedUnits,
      candidates: sweepCandidates,
      durationMs: sweepDurationMs,
      fetchBudgetMs: SWEEP_FETCH_DEADLINE_TOTAL_MS,
    });
    console.log(sweepSummary);
    appendTelemetry(sweepSummary);

    // ── Formal incident reporting (error_log, category "scanner") ──────────
    // Telemetry lines are diagnostics; these rows are the ALERTABLE record —
    // /api/logs/summary surfaces them to the external log-reader cron.
    const incidentContext: Record<string, unknown> = {
      pid: process.pid,
      env: process.env.NODE_ENV || "development",
      uptimeSec: Math.round(process.uptime()),
      boundaryTfs,
      attempted: sweepAccounting.attempted,
      scanned: sweepAccounting.scanned,
      feedHealthSkipped: sweepAccounting.feedHealthSkipped,
      skippedByTimeout: sweepAccounting.timeoutSkipped,
      venueClosed: sweepAccounting.venueClosed,
      errors: sweepAccounting.errors,
      abandoned: sweepAccounting.abandoned,
      primaryCacheDegraded: sweepAccounting.primaryCacheDegraded,
      parentCacheDegraded: sweepParentCacheDegraded,
      parentInconclusive: sweepAccounting.parentInconclusive,
      unclassified: sweepAccounting.unclassified,
      accountingValid: sweepAccounting.accountingValid,
      budgetSkippedUnits,
      candidates: sweepCandidates,
      durationMs: sweepDurationMs,
      ...(sweepAbandonedMarkets.length > 0 ? { abandonedMarkets: sweepAbandonedMarkets } : {}),
    };
    const incidentClassification = classifyScannerSweepIncident(
      sweepAccounting,
      budgetSkippedUnits,
    );
    if (incidentClassification.accountingInvalid) {
      recordCriticalError({
        category: "scanner",
        severity: "critical",
        source: "scanner-sweep",
        message: `Scanner accounting invalid: ${sweepAccounting.unclassified} of ${sweepAccounting.attempted} attempts unclassified`,
        context: incidentContext,
      });
    }
    if (incidentClassification.coverage === "blackout") {
      // Blackout: intended work or whole budget-gated units produced no scan.
      recordCriticalError({
        category: "scanner",
        severity: "critical",
        source: "scanner-sweep",
        message:
          `Scanner blackout: 0 of ${sweepAccounting.attempted} markets scanned ` +
          `(${sweepAccounting.feedHealthSkipped} feed-health-skipped, ` +
          `${sweepAccounting.timeoutSkipped} timeout-skipped, ` +
          `${sweepAccounting.parentInconclusive} parent-inconclusive, ${sweepAccounting.errors} errors, ` +
          `${budgetSkippedUnits} budget-gated unit(s))`,
        context: incidentContext,
      });
    } else if (incidentClassification.coverage === "partial") {
      // Real attempt failures and abandoned work remain alertable. Bounded
      // budget/timeout partials stay visible in the TOTAL telemetry line.
      recordCriticalError({
        category: "scanner",
        severity: "error",
        source: "scanner-sweep",
        message:
          `Scanner partial sweep: ${sweepAccounting.scanned}/${sweepAccounting.attempted} scanned, ` +
          `${sweepAccounting.feedHealthSkipped} feed-health-skipped, ` +
          `${sweepAccounting.timeoutSkipped} timeout-skipped, ${sweepAccounting.abandoned} abandoned, ` +
          `${budgetSkippedUnits} budget-gated unit(s)`,
        context: incidentContext,
      });
    }
    // Overrun check is INDEPENDENT of the scan-coverage verdict: a sweep can
    // scan everything yet still prove the budget enforcement is broken.
    // The limit is the TRUE enforced envelope, term by term:
    //   fetch deadline (240s): no new dispatches after this — the market loop
    //     and slot waits gate on it (both-clocks fix, 2026-07-20);
    //   + drain floor (15s): the ONE in-flight TF still gets its minimum
    //     settling grace before the abort fires;
    //   + teardown allowance (8s): aborted dispatches' bounded unwind window;
    //   + 5s margin: scoring/persist/summary after the last drain.
    // = 268s. The previous 253s limit omitted the drain floor, so it fired
    // critical alerts on by-design behaviour (prod 2026-07-20 01:04, 278.3s —
    // of which ~13s was the real loop-grind bug fixed above, the rest the
    // unbudgeted drain floor). Anything past THIS limit means an enforcement
    // gate genuinely failed. Still < the 270s wedge-drain clamp and 300s
    // wedge window, so sweeps cannot stack.
    const overrunLimitMs =
      SWEEP_FETCH_DEADLINE_TOTAL_MS + SWEEP_DRAIN_FLOOR_MS + SWEEP_TEARDOWN_ALLOWANCE_MS + 5_000;
    if (sweepDurationMs > overrunLimitMs) {
      recordCriticalError({
        category: "scanner",
        severity: "critical",
        source: "scanner-sweep",
        message: `Scanner budget overrun: sweep ran ${(sweepDurationMs / 1000).toFixed(1)}s (hard limit ${(overrunLimitMs / 1000).toFixed(0)}s)`,
        context: incidentContext,
      });
    }
  } catch (err) {
    if (err instanceof ScannerSweepRevokedError || !ownsScannerSweep(owner)) {
      const cancelledLine = `[Scanner] SWEEP CANCELLED: generation ${gen} lost lifecycle ownership`;
      console.log(cancelledLine);
      appendTelemetry(cancelledLine);
      return;
    }
    // Invariant: no sweep may end without a SWEEP TOTAL or SWEEP ABORT line
    // reaching telemetry — external log readers only see the telemetry file.
    const abortAccounting = sweepLedger.reconcile();
    publishScannerSweepManifest(createScannerSweepManifest({
      generation: gen,
      boundaryTimeframes: boundaryTfs,
      startedAt: sweepBeganAt,
      finishedAt: Date.now(),
      accounting: abortAccounting,
      budgetSkippedUnits,
      parentCacheDegraded: sweepParentCacheDegraded > 0,
      candidatesByProtocol: new Map(
        [...allCandidatesByProtocol].map(([protocol, entries]) => [
          protocol,
          Object.freeze([...entries].sort((a, b) => b.score - a.score).slice(0, TOP_K)),
        ]),
      ),
      completed: false,
    }));
    const abortLine = formatScannerSweepAccountingLine("ABORT", abortAccounting, {
      parentCacheDegraded: sweepParentCacheDegraded,
      budgetSkippedUnits,
      candidates: sweepCandidates,
      durationMs: Date.now() - sweepBeganAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    console.error(abortLine);
    appendTelemetry(abortLine);
    recordCriticalError({
      category: "scanner",
      severity: "critical",
      source: "scanner-sweep",
      message: `Scanner sweep crashed after ${((Date.now() - sweepBeganAt) / 1000).toFixed(1)}s`,
      error: err,
      context: {
        pid: process.pid,
        env: process.env.NODE_ENV || "development",
        uptimeSec: Math.round(process.uptime()),
        boundaryTfs,
        attempted: abortAccounting.attempted,
        scanned: abortAccounting.scanned,
        feedHealthSkipped: abortAccounting.feedHealthSkipped,
        venueClosed: abortAccounting.venueClosed,
        skippedByTimeout: abortAccounting.timeoutSkipped,
        primaryCacheDegraded: abortAccounting.primaryCacheDegraded,
        parentCacheDegraded: sweepParentCacheDegraded,
        errors: abortAccounting.errors,
        abandoned: abortAccounting.abandoned,
        unclassified: abortAccounting.unclassified,
        accountingValid: abortAccounting.accountingValid,
        budgetSkippedUnits,
        candidates: sweepCandidates,
        ...(sweepAbandonedMarkets.length > 0 ? { abandonedMarkets: sweepAbandonedMarkets } : {}),
      },
    });
  } finally {
    for (const child of owner.children) {
      if (!child.signal.aborted) child.abort("sweep finished");
    }
    owner.children.clear();
    if (activeSweepOwner === owner) activeSweepOwner = null;
    // Only clear our own claim — a wedged sweep that resumes after an override
    // must not wipe the newer sweep's timestamp.
    if (gen === sweepGeneration) sweepStartedAt = null;
  }
}

/** Runs the production sweep path directly for lifecycle race tests. */
export function runScannerSweepForTest(): Promise<void> {
  if (!scannerRunning) throw new Error("scanner must be started before running a test sweep");
  return runSweep();
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function scheduleNextScan(): void {
  // Use the explicit running flag — NOT scannerTimer — as the stopped sentinel.
  // scannerTimer is null transiently between the callback fire and setTimeout() returning;
  // using it as the guard caused the original recurrence bug (only one sweep fired).
  if (!scannerRunning) return;

  const now = Date.now();
  const tfMs = TIMEFRAME_MS["15m"];
  // Next 15m boundary + 2s settle so candles for the closing bar are committed.
  const delay = (Math.floor(now / tfMs) + 1) * tfMs - now + 2_000;

  scannerTimer = setTimeout(() => {
    // Re-arm BEFORE running sweep so subsequent boundaries are never missed
    // even if runSweep() throws synchronously or takes longer than the interval.
    scheduleNextScan();

    runSweep().catch((err) => {
      const line = `[Scanner] SWEEP ABORT: unhandled crash — ${err instanceof Error ? err.message : err}`;
      console.error(line);
      appendTelemetry(line);
    });
  }, delay);

  // Don't hold the process open just for the scanner timer.
  if (typeof (scannerTimer as any)?.unref === "function") {
    (scannerTimer as any).unref();
  }

  console.log(`[Scanner] next scan in ${Math.round(delay / 1000)}s`);
}

// ─── Public lifecycle API ─────────────────────────────────────────────────────

/**
 * Start the scanner. Safe to call multiple times — silently no-ops if already running.
 * Wire next to startAiTraderMonitor() in server startup (see server/index.ts).
 */
export function startScanner(): void {
  if (scannerRunning) return; // already running (singleton guard on the explicit flag)
  scannerRunning = true;
  console.log("[Scanner] starting (15m boundary sweep — shadow mode, no trading)");

  // Datafeed infra incidents (e.g. a slow/wedged candle-cache DB read eating
  // a fetch budget) get a formal error_log row, not just a telemetry line.
  // Registered here — NOT at module top — so unit tests importing datafeed
  // never write error_log rows as a side effect.
  setDatafeedIncidentReporter((incident) => {
    recordCriticalError({
      category: "scanner",
      severity: "error",
      source: "datafeed",
      message: `Datafeed ${incident.kind}: ${incident.symbol} ${incident.timeframe} cache read exceeded ${incident.budgetMs}ms — treated as miss`,
      context: {
        ...incident,
        pid: process.pid,
        env: process.env.NODE_ENV || "development",
        uptimeSec: Math.round(process.uptime()),
      },
    });
  });

  scheduleNextScan();

  // Boot catch-up sweep: a restart (every deploy) wipes the in-memory shortlist,
  // and the first boundary sweep can be up to 15 minutes away. During that blind
  // window every scanner bot's manual Ask AI 409s ("no fresh candidates") and
  // auto bots skip their boundary pick. Run one immediate sweep to repopulate.
  // Off-boundary is safe: getBoundaryTfs() always includes "15m", the G9
  // freshness check passes (the forming bar is by definition fresh), and the
  // shortlist consumers already tolerate candidates up to one boundary old —
  // a mid-bar evaluation is no staler than the previous boundary's pick.
  // Skipped when the boundary sweep is imminent (see BOOT_SWEEP_MIN_LEAD_MS).
  //
  // 2026-07-19 hardening: the catch-up no longer fires immediately. It waits
  // BOOT_SWEEP_DELAY_MS (past the staggered-startup window), then waits for DB
  // pool headroom, then re-checks at execution time that the scanner is still
  // running, no sweep has already started/completed, and the next boundary is
  // still far enough away to justify a catch-up at all.
  bootCatchUpTimer = setTimeout(() => {
    bootCatchUpTimer = null;
    void (async () => {
      // Dynamic import: db.ts starts pool heartbeat intervals at module load,
      // so a static import here would drag them into every unit-test module
      // graph that touches the scanner (breaks fake-timer counting).
      const { runSerializedBootWork } = await import("../db");
      // Serialized boot slot (cap=1 across all heavy startup jobs): the old
      // whenPoolHasHeadroom() was point-in-time and did not reserve capacity,
      // so the catch-up could land on the pool together with the stats
      // monitor / portfolio backfill (2026-07-20 incident). maxWaitMs: a
      // catch-up that cannot START before the next boundary sweep is
      // worthless — SKIP it (the boundary sweep repopulates the shortlist);
      // never run it late. All viability checks re-run INSIDE the slot: the
      // world may have changed (sweep started, boundary now imminent,
      // scanner stopped) while we were queued.
      const tfMsOuter = TIMEFRAME_MS["15m"];
      const msToBoundaryOuter =
        (Math.floor(Date.now() / tfMsOuter) + 1) * tfMsOuter - Date.now();
      const slotBudgetMs = msToBoundaryOuter - BOOT_SWEEP_MIN_LEAD_MS;
      if (slotBudgetMs <= 0) {
        console.log(
          `[Scanner] boot catch-up skipped (next boundary sweep in ${Math.round(msToBoundaryOuter / 1000)}s)`
        );
        return;
      }
      await runSerializedBootWork(
        "scanner-boot-catchup",
        async () => {
          if (!scannerRunning) return;
          if (sweepStartedAt !== null || telemetryRing.length > 0) {
            console.log("[Scanner] boot catch-up skipped — a sweep already ran/is running");
            return;
          }
          const tfMs = TIMEFRAME_MS["15m"];
          const msToBoundary = (Math.floor(Date.now() / tfMs) + 1) * tfMs - Date.now();
          if (msToBoundary <= BOOT_SWEEP_MIN_LEAD_MS) {
            console.log(
              `[Scanner] boot catch-up skipped (next boundary sweep in ${Math.round(msToBoundary / 1000)}s)`
            );
            return;
          }
          console.log(
            `[Scanner] boot catch-up sweep (restart cleared shortlist; next boundary sweep in ${Math.round(msToBoundary / 1000)}s)`
          );
          await runSweep().catch((err) =>
            console.error(
              `[Scanner] boot catch-up sweep crashed: ${err instanceof Error ? err.message : err}`
            )
          );
        },
        { maxWaitMs: slotBudgetMs }
      );
    })();
  }, BOOT_SWEEP_DELAY_MS);
  if (typeof (bootCatchUpTimer as any)?.unref === "function") {
    (bootCatchUpTimer as any).unref();
  }
}

/**
 * Stop the scanner and clear all in-memory state.
 * Called inside stopAiTraderMonitor() (monitor.ts) so test teardown and server
 * shutdown always stop both subsystems together.
 */
export function stopScanner(): void {
  scannerRunning = false; // primary stop signal — scheduleNextScan() exits on this
  revokeScannerSweep(activeSweepOwner, "scanner stopped");
  setDatafeedIncidentReporter(null);
  if (scannerTimer) {
    clearTimeout(scannerTimer);
    scannerTimer = null;
  }
  if (bootCatchUpTimer) {
    clearTimeout(bootCatchUpTimer);
    bootCatchUpTimer = null;
  }
  sweepStartedAt = null;
  sweepGeneration++;
  scannerPublicationState = Object.freeze({ currentGeneration: null, lastTradableGeneration: null });
  universeCache.clear();
  multiplierQuarantineByProtocol.clear();
  feedHealthMap.clear();
  telemetryRing.splice(0, telemetryRing.length);
  console.log("[Scanner] stopped");
}

/**
 * Returns the current ranked shortlist for the given protocol.
 * Empty array if no boundary sweep has completed yet.
 */
export function getScannerShortlist(protocol: string): ScannerCandidate[] {
  return getScannerShortlistResult(protocol).candidates;
}

export type ScannerShortlistRead = Readonly<{
  authority: "tradable" | "absent" | "diagnostic_only" | "stale";
  candidates: ScannerCandidate[];
}>;

export function getScannerShortlistResult(protocol: string): ScannerShortlistRead {
  const current = scannerPublicationState.currentGeneration;
  if (!current) return { authority: "absent", candidates: [] };
  if (current.verdict !== "tradable") return { authority: "diagnostic_only", candidates: [] };
  if (Date.now() - current.finishedAt > SCANNER_SHORTLIST_MAX_AGE_MS) {
    return { authority: "stale", candidates: [] };
  }
  return {
    authority: "tradable",
    candidates: [...(current.candidatesByProtocol.get(protocol) ?? [])].filter(
      (candidate) => Date.now() - candidate.evaluatedAt <= SCANNER_SHORTLIST_MAX_AGE_MS,
    ),
  };
}

/** Same 20-minute one-boundary-lag policy formerly enforced only by consumers. */
export const SCANNER_SHORTLIST_MAX_AGE_MS = 20 * 60_000;

function toGenerationStatus(manifest: ScannerSweepManifest | null): ScannerGenerationStatus | null {
  if (!manifest) return null;
  const candidateCounts: Record<string, number> = {};
  for (const protocol of PROTOCOLS) {
    candidateCounts[protocol] = manifest.candidatesByProtocol.get(protocol)?.length ?? 0;
  }
  const { candidatesByProtocol: _candidatesByProtocol, ...status } = manifest;
  return { ...status, candidateCounts: Object.freeze(candidateCounts) };
}

/**
 * Full status blob for the telemetry endpoint.
 */
export function getScannerStatus(): ScannerStatus {
  const shortlist: Record<string, ScannerCandidate[]> = {};
  for (const protocol of PROTOCOLS) {
    shortlist[protocol] = getScannerShortlist(protocol);
  }
  const lastBoundaryStats = telemetryRing.length > 0
    ? telemetryRing[telemetryRing.length - 1]
    : null;
  const multiplierQuarantinedMarkets = [...new Set(
    [...multiplierQuarantineByProtocol.values()].flatMap((markets) => [...markets]),
  )].sort();
  return {
    shortlist,
    currentGeneration: toGenerationStatus(scannerPublicationState.currentGeneration),
    lastTradableGeneration: toGenerationStatus(scannerPublicationState.lastTradableGeneration),
    lastBoundaryStats,
    recentHistory: [...telemetryRing],
    excludedMarkets: [...SCANNER_FEED_EXCLUDE],
    multiplierQuarantinedMarkets,
    scannerRunning,
  };
}
