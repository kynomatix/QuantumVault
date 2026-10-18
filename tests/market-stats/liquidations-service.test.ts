import { describe, expect, it, vi } from 'vitest';
import { getLiquidationStats, LiquidationStatsCache } from '../../server/market-stats/liquidations-service';
import { loadOkxLiquidationInputs } from '../../server/market-stats/liquidations-okx';
import { LIQUIDATION_DAY, HOUR, type LiquidationInputs } from '../../server/market-stats/liquidations-model';
import { END, fullInputs } from './liquidations-fixtures';
import { createDataRelayClient, omittedRelay, parseRelayRead } from '../../server/market-stats/liquidations-relay';
import { relayEnvelope } from './liquidations-relay-fixtures';

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

describe('optional multi-venue daily enrichment', () => {
  function relay(end = END) {
    const fixture = relayEnvelope(end - 38 * LIQUIDATION_DAY, end - HOUR);
    fixture.generatedAt = new Date(end + HOUR).toISOString();
    for (const venue of Object.values(fixture.venues)) for (const row of venue.rows) row.fetchedAt = fixture.generatedAt;
    return parseRelayRead(fixture, end - 38 * LIQUIDATION_DAY, end - HOUR, end + HOUR);
  }
  it('uses all four sources and the unchanged snapshot/expiry with complete coverage', async () => {
    const { deps } = setup(), loadRelay = vi.fn(async () => relay());
    const configured = { ...deps, loadRelay };
    const cards = await Promise.all(Array.from({ length: 8 }, () => getLiquidationStats(configured, deps.now())));
    expect(loadRelay).toHaveBeenCalledOnce(); expect(deps.loadInputs).toHaveBeenCalledOnce();
    expect(cards.every(c => c === cards[0])).toBe(true);
    expect(cards[0]).toMatchObject({ status: 'available', asOf: END, expiresAt: END + 26 * HOUR,
      source: 'OKX + Binance + Bybit + Hyperliquid', coverage: { venuesUsed: ['okx', 'binance', 'bybit', 'hyperliquid'] } });
    expect(cards[0].value?.methodologyVersion).toBe('oi-leverage-v3');
  });
  it('keeps the exact OKX-only value and metadata when all optional data is unavailable', async () => {
    const a = setup(), b = setup();
    const original = await getLiquidationStats(a.deps, a.deps.now());
    const fallback = await getLiquidationStats({ ...b.deps, loadRelay: async () => omittedRelay('deadline') }, b.deps.now());
    expect(fallback.value).toEqual(original.value);
    for (const key of ['source', 'basis', 'asOf', 'fetchedAt', 'expiresAt', 'gaps'] as const) expect(fallback[key]).toEqual(original[key]);
    expect(fallback.coverage?.venuesUsed).toEqual(['okx']);
  });
  it('includes a valid subset, resets interior gaps, and accepts three hours of terminal lag', async () => {
    const { deps } = setup(), fixture = relayEnvelope(END - 38 * LIQUIDATION_DAY, END - HOUR);
    fixture.venues.binance.rows.splice(100, 2); fixture.venues.binance.rows.splice(-3);
    fixture.venues.bybit.rows.splice(-4); fixture.venues.hyperliquid.rows.splice(0, 911);
    const loadRelay = async () => parseRelayRead(fixture, END - 38 * LIQUIDATION_DAY, END - HOUR, deps.now());
    const card = await getLiquidationStats({ ...deps, loadRelay }, deps.now());
    expect(card.status).toBe('available'); expect(card.coverage?.venuesUsed).toEqual(['okx', 'binance']);
    expect(card.coverage?.venues[0]).toMatchObject({ gapHours: 2, terminalLagHours: 3, lastObservation: END - 4 * HOUR });
    expect(card.coverage?.venues[1].reason).toBe('stale'); expect(card.coverage?.venues[2].reason).toBe('baseline-only');
  });
  it('recovers a degraded day at most hourly in the same single flight without reloading OKX or rejuvenating times', async () => {
    const { deps, advance } = setup(), loadRelay = vi.fn(async () => omittedRelay('http'));
    const configured = { ...deps, loadRelay };
    const original = await getLiquidationStats(configured, deps.now());
    advance(HOUR - 1); expect(await getLiquidationStats(configured, deps.now())).toBe(original);
    expect(loadRelay).toHaveBeenCalledOnce();
    advance(1); loadRelay.mockResolvedValue(relay());
    const recovered = await Promise.all(Array.from({ length: 8 }, () => getLiquidationStats(configured, deps.now())));
    expect(loadRelay).toHaveBeenCalledTimes(2); expect(deps.loadInputs).toHaveBeenCalledOnce();
    expect(recovered.every(c => c === recovered[0])).toBe(true);
    expect(recovered[0].value?.methodologyVersion).toBe('oi-leverage-v3');
    expect(recovered[0].asOf).toBe(original.asOf); expect(recovered[0].fetchedAt).toBe(original.fetchedAt);
    expect(recovered[0].expiresAt).toBe(original.expiresAt);
    advance(10 * HOUR); await getLiquidationStats(configured, deps.now()); expect(loadRelay).toHaveBeenCalledTimes(2);
  });
  it('throttles repeated failed enrichment and does not retain unbounded history', async () => {
    const { deps, advance } = setup(), loadRelay = vi.fn(async () => omittedRelay('deadline'));
    const configured = { ...deps, loadRelay };
    await getLiquidationStats(configured, deps.now()); advance(HOUR);
    await getLiquidationStats(configured, deps.now()); advance(HOUR - 1);
    await getLiquidationStats(configured, deps.now());
    expect(loadRelay).toHaveBeenCalledTimes(2); expect(deps.loadInputs).toHaveBeenCalledOnce();
    expect(deps.cache.recovery?.hours).toHaveLength(912);
  });
  it('starts relay work alongside OKX and contains optional exceptions', async () => {
    const { deps } = setup(), started: string[] = []; let finish!: (input: LiquidationInputs) => void;
    deps.loadInputs.mockImplementation(() => { started.push('okx'); return new Promise(resolve => { finish = resolve; }); });
    const loadRelay = vi.fn(async () => { started.push('relay'); throw new Error('EXAMPLE'); });
    const pending = getLiquidationStats({ ...deps, loadRelay }, deps.now());
    expect(started).toEqual(['relay', 'okx']); finish(fullInputs());
    const card = await pending; expect(card.status).toBe('available'); expect(JSON.stringify(card)).not.toContain('EXAMPLE');
  });
  it('a stuck relay cannot add a serial budget after OKX', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = setup();
      const fetcher = vi.fn(() => new Promise<Response>(() => {}));
      const client = createDataRelayClient({ url: 'https://relay.example', token: 'EXAMPLE', fetch: fetcher as typeof fetch, now: deps.now });
      const pending = getLiquidationStats({ ...deps, loadRelay: client.read }, deps.now());
      expect(fetcher).toHaveBeenCalledOnce(); expect(deps.loadInputs).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_000);
      const card = await pending; expect(card.status).toBe('available'); expect(card.coverage?.venues[0].reason).toBe('deadline');
    } finally { vi.useRealTimers(); }
  });
  it('builds a new-day OKX result rather than relabelling yesterday’s enriched model', async () => {
    const { deps, advance } = setup(), loadRelay = vi.fn(async () => relay());
    const configured = { ...deps, loadRelay }, original = await getLiquidationStats(configured, deps.now());
    advance(24 * HOUR); loadRelay.mockResolvedValue(omittedRelay('deadline'));
    const next = await getLiquidationStats(configured, deps.now());
    expect(next.asOf).toBe(END + LIQUIDATION_DAY); expect(next.value?.methodologyVersion).toBe('oi-leverage-v2');
    expect(next.source).toBe('OKX BTC-USDT-SWAP'); expect(original.source).toBe('OKX + Binance + Bybit + Hyperliquid');
    expect(deps.cache.recovery?.day).toBe(END + LIQUIDATION_DAY);
  });
  it('retains original last-good sources on OKX failure only until the original ceiling', async () => {
    const { deps, advance } = setup(), configured = { ...deps, loadRelay: async () => relay() };
    const original = await getLiquidationStats(configured, deps.now());
    advance(23 * HOUR); deps.loadInputs.mockRejectedValue(new Error('offline'));
    expect(await getLiquidationStats(configured, deps.now())).toBe(original);
    advance(2 * HOUR); expect((await getLiquidationStats(configured, deps.now())).status).toBe('unavailable');
  });
});
