import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { readCloseSnapshot, type CloseSnapshot } from '../../server/protocol/close-outcome';
import type { ProtocolAdapter } from '../../server/protocol/adapter';

const account = 'EXAMPLE';
const epoch = 1_000_000;
const body = { success: true, error: null, code: null, last_order_id: 2, data: [] };
function adapter() {
  return new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
}
function response() {
  return new Response(JSON.stringify(body), { status: 200 });
}
function snapshot(queueMs: number, requestMs: number): CloseSnapshot {
  return { positions: [], evidence: { account, environment: 'EXAMPLE', requestId: 'EXAMPLE',
    startedAt: epoch, dispatchedAt: epoch + queueMs, receivedAt: epoch + queueMs + requestMs,
    lastOrderId: 2, complete: true, fresh: true, noDedup: true } };
}
function consumer(value: CloseSnapshot) {
  return readCloseSnapshot({ getCloseConfirmationSnapshot: async () => value } as unknown as ProtocolAdapter, account);
}

describe('strict close snapshot queue and freshness budgets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    pacificaCache.invalidateAll();
    Object.assign(pacificaCache, { inflight: new Map() });
    Object.assign(pacificaQuota, { spends: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('accepts a long real quota wait plus fast HTTP through both validators', async () => {
    vi.spyOn(pacificaQuota, 'canAfford').mockImplementation(() => Date.now() >= epoch + 7_500);
    vi.spyOn(pacificaQuota, 'msUntilNextRefund').mockReturnValue(250);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve(response()), 3_500)));
    const read = readCloseSnapshot(adapter(), account);
    await vi.advanceTimersByTimeAsync(7_250);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_750);
    const result = await read;
    expect(result.evidence).toMatchObject({ startedAt: epoch, dispatchedAt: epoch + 7_500, receivedAt: epoch + 11_000 });
    expect(result.positions).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects HTTP older than ten seconds after dispatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve(response()), 10_001)));
    const assertion = expect(readCloseSnapshot(adapter(), account)).rejects.toThrow('invalid_close_envelope:timeout');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    const log = vi.mocked(console.warn).mock.calls[0][0] as string;
    expect(log).toContain('"queueWaitMs":0');
    expect(log).toContain('"requestMs":10001');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts body completion, not just HTTP headers, as receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
      ok: true, status: 200,
      json: () => new Promise(done => setTimeout(() => done(body), 5_001)),
    } as Response), 5_000)));
    const assertion = expect(adapter().getCloseConfirmationSnapshot(account)).rejects.toThrow('invalid_close_envelope:timeout');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it('settles at the overall deadline even if fetch ignores abort and never resolves', async () => {
    const a = adapter();
    let finish!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const assertion = expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('invalid_close_envelope:total_timeout');
    await vi.advanceTimersByTimeAsync(18_000);
    await assertion;
    expect((a as any).closeWatermarks.size).toBe(0);
    // A late completion cannot install accepted close evidence or a watermark.
    finish(response());
    await vi.advanceTimersByTimeAsync(0);
    expect((a as any).closeWatermarks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('"requestMs":18000');
  });

  it('keeps the existing bounded quota rejection without dispatching', async () => {
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(false);
    vi.spyOn(pacificaQuota, 'msUntilNextRefund').mockReturnValue(250);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const assertion = expect(adapter().getCloseConfirmationSnapshot(account)).rejects.toThrow('quota exhausted');
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses dispatch after an event-loop delay overruns the queue budget', async () => {
    vi.spyOn(pacificaQuota, 'canAfford').mockImplementation(() => Date.now() > epoch);
    vi.spyOn(pacificaQuota, 'msUntilNextRefund').mockReturnValue(250);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const assertion = expect(adapter().getCloseConfirmationSnapshot(account)).rejects.toThrow('invalid_close_envelope:queue_timeout');
    vi.setSystemTime(epoch + 8_001);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [7_500, 3_500, true], [8_000, 10_000, true], [0, 10_000, true],
    [8_001, 1, false], [0, 10_001, false], [8_000, 10_001, false],
    [-1, 1, false], [0, -1, false],
  ])('both validators agree for queue=%i request=%i', async (queueMs, requestMs, accepted) => {
    const a = adapter();
    vi.spyOn(a as any, 'get').mockImplementation(async (_path: unknown, _params: unknown, options: any) => {
      vi.setSystemTime(epoch + queueMs);
      options.onDispatch();
      vi.setSystemTime(epoch + queueMs + requestMs);
      return body;
    });
    const direct = a.getCloseConfirmationSnapshot(account);
    if (accepted) await expect(direct).resolves.toMatchObject({ positions: [] });
    else await expect(direct).rejects.toThrow('invalid_close_envelope:');
    vi.setSystemTime(epoch + queueMs + requestMs);
    const checked = consumer(snapshot(queueMs, requestMs));
    if (accepted) await expect(checked).resolves.toMatchObject({ positions: [] });
    else await expect(checked).rejects.toThrow('invalid_close_confirmation_evidence');
  });

  it('rejects completed evidence beyond the total bound even when the timer could not run', async () => {
    const a = adapter();
    vi.spyOn(a as any, 'get').mockImplementation(async (_path: unknown, _params: unknown, options: any) => {
      vi.setSystemTime(epoch + 8_000);
      options.onDispatch();
      vi.setSystemTime(epoch + 18_001);
      return body;
    });
    await expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('invalid_close_envelope:total_timeout');
    await expect(consumer(snapshot(8_000, 10_001))).rejects.toThrow('invalid_close_confirmation_evidence');
  });

  it('retains the second validator receipt-age and finite-timestamp checks', async () => {
    vi.setSystemTime(epoch + 10_002);
    await expect(consumer(snapshot(0, 1))).rejects.toThrow('invalid_close_confirmation_evidence');
    vi.setSystemTime(epoch);
    await expect(consumer(snapshot(0, 1))).rejects.toThrow('invalid_close_confirmation_evidence');
    await expect(consumer(snapshot(Number.NaN, 1))).rejects.toThrow('invalid_close_confirmation_evidence');
  });

  it('logs only integer durations and fixed shape metadata, never envelope values', async () => {
    const a = adapter();
    vi.spyOn(pacificaQuota, 'canAfford').mockImplementation(() => Date.now() >= epoch + 7_500);
    vi.spyOn(pacificaQuota, 'msUntilNextRefund').mockReturnValue(250);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(
      new Response(JSON.stringify({ ...body, success: false, account: 'REDACTED', error: 'CHANGEME', unexpected: 'REDACTED' })),
    ), 3_500)));
    const assertion = expect(a.getCloseConfirmationSnapshot(account)).rejects.toThrow('invalid_close_envelope:success_not_true');
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
    expect(console.warn).toHaveBeenCalledTimes(1);
    const log = vi.mocked(console.warn).mock.calls[0][0] as string;
    expect(log).not.toMatch(/EXAMPLE|REDACTED|CHANGEME|unexpected|\n/);
    const diagnostic = JSON.parse(log.slice(log.indexOf('{')));
    expect(Object.keys(diagnostic).sort()).toEqual(['data_empty', 'envelopeType', 'fields', 'queueWaitMs', 'requestMs']);
    expect(diagnostic.queueWaitMs).toBe(7_500);
    expect(diagnostic.requestMs).toBe(3_500);
    expect(Number.isInteger(diagnostic.queueWaitMs)).toBe(true);
    expect(Number.isInteger(diagnostic.requestMs)).toBe(true);
    for (const field of Object.values(diagnostic.fields)) expect(Object.keys(field as object).sort()).toEqual(['present', 'type']);
  });
});
