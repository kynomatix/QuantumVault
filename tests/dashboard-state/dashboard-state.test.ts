// Truthful dashboard states (2026-07-19 incident): "no bots / no positions"
// may only render after an HTTP 200 for the confirmed active wallet. These
// tests pin the pure derivation and the server-health store so a failed read
// can never silently masquerade as an empty account again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deriveDashboardSectionState,
  isBlockedState,
  staleDataLabel,
  type DashboardSectionInputs,
} from '../../client/src/lib/dashboard-state';
import {
  coreFetch,
  CoreReadError,
  reportCoreReadFailure,
  reportCoreReadSuccess,
  reportCoreAuthFailure,
  reportCoreAuthSuccess,
  isServerDegraded,
  isSessionExpired,
  __resetServerHealthForTests,
} from '../../client/src/lib/server-health';

function inputs(overrides: Partial<DashboardSectionInputs> = {}): DashboardSectionInputs {
  // Baseline: healthy connected wallet, successful non-empty read.
  return {
    walletConnected: true,
    walletConnecting: false,
    signingInProgress: false,
    authError: false,
    sessionConnected: true,
    sessionExpired: false,
    serverDegraded: false,
    querySuccess: true,
    queryError: false,
    isEmpty: false,
    hasData: true,
    ...overrides,
  };
}

describe('deriveDashboardSectionState', () => {
  it('renders ready with fresh data', () => {
    expect(deriveDashboardSectionState(inputs())).toBe('ready');
  });

  it('allows "empty" ONLY after a successful read with zero items', () => {
    expect(
      deriveDashboardSectionState(inputs({ querySuccess: true, isEmpty: true, hasData: false })),
    ).toBe('empty');
  });

  it('never returns "empty" when the query has not succeeded', () => {
    // Every failure combination with no data must NOT claim empty.
    const failureModes: Partial<DashboardSectionInputs>[] = [
      { querySuccess: false, isEmpty: true, hasData: false }, // still loading
      { querySuccess: false, queryError: true, isEmpty: true, hasData: false }, // read failed
      { querySuccess: false, serverDegraded: true, isEmpty: true, hasData: false }, // server down
      { querySuccess: false, sessionExpired: true, isEmpty: true, hasData: false }, // 401/403
      { querySuccess: false, sessionConnected: false, isEmpty: true, hasData: false }, // no session
      { querySuccess: false, walletConnected: false, isEmpty: true, hasData: false }, // no wallet
    ];
    for (const mode of failureModes) {
      const state = deriveDashboardSectionState(inputs(mode));
      expect(state, JSON.stringify(mode)).not.toBe('empty');
      expect(state, JSON.stringify(mode)).not.toBe('ready');
    }
  });

  it('wallet-level states take precedence (queries are disabled there)', () => {
    expect(
      deriveDashboardSectionState(inputs({ walletConnected: false, walletConnecting: true })),
    ).toBe('wallet-connecting');
    expect(deriveDashboardSectionState(inputs({ walletConnected: false }))).toBe(
      'wallet-disconnected',
    );
    expect(
      deriveDashboardSectionState(
        inputs({ sessionConnected: false, signingInProgress: true }),
      ),
    ).toBe('signature-required');
    expect(
      deriveDashboardSectionState(inputs({ sessionConnected: false, authError: true })),
    ).toBe('auth-failed');
    // Connected, no session, nothing in flight yet → still connecting, never empty.
    expect(deriveDashboardSectionState(inputs({ sessionConnected: false }))).toBe(
      'wallet-connecting',
    );
  });

  it('session expiry without cached data → explicit session-expired state', () => {
    expect(
      deriveDashboardSectionState(
        inputs({ sessionExpired: true, querySuccess: false, hasData: false }),
      ),
    ).toBe('session-expired');
  });

  it('preserves last-known-good data as "stale" under every failure', () => {
    const failuresWithData: Partial<DashboardSectionInputs>[] = [
      { sessionExpired: true },
      { serverDegraded: true },
      { queryError: true, querySuccess: false },
      { querySuccess: false }, // refetch in flight after cache restore
    ];
    for (const mode of failuresWithData) {
      expect(
        deriveDashboardSectionState(inputs({ ...mode, hasData: true })),
        JSON.stringify(mode),
      ).toBe('stale');
    }
  });

  it('server degradation without cached data → server-unavailable', () => {
    expect(
      deriveDashboardSectionState(
        inputs({ serverDegraded: true, querySuccess: false, hasData: false }),
      ),
    ).toBe('server-unavailable');
  });

  it('a single failed read (server healthy) → request-failed', () => {
    expect(
      deriveDashboardSectionState(
        inputs({ queryError: true, querySuccess: false, hasData: false }),
      ),
    ).toBe('request-failed');
  });

  it('sessionExpired outranks serverDegraded (auth problem is more specific)', () => {
    expect(
      deriveDashboardSectionState(
        inputs({
          sessionExpired: true,
          serverDegraded: true,
          querySuccess: false,
          hasData: false,
        }),
      ),
    ).toBe('session-expired');
  });

  it('isBlockedState covers exactly the explicit problem panels', () => {
    expect(isBlockedState('session-expired')).toBe(true);
    expect(isBlockedState('server-unavailable')).toBe(true);
    expect(isBlockedState('request-failed')).toBe(true);
    expect(isBlockedState('auth-failed')).toBe(true);
    expect(isBlockedState('empty')).toBe(false);
    expect(isBlockedState('ready')).toBe(false);
    expect(isBlockedState('loading')).toBe(false);
    expect(isBlockedState('stale')).toBe(false);
  });

  it('staleDataLabel formats a timestamp and handles the unknown case', () => {
    expect(staleDataLabel(0)).toBe('Last update time unknown');
    expect(staleDataLabel(Date.now())).toMatch(/^Last updated /);
  });
});

describe('server-health store', () => {
  beforeEach(() => __resetServerHealthForTests());
  afterEach(() => __resetServerHealthForTests());

  it('flags degraded only after 2 consecutive failures (one blip tolerated)', () => {
    reportCoreReadFailure();
    expect(isServerDegraded()).toBe(false);
    reportCoreReadFailure();
    expect(isServerDegraded()).toBe(true);
  });

  it('a success resets the failure streak and clears degradation', () => {
    reportCoreReadFailure();
    reportCoreReadSuccess();
    reportCoreReadFailure();
    expect(isServerDegraded()).toBe(false); // streak was broken
    reportCoreReadFailure();
    expect(isServerDegraded()).toBe(true);
    reportCoreReadSuccess();
    expect(isServerDegraded()).toBe(false);
  });

  it('session expiry is latched by auth failure and cleared by auth success', () => {
    expect(isSessionExpired()).toBe(false);
    reportCoreAuthFailure();
    expect(isSessionExpired()).toBe(true);
    reportCoreAuthSuccess();
    expect(isSessionExpired()).toBe(false);
  });

  it('CoreReadError classifies status codes into auth/server/http kinds', () => {
    expect(new CoreReadError('bots', 401).kind).toBe('auth');
    expect(new CoreReadError('bots', 403).kind).toBe('auth');
    expect(new CoreReadError('bots', 500).kind).toBe('server');
    expect(new CoreReadError('bots', 503).kind).toBe('server');
    expect(new CoreReadError('bots', 404).kind).toBe('http');
    expect(new CoreReadError('bots', 401).status).toBe(401);
    expect(new CoreReadError('bots', 500).message).toContain('HTTP 500');
  });
});

describe('coreFetch', () => {
  beforeEach(() => __resetServerHealthForTests());
  afterEach(() => {
    __resetServerHealthForTests();
    vi.unstubAllGlobals();
  });

  function stubFetchSequence(responses: Array<Response | Error>) {
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      }),
    );
  }

  it('marks degraded after consecutive 5xx and clears on the next 200', async () => {
    stubFetchSequence([
      new Response('err', { status: 500 }),
      new Response('err', { status: 500 }),
      new Response('{}', { status: 200 }),
    ]);
    await coreFetch('/api/trading-bots');
    expect(isServerDegraded()).toBe(false);
    await coreFetch('/api/trading-bots');
    expect(isServerDegraded()).toBe(true);
    await coreFetch('/api/trading-bots');
    expect(isServerDegraded()).toBe(false);
  });

  it('network errors count toward degradation and rethrow', async () => {
    stubFetchSequence([new Error('ECONNREFUSED'), new Error('ECONNREFUSED')]);
    await expect(coreFetch('/x')).rejects.toThrow('ECONNREFUSED');
    await expect(coreFetch('/x')).rejects.toThrow('ECONNREFUSED');
    expect(isServerDegraded()).toBe(true);
  });

  it('401/403 flips sessionExpired but NOT degraded; 200 clears it', async () => {
    stubFetchSequence([
      new Response('nope', { status: 403 }),
      new Response('{}', { status: 200 }),
    ]);
    await coreFetch('/api/positions');
    expect(isSessionExpired()).toBe(true);
    expect(isServerDegraded()).toBe(false);
    await coreFetch('/api/positions');
    expect(isSessionExpired()).toBe(false);
  });

  it('a 404 neither degrades nor expires the session', async () => {
    stubFetchSequence([new Response('missing', { status: 404 })]);
    const res = await coreFetch('/api/whatever');
    expect(res.status).toBe(404);
    expect(isServerDegraded()).toBe(false);
    expect(isSessionExpired()).toBe(false);
  });

  it('an unauthenticated read (authed: false) never touches the sessionExpired latch', async () => {
    // Latch sessionExpired via an authed 403 first.
    stubFetchSequence([
      new Response('nope', { status: 403 }),
      new Response('[]', { status: 200 }),
      new Response('nope', { status: 401 }),
      new Response('{}', { status: 200 }),
    ]);
    await coreFetch('/api/positions');
    expect(isSessionExpired()).toBe(true);

    // A public read's 200 must NOT clear it — it says nothing about the session.
    await coreFetch('/api/bots', undefined, { authed: false });
    expect(isSessionExpired()).toBe(true);

    // A public read's 401/403 must NOT set it either (fresh state check below).
    __resetServerHealthForTests();
    await coreFetch('/api/bots', undefined, { authed: false });
    expect(isSessionExpired()).toBe(false);

    // But it still participates in the degraded latch bookkeeping (reachability
    // is session-independent): a 200 resets the consecutive-failure counter.
    await coreFetch('/api/bots', undefined, { authed: false });
    expect(isServerDegraded()).toBe(false);
  });
});
