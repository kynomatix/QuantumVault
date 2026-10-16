import type { Express, RequestHandler, Response } from 'express';
import { getPhoenixProduction, PhoenixOnboardingError, type PhoenixProduction } from './production';

const unavailable = { code: 'PHOENIX_REGISTRATION_UNAVAILABLE', error: 'Phoenix registration is unavailable. Retain and resume the same request.' };
function failure(res: Response, error: unknown) {
  if (error instanceof PhoenixOnboardingError) return res.status(error.status).json({ code: error.code, error: 'Phoenix registration request refused.' });
  return res.status(503).json(unavailable);
}
export function registerPhoenixOnboardingRoutes(app: Express, requireWallet: RequestHandler,
  getProduction: () => PhoenixProduction | null = getPhoenixProduction): void {
  app.get('/api/phoenix/canary/preflight', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const holder = getProduction();
      if (!holder) return res.status(404).json({ code: 'PHOENIX_CANARY_UNAVAILABLE' });
      return res.json(await holder.preflight(req.walletAddress!));
    } catch (error) { return failure(res, error); }
  });
  app.post('/api/phoenix/bots/:botId/onboarding/resume', requireWallet, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const holder = getProduction();
      if (!holder) return res.status(503).json(unavailable);
      if (Object.keys(req.body ?? {}).length) return res.status(400).json({ code: 'PHOENIX_RESUME_BODY_REFUSED' });
      return res.json(await holder.resume(req.walletAddress!, req.params.botId));
    } catch (error) { return failure(res, error); }
  });
}

/** Every Phoenix create outcome terminates before legacy allocation or money rails. */
export async function handlePhoenixRegistrationCreate(owner: string, input: Record<string, unknown>, res: Response,
  getProduction: () => PhoenixProduction | null = getPhoenixProduction) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const holder = getProduction();
    if (!holder) return res.status(503).json(unavailable);
    return res.json(await holder.create(owner, input));
  } catch (error) { return failure(res, error); }
}
