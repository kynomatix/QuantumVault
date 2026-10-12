import { pacificaQuota } from '../protocol/pacifica/pacifica-quota';
import { BTC_TREND_WEEK_MS as WEEK, BTC_WEEKLY_SOURCES, validBtcStoredWeek,
  type BtcStoredWeek, type BtcWeeklySource } from '../../shared/grid-direction';

const DAY = WEEK / 7;
export const BTC_WEEKLY_SOURCE_ORDER = Object.keys(BTC_WEEKLY_SOURCES) as BtcWeeklySource[];
type Bar = { time: number; close: string; finalized: boolean };

/** A daily-derived close requires all seven finalized UTC days, without gaps or duplicates. */
export function aggregateBtcDailyWeeks(bars: Bar[], source: BtcWeeklySource, start: number, end: number, fetchedAt: number): BtcStoredWeek[] {
  const days = new Map<number, Bar>();
  for (const bar of bars) {
    if (bar.time < start || bar.time >= end) continue;
    if (!Number.isSafeInteger(bar.time) || bar.time % DAY !== 0 || days.has(bar.time)) return [];
    days.set(bar.time, bar);
  }
  const weeks: BtcStoredWeek[] = [];
  for (let time = start; time < end; time += WEEK) {
    const seven = Array.from({ length: 7 }, (_, i) => days.get(time + i * DAY));
    if (!seven.every(bar => bar?.finalized && /^\d{1,12}(\.\d{1,18})?$/.test(bar.close) && Number(bar.close) > 0)) continue;
    weeks.push({ market: 'BTC', weekStart: time, close: seven[6]!.close, source,
      basis: BTC_WEEKLY_SOURCES[source].basis, aggregation: 'daily', finalized: true, fetchedAt });
  }
  return weeks;
}

async function json(url: string, signal: AbortSignal, timeout: number, body?: unknown): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Weekly source unavailable');
  return response.json();
}

/** Dedicated fetches bypass chart caches; provenance is attached before anything is stored. */
export async function readBtcWeeklySource(source: BtcWeeklySource, signal: AbortSignal, start: number, end: number): Promise<BtcStoredWeek[]> {
  signal.throwIfAborted();
  let bars: Bar[] = [], daily = false;
  if (source === 'okx-index' || source === 'okx-perp') {
    const index = source === 'okx-index';
    const query = new URLSearchParams({ instId: index ? 'BTC-USDT' : 'BTC-USDT-SWAP', bar: '1Wutc', limit: '60' });
    const payload = await json(`https://www.okx.com/api/v5/market/${index ? 'index-candles' : 'history-candles'}?${query}`, signal, 1500);
    if (payload?.code !== '0' || !Array.isArray(payload.data) || payload.data.length > 60) return [];
    bars = payload.data.map((r: any[]) => ({ time: Number(r[0]), close: r[4], finalized: r[index ? 5 : 8] === '1' }));
  } else if (source === 'gate-spot') {
    const query = new URLSearchParams({ currency_pair: 'BTC_USDT', interval: '1w', from: String(start / 1000), to: String(end / 1000 - 1) });
    const payload = await json(`https://api.gateio.ws/api/v4/spot/candlesticks?${query}`, signal, 5000);
    if (!Array.isArray(payload) || payload.length > 60) return [];
    bars = payload.map((r: any[]) => ({ time: Number(r[0]) * 1000, close: r[2], finalized: r[7] === 'true' || r[7] === true }));
  } else if (source === 'kraken-spot') {
    daily = true;
    const payload = await json(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since=${start / 1000}`, signal, 2500);
    if (!Array.isArray(payload?.error) || payload.error.length || !payload.result) return [];
    const rows = Object.entries(payload.result).find(([key]) => key !== 'last')?.[1];
    if (!Array.isArray(rows) || rows.length > 720) return [];
    bars = rows.map((r: any[], i: number) => ({ time: Number(r[0]) * 1000, close: r[4],
      finalized: i !== rows.length - 1 && Number(r[0]) * 1000 + DAY <= Date.now() }));
  } else if (source === 'coinbase-spot') {
    daily = true;
    // Coinbase caps each response at 300 days and may include a candle before start.
    for (let cursor = start; cursor < end; cursor += 299 * DAY) {
      const until = Math.min(end, cursor + 299 * DAY);
      const query = new URLSearchParams({ granularity: '86400', start: new Date(cursor).toISOString(), end: new Date(until).toISOString() });
      const rows = await json(`https://api.exchange.coinbase.com/products/BTC-USD/candles?${query}`, signal, 2000);
      if (!Array.isArray(rows) || rows.length > 300) return [];
      bars.push(...rows.filter((r: any[]) => Number(r[0]) * 1000 >= cursor && Number(r[0]) * 1000 < until)
        .map((r: any[]) => ({ time: Number(r[0]) * 1000, close: String(r[4]), finalized: Number(r[0]) * 1000 + DAY <= Date.now() })));
    }
  } else if (source === 'hyperliquid-perp') {
    // Live native 1w opens on Thursday. Use seven UTC days instead of relabelling it.
    daily = true;
    const rows = await json('https://api.hyperliquid.xyz/info', signal, 2000,
      { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1d', startTime: start, endTime: end } });
    if (!Array.isArray(rows) || rows.length > 400) return [];
    if (rows.some(r => r.s !== 'BTC' || r.i !== '1d' || r.T !== r.t + DAY - 1)) return [];
    bars = rows.map(r => ({ time: r.t, close: r.c, finalized: r.t + DAY <= Date.now() }));
  } else {
    if (!pacificaQuota.tryClaimImmediate('/kline', 'background')) return [];
    const path = source === 'pacifica-mark' ? 'kline/mark' : 'kline';
    const query = new URLSearchParams({ symbol: 'BTC', interval: '1w', start_time: String(start), end_time: String(end), limit: '60' });
    const payload = await json(`https://api.pacifica.fi/api/v1/${path}?${query}`, signal, 2000);
    if (payload?.success !== true || !Array.isArray(payload.data) || payload.data.length > 60) return [];
    if (payload.data.some((r: any) => r.s !== 'BTC' || r.i !== '1w' || ![r.t + WEEK, r.t + WEEK - 1].includes(r.T))) return [];
    bars = payload.data.map((r: any) => ({ time: r.t, close: r.c, finalized: r.t + WEEK <= Date.now() }));
  }
  signal.throwIfAborted();
  const fetchedAt = Date.now();
  const weeks = daily ? aggregateBtcDailyWeeks(bars, source, start, end, fetchedAt)
    : bars.filter(bar => bar.time >= start && bar.time < end && bar.finalized).map(bar => ({
      market: 'BTC' as const, weekStart: bar.time, close: bar.close, source, basis: BTC_WEEKLY_SOURCES[source].basis,
      aggregation: 'native' as const, finalized: true as const, fetchedAt,
    }));
  weeks.sort((a, b) => a.weekStart - b.weekStart);
  if (weeks.some((week, i) => !validBtcStoredWeek(week, fetchedAt) || (i > 0 && week.weekStart !== weeks[i - 1].weekStart + WEEK))) return [];
  return weeks;
}

export async function plannerBtcWeeklyCandles(signal: AbortSignal, start: number, end: number): Promise<BtcStoredWeek[]> {
  for (const source of BTC_WEEKLY_SOURCE_ORDER) {
    try {
      const weeks = await readBtcWeeklySource(source, signal, start, end);
      signal.throwIfAborted();
      if (weeks.length >= 50 && weeks.length <= 55 && weeks.at(-1)!.weekStart + WEEK === end) return weeks;
    } catch { signal.throwIfAborted(); }
  }
  return [];
}
