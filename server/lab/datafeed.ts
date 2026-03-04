import type { OHLCV } from "./engine";
import { getCachedCandles, saveCandlesToDb } from "./candle-store";

const OKX_BATCH_SIZE = 300;
const GATE_BATCH_SIZE = 2000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const okxFailedInstruments = new Set<string>();

function symbolToOkxInstId(symbol: string): string {
  const base = symbol.split("/")[0];
  return `${base}-USDT-SWAP`;
}

function symbolToGateContract(symbol: string): string {
  const base = symbol.split("/")[0];
  return `${base}_USDT`;
}

function mapTimeframeToGate(tf: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "8h": "8h",
    "12h": "12h", "1d": "1d", "1w": "7d",
  };
  return map[tf] || tf;
}

async function fetchGateCandles(
  contract: string,
  interval: string,
  fromSec: number,
  toSec: number,
): Promise<any[]> {
  const params = new URLSearchParams({
    contract,
    interval,
    from: String(fromSec),
    to: String(toSec),
    limit: String(GATE_BATCH_SIZE),
  });

  const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?${params}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * (attempt + 1) * 2;
        console.log(`[Gate] Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, wait));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gate.io API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      if (!Array.isArray(json)) {
        throw new Error(`Gate.io unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
      }
      return json;
    } catch (err: any) {
      if (attempt < MAX_RETRIES - 1) {
        const wait = RETRY_DELAY_MS * (attempt + 1);
        console.log(`[Gate] Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${wait}ms`);
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
  const contract = symbolToGateContract(symbol);
  const interval = mapTimeframeToGate(timeframe);
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);

  onProgress?.(`Fetching ${symbol} ${timeframe} from Gate.io (fallback)...`);
  console.log(`Fetching OHLCV for ${contract} ${interval} from Gate.io (OKX fallback)`);

  const allCandles: OHLCV[] = [];
  let currentFrom = startSec;
  let page = 0;
  let consecutiveErrors = 0;

  while (currentFrom < endSec) {
    try {
      const raw = await fetchGateCandles(contract, interval, currentFrom, endSec);
      consecutiveErrors = 0;

      if (!raw || raw.length === 0) break;

      for (const candle of raw) {
        const ts = candle.t * 1000;
        if (ts < startMs || ts > endMs) continue;
        allCandles.push({
          time: ts,
          open: parseFloat(candle.o),
          high: parseFloat(candle.h),
          low: parseFloat(candle.l),
          close: parseFloat(candle.c),
          volume: parseFloat(candle.sum || candle.v || "0"),
        });
      }

      const lastTs = raw[raw.length - 1].t;
      if (lastTs <= currentFrom) break;
      currentFrom = lastTs + 1;
      page++;

      if (page % 3 === 0) {
        onProgress?.(`Fetched ${allCandles.length} candles for ${symbol} ${timeframe} from Gate.io...`);
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err: any) {
      consecutiveErrors++;
      console.log(`[Gate] Page fetch error after ${allCandles.length} candles (error ${consecutiveErrors}/5): ${err.message}`);
      if (consecutiveErrors >= 5) {
        console.log(`[Gate] Too many consecutive errors, stopping fetch with ${allCandles.length} candles`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * consecutiveErrors));
    }
  }

  console.log(`[Gate] Fetch complete: ${allCandles.length} candles over ${page} pages for ${contract} ${interval}`);
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

function aggregateCandles(candles: OHLCV[], factor: number): OHLCV[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
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
    const aggregated = aggregateCandles(sourceCandles, synthetic.factor);
    console.log(`[Synthetic] Built ${aggregated.length} ${timeframe} candles from ${sourceCandles.length} ${synthetic.source} candles`);
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

  if (!okxFailedInstruments.has(instId)) {
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
      okxFailedInstruments.add(instId);
      console.log(`[OKX] ${instId} not available — will use Gate.io fallback for future requests`);
    }
  } else {
    console.log(`[OKX] Skipping ${instId} (previously failed) — using Gate.io directly`);
  }

  if (allCandles.length === 0) {
    try {
      allCandles = await fetchAllGateCandles(symbol, timeframe, startMs, endMs, onProgress);
    } catch (err: any) {
      console.log(`[Gate] Fallback also failed for ${symbol} ${timeframe}: ${err.message}`);
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

  onProgress?.(`No candle data available for ${symbol} ${timeframe} from OKX or Gate.io`);
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
