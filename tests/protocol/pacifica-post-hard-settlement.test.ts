import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PacificaAdapter,
  PacificaPostOutcomeAmbiguousError,
} from '../../server/protocol/pacifica/pacifica-adapter.js';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache.js';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota.js';
import { isUnconfirmedLandingVerdict } from '../../server/protocol/tx-verdicts.js';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/qv_test';
process.env.AGENT_ENCRYPTION_KEY ??= '0'.repeat(64);
const { isTransientError } = await import('../../server/trade-retry-service.js');

function abortAwarePendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('test fixture requires a request signal'));
      return;
    }
    const rejectFromAbort = () => reject(signal.reason);
    if (signal.aborted) rejectFromAbort();
    else signal.addEventListener('abort', rejectFromAbort, { once: true });
  }));
}

function subject(): PacificaAdapter & {
  post(path: string, body: unknown): Promise<unknown>;
  postWithApprovalRetry(
    path: string,
    buildBody: () => unknown,
    logTag: string,
    alreadyMatcher: RegExp,
  ): Promise<boolean>;
} {
  return new PacificaAdapter({ baseUrl: 'http://pacifica.test' }) as never;
}

describe('Pacifica generic POST hard settlement', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    pacificaCache.resetCounters();
    pacificaQuota.resetCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    pacificaCache.invalidateAll();
  });

  it('hard-settles a mutation whose socket ignores abort and classifies the outcome as ambiguous', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = subject().post('/account/withdraw', {
      account: 'account-1', amount: '10', signature: 'redacted', timestamp: 1,
    }).catch(error => error);
    let settled = false;
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(34_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;

    expect(error).toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(error).toMatchObject({
      code: 'PACIFICA_POST_OUTCOME_AMBIGUOUS',
      endpoint: '/account/withdraw',
      mutationClass: 'withdrawal',
      authoritativeReads: [],
      stableIdentity: false,
      retryDisposition: 'never_automatic',
      priority: 'normal',
    });
    expect(isUnconfirmedLandingVerdict(error)).toBe(true);
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
  });

  it('hard-settles a body read that wedges after 2xx headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => new Promise<unknown>(() => {}),
    } as Response)));
    const pending = subject().post('/account/leverage', {
      account: 'account-1', symbol: 'BTC', leverage: 5,
    }).catch(error => error);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(error).toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(error).toMatchObject({
      mutationClass: 'leverage_update',
      authoritativeReads: ['/account/settings:symbol+leverage'],
      stableIdentity: true,
      retryDisposition: 'after_authoritative_read',
    });
  });

  it.each([400, 401, 403, 404, 405, 422])('keeps explicit terminal HTTP %s distinct from ambiguous outcomes', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid request', { status })));
    const error = await subject().post('/account/leverage', {
      account: 'account-1', symbol: 'BTC', leverage: 5,
    }).catch(value => value);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(isUnconfirmedLandingVerdict(error)).toBe(false);
  });

  it('keeps HTTP 429 visible as a terminal rejection for the bounded approval retry loop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const error = await subject().post('/account/builder_codes/approve', {
      account: 'account-1', builder_code: 'QuantumVault',
    }).catch(value => value);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(String(error)).toContain('429');
    expect(isUnconfirmedLandingVerdict(error)).toBe(false);
  });

  it.each([408, 409, 425, 499, 500, 503])('classifies nonterminal HTTP %s as ambiguous', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream uncertain', { status })));
    const error = await subject().post('/account/leverage', {
      account: 'account-1', symbol: 'BTC', leverage: 5,
    }).catch(value => value);

    expect(error).toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(error).toMatchObject({
      mutationClass: 'leverage_update',
      stableIdentity: true,
      retryDisposition: 'after_authoritative_read',
      priority: 'normal',
    });
  });

  it.each([
    ['/orders/create', { account: 'a' }, 'limit_order_create', ['/orders/open:client_order_id', '/trades/history:client_order_id'], false, 'normal'],
    ['/orders/stop/create', { account: 'a', client_order_id: 'stop-1' }, 'stop_order_create', ['/orders/stop:client_order_id', '/trades/history:client_order_id'], true, 'normal'],
    ['/account/margin', { account: 'a', margin_mode: 'cross' }, 'margin_mode_update', ['/account/settings:margin_mode'], true, 'normal'],
    ['/positions/tpsl', { account: 'a', symbol: 'BTC' }, 'position_tpsl_update', ['/orders/stop:symbol+legs'], true, 'normal'],
    ['/account/subaccount/create', { main_account: 'a', subaccount: 'sub' }, 'subaccount_create', ['/account/subaccount/list:subaccount'], true, 'normal'],
    ['/account/builder_codes/approve', { account: 'a', builder_code: 'QV' }, 'builder_code_approval', ['/account/builder_codes/approvals:builder_code'], true, 'normal'],
    ['/referral/user/code/claim', { account: 'a', code: 'ref' }, 'referral_code_claim', ['/account:referral_code'], true, 'normal'],
    ['/account/subaccount/transfer', { account: 'a', to_account: 'sub', amount: '1' }, 'subaccount_transfer', [], false, 'normal'],
    ['/agent/bind', { account: 'a', agent_wallet: 'agent' }, 'agent_binding', [], false, 'normal'],
  ] as const)('binds %s to its reconciliation policy', async (path, body, mutationClass, reads, stableIdentity, priority) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket failure'); }));
    const error = await subject().post(path, body).catch(value => value);

    expect(error).toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(error).toMatchObject({
      mutationClass,
      authoritativeReads: [...reads],
      stableIdentity,
      retryDisposition: stableIdentity ? 'after_authoritative_read' : 'never_automatic',
      priority,
    });
  });

  it.each([
    ['/orders/create_market', { account: 'a', client_order_id: 'close-1' }],
    ['/orders/cancel', { account: 'a', order_id: 'order-1' }],
    ['/orders/cancel_all', { account: 'a', all_symbols: true }],
    ['/orders/stop/cancel', { account: 'a', order_id: 'stop-1' }],
  ] as const)('keeps risk-reducing %s transient after the real soft-abort path', async (path, body) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', abortAwarePendingFetch());
    const pending = subject().post(path, body).catch(value => value);

    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(isUnconfirmedLandingVerdict(error)).toBe(false);
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ['/orders/create_market', { account: 'a', client_order_id: 'close-1' }],
    ['/orders/cancel', { account: 'a', order_id: 'order-1' }],
    ['/orders/cancel_all', { account: 'a', all_symbols: true }],
    ['/orders/stop/cancel', { account: 'a', order_id: 'stop-1' }],
  ] as const)('keeps risk-reducing %s transient after hard abandonment', async (path, body) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = subject().post(path, body).catch(value => value);
    await vi.advanceTimersByTimeAsync(35_000);
    const error = await pending;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(isUnconfirmedLandingVerdict(error)).toBe(false);
    expect(isTransientError(error)).toBe(true);
  });

  it('does not swallow an ambiguous approval response whose body resembles already-enrolled success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('already approved', { status: 503 })));

    const approved = await subject().postWithApprovalRetry(
      '/account/builder_codes/approve',
      () => ({ account: 'a', builder_code: 'QuantumVault' }),
      '[test]',
      /already approved/i,
    );

    expect(approved).toBe(false);
  });

  it('keeps the authenticated signed POST read retryable and outside mutation ambiguity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('read socket timeout'); }));
    const error = await subject().post('/account/subaccount/list', {
      account: 'account-1', signature: 'redacted', timestamp: 1,
    }).catch(value => value);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(isUnconfirmedLandingVerdict(error)).toBe(false);
  });

  it('invalidates pre-mutation authority even when the response is ambiguous', async () => {
    pacificaCache.set('/positions?account=account-1', '/positions', [{ symbol: 'BTC' }]);
    pacificaCache.set('/account?account=account-1', '/account', { equity: '10' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket failure'); }));

    await subject().post('/orders/cancel', { account: 'account-1', order_id: 'order-1' }).catch(() => {});

    expect(pacificaCache.getFresh('/positions?account=account-1')).toBeUndefined();
    expect(pacificaCache.getFresh('/account?account=account-1')).toBeUndefined();
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
  });

  it('abandons a late response after the hard deadline without a second quota charge or cache invalidation', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const pending = subject().post('/account/leverage', {
      account: 'account-1', symbol: 'BTC', leverage: 5,
    }).catch(error => error);

    await vi.advanceTimersByTimeAsync(35_000);
    const error = await pending;
    expect(error).toBeInstanceOf(PacificaPostOutcomeAmbiguousError);
    expect(pacificaQuota.snapshot().requestsServed).toBe(1);

    pacificaCache.set('/positions?account=account-1', '/positions', [{ symbol: 'BTC' }]);
    pacificaCache.set('/account?account=account-1', '/account', { equity: '10' });
    resolveFetch(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(pacificaQuota.snapshot().requestsServed).toBe(1);
    expect(pacificaCache.getFresh('/positions?account=account-1')).toEqual([{ symbol: 'BTC' }]);
    expect(pacificaCache.getFresh('/account?account=account-1')).toEqual({ equity: '10' });
  });

  it('rejects an undeclared future POST endpoint before sending anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await subject().post('/future/mutation', {}).catch(value => value);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('settlement policy is not declared');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pacificaQuota.snapshot().requestsServed).toBe(0);
  });
});
