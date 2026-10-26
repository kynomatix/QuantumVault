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

// Each row changes one predicate of an otherwise valid response.
describe('strict close envelope diagnostics', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    Object.assign(pacificaCache, { inflight: new Map() });
    Object.assign(pacificaQuota, { spends: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['success_not_true', { success: false }],
    ['success_not_true', { success: undefined }],
    ['error_not_null', { error: 'EXAMPLE_BODY' }],
    ['error_not_null', { error: undefined }],
    ['code_not_null', { code: 0 }],
    ['code_not_null', { code: undefined }],
    ['data_not_array', { data: null }],
    ['data_not_array', { data: {} }],
    ['data_not_array', { data: undefined }],
    ['last_order_id_type', { last_order_id: undefined }],
    ['last_order_id_type', { last_order_id: null }],
    ['last_order_id_type', { last_order_id: '2' }],
    ['last_order_id_type', { last_order_id: '02' }],
    ['last_order_id_type', { last_order_id: '9007199254740992' }],
    ['last_order_id_type', { last_order_id: true }],
    ['last_order_id_unsafe', { last_order_id: 1.5 }],
    ['last_order_id_unsafe', { last_order_id: Number.MAX_SAFE_INTEGER + 1 }],
    ['last_order_id_negative', { last_order_id: -1 }],
    ['account_mismatch', { account: 'EXAMPLE_WRONG' }],
    ['subaccount_scope', { subaccount_id: null }],
  ] as const)('reports %s for isolated defect %#', async (reason, fields) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([], fields));
    await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow(
      new Error(`invalid_close_envelope:${reason}`),
    );
    expect(console.warn).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(console.warn).mock.calls;
    expect(calls[0]).toHaveLength(1);
    const line = calls[0][0] as string;
    const prefix = `[Pacifica] invalid_close_envelope:${reason} `;
    expect(line.startsWith(prefix)).toBe(true);
    expect(line).not.toMatch(/[\r\n]/);
    const diagnostics = JSON.parse(line.slice(prefix.length));
    expect(typeof diagnostics.data_empty).toBe('boolean');
    expect(diagnostics.fields.last_order_id.type).toBe(typeof ('last_order_id' in fields ? fields.last_order_id : 2));
  });

  it.each([
    ['body_null', null], ['body_array', []], ['body_type', false], ['body_type', 'EXAMPLE_BODY'],
  ] as const)('reports %s for invalid body %#', async (reason, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow(
      new Error(`invalid_close_envelope:${reason}`),
    );
  });

  it.each(['has_more', 'next_cursor', 'cursor', 'next_page', 'pagination', 'truncated', 'limit', 'offset'])(
    'rejects pagination field %s without exposing its value', async field => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([], { [field]: 'EXAMPLE_CURSOR' }));
      await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow('invalid_close_envelope:pagination');
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('EXAMPLE_CURSOR');
    },
  );

  it.each([0, Number.MAX_SAFE_INTEGER])('retains numeric boundary %s and absent/null/false pagination', async last_order_id => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([], {
      last_order_id, has_more: false, cursor: null, offset: undefined,
    }));
    expect((await adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).evidence.lastOrderId).toBe(last_order_id);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reports missing dispatch callback', async () => {
    const a = adapter();
    vi.spyOn(a as any, 'get').mockResolvedValue({ success: true, error: null, code: null, last_order_id: 2, data: [] });
    await expect(a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow('invalid_close_envelope:dispatch_missing');
  });

  it.each([10_000, 10_001])('retains the elapsed-time boundary at %s ms', async elapsed => {
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      time.mockReturnValue(now + elapsed);
      return response();
    });
    const read = adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT');
    if (elapsed > 10_000) await expect(read).rejects.toThrow('invalid_close_envelope:timeout');
    else expect((await read).evidence.lastOrderId).toBe(2);
  });

  it('reports regression without advancing or poisoning the accepted watermark', async () => {
    const a = adapter();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([], { last_order_id: 4 }))
      .mockResolvedValueOnce(response([], { last_order_id: 99, error: 'EXAMPLE_BODY' }))
      .mockResolvedValueOnce(response([], { last_order_id: 3 }))
      .mockResolvedValueOnce(response([], { last_order_id: 4 }));
    await a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT');
    await expect(a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow('invalid_close_envelope:error_not_null');
    await expect(a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow('invalid_close_envelope:watermark_regressed');
    expect((await a.getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).evidence.lastOrderId).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(4);
  });


  it.each([
    [[], true], [[{ secret: 'REDACTED' }], false], [null, false], [{}, false], [undefined, false], ['', false],
  ])('prints data_empty safely for data %#', async (data, empty) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([], { data, last_order_id: null }));
    await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow('invalid_close_envelope:');
    const call = vi.mocked(console.warn).mock.calls[0];
    expect(call).toHaveLength(1);
    const line = call[0] as string;
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toContain('REDACTED');
    const diagnostics = JSON.parse(line.slice(line.indexOf(' {') + 1));
    expect(diagnostics.data_empty).toBe(empty);
    expect(diagnostics.fields.last_order_id).toEqual({ present: true, type: 'object' });
  });

  it('emits only allowlisted field presence and JS types, never body, account or key values', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([], {
      error: 'EXAMPLE_BODY', account: 'EXAMPLE_WRONG', secret: 'EXAMPLE_KEY',
      code: undefined, next_cursor: 'EXAMPLE_CURSOR', EXAMPLE_UNEXPECTED_FIELD: 'EXAMPLE_VALUE',
    }));
    await expect(adapter().getCloseConfirmationSnapshot('EXAMPLE_ACCOUNT')).rejects.toThrow(
      new Error('invalid_close_envelope:error_not_null'),
    );
    const calls = vi.mocked(console.warn).mock.calls;
    const fieldNames = ['success', 'error', 'code', 'data', 'last_order_id', 'account', 'subaccount_id',
      'has_more', 'next_cursor', 'cursor', 'next_page', 'pagination', 'truncated', 'limit', 'offset'];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    const line = calls[0][0] as string;
    expect(line).not.toMatch(/[\r\n]/);
    const diagnostics = JSON.parse(line.slice(line.indexOf(' {') + 1));
    expect(Object.keys(diagnostics)).toEqual(['envelopeType', 'data_empty', 'fields']);
    expect(diagnostics.data_empty).toBe(true);
    expect(diagnostics.fields.last_order_id).toEqual({ present: true, type: 'number' });
    expect(diagnostics.envelopeType).toBe('object');
    expect(Object.keys(diagnostics.fields)).toEqual(fieldNames);
    expect(diagnostics.fields.error).toEqual({ present: true, type: 'string' });
    expect(diagnostics.fields.code).toEqual({ present: false, type: 'undefined' });
    expect(diagnostics.fields.account).toEqual({ present: true, type: 'string' });
    expect(diagnostics.fields.data).toEqual({ present: true, type: 'object' });
    for (const field of Object.values(diagnostics.fields) as Array<{ present: boolean; type: string }>) {
      expect(Object.keys(field)).toEqual(['present', 'type']);
      expect(typeof field.present).toBe('boolean');
      expect(['undefined', 'object', 'boolean', 'number', 'string']).toContain(field.type);
    }
    const logged = JSON.stringify([calls, error.mock.calls, log.mock.calls, info.mock.calls, debug.mock.calls]);
    for (const value of ['EXAMPLE_ACCOUNT', 'EXAMPLE_WRONG', 'EXAMPLE_BODY', 'EXAMPLE_KEY', 'EXAMPLE_CURSOR',
      'EXAMPLE_UNEXPECTED_FIELD', 'EXAMPLE_VALUE']) expect(logged).not.toContain(value);
  });
});
