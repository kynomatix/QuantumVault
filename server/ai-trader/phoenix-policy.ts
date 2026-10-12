import type { AiTraderBot, TradingBot } from '@shared/schema';
import type { PhoenixAiBinding } from '../../shared/phoenix-ai-contract';
import { assertPhoenixIdentity, phoenixIdentityFromBot } from '../protocol/phoenix/identity';
import { orderIntentHash } from '../protocol/phoenix/order-contract';
import type { BotPolicyInput } from '../protocol/phoenix/policy';

type AiPolicyBot = Pick<AiTraderBot, 'market' | 'maxLeverage' | 'allocatedUsdc'> & Partial<AiTraderBot>;
const riskDecimal = (value: string) => {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || value.includes('\n')) throw new Error('Phoenix AI risk policy malformed');
  return String(Number(value));
};

export function assertPhoenixAiBinding(bot: AiPolicyBot): PhoenixAiBinding {
  const b = bot.phoenixBinding;
  if (bot.protocol !== 'phoenix' || !b || b.version !== 1 || b.aiBotId !== bot.id
    || !b.executionBotId || b.executionBotId !== bot.phoenixExecutionBotId
    || b.identity.traderAccountAddress !== bot.protocolSubaccountId
    || !Number.isSafeInteger(b.derivationIndex) || b.derivationIndex < 1 || b.derivationIndex > 2147483647
    || b.derivationPathVersion !== 1) throw new Error('Phoenix AI binding unavailable');
  assertPhoenixIdentity(b.identity);
  return structuredClone(b);
}

/** Both the AI mandate and U03 custody must agree before any signing callback. */
export function assertPhoenixAiCustody(bot: AiTraderBot, custody: TradingBot): PhoenixAiBinding {
  const b = assertPhoenixAiBinding(bot);
  const identity = phoenixIdentityFromBot(custody);
  if (custody.id !== b.executionBotId || custody.walletAddress !== bot.walletAddress
    || custody.derivationIndex !== b.derivationIndex || custody.derivationPathVersion !== b.derivationPathVersion
    || orderIntentHash(identity) !== orderIntentHash(b.identity)) throw new Error('Phoenix AI custody mismatch');
  return b;
}

/** Pacifica's existing three-field HMAC record stays byte-for-byte unchanged. */
export function aiTraderPolicyObject(bot: AiPolicyBot): BotPolicyInput {
  const legacy = { market: bot.market, leverage: bot.maxLeverage, maxPositionSize: bot.allocatedUsdc };
  if (bot.protocol !== 'phoenix') return legacy;
  const binding = bot.paperMode === false ? assertPhoenixAiBinding(bot) : null;
  return { ...legacy, activeProtocol: 'phoenix', aiTraderPolicy: {
    policyVersion: 'phoenix-ai-v1', ownerWallet: bot.walletAddress ?? '', paperMode: bot.paperMode !== false,
    aiBotId: binding?.aiBotId ?? null, bindingHash: orderIntentHash(binding),
    sizingMode: bot.sizingMode ?? 'discretionary', riskMinPct: riskDecimal(bot.riskMinPct ?? '0.50'), riskMaxPct: riskDecimal(bot.riskMaxPct ?? '1.50'),
  } };
}
