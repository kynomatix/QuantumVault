import type { Express, RequestHandler } from 'express';
import { phoenixFundingDetail } from './funding-detail';
import type { PhoenixOperationStore } from './operation-store';

export const PHOENIX_FUNDING_DISABLED = Object.freeze({ code: 'PHOENIX_FUNDING_DISABLED',
  error: 'Phoenix funding is disabled. Queue outcome verification and live fee quotes are not yet enabled.' });

export function registerPhoenixFundingRoutes(app: Express, requireWallet: RequestHandler,
  dependencies: { history(botId: string, owner: string): ReturnType<PhoenixOperationStore['fundingHistory']> }) {
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
