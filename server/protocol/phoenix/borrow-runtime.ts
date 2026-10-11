import type { Express, RequestHandler } from 'express';
import type { PhoenixBorrowService } from './borrow-service';
import type { BorrowAction, PhoenixBorrowIntent } from './borrow-contract';

export interface PhoenixBorrowRuntime {
  request(owner: string, botId: string, action: BorrowAction | 'resume', body: unknown): Promise<unknown>;
}
/** Server bindings resolve persisted intent for resume, authenticated custody,
 * lender allowlists, U08 complete snapshots and U04 settlement. No HTTP body
 * can install a runtime, supply a receipt or replace a liquidity policy. */
export function createPhoenixBorrowRuntime(service: PhoenixBorrowService, source: {
  intent(owner: string, botId: string, action: BorrowAction | 'resume', body: unknown): Promise<PhoenixBorrowIntent>;
}): PhoenixBorrowRuntime {
  return { async request(owner,botId,action,body) {
    const intent = await source.intent(owner,botId,action,body);
    if (intent.ownerWallet !== owner || intent.botId !== botId || action !== 'resume' && intent.action !== action) throw new Error('Phoenix borrowing request binding mismatch');
    return service.run(intent);
  } };
}
// As with U04/U10, live queue evidence and reviewed production bindings have not
// been installed. An environment switch alone can never enable this money path.
const runtime: PhoenixBorrowRuntime | null = null;
export function phoenixBorrowCapabilities(env: NodeJS.ProcessEnv = process.env) {
  return { externalLender: 'jupiter-lend' as const, phoenixMarginIsCollateral: false as const,
    newBorrowing: runtime !== null && env.PHOENIX_BORROW_ENABLED === 'true',
    manualRecovery: runtime !== null, requiresMeasuredDelay: true as const,
    requiresDeploymentConsent: true as const, requiresSeparateLiquidReserve: true as const };
}
export function registerPhoenixBorrowRoutes(app: Express, requireWallet: RequestHandler) {
  for (const action of ['open','grow','topup','release','repay','unwind','deploy','resume'] as const) {
    app.post(`/api/phoenix/bots/:botId/borrowing/${action}`, requireWallet, async (req,res) => {
      res.setHeader('Cache-Control','no-store');
      try {
        const { storage } = await import('../../storage');
        const bot = await storage.getTradingBotById(req.params.botId);
        if (!bot || bot.walletAddress !== req.walletAddress || bot.activeProtocol !== 'phoenix') { res.status(404).json({error:'Phoenix borrowing bot unavailable'}); return; }
        const installed = runtime as PhoenixBorrowRuntime | null;
        if (!installed) { res.status(503).json({code:'PHOENIX_BORROW_DISABLED',error:'Phoenix external borrowing awaits reviewed lender and settlement bindings.',capabilities:phoenixBorrowCapabilities()}); return; }
        // Recovery is intentionally outside the new-borrow switch/allowlist.
        if (!['repay','unwind','resume'].includes(action) && !phoenixBorrowCapabilities().newBorrowing) { res.status(503).json({code:'PHOENIX_BORROW_DISABLED'}); return; }
        res.json(await installed.request(req.walletAddress!,bot.id,action,req.body));
      } catch { res.status(409).json({error:'Phoenix lender state needs attention; preserve the same request identity'}); }
    });
  }
}
