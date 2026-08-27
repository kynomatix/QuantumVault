import type { OHLCV } from "./engine";
import {
  getCachedCandles,
  getCachedCandlesBatch,
  saveCandlesToDb,
  CACHE_BUDGET_ABORT_REASON,
  type CandleReadCallerClass,
  type CandleReadPhases,
} from "./candle-store";
import { getBenchmarksBase, hermesFetch } from '../pricing/hermes-config.js';
import { appendTelemetry } from "../telemetry";

export type CandleSource = "okx" | "gate" | "pyth" | "unknown";
export type CandleVenue = "okx" | "gate" | "none" | "unknown";
export type CandleBasis = "perp" | "spot" | "index" | "unknown";
export type CandleProxy = "direct" | "proxy" | "unknown";
export type CandleFinality = "finalized" | "forming" | "unknown";
export type CandleTimeSemantic = "open_time" | "unknown";

export interface CandleProvenance {
  source: CandleSource;
  venue: CandleVenue;
  basis: CandleBasis;
  proxy: CandleProxy;
  finality: CandleFinality;
  timeSemantic: CandleTimeSemantic;
}

export interface ProvenancedOHLCV extends OHLCV {
  provenance: CandleProvenance;
}

export interface CandleBasisPolicy {
  consumer: "scanner" | "ai_context" | "chart" | "lab" | "paper_monitor" | "live_monitor";
  acceptedBasis: readonly CandleBasis[];
  acceptedFinality: readonly CandleFinality[];
  acceptedProxy: readonly CandleProxy[];
}

export const MONEY_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  consumer: "scanner",
  acceptedBasis: Object.freeze(["perp"] as const),
  acceptedFinality: Object.freeze(["finalized"] as const),
  acceptedProxy: Object.freeze(["direct"] as const),
});

export const AI_CONTEXT_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  ...MONEY_CANDLE_POLICY,
  consumer: "ai_context",
});

export const CHART_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  consumer: "chart",
  acceptedBasis: Object.freeze(["perp"] as const),
  acceptedFinality: Object.freeze(["finalized", "forming"] as const),
  acceptedProxy: Object.freeze(["direct"] as const),
});

export const PAPER_MONITOR_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  ...CHART_CANDLE_POLICY,
  consumer: "paper_monitor",
});

export const LIVE_MONITOR_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  ...CHART_CANDLE_POLICY,
  consumer: "live_monitor",
});

export const LAB_DIRECT_PERP_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  consumer: "lab",
  acceptedBasis: Object.freeze(["perp"] as const),
  acceptedFinality: Object.freeze(["finalized"] as const),
  acceptedProxy: Object.freeze(["direct"] as const),
});

export const LAB_ALL_KNOWN_CANDLE_POLICY: Readonly<CandleBasisPolicy> = Object.freeze({
  consumer: "lab",
  acceptedBasis: Object.freeze(["perp", "spot", "index"] as const),
  acceptedFinality: Object.freeze(["finalized", "forming"] as const),
  acceptedProxy: Object.freeze(["direct", "proxy"] as const),
});

export type CandleBasisUnavailableReason =
  | "no_acceptable_source"
  | "nonfinalized_only"
  | "malformed_provenance";

export class CandleBasisUnavailableError extends Error {
  constructor(
    public readonly reason: CandleBasisUnavailableReason,
    public readonly symbol: string,
    public readonly timeframe: string,
  ) {
    super(`No acceptable candle basis for ${symbol} ${timeframe}: ${reason}`);
    this.name = "CandleBasisUnavailableError";
  }
}

export function isCandleBasisUnavailableError(err: unknown): err is CandleBasisUnavailableError {
  return err instanceof CandleBasisUnavailableError;
}

const OKX_BATCH_SIZE = 300;
const GATE_BATCH_SIZE = 900;
const PYTH_BATCH_SIZE = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

/** One-time flag: log the first 401/403 from Pyth Benchmarks (auth cutover signal). */
let pythBenchmarksAuthWarned = false;

const okxFailedInstruments = new Map<string, number>();
const gateFailedPairs = new Map<string, number>();
const pythFailedSymbols = new Map<string, number>();

function isNegCached(cache: Map<string, number>, key: string): boolean {
  const ts = cache.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > NEGATIVE_CACHE_TTL_MS) {
    cache.delete(key);
    return false;
  }
  return true;
}

function negCache(cache: Map<string, number>, key: string): void {
  cache.set(key, Date.now());
}

// ---------------------------------------------------------------------------
// OKX source-level circuit breaker.
//
// Prod incident 2026-07-18 (part 2): the production deployment's egress IPs
// cannot reach OKX at all — even majors (SOL/BTC/ETH) fail with network
// timeouts after ~75-97s each. The per-instrument negcache (30-min TTL) only
// helps on the SECOND touch, so with ~90 scanner markets the first-touch cost
// alone exhausts the 240s sweep budget forever ("TIMEOUT: 58 markets skipped").
//
// This breaker is SOURCE-level: after N consecutive instruments where OKX
// itself was unreachable (network failure — NOT "instrument doesn't exist",
// which proves the API answered), skip OKX entirely for all symbols for a
// cooldown. After the cooldown, ONE probe fetch is allowed through
// (half-open): a single failure re-trips immediately, any success resets.
// ---------------------------------------------------------------------------
const OKX_SOURCE_BREAKER_THRESHOLD = 3;
const OKX_SOURCE_BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

let okxSourceConsecutiveFailures = 0;
let okxSourceDownUntil = 0;

function isOkxSourceDown(): boolean {
  return Date.now() < okxSourceDownUntil;
}

function recordOkxSourceSuccess(): void {
  okxSourceConsecutiveFailures = 0;
}

function recordOkxSourceFailure(instId: string): void {
  okxSourceConsecutiveFailures++;
  if (okxSourceConsecutiveFailures >= OKX_SOURCE_BREAKER_THRESHOLD) {
    okxSourceDownUntil = Date.now() + OKX_SOURCE_BREAKER_COOLDOWN_MS;
    // Leave the counter one below the threshold so a single failed half-open
    // probe after the cooldown re-trips immediately (instead of paying the
    // full N-symbol penalty again).
    okxSourceConsecutiveFailures = OKX_SOURCE_BREAKER_THRESHOLD - 1;
    const msg =
      `[OKX] SOURCE DOWN: ${OKX_SOURCE_BREAKER_THRESHOLD} consecutive network failures ` +
      `(last: ${instId}) — skipping OKX for ALL symbols for ` +
      `${Math.round(OKX_SOURCE_BREAKER_COOLDOWN_MS / 60000)} min; Gate/Pyth fallbacks take over`;
    console.log(msg);
    appendTelemetry(msg);
  }
}

/** Test-only: reset the OKX source breaker between test cases. */
export function __testResetOkxSourceBreaker(): void {
  okxSourceConsecutiveFailures = 0;
  okxSourceDownUntil = 0;
}

class GatePairNotFoundError extends Error {
  constructor(pair: string, detail: string) {
    super(`Gate.io pair not found: ${pair} — ${detail}`);
    this.name = "GatePairNotFoundError";
  }
}

/**
 * Permanent OKX "instrument doesn't exist" (code 51001). Non-retryable:
 * retrying a delisted/never-listed instId 3× per page with backoff burned
 * 30-45s of the scanner's sweep budget per missing market, every sweep
 * (prod incident 2026-07-18: "TIMEOUT: 61 markets skipped").
 */
class OkxInstrumentNotFoundError extends Error {
  constructor(instId: string, detail: string) {
    super(`OKX instrument not found: ${instId} — ${detail}`);
    this.name = "OkxInstrumentNotFoundError";
  }
}

/** Verbose per-fetch source tracing (set DATAFEED_VERBOSE=1). */
const DATAFEED_VERBOSE =
  process.env.DATAFEED_VERBOSE === "1" || process.env.DATAFEED_VERBOSE === "true";

function isValidNumber(v: unknown): v is number {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length > 0 && Number.isFinite(Number(v));
  return false;
}

export function stripMultiplierPrefix(base: string): string {
  const match = base.match(/^1[KM](.+)$/i);
  return match ? match[1] : base;
}

function sourceProxy(symbol: string, selectedBase?: string): CandleProxy {
  const requestedBase = symbol.split("/")[0];
  if (stripMultiplierPrefix(requestedBase) !== requestedBase) return "proxy";
  if (selectedBase && selectedBase !== requestedBase) return "proxy";
  return "direct";
}

function hasCompleteKnownProvenance(candle: ProvenancedOHLCV): boolean {
  const p = candle.provenance;
  return !!p
    && p.source !== "unknown"
    && p.venue !== "unknown"
    && p.basis !== "unknown"
    && p.proxy !== "unknown"
    && p.finality !== "unknown"
    && p.timeSemantic !== "unknown";
}

export function candleMatchesBasisPolicy(
  candle: ProvenancedOHLCV,
  policy: CandleBasisPolicy,
): boolean {
  const p = candle.provenance;
  const requireDirectOkxIdentity = policy.consumer !== "lab"
    && policy.consumer !== "scanner"
    && policy.consumer !== "ai_context";
  return hasCompleteKnownProvenance(candle)
    && (!requireDirectOkxIdentity
      || (p.source === "okx" && p.venue === "okx" && p.timeSemantic === "open_time"))
    && policy.acceptedBasis.includes(p.basis)
    && policy.acceptedFinality.includes(p.finality)
    && policy.acceptedProxy.includes(p.proxy);
}

function symbolToOkxInstId(symbol: string): string {
  const base = stripMultiplierPrefix(symbol.split("/")[0]);
  return `${base}-USDT-SWAP`;
}

function symbolToGateSpotPair(symbol: string): string {
  const base = stripMultiplierPrefix(symbol.split("/")[0]);
  return `${base}_USDT`;
}

const NON_CRYPTO_PYTH_MAP: Record<string, string> = {
  EURUSD: "EURUSD",
  USDJPY: "USDJPY",
  XAU: "XAUUSD",
  XAG: "XAGUSD",
  PLATINUM: "XPTUSD",
  CL: "USOILSPOT",
  SP500: "SPY",
  NVDA: "NVDA",
  TSLA: "TSLA",
  GOOGL: "GOOGL",
  PLTR: "PLTR",
  HOOD: "HOOD",
  CRCL: "CRCL",
  // ── Flash Trade native base symbols (FX / commodity / equity) ─────────────
  // Flash's PoolConfig uses different bases than the keys above (EUR not EURUSD,
  // SPY not SP500, CRUDEOIL not CL), so they get their own entries. Values are
  // Pyth Benchmarks TradingView shim symbols, verified live against
  // benchmarks.pyth.network. NATGAS (Flash Commodities.NGDN6/USD) is
  // deliberately ABSENT: Pyth Benchmarks exposes no natural-gas history feed
  // (only oil: US/UK spot + WTI futures), so it is not backtestable and
  // QuantumLab filters it out of the selectable Flash ticker list.
  EUR: "EURUSD",
  GBP: "GBPUSD",
  USDCNH: "USDCNH",
  CRUDEOIL: "USOILSPOT",
  SPY: "SPY",
  AAPL: "AAPL",
  AMD: "AMD",
  AMZN: "AMZN",
  MSTR: "MSTR",
};

export function isNonCryptoSymbol(symbol: string): boolean {
  const base = symbol.split("/")[0];
  return base in NON_CRYPTO_PYTH_MAP;
}

// ─── Venue trading-hours gate for non-crypto symbols ─────────────────────────
//
// Pyth Benchmarks is the ONLY candle source for non-crypto bases (the
// "Gate.io fallback" log label is misleading — there is no OKX/Gate path for
// equities/FX/metals). When the underlying venue is CLOSED (NYSE after-hours,
// FX weekend) a fetch can return no new candles: it only burns the shared
// per-IP Pyth rate budget, and its 429 retry backoff (2s/4s/6s) burns the
// caller's sweep budget. Callers that only care about FRESH candles (the AI
// Trader scanner) should skip closed markets entirely — stale-market
// candidates are dropped by the G9 staleness check anyway, so skipping the
// fetch changes no decision, it just stops paying for the discovery.
//
// NOT applied inside fetchOHLCV itself: QuantumLab backtests legitimately
// pull historical ranges while markets are closed.
//
// US market holidays are deliberately not modeled — on a holiday weekday the
// behaviour degrades to the status quo (fetch, maybe rate-limit, G9 drops).

const EQUITY_PYTH_BASES = new Set([
  "SP500", "SPY", "NVDA", "TSLA", "GOOGL", "PLTR", "HOOD", "CRCL",
  "AAPL", "AMD", "AMZN", "MSTR",
]);

// FX / metals / oil — trade ~24×5, closed only over the weekend. Every key of
// NON_CRYPTO_PYTH_MAP MUST appear in exactly one of EQUITY_PYTH_BASES or this
// set (enforced by tests/ai-trader/market-hours.test.ts) so a future equity
// added to the map can't silently fall through to the 24×5 rule and keep
// fetching overnight.
const NONCRYPTO_24X5_BASES = new Set([
  "EURUSD", "USDJPY", "EUR", "GBP", "USDCNH",
  "XAU", "XAG", "PLATINUM", "CL", "CRUDEOIL",
]);

/** Test-only introspection: session classification of every non-crypto base. */
export function getNonCryptoSessionClassification(): {
  allBases: string[];
  equities: string[];
  fx24x5: string[];
} {
  return {
    allBases: Object.keys(NON_CRYPTO_PYTH_MAP),
    equities: [...EQUITY_PYTH_BASES],
    fx24x5: [...NONCRYPTO_24X5_BASES],
  };
}

const ET_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const ET_DOW: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function easternParts(now: Date): { dow: number; minutes: number } {
  let dow = 1;
  let hour = 0;
  let minute = 0;
  for (const p of ET_PARTS_FMT.formatToParts(now)) {
    if (p.type === "weekday") dow = ET_DOW[p.value] ?? 1;
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return { dow, minutes: hour * 60 + minute };
}

/**
 * True when the venue behind a non-crypto symbol is currently trading (so a
 * candle fetch can yield FRESH bars). Crypto symbols always return true.
 *
 * - Equities: NYSE regular session Mon–Fri 09:30–16:00 ET, plus a 30-minute
 *   grace window after the close so the day's final bars get fetched once
 *   (and land in the caller's cache) before the gate closes.
 * - FX / metals / oil (24×5): closed from Fri 17:00 ET to Sun 17:00 ET.
 */
export function isNonCryptoMarketOpen(symbol: string, now: Date = new Date()): boolean {
  const base = stripMultiplierPrefix(symbol.split("/")[0]);
  if (!(base in NON_CRYPTO_PYTH_MAP)) return true; // crypto trades 24/7

  const { dow, minutes } = easternParts(now);

  if (EQUITY_PYTH_BASES.has(base)) {
    if (dow === 0 || dow === 6) return false;
    return minutes >= 9 * 60 + 30 && minutes <= 16 * 60 + 30;
  }

  // FX / metals / oil weekend closure.
  if (dow === 6) return false;
  if (dow === 5 && minutes >= 17 * 60) return false;
  if (dow === 0 && minutes < 17 * 60) return false;
  return true;
}

function symbolToPythId(symbol: string): string {
  const base = stripMultiplierPrefix(symbol.split("/")[0]);
  if (base in NON_CRYPTO_PYTH_MAP) {
    return NON_CRYPTO_PYTH_MAP[base];
  }
  return `Crypto.${base}/USD`;
}

function mapTimeframeToGate(tf: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "8h": "8h",
    "12h": "12h", "1d": "1d", "1w": "7d",
  };
  return map[tf] || tf;
}

function mapTimeframeToPyth(tf: string): string {
  const map: Record<string, string> = {
    "1m": "1", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "2h": "120", "4h": "240",
    "8h": "480", "12h": "720", "1d": "D", "1w": "W",
  };
  return map[tf] || "60";
}

// ─── Cooperative cancellation (AbortSignal threading) ────────────────────────
//
// Deadline-bounded callers (the AI-trader scanner) pass an AbortSignal in
// fetchOHLCV options so an expired sweep budget can ACTIVELY cancel in-flight
// fetch chains instead of merely abandoning their promises (2026-07-19
// incident: "abandoned" chains kept paginating + retry-sleeping for tens of
// seconds past the budget, holding datafeed/Pyth/DB capacity).
//
// Rules enforced at every catch site below:
//   1. External abort is checked FIRST in every catch, BEFORE any retry,
//      negcache, or circuit-breaker accounting — a budget expiry must never
//      count as an instrument/source failure (it would trip the OKX source
//      breaker and 30-min negcaches for perfectly healthy feeds).
//   2. The internal per-request timeout in fetchWithHardTimeout ALSO surfaces
//      as an AbortError from undici, so cancellation is detected by CHECKING
//      THE SIGNAL STATE (`signal.aborted`), never by the error's name.

/** True when the given error is a cancellation-style AbortError. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function makeAbortError(): Error {
  const e = new Error("Datafeed fetch aborted by caller signal");
  e.name = "AbortError";
  return e;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError();
}

/** Sleep that rejects with AbortError the moment the signal fires. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Optional incident hook: the main-process scanner registers a reporter so
// repeated slow candle-cache reads reach the admin error log. The Lab child
// process never registers one (recordCriticalError lives in the main process),
// so this stays a no-op there by construction.
export type DatafeedIncident = {
  kind: "slow_cache";
  symbol: string;
  timeframe: string;
  budgetMs: number;
  /** Phase breakdown of the degraded read (which phase ate the budget). */
  phases?: CandleReadPhases;
};

/**
 * Typed degradation for deadline-bounded live callers (scanner/monitors/
 * context-builder): the candle-cache lookup exceeded its budget. This is NOT
 * a cache miss — the invocation FAILS: no OKX/Gate/Pyth network fallback (it
 * would add load exactly while the DB is under pressure), no cache
 * write-back, no feed negcache. Callers count it separately as DB/cache
 * degradation and skip/retry on their own schedule. Deadline-less callers
 * (Lab) never see this error.
 */
export class CacheDegradedError extends Error {
  readonly symbol: string;
  readonly timeframe: string;
  readonly budgetMs: number;
  readonly phases?: CandleReadPhases;
  constructor(symbol: string, timeframe: string, budgetMs: number, phases?: CandleReadPhases) {
    super(`Candle cache degraded: ${symbol} ${timeframe} read exceeded ${budgetMs}ms budget`);
    this.name = "CacheDegradedError";
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.budgetMs = budgetMs;
    this.phases = phases;
  }
}

export function isCacheDegradedError(err: unknown): err is CacheDegradedError {
  return (
    err instanceof CacheDegradedError ||
    (typeof err === "object" && err !== null && (err as any).name === "CacheDegradedError")
  );
}
let datafeedIncidentReporter: ((evt: DatafeedIncident) => void) | null = null;
export function setDatafeedIncidentReporter(
  fn: ((evt: DatafeedIncident) => void) | null,
): void {
  datafeedIncidentReporter = fn;
}

/**
 * Belt-and-braces bounded fetch. Prod incident 2026-07-18 07:30 UTC: an OKX
 * candle fetch built with `AbortSignal.timeout(15000)` NEVER settled — no
 * abort, no error, no retry log — and the never-resolving promise wedged the
 * AI-trader sweep for 900s until the next boundary's wedge override. Node's
 * fetch (undici) holds timeout signals weakly enough that under rare
 * GC/pressure conditions the abort can simply never fire.
 *
 * Two independent nets, both with strong references:
 *  1. A manually-managed AbortController + setTimeout closure (strong refs,
 *     immune to the signal-GC class). Deliberately NOT cleared on return, so
 *     a stalled body read (`res.json()` at the call site) is also aborted at
 *     the deadline; aborting an already-consumed response is a no-op.
 *  2. A Promise.race hard reject at ms+5s, so this await settles even if the
 *     abort plumbing itself wedges.
 *
 * NOTE: the race (net #2) covers only the header phase — body reads at the
 * call site (`res.json()`/`res.text()`) are protected only by net #1. The
 * scanner's sweep-level drain cap is the ultimate guarantor if both fail.
 */
async function fetchWithHardTimeout(
  url: string,
  ms: number,
  init?: RequestInit,
  externalSignal?: AbortSignal,
  transport: 'default' | 'hermes' = 'default',
): Promise<Response> {
  throwIfAborted(externalSignal);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  // External cancellation is forwarded via a MANUAL listener with strong refs
  // — deliberately NOT AbortSignal.any(), which belongs to the same weak-ref
  // GC class that let AbortSignal.timeout silently never fire (incident above).
  // Removed in finally so a long-lived sweep signal doesn't accumulate one
  // listener per request.
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  let raceTimer: NodeJS.Timeout | undefined;
  try {
    const request = transport === 'hermes' ? hermesFetch : fetch;
    return await Promise.race([
      request(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(
          () => reject(new Error(`fetch hard-timeout after ${ms + 5000}ms (abort never fired)`)),
          ms + 5_000,
        );
      }),
    ]);
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function fetchGateCandles(
  pair: string,
  interval: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const params = new URLSearchParams({
    currency_pair: pair,
    interval,
    from: String(fromSec),
    to: String(toSec),
  });

  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?${params}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithHardTimeout(url, 15000, undefined, signal);
      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        console.log(`[Gate Spot] Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
        await abortableSleep(wait, signal);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        // INVALID_CURRENCY_PAIR ("ORE_USDT") and INVALID_CURRENCY ("XMR") are
        // both permanent not-listed errors. The bare INVALID_CURRENCY variant
        // was previously unmatched → retried forever, never negcached (prod
        // incident 2026-07-18: XMR burned ~40s of sweep budget every 15m).
        if (res.status === 400 && (text.includes("INVALID_CURRENCY") || text.includes("currency_pair"))) {
          throw new GatePairNotFoundError(pair, text);
        }
        if (res.status === 400 && text.includes("too broad")) {
          const halfRange = Math.floor((toSec - fromSec) / 2);
          if (halfRange > 60) {
            console.log(`[Gate Spot] Range too broad, splitting chunk in half (${halfRange}s)`);
            const firstHalf = await fetchGateCandles(pair, interval, fromSec, fromSec + halfRange, signal);
            const secondHalf = await fetchGateCandles(pair, interval, fromSec + halfRange, toSec, signal);
            return [...firstHalf, ...secondHalf];
          }
        }
        if (res.status === 400 && text.includes("too long ago")) {
          console.log(`[Gate Spot] Data too old for ${pair}, skipping this chunk`);
          return [];
        }
        throw new Error(`Gate.io Spot API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      if (!Array.isArray(json)) {
        throw new Error(`Gate.io Spot unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
      }
      return json;
    } catch (err: any) {
      // Cancellation FIRST — before any retry accounting (rule 1 above).
      throwIfAborted(signal);
      // Permanent not-found — retrying cannot succeed; propagate immediately
      // so the caller negcaches without burning the retry backoff.
      if (err instanceof GatePairNotFoundError) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[Gate Spot] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
        await abortableSleep(wait, signal);
        continue;
      }
      throw err;
    }
  }
  return [];
}

async function fetchAllGateCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (msg: string) => void,
  deadlineAt: number = Infinity,
  signal?: AbortSignal,
): Promise<ProvenancedOHLCV[]> {
  const pair = symbolToGateSpotPair(symbol);

  if (isNegCached(gateFailedPairs, pair)) {
    console.log(`[Gate Spot] Skipping ${pair} (recently failed)`);
    return [];
  }

  const interval = mapTimeframeToGate(timeframe);
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);

  onProgress?.(`Fetching ${symbol} ${timeframe} from Gate.io spot (fallback)...`);
  console.log(`Fetching OHLCV for ${pair} ${interval} from Gate.io spot (OKX fallback)`);

  const allCandles: ProvenancedOHLCV[] = [];
  let currentFrom = startSec;
  let page = 0;
  let consecutiveErrors = 0;

  const tfSeconds = getTimeframeSeconds(timeframe);
  const windowSeconds = tfSeconds * GATE_BATCH_SIZE;

  while (currentFrom < endSec) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineAt) {
      const gateDeadlineMsg = `[Gate Spot] Fetch deadline reached — stopping with ${allCandles.length} candles for ${pair} ${interval}`;
      console.log(gateDeadlineMsg);
      appendTelemetry(gateDeadlineMsg);
      break;
    }
    const chunkEnd = Math.min(currentFrom + windowSeconds, endSec);
    try {
      const raw = await fetchGateCandles(pair, interval, currentFrom, chunkEnd, signal);
      consecutiveErrors = 0;

      if (!raw || raw.length === 0) {
        if (chunkEnd >= endSec) break;
        currentFrom = chunkEnd;
        continue;
      }

      for (const candle of raw) {
        if (!Array.isArray(candle) || candle.length < 6) continue;
        const ts = parseInt(candle[0]) * 1000;
        if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
        const open = parseFloat(candle[5]);
        const high = parseFloat(candle[3]);
        const low = parseFloat(candle[4]);
        const close = parseFloat(candle[2]);
        if (!isValidNumber(open) || !isValidNumber(high) || !isValidNumber(low) || !isValidNumber(close)) continue;
        allCandles.push({
          time: ts,
          open,
          high,
          low,
          close,
          volume: parseFloat(candle[1] || "0") || 0,
          provenance: {
            source: "gate",
            venue: "gate",
            basis: "spot",
            proxy: sourceProxy(symbol),
            finality: "unknown",
            timeSemantic: "unknown",
          },
        });
      }

      const lastRaw = raw[raw.length - 1];
      const lastTs = Array.isArray(lastRaw) ? parseInt(lastRaw[0]) : NaN;
      if (!Number.isFinite(lastTs) || lastTs <= currentFrom) break;
      currentFrom = lastTs + 1;
      page++;

      if (page % 3 === 0) {
        onProgress?.(`Fetched ${allCandles.length} candles for ${symbol} ${timeframe} from Gate.io spot...`);
      }

      await abortableSleep(200, signal);
    } catch (err: any) {
      // Cancellation FIRST — must never negcache or count as a feed error.
      throwIfAborted(signal);
      if (err instanceof GatePairNotFoundError) {
        console.log(`[Gate Spot] ${pair} not found on Gate.io spot`);
        negCache(gateFailedPairs, pair);
        break;
      }
      consecutiveErrors++;
      console.log(`[Gate Spot] Page fetch error after ${allCandles.length} candles (error ${consecutiveErrors}/5): ${err.message}`);
      if (consecutiveErrors >= 5) {
        console.log(`[Gate Spot] Too many consecutive errors, stopping fetch with ${allCandles.length} candles`);
        break;
      }
      await abortableSleep(RETRY_DELAY_MS * consecutiveErrors, signal);
    }
  }

  console.log(`[Gate Spot] Fetch complete: ${allCandles.length} candles over ${page} pages for ${pair} ${interval}`);

  return allCandles;
}

// ─── Pyth Benchmarks request limiter ─────────────────────────────────────────
//
// Prod evidence (2026-07-18 10:30 UTC sweep): the scanner's 3 concurrent
// dispatch slots all landed on Pyth-routed symbols at once, and all three got
// HTTP 429 in lockstep — then retried in lockstep (2s/4s/6s), burning up to
// 12s of sleep PER SYMBOL against the shared per-IP rate budget (Replit
// egress IPs are shared, so we never have the whole budget to ourselves).
// Cap concurrent Pyth requests at 2 and space request starts ≥250ms apart so
// bursts stop tripping the token bucket. OKX/Gate paths are unaffected.

const PYTH_MAX_CONCURRENT = 2;
const PYTH_MIN_START_SPACING_MS = 250;
let pythSlotsInUse = 0;
let pythLastStartAt = 0;
const pythSlotQueue: Array<() => void> = [];

async function acquirePythSlot(): Promise<void> {
  while (pythSlotsInUse >= PYTH_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => pythSlotQueue.push(resolve));
  }
  pythSlotsInUse++;
  // Reserve the start timestamp BEFORE sleeping: two acquirers that both read
  // a stale pythLastStartAt would otherwise start <250ms apart (best-effort
  // spacing). Reservation makes spacing strict.
  const startAt = Math.max(Date.now(), pythLastStartAt + PYTH_MIN_START_SPACING_MS);
  pythLastStartAt = startAt;
  const wait = startAt - Date.now();
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

function releasePythSlot(): void {
  pythSlotsInUse = Math.max(0, pythSlotsInUse - 1);
  const next = pythSlotQueue.shift();
  if (next) next();
}

async function fetchPythCandles(
  pythSymbol: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<{ t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; s: string } | null> {
  throwIfAborted(signal);
  await acquirePythSlot();
  try {
    // Re-check after the (possibly long) slot wait — don't burn a rate-limited
    // Pyth request on a fetch whose sweep budget already expired.
    throwIfAborted(signal);
    return await fetchPythCandlesInner(pythSymbol, resolution, fromSec, toSec, signal);
  } finally {
    releasePythSlot();
  }
}

async function fetchPythCandlesInner(
  pythSymbol: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<{ t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; s: string } | null> {
  const params = new URLSearchParams({
    symbol: pythSymbol,
    resolution,
    from: String(fromSec),
    to: String(toSec),
  });

  const url = `${getBenchmarksBase()}/v1/shims/tradingview/history?${params}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithHardTimeout(url, 20000, undefined, signal, 'hermes');
      if ((res.status === 401 || res.status === 403) && !pythBenchmarksAuthWarned) {
        pythBenchmarksAuthWarned = true;
        console.error(
          `[Pyth] Benchmarks returned HTTP ${res.status}: candle source now requires ` +
            'authentication. Set PYTH_HERMES_API_KEY / PYTH_BENCHMARKS_BASE.',
        );
      }
      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        console.log(`[Pyth] Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
        await abortableSleep(wait, signal);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Pyth API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      if (json.s === "error" || json.s === "no_data") {
        return json;
      }
      return json;
    } catch (err: any) {
      // Cancellation FIRST — before any retry accounting (rule 1 above).
      throwIfAborted(signal);
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[Pyth] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
        await abortableSleep(wait, signal);
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function fetchAllPythCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (msg: string) => void,
  deadlineAt: number = Infinity,
  signal?: AbortSignal,
): Promise<ProvenancedOHLCV[]> {
  const pythSymbol = symbolToPythId(symbol);

  if (isNegCached(pythFailedSymbols, pythSymbol)) {
    console.log(`[Pyth] Skipping ${pythSymbol} (recently failed)`);
    return [];
  }

  const resolution = mapTimeframeToPyth(timeframe);
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);

  onProgress?.(`Fetching ${symbol} ${timeframe} from Pyth Benchmarks (fallback)...`);
  console.log(`Fetching OHLCV for ${pythSymbol} ${resolution} from Pyth Benchmarks (Gate.io fallback)`);

  const allCandles: ProvenancedOHLCV[] = [];
  let currentFrom = startSec;
  let page = 0;
  let consecutiveErrors = 0;

  const tfSeconds = getTimeframeSeconds(timeframe);
  const base = symbol.split("/")[0];
  const isNonCrypto = base in NON_CRYPTO_PYTH_MAP;
  const batchSize = isNonCrypto ? Math.min(PYTH_BATCH_SIZE, Math.floor(90 * 86400 / tfSeconds)) : PYTH_BATCH_SIZE;
  const chunkSeconds = tfSeconds * batchSize;

  while (currentFrom < endSec) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineAt) {
      const pythDeadlineMsg = `[Pyth] Fetch deadline reached — stopping with ${allCandles.length} candles for ${pythSymbol} ${resolution}`;
      console.log(pythDeadlineMsg);
      appendTelemetry(pythDeadlineMsg);
      break;
    }
    const chunkEnd = Math.min(currentFrom + chunkSeconds, endSec);

    try {
      const data = await fetchPythCandles(pythSymbol, resolution, currentFrom, chunkEnd, signal);
      consecutiveErrors = 0;

      if (!data || data.s === "error") {
        if (isNonCrypto) {
          console.log(`[Pyth] ${pythSymbol} returned error for chunk ${currentFrom}–${chunkEnd} — skipping (non-crypto, limited history)`);
          currentFrom = chunkEnd;
          await abortableSleep(200, signal);
          continue;
        }
        negCache(pythFailedSymbols, pythSymbol);
        console.log(`[Pyth] ${pythSymbol} returned error status — symbol likely invalid`);
        break;
      }

      if (data.s === "no_data" || !data.t || data.t.length === 0) {
        if (chunkEnd >= endSec) break;
        currentFrom = chunkEnd;
        continue;
      }

      const arrLen = data.t.length;
      if (!Array.isArray(data.o) || !Array.isArray(data.h) || !Array.isArray(data.l) || !Array.isArray(data.c) ||
          data.o.length !== arrLen || data.h.length !== arrLen || data.l.length !== arrLen || data.c.length !== arrLen) {
        console.log(`[Pyth] Misaligned arrays in response (t=${arrLen}, o=${data.o?.length}, h=${data.h?.length}, l=${data.l?.length}, c=${data.c?.length}), skipping chunk`);
        if (chunkEnd >= endSec) break;
        currentFrom = chunkEnd;
        continue;
      }

      for (let i = 0; i < arrLen; i++) {
        const ts = data.t[i] * 1000;
        if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
        const open = data.o[i];
        const high = data.h[i];
        const low = data.l[i];
        const close = data.c[i];
        if (!isValidNumber(open) || !isValidNumber(high) || !isValidNumber(low) || !isValidNumber(close)) continue;
        allCandles.push({
          time: ts,
          open,
          high,
          low,
          close,
          volume: data.v?.[i] || 0,
          provenance: {
            source: "pyth",
            venue: "none",
            basis: "index",
            proxy: sourceProxy(symbol, NON_CRYPTO_PYTH_MAP[base]),
            finality: "unknown",
            timeSemantic: "unknown",
          },
        });
      }

      const lastTs = data.t[data.t.length - 1];
      const nextFrom = lastTs + tfSeconds;
      if (nextFrom <= currentFrom) {
        currentFrom = chunkEnd;
      } else {
        currentFrom = nextFrom;
      }
      page++;

      if (page % 3 === 0) {
        onProgress?.(`Fetched ${allCandles.length} candles for ${symbol} ${timeframe} from Pyth...`);
      }

      await abortableSleep(200, signal);
    } catch (err: any) {
      // Cancellation FIRST — must never count toward consecutive-error stops.
      throwIfAborted(signal);
      consecutiveErrors++;
      console.log(`[Pyth] Page fetch error after ${allCandles.length} candles (error ${consecutiveErrors}/5): ${err.message}`);
      if (consecutiveErrors >= 5) {
        console.log(`[Pyth] Too many consecutive errors, stopping fetch with ${allCandles.length} candles`);
        break;
      }
      await abortableSleep(RETRY_DELAY_MS * consecutiveErrors, signal);
    }
  }

  console.log(`[Pyth] Fetch complete: ${allCandles.length} candles over ${page} pages for ${pythSymbol} ${resolution}`);

  return allCandles;
}

function mapTimeframeToOkx(tf: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1H", "2h": "2H", "4h": "4H", "8h": "8H",
    "12h": "12H", "1d": "1D", "1w": "1W",
  };
  return map[tf] || tf;
}

async function fetchOkxCandles(
  instId: string,
  bar: string,
  afterMs?: number,
  beforeMs?: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const params = new URLSearchParams({ instId, bar, limit: String(OKX_BATCH_SIZE) });
  if (afterMs) params.set("after", String(afterMs));
  if (beforeMs) params.set("before", String(beforeMs));

  const url = `https://www.okx.com/api/v5/market/history-candles?${params}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithHardTimeout(url, 15000, undefined, signal);
      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        console.log(`[OKX] Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
        await abortableSleep(wait, signal);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OKX API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      if (json.code !== "0") {
        // 51001 = "Instrument ID ... doesn't exist" — permanent, non-retryable.
        if (json.code === "51001" || (typeof json.msg === "string" && json.msg.includes("doesn't exist"))) {
          throw new OkxInstrumentNotFoundError(instId, json.msg || json.code);
        }
        throw new Error(`OKX API error: ${json.msg || JSON.stringify(json)}`);
      }
      return json.data || [];
    } catch (err: any) {
      // Cancellation FIRST — before any retry accounting (rule 1 above).
      throwIfAborted(signal);
      // Permanent not-found — propagate immediately, no retry backoff.
      if (err instanceof OkxInstrumentNotFoundError) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[OKX] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
        await abortableSleep(wait, signal);
        continue;
      }
      throw err;
    }
  }
  return [];
}

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "45m": 2_700_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
  "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
};

function aggregateProvenance(group: ProvenancedOHLCV[], complete: boolean): CandleProvenance {
  const same = <K extends keyof CandleProvenance>(key: K): CandleProvenance[K] | "unknown" => {
    const first = group[0].provenance[key];
    return group.every((c) => c.provenance[key] === first) ? first : "unknown";
  };
  const componentFinalities = group.map((c) => c.provenance.finality);
  const finality: CandleFinality = complete && componentFinalities.every((f) => f === "finalized")
    ? "finalized"
    : componentFinalities.some((f) => f === "forming")
      ? "forming"
      : "unknown";
  return {
    source: same("source") as CandleSource,
    venue: same("venue") as CandleVenue,
    basis: same("basis") as CandleBasis,
    proxy: same("proxy") as CandleProxy,
    finality,
    timeSemantic: same("timeSemantic") as CandleTimeSemantic,
  };
}

export function aggregateCandles(
  candles: ProvenancedOHLCV[],
  factor: number,
  targetTfMs?: number,
): ProvenancedOHLCV[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return [];

  if (targetTfMs && targetTfMs > 0) {
    const buckets = new Map<number, ProvenancedOHLCV[]>();
    for (const c of sorted) {
      const bucket = Math.floor(c.time / targetTfMs) * targetTfMs;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(c);
    }
    const result: ProvenancedOHLCV[] = [];
    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
    for (const key of sortedKeys) {
      const group = buckets.get(key)!;
      if (group.length < factor) continue;
      result.push({
        time: group[0].time,
        open: group[0].open,
        high: Math.max(...group.map(c => c.high)),
        low: Math.min(...group.map(c => c.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((s, c) => s + c.volume, 0),
        provenance: aggregateProvenance(group, group.length === factor),
      });
    }
    return result;
  }

  const result: ProvenancedOHLCV[] = [];
  for (let i = 0; i + factor - 1 < sorted.length; i += factor) {
    const group = sorted.slice(i, i + factor);
    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
      provenance: aggregateProvenance(group, group.length === factor),
    });
  }
  return result;
}

const SYNTHETIC_TIMEFRAMES: Record<string, { source: string; factor: number }> = {
  "45m": { source: "15m", factor: 3 },
  "8h": { source: "4h", factor: 2 },
  "8H": { source: "4h", factor: 2 },
};

export interface FetchOHLCVOptions {
  basisPolicy: CandleBasisPolicy;
  skipSpotFallback?: boolean;
  bypassCache?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
  callerClass?: CandleReadCallerClass;
}

export const SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS = 5_000;

export interface PrefetchCachedOHLCVOptions {
  basisPolicy: CandleBasisPolicy;
  signal?: AbortSignal;
  callerClass?: CandleReadCallerClass;
}

export interface PrefetchedOHLCV {
  complete: Map<string, ProvenancedOHLCV[]>;
  prefixes: Map<string, ProvenancedOHLCV[]>;
  exactMisses: Set<string>;
}

export class CandleTailCompletionError extends Error {
  readonly code = "candle_tail_completion_failed";

  constructor(
    public readonly symbol: string,
    public readonly timeframe: string,
    public readonly reason: "empty_prefix" | "merged_range_inadmissible",
  ) {
    super(`Candle tail completion failed for ${symbol} ${timeframe}: ${reason}`);
    this.name = "CandleTailCompletionError";
  }
}

function cacheRangeIsAdmissible(
  cached: readonly ProvenancedOHLCV[],
  timeframe: string,
  startMs: number,
  endMs: number,
): boolean {
  const intervalMs = getTimeframeSeconds(timeframe) * 1000;
  const expectedBars = Math.floor((endMs - startMs) / intervalMs);
  const minCacheBars = Math.min(100, Math.max(1, expectedBars - 1));
  if (cached.length < minCacheBars) return false;
  const isLiveRequest = endMs > Date.now() - 2 * intervalMs;
  const newestCachedTs = cached[cached.length - 1].time;
  return !isLiveRequest || newestCachedTs > endMs - 2 * intervalMs;
}

/**
 * Scanner-only cache prefetch. This function never reaches a network source:
 * misses and any operational failure remain visible to the scanner, which
 * falls back to the unchanged per-market fetch path.
 */
export async function prefetchCachedOHLCV(
  symbols: readonly string[],
  timeframe: string,
  startDate: string | number,
  endDate: string | number,
  options: PrefetchCachedOHLCVOptions,
): Promise<PrefetchedOHLCV> {
  if (!options?.basisPolicy) {
    throw new Error("prefetchCachedOHLCV requires an explicit basisPolicy");
  }
  const normalizedTimeframe = timeframe.toLowerCase();
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  throwIfAborted(options.signal);

  const batchController = new AbortController();
  const timeout = setTimeout(
    () => batchController.abort(CACHE_BUDGET_ABORT_REASON),
    SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
  );
  timeout.unref?.();
  const onCallerAbort = () => batchController.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) batchController.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const grouped = await getCachedCandlesBatch(
      symbols,
      normalizedTimeframe,
      startMs,
      endMs,
      {
        basisPolicy: options.basisPolicy,
        queryTimeoutMs: SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
        signal: batchController.signal,
        callerClass: options.callerClass ?? "scanner",
        admission: "scanner_prefix",
      },
    );
    const complete = new Map<string, ProvenancedOHLCV[]>();
    const prefixes = new Map<string, ProvenancedOHLCV[]>();
    const exactMisses = new Set<string>();
    for (const [symbol, cached] of grouped) {
      if (cached === null) {
        exactMisses.add(symbol);
        continue;
      }
      const policyAdmitted = cached.filter((candle) =>
        candleMatchesBasisPolicy(candle, options.basisPolicy),
      );
      if (policyAdmitted.length === 0) {
        exactMisses.add(symbol);
      } else if (cacheRangeIsAdmissible(policyAdmitted, normalizedTimeframe, startMs, endMs)) {
        complete.set(symbol, policyAdmitted);
      } else {
        prefixes.set(symbol, policyAdmitted);
      }
    }
    return { complete, prefixes, exactMisses };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Deterministic strongest-observation merge for a completed scanner tail. */
export function mergeScannerCandleTail(
  prefix: readonly ProvenancedOHLCV[],
  tail: readonly ProvenancedOHLCV[],
): ProvenancedOHLCV[] {
  const finalityRank: Record<CandleFinality, number> = { finalized: 0, forming: 1, unknown: 2 };
  const identity = ({ provenance: p }: ProvenancedOHLCV) =>
    `${p.source}/${p.venue}/${p.basis}/${p.proxy}/${p.finality}/${p.timeSemantic}`;
  const byTime = new Map<number, ProvenancedOHLCV>();
  for (const candle of [...prefix, ...tail]) {
    const retained = byTime.get(candle.time);
    if (!retained
        || finalityRank[candle.provenance.finality] < finalityRank[retained.provenance.finality]
        || (finalityRank[candle.provenance.finality] === finalityRank[retained.provenance.finality]
          && identity(candle) < identity(retained))) {
      byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Complete a batch-admitted scanner prefix without repeating its DB lookup or
 * refetching its deep history. The merged result is never returned until the
 * original range passes the unchanged money policy, row floor and freshness.
 */
export async function completeCachedOHLCVTail(
  symbol: string,
  timeframe: string,
  startDate: string | number,
  endDate: string | number,
  prefix: readonly ProvenancedOHLCV[],
  onProgress: ((msg: string) => void) | undefined,
  options: FetchOHLCVOptions,
): Promise<ProvenancedOHLCV[]> {
  if (prefix.length === 0) {
    throw new CandleTailCompletionError(symbol, timeframe, "empty_prefix");
  }
  const normalizedTimeframe = timeframe.toLowerCase();
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const orderedPrefix = [...prefix].sort((a, b) => a.time - b.time);
  const overlapStartMs = Math.max(startMs, orderedPrefix[orderedPrefix.length - 1].time);
  try {
    const tail = await fetchOHLCV(
      symbol,
      normalizedTimeframe,
      overlapStartMs,
      endMs,
      onProgress,
      { ...options, basisPolicy: options.basisPolicy, bypassCache: true },
    );
    const merged = mergeScannerCandleTail(orderedPrefix, tail).filter(
      (candle) => candle.time >= startMs
        && candle.time <= endMs
        && candleMatchesBasisPolicy(candle, options.basisPolicy),
    );
    if (!cacheRangeIsAdmissible(merged, normalizedTimeframe, startMs, endMs)) {
      throw new CandleTailCompletionError(symbol, normalizedTimeframe, "merged_range_inadmissible");
    }
    const line =
      `[ScannerTailCompletion] ${symbol} ${normalizedTimeframe} outcome=complete ` +
      `prefix=${orderedPrefix.length} tail=${tail.length} merged=${merged.length}`;
    console.log(line);
    appendTelemetry(line);
    return merged;
  } catch (error) {
    const line =
      `[ScannerTailCompletion] ${symbol} ${normalizedTimeframe} outcome=failed ` +
      `reason=${error instanceof Error ? error.name : "unknown"}`;
    console.log(line);
    appendTelemetry(line);
    throw error;
  }
}

export function fetchOHLCV(
  symbol: string,
  timeframe: string,
  startDate: string | number,
  endDate: string | number,
  onProgress: ((msg: string) => void) | undefined,
  options: FetchOHLCVOptions,
): Promise<ProvenancedOHLCV[]>;
export async function fetchOHLCV(
  symbol: string,
  timeframe: string,
  startDate: string | number,
  endDate: string | number,
  onProgress?: (msg: string) => void,
  options?: {
    basisPolicy: CandleBasisPolicy;
    skipSpotFallback?: boolean;
    bypassCache?: boolean;
    deadlineMs?: number;
    /**
     * Cooperative cancellation: when the caller aborts (e.g. scanner sweep
     * budget expiry), the whole fetch chain — retries, backoff sleeps,
     * pagination, in-flight HTTP — unwinds promptly with an AbortError.
     * Cancellation NEVER negcaches instruments or trips source breakers.
     */
    signal?: AbortSignal;
    /** Attribution for candle-read phase telemetry. */
    callerClass?: CandleReadCallerClass;
  }
): Promise<ProvenancedOHLCV[]> {
  if (!options?.basisPolicy) {
    throw new Error("fetchOHLCV requires an explicit basisPolicy");
  }
  const basisPolicy = options.basisPolicy;
  let sawMalformedProvenance = false;
  const typedFailure = basisPolicy.consumer === "scanner" || basisPolicy.consumer === "ai_context";
  const finishWithPolicy = (candles: ProvenancedOHLCV[]): ProvenancedOHLCV[] => {
    const admitted = candles.filter((c) => candleMatchesBasisPolicy(c, basisPolicy));
    if (basisPolicy.consumer === "lab") {
      const identities = [...new Set(admitted.map(({ provenance: p }) =>
        `${p.source}/${p.venue}/${p.basis}/${p.proxy}/${p.finality}/${p.timeSemantic}`,
      ))].sort().join(",");
      console.log(`[CandleProvenance] ${symbol} ${timeframe} ${identities || "unavailable"} bars=${admitted.length}`);
    }
    if (admitted.length > 0 || !typedFailure) return admitted;
    const sawExcludedFinality = candles.some((c) => {
      const p = c.provenance;
      return p.source !== "unknown"
        && p.venue !== "unknown"
        && p.basis !== "unknown"
        && p.proxy !== "unknown"
        && p.timeSemantic !== "unknown"
        && basisPolicy.acceptedBasis.includes(p.basis)
        && basisPolicy.acceptedProxy.includes(p.proxy)
        && !basisPolicy.acceptedFinality.includes(p.finality);
    });
    const reason: CandleBasisUnavailableReason = sawMalformedProvenance
      ? "malformed_provenance"
      : sawExcludedFinality
        ? "nonfinalized_only"
        : "no_acceptable_source";
    throw new CandleBasisUnavailableError(reason, symbol, timeframe);
  };
  timeframe = timeframe.toLowerCase();
  const signal = options.signal;
  throwIfAborted(signal);
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  // Optional overall deadline: bounds total time across pagination loops and
  // source fallbacks. Individual in-flight HTTP calls (each already capped by
  // AbortSignal.timeout + bounded retries) are allowed to finish past it, so
  // the effective worst case is deadline + one call chain (~50s).
  const deadlineAt = options?.deadlineMs ? Date.now() + options.deadlineMs : Infinity;

  onProgress?.(`Checking cache for ${symbol} ${timeframe}...`);
  // Bound the cache lookup when the caller set a deadline: the deadline clock
  // starts BEFORE this DB read, so a slow/wedged DB otherwise consumes the
  // entire fetch budget before any network attempt (2026-07-19 incident:
  // traces showed okx hitting its 45s deadline 0.4s into the network section
  // because the cache read ate ~44.6s). A read that exceeds its budget FAILS
  // the invocation with CacheDegradedError (2026-07-20 incident: treating it
  // as a miss started a network fetch + full-range cache write-back exactly
  // while the DB was under pressure). Deadline-less callers (Lab backtests)
  // keep waiting unbounded — for them a slow cache read is still far cheaper
  // than refetching years of candles.
  const cacheStartedAt = Date.now();
  let cached: ProvenancedOHLCV[] | null = null;
  if (!options?.bypassCache) {
    if (Number.isFinite(deadlineAt)) {
      const cacheBudgetMs = Math.min(5_000, Math.max(1_000, Math.floor((options?.deadlineMs ?? 0) / 4)));
      // Cooperative cancellation through the FULL admission path (2026-07-20
      // incident): the old Promise.race abandoned the read but left it
      // running — it could still queue at the semaphore, wait 30s at
      // pool.connect(), and run its SELECT long after this caller had moved
      // on. Now one AbortSignal cancels semaphore wait / pool acquisition /
      // post-acquire promptly; only an already-in-flight SELECT runs to its
      // own query_timeout (cacheBudgetMs + 500ms), so the worst-case await
      // here is budget + ~0.5s and NO abandoned work survives this scope.
      //
      // Two abort sources share the signal, distinguished by reason:
      //  - internal budget timer  -> typed CacheDegradedError (fail the
      //    invocation: no network fallback, no negcache, no cache write)
      //  - caller signal (sweep teardown) -> plain AbortError (no incident)
      const budgetCtrl = new AbortController();
      const budgetTimer = setTimeout(
        () => budgetCtrl.abort(CACHE_BUDGET_ABORT_REASON),
        cacheBudgetMs,
      );
      budgetTimer.unref?.();
      const onCallerAbort = () => budgetCtrl.abort();
      if (signal) {
        if (signal.aborted) budgetCtrl.abort();
        else signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      let phases: CandleReadPhases | undefined;
      try {
        cached = await getCachedCandles(symbol, timeframe, startMs, endMs, {
          basisPolicy,
          queryTimeoutMs: cacheBudgetMs + 500,
          signal: budgetCtrl.signal,
          callerClass: options?.callerClass ?? "scanner",
          onPhases: (p) => {
            phases = p;
          },
        });
      } catch (err: any) {
        // Signal-state is authoritative — check state before error name so a
        // query that rejects with a plain Error after a signal fired is still
        // classified by that signal's outcome, not by the error's name.
        if (signal?.aborted) {
          // Caller cancelled (sweep teardown): plain abort, no incident,
          // no degradation accounting.
          if (err?.name === "AbortError") throw err;
          throw makeAbortError();
        }
        if (budgetCtrl.signal.aborted || err?.name === "AbortError") {
          // Budget expiry: budgetCtrl fired (regardless of what the query
          // threw — signal state wins), OR the inner AbortError surfaced
          // from the candle-store's budget-abort path. Either way: typed
          // degradation. Do NOT reinterpret as a miss.
          const ph = phases
            ? ` sem=${phases.semaphoreWaitMs}ms acquire=${phases.poolAcquireMs}ms query=${phases.queryMs}ms`
            : "";
          const slowMsg = `[CandleCache] Degraded: read >${cacheBudgetMs}ms for ${symbol} ${timeframe} — failing invocation (no network fallback)${ph}`;
          console.log(slowMsg);
          appendTelemetry(slowMsg);
          try {
            datafeedIncidentReporter?.({ kind: "slow_cache", symbol, timeframe, budgetMs: cacheBudgetMs, phases });
          } catch {
            // Reporter must never break the fetch path.
          }
          throw new CacheDegradedError(symbol, timeframe, cacheBudgetMs, phases);
        }
        // Operational error (pool checkout failure, SQL/query timeout,
        // connection error) that reached us before either signal fired.
        // Any cache-read operational failure is degradation — never a miss
        // that would start a network fallback while the DB is degraded.
        const phOp = phases
          ? ` sem=${phases.semaphoreWaitMs}ms acquire=${phases.poolAcquireMs}ms query=${phases.queryMs}ms`
          : "";
        const opMsg = `[CandleCache] Degraded (cache read error): ${symbol} ${timeframe}${phOp}: ${err?.message ?? String(err)}`;
        console.log(opMsg);
        appendTelemetry(opMsg);
        try {
          datafeedIncidentReporter?.({ kind: "slow_cache", symbol, timeframe, budgetMs: cacheBudgetMs, phases });
        } catch {
          // Reporter must never break the fetch path.
        }
        throw new CacheDegradedError(symbol, timeframe, cacheBudgetMs, phases);
      } finally {
        clearTimeout(budgetTimer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
      }
    } else {
      cached = await getCachedCandles(symbol, timeframe, startMs, endMs, {
        basisPolicy,
        callerClass: options?.callerClass ?? "lab",
      });
    }
  }
  const cacheReadMs = Date.now() - cacheStartedAt;
  // Range-aware completeness floor: a request spanning only N bars can never
  // return 100 candles, so short live windows (e.g. an open paper position's
  // entry→now bracket check) would otherwise bypass the cache on EVERY tick.
  const requestIntervalMs = getTimeframeSeconds(timeframe) * 1000;
  const expectedBars = Math.floor((endMs - startMs) / requestIntervalMs);
  const minCacheBars = Math.min(100, Math.max(1, expectedBars - 1));
  if (cached && cached.length >= minCacheBars) {
    // For live requests (endMs near now), also require the newest cached candle to be
    // recent enough. Historical backtest ranges (endMs well in the past) always
    // cache-hit unchanged — QuantumLab optimizer depends on this behaviour.
    const intervalMs = requestIntervalMs;
    const isLiveRequest = endMs > Date.now() - 2 * intervalMs;
    const newestCachedTs = cached[cached.length - 1].time;
    if (!isLiveRequest || newestCachedTs > endMs - 2 * intervalMs) {
      console.log(`[CandleCache] Hit: ${cached.length} candles for ${symbol} ${timeframe}`);
      onProgress?.(`Loaded ${cached.length} cached candles for ${symbol} ${timeframe}`);
      return finishWithPolicy(cached);
    }
    console.log(
      `[CandleCache] Live miss: newest candle is ` +
      `${Math.round(((endMs - newestCachedTs) / intervalMs) * 10) / 10} intervals stale — refetching`
    );
  }

  throwIfAborted(signal);

  const synthetic = SYNTHETIC_TIMEFRAMES[timeframe];
  if (synthetic) {
    onProgress?.(`Synthesizing ${timeframe} from ${synthetic.source} candles...`);
    const sourceCandles = await fetchOHLCV(symbol, synthetic.source, startDate, endDate, onProgress, options);
    const targetTfMs = TIMEFRAME_MS[timeframe.toLowerCase()] || 0;
    const aggregated = finishWithPolicy(aggregateCandles(sourceCandles, synthetic.factor, targetTfMs));
    console.log(`[Synthetic] Built ${aggregated.length} ${timeframe} candles from ${sourceCandles.length} ${synthetic.source} candles (aligned to ${targetTfMs}ms boundaries)`);
    onProgress?.(`Synthesized ${aggregated.length} ${timeframe} candles from ${synthetic.source}`);

    throwIfAborted(signal); // aborted fetches never fire background writes
    if (aggregated.length > 0) {
      saveCandlesToDb(symbol, timeframe, aggregated).catch((err) => {
        const line = `[CandleCache] Background save error: ${err instanceof Error ? err.message : String(err)}`;
        console.log(line);
        appendTelemetry(line);
      });
    }

    return aggregated;
  }

  const nonCrypto = isNonCryptoSymbol(symbol);
  const instId = symbolToOkxInstId(symbol);
  let allCandles: ProvenancedOHLCV[] = [];

  // Per-fetch source-chain trace: one compact line showing which sources ran,
  // what each returned, and where the time went. Emitted for every EMPTY or
  // SLOW (>10s) network fetch; DATAFEED_VERBOSE=1 emits it for every fetch.
  const netStart = Date.now();
  const trace: string[] = [];
  // Surface pre-network time spent on the DB cache read (>1s only): a wedged
  // DB consuming the fetch deadline before the network section is otherwise
  // invisible and gets misattributed to the first source in the trace.
  if (cacheReadMs > 1_000) trace.push(`cache=${(cacheReadMs / 1000).toFixed(1)}s`);
  const emitTrace = (count: number) => {
    const elapsedMs = Date.now() - netStart;
    if (!DATAFEED_VERBOSE && count > 0 && elapsedMs <= 10_000) return;
    const line = `[Datafeed] ${symbol} ${timeframe}: ${trace.join(" ")} total=${(elapsedMs / 1000).toFixed(1)}s candles=${count}`;
    console.log(line);
    appendTelemetry(line);
  };

  if (nonCrypto) {
    if (!basisPolicy.acceptedBasis.includes("index")) {
      emitTrace(0);
      return finishWithPolicy([]);
    }
    onProgress?.(`Fetching ${symbol} ${timeframe} from Pyth (non-crypto)...`);
    try {
      allCandles = await fetchAllPythCandles(symbol, timeframe, startMs, endMs, onProgress, deadlineAt, signal);
    } catch (err: any) {
      // Cancellation must escape this swallowing catch — the caller needs to
      // see the AbortError, and an aborted fetch proves nothing about Pyth.
      throwIfAborted(signal);
      console.log(`[Pyth] Non-crypto fetch failed for ${symbol} ${timeframe}: ${err.message}`);
    }
    trace.push(`pyth=${allCandles.length}c/${((Date.now() - netStart) / 1000).toFixed(1)}s`);

    if (allCandles.length > 0) {
      const deduped = deduplicateCandles(finishWithPolicy(allCandles));
      emitTrace(deduped.length);
      onProgress?.(`Fetched ${deduped.length} candles for ${symbol} ${timeframe}`);
      throwIfAborted(signal); // aborted fetches never fire background writes
      saveCandlesToDb(symbol, timeframe, deduped).catch((err) => {
        const line = `[CandleCache] Background save error: ${err instanceof Error ? err.message : String(err)}`;
        console.log(line);
        appendTelemetry(line);
      });
      return deduped;
    }

    emitTrace(0);
    onProgress?.(`No candle data available for ${symbol} ${timeframe} from Pyth`);
    return finishWithPolicy(allCandles);
  }

  const okxNegCachedAtEntry = isNegCached(okxFailedInstruments, instId);
  const okxSourceDownAtEntry = isOkxSourceDown();
  if (basisPolicy.acceptedBasis.includes("perp") && !okxNegCachedAtEntry && !okxSourceDownAtEntry) {
    const bar = mapTimeframeToOkx(timeframe);
    onProgress?.(`Fetching ${symbol} ${timeframe} from OKX...`);
    console.log(`Fetching OHLCV for ${instId} ${bar} from ${startDate} to ${endDate} via OKX`);

    let currentEndMs = endMs;
    let page = 0;
    let emptyPages = 0;
    let consecutiveErrors = 0;
    let attemptedNetwork = false;

    while (currentEndMs > startMs) {
      throwIfAborted(signal);
      if (Date.now() >= deadlineAt) {
        const okxDeadlineMsg = `[OKX] Fetch deadline reached — stopping with ${allCandles.length} candles for ${instId} ${bar}`;
        console.log(okxDeadlineMsg);
        appendTelemetry(okxDeadlineMsg);
        break;
      }
      try {
        attemptedNetwork = true;
        const raw = await fetchOkxCandles(instId, bar, currentEndMs, undefined, signal);
        // Any well-formed API response (even empty data / exhausted 429
        // retries) proves the OKX source is reachable.
        recordOkxSourceSuccess();
        consecutiveErrors = 0;

        if (!raw || raw.length === 0) {
          emptyPages++;
          if (emptyPages > 5) break;
          currentEndMs -= getTimeframeSeconds(timeframe) * OKX_BATCH_SIZE * 1000;
          continue;
        }
        emptyPages = 0;

        for (const candle of raw) {
          if (!Array.isArray(candle) || candle.length < 9 || (candle[8] !== "0" && candle[8] !== "1")) {
            sawMalformedProvenance = true;
            continue;
          }
          const ts = parseInt(candle[0]);
          const open = parseFloat(candle[1]);
          const high = parseFloat(candle[2]);
          const low = parseFloat(candle[3]);
          const close = parseFloat(candle[4]);
          if (!Number.isFinite(ts) || ts < startMs || ts > endMs
              || !isValidNumber(open) || !isValidNumber(high)
              || !isValidNumber(low) || !isValidNumber(close)) {
            sawMalformedProvenance = true;
            continue;
          }
          allCandles.push({
            time: ts,
            open,
            high,
            low,
            close,
            volume: parseFloat(candle[5] || "0"),
            provenance: {
              source: "okx",
              venue: "okx",
              basis: "perp",
              proxy: sourceProxy(symbol),
              finality: candle[8] === "1" ? "finalized" : "forming",
              timeSemantic: "open_time",
            },
          });
        }

        const oldestTs = parseInt(raw[raw.length - 1][0]);
        if (oldestTs >= currentEndMs) break;
        currentEndMs = oldestTs;
        if (currentEndMs <= startMs) break;
        page++;

        if (page % 5 === 0) {
          onProgress?.(`Fetched ${allCandles.length} candles for ${symbol} ${timeframe}...`);
        }

        await abortableSleep(200, signal);
      } catch (err: any) {
        // Cancellation FIRST — a budget abort must never negcache the
        // instrument, count toward consecutive errors, or trip the breaker.
        throwIfAborted(signal);
        // Instrument doesn't exist on OKX — negcache NOW and stop. The old
        // path retried 5 more pages with escalating sleeps before negcaching.
        // The API answered authoritatively, so the SOURCE is reachable.
        if (err instanceof OkxInstrumentNotFoundError) {
          recordOkxSourceSuccess();
          negCache(okxFailedInstruments, instId);
          console.log(`[OKX] ${instId} does not exist — negcached, falling through to Gate.io spot`);
          break;
        }
        consecutiveErrors++;
        console.log(`[OKX] Page fetch error after ${allCandles.length} candles (error ${consecutiveErrors}/5): ${err.message}`);
        if (consecutiveErrors >= 5) {
          console.log(`[OKX] Too many consecutive errors, stopping fetch with ${allCandles.length} candles`);
          break;
        }
        await abortableSleep(RETRY_DELAY_MS * consecutiveErrors, signal);
      }
    }

    console.log(`[OKX] Fetch complete: ${allCandles.length} candles over ${page} pages for ${instId} ${bar}`);

    if (allCandles.length === 0) {
      // Network-type failure (timeouts/refused — NOT a not-found, which
      // resets above): count it toward the source-level breaker.
      if (attemptedNetwork && consecutiveErrors > 0) {
        recordOkxSourceFailure(instId);
      }
      // Only negcache the instrument if we actually reached the network for
      // it — a deadline hit before the first attempt proves nothing.
      if (attemptedNetwork && !isNegCached(okxFailedInstruments, instId)) {
        negCache(okxFailedInstruments, instId);
        console.log(`[OKX] ${instId} not available — will use Gate.io spot fallback for future requests`);
      }
      trace.push(`okx=0c/${((Date.now() - netStart) / 1000).toFixed(1)}s(${attemptedNetwork ? "unavailable" : "deadline"})`);
    } else {
      trace.push(`okx=${allCandles.length}c/${((Date.now() - netStart) / 1000).toFixed(1)}s`);
    }
  } else if (!basisPolicy.acceptedBasis.includes("perp")) {
    trace.push("okx=policy-skip");
  } else if (okxNegCachedAtEntry) {
    console.log(`[OKX] Skipping ${instId} (recently failed) — trying Gate.io spot`);
    trace.push("okx=negcached-skip");
  } else {
    console.log(`[OKX] Skipping ${instId} (source circuit breaker OPEN) — trying Gate.io spot`);
    trace.push("okx=source-down-skip");
  }

  throwIfAborted(signal); // no NEW source attempt after cancellation

  if (allCandles.length === 0 && basisPolicy.acceptedBasis.includes("spot")
      && !options?.skipSpotFallback && Date.now() < deadlineAt) {
    const gateStart = Date.now();
    const gateNegCachedAtEntry = isNegCached(gateFailedPairs, symbolToGateSpotPair(symbol));
    try {
      allCandles = await fetchAllGateCandles(symbol, timeframe, startMs, endMs, onProgress, deadlineAt, signal);
    } catch (err: any) {
      // Cancellation must escape this swallowing catch.
      throwIfAborted(signal);
      console.log(`[Gate Spot] Fallback failed for ${symbol} ${timeframe}: ${err.message}`);
    }
    trace.push(
      gateNegCachedAtEntry
        ? "gate=negcached-skip"
        : `gate=${allCandles.length}c/${((Date.now() - gateStart) / 1000).toFixed(1)}s`,
    );
  }

  if (allCandles.length === 0 && basisPolicy.acceptedBasis.includes("index")
      && !options?.skipSpotFallback && Date.now() < deadlineAt) {
    throwIfAborted(signal); // no NEW source attempt after cancellation
    const pythStart = Date.now();
    const pythNegCachedAtEntry = isNegCached(pythFailedSymbols, symbolToPythId(symbol));
    try {
      allCandles = await fetchAllPythCandles(symbol, timeframe, startMs, endMs, onProgress, deadlineAt, signal);
    } catch (err: any) {
      // Cancellation must escape this swallowing catch.
      throwIfAborted(signal);
      console.log(`[Pyth] Fallback failed for ${symbol} ${timeframe}: ${err.message}`);
    }
    trace.push(
      pythNegCachedAtEntry
        ? "pyth=negcached-skip"
        : `pyth=${allCandles.length}c/${((Date.now() - pythStart) / 1000).toFixed(1)}s`,
    );
  }

  if (allCandles.length > 0) {
    const deduped = deduplicateCandles(finishWithPolicy(allCandles));
    if (deduped.length === 0) {
      emitTrace(0);
      onProgress?.(`Candle data for ${symbol} ${timeframe} was provenance-ineligible`);
      return deduped;
    }
    emitTrace(deduped.length);
    onProgress?.(`Fetched ${deduped.length} candles for ${symbol} ${timeframe}`);

    throwIfAborted(signal); // aborted fetches never fire background writes
    saveCandlesToDb(symbol, timeframe, deduped).catch((err) => {
      const line = `[CandleCache] Background save error: ${err instanceof Error ? err.message : String(err)}`;
      console.log(line);
      appendTelemetry(line);
    });

    return deduped;
  }

  emitTrace(0);
  onProgress?.(`No candle data available for ${symbol} ${timeframe} from OKX, Gate.io, or Pyth`);
  return finishWithPolicy(allCandles);
}

function deduplicateCandles(candles: ProvenancedOHLCV[]): ProvenancedOHLCV[] {
  const seen = new Set<number>();
  const result: ProvenancedOHLCV[] = [];
  for (const c of candles) {
    if (!seen.has(c.time)) {
      seen.add(c.time);
      result.push(c);
    }
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

export function getTimeframeSeconds(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "45m": 2700,
    "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800,
  };
  return map[tf] || 900;
}
