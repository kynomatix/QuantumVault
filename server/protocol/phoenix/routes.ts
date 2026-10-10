import type { Express } from 'express';

/** Public cached display data only; a request cannot trigger upstream work. */
export function registerPhoenixReadRoutes(app: Express): void {
  app.get('/api/phoenix/readiness', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.PHOENIX_READS_ENABLED !== 'true') { res.status(404).json({ error: 'Phoenix public reads disabled' }); return; }
    try {
      const { getPhoenixReader } = await import('./runtime');
      const reader = getPhoenixReader();
      if (!reader) { res.status(503).json({ error: 'Phoenix public reads unavailable' }); return; }
      res.json({ capabilities: reader.getCapabilities(), markets: reader.getMarkets(), prices: reader.getPrices() });
    } catch { res.status(503).json({ error: 'Phoenix public reads unavailable' }); }
  });
}
