import { describe, expect, it, vi } from 'vitest';
import type { Express, RequestHandler } from 'express';
import { registerMarketStatsRoutes } from '../../server/market-stats/routes';
import { LiquidationStatsCache } from '../../server/market-stats/liquidations-service';
import { END, fullInputs } from './liquidations-fixtures';

describe('liquidation authenticated sibling route', () => {
  function setup(authorized = true) {
    const routes = new Map<string, Function[]>();
    const auth = vi.fn((req, res, next) => authorized ? next() : res.status(401).json({ error: 'Wallet session required' }));
    const load = vi.fn(async () => ({ cache: new LiquidationStatsCache(), now: () => END + 3600000, loadInputs: async () => fullInputs() }));
    const v1 = vi.fn();
    registerMarketStatsRoutes({ get: (path: string, ...handlers: Function[]) => routes.set(path, handlers) } as unknown as Express,
      auth as RequestHandler, v1, load);
    const res = { set: vi.fn(), status: vi.fn(), json: vi.fn(), destroyed: false }; res.status.mockReturnValue(res);
    return { handlers: routes.get('/api/market-stats/liquidations')!, auth, load, res, v1 };
  }
  it('applies authentication before loading sources and never loads the v1 DB dependencies', async () => {
    const { handlers, auth, load, res, v1 } = setup();
    expect(handlers[0]).toBe(auth); expect(load).not.toHaveBeenCalled();
    await handlers[0]({}, res, () => handlers[1]({ query: {} }, res));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'available', serverNow: END + 3600000 }));
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store'); expect(v1).not.toHaveBeenCalled();
  });
  it('stops unauthorized requests before the loader', async () => {
    const { handlers, load, res } = setup(false);
    await handlers[0]({}, res, () => handlers[1]({ query: {} }, res));
    expect(res.status).toHaveBeenCalledWith(401); expect(load).not.toHaveBeenCalled();
  });
  it('rejects all query parameters', async () => {
    const { handlers, load, res } = setup();
    await handlers[1]({ query: { days: '90' } }, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(load).not.toHaveBeenCalled();
  });
  it('isolates dependency failures and permits a later retry', async () => {
    const { handlers, load, res } = setup(); load.mockRejectedValueOnce(new Error('loader failed'));
    await handlers[1]({ query: {} }, res); expect(res.status).toHaveBeenCalledWith(503);
    await handlers[1]({ query: {} }, res); expect(load).toHaveBeenCalledTimes(2);
  });
});
