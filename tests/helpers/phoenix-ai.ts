import type { AiTraderBot, AiTraderDecision, TradingBot } from '@shared/schema';
import { phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import { admitPhoenixOrder, orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import type { PhoenixOrderRecord } from '../../server/protocol/phoenix/order-store';
import type { ClampedDecision } from '../../server/ai-trader/guardrails';
import { authority, identity, now } from './phoenix-orders';
export { identity, now };
export function aiBot(patch: Partial<AiTraderBot> = {}): AiTraderBot {
  return { id: 'EXAMPLE-ai', walletAddress: 'EXAMPLE-owner', protocol: 'phoenix', paperMode: false,
    market: 'SOL-PERP', marketSource: 'manual', maxLeverage: 2, allocatedUsdc: '100.00', sizingMode: 'discretionary',
    riskMinPct: '0.50', riskMaxPct: '1.50', status: 'proposed', policyHmac: 'EXAMPLE-hmac',
    currentQualificationEraDigest: 'EXAMPLE-era', graduatedQualificationEraDigest: 'EXAMPLE-era', graduationState: 'graduated',
    protocolSubaccountId: identity.traderAccountAddress, phoenixExecutionBotId: 'EXAMPLE-bot',
    phoenixBinding: { version: 1, aiBotId: 'EXAMPLE-ai', executionBotId: 'EXAMPLE-bot', identity, derivationIndex: 1, derivationPathVersion: 1 },
    ...patch } as AiTraderBot;
}
export function custody(patch: Partial<TradingBot> = {}): TradingBot {
 return { id: 'EXAMPLE-bot', walletAddress: 'EXAMPLE-owner', activeProtocol: 'phoenix', derivationIndex: 1,
   ...phoenixIdentityColumns(identity), market: 'SOL-PERP', leverage: 2, maxPositionSize: '100.00',
   policyHmac: 'EXAMPLE-hmac', botSubaccountKeyEncryptedV3: 'EXAMPLE-ciphertext', subaccountStatus: 'active', ...patch } as TradingBot;
}
export function aiAuthority() { const a = authority(); a.market = 'SOL-PERP'; a.protection!.market = a.market; return a; }
export function clamped(patch: Partial<ClampedDecision> = {}): ClampedDecision {
 return { action: 'long', leverage: 2, sizePct: 50, stopLossPrice: 140, takeProfitPrice: 170,
  confidence: 7, rationale: 'EXAMPLE', invalidation: 'EXAMPLE', sizeBase: 999, notionalUsdc: 999999, marginUsdc: 99999, ...patch };
}
export function decision(bot = aiBot(), c = clamped()): AiTraderDecision {
 return { id: 'EXAMPLE-decision', botId: bot.id, outcome: null, clampedDecision: c, rawDecision: { action: c.action },
  contextDigest: { executionVenue: 'phoenix' }, qualificationEraDigest: bot.currentQualificationEraDigest } as AiTraderDecision;
}
export function filled(i: import('../../server/protocol/phoenix/order-contract').PhoenixOrderIntent, state: PhoenixOrderRecord['state'] = 'landed'): PhoenixOrderRecord {
 const a = aiAuthority(), admission = admitPhoenixOrder(i, a, now);
 return { id: 'EXAMPLE-order', intent: i, intent_hash: orderIntentHash(i), state, revision: 1,
  data: { admission, orderId: 'EXAMPLE-venue-order', positionEpoch: 'EXAMPLE-position-epoch', outcomeSource: 'EXAMPLE-chain',
   outcomeReference: 'EXAMPLE-receipt', fills: [{ fillId: 'EXAMPLE-fill', orderId: 'EXAMPLE-venue-order', baseLots: admission.packet.numBaseLots,
    quoteMicros: String(BigInt(admission.packet.numBaseLots) * 1500000n), feeMicros: '35000' }] } };
}
