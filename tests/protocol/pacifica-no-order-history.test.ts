import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';
import { closeResultFromObservation, qualifiedFlatObservation, readCloseSnapshot, type CloseSnapshot } from '../../server/protocol/close-outcome';

const account = 'EXAMPLE_ACCOUNT';
const row = { symbol: 'BTC', side: 'bid', amount: '1', entry_price: '100', li: 1 };
function adapter() {
  const value = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
  Object.assign(value, { initialized: true, registry: new SymbolRegistry([
    { internal: 'BTC-PERP', protocol: 'BTC', aliases: [] },
  ]) });
  return value;
}
function response(fields: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: true, error: null, code: null, data: [], ...fields }), { status: 200 });
}
function snapshot(lastOrderId: number | null, requestId: string): CloseSnapshot {
  const now = Date.now();
  return { positions: [], evidence: { account, environment: 'EXAMPLE', requestId,
    startedAt: now, dispatchedAt: now, receivedAt: now, lastOrderId,
    complete: true, fresh: true, noDedup: true } };
}

describe('Pacifica no order history', () => {
  beforeEach(() => {
    pacificaCache.invalidateAll();
    Object.assign(pacificaCache, { inflight: new Map() });
    Object.assign(pacificaQuota, { spends: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('accepts first and repeated empty omissions without inventing a numeric watermark', async () => {
    const a = adapter();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
    const first = await readCloseSnapshot(a, account);
    const second = await readCloseSnapshot(a, account);
    expect(first.positions).toEqual([]);
    expect(first.evidence.lastOrderId).toBeNull();
    expect(second.evidence.lastOrderId).toBeNull();
    expect(second.evidence.requestId).not.toBe(first.evidence.requestId);
    expect(qualifiedFlatObservation(account, undefined, first, second, first.evidence.receivedAt)).toBe(false);
    expect(qualifiedFlatObservation(account, undefined, first, second, first.evidence.receivedAt, 'empty-account')).toBe(true);
  });

  it.each([0, 2])('never accepts an omission after numeric watermark %s, including after an intervening failure', async numeric => {
    const a = adapter();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ last_order_id: numeric }))
      .mockResolvedValueOnce(response({ success: false })).mockImplementation(async () => response());
    expect((await a.getCloseConfirmationSnapshot(account)).evidence.lastOrderId).toBeNull();
    expect((await a.getCloseConfirmationSnapshot(account)).evidence.lastOrderId).toBe(numeric);
    await expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('success_not_true');
    await expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('watermark_regressed');
    expect((await a.getCloseConfirmationSnapshot('EXAMPLE_OTHER')).evidence.lastOrderId).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([
    { data: [row] }, { data: [{ ...row, amount: '0' }] }, { last_order_id: null },
    { last_order_id: '0' }, { last_order_id: '2' }, { data: null },
    { success: false }, { error: undefined }, { code: undefined },
    { account: 'EXAMPLE_OTHER' }, { subaccount_id: null },
    ...['has_more', 'next_cursor', 'cursor', 'next_page', 'pagination', 'truncated', 'limit', 'offset'].map(key => ({ [key]: true })),
  ])('retains every other envelope predicate for omitted watermarks %#', async fields => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(fields));
    await expect(adapter().getCloseConfirmationSnapshot(account)).rejects.toThrow('invalid_close_envelope');
  });

  it('distinguishes an own undefined property from absence', async () => {
    const a = adapter();
    vi.spyOn(a as any, 'get').mockImplementation(async (_path, _params, options: any) => {
      options.onDispatch();
      return { success: true, error: null, code: null, data: [], last_order_id: undefined };
    });
    await expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('last_order_id_type');
  });

  it('does not install a numeric watermark from a rejected envelope', async () => {
    const a = adapter();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ last_order_id: 2, has_more: true }))
      .mockResolvedValueOnce(response());
    await expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('pagination');
    expect((await a.getCloseConfirmationSnapshot(account)).evidence.lastOrderId).toBeNull();
  });

  it('rejects an older in-flight omission after a numeric observation completes', async () => {
    const a = adapter();
    let release!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(response({ last_order_id: 2 }));
    const pending = a.getCloseConfirmationSnapshot(account);
    await a.getCloseConfirmationSnapshot(account);
    release(response());
    await expect(pending).rejects.toThrow('watermark_regressed');
  });

  it.each([[null, null], [null, 2], [2, null]] as const)('never confirms a submitted close from %s to %s', (beforeId, afterId) => {
    const baseline = snapshot(beforeId, 'EXAMPLE_BEFORE');
    const after = snapshot(afterId, 'EXAMPLE_AFTER');
    if (beforeId !== null) baseline.positions = [{ internalSymbol: 'BTC-PERP', baseSize: 1 } as any];
    expect(closeResultFromObservation({ account, market: 'BTC-PERP', baseline, after,
      settledAt: baseline.evidence.receivedAt }).outcome).toBe('unknown');
    expect(qualifiedFlatObservation(account, undefined, baseline, after, baseline.evidence.receivedAt)).toBe(false);
  });

  it.each(['nonempty', 'old', 'same-request', 'wrong-account', 'regression'] as const)(
    'empty-account teardown still rejects %s evidence', defect => {
      const baseline = snapshot(null, 'EXAMPLE_BEFORE');
      const after = snapshot(null, 'EXAMPLE_AFTER');
      if (defect === 'nonempty') after.positions = [{ internalSymbol: 'BTC-PERP', baseSize: 0 } as any];
      if (defect === 'old') after.evidence.startedAt = baseline.evidence.receivedAt - 1;
      if (defect === 'same-request') after.evidence.requestId = baseline.evidence.requestId;
      if (defect === 'wrong-account') after.evidence.account = 'EXAMPLE_OTHER';
      if (defect === 'regression') baseline.evidence.lastOrderId = 0;
      expect(qualifiedFlatObservation(account, undefined, baseline, after, baseline.evidence.receivedAt, 'empty-account')).toBe(false);
    },
  );
});
