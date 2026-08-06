import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';

const openLong = {
  symbol: 'BTC',
  side: 'bid',
  amount: '0.25',
  entry_price: '64000',
  margin: '100',
  funding: '0',
  isolated: false,
  liquidation_price: null,
  created_at: 1,
  updated_at: 2,
};

function makeAdapter() {
  const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
  (adapter as any).registry = new SymbolRegistry([
    { internal: 'BTC-PERP', protocol: 'BTC', aliases: [] },
    { internal: 'ETH-PERP', protocol: 'ETH', aliases: [] },
  ]);
  (adapter as any).initialized = true;
  return adapter;
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}

describe('Pacifica strict close-authority position read', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    (pacificaCache as any).inflight.clear();
    (pacificaQuota as any).spends = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses one fresh /positions request and performs no price or book work', async () => {
    const adapter = makeAdapter();
    const priceSweep = vi.spyOn(adapter, 'getAllPrices');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(ok([openLong]));

    const result = await adapter.getStrictPositionForMarket('account-1', 'BTC-PERP', '4');

    expect(result).toMatchObject({
      internalSymbol: 'BTC-PERP',
      baseSize: 0.25,
      entryPrice: 64000,
      markPrice: 64000,
    });
    expect(priceSweep).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/positions?account=account-1&subaccount_id=4');
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('/book');
  });

  it('ignores a fresh cache entry and uses the newly fetched venue row', async () => {
    const adapter = makeAdapter();
    const key = pacificaCache.buildKey('/positions', {
      account: 'account-1',
      subaccount_id: '4',
    });
    pacificaCache.set(key, '/positions', [{ ...openLong, amount: '9' }]);
    vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ ...openLong, amount: '0.5' }]));

    const result = await adapter.getStrictPositionForMarket('account-1', 'BTC-PERP', '4');

    expect(result?.baseSize).toBe(0.5);
  });

  it('does not join a stale-capable in-flight request for the same account', async () => {
    const adapter = makeAdapter();
    let resolveOrdinary!: (response: Response) => void;
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveOrdinary = resolve;
      }))
      .mockResolvedValueOnce(ok([openLong]));

    const ordinary = (adapter as any).get('/positions', { account: 'account-1' });
    const strict = await adapter.getStrictPositionForMarket('account-1', 'BTC-PERP');

    expect(strict?.baseSize).toBe(0.25);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    resolveOrdinary(ok([]));
    await ordinary;
  });

  it('returns FLAT authority only for a valid fresh array with no matching market', async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch').mockResolvedValue(ok([
      { ...openLong, symbol: 'ETH' },
    ]));

    await expect(
      adapter.getStrictPositionForMarket('account-1', 'BTC-PERP'),
    ).resolves.toBeNull();
  });

  it('does not let malformed semantics on an identified unrelated market block a clean target close', async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch').mockResolvedValue(ok([
      {
        ...openLong,
        symbol: 'ETH',
        side: 'invalid',
        amount: '',
        entry_price: '',
      },
      openLong,
    ]));

    await expect(
      adapter.getStrictPositionForMarket('account-1', 'BTC-PERP'),
    ).resolves.toMatchObject({
      internalSymbol: 'BTC-PERP',
      baseSize: 0.25,
    });
  });

  it.each([
    ['non-array', { symbol: 'BTC' }],
    ['malformed row', [null]],
    ['duplicate rows', [openLong, openLong]],
    ['invalid side', [{ ...openLong, side: 'long' }]],
    ['blank amount', [{ ...openLong, amount: '' }]],
    ['negative amount', [{ ...openLong, amount: '-1' }]],
    ['blank entry', [{ ...openLong, entry_price: '' }]],
    ['zero entry on open position', [{ ...openLong, entry_price: '0' }]],
  ])('fails closed for %s', async (_label, payload) => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch').mockResolvedValue(ok(payload));

    await expect(
      adapter.getStrictPositionForMarket('account-1', 'BTC-PERP'),
    ).rejects.toThrow();
  });

  it('does not serve stale position data when upstream returns 429', async () => {
    const adapter = makeAdapter();
    const key = pacificaCache.buildKey('/positions', { account: 'account-1' });
    pacificaCache.set(key, '/positions', [openLong]);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );

    await expect(
      adapter.getStrictPositionForMarket('account-1', 'BTC-PERP'),
    ).rejects.toThrow('429');
  });

  it('fails after the bounded quota wait instead of serving stale data', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(false);
    vi.spyOn(pacificaQuota, 'msUntilNextRefund').mockReturnValue(250);
    const fetchSpy = vi.spyOn(global, 'fetch');

    const read = adapter.getStrictPositionForMarket('account-1', 'BTC-PERP');
    const assertion = expect(read).rejects.toThrow('quota exhausted');
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
