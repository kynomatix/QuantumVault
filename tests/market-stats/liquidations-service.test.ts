import { describe, expect, it, vi } from 'vitest';
import { getLiquidationStats, LiquidationStatsCache } from '../../server/market-stats/liquidations-service';
import { loadOkxLiquidationInputs } from '../../server/market-stats/liquidations-okx';
import { LIQUIDATION_DAY, HOUR, type LiquidationInputs } from '../../server/market-stats/liquidations-model';
import { END, fullInputs } from './liquidations-fixtures';

function setup() {
  let now = END + HOUR;
  const loadInputs = vi.fn(async (at: number) => fullInputs(Math.floor(at / LIQUIDATION_DAY) * LIQUIDATION_DAY));
  return { deps: { cache: new LiquidationStatsCache(), now: () => now, loadInputs }, advance: (n: number) => { now += n; } };
}
describe('liquidation daily cache', () => {
  it('computes once per UTC day and coalesces concurrent requests', async () => {
    const { deps, advance } = setup();
    const cards = await Promise.all(Array.from({ length: 8 }, () => getLiquidationStats(deps, deps.now())));
    expect(deps.loadInputs).toHaveBeenCalledOnce(); expect(cards.every(c => c === cards[0])).toBe(true);
    advance(20 * HOUR); expect(await getLiquidationStats(deps, deps.now())).toBe(cards[0]);
    advance(3 * HOUR); const next = await getLiquidationStats(deps, deps.now());
    expect(deps.loadInputs).toHaveBeenCalledTimes(2); expect(next.asOf).toBe(END + LIQUIDATION_DAY);
    expect(cards[0].asOf).toBe(END); // hits never rejuvenate observations
  });
  it('coalesces failures and enforces the negative retry window', async () => {
    const { deps, advance } = setup(); deps.loadInputs.mockRejectedValue(new Error('offline'));
    const cards = await Promise.all([getLiquidationStats(deps, deps.now()), getLiquidationStats(deps, deps.now())]);
    expect(cards[0].status).toBe('unavailable'); expect(deps.loadInputs).toHaveBeenCalledOnce();
    advance(14 * 60_000); await getLiquidationStats(deps, deps.now()); expect(deps.loadInputs).toHaveBeenCalledOnce();
    advance(60_000); await getLiquidationStats(deps, deps.now()); expect(deps.loadInputs).toHaveBeenCalledTimes(2);
  });
  it('serves last good on refresh failure only until the original 26h ceiling', async () => {
    const { deps, advance } = setup(); const good = await getLiquidationStats(deps, deps.now());
    advance(23 * HOUR); deps.loadInputs.mockRejectedValue(new Error('offline'));
    expect(await getLiquidationStats(deps, deps.now())).toBe(good);
    advance(2 * HOUR); const stale = await getLiquidationStats(deps, deps.now());
    expect(stale.status).toBe('unavailable'); expect(good.expiresAt).toBe(END + 26 * HOUR);
  });
  it.each(['oi', 'candles'] as const)('returns unavailable and marks incomplete %s input', async kind => {
    const { deps } = setup(), inputs = fullInputs(); inputs[kind].splice(22, 2);
    deps.loadInputs.mockResolvedValue(inputs);
    const card = await getLiquidationStats(deps, deps.now());
    expect(card.status).toBe('unavailable'); expect(card.value).toBeNull(); expect(card.gaps).toHaveLength(2);
  });
  it('rejects a result that expires while the provider is loading', async () => {
    const { deps, advance } = setup(); deps.loadInputs.mockImplementation(async () => { advance(26 * HOUR); return fullInputs(); });
    expect((await getLiquidationStats(deps, deps.now())).status).toBe('unavailable');
  });
});
function adapterFetch(inputs: LiquidationInputs) {
  const urls: URL[] = [];
  const fetcher = vi.fn(async (raw: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(raw)); urls.push(url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const oi = url.pathname.includes('open-interest');
    const end = Number(url.searchParams.get(oi ? 'end' : 'after'));
    const rows = (oi ? inputs.oi.map(r => [String(r.time), '999999', String(r.btc), '888888888'])
      : inputs.candles.map(r => [String(r.time), String(r.open), String(r.high), String(r.low), String(r.close), '0', '0', '0', '1']))
      .filter(r => Number(r[0]) < end).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 100);
    return new Response(JSON.stringify({ code: '0', data: rows }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}
describe('narrow public OKX adapter', () => {
  it('paginates within limits with same-instrument UTC hours and uses BTC quantity', async () => {
    const inputs = fullInputs(), { fetcher, urls } = adapterFetch(inputs);
    const result = await loadOkxLiquidationInputs(END + HOUR, fetcher);
    expect(result.oi).toHaveLength(912); expect(result.candles).toHaveLength(912);
    expect(result.oi[0].btc).toBe(1911); // not contracts or USD
    expect(urls).toHaveLength(20);
    for (const url of urls) {
      expect(url.searchParams.get('instId')).toBe('BTC-USDT-SWAP'); expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get(url.pathname.includes('open-interest') ? 'period' : 'bar')).toBe('1H');
      expect(url.searchParams.has('begin')).toBe(false);
    }
  });
  it.each(['http', 'code', 'malformed', 'oversized', 'timeout', 'stuck'] as const)('rejects %s responses', async kind => {
    const fetcher = vi.fn(async () => {
      if (kind === 'timeout') throw new DOMException('deadline', 'TimeoutError');
      if (kind === 'http') return new Response('', { status: 429 });
      if (kind === 'oversized') return new Response(' '.repeat(256_001));
      if (kind === 'stuck') return new Response(JSON.stringify({ code: '0', data: [[String(END), '1', '1', '1', '1', '1', '1', '1', '1']] }));
      return new Response(JSON.stringify({ code: kind === 'code' ? '500' : '0', data: kind === 'malformed' ? [['']] : [] }));
    }) as unknown as typeof fetch;
    await expect(loadOkxLiquidationInputs(END + HOUR, fetcher)).rejects.toThrow();
  });
  it('omits unconfirmed candles so validation marks them as missing', async () => {
    const { fetcher } = adapterFetch(fullInputs());
    const wrapped = (async (...args: Parameters<typeof fetch>) => {
      const response = await fetcher(...args); const body = await response.json();
      if (String(args[0]).includes('history-candles')) body.data[0][8] = '0';
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const result = await loadOkxLiquidationInputs(END + HOUR, wrapped);
    expect(result.candles.length).toBe(902);
  });
});
