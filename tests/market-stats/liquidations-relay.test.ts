import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataRelayClient, parseRelayRead } from '../../server/market-stats/liquidations-relay';
import { HOUR } from '../../server/market-stats/liquidations-model';
import { END } from './liquidations-fixtures';
import { relayEnvelope } from './liquidations-relay-fixtures';

const start = END - 3 * HOUR, last = END - HOUR, now = END + HOUR;
function client(fetcher: typeof fetch, clock = () => now) {
  return createDataRelayClient({ url: 'https://relay.example', token: 'EXAMPLE', fetch: fetcher, now: clock });
}
const jsonFetch = (value: unknown) => vi.fn(async () => new Response(JSON.stringify(value))) as unknown as typeof fetch;
afterEach(() => vi.useRealTimers());
describe('bounded optional relay read', () => {
  it('uses one HTTPS GET, an inclusive last model hour, and only a header credential', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(relayEnvelope())));
    const result = await client(fetcher as typeof fetch).read(start, last);
    expect(result.series.map(v => v.venue)).toEqual(['binance', 'bybit', 'hyperliquid']);
    expect(result.series[0].rows[0]).toEqual({ time: start, btc: 100, fetchedAt: now });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = (fetcher.mock.calls as unknown as [URL, RequestInit][])[0];
    expect(url.searchParams.get('end')).toBe(new Date(last).toISOString());
    expect(url.searchParams.get('start')).toBe(new Date(start).toISOString());
    expect(String(url)).not.toContain('EXAMPLE'); expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ Authorization: 'Bearer EXAMPLE', Accept: 'application/json' });
    expect(JSON.stringify(result)).not.toContain('EXAMPLE');
  });
  it('isolates a malformed venue and accepts nullable USD OI', () => {
    const fixture = relayEnvelope(); fixture.venues.binance.rows[0].oiCoins = -1;
    expect(parseRelayRead(fixture, start, last, now).series.map(v => v.venue)).toEqual(['bybit', 'hyperliquid']);
  });
  it('accepts the documented direct venue keys as well as the venues envelope', () => {
    const { venues, ...metadata } = relayEnvelope();
    expect(parseRelayRead({ ...metadata, ...venues }, start, last, now)).toEqual(parseRelayRead(relayEnvelope(), start, last, now));
  });
  it.each(['symbol', 'interval', 'generatedAt', 'envelope'] as const)('rejects wrong %s', kind => {
    const fixture = relayEnvelope();
    if (kind === 'symbol') fixture.symbol = 'ETH';
    if (kind === 'interval') fixture.interval = '4h';
    if (kind === 'generatedAt') fixture.generatedAt = new Date(now + HOUR).toISOString();
    const result = parseRelayRead(kind === 'envelope' ? [] : fixture, start, last, now);
    expect(result.series).toEqual([]); expect(result.coverage.every(c => c.reason === 'malformed')).toBe(true);
  });
  it.each(['venue', 'symbol', 'interval', 'duplicate', 'unsorted', 'outside', 'non-hour', 'number', 'ohlc',
    'fetch-future', 'fetch-before-close', 'source', 'gap-conflict', 'gap-duplicate', 'gap-outside', 'row-bound', 'gap-bound'] as const)(
    'rejects %s only for the affected venue', kind => {
      const fixture = relayEnvelope(), venue = fixture.venues.binance;
      if (kind === 'venue') venue.venue = 'bybit';
      if (kind === 'symbol') venue.symbol = 'ETH';
      if (kind === 'interval') venue.interval = '4h';
      if (kind === 'duplicate') venue.rows.push(venue.rows[0]);
      if (kind === 'unsorted') venue.rows.reverse();
      if (kind === 'outside') venue.rows[0].hour = new Date(start - HOUR).toISOString();
      if (kind === 'non-hour') venue.rows[0].hour = new Date(start + 1).toISOString();
      if (kind === 'number') (venue.rows[0] as unknown as { oiCoins: unknown }).oiCoins = '100';
      if (kind === 'ohlc') venue.rows[0].low = 102;
      if (kind === 'fetch-future') venue.rows[0].fetchedAt = new Date(now + HOUR).toISOString();
      if (kind === 'fetch-before-close') venue.rows[0].fetchedAt = new Date(start).toISOString();
      if (kind === 'source') venue.rows[0].sourceKind = 'x'.repeat(81);
      if (kind === 'gap-conflict') venue.gaps.push({ hour: venue.rows[0].hour, reason: 'EXAMPLE' });
      if (kind === 'gap-duplicate') { const removed = venue.rows.splice(1, 1)[0]; venue.gaps.push(...Array(2).fill({ hour: removed.hour, reason: 'EXAMPLE' })); }
      if (kind === 'gap-outside') venue.gaps.push({ hour: new Date(start - HOUR).toISOString(), reason: 'EXAMPLE' });
      if (kind === 'row-bound') venue.rows = Array(913).fill(venue.rows[0]);
      if (kind === 'gap-bound') venue.gaps = Array(913).fill({ hour: new Date(start).toISOString(), reason: 'EXAMPLE' });
      const result = parseRelayRead(fixture, start, last, now);
      expect(result.series.map(v => v.venue)).toEqual(['bybit', 'hyperliquid']);
      expect(result.coverage[0].reason).toBe('malformed');
    });
  it('derives unlisted gaps and distinguishes terminal lag from an interior reset', () => {
    const fixture = relayEnvelope(END - 6 * HOUR, last);
    fixture.venues.binance.rows.splice(2, 2);
    fixture.venues.bybit.rows.splice(-3);
    const result = parseRelayRead(fixture, END - 6 * HOUR, last, now);
    expect(result.coverage[0].gaps).toEqual([{ start: END - 4 * HOUR, end: END - 3 * HOUR }]);
    expect(result.coverage[0].gapHours).toBe(2);
    expect(result.coverage[1]).toMatchObject({ status: 'included', terminalLagHours: 3, lastObservation: END - 4 * HOUR });
    fixture.venues.bybit.rows.splice(-1);
    expect(parseRelayRead(fixture, END - 6 * HOUR, last, now).coverage[1].reason).toBe('stale');
  });
  it('omits empty and baseline-only histories', () => {
    const fixture = relayEnvelope(); fixture.venues.binance.rows = []; fixture.venues.bybit.rows.splice(0, 2);
    const result = parseRelayRead(fixture, start, last, now);
    expect(result.coverage.map(c => c.reason)).toEqual(['empty', 'baseline-only', undefined]);
  });
  it.each([401, 429, 500])('classifies HTTP %s without upstream text', async status => {
    const result = await client(vi.fn(async () => new Response('EXAMPLE', { status })) as typeof fetch).read(start, last);
    expect(result.coverage.every(c => c.reason === 'http')).toBe(true); expect(JSON.stringify(result)).not.toContain('EXAMPLE');
  });
  it.each(['http://relay.example', 'https://EXAMPLE@relay.example', 'https://relay.example/path', 'https://relay.example/?key=EXAMPLE', 'invalid', undefined])(
    'disables unsafe or absent origin %s', async url => {
      const fetcher = vi.fn(); const result = await createDataRelayClient({ url, token: 'EXAMPLE', fetch: fetcher }).read(start, last);
      expect(fetcher).not.toHaveBeenCalled(); expect(result.coverage[0].reason).toBe('disabled');
    });
  it('does not send a request without credentials or for an invalid window', async () => {
    const fetcher = vi.fn(); const relay = createDataRelayClient({ url: 'https://relay.example', fetch: fetcher });
    expect((await relay.read(start, last)).coverage[0].reason).toBe('disabled');
    expect((await relay.read(start, start + 912 * HOUR)).coverage[0].reason).toBe('malformed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('caps streamed bytes before parsing, regardless of content-length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
    const result = await client(vi.fn(async () => new Response(stream, { headers: { 'content-length': '1' } })) as typeof fetch).read(start, last);
    expect(result.coverage[0].reason).toBe('malformed'); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['headers', 'body'] as const)('enforces the 4s total budget while waiting for %s', async phase => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const fetcher = vi.fn(() => phase === 'headers' ? new Promise<Response>(() => {})
      : Promise.resolve(new Response(new ReadableStream({ cancel }))));
    const pending = client(fetcher as typeof fetch).read(start, last);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await pending).coverage[0].reason).toBe('deadline');
    if (phase === 'body') expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects redirected/exceptional and malformed JSON responses without leaking messages', async () => {
    const fetcher = vi.fn(async () => { throw new Error('EXAMPLE'); });
    expect(JSON.stringify(await client(fetcher as typeof fetch).read(start, last))).not.toContain('EXAMPLE');
    expect((await client(vi.fn(async () => new Response('{EXAMPLE')) as typeof fetch).read(start, last)).coverage[0].reason).toBe('malformed');
    expect((await client(jsonFetch(relayEnvelope())).read(start, last)).series).toHaveLength(3);
  });
});
describe('collection contract', () => {
  it.each([{ partial: true, ignored: 'EXAMPLE' }, { partial: false }, {}, ['EXAMPLE'], null].map(body => ({ body })))('accepts 2xx JSON without requiring extra fields', async ({ body }) => {
    const result = await client(jsonFetch(body)).collect();
    expect(result.status).toBe('done'); expect(JSON.stringify(result)).not.toContain('EXAMPLE');
    expect(result.partial).toBe(body && !Array.isArray(body) && 'partial' in body ? body.partial : undefined);
  });
  it.each([404, 405])('classifies HTTP %s as not-ready', async status => {
    expect(await client(vi.fn(async () => new Response('EXAMPLE', { status })) as typeof fetch).collect()).toMatchObject({ status: 'not-ready', httpStatus: status });
  });
  it('bounds a stuck collection to 75 seconds and attempts only one POST', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = client(fetcher as typeof fetch).collect(); await vi.advanceTimersByTimeAsync(75_000);
    expect((await pending).status).toBe('deadline'); expect(fetcher).toHaveBeenCalledOnce();
  });
});
