import type { OHLCV } from "./engine";
import { getCachedCandles, saveCandlesToDb } from "./candle-store";

const OKX_BATCH_SIZE = 300;
const GATE_BATCH_SIZE = 900;
const PYTH_BATCH_SIZE = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

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

class GatePairNotFoundError extends Error {
  constructor(pair: string, detail: string) {
    super(`Gate.io pair not found: ${pair} — ${detail}`);
    this.name = "GatePairNotFoundError";
  }
}

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
  const base = symbol.split("/")[0];
  return `${base}-USDT-SWAP`;
}

function symbolToGateSpotPair(symbol: string): string {
  const base = stripMultiplierPrefix(symbol.split("/")[0]);
  return `${base}_USDT`;
}

function symbolToPythId(symbol: string): string {
  const base = stripMultiplierPrefix(symbol.split("/")[0]);
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
        if (res.status === 400 && (text.includes("INVALID_CURRENCY_PAIR") || text.includes("currency_pair"))) {
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

  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?${params}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
  const chunkSeconds = tfSeconds * PYTH_BATCH_SIZE;

  while (currentFrom < endSec) {
    const chunkEnd = Math.min(currentFrom + chunkSeconds, endSec);

    try {
      const data = await fetchPythCandles(pythSymbol, resolution, currentFrom, chunkEnd);
      consecutiveErrors = 0;

      if (!data || data.s === "error") {
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
        throw new Error(`OKX API error: ${json.msg || JSON.stringify(json)}`);
      }
      return json.data || [];
    } catch (err: any) {
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
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
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
  "8h": { source: "4h", factor: 2 },
  "8H": { source: "4h", factor: 2 },
};

export async function fetchOHLCV(
  symbol: string,
  timeframe: string,
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void
): Promise<OHLCV[]> {
  timeframe = timeframe.toLowerCase();
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();

  onProgress?.(`Checking cache for ${symbol} ${timeframe}...`);
  const cached = await getCachedCandles(symbol, timeframe, startMs, endMs);
  if (cached && cached.length >= 100) {
    console.log(`[CandleCache] Hit: ${cached.length} candles for ${symbol} ${timeframe}`);
    onProgress?.(`Loaded ${cached.length} cached candles for ${symbol} ${timeframe}`);
    return cached;
  }

  const synthetic = SYNTHETIC_TIMEFRAMES[timeframe];
  if (synthetic) {
    onProgress?.(`Synthesizing ${timeframe} from ${synthetic.source} candles...`);
    const sourceCandles = await fetchOHLCV(symbol, synthetic.source, startDate, endDate, onProgress);
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

  const instId = symbolToOkxInstId(symbol);
  let allCandles: OHLCV[] = [];

  if (!isNegCached(okxFailedInstruments, instId)) {
    const bar = mapTimeframeToOkx(timeframe);
    onProgress?.(`Fetching ${symbol} ${timeframe} from OKX...`);
    console.log(`Fetching OHLCV for ${instId} ${bar} from ${startDate} to ${endDate} via OKX`);

    let currentEndMs = endMs;
    let page = 0;
    let emptyPages = 0;
    let consecutiveErrors = 0;

    while (currentEndMs > startMs) {
      try {
        const raw = await fetchOkxCandles(instId, bar, currentEndMs);
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
      negCache(okxFailedInstruments, instId);
      console.log(`[OKX] ${instId} not available — will use Gate.io spot fallback for future requests`);
    }
  } else {
    console.log(`[OKX] Skipping ${instId} (recently failed) — trying Gate.io spot`);
  }

  if (allCandles.length === 0) {
    try {
      allCandles = await fetchAllGateCandles(symbol, timeframe, startMs, endMs, onProgress);
    } catch (err: any) {
      console.log(`[Gate Spot] Fallback failed for ${symbol} ${timeframe}: ${err.message}`);
    }
  }

  if (allCandles.length === 0) {
    try {
      allCandles = await fetchAllPythCandles(symbol, timeframe, startMs, endMs, onProgress);
    } catch (err: any) {
      console.log(`[Pyth] Fallback failed for ${symbol} ${timeframe}: ${err.message}`);
    }
  }

  if (allCandles.length > 0) {
    const deduped = deduplicateCandles(allCandles);
    onProgress?.(`Fetched ${deduped.length} candles for ${symbol} ${timeframe}`);

    saveCandlesToDb(symbol, timeframe, deduped).catch((err) =>
      console.log(`[CandleCache] Background save error: ${err.message}`)
    );

    return deduped;
  }

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
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800,
  };
  return map[tf] || 900;
}
