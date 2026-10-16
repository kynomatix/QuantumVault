import type { Express, RequestHandler, Response } from 'express';
import { LAB_PROVENANCE_MESSAGES } from '../../shared/lab-provenance';
import { confirmLabSource, findLabSources, labSourceDetail, triageLabBot } from './provenance';

function failure(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const code = /^LAB_[A-Z_]+$/.test(message) ? message : 'LAB_PROVENANCE_UNAVAILABLE';
  return res.status(code.endsWith('NOT_FOUND') ? 404 : 409).json({ code,
    error: LAB_PROVENANCE_MESSAGES[code as keyof typeof LAB_PROVENANCE_MESSAGES] ?? code.replaceAll('_', ' ').toLowerCase() });
}
export function registerLabProvenanceRoutes(app: Express, requireWallet: RequestHandler) {
  const owner = (req: unknown) => (req as { walletAddress: string }).walletAddress;
  app.get('/api/trading-bots/:id/lab-source', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await labSourceDetail(owner(req), req.params.id)); } catch (e) { failure(res, e); }
  });
  app.post('/api/trading-bots/:id/lab-source/find', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await findLabSources(owner(req), req.params.id)); } catch (e) { failure(res, e); }
  });
  app.post('/api/trading-bots/:id/lab-source/confirm', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.body ?? {}).some(k => k !== 'resultId') || !Number.isSafeInteger(req.body?.resultId) || req.body.resultId < 1) {
        throw new Error('LAB_RESULT_REQUIRED');
      }
      res.json(await confirmLabSource(owner(req), req.params.id, req.body.resultId));
    } catch (e) { failure(res, e); }
  });
  app.get('/api/trading-bots/:id/lab-source/triage', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await triageLabBot(owner(req), req.params.id)); } catch (e) { failure(res, e); }
  });
}
