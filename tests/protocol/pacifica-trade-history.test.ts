import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';

function makeAdapter() {
  const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
  (adapter as any).registry = new SymbolRegistry([
    { internal: 'ZEC-PERP', protocol: 'ZEC', aliases: [] },
  ]);
  (adapter as any).initialized = true;
  return adapter;
}

function trade(overrides: Record<string, unknown> = {}) {
  return {
    history_id: 101,
    order_id: 201,
    client_order_id: 'close-1',
    symbol: 'ZEC',
    amount: '0.94',
    price: '506.72',
    entry_price: '507.50',
    fee: '0.666844',
    pnl: '-0.731805',
    event_type: 'fulfill_taker',
    side: 'close_long',
    created_at: 1_775_000_000_000,
    cause: 'normal',
    ...overrides,
  };
}

function envelope(data: unknown[], nextCursor: string | null, hasMore: boolean): Response {
  return new Response(JSON.stringify({
    success: true,
    data,
    next_cursor: nextCursor,
    has_more: hasMore,
  }), { status: 200 });
}

describe('Pacifica documented trade history authority', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    (pacificaCache as any).inflight.clear();
    (pacificaQuota as any).spends = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('paginates, deduplicates, and maps the incident split close exactly', async () => {
    const adapter = makeAdapter();
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(envelope([
        trade(),
        trade({
          history_id: 102,
          order_id: 202,
          amount: '0.14',
          price: '506.73',
          fee: '0.099319',
          pnl: '-0.107594',
          created_at: 1_775_000_000_001,
        }),
      ], 'page-2', true))
      .mockResolvedValueOnce(envelope([
        trade({
          history_id: 102,
          order_id: 202,
          amount: '0.14',
          price: '506.73',
          fee: '0.099319',
          pnl: '-0.107594',
          created_at: 1_775_000_000_001,
        }),
        trade({
          history_id: 103,
          order_id: 203,
          amount: '0.49',
          price: '506.73',
          fee: '0.347617',
          pnl: '-0.376580',
          created_at: 1_775_000_000_002,
        }),
      ], null, false));

    const result = await adapter.getTradeHistory('account-1', {
      internalSymbol: 'ZEC-PERP',
      startTime: 1_774_999_000_000,
      endTime: 1_775_001_000_000,
      limit: 200,
      maxPages: 10,
      // These generic legacy fields are intentionally unsupported by this
      // direct Pacifica endpoint and must not leak into its query.
      offset: 99,
      subaccountId: 'sub-ignored',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchSpy.mock.calls[0][0]);
    const secondUrl = String(fetchSpy.mock.calls[1][0]);
    expect(firstUrl).toContain('/trades/history?');
    expect(firstUrl).toContain('account=account-1');
    expect(firstUrl).toContain('symbol=ZEC');
    expect(firstUrl).toContain('limit=200');
    expect(firstUrl).not.toContain('offset=');
    expect(firstUrl).not.toContain('subaccount');
    expect(secondUrl).toContain('cursor=page-2');

    expect(result).toHaveLength(3);
    expect(result.reduce((sum, row) => sum + row.size, 0)).toBeCloseTo(1.57, 12);
    expect(result.reduce((sum, row) => sum + row.fee, 0)).toBeCloseTo(1.113780, 12);
    expect(result.reduce((sum, row) => sum + (row.realizedPnl ?? 0), 0)).toBeCloseTo(-1.215979, 12);
    expect(result[0]).toMatchObject({
      tradeId: '101',
      orderId: '201',
      clientOrderId: 'close-1',
      internalSymbol: 'ZEC-PERP',
      side: 'short',
      venueEventKind: 'close_long',
      liquidityRole: 'taker',
      cause: 'normal',
      timestamp: 1_775_000_000_000,
    });
  });

  it('preserves semantic close direction independently from open direction', async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch').mockResolvedValue(envelope([
      trade({ history_id: 1, side: 'open_long' }),
      trade({ history_id: 2, side: 'open_short' }),
      trade({ history_id: 3, side: 'close_long' }),
      trade({ history_id: 4, side: 'close_short' }),
    ], null, false));

    const result = await adapter.getTradeHistory('account-1', { internalSymbol: 'ZEC-PERP' });
    expect(result.map(row => [row.venueEventKind, row.side])).toEqual([
      ['open_long', 'long'],
      ['open_short', 'short'],
      ['close_long', 'short'],
      ['close_short', 'long'],
    ]);
  });

  it.each([
    ['missing cursor', { success: true, data: [trade()], has_more: true }],
    ['non-array data', { success: true, data: {}, has_more: false }],
    ['unknown side', { success: true, data: [trade({ side: 'bid' })], has_more: false }],
    ['invalid amount', { success: true, data: [trade({ amount: '' })], has_more: false }],
    ['invalid timestamp', { success: true, data: [trade({ created_at: 'yesterday' })], has_more: false }],
  ])('fails closed for %s', async (_label, body) => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    await expect(adapter.getTradeHistory('account-1', { internalSymbol: 'ZEC-PERP' })).rejects.toThrow();
  });

  it('treats HTTP failure as unavailable rather than empty history', async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(adapter.getTradeHistory('account-1', { internalSymbol: 'ZEC-PERP' }))
      .rejects.toThrow('404');
  });

  it('fails when the bounded page limit is exhausted', async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(envelope([trade({ history_id: 1 })], 'page-2', true))
      .mockResolvedValueOnce(envelope([trade({ history_id: 2 })], 'page-3', true));
    await expect(adapter.getTradeHistory('account-1', {
      internalSymbol: 'ZEC-PERP',
      maxPages: 2,
    })).rejects.toThrow('exceeded 2 pages');
  });
});
