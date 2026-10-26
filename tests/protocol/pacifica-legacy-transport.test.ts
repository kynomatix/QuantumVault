import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaWsManager } from '../../server/protocol/pacifica/pacifica-ws.js';
import { PacificaPricesWsManager } from '../../server/live-data-spine/pacifica-prices-ws.js';
import { PacificaTransportAuthority } from '../../server/protocol/pacifica/pacifica-transport.js';
import * as transportModule from '../../server/protocol/pacifica/pacifica-transport.js';

const mocks = vi.hoisted(() => {
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string, public options?: unknown) { sockets.push(this); }
    send() {} close() {}
  }
  class GlobalSocket extends Socket {}
  return { sockets, Socket, GlobalSocket };
});
vi.mock('ws', () => ({ WebSocket: mocks.Socket }));
const EXAMPLE_KEY = 'EXAMPLE1_1111111111111111';
const endpoint = 'https://api.pacifica.fi/api/v1/account';
const source = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
// Baseline commitHash: cff20740b4973c5bf85b777e5e5db3630d596d28. Pin the complete live WS files and REST deadline implementation.
const baselineSha256 = {
  privateWsSha256: '98bcb0a087e332dac6cd141c23646d21e5485b621a10051063bb2244a4f2efde',
  priceWsSha256: '18785fe53909ef7d51cecf0746d8f311141fe1d8d0fb9d69429ce18d7ee74313',
  // U7c scopes MAIN lock, quota and lower-only headers before fetch; deadline/abort/error identity behavior remains covered below.
  fetchBoundedSha256: '103f56d688104b9a501a1324fbf954e1ac97c996b26231a966c34944edd3239d',
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); mocks.sockets.length = 0; });
function presentKey() {
  vi.stubEnv('PACIFICA_API_KEY', EXAMPLE_KEY);
  const transport = new PacificaTransportAuthority(EXAMPLE_KEY);
  const capture = vi.spyOn(transportModule, 'pacificaTransportAuthority').mockReturnValue(transport);
  const hooks = ['restInit', 'response', 'redact', 'safeError', 'websocketOptions', 'observeWsAction'] as const;
  for (const hook of hooks) vi.spyOn(transport, hook);
  vi.spyOn(transport.quota, 'reserve'); vi.spyOn(transport.quota, 'settle');
  return { transport, capture, assertUntouched: () => {
    expect(capture).not.toHaveBeenCalled();
    for (const hook of hooks) expect(transport[hook]).not.toHaveBeenCalled();
    expect(transport.quota.reserve).not.toHaveBeenCalled(); expect(transport.quota.settle).not.toHaveBeenCalled();
    expect(transport.status().quota.availability).toBe('unknown');
  } };
}

describe('legacy Pacifica remains at the baseline with Config Key present', () => {
  it('retains both live WS files and the reviewed REST boundary pin', () => {
    expect(sha256(source('server/protocol/pacifica/pacifica-ws.ts'))).toBe(baselineSha256.privateWsSha256);
    expect(sha256(source('server/live-data-spine/pacifica-prices-ws.ts'))).toBe(baselineSha256.priceWsSha256);
    const adapter = source('server/protocol/pacifica/pacifica-adapter.ts');
    const start = adapter.indexOf('  private async fetchBounded(');
    const end = adapter.indexOf('\n  /**\n   * Bound a body read', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    expect(sha256(adapter.slice(start, end))).toBe(baselineSha256.fetchBoundedSha256);
  });
  it.each(['wss://ws.pacifica.fi/ws', 'wss://legacy.example/ws'])('private WS retains the global constructor, one URL argument and raw parsing: %s', url => {
    vi.useFakeTimers(); const key = presentKey(); vi.stubGlobal('WebSocket', mocks.GlobalSocket);
    const ws = new PacificaWsManager({ wsUrl: url, account: 'EXAMPLE_ACCOUNT' }, {} as any);
    const handle = vi.spyOn(ws as any, 'handleMessage').mockImplementation(() => {});
    ws.connect(); (ws as any).doConnect();
    expect(mocks.sockets).toHaveLength(2);
    for (const socket of mocks.sockets) {
      expect(socket).toBeInstanceOf(mocks.GlobalSocket); expect(socket.url).toBe(url); expect(socket.options).toBeUndefined();
    }
    // Legacy also retains the old-connection parser; Grid's guard must not reach it.
    const raw = JSON.stringify({ type: 'create_order', echo: EXAMPLE_KEY, rl: { r: 3000, q: 3000, t: 30_000 } });
    mocks.sockets[0].onmessage({ data: raw }); mocks.sockets[1].onmessage({ data: raw });
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenLastCalledWith(JSON.parse(raw));
    ws.disconnect(); key.assertUntouched();
  });
  it.each(['wss://ws.pacifica.fi/ws', 'wss://legacy.example/ws'])('price spine retains Node WS maxPayload only and unredacted price parsing: %s', url => {
    vi.useFakeTimers(); const key = presentKey(); const mapSymbol = vi.fn(symbol => symbol);
    const onTick = vi.fn(); const ws = new PacificaPricesWsManager({ wsUrl: url, onTick, mapSymbol });
    ws.connect(); (ws as any).doConnect();
    expect(mocks.sockets).toHaveLength(2);
    for (const socket of mocks.sockets) expect(socket.options).toEqual({ maxPayload: 4 * 1024 * 1024 });
    mocks.sockets[1].onmessage({ data: JSON.stringify({ channel: 'prices', data: [{ symbol: EXAMPLE_KEY, mark: '100', oracle: '99' }] }) });
    expect(mapSymbol).toHaveBeenCalledWith(EXAMPLE_KEY);
    expect(onTick).toHaveBeenCalledWith(expect.objectContaining({ internalSymbol: EXAMPLE_KEY, mark: 100 }));
    ws.disconnect(); key.assertUntouched();
  });
  it.each(['GET', 'POST'])('legacy %s retains headers, implicit redirects, raw response and no quota hooks', async method => {
    const key = presentKey(); const adapter = new PacificaAdapter();
    const raw = new Response(JSON.stringify({ echo: EXAMPLE_KEY }), { headers: { ratelimit: '"credits";r=3000;t=60', 'ratelimit-policy': '"credits";q=3000;w=60' } });
    const fetch = vi.fn().mockResolvedValue(raw); vi.stubGlobal('fetch', fetch);
    const init = { method, headers: { 'Content-Type': 'application/json', 'X-EXAMPLE': 'EXAMPLE' }, ...(method === 'POST' ? { body: '{"EXAMPLE":true}' } : {}) };
    const result = await (adapter as any).fetchBounded(endpoint, init, 500, 1000, 'EXAMPLE');
    expect(result).toBe(raw); expect(await result.json()).toEqual({ echo: EXAMPLE_KEY });
    const sent = fetch.mock.calls[0][1];
    expect(sent).toEqual({ ...init, signal: expect.any(AbortSignal) });
    expect(sent.headers).toBe(init.headers); expect(sent).not.toHaveProperty('redirect');
    expect(new Headers(sent.headers).has('PF-API-KEY')).toBe(false);
    key.assertUntouched();
  });
  it('legacy REST keeps custom targets and the original transport error identity, type and cause', async () => {
    const key = presentKey(); const adapter = new PacificaAdapter();
    const error = new TypeError('EXAMPLE transport failure', { cause: new Error('EXAMPLE cause') });
    const fetch = vi.fn().mockRejectedValue(error); vi.stubGlobal('fetch', fetch);
    await expect((adapter as any).fetchBounded('https://legacy.example/api/v1/account', { method: 'GET' }, 500, 1000, 'EXAMPLE')).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1); key.assertUntouched();
  });
  it.each(['private', 'prices'])('legacy %s constructor errors retain their original object and reconnect behavior', kind => {
    vi.useFakeTimers(); const key = presentKey(); const error = new TypeError('EXAMPLE constructor failure');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ws: PacificaWsManager | PacificaPricesWsManager;
    if (kind === 'private') {
      vi.stubGlobal('WebSocket', class { constructor() { throw error; } });
      ws = new PacificaWsManager({ wsUrl: 'wss://legacy.example/ws', account: 'EXAMPLE_ACCOUNT' }, {} as any);
    } else {
      ws = new PacificaPricesWsManager({ onTick: () => {}, webSocketFactory: () => { throw error; } });
    }
    ws.connect(); expect(log.mock.calls[0][1]).toBe(error);
    expect(vi.getTimerCount()).toBeGreaterThan(0); ws.disconnect(); key.assertUntouched();
  });
});
