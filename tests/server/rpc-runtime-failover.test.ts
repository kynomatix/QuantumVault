import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  __resetSolanaRpcTransportForTests,
  createSolanaRpcConnection,
  createSolanaRpcTransport,
  fetchSolanaRpc,
  SolanaRpcResponseTooLargeError,
} from '../../server/rpc-config.js';

const PRIMARY = 'https://primary.invalid/?api-key=primary-secret';
const BACKUP = 'https://backup.invalid/?token=backup-secret';

function request(method = 'getBalance'): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  };
}

function rpcResult(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Solana RPC runtime failover', () => {
  beforeEach(() => {
    __resetSolanaRpcTransportForTests();
  });

  it('returns a valid primary response without touching backup', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(rpcResult({ value: 7 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    const response = await transport.fetch(PRIMARY, request());

    expect((await response.json()).result).toEqual({ value: 7 });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][0]).toBe(PRIMARY);
    expect(transport.activeEndpoint()).toBe('primary');
  });

  it('fails a replay-safe read over to backup and promotes only its valid response', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 11 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result).toEqual({ value: 11 });
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it.each([401, 403, 429])('fails over the plausible lapsed-primary HTTP %s signature', async status => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'primary unavailable' }), { status }))
      .mockResolvedValueOnce(rpcResult({ value: 12 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(12);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('fails over the plausible lapsed-primary HTTP 200 / JSON-RPC -32429 signature', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, error: { code: -32429, message: 'provider rate limit' },
      })))
      .mockResolvedValueOnce(rpcResult({ value: 13 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(13);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('does not promote a backup when both endpoints fail', async () => {
    const nativeFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('primary unavailable'))
      .mockRejectedValueOnce(new TypeError('backup unavailable'));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await expect(transport.fetch(PRIMARY, request())).rejects.toMatchObject({
      name: 'SolanaRpcTransportError',
      endpoint: 'backup',
      reason: 'transport',
    });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(transport.activeEndpoint()).toBe('primary');
  });

  it.each(['getSignatureStatuses', 'getTransaction', 'getSignaturesForAddress', 'getBlockHeight', 'isBlockhashValid'])(
    'keeps absence-sensitive history method %s on configured primary and surfaces failure',
    async method => {
      const nativeFetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('primary unavailable'))
        .mockResolvedValueOnce(rpcResult(null));
      const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

      await expect(transport.fetch(PRIMARY, request(method))).rejects.toMatchObject({
        name: 'SolanaRpcTransportError',
        endpoint: 'primary',
      });
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(nativeFetch.mock.calls[0][0]).toBe(PRIMARY);
      expect(transport.activeEndpoint()).toBe('primary');
    },
  );

  it('returns a valid primary history absence unchanged without consulting backup', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(rpcResult({ context: { slot: 1 }, value: [null] }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    const response = await transport.fetch(PRIMARY, request('getSignatureStatuses'));

    expect((await response.json()).result.value).toEqual([null]);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][0]).toBe(PRIMARY);
  });

  it('keeps expiry height on configured primary after an unrelated safe read promotes backup', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 8 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await transport.fetch(PRIMARY, request('getBalance'));
    expect(transport.activeEndpoint()).toBe('backup');
    expect((await transport.fetch(PRIMARY, request('getBlockHeight'))).status).toBe(503);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('never forms an expired verdict from primary null status and backup height', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 8 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 10 }, value: [null] }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult(1_001));
    const connection = createSolanaRpcConnection('confirmed', {
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
    });

    await connection.getBalance(new PublicKey('11111111111111111111111111111111'));
    const reconcile = async (
      rpc: Pick<typeof connection, 'getSignatureStatuses' | 'getBlockHeight'>,
      signature: string,
      lastValidBlockHeight: number,
    ): Promise<'landed' | 'pending' | 'expired'> => {
      const status = (await rpc.getSignatureStatuses([signature])).value[0];
      if (status) return 'landed';
      return (await rpc.getBlockHeight()) > lastValidBlockHeight ? 'expired' : 'pending';
    };

    await expect(reconcile(connection, '1'.repeat(88), 1_000)).rejects.toThrow();
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY, PRIMARY]);
  });

  it('keeps every batch containing a history method on configured primary', async () => {
    const historyBatch = [
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'getTransaction', params: ['signature'] },
    ];
    const mixedHistoryBatch = [
      { jsonrpc: '2.0', id: 3, method: 'sendTransaction', params: ['bytes'] },
      { jsonrpc: '2.0', id: 4, method: 'getSignatureStatuses', params: [['signature']] },
    ];
    const expiryBatch = [
      { jsonrpc: '2.0', id: 5, method: 'getBalance', params: [] },
      { jsonrpc: '2.0', id: 6, method: 'getBlockHeight', params: [] },
    ];
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 9 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await transport.fetch(PRIMARY, request('getBalance'));
    expect(transport.activeEndpoint()).toBe('backup');
    expect((await transport.fetch(PRIMARY, { ...request(), body: JSON.stringify(historyBatch) })).status).toBe(503);
    expect((await transport.fetch(PRIMARY, { ...request(), body: JSON.stringify(mixedHistoryBatch) })).status).toBe(503);
    expect((await transport.fetch(PRIMARY, { ...request(), body: JSON.stringify(expiryBatch) })).status).toBe(503);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY, PRIMARY, PRIMARY]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('treats caller abort as terminal without attempting backup', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('caller stopped', 'AbortError'));
    const nativeFetch = vi.fn();
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await expect(transport.fetch(PRIMARY, { ...request(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeFetch).toHaveBeenCalledTimes(0);
  });

  it('does not enter a backup attempt when the caller aborts an in-flight primary read', async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    const nativeFetch = vi.fn().mockImplementation(async (_url: RequestInfo | URL, init: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      })
    ));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      observe: event => {
        if (event.outcome === 'attempt') attempts.push(event.endpoint);
      },
    });

    const pending = transport.fetch(PRIMARY, { ...request(), signal: controller.signal });
    controller.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual(['primary']);
  });

  it.each(['sendTransaction', 'requestAirdrop', 'futureUnknownMethod'])(
    'keeps unsafe or unknown method %s on one active provider while preserving five 429 attempts',
    async method => {
      const nativeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));
      const transport = createSolanaRpcTransport({
        primaryUrl: PRIMARY,
        backupUrl: BACKUP,
        fetchImpl: nativeFetch,
        signed429BackoffMs: [0, 0, 0, 0],
      });

      expect((await transport.fetch(PRIMARY, request(method))).status).toBe(429);
      expect(nativeFetch).toHaveBeenCalledTimes(5);
      expect(nativeFetch.mock.calls.map(call => call[0])).toEqual(Array(5).fill(PRIMARY));
    },
  );

  it('keeps a later signed write on configured primary after a safe read promotes backup', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 8 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'primary unavailable' }), { status: 503 }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    await transport.fetch(PRIMARY, request('getBalance'));
    const writeResponse = await transport.fetch(PRIMARY, request('sendTransaction'));

    expect(writeResponse.status).toBe(503);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('keeps factory Connection sends on configured primary after its safe read promotes backup', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 8 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'primary unavailable' },
      }), { status: 503, headers: { 'content-type': 'application/json' } }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
    });
    const connection = createSolanaRpcConnection('confirmed', {
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
    });

    await expect(connection.getBalance(new PublicKey('11111111111111111111111111111111'))).resolves.toBe(8);
    expect(transport.activeEndpoint()).toBe('backup');
    await expect(connection.sendRawTransaction(Uint8Array.from([1, 2, 3]))).rejects.toThrow('primary unavailable');
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('keeps browser proxy helper sends on configured primary after a safe read promotes backup', async () => {
    const priorPrimary = process.env.SOLANA_RPC_URL;
    const priorBackup = process.env.TRITON_ONE_RPC;
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 8 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'primary unavailable' },
      }), { status: 503, headers: { 'content-type': 'application/json' } }));

    try {
      process.env.SOLANA_RPC_URL = PRIMARY;
      process.env.TRITON_ONE_RPC = BACKUP;
      vi.stubGlobal('fetch', nativeFetch);
      __resetSolanaRpcTransportForTests();

      await fetchSolanaRpc({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] });
      const writeResponse = await fetchSolanaRpc({
        jsonrpc: '2.0', id: 2, method: 'sendTransaction', params: ['signed-bytes'],
      });

      expect(writeResponse.status).toBe(503);
      expect(await writeResponse.json()).toMatchObject({ error: { message: 'primary unavailable' } });
      expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY]);
      expect(createSolanaRpcTransport().activeEndpoint()).toBe('backup');
    } finally {
      if (priorPrimary === undefined) delete process.env.SOLANA_RPC_URL;
      else process.env.SOLANA_RPC_URL = priorPrimary;
      if (priorBackup === undefined) delete process.env.TRITON_ONE_RPC;
      else process.env.TRITON_ONE_RPC = priorBackup;
      vi.unstubAllGlobals();
      __resetSolanaRpcTransportForTests();
    }
  });

  it('fails over a narrow transient JSON-RPC refusal', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Node is behind' } })))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 99 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(99);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('returns domain JSON-RPC errors without failover', async () => {
    const domainError = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } };
    const nativeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(domainError)));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect(await (await transport.fetch(PRIMARY, request())).json()).toEqual(domainError);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not use message substrings to reinterpret a domain error as transient', async () => {
    const domainError = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'node is behind and rate limited' } };
    const nativeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(domainError)));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect(await (await transport.fetch(PRIMARY, request())).json()).toEqual(domainError);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('fails over a non-empty all-safe batch only when response ids match', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 7, method: 'getBalance', params: [] },
      { jsonrpc: '2.0', id: 'slot', method: 'getSlot', params: [] },
    ];
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 7, error: { code: -32005, message: 'unhealthy' } },
        { jsonrpc: '2.0', id: 'slot', result: 1 },
      ])))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 'slot', result: 2 },
        { jsonrpc: '2.0', id: 7, result: { value: 3 } },
      ])));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await expect((await transport.fetch(PRIMARY, { ...request(), body: JSON.stringify(batch) })).json())
      .resolves.toHaveLength(2);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP]);
  });

  it.each([
    { body: [] },
    { body: [{ jsonrpc: '2.0', method: 'getBalance', params: [] }] },
    { body: [
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'sendTransaction', params: [] },
    ] },
  ])('keeps empty, notification-only, and mixed batches single-provider', async ({ body }) => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await transport.fetch(PRIMARY, { ...request(), body: JSON.stringify(body) });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][0]).toBe(PRIMARY);
  });

  it('does not promote a response whose batch ids do not match the request', async () => {
    const body = [
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'getSlot', params: [] },
    ];
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: 1 },
        { jsonrpc: '2.0', id: 99, result: 2 },
      ])))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: 1 },
        { jsonrpc: '2.0', id: 2, result: 2 },
      ])));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await expect((await transport.fetch(PRIMARY, { ...request(), body: JSON.stringify(body) })).json())
      .resolves.toHaveLength(2);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('fails back only after the active backup fails and primary succeeds', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 1 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 2 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await transport.fetch(PRIMARY, request());
    expect(transport.activeEndpoint()).toBe('backup');
    await transport.fetch(PRIMARY, request());
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, BACKUP, PRIMARY]);
    expect(transport.activeEndpoint()).toBe('primary');
  });

  it('does not let a late primary success reverse a concurrent backup promotion', async () => {
    let resolveSlowPrimary!: (response: Response) => void;
    const slowPrimary = new Promise<Response>(resolve => { resolveSlowPrimary = resolve; });
    let primaryCalls = 0;
    const nativeFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      if (url === PRIMARY) {
        primaryCalls += 1;
        if (primaryCalls === 1) return slowPrimary;
        return new Response('{}', { status: 503 });
      }
      return rpcResult({ value: 22 });
    });
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    const slow = transport.fetch(PRIMARY, request());
    await Promise.resolve();
    await expect(transport.fetch(PRIMARY, request())).resolves.toBeInstanceOf(Response);
    expect(transport.activeEndpoint()).toBe('backup');
    resolveSlowPrimary(rpcResult({ value: 11 }));
    await expect(slow).resolves.toBeInstanceOf(Response);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('does not let an older request promote after the selection returns to its starting endpoint', async () => {
    const bootstrapFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 1 }));
    const bootstrap = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: bootstrapFetch,
    });
    await bootstrap.fetch(PRIMARY, request());
    expect(bootstrap.activeEndpoint()).toBe('backup');

    let resolveOlderPrimary!: (response: Response) => void;
    const olderPrimary = new Promise<Response>(resolve => { resolveOlderPrimary = resolve; });
    let signalOlderPrimaryStarted!: () => void;
    const olderPrimaryStarted = new Promise<void>(resolve => { signalOlderPrimaryStarted = resolve; });
    const olderFetch = vi.fn().mockImplementation((url: RequestInfo | URL) => {
      if (url === BACKUP) return Promise.resolve(new Response('{}', { status: 503 }));
      signalOlderPrimaryStarted();
      return olderPrimary;
    });
    const older = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: olderFetch,
    });
    const olderRequest = older.fetch(PRIMARY, request());
    await olderPrimaryStarted;

    const promotePrimaryFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 2 }));
    const promotePrimary = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: promotePrimaryFetch,
    });
    await promotePrimary.fetch(PRIMARY, request());
    expect(promotePrimary.activeEndpoint()).toBe('primary');

    const promoteBackupFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 3 }));
    const selectedEvents: string[] = [];
    const promoteBackup = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: promoteBackupFetch,
      observe: event => {
        if (event.outcome === 'selected') selectedEvents.push(event.endpoint);
      },
    });
    await promoteBackup.fetch(PRIMARY, request());
    expect(promoteBackup.activeEndpoint()).toBe('backup');

    resolveOlderPrimary(rpcResult({ value: 4 }));
    await olderRequest;
    expect(older.activeEndpoint()).toBe('backup');
    expect(selectedEvents).toEqual(['backup']);
  });

  it('settles a web3-style read at the transport deadline even when fetch ignores abort', async () => {
    const nativeFetch = vi.fn().mockImplementation(() => new Promise<Response>(() => undefined));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: null,
      fetchImpl: nativeFetch,
      primaryTimeoutMs: 5,
      totalTimeoutMs: 10,
    });

    await expect(transport.fetch(PRIMARY, request())).rejects.toMatchObject({
      name: 'SolanaRpcTransportError',
      reason: 'timeout',
    });
  });

  it('fails over malformed provider JSON', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{not-json'))
      .mockResolvedValueOnce(rpcResult({ value: 3 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(3);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('enforces the body cap even when Content-Length is absent', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: 'x'.repeat(512) })));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: null,
      fetchImpl: nativeFetch,
      maxResponseBytes: 32,
    });

    await expect(transport.fetch(PRIMARY, request())).rejects.toBeInstanceOf(SolanaRpcResponseTooLargeError);
  });

  it('does not forward primary credentials or provider headers to backup', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ value: 1 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: BACKUP, fetchImpl: nativeFetch });

    await transport.fetch(PRIMARY, {
      ...request(),
      headers: {
        authorization: 'Bearer primary-secret',
        'x-api-key': 'primary-secret',
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });

    expect(nativeFetch.mock.calls[1][0]).toBe(BACKUP);
    const headers = new Headers(nativeFetch.mock.calls[1][1]?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('remains primary-only when no backup is configured', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    const transport = createSolanaRpcTransport({ primaryUrl: PRIMARY, backupUrl: null, fetchImpl: nativeFetch });

    expect((await transport.fetch(PRIMARY, request())).status).toBe(503);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('disables web3 rate-limit retries so one safe call has at most two transport attempts', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 123 }));
    const connection = createSolanaRpcConnection('confirmed', {
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
    });

    await expect(connection.getBalance(new PublicKey('11111111111111111111111111111111'))).resolves.toBe(123);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('alternates bounded retries after both providers return 429', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ context: { slot: 1 }, value: 321 }));
    const connection = createSolanaRpcConnection('confirmed', {
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    await expect(connection.getBalance(new PublicKey('11111111111111111111111111111111'))).resolves.toBe(321);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, PRIMARY]);
  });

  it('retries the alternate after a starting non-429 failure and alternate 429', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ value: 654 }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(654);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, BACKUP]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('returns to a throttled active backup when the dead primary returns 401', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 1 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(rpcResult({ value: 2 }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    await transport.fetch(PRIMARY, request());
    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(2);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, BACKUP, PRIMARY, BACKUP]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('returns to a throttled active backup after both providers return 429', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(rpcResult({ value: 1 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ value: 2 }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    await transport.fetch(PRIMARY, request());
    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(2);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual([PRIMARY, BACKUP, BACKUP, PRIMARY, BACKUP]);
    expect(transport.activeEndpoint()).toBe('backup');
  });

  it('preserves five same-provider 429 attempts for a replay-safe primary-only call', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ value: 77 }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: null,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    expect((await (await transport.fetch(PRIMARY, request())).json()).result.value).toBe(77);
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual(Array(5).fill(PRIMARY));
  });

  it('keeps history-authoritative 429 retries on configured primary for five attempts', async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(rpcResult({ value: [null] }));
    const transport = createSolanaRpcTransport({
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: nativeFetch,
      signed429BackoffMs: [0, 0, 0, 0],
    });

    await expect((await transport.fetch(PRIMARY, request('getSignatureStatuses'))).json())
      .resolves.toMatchObject({ result: { value: [null] } });
    expect(nativeFetch.mock.calls.map(call => call[0])).toEqual(Array(5).fill(PRIMARY));
    expect(transport.activeEndpoint()).toBe('primary');
  });

  it('pins the websocket endpoint to the configured primary', () => {
    const connection = createSolanaRpcConnection('confirmed', {
      primaryUrl: PRIMARY,
      backupUrl: BACKUP,
      fetchImpl: vi.fn(),
    });

    expect((connection as unknown as { _rpcWsEndpoint: string })._rpcWsEndpoint)
      .toBe('wss://primary.invalid/?api-key=primary-secret');
  });
});
