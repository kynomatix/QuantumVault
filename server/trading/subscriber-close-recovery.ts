import type { IStorage } from '../storage';
import type { ProtocolAdapter } from '../protocol/adapter';
import { readSubscriberCloseAccounting, subscriberClosePersistence, subscriberPartialExecution,
  type SubscriberCloseAccounting } from './subscriber-close-accounting';

/** Read-only venue work. No signing, order retry or payout is performed here. */
export async function recoverSubscriberCloseEvidence(input: {
  botId: string; account: string; adapter: ProtocolAdapter;
  storage: Pick<IStorage, 'getSubscriberCloseAccountingCandidates' | 'updatePendingBotTrade'
    | 'remediateSubscriberCloseAccountingAtomic'>;
}): Promise<number> {
  const candidates = await input.storage.getSubscriberCloseAccountingCandidates(input.botId);
  let repaired = 0;
  for (const trade of candidates) {
    const payload = trade.webhookPayload && typeof trade.webhookPayload === 'object'
      ? trade.webhookPayload as Record<string, unknown> : {};
    const prior = payload.subscriberCloseAccounting as SubscriberCloseAccounting | undefined;
    const request = prior?.recovery;
    if (!request || prior?.account !== input.account || request.account !== input.account
        || request.market !== trade.market || !request.orderId
        || prior.orderId !== request.orderId || trade.txSignature !== request.orderId) continue;
    try {
      const accounting = await readSubscriberCloseAccounting(input.adapter, request);
      if (payload.partialClose === true && trade.status === 'pending') {
        const execution = subscriberPartialExecution(accounting);
        if (execution.pnl === null || accounting.size === null) continue;
        const marker = payload.partialCloseAccounting as Record<string, unknown> | undefined;
        if (!marker) continue;
        await input.storage.updatePendingBotTrade(trade.id, {
          size: accounting.size, price: accounting.price!, fee: null, pnl: null,
          webhookPayload: { ...payload, ...subscriberClosePersistence(accounting).webhookPayload,
            partialCloseAccounting: { ...marker, requestedClosedSize: Number(accounting.size) },
            feeEvidence: { kind: 'venue_exact', amount: execution.fee, protocol: 'pacifica' },
            executionAccounting: { ...execution, priceAuthority: 'venue_execution' } },
        });
      } else if (accounting.reason === null && request.closeResult?.outcome === 'confirmed') {
        const result = await input.storage.remediateSubscriberCloseAccountingAtomic({
          botId: input.botId, tradeId: trade.id, accounting,
        });
        if (result.remediated) repaired++;
      }
    } catch (error) {
      // Conflicting evidence or a failed transaction leaves the durable marker
      // available to a later pass without converting uncertainty into zero.
      console.warn(`[SubscriberCloseRecovery] ${trade.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return repaired;
}
