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
import { fetchOHLCV } from "../lab/datafeed";
import { marketToDatafeedTicker } from "./context-builder";
import { getFlashMarketSpecs } from "../protocol/flash/flash-markets";
import { getAdapter } from "../protocol/adapter-registry";
import { detectWM } from "./wm-detector";
import { detectPivots, classifyDow, type DowClassification } from "./dow-structure";
import { getSessionContext } from "./session-context";

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
}

export interface ScannerBoundaryStats {
  protocol: string;
  timeframe: string;
  sweepStartedAt: number;
  sweepFinishedAt: number;
  durationMs: number;
  marketsScanned: number;
  marketsFresh: number;
  marketsSkippedByTimeout: number;
  errorCount: number;
  candidateCount: number;
}

export interface ScannerStatus {
  shortlist: Record<string, ScannerCandidate[]>;
  lastBoundaryStats: ScannerBoundaryStats | null;
  recentHistory: ScannerBoundaryStats[];
  excludedMarkets: string[];
  scannerRunning: boolean;
}

// ─── Module state (all bounded) ───────────────────────────────────────────────

// Current ranked shortlist per protocol — replaced wholesale each boundary.
const shortlistMap = new Map<string, ScannerCandidate[]>();

// Telemetry ring buffer: plain array, push + trim to 200. In-memory only; resets on restart.
const telemetryRing: ScannerBoundaryStats[] = [];

// Universe cache per protocol: { data: market internal symbols[], expiresAt }.
const universeCache = new Map<string, { data: string[]; expiresAt: number }>();

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
const SWEEP_WEDGE_MS = 5 * 60_000;
/**
 * Total network-fetch budget for one whole sweep (all protocols, all TFs).
 * Must stay well under SWEEP_WEDGE_MS: 240s deadline + one in-flight call
 * chain (~50s worst case) ≈ 290s < 300s wedge window, so the wedge override
 * remains a backstop for truly-hung awaits only — sweeps cannot stack.
 */
const SWEEP_FETCH_DEADLINE_TOTAL_MS = 240_000;
/** Per-fetch cap within the sweep budget. */
const SWEEP_PER_FETCH_DEADLINE_MS = 45_000;

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

// ─── Core evaluator (pure, exported for unit tests) ───────────────────────────
//
// Takes already-fetched bar arrays so tests can pass synthetic fixtures without
// making any network calls. The sweep orchestration handles fetching.

/**
 * Evaluate a single market+TF candidate given pre-fetched bars.
 *
 * Steps (in order):
 *   1. G9 staleness: newest candle must be < 2 × tfMs old, else return null.
 *   2. detectWM: require an actionable pattern (within NECKLINE_WINDOW 0.5%).
 *      No actionable W/M → return null. v1 pins W/M as the sole setup trigger.
 *   3. detectPivots + classifyDow on parent-TF bars. OPPOSE setup direction → null.
 *      (Neutral / mixed / insufficient → allow with score penalty from missing +20.)
 *   4. getSessionContext(now): weekend (thin liquidity) → −10 score penalty (not rejected).
 *   5. Compute deterministic score and return a full ScannerCandidate.
 */
export function evaluateCandidate(
  market: string,
  protocol: string,
  bars: OHLCV[],
  parentBars: OHLCV[] | null,
  tf: string,
  now: Date,
): ScannerCandidate | null {
  if (bars.length < 2) return null;

  const tfMs = TIMEFRAME_MS[tf];
  if (!tfMs) return null;

  // ── Step 1: G9 staleness ──────────────────────────────────────────────────
  // bars[bars.length - 1] is the forming bar / most recent. Its .time is the
  // bar-open timestamp in ms. A fresh bar is one whose open is < 2 intervals ago.
  const newestBarTime = bars[bars.length - 1].time;
  const ageMs = now.getTime() - newestBarTime;
  if (ageMs >= 2 * tfMs) return null;

  // ── Step 2: W/M detection ─────────────────────────────────────────────────
  // detectWM already enforces NECKLINE_WINDOW (0.5%) actionability criterion.
  const wm = detectWM(bars);
  if (!wm) return null;

  const setup: "W" | "M" = wm.type;
  const direction: "long" | "short" = setup === "W" ? "long" : "short";

  // necklineDistancePct: |fraction| × 100 → 0–0.5 percentage points.
  // Max value = NECKLINE_WINDOW × 100 = 0.5. Used in score formula as-is.
  const necklineDistancePct = Math.abs(wm.currentPriceDistFromNeckline) * 100;

  // ── Step 3: Parent-TF Dow alignment ──────────────────────────────────────
  // W-bottom (long) is aligned with HH/HL (parent uptrend); M-top (short)
  // with LH/LL (parent downtrend). Opposing alignment is a hard reject.
  // Neutral / mixed / insufficient → allow (no +20 bonus on the score).
  let parentTrend: string = "none";
  let parentAligned = false;
  let parentOpposed = false;

  if (parentBars !== null) {
    // Always classify even when bars are few — classifyDow returns "insufficient"
    // for short input, which is the correct label and is never a hard-reject.
    const pivots = detectPivots(parentBars);
    const dowResult = classifyDow(pivots);
    const cls: DowClassification = dowResult.classification;
    parentTrend = cls;

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

  if (parentOpposed) return null;

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
    protocol,
    market,
    timeframe: tf,
    direction,
    setup,
    score,
    necklineDistancePct,
    parentTrend,
    evaluatedAt: now.getTime(),
  };
}

// ─── Universe builder (cached 1h per protocol) ───────────────────────────────

async function buildUniverse(protocol: string): Promise<string[]> {
  const cached = universeCache.get(protocol);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  let markets: string[] = [];
  try {
    if (protocol === "flash") {
      const specs = getFlashMarketSpecs();
      markets = specs.map((s) => s.internalSymbol);
    } else {
      const adapter = getAdapter(protocol);
      const all = await adapter.getMarkets();
      markets = all.filter((m) => m.isActive).map((m) => m.internalSymbol);
    }
  } catch (err) {
    console.error(
      `[Scanner] universe build failed for ${protocol}: ${err instanceof Error ? err.message : err}`
    );
    // Return stale cache if available, else empty. Never throw.
    const stale = universeCache.get(protocol);
    return stale ? stale.data : [];
  }

  // Subtract feed-dead markets.
  const filtered = markets.filter((m) => !SCANNER_FEED_EXCLUDE.has(m));

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
      console.log("[Scanner] Previous sweep still running — skipping this boundary");
      return;
    }
    console.error(
      `[Scanner] previous sweep wedged for ${Math.round(ageMs / 1000)}s — overriding so scanning continues`
    );
  }
  const gen = ++sweepGeneration;
  sweepStartedAt = Date.now();
  // Sweep-global fetch deadline: bounds the WHOLE sweep's network time so a
  // degraded-feed sweep finishes comfortably inside SWEEP_WEDGE_MS and two
  // sweeps can never run concurrently in practice. Each dispatch passes the
  // remaining budget into fetchOHLCV (which cuts pagination/fallbacks at the
  // deadline); dispatches with <5s remaining are skipped outright.
  const fetchDeadlineAt = Date.now() + SWEEP_FETCH_DEADLINE_TOTAL_MS;

  try {
    const now = new Date();
    const boundaryTfs = getBoundaryTfs(now);

    // Accumulate candidates across all TFs per protocol, then rank and keep top K.
    const allCandidatesByProtocol = new Map<string, ScannerCandidate[]>();
    for (const protocol of PROTOCOLS) {
      allCandidatesByProtocol.set(protocol, []);
    }

    // Boundary-level candle cache: shared across ALL protocols and TFs in this sweep.
    // Ensures BTC/USDT 15m candles are fetched exactly once even when both Flash and
    // Pacifica list BTC-PERP (both map to the same datafeed ticker via marketToDatafeedTicker).
    const candleCache = new Map<string, OHLCV[]>();

    for (const protocol of PROTOCOLS) {
      const universe = await buildUniverse(protocol);

      // Per-protocol budget clock. The budget used to be measured from the GLOBAL
      // sweep start, which let the first protocol (flash) consume the entire 55s on
      // cold sweeps — pacifica's loop then started with the budget already blown and
      // skipped every market ("Scanning 0 Pacifica markets" in the create modal).
      // Each protocol now gets its own SWEEP_BUDGET_MS window; worst case total is
      // PROTOCOLS.length × 55s ≈ 110s, still far inside the 15m boundary cadence.
      const protocolStart = Date.now();

      for (const tf of boundaryTfs) {
        const tfStart = Date.now();
        const parentTf = PARENT_TF[tf] ?? null;
        const tfMs = TIMEFRAME_MS[tf];

        let marketsScanned = 0;
        let marketsFresh = 0;
        let marketsSkippedByTimeout = 0;
        let errorCount = 0;
        const tfCandidates: ScannerCandidate[] = [];

        // Concurrency tracking (module-local to each TF scan, not shared across TFs).
        let inFlight = 0;
        const pendingPromises: Promise<void>[] = [];

        // Per-market fetch + evaluate, dispatched concurrently (max 3 in flight).
        const dispatchMarket = (market: string): Promise<void> => {
          return (async () => {
            const ticker = marketToDatafeedTicker(market);

            // Feed health check: skip if recently failed (mirrors datafeed negcaches).
            const health = feedHealthMap.get(ticker);
            if (health && Date.now() - health.failedAt < FEED_HEALTH_TTL_MS) {
              // Closed-market equities (e.g. AMZN outside NYSE hours) drop out
              // naturally via the G9 staleness check — correct behaviour per spec.
              return;
            }

            const endMs = now.getTime();
            const startMs = endMs - (INDICATOR_BARS + 1) * tfMs;
            const startDate = new Date(startMs).toISOString();
            const endDate = new Date(endMs).toISOString();

            let bars: OHLCV[] = [];
            let fetchDeadlineTruncated = false;
            try {
              const cacheKey = `${ticker}:${tf}`;
              if (candleCache.has(cacheKey)) {
                bars = candleCache.get(cacheKey)!;
              } else {
                const remainingMs = fetchDeadlineAt - Date.now();
                if (remainingMs < 5_000) {
                  // Sweep fetch budget exhausted — skip without marking the
                  // feed dead (this is our budget, not the feed's fault).
                  marketsSkippedByTimeout++;
                  return;
                }
                const perFetchDeadlineMs = Math.min(
                  SWEEP_PER_FETCH_DEADLINE_MS,
                  remainingMs,
                );
                const fetchStartedAt = Date.now();
                bars = await fetchOHLCV(ticker, tf, startDate, endDate, undefined, {
                  deadlineMs: perFetchDeadlineMs,
                });
                // If the fetch came back EMPTY after running out its deadline,
                // treat it as a budget timeout, not a dead feed — a truncated
                // fetch is indistinguishable from a dead feed by bars alone.
                fetchDeadlineTruncated =
                  bars.length === 0 &&
                  Date.now() - fetchStartedAt >= perFetchDeadlineMs - 1_000;
                if (!fetchDeadlineTruncated) {
                  candleCache.set(cacheKey, bars);
                }
              }
            } catch (err) {
              feedHealthMap.set(ticker, { failedAt: Date.now() });
              errorCount++;
              return;
            }

            if (bars.length === 0) {
              if (fetchDeadlineTruncated) {
                // Our sweep budget cut this fetch short — skip WITHOUT the
                // 30-min feed-dead exclusion; the feed may be perfectly fine.
                marketsSkippedByTimeout++;
                return;
              }
              // Empty = feed dead for this ticker. Mark and skip.
              feedHealthMap.set(ticker, { failedAt: Date.now() });
              return;
            }

            marketsScanned++;

            // Track freshness (G9 check mirrored here for logging).
            const newestBarTime = bars[bars.length - 1].time;
            const ageMs = now.getTime() - newestBarTime;
            if (ageMs < 2 * tfMs) marketsFresh++;

            // Fetch parent-TF bars (use cache to avoid duplicate fetches).
            let parentBars: OHLCV[] | null = null;
            if (parentTf) {
              const parentTfMs = TIMEFRAME_MS[parentTf];
              const parentStartMs = endMs - (INDICATOR_BARS + 1) * parentTfMs;
              const parentCacheKey = `${ticker}:${parentTf}`;
              try {
                if (candleCache.has(parentCacheKey)) {
                  parentBars = candleCache.get(parentCacheKey)!;
                } else {
                  const remainingMs = fetchDeadlineAt - Date.now();
                  if (remainingMs < 5_000) {
                    parentBars = null; // budget exhausted — parent is optional
                  } else {
                    parentBars = await fetchOHLCV(
                      ticker,
                      parentTf,
                      new Date(parentStartMs).toISOString(),
                      endDate,
                      undefined,
                      { deadlineMs: Math.min(SWEEP_PER_FETCH_DEADLINE_MS, remainingMs) },
                    );
                    candleCache.set(parentCacheKey, parentBars);
                  }
                }
              } catch {
                parentBars = null; // parent fetch failure is non-fatal
              }
            }

            const candidate = evaluateCandidate(market, protocol, bars, parentBars, tf, now);
            if (candidate) tfCandidates.push(candidate);
          })();
        };

        // Dispatch loop: max 3 concurrent + ≥150ms stagger between dispatches.
        for (let i = 0; i < universe.length; i++) {
          const market = universe[i];

          // Check this protocol's sweep budget first (per-protocol clock — see above).
          if (Date.now() - protocolStart > SWEEP_BUDGET_MS) {
            marketsSkippedByTimeout += universe.length - i;
            break;
          }

          // Wait for a semaphore slot (busy-wait in 10ms slices).
          while (inFlight >= MAX_CONCURRENT_FETCHES) {
            await sleep(10);
          }
          inFlight++;
          const p = dispatchMarket(market).finally(() => { inFlight--; });
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
          const fullyCached =
            candleCache.has(`${staggerTicker}:${tf}`) &&
            (!parentTf || candleCache.has(`${staggerTicker}:${parentTf}`));
          if (!healthSkipped && !fullyCached) {
            await sleep(FETCH_STAGGER_MS);
          }
        }

        // Wait for all in-flight fetches to finish.
        await Promise.all(pendingPromises);

        if (marketsSkippedByTimeout > 0) {
          console.log(`[Scanner] TIMEOUT: ${marketsSkippedByTimeout} markets skipped`);
        }

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
          marketsScanned,
          marketsFresh,
          marketsSkippedByTimeout,
          errorCount,
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
        console.log(
          `[Scanner] ${protocol} ${tf}: ${marketsScanned} scanned, ${marketsFresh} fresh, ` +
            `${tfCandidates.length} candidates${tfCandidates.length > 0 ? ` (${candStr})` : ""} in ${durationSec}s`,
        );
      } // end TF loop
    } // end protocol loop

    // After all TFs for all protocols: rank accumulated candidates, keep top K=3,
    // and replace the shortlist wholesale.
    for (const protocol of PROTOCOLS) {
      const all = allCandidatesByProtocol.get(protocol) ?? [];
      all.sort((a, b) => b.score - a.score);
      shortlistMap.set(protocol, all.slice(0, TOP_K));
    }
  } catch (err) {
    console.error(
      `[Scanner] sweep crashed: ${err instanceof Error ? err.message : err}`
    );
  } finally {
    // Only clear our own claim — a wedged sweep that resumes after an override
    // must not wipe the newer sweep's timestamp.
    if (gen === sweepGeneration) sweepStartedAt = null;
  }
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

    runSweep().catch((err) =>
      console.error(
        `[Scanner] sweep unhandled crash: ${err instanceof Error ? err.message : err}`
      )
    );
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
  scheduleNextScan();
}

/**
 * Stop the scanner and clear all in-memory state.
 * Called inside stopAiTraderMonitor() (monitor.ts) so test teardown and server
 * shutdown always stop both subsystems together.
 */
export function stopScanner(): void {
  scannerRunning = false; // primary stop signal — scheduleNextScan() exits on this
  if (scannerTimer) {
    clearTimeout(scannerTimer);
    scannerTimer = null;
  }
  sweepStartedAt = null;
  sweepGeneration++;
  shortlistMap.clear();
  universeCache.clear();
  feedHealthMap.clear();
  telemetryRing.splice(0, telemetryRing.length);
  console.log("[Scanner] stopped");
}

/**
 * Returns the current ranked shortlist for the given protocol.
 * Empty array if no boundary sweep has completed yet.
 */
export function getScannerShortlist(protocol: string): ScannerCandidate[] {
  return shortlistMap.get(protocol) ?? [];
}

/**
 * Full status blob for the telemetry endpoint.
 */
export function getScannerStatus(): ScannerStatus {
  const shortlist: Record<string, ScannerCandidate[]> = {};
  for (const protocol of PROTOCOLS) {
    shortlist[protocol] = shortlistMap.get(protocol) ?? [];
  }
  const lastBoundaryStats = telemetryRing.length > 0
    ? telemetryRing[telemetryRing.length - 1]
    : null;
  return {
    shortlist,
    lastBoundaryStats,
    recentHistory: [...telemetryRing],
    excludedMarkets: [...SCANNER_FEED_EXCLUDE],
    scannerRunning,
  };
}
