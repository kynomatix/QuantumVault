import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { botTrades } from '@shared/schema';
import type { CloseIntent } from './signal-bot-close-intent-types';

/** Quiescence never fabricates money. Existing fill-backed finalizers may win first. */
export async function accountDurableClose(client: any, intent: CloseIntent,
  mode: 'confirmed' | 'flat' | 'still_open' | 'residual' | 'not_sent'): Promise<void> {
  const { storage, DatabaseStorage } = await import('../storage');
  const [trade] = await drizzle(client).select().from(botTrades).where(eq(botTrades.id, intent.original_trade_id));
  if (!trade) throw new Error('close_intent_trade_missing');
  const payload = trade.webhookPayload && typeof trade.webhookPayload === 'object' ? trade.webhookPayload : {};
  const flat = mode === 'flat' || (mode === 'confirmed' && intent.close_kind === 'full');
  const orderId = intent.attempt_log[intent.attempt_log.length - 1]?.outcome?.orderId;
  await storage.recordCloseEventAtomic({ botId: intent.bot_id,
    update: { tradeId: intent.original_trade_id, fields: {
      status: flat ? 'executed' : mode === 'confirmed' ? 'pending' : 'failed',
      fee: null, pnl: null, txSignature: orderId ?? null,
      ...(flat ? { protocolFillId: DatabaseStorage.canonicalCloseFillId({ signature: orderId ?? `close-intent-${intent.id}`,
        botId: intent.bot_id, side: 'CLOSE', market: intent.market, size: Number(intent.requested_size_base) }) } : {}),
      errorMessage: flat ? null : mode === 'confirmed' ? 'partial_close_accounting_unavailable'
        : mode === 'still_open' ? 'close_expired_unconfirmed' : mode === 'not_sent' ? 'close_not_sent' : 'close_residual_attention',
      webhookPayload: { ...payload, closeIntentId: intent.id, closeAttention: mode === 'residual',
        closeAccounting: { kind: 'unavailable', reason: 'attributable_close_fills_unavailable' } },
    } }, deltas: {},
    ...(flat ? { confirmedPositionCloseIncomplete: { walletAddress: intent.owner_wallet, market: intent.market } } : {}),
  }, client);
}
