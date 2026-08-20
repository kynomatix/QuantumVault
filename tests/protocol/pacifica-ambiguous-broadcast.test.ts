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

  it('keeps reduce-only close timeout throwable, token-free, and retryable', async () => {
    process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/qv_test';
    process.env.AGENT_ENCRYPTION_KEY ??= '0'.repeat(64);
    const { isTransientError } = await import('../../server/trade-retry-service.js');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('request timeout'); }));

    let caught: unknown;
    try {
      await adapter().placeMarketOrder(request({ reduceOnly: true }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isUnconfirmedLandingVerdict(caught)).toBe(false);
    expect(isTransientError(caught)).toBe(true);
  });
});
