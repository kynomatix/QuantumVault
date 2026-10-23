import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';
import { closeResultFromObservation } from '../../server/protocol/close-outcome';

function adapter() {
  const value = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
  Object.assign(value, { initialized: true, registry: new SymbolRegistry([
    { internal: 'BTC-PERP', protocol: 'BTC', aliases: [] },
  ]) });
  return value;
}
const row = { symbol: 'BTC', side: 'bid', amount: '1', entry_price: '100', li: 1 };
function response(data: unknown = [], fields: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: true, error: null, code: null, last_order_id: 2, data, ...fields }), { status: 200 });
}
describe('strict Pacifica close confirmation through real HTTP transport', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    Object.assign(pacificaCache, { inflight: new Map() });
    Object.assign(pacificaQuota, { spends: [] });
  });
  afterEach(() => vi.restoreAllMocks());
  it('requires independent post-settlement flatness with an advancing watermark', async () => {
    const a = adapter();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row], { last_order_id: 1 }))
      .mockResolvedValueOnce(response());
    const baseline = await a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT');
    const settledAt = Date.now();
    const after = await a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT');
    expect(closeResultFromObservation({ account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP', baseline, after, settledAt }).outcome).toBe('confirmed');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toContain('/positions?account=EXAMPLE_ACCOUNT');
    expect(baseline.evidence.requestId).not.toBe(after.evidence.requestId);
  });
  it.each([404, 500])('does not turn HTTP %s into flatness', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
    await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow();
  });
  it.each([
    { success: false }, { error: 'EXAMPLE' }, { code: 0 }, { data: {} }, { data: null },
    { last_order_id: undefined }, { last_order_id: -1 }, { last_order_id: Number.MAX_SAFE_INTEGER + 1 },
    { account: 'EXAMPLE_WRONG' }, { subaccount_id: '1' }, { has_more: true }, { next_cursor: 'EXAMPLE' },
    { data: [row, row] }, { data: [{ ...row, amount: undefined }] }, { data: [{ ...row, amount: 'NaN' }] },
    { data: [{ ...row, amount: '' }] }, { data: [{ ...row, amount: '-1' }] },
    { data: [{ ...row, amount: '1x' }] }, { data: [{ ...row, amount: '1e-999' }] },
    { data: [{ ...row, side: 'long' }] }, { data: [{ ...row, symbol: 'BTC-PERP' }] },
    { data: [{ ...row, symbol: 'EXAMPLE_UNKNOWN' }] }, { data: [{ ...row, account: 'EXAMPLE_WRONG' }] },
    { data: [{ ...row, li: 3 }] },
  ])('rejects malformed or ambiguous inventory %#', async fields => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([], fields));
    await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow();
  });
  it('rejects a regressed watermark and does not share concurrent reads', async () => {
    const a = adapter();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
    const [first, second] = await Promise.all([a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT'), a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.evidence.requestId).not.toBe(second.evidence.requestId);
    fetch.mockResolvedValue(response([], { last_order_id: 1 }));
    await expect(a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow();
  });
  it('preserves the default reader 404 contract while rejecting missing and NaN amounts', async () => {
    const a = adapter();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await a.getPositions('EXAMPLE_ACCOUNT')).toEqual([]);
    for (const amount of [undefined, 'NaN', '']) {
      pacificaCache.invalidateAll();
      fetch.mockImplementation(async () => response([{ ...row, amount }]));
      await expect(a.getPositions('EXAMPLE_ACCOUNT')).rejects.toThrow('invalid_position_amount');
    }
  });
  it.each(['residual', 'unchanged', 'wrong-account', 'old-read', 'reused-read'] as const)('refuses %s evidence', async defect => {
    const a = adapter();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row], { last_order_id: 1 })).mockResolvedValueOnce(response());
    const baseline = await a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT');
    const settledAt = Date.now();
    const after = await a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT');
    if (defect === 'residual') after.positions = [{ ...baseline.positions[0], baseSize: 0.00000001 }];
    if (defect === 'unchanged') after.evidence.lastOrderId = 1;
    if (defect === 'wrong-account') after.evidence.account = 'EXAMPLE_WRONG';
    if (defect === 'old-read') after.evidence.startedAt = settledAt - 1;
    if (defect === 'reused-read') after.evidence.requestId = baseline.evidence.requestId;
    expect(closeResultFromObservation({ account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP', baseline, after, settledAt }).outcome).not.toBe('confirmed');
  });
});
