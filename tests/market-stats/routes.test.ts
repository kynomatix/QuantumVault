import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Express, RequestHandler } from 'express';
import { registerMarketStatsRoutes } from '../../server/market-stats/routes';
import { MarketStatsCache } from '../../server/market-stats/cache';
import { computeBtcDirection } from '../../server/grid-planner/direction';
import { NOW, weeks, days } from './fixtures';

describe('Market Stats route boundary', () => {
  function setup() {
    const registrations = new Map<string, Function[]>();
    const app = { get: vi.fn((path, ...handlers) => registrations.set(path, handlers)) };
    const auth = vi.fn() as unknown as RequestHandler;
    const deps = { cache: new MarketStatsCache(), now: () => NOW,
      direction: async () => computeBtcDirection(weeks(), NOW),
      dailyCandles: async () => ({ candles: days(), fetchedAt: NOW }),
      cot: async () => null, funding: async () => null };
    const load = vi.fn(async () => deps);
    registerMarketStatsRoutes(app as unknown as Express, auth, load);
    const res = { set: vi.fn(), status: vi.fn(), json: vi.fn(), destroyed: false };
    res.status.mockReturnValue(res);
    return { registrations, auth, load, res };
  }
  it('places the supplied wallet session guard before the read, with no planner feature gate', async () => {
    const { registrations, auth, load, res } = setup();
    expect([...registrations.keys()]).toEqual(['/api/market-stats', '/api/market-stats/liquidations']);
    const [guard, read] = registrations.get('/api/market-stats')!;
    expect(guard).toBe(auth); expect(load).not.toHaveBeenCalled();
    await read({ query: {} }, res);
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cycle: expect.objectContaining({ status: 'available' }),
      funding: expect.objectContaining({ status: 'unavailable' }) }));
  });
  it('rejects all caller-controlled source and wallet query fields', async () => {
    const { registrations, load, res } = setup();
    await registrations.get('/api/market-stats')![1]({ query: { wallet: 'EXAMPLE', symbol: 'ETH' } }, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(load).not.toHaveBeenCalled();
  });
  // Execute the actual local guard without importing registerRoutes and its startup graph.
  function walletGuard() {
    const source = readFileSync(new URL('../../server/routes.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  const requireWallet = ');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf('\n  };', start);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end + 6), {}).outputText;
    return new Function(`${code}; return requireWallet;`)();
  }
  it.each([
    [{}, {}, 401],
    [{ walletAddress: 'EXAMPLE' }, { 'x-wallet-address': 'CHANGEME' }, 403],
  ])('rejects an unauthenticated or mismatched wallet before loading sources', async (session, headers, status) => {
    const { res, load } = setup(), next = vi.fn(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      walletGuard()({ query: {}, session, headers, path: '/api/market-stats', method: 'GET' }, res, next);
      expect(res.status).toHaveBeenCalledWith(status); expect(next).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('accepts the matching session and binds its wallet to the request', () => {
    const { res } = setup(), next = vi.fn();
    const request = { query: {}, session: { walletAddress: 'EXAMPLE' }, headers: { 'x-wallet-address': 'EXAMPLE' },
      path: '/api/market-stats', method: 'GET', walletAddress: undefined };
    walletGuard()(request, res, next);
    expect(next).toHaveBeenCalledOnce(); expect(request.walletAddress).toBe('EXAMPLE');
  });
});
