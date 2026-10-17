import { HOUR, MODEL_DAYS, LIQUIDATION_DAY, LiquidationInputError, type LiquidationInputs } from './liquidations-model';

type Fetch = typeof fetch;
const BASE = 'https://www.okx.com';
const MAX_BODY = 256_000;

async function page(url: URL, fetcher: Fetch, signal: AbortSignal): Promise<string[][]> {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new LiquidationInputError(`OKX hourly history returned HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new LiquidationInputError('OKX hourly history has no response body.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new LiquidationInputError('OKX hourly history exceeded the response budget.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const json = JSON.parse(new TextDecoder().decode(bytes));
  if (json.code !== '0' || !Array.isArray(json.data) || json.data.length > 100
    || !json.data.every((row: unknown) => Array.isArray(row) && row.every(v => typeof v === 'string' && v.trim() !== '')))
    throw new LiquidationInputError('OKX hourly history returned an invalid payload.');
  return json.data;
}

/** Display-only adapter; never changes the trading datafeed mapper. */
export async function loadOkxLiquidationInputs(now: number, fetcher: Fetch = fetch): Promise<LiquidationInputs> {
  const end = Math.floor(now / LIQUIDATION_DAY) * LIQUIDATION_DAY, start = end - MODEL_DAYS * LIQUIDATION_DAY;
  const deadline = AbortSignal.timeout(22_000);
  async function history(kind: 'oi' | 'candles') {
    let cursor = end;
    const all: string[][] = [];
    // 912 hours / 100 per page: at most 10 requests per endpoint per refresh,
    // within OI's documented 10 requests / 2s / IP+instrument limit.
    for (let n = 0; n < 10; n++) {
      const url = new URL(kind === 'oi' ? '/api/v5/rubik/stat/contracts/open-interest-history' : '/api/v5/market/history-candles', BASE);
      url.searchParams.set('instId', 'BTC-USDT-SWAP'); url.searchParams.set('limit', '100');
      url.searchParams.set(kind === 'oi' ? 'period' : 'bar', '1H');
      url.searchParams.set(kind === 'oi' ? 'end' : 'after', String(cursor));
      const rows = await page(url, fetcher, AbortSignal.any([deadline, AbortSignal.timeout(6_000)]));
      if (!rows.length) break;
      if (rows.some(r => r.length < (kind === 'oi' ? 4 : 9) || !Number.isSafeInteger(Number(r[0])) || Number(r[0]) % HOUR))
        throw new LiquidationInputError('OKX hourly history has malformed rows.');
      const oldest = Math.min(...rows.map(r => Number(r[0])));
      if (oldest >= cursor) throw new LiquidationInputError('OKX hourly pagination did not advance.');
      all.push(...rows.filter(r => Number(r[0]) >= start && Number(r[0]) < end));
      if (oldest <= start) break;
      cursor = oldest;
    }
    return all;
  }
  const [oi, candles] = await Promise.all([history('oi'), history('candles')]);
  return { fetchedAt: Date.now(), oi: oi.map(r => ({ time: Number(r[0]), btc: Number(r[2]) })),
    candles: candles.filter(r => r[8] === '1').map(r => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) })) };
}
