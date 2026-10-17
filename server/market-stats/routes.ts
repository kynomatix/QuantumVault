import type { Express, RequestHandler } from 'express';
import { getMarketStats, type MarketStatsDeps } from './service';

export function registerMarketStatsRoutes(app: Express, requireWallet: RequestHandler,
  loadDeps: () => Promise<MarketStatsDeps> = async () => (await import('./default-deps')).defaultMarketStatsDeps) {
  let dependencies: Promise<MarketStatsDeps> | undefined;
  let active = 0;
  app.get('/api/market-stats', requireWallet, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) { res.status(400).json({ error: 'Market Stats accepts no query fields' }); return; }
    if (active >= 20) { res.status(503).json({ error: 'Market Stats is busy; try again later' }); return; }
    active++;
    try {
      const deps = await (dependencies ??= loadDeps().catch(error => { dependencies = undefined; throw error; }));
      const stats = await getMarketStats(deps, deps.now());
      if (!res.destroyed) res.json(stats);
    } catch { if (!res.destroyed) res.status(503).json({ error: 'Market Stats is temporarily unavailable' }); }
    finally { active--; }
  });
}
