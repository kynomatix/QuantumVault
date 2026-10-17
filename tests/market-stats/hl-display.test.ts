import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('read-only Hyperliquid display adapter', () => {
  const fetchMock = vi.fn();
  const body = (funding: unknown = '0', openInterest: unknown = '0') => [
    { universe: [{ name: 'BTC' }] },
    [{ funding, openInterest, dayNtlVlm: '100', premium: '0', oraclePx: '100', markPx: '100' }],
  ];
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
    fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('retains the raw capture time and does not append participation history', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => body() });
    const api = await import('../../server/ai-trader/hl-context');
    const first = await api.fetchHlDisplaySnapshot('BTC-PERP');
    expect(first).toEqual({ fundingRate: 0, openInterest: 0, fetchedAt: Date.now() });
    vi.setSystemTime(Date.now() + 1_000);
    expect(await api.fetchHlDisplaySnapshot('BTC-PERP')).toEqual(first);
    const participation = await api.getHlParticipationSnapshot('BTC-PERP');
    expect(participation?.openInterestDeltaPct).toBeNull();
    expect(participation?.fundingTrajectory).toEqual([0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([['', '10'], [null, '10'], ['NaN', '10'], ['0', '-1'], ['0', undefined]])(
    'rejects malformed funding/OI instead of fabricating zero (%s, %s)', async (funding, oi) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => body(funding, oi === undefined ? null : oi) });
      const api = await import('../../server/ai-trader/hl-context');
      expect(await api.fetchHlDisplaySnapshot('BTC-PERP')).toBeNull();
    });
});
