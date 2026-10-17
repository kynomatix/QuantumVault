import { describe, expect, it, vi } from 'vitest';
import { loadOkxLiquidationHistory } from '../../server/market-stats/liquidations-okx';
import { HOUR, LIQUIDATION_DAY } from '../../server/market-stats/liquidations-model';
import { getLiquidationStats, LiquidationStatsCache } from '../../server/market-stats/liquidations-service';
import { END, fullInputs } from './liquidations-fixtures';

function historyFetch(change: (rows: string[][], page: number) => string[][] = r => r) {
  const urls: URL[] = [], signals: AbortSignal[] = [];
  const rows = Array.from({ length: 1080 }, (_, i) => [String(END - (i + 1) * 4 * HOUR), '100', '102', '98', '101', '0', '0', '0', '1']);
  const fetcher = vi.fn(async (raw: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(raw)); urls.push(url); signals.push(init!.signal!);
    const page = rows.filter(r => Number(r[0]) < Number(url.searchParams.get('after'))).slice(0, 100);
    return new Response(JSON.stringify({ code: '0', data: change(page, urls.length) }));
  }) as unknown as typeof fetch;
  return { fetcher, urls, signals };
}

describe('display-only 180-day OKX 4H history', () => {
  it('paginates confirmed UTC bars for the same instrument within the 100-row limit and deadline', async () => {
    const { fetcher, urls, signals } = historyFetch();
    const candles = await loadOkxLiquidationHistory(END + 23 * HOUR, fetcher);
    expect(candles).toHaveLength(1080); expect(urls).toHaveLength(11);
    expect(candles[0].time).toBe(END - 180 * LIQUIDATION_DAY); expect(candles.at(-1)!.time).toBe(END - 4 * HOUR);
    candles.forEach((c, i) => { expect(c.time % (4 * HOUR)).toBe(0); if (i) expect(c.time - candles[i - 1].time).toBe(4 * HOUR); });
    urls.forEach((url, i) => {
      expect(url.pathname).toBe('/api/v5/market/history-candles'); expect(url.searchParams.get('instId')).toBe('BTC-USDT-SWAP');
      expect(url.searchParams.get('bar')).toBe('4H'); expect(url.searchParams.get('limit')).toBe('100');
      expect(Number(url.searchParams.get('after'))).toBe(END - i * 100 * 4 * HOUR);
      expect(signals[i]).toBeInstanceOf(AbortSignal); expect(signals[i].aborted).toBe(false);
    });
  });
  it.each(['unaligned', 'unconfirmed', 'duplicate', 'gap', 'stuck', 'prices', 'short', 'empty'] as const)('rejects %s history instead of inventing candles', async kind => {
    const { fetcher } = historyFetch((rows, page) => {
      if (page !== 1) return rows;
      if (kind === 'empty') return [];
      if (kind === 'unaligned') rows[0][0] = String(END - HOUR);
      if (kind === 'unconfirmed') rows[0][8] = '0';
      if (kind === 'duplicate') rows[1] = [...rows[0]];
      if (kind === 'gap') rows.splice(12, 1);
      if (kind === 'stuck') rows[0][0] = String(END);
      if (kind === 'prices') rows[0][2] = '90';
      if (kind === 'short') rows[0] = rows[0].slice(0, 5);
      return rows;
    });
    await expect(loadOkxLiquidationHistory(END, fetcher)).rejects.toThrow();
  });
  it.each(['http', 'code', 'oversized', 'timeout', 'body-aborted'] as const)('rejects %s provider failures', async kind => {
    const fetcher = vi.fn(async (_url, init) => {
      if (kind === 'timeout') throw new DOMException('deadline', 'TimeoutError');
      if (kind === 'http') return new Response('', { status: 429 });
      if (kind === 'oversized') return new Response(' '.repeat(256001));
      if (kind === 'body-aborted') return new Response(new ReadableStream({ start(c) {
        expect(init.signal).toBeInstanceOf(AbortSignal); c.error(new DOMException('deadline during body', 'AbortError'));
      } }));
      return new Response(JSON.stringify({ code: '500', data: [] }));
    }) as unknown as typeof fetch;
    await expect(loadOkxLiquidationHistory(END, fetcher)).rejects.toThrow();
  });
});

describe('history shares the existing daily heatmap cache', () => {
  it('coalesces history requests, refreshes on UTC rollover and keeps model output unchanged', async () => {
    let now = END + HOUR;
    const loadHistory = vi.fn(async (at: number) => [{ time: Math.floor(at / LIQUIDATION_DAY) * LIQUIDATION_DAY - 180 * LIQUIDATION_DAY, open: 100, high: 100, low: 100, close: 100 }]);
    const deps = { cache: new LiquidationStatsCache(), now: () => now, loadInputs: async (at: number) => fullInputs(Math.floor(at / LIQUIDATION_DAY) * LIQUIDATION_DAY), loadHistory };
    const cards = await Promise.all([getLiquidationStats(deps, now), getLiquidationStats(deps, now)]);
    expect(cards[0]).toBe(cards[1]); expect(cards[0].value?.candles).toHaveLength(1); expect(cards[0].value?.columns).toHaveLength(180);
    expect(loadHistory).toHaveBeenCalledOnce();
    now += 20 * HOUR; expect(await getLiquidationStats(deps, now)).toBe(cards[0]); expect(loadHistory).toHaveBeenCalledOnce();
    now += 3 * HOUR; expect((await getLiquidationStats(deps, now)).asOf).toBe(END + LIQUIDATION_DAY); expect(loadHistory).toHaveBeenCalledTimes(2);
  });
  it('retains last good history on failure, respects negative retry, then expires without rejuvenating it', async () => {
    let now = END + HOUR;
    const loadHistory = vi.fn(async () => []);
    const deps = { cache: new LiquidationStatsCache(), now: () => now, loadInputs: async (at: number) => fullInputs(Math.floor(at / LIQUIDATION_DAY) * LIQUIDATION_DAY), loadHistory };
    const good = await getLiquidationStats(deps, now);
    now = END + LIQUIDATION_DAY; loadHistory.mockRejectedValue(new Error('offline'));
    expect(await getLiquidationStats(deps, now)).toBe(good);
    now += 14 * 60000; expect(await getLiquidationStats(deps, now)).toBe(good); expect(loadHistory).toHaveBeenCalledTimes(2);
    now = END + 26 * HOUR; expect((await getLiquidationStats(deps, now)).status).toBe('unavailable');
    expect(good.expiresAt).toBe(END + 26 * HOUR);
  });
});
