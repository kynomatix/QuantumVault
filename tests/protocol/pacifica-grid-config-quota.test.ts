import { afterEach, describe, expect, it, vi } from 'vitest';
import { PacificaTransportAuthority, validPacificaConfigKey } from '../../server/protocol/pacifica/pacifica-transport.js';
import * as transportModule from '../../server/protocol/pacifica/pacifica-transport.js';
import { ObservedPacificaQuota, parseRestQuota, parseWsQuota } from '../../server/protocol/pacifica/pacifica-observed-quota.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaWsManager } from '../../server/protocol/pacifica/pacifica-ws.js';
import { PacificaPricesWsManager } from '../../server/live-data-spine/pacifica-prices-ws.js';
const mocks = vi.hoisted(() => {
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string, public options?: unknown) { sockets.push(this); }
    send() {} close() {}
  }
  return { sockets, Socket };
});
vi.mock('ws', () => ({ WebSocket: mocks.Socket }));
const EXAMPLE_KEY = 'EXAMPLE1_1111111111111111';
const URL = 'https://api.pacifica.fi/api/v1/account';
const response = (body: unknown = {}, metadata = true, status = 200) => new Response(JSON.stringify(body), { status,
  headers: metadata ? { ratelimit: '"credits";r=3000;t=60', 'ratelimit-policy': '"credits";q=3000;w=60' } : {} });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); mocks.sockets.length = 0; });

describe('Config Key custody and target binding', () => {
  it.each([undefined, '', 'REDACTED', 'EXAMPLE1_0000000000000000', 'EXAMPLE1_11111111111111111', ` ${EXAMPLE_KEY}`])('denies invalid or absent credentials without echoes (%s)', key => {
    const t = new PacificaTransportAuthority(key);
    expect(t.status().liveEntryAllowed).toBe(false);
    expect(new Headers(t.restInit(URL, {}).headers).has('PF-API-KEY')).toBe(false);
    if (key) expect(JSON.stringify(t.status())).not.toContain(key);
  });
  it('uses only the documented header; does not claim a tier from a valid key', () => {
    const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    expect(validPacificaConfigKey(EXAMPLE_KEY)).toBe(true);
    const init = t.restInit(URL, { headers: { 'Content-Type': 'application/json' } });
    expect(new Headers(init.headers).get('PF-API-KEY')).toBe(EXAMPLE_KEY);
    expect(init.redirect).toBe('error');
    expect(t.status()).toMatchObject({ keyStatus: 'present', liveEntryAllowed: false, sharingProof: 'deployment_local_only', quota: { tier: null, quotaDeciCredits: null } });
    expect(JSON.stringify(t)).not.toContain(EXAMPLE_KEY);
  });
  it.each(['http://api.pacifica.fi/api/v1/account', 'https://api.pacifica.fi.evil.example/api/v1/account',
    'https://evil.example/api/v1/account', 'https://api.pacifica.fi/api/v2/account', 'https://api.pacifica.fi/api/v1/%2faccount',
    'https://EXAMPLE@api.pacifica.fi/api/v1/account', 'https://api.pacifica.fi:444/api/v1/account'])('refuses a foreign credential target %s', url => {
    const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    expect(() => t.restInit(url, {})).toThrow('target refused');
  });
  it.each(['ws://ws.pacifica.fi/ws', 'wss://ws.pacifica.fi/other', 'wss://evil.example/ws', 'wss://ws.pacifica.fi/ws?EXAMPLE=1'])('refuses a foreign WS target %s', url => {
    expect(() => new PacificaTransportAuthority(EXAMPLE_KEY).websocketOptions(url)).toThrow('target refused');
  });
  it('strips a caller-supplied key when the captured key is absent', () => {
    const t = new PacificaTransportAuthority(undefined);
    expect(new Headers(t.restInit(URL, { headers: { 'pf-api-key': 'REDACTED' } }).headers).has('PF-API-KEY')).toBe(false);
  });
  it('observes headers before body; redacts echo bodies and thrown transport errors', async () => {
    const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    const r = t.response(response({ message: EXAMPLE_KEY, nested: [EXAMPLE_KEY] }));
    expect(t.status().liveEntryAllowed).toBe(true);
    expect(JSON.stringify(await r.json())).not.toContain(EXAMPLE_KEY);
    expect(t.safeError(new Error(EXAMPLE_KEY)).message).not.toContain(EXAMPLE_KEY);
    const bad = t.response(new Response(EXAMPLE_KEY, { status: 200 }));
    await expect(bad.json()).rejects.toThrow('Pacifica transport failed');
    expect(t.status().liveEntryAllowed).toBe(false);
  });
  it.each([400, 401, 403, 429, 500])('rejects acceptance evidence on HTTP %s', code => {
    const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    t.response(response({}, true, code)); expect(t.status().liveEntryAllowed).toBe(false);
  });
  it('covers every adapter REST path through the common boundary', async () => {
    const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    const adapter = new PacificaAdapter(undefined, t);
    const fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init.headers).get('PF-API-KEY')).toBe(EXAMPLE_KEY);
      expect(init.redirect).toBe('error'); return response({ success: true, data: [] });
    }); vi.stubGlobal('fetch', fetch);
    await adapter.getGridOpenOrders('EXAMPLE_ACCOUNT');
    await (adapter as any).post('/orders/cancel', { account: 'EXAMPLE_ACCOUNT' });
    await (adapter as any).fetchBounded(URL, { method: 'GET' }, 500, 1000, 'EXAMPLE');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(t.status().quota.outstandingDeciCredits).toBe(245);
  });
  it('never restores quota from a response after the hard timeout', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = new PacificaTransportAuthority(EXAMPLE_KEY), adapter = new PacificaAdapter(undefined, t);
    let deliver!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { deliver = resolve; })));
    const result = expect((adapter as any).fetchBounded(URL, { method: 'GET' }, 10, 20, 'EXAMPLE')).rejects.toThrow('HARD-TIMEOUT');
    await vi.advanceTimersByTimeAsync(20); await result;
    deliver(response()); await vi.advanceTimersByTimeAsync(0);
    expect(t.status().liveEntryAllowed).toBe(false);
    expect(t.status().quota.outstandingDeciCredits).toBe(120);
  });
  it('private WS attaches the key on reconnect and ignores replaced-connection quota', () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', mocks.Socket);
    const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    const ws = new PacificaWsManager({ wsUrl: 'wss://ws.pacifica.fi/ws', account: 'EXAMPLE_ACCOUNT' }, {} as any, t);
    ws.connect(); const first = mocks.sockets[0];
    expect(first.options).toEqual({ headers: { 'PF-API-KEY': EXAMPLE_KEY }, followRedirects: false });
    (ws as any).doConnect(); const second = mocks.sockets[1];
    const data = JSON.stringify({ type: 'create_order', id: '00000000-0000-4000-8000-000000000001', code: 200, rl: { r: 3000, q: 3000, t: 32_000 } });
    first.onmessage({ data }); expect(t.status().liveEntryAllowed).toBe(false);
    second.onmessage({ data }); expect(t.status().liveEntryAllowed).toBe(true);
    expect(second.options).toEqual(first.options); ws.disconnect();
  });
  it('public prices WS attaches credentials on every new connection but never proves action quota', () => {
    vi.useFakeTimers(); const t = new PacificaTransportAuthority(EXAMPLE_KEY);
    vi.spyOn(transportModule, 'pacificaTransportAuthority').mockReturnValue(t);
    const ws = new PacificaPricesWsManager({ onTick: () => {} });
    ws.connect(); (ws as any).doConnect();
    expect(mocks.sockets).toHaveLength(2);
    for (const socket of mocks.sockets) expect(socket.options).toMatchObject({ headers: { 'PF-API-KEY': EXAMPLE_KEY }, followRedirects: false });
    expect(t.status().liveEntryAllowed).toBe(false); ws.disconnect();
  });
});
describe('observed quota and shared reservations', () => {
  it('parses deci-credits; WS milliseconds and REST seconds are separate', () => {
    expect(parseRestQuota('"credits";r=1200;t=32', '"credits";q=1250;w=60')).toEqual({ quota: 1250, remaining: 1200, resetSeconds: 32 });
    expect(parseWsQuota({ r: 1200, q: 1250, t: 32_999 })).toEqual({ quota: 1250, remaining: 1200, resetSeconds: 32 });
  });
  it.each([
    ['"credits";r=1201;t=32', '"credits";q=1200;w=60'], ['"credits";r=1;t=61', '"credits";q=1000;w=60'],
    ['"credits";r=0;t=1', '"credits";q=0;w=60'], ['"credits";r=1.5;t=1', '"credits";q=1000;w=60'],
    ['"credits";r=1;t=1', '"credits";q=1000;w=30'], ['"credits";r=9007199254740992;t=1', '"credits";q=9007199254740992;w=60'],
    [null, '"credits";q=1000;w=60'], ['"credits";r=1;t=1', null],
  ])('rejects malformed or unpaired metadata', (rate, policy) => { expect(parseRestQuota(rate, policy)).toBeNull(); });
  it('reserves before dispatch; prevents duplicate settlement and retains uncertain charges', () => {
    let now = 1000; const q = new ObservedPacificaQuota('EXAMPLE_DOMAIN', () => now);
    expect(q.reserve('EXAMPLE_UNKNOWN', 10)).toBe(false);
    q.observe({ quota: 1000, remaining: 1000, resetSeconds: 60 });
    expect(q.snapshot().entryDeciCredits).toBe(600);
    expect(q.reserve('EXAMPLE_A', 600)).toBe(true);
    expect(q.reserve('EXAMPLE_B', 1)).toBe(false);
    expect(q.reserve('EXAMPLE_A', 1)).toBe(false);
    expect(q.settle('EXAMPLE_A', 'uncertain')).toBe(true);
    expect(q.settle('EXAMPLE_A', 'not_sent')).toBe(false);
    expect(q.snapshot().outstandingDeciCredits).toBe(600);
    expect(q.reserve('EXAMPLE_EXIT', 120, 'risk-reduction')).toBe(true);
    expect(q.settle('EXAMPLE_EXIT', 'not_sent')).toBe(true);
    now += 60_001; expect(q.snapshot().availability).toBe('unknown');
    expect(q.snapshot().outstandingDeciCredits).toBe(0);
  });
  it('lower observations win immediately; reordered upgrades cannot restore admission', () => {
    const q = new ObservedPacificaQuota('EXAMPLE_DOMAIN', () => 1000);
    q.observe({ quota: 3000, remaining: 3000, resetSeconds: 60 });
    q.observe({ quota: 500, remaining: 400, resetSeconds: 50 });
    expect(q.snapshot().entryDeciCredits).toBe(100);
    q.observe({ quota: 30_000, remaining: 30_000, resetSeconds: 60 });
    expect(q.snapshot()).toMatchObject({ quotaDeciCredits: 500, remainingDeciCredits: 400, entryDeciCredits: 100 });
    q.observe(null); expect(q.snapshot().entryDeciCredits).toBe(0);
  });
  it('never cross-promotes domains or accepts subscription quota', () => {
    const a = new PacificaTransportAuthority(EXAMPLE_KEY, 'EXAMPLE_A');
    const b = new PacificaTransportAuthority(EXAMPLE_KEY, 'EXAMPLE_B');
    a.response(response()); expect(b.status().liveEntryAllowed).toBe(false);
    b.observeWsAction({ type: 'prices', id: 'EXAMPLE', rl: { r: 3000, q: 3000, t: 30_000 } }, true);
    expect(b.status().liveEntryAllowed).toBe(false);
    expect(parseWsQuota({ r: 1, q: 1000, t: 60_001 })).toBeNull();
  });
});
