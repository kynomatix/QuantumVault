import { registerPhoenixBorrowRoutes } from './borrow-runtime';
import { registerPhoenixCarryRoutes } from './carry-runtime';
import type { Express, RequestHandler } from 'express';
import { phoenixFundingDetail } from './funding-detail';
import type { PhoenixOperationStore } from './operation-store';
import { PhoenixOwnershipError } from './operation-store';

export const PHOENIX_FUNDING_DISABLED = Object.freeze({ code: 'PHOENIX_FUNDING_DISABLED',
  error: 'Phoenix funding is disabled by the current owner canary policy.' });

export function registerPhoenixFundingRoutes(app: Express, requireWallet: RequestHandler,
  dependencies: { history(botId: string, owner: string): ReturnType<PhoenixOperationStore['fundingHistory']> }) {
  registerPhoenixBorrowRoutes(app, requireWallet);
  registerPhoenixCarryRoutes(app, requireWallet);
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
    catch (error) { res.status(error instanceof PhoenixOwnershipError ? 404 : 503).json({ error: 'Phoenix funding history unavailable for this bot' }); }
  });
  // No body-supplied quote, receipt, signer, pin or runtime can enable production funding.
  for (const action of ['preview', 'deposit', 'withdraw', 'resume']) {
    app.post(`/api/phoenix/bots/:botId/funding/${action}`, requireWallet, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const { getPhoenixProduction } = await import('./production');
        const runtime = getPhoenixProduction()?.funding;
        if (!runtime) { res.status(503).json(PHOENIX_FUNDING_DISABLED); return; }
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ error: 'PHOENIX_INVALID_REQUEST' }); return; }
        const args = [req.params.botId, req.walletAddress!, req.body] as const;
        const result = action === 'preview' ? await runtime.preview(...args) : action === 'resume' ? await runtime.resume(...args)
          : await runtime.execute(req.params.botId, req.walletAddress!, action as 'deposit' | 'withdraw', req.body);
        res.json(result);
      } catch (error) {
        const code = error instanceof Error && /^PHOENIX_[A-Z_]+$/.test(error.message) ? error.message : 'PHOENIX_FUNDING_UNAVAILABLE';
        res.status(error instanceof PhoenixOwnershipError ? 404 : 409).json({ code, error: code });
      }
    });
  }
}
