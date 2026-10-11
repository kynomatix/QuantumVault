import { phoenixFeatureEnabled } from './rollout';
import type { Express, RequestHandler } from 'express';
import type { PhoenixCarryService } from './carry-service';
import { recommendPhoenixCarry, type CarryEconomics } from './carry-policy';
import type { ParkingIntent } from './parking-contract';

export function createPhoenixCarryRuntime(service: PhoenixCarryService, source: {
  /** Authenticated, server-resolved measurements; never a client quote. */
  economics(owner: string, botId: string): Promise<CarryEconomics>;
  /** start binds explicit consent to an authoritative close; resume loads the
   * immutable journal. Neither accepts a signer, receipt or economics body. */
  intent(owner: string, botId: string, action: 'start' | 'resume', body: unknown): Promise<ParkingIntent>;
  pending(): Promise<ParkingIntent[]>;
  report(i: ParkingIntent, error: unknown): void;
}, now = Date.now) {
  return {
    async recommendation(owner: string, botId: string) { return recommendPhoenixCarry(await source.economics(owner,botId),now()); },
    async request(owner: string, botId: string, action: 'start' | 'resume', body: unknown) {
      const i = await source.intent(owner,botId,action,body);
      if (i.ownerWallet !== owner || i.botId !== botId || i.action !== 'carry') throw new Error('Carry request binding mismatch');
      return action === 'start' ? service.start(i) : service.resume(i);
    },
    async recover() {
      for (const i of await source.pending()) {
        if (i.action !== 'carry') continue;
        try { await service.resume(i); } catch (e) { source.report(i,e); }
      }
    },
  };
}
type PhoenixCarryRuntime = ReturnType<typeof createPhoenixCarryRuntime>;
// No live installation: measured costs, queue proofs and lender/vault observers
// must be reviewed first. An environment switch alone cannot enable automation.
const runtime: PhoenixCarryRuntime | null = null;
export function phoenixCarryCapabilities(env: NodeJS.ProcessEnv = process.env) {
  return { enabled: runtime !== null && phoenixFeatureEnabled('carry',env),
    recovery: runtime !== null, automaticBorrowing: false as const, preservesParkedAssets: true as const };
}
export async function recoverPhoenixCarry() { await (runtime as PhoenixCarryRuntime | null)?.recover(); }
export function registerPhoenixCarryRoutes(app: Express, requireWallet: RequestHandler) {
  for (const action of ['recommendation','start','resume'] as const) {
    const handler: RequestHandler = async (req,res) => {
      res.setHeader('Cache-Control','no-store');
      try {
        const {storage} = await import('../../storage');
        const bot = await storage.getTradingBotById(req.params.botId);
        if (!bot || bot.walletAddress !== req.walletAddress || bot.activeProtocol !== 'phoenix') { res.status(404).json({error:'Phoenix carry bot unavailable'}); return; }
        const installed = runtime as PhoenixCarryRuntime | null;
        if (!installed || action === 'start' && !phoenixCarryCapabilities().enabled) {
          res.status(503).json({code:'PHOENIX_CARRY_DISABLED',status:'unavailable',capabilities:phoenixCarryCapabilities(),
            error:'Phoenix carry awaits reviewed cost, queue and settlement bindings.'}); return;
        }
        res.json(action === 'recommendation' ? await installed.recommendation(req.walletAddress!,bot.id)
          : await installed.request(req.walletAddress!,bot.id,action,req.body));
      } catch { res.status(409).json({error:'Phoenix carry state needs attention; preserve the same request identity'}); }
    };
    if (action === 'recommendation') app.get(`/api/phoenix/bots/:botId/carry/${action}`,requireWallet,handler);
    else app.post(`/api/phoenix/bots/:botId/carry/${action}`,requireWallet,handler);
  }
}
