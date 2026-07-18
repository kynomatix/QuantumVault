import type { OHLCV } from "./engine";
import { getCachedCandles, saveCandlesToDb } from "./candle-store";
import { getBenchmarksBase, getHermesHeaders } from '../pricing/hermes-config.js';
import { appendTelemetry } from "../telemetry";

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

function stripMultiplierPrefix(base: string): string {
  const match = base.match(/^1[KM](.+)$/i);
  return match ? match[1] : base;
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

async function fetchGateCandles(
  pair: string,
  interval: string,
  fromSec: number,
  toSec: number,
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
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        console.log(`[Gate Spot] Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, wait));
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
            const firstHalf = await fetchGateCandles(pair, interval, fromSec, fromSec + halfRange);
            const secondHalf = await fetchGateCandles(pair, interval, fromSec + halfRange, toSec);
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
      // Permanent not-found — retrying cannot succeed; propagate immediately
      // so the caller negcaches without burning the retry backoff.
      if (err instanceof GatePairNotFoundError) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[Gate Spot] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
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
): Promise<OHLCV[]> {
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

  const allCandles: OHLCV[] = [];
  let currentFrom = startSec;
  let page = 0;
  let consecutiveErrors = 0;

  const tfSeconds = getTimeframeSeconds(timeframe);
  const windowSeconds = tfSeconds * GATE_BATCH_SIZE;

  while (currentFrom < endSec) {
    if (Date.now() >= deadlineAt) {
      const gateDeadlineMsg = `[Gate Spot] Fetch deadline reached — stopping with ${allCandles.length} candles for ${pair} ${interval}`;
      console.log(gateDeadlineMsg);
      appendTelemetry(gateDeadlineMsg);
      break;
    }
    const chunkEnd = Math.min(currentFrom + windowSeconds, endSec);
    try {
      const raw = await fetchGateCandles(pair, interval, currentFrom, chunkEnd);
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

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err: any) {
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
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * consecutiveErrors));
    }
  }

  console.log(`[Gate Spot] Fetch complete: ${allCandles.length} candles over ${page} pages for ${pair} ${interval}`);

  return allCandles;
}

async function fetchPythCandles(
  pythSymbol: string,
  resolution: string,
  fromSec: number,
  toSec: number,
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
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: getHermesHeaders() });
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
        await new Promise(resolve => setTimeout(resolve, wait));
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
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[Pyth] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
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
): Promise<OHLCV[]> {
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

  const allCandles: OHLCV[] = [];
  let currentFrom = startSec;
  let page = 0;
  let consecutiveErrors = 0;

  const tfSeconds = getTimeframeSeconds(timeframe);
  const base = symbol.split("/")[0];
  const isNonCrypto = base in NON_CRYPTO_PYTH_MAP;
  const batchSize = isNonCrypto ? Math.min(PYTH_BATCH_SIZE, Math.floor(90 * 86400 / tfSeconds)) : PYTH_BATCH_SIZE;
  const chunkSeconds = tfSeconds * batchSize;

  while (currentFrom < endSec) {
    if (Date.now() >= deadlineAt) {
      const pythDeadlineMsg = `[Pyth] Fetch deadline reached — stopping with ${allCandles.length} candles for ${pythSymbol} ${resolution}`;
      console.log(pythDeadlineMsg);
      appendTelemetry(pythDeadlineMsg);
      break;
    }
    const chunkEnd = Math.min(currentFrom + chunkSeconds, endSec);

    try {
      const data = await fetchPythCandles(pythSymbol, resolution, currentFrom, chunkEnd);
      consecutiveErrors = 0;

      if (!data || data.s === "error") {
        if (isNonCrypto) {
          console.log(`[Pyth] ${pythSymbol} returned error for chunk ${currentFrom}–${chunkEnd} — skipping (non-crypto, limited history)`);
          currentFrom = chunkEnd;
          await new Promise(resolve => setTimeout(resolve, 200));
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

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err: any) {
      consecutiveErrors++;
      console.log(`[Pyth] Page fetch error after ${allCandles.length} candles (error ${consecutiveErrors}/5): ${err.message}`);
      if (consecutiveErrors >= 5) {
        console.log(`[Pyth] Too many consecutive errors, stopping fetch with ${allCandles.length} candles`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * consecutiveErrors));
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
  beforeMs?: number
): Promise<any[]> {
  const params = new URLSearchParams({ instId, bar, limit: String(OKX_BATCH_SIZE) });
  if (afterMs) params.set("after", String(afterMs));
  if (beforeMs) params.set("before", String(beforeMs));

  const url = `https://www.okx.com/api/v5/market/history-candles?${params}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        console.log(`[OKX] Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, wait));
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
      // Permanent not-found — propagate immediately, no retry backoff.
      if (err instanceof OkxInstrumentNotFoundError) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[OKX] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
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

function aggregateCandles(candles: OHLCV[], factor: number, targetTfMs?: number): OHLCV[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return [];

  if (targetTfMs && targetTfMs > 0) {
    const buckets = new Map<number, OHLCV[]>();
    for (const c of sorted) {
      const bucket = Math.floor(c.time / targetTfMs) * targetTfMs;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(c);
    }
    const result: OHLCV[] = [];
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
      });
    }
    return result;
  }

  const result: OHLCV[] = [];
  for (let i = 0; i + factor - 1 < sorted.length; i += factor) {
    const group = sorted.slice(i, i + factor);
    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

const SYNTHETIC_TIMEFRAMES: Record<string, { source: string; factor: number }> = {
  "45m": { source: "15m", factor: 3 },
  "8h": { source: "4h", factor: 2 },
  "8H": { source: "4h", factor: 2 },
};

export async function fetchOHLCV(
  symbol: string,
  timeframe: string,
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
  options?: { skipSpotFallback?: boolean; bypassCache?: boolean; deadlineMs?: number }
): Promise<OHLCV[]> {
  timeframe = timeframe.toLowerCase();
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  // Optional overall deadline: bounds total time across pagination loops and
  // source fallbacks. Individual in-flight HTTP calls (each already capped by
  // AbortSignal.timeout + bounded retries) are allowed to finish past it, so
  // the effective worst case is deadline + one call chain (~50s).
  const deadlineAt = options?.deadlineMs ? Date.now() + options.deadlineMs : Infinity;

  onProgress?.(`Checking cache for ${symbol} ${timeframe}...`);
  const cached = options?.bypassCache ? null : await getCachedCandles(symbol, timeframe, startMs, endMs);
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
      return cached;
    }
    console.log(
      `[CandleCache] Live miss: newest candle is ` +
      `${Math.round(((endMs - newestCachedTs) / intervalMs) * 10) / 10} intervals stale — refetching`
    );
  }

  const synthetic = SYNTHETIC_TIMEFRAMES[timeframe];
  if (synthetic) {
    onProgress?.(`Synthesizing ${timeframe} from ${synthetic.source} candles...`);
    const sourceCandles = await fetchOHLCV(symbol, synthetic.source, startDate, endDate, onProgress, options);
    const targetTfMs = TIMEFRAME_MS[timeframe.toLowerCase()] || 0;
    const aggregated = aggregateCandles(sourceCandles, synthetic.factor, targetTfMs);
    console.log(`[Synthetic] Built ${aggregated.length} ${timeframe} candles from ${sourceCandles.length} ${synthetic.source} candles (aligned to ${targetTfMs}ms boundaries)`);
    onProgress?.(`Synthesized ${aggregated.length} ${timeframe} candles from ${synthetic.source}`);

    if (aggregated.length > 0) {
      saveCandlesToDb(symbol, timeframe, aggregated).catch((err) =>
        console.log(`[CandleCache] Background save error: ${err.message}`)
      );
    }

    return aggregated;
  }

  const nonCrypto = isNonCryptoSymbol(symbol);
  const instId = symbolToOkxInstId(symbol);
  let allCandles: OHLCV[] = [];

  // Per-fetch source-chain trace: one compact line showing which sources ran,
  // what each returned, and where the time went. Emitted for every EMPTY or
  // SLOW (>10s) network fetch; DATAFEED_VERBOSE=1 emits it for every fetch.
  const netStart = Date.now();
  const trace: string[] = [];
  const emitTrace = (count: number) => {
    const elapsedMs = Date.now() - netStart;
    if (!DATAFEED_VERBOSE && count > 0 && elapsedMs <= 10_000) return;
    const line = `[Datafeed] ${symbol} ${timeframe}: ${trace.join(" ")} total=${(elapsedMs / 1000).toFixed(1)}s candles=${count}`;
    console.log(line);
    appendTelemetry(line);
  };

  if (nonCrypto) {
    onProgress?.(`Fetching ${symbol} ${timeframe} from Pyth (non-crypto)...`);
    try {
      allCandles = await fetchAllPythCandles(symbol, timeframe, startMs, endMs, onProgress, deadlineAt);
    } catch (err: any) {
      console.log(`[Pyth] Non-crypto fetch failed for ${symbol} ${timeframe}: ${err.message}`);
    }
    trace.push(`pyth=${allCandles.length}c/${((Date.now() - netStart) / 1000).toFixed(1)}s`);

    if (allCandles.length > 0) {
      const deduped = deduplicateCandles(allCandles);
      emitTrace(deduped.length);
      onProgress?.(`Fetched ${deduped.length} candles for ${symbol} ${timeframe}`);
      saveCandlesToDb(symbol, timeframe, deduped).catch((err) =>
        console.log(`[CandleCache] Background save error: ${err.message}`)
      );
      return deduped;
    }

    emitTrace(0);
    onProgress?.(`No candle data available for ${symbol} ${timeframe} from Pyth`);
    return allCandles;
  }

  const okxNegCachedAtEntry = isNegCached(okxFailedInstruments, instId);
  const okxSourceDownAtEntry = isOkxSourceDown();
  if (!okxNegCachedAtEntry && !okxSourceDownAtEntry) {
    const bar = mapTimeframeToOkx(timeframe);
    onProgress?.(`Fetching ${symbol} ${timeframe} from OKX...`);
    console.log(`Fetching OHLCV for ${instId} ${bar} from ${startDate} to ${endDate} via OKX`);

    let currentEndMs = endMs;
    let page = 0;
    let emptyPages = 0;
    let consecutiveErrors = 0;
    let attemptedNetwork = false;

    while (currentEndMs > startMs) {
      if (Date.now() >= deadlineAt) {
        const okxDeadlineMsg = `[OKX] Fetch deadline reached — stopping with ${allCandles.length} candles for ${instId} ${bar}`;
        console.log(okxDeadlineMsg);
        appendTelemetry(okxDeadlineMsg);
        break;
      }
      try {
        attemptedNetwork = true;
        const raw = await fetchOkxCandles(instId, bar, currentEndMs);
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
          const ts = parseInt(candle[0]);
          if (ts < startMs || ts > endMs) continue;
          allCandles.push({
            time: ts,
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5] || "0"),
          });
        }

        const oldestTs = parseInt(raw[raw.length - 1][0]);
        if (oldestTs >= currentEndMs) break;
        currentEndMs = oldestTs;
        page++;

        if (page % 5 === 0) {
          onProgress?.(`Fetched ${allCandles.length} candles for ${symbol} ${timeframe}...`);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err: any) {
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
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * consecutiveErrors));
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
  } else if (okxNegCachedAtEntry) {
    console.log(`[OKX] Skipping ${instId} (recently failed) — trying Gate.io spot`);
    trace.push("okx=negcached-skip");
  } else {
    console.log(`[OKX] Skipping ${instId} (source circuit breaker OPEN) — trying Gate.io spot`);
    trace.push("okx=source-down-skip");
  }

  if (allCandles.length === 0 && !options?.skipSpotFallback && Date.now() < deadlineAt) {
    const gateStart = Date.now();
    const gateNegCachedAtEntry = isNegCached(gateFailedPairs, symbolToGateSpotPair(symbol));
    try {
      allCandles = await fetchAllGateCandles(symbol, timeframe, startMs, endMs, onProgress, deadlineAt);
    } catch (err: any) {
      console.log(`[Gate Spot] Fallback failed for ${symbol} ${timeframe}: ${err.message}`);
    }
    trace.push(
      gateNegCachedAtEntry
        ? "gate=negcached-skip"
        : `gate=${allCandles.length}c/${((Date.now() - gateStart) / 1000).toFixed(1)}s`,
    );
  }

  if (allCandles.length === 0 && !options?.skipSpotFallback && Date.now() < deadlineAt) {
    const pythStart = Date.now();
    const pythNegCachedAtEntry = isNegCached(pythFailedSymbols, symbolToPythId(symbol));
    try {
      allCandles = await fetchAllPythCandles(symbol, timeframe, startMs, endMs, onProgress, deadlineAt);
    } catch (err: any) {
      console.log(`[Pyth] Fallback failed for ${symbol} ${timeframe}: ${err.message}`);
    }
    trace.push(
      pythNegCachedAtEntry
        ? "pyth=negcached-skip"
        : `pyth=${allCandles.length}c/${((Date.now() - pythStart) / 1000).toFixed(1)}s`,
    );
  }

  if (allCandles.length > 0) {
    const deduped = deduplicateCandles(allCandles);
    emitTrace(deduped.length);
    onProgress?.(`Fetched ${deduped.length} candles for ${symbol} ${timeframe}`);

    saveCandlesToDb(symbol, timeframe, deduped).catch((err) =>
      console.log(`[CandleCache] Background save error: ${err.message}`)
    );

    return deduped;
  }

  emitTrace(0);
  onProgress?.(`No candle data available for ${symbol} ${timeframe} from OKX, Gate.io, or Pyth`);
  return allCandles;
}

function deduplicateCandles(candles: OHLCV[]): OHLCV[] {
  const seen = new Set<number>();
  const result: OHLCV[] = [];
  for (const c of candles) {
    if (!seen.has(c.time)) {
      seen.add(c.time);
      result.push(c);
    }
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

function getTimeframeSeconds(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "45m": 2700,
    "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800,
  };
  return map[tf] || 900;
}
