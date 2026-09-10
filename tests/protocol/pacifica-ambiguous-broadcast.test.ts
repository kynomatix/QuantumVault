import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache.js';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota.js';
import {
  isUnconfirmedLandingResult,
  isUnconfirmedLandingVerdict,
} from '../../server/protocol/tx-verdicts.js';
import type { MarketOrderParams } from '../../server/protocol/protocol-types.js';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/qv_test';
process.env.AGENT_ENCRYPTION_KEY ??= '0'.repeat(64);
const { isTransientError } = await import('../../server/trade-retry-service.js');

function request(overrides: Partial<MarketOrderParams> = {}): MarketOrderParams {
  return {
    agentPublicKey: 'agent-account',
    agentSecretKey: new Uint8Array(64),
    mainWalletAddress: 'owner-wallet',
    internalSymbol: 'BTC-PERP',
    side: 'long',
    sizeBase: 0.01,
    clientOrderId: 'client-order-1',
    subaccountId: 'sub-1',
    ...overrides,
  };
}

function adapter(): PacificaAdapter {
  const subject = new PacificaAdapter({ baseUrl: 'http://pacifica.test' }) as any;
  subject.ensurePacificaEnrollment = vi.fn(async () => ({
    builderApproved: false,
    referralClaimed: false,
  }));
  subject.getRegistry = () => ({ internalToProtocol: () => 'BTC' });
  subject.quantizeOrderSize = (_symbol: string, size: number) => size;
  subject.quantizeOrderSizeCeil = (_symbol: string, size: number) => size;
  return subject;
}

function seedMutationCaches(): void {
  pacificaCache.set('/positions?account=agent-account', '/positions', [{ symbol: 'BTC' }]);
  pacificaCache.set('/account?account=agent-account', '/account', { equity: '10' });
}

function expectMutationCachesInvalidated(): void {
  expect(pacificaCache.getFresh('/positions?account=agent-account')).toBeUndefined();
  expect(pacificaCache.getFresh('/account?account=agent-account')).toBeUndefined();
}

describe('Pacifica risk-increasing market-order ambiguity', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    pacificaCache.resetCounters();
    pacificaQuota.resetCounters();
    vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => ({
        ...data,
        account: 'agent-account',
        signature: 'sig',
        timestamp: 1,
      }) as any,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    pacificaCache.invalidateAll();
  });

  it('returns typed unconfirmed on transport rejection, records quota, and invalidates cached state', async () => {
    seedMutationCaches();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket timeout'); }));

    const result = await adapter().placeMarketOrder(request());

    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      clientOrderId: 'client-order-1',
      landingDisposition: 'unconfirmed',
    });
    expect(isUnconfirmedLandingResult(result)).toBe(true);
    expect(isUnconfirmedLandingVerdict(result.error)).toBe(true);
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
    expectMutationCachesInvalidated();
  });

  it('treats an explicit terminal 422 as a terminal rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid order', { status: 422 })));

    const result = await adapter().placeMarketOrder(request());

    expect(result).toMatchObject({
      success: false,
      status: 'rejected',
      landingDisposition: 'terminal',
    });
    expect(isUnconfirmedLandingResult(result)).toBe(false);
  });

  it.each([408, 409, 425, 429, 500, 503])('treats HTTP %s as unconfirmed', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('uncertain', { status })));
    const result = await adapter().placeMarketOrder(request());
    expect(result.landingDisposition).toBe('unconfirmed');
    expect(isUnconfirmedLandingVerdict(result.error)).toBe(true);
  });

  it('treats an unreadable 2xx body as unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })));
    const result = await adapter().placeMarketOrder(request());
    expect(result).toMatchObject({ success: false, status: 'unknown', landingDisposition: 'unconfirmed' });
  });

  it('treats a 2xx success:false envelope as conservative unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: 'not terminal',
    }), { status: 200 })));
    const result = await adapter().placeMarketOrder(request());
    expect(result).toMatchObject({ success: false, status: 'unknown', landingDisposition: 'unconfirmed' });
  });

  it('maps a compact acknowledgement to success-shaped unconfirmed and preserves supplied identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { I: 'venue-client-id', i: 7123 },
    }), { status: 200 })));

    const result = await adapter().placeMarketOrder(request());

    expect(result).toMatchObject({
      success: true,
      status: 'acknowledged',
      orderId: '7123',
      clientOrderId: 'client-order-1',
      landingDisposition: 'unconfirmed',
    });
    expect(isUnconfirmedLandingVerdict(result.error)).toBe(true);
  });

  it.each(['submitted', 'acknowledged', 'partial_fill', 'venue_future_state'])('maps nonterminal %s to unconfirmed', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      order_id: 'order-1',
      status,
    }), { status: 200 })));
    const result = await adapter().placeMarketOrder(request());
    expect(result.landingDisposition).toBe('unconfirmed');
    expect(isUnconfirmedLandingResult(result)).toBe(true);
  });

  it('maps filled to terminal success while recording quota and invalidating cached state', async () => {
    seedMutationCaches();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      order_id: 'order-filled',
      client_order_id: 'venue-client-id',
      status: 'filled',
      fill_price: '101.5',
      fill_size: '0.01',
    }), { status: 200 })));

    const result = await adapter().placeMarketOrder(request());

    expect(result).toMatchObject({
      success: true,
      status: 'filled',
      orderId: 'order-filled',
      clientOrderId: 'client-order-1',
      fillPrice: 101.5,
      fillSize: 0.01,
      landingDisposition: 'terminal',
    });
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
    expectMutationCachesInvalidated();
  });

  it('keeps reduce-only close transport failure on the ordinary urgent retry path', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('test fixture requires a request signal'));
        return;
      }
      const rejectFromAbort = () => reject(signal.reason);
      if (signal.aborted) rejectFromAbort();
      else signal.addEventListener('abort', rejectFromAbort, { once: true });
    })));

    const pending = adapter().placeMarketOrder(request({ reduceOnly: true })).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const caught = await pending;

    expect(caught).toBeInstanceOf(Error);
    expect(isUnconfirmedLandingVerdict(caught)).toBe(false);
    expect(isTransientError(caught)).toBe(true);
  });
});

// Append to the existing pacifica-ambiguous-broadcast.test.ts in a disposable
// source snapshot. The existing request/adapter/cache fixtures remain in scope.
describe('Pacifica entry transport soft/hard separation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pacificaCache.invalidateAll();
    pacificaQuota.resetCounters();
    vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => ({
        ...data, account: 'agent-account', signature: 'synthetic-signature', timestamp: 1,
      }) as any,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    pacificaCache.invalidateAll();
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function filled() {
    return new Response(JSON.stringify({ order_id: 'entry-filled', status: 'filled',
      fill_price: '101.5', fill_size: '0.01' }), { status: 200 });
  }
  it('settles abort-responsive entry at the existing soft deadline', async () => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = adapter().placeMarketOrder(request());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pacificaQuota.snapshot().requestsServed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ landingDisposition: 'unconfirmed', clientOrderId: 'client-order-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps an abort-insensitive entry pending through grace and abandons at 35 seconds', async () => {
    const transport = deferred<Response>();
    const fetchMock = vi.fn(() => transport.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = adapter().placeMarketOrder(request());
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false); // Red promptly on the current equal 30s/30s pair.
      expect(pacificaQuota.snapshot().requestsServed).toBe(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ landingDisposition: 'unconfirmed', clientOrderId: 'client-order-1' });
      expect(pacificaQuota.snapshot().requestsServed).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.resolve(filled());
      await vi.advanceTimersByTimeAsync(0);
    }
  });
  it('accepts a terminal fill arriving during the existing generic POST grace interval', async () => {
    const transport = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => transport.promise));
    const pending = adapter().placeMarketOrder(request());
    await vi.advanceTimersByTimeAsync(32_000);
    transport.resolve(filled());
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ success: true, status: 'filled', orderId: 'entry-filled',
      clientOrderId: 'client-order-1', landingDisposition: 'terminal' });
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['resolve', 'reject'] as const)('observes late transport %s without a second outcome or quota write', async late => {
    const transport = deferred<Response>();
    const fetchMock = vi.fn(() => transport.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = adapter().placeMarketOrder(request());
    await vi.advanceTimersByTimeAsync(35_000);
    const original = await pending;
    const json = vi.fn(async () => ({ status: 'filled', order_id: 'late' }));
    if (late === 'resolve') transport.resolve({ ok: true, json } as unknown as Response);
    else transport.reject(new Error('synthetic late rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe(original);
    expect(original.landingDisposition).toBe('unconfirmed');
    expect(json).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains the separate ten-second body budget after grace-period headers', async () => {
    const transport = deferred<Response>(), body = deferred<unknown>();
    vi.stubGlobal('fetch', vi.fn(() => transport.promise));
    const pending = adapter().placeMarketOrder(request());
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(34_999);
      transport.resolve({ ok: true, json: () => body.promise } as unknown as Response);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ landingDisposition: 'unconfirmed' });
      expect(pacificaQuota.snapshot().requestsServed).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.resolve(filled());
      body.resolve({ status: 'filled', order_id: 'late-body' });
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
