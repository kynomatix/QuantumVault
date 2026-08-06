import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';
import type { MarketOrderParams, ProtocolPosition } from '../../server/protocol/protocol-types';

const ACCOUNT = 'PacificaLeverageAccount111111111111111111111';
const SECRET = new Uint8Array(64);
const OPEN_ERROR = 'LDO-PERP position is already open; requested lower leverage cannot be applied while open; no leverage update or order was attempted';
const UNVERIFIED_ERROR = 'LDO-PERP position state could not be verified before applying lower leverage; no leverage update or order was attempted';

type EventLog = string[];

function marginSetting(leverage: unknown, symbol = 'LDO') {
  return {
    symbol,
    isolated: false,
    leverage,
    created_at: 1,
    updated_at: 2,
  };
}

function settingsData(rows: unknown[]) {
  return {
    auto_lend_disabled: null,
    margin_settings: rows,
    spot_settings: [],
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}

function openPosition() {
  return {
    symbol: 'LDO',
    side: 'ask',
    amount: '77',
    entry_price: '0.3764',
    margin: '10',
    funding: '0',
    isolated: false,
    liquidation_price: null,
    created_at: 1,
    updated_at: 2,
  };
}

function orderParams(overrides: Partial<MarketOrderParams> = {}): MarketOrderParams {
  return {
    agentPublicKey: ACCOUNT,
    agentSecretKey: SECRET,
    mainWalletAddress: 'MainWallet111111111111111111111111111111111',
    internalSymbol: 'LDO-PERP',
    side: 'short',
    sizeBase: 77,
    reduceOnly: false,
    subaccountId: '4',
    leverage: 8,
    ...overrides,
  };
}

function makeAdapter(events: EventLog = []) {
  const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' }) as any;
  adapter.registry = new SymbolRegistry([
    { internal: 'LDO-PERP', protocol: 'LDO', aliases: [] },
    { internal: 'BTC-PERP', protocol: 'BTC', aliases: [] },
  ]);
  adapter.initialized = true;
  adapter.ensurePacificaEnrollment = vi.fn(async () => ({
    builderApproved: false,
    referralClaimed: false,
  }));
  adapter.quantizeOrderSize = vi.fn((_symbol: string, size: number) => size);
  adapter.quantizeOrderSizeCeil = vi.fn((_symbol: string, size: number) => size);
  adapter.mapOrderResponse = vi.fn(() => ({ success: true, status: 'filled', orderId: 'order-1' }));
  const post = vi.fn(async (path: string) => {
    events.push(`POST ${path}`);
    if (path === '/account/leverage') return { success: true };
    if (path === '/orders/create_market') return { order_id: 'order-1', status: 'filled' };
    throw new Error(`unexpected POST ${path}`);
  });
  adapter.post = post;
  return { adapter: adapter as PacificaAdapter, post };
}

function recordFetch(events: EventLog, resolver: (url: URL) => Promise<Response> | Response) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    events.push(`GET ${url.pathname}`);
    return resolver(url);
  });
}

describe('Pacifica leveraged market-order admission', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    (pacificaCache as any).inflight.clear();
    (pacificaQuota as any).spends = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_type: string, data: Record<string, unknown>, account: string) => ({
        ...data,
        account,
        agent_wallet: null,
        signature: 'test-signature',
        timestamp: 1,
        expiry_window: 30_000,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('unwraps the real settings envelope and omits only an exactly redundant update', async () => {
    const events: EventLog = [];
    const { adapter, post } = makeAdapter(events);
    const fetchSpy = recordFetch(events, (url) => {
      expect(url.searchParams.get('account')).toBe(ACCOUNT);
      expect(url.searchParams.get('subaccount_id')).toBe('4');
      return ok(settingsData([marginSetting(8)]));
    });

    await expect(adapter.placeMarketOrder(orderParams())).resolves.toMatchObject({ success: true });

    expect(events).toEqual([
      'GET /account/settings',
      'POST /orders/create_market',
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalledWith('/account/leverage', expect.anything());
  });

  it('keeps update-before-order when the current setting is lower', async () => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    recordFetch(events, () => ok(settingsData([marginSetting(5)])));

    await adapter.placeMarketOrder(orderParams());

    expect(events).toEqual([
      'GET /account/settings',
      'POST /account/leverage',
      'POST /orders/create_market',
    ]);
  });

  it('uses strict requested-market authority before lowering a proven-flat market', async () => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    recordFetch(events, (url) => {
      if (url.pathname === '/account/settings') return ok(settingsData([marginSetting(10)]));
      if (url.pathname === '/positions') return ok([]);
      throw new Error(`unexpected GET ${url.pathname}`);
    });

    await adapter.placeMarketOrder(orderParams());

    expect(events).toEqual([
      'GET /account/settings',
      'GET /positions',
      'POST /account/leverage',
      'POST /orders/create_market',
    ]);
  });

  it('refuses a lower-leverage entry when the requested market is proven open', async () => {
    const events: EventLog = [];
    const { adapter, post } = makeAdapter(events);
    recordFetch(events, (url) => {
      if (url.pathname === '/account/settings') return ok(settingsData([marginSetting(10)]));
      if (url.pathname === '/positions') return ok([openPosition()]);
      throw new Error(`unexpected GET ${url.pathname}`);
    });

    await expect(adapter.placeMarketOrder(orderParams())).rejects.toThrow(OPEN_ERROR);

    expect(events).toEqual(['GET /account/settings', 'GET /positions']);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['failed position read', new Response('unavailable', { status: 500 })],
    ['malformed position response', ok({ symbol: 'LDO' })],
  ])('refuses without claiming open for %s', async (_label, positionResponse) => {
    const events: EventLog = [];
    const { adapter, post } = makeAdapter(events);
    recordFetch(events, (url) => (
      url.pathname === '/account/settings'
        ? ok(settingsData([marginSetting(10)]))
        : positionResponse
    ));

    await expect(adapter.placeMarketOrder(orderParams())).rejects.toThrow(UNVERIFIED_ERROR);

    expect(events).toEqual(['GET /account/settings', 'GET /positions']);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a non-finite returned position without claiming it is open', async () => {
    const events: EventLog = [];
    const { adapter, post } = makeAdapter(events);
    recordFetch(events, () => ok(settingsData([marginSetting(10)])));
    vi.spyOn(adapter, 'getStrictPositionForMarket').mockResolvedValue({
      internalSymbol: 'LDO-PERP',
      baseSize: Number.NaN,
      entryPrice: 1,
      markPrice: 1,
      unrealizedPnl: 0,
      leverage: 1,
      liquidationPrice: null,
      marginMode: 'cross',
    } satisfies ProtocolPosition);

    await expect(adapter.placeMarketOrder(orderParams())).rejects.toThrow(UNVERIFIED_ERROR);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['post-unwrap array', [marginSetting(8)]],
    ['missing margin_settings', { auto_lend_disabled: null, spot_settings: [] }],
    ['non-array margin_settings', { margin_settings: { symbol: 'LDO', leverage: 8 } }],
    ['unclassifiable row', settingsData([null])],
    ['blank symbol', settingsData([marginSetting(8, ' ')])],
    ['missing requested symbol', settingsData([marginSetting(8, 'BTC')])],
    ['duplicate requested symbol', settingsData([marginSetting(8), marginSetting(8)])],
    ['blank leverage', settingsData([marginSetting('')])],
    ['fractional leverage', settingsData([marginSetting(8.5)])],
    ['unsafe leverage', settingsData([marginSetting(Number.MAX_SAFE_INTEGER + 1)])],
    ['zero leverage', settingsData([marginSetting(0)])],
  ])('does not suppress the update for %s', async (_label, data) => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    recordFetch(events, () => ok(data));

    await adapter.placeMarketOrder(orderParams());

    expect(events).toEqual([
      'GET /account/settings',
      'POST /account/leverage',
      'POST /orders/create_market',
    ]);
  });

  it('preserves the leverage gate when the strict settings read fails', async () => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    recordFetch(events, () => new Response('unavailable', { status: 500 }));

    await adapter.placeMarketOrder(orderParams());

    expect(events).toEqual([
      'GET /account/settings',
      'POST /account/leverage',
      'POST /orders/create_market',
    ]);
  });

  it('never sends the order when the preserved leverage update rejects', async () => {
    const events: EventLog = [];
    const { adapter, post } = makeAdapter(events);
    recordFetch(events, () => ok(settingsData([marginSetting(5)])));
    post.mockImplementation(async (path: string) => {
      events.push(`POST ${path}`);
      if (path === '/account/leverage') throw new Error('InvalidLeverage(8)');
      return { order_id: 'must-not-run', status: 'filled' };
    });

    await expect(adapter.placeMarketOrder(orderParams())).rejects.toThrow('InvalidLeverage(8)');
    expect(events).toEqual(['GET /account/settings', 'POST /account/leverage']);
  });

  it('does not serve exact stale settings on upstream HTTP 429', async () => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    const key = pacificaCache.buildKey('/account/settings', {
      account: ACCOUNT,
      subaccount_id: '4',
    });
    pacificaCache.set(key, '/account/settings', settingsData([marginSetting(8)]));
    recordFetch(events, () => new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
    }));

    await adapter.placeMarketOrder(orderParams());

    expect(events).toEqual([
      'GET /account/settings',
      'POST /account/leverage',
      'POST /orders/create_market',
    ]);
  });

  it('does not serve exact stale settings after the bounded local quota wait', async () => {
    vi.useFakeTimers();
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    const key = pacificaCache.buildKey('/account/settings', {
      account: ACCOUNT,
      subaccount_id: '4',
    });
    pacificaCache.set(key, '/account/settings', settingsData([marginSetting(8)]));
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(false);
    vi.spyOn(pacificaQuota, 'msUntilNextRefund').mockReturnValue(250);
    const fetchSpy = vi.spyOn(global, 'fetch');

    const placed = adapter.placeMarketOrder(orderParams());
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(placed).resolves.toMatchObject({ success: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      'POST /account/leverage',
      'POST /orders/create_market',
    ]);
  });

  it('does not join a stale-permitted settings producer', async () => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    let resolveOrdinary!: (response: Response) => void;
    const fetchSpy = recordFetch(events, () => {
      if (!resolveOrdinary) {
        return new Promise<Response>((resolve) => { resolveOrdinary = resolve; });
      }
      return ok(settingsData([marginSetting(8)]));
    });

    const params = { account: ACCOUNT, subaccount_id: '4' };
    const ordinary = (adapter as any).get('/account/settings', params);
    await adapter.placeMarketOrder(orderParams());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      'GET /account/settings',
      'GET /account/settings',
      'POST /orders/create_market',
    ]);
    resolveOrdinary(ok(settingsData([])));
    await ordinary;
  });

  it('retains ordinary stale fallback outside fresh-required mode', async () => {
    const { adapter } = makeAdapter();
    const params = { account: ACCOUNT, subaccount_id: '4' };
    const key = pacificaCache.buildKey('/account/settings', params);
    const stale = settingsData([marginSetting(8)]);
    pacificaCache.set(key, '/account/settings', stale);
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(false);
    const fetchSpy = vi.spyOn(global, 'fetch');

    await expect(
      (adapter as any).get('/account/settings', params, { bypassCache: true }),
    ).resolves.toEqual(stale);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps reduce-only orders independent of settings and leverage', async () => {
    const events: EventLog = [];
    const { adapter } = makeAdapter(events);
    const fetchSpy = vi.spyOn(global, 'fetch');

    await adapter.placeMarketOrder(orderParams({ reduceOnly: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events).toEqual(['POST /orders/create_market']);
  });
});
