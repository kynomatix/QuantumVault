import type { Express, RequestHandler } from 'express';
import { getMarketStats, type MarketStatsDeps } from './service';
import { getLiquidationStats, type LiquidationStatsDeps } from './liquidations-service';

export function registerMarketStatsRoutes(app: Express, requireWallet: RequestHandler,
  loadDeps: () => Promise<MarketStatsDeps> = async () => (await import('./default-deps')).defaultMarketStatsDeps,
  loadLiquidationDeps: () => Promise<LiquidationStatsDeps> = async () => (await import('./liquidations-service')).defaultLiquidationStatsDeps) {
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
  let liquidationDependencies: Promise<LiquidationStatsDeps> | undefined;
  let liquidationActive = 0;
  app.get('/api/market-stats/liquidations', requireWallet, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) { res.status(400).json({ error: 'Liquidation Stats accepts no query fields' }); return; }
    if (liquidationActive >= 20) { res.status(503).json({ error: 'Liquidation Stats is busy; try again later' }); return; }
    liquidationActive++;
    try {
      const deps = await (liquidationDependencies ??= loadLiquidationDeps().catch(error => { liquidationDependencies = undefined; throw error; }));
      const card = await getLiquidationStats(deps, deps.now());
      if (!res.destroyed) res.json({ ...card, serverNow: deps.now() });
    } catch { if (!res.destroyed) res.status(503).json({ error: 'Liquidation Stats is temporarily unavailable' }); }
    finally { liquidationActive--; }
  });
}
