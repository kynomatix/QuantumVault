import type { Express, RequestHandler } from 'express';
import { phoenixFundingDetail } from './funding-detail';
import type { PhoenixOperationStore } from './operation-store';

export const PHOENIX_FUNDING_DISABLED = Object.freeze({ code: 'PHOENIX_FUNDING_DISABLED',
  error: 'Phoenix funding is disabled. Queue outcome verification and live fee quotes are not yet enabled.' });

export function registerPhoenixFundingRoutes(app: Express, requireWallet: RequestHandler,
  dependencies: { history(botId: string, owner: string): ReturnType<PhoenixOperationStore['fundingHistory']> }) {
  app.get('/api/phoenix/performance/:publishedBotId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { storage } = await import('../../storage');
      const published = await storage.getPublishedBotById(req.params.publishedBotId);
      const bot = published?.isActive ? await storage.getTradingBotById(published.tradingBotId) : null;
      if (!bot || bot.activeProtocol !== 'phoenix') { res.status(404).json({ error: 'Phoenix performance unavailable' }); return; }
      const { readPhoenixAccounting } = await import('./accounting-runtime');
      const detail = await readPhoenixAccounting(bot);
      res.json({ venue: 'phoenix', status: detail.status, performance: detail.performance,
        history: detail.history.map(e => ({ market: e.market, side: e.side, openedAt: e.openedAt, closedAt: e.closedAt,
          netPnlMicros: e.netPnlMicros, venueFeesMicros: e.feeMicros, fundingMicros: e.fundingMicros,
          accounting: e.accounting, liquidation: e.liquidation })) });
    } catch { res.status(503).json({ error: 'Phoenix performance unavailable', status: 'unknown' }); }
  });
  app.get('/api/phoenix/bots/:botId/accounting', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { storage } = await import('../../storage');
      const bot = await storage.getTradingBotById(req.params.botId);
      if (!bot || bot.walletAddress !== req.walletAddress || bot.activeProtocol !== 'phoenix') {
        res.status(404).json({ error: 'Phoenix accounting unavailable for this bot' }); return;
      }
      const { readPhoenixAccounting } = await import('./accounting-runtime');
      res.json(await readPhoenixAccounting(bot));
    } catch { res.status(503).json({ error: 'Phoenix accounting unavailable', status: 'unknown' }); }
  });
  app.get('/api/phoenix/bots/:botId/funding', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(phoenixFundingDetail(await dependencies.history(req.params.botId, req.walletAddress!))); }
    catch { res.status(404).json({ error: 'Phoenix funding history unavailable for this bot' }); }
  });
  // No body-supplied quote, receipt, signer, pin or runtime can enable production funding.
  for (const action of ['preview', 'deposit', 'withdraw', 'resume']) {
    app.post(`/api/phoenix/bots/:botId/funding/${action}`, requireWallet, (_req, res) => {
      res.status(503).json(PHOENIX_FUNDING_DISABLED);
    });
  }
}
