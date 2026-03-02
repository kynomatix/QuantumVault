import type { OHLCV } from "./engine";
import { getCachedCandles, saveCandlesToDb } from "./candle-store";

const OKX_BATCH_SIZE = 300;

function symbolToOkxInstId(symbol: string): string {
  const base = symbol.split("/")[0];
  return `${base}-USDT-SWAP`;
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
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OKX API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.code !== "0") {
    throw new Error(`OKX API error: ${json.msg || JSON.stringify(json)}`);
  }
  return json.data || [];
}

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

  const instId = symbolToOkxInstId(symbol);
  const bar = mapTimeframeToOkx(timeframe);
  onProgress?.(`Fetching ${symbol} ${timeframe} from OKX...`);
  console.log(`Fetching OHLCV for ${instId} ${bar} from ${startDate} to ${endDate} via OKX`);

  const allCandles: OHLCV[] = [];
  let currentEndMs = endMs;
  let page = 0;
  let emptyPages = 0;

  while (currentEndMs > startMs) {
    try {
      const raw = await fetchOkxCandles(instId, bar, currentEndMs);

      if (!raw || raw.length === 0) {
        emptyPages++;
        if (emptyPages > 3) break;
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

      if (page % 3 === 0) {
        onProgress?.(`Fetched ${allCandles.length} candles for ${symbol} ${timeframe}...`);
      }

      await new Promise(resolve => setTimeout(resolve, 150));
    } catch (err: any) {
      console.log(`Error fetching ${symbol} from OKX: ${err.message}`);
      if (allCandles.length > 0) break;
      throw err;
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

  onProgress?.(`No candle data available for ${symbol} ${timeframe} in the requested date range`);
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
