import type { TradingBot } from '../../../shared/schema';
import { phoenixCanaryAllows } from './rollout';
import { phoenixMarket } from './markets';
import { phoenixPriceUsdToTicks } from './sdk-boundary';
import type { PhoenixOrderAuthority, PhoenixOrderIntent } from './order-contract';

export function signalMicros(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/.test(value) || /[\r\n]/.test(value)) throw new Error('PHOENIX_FIXED_USDC_REQUIRED');
  const [whole, decimal = ''] = value.split('.');
  const n = BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, '0'));
  if (n <= 0n) throw new Error('PHOENIX_POSITIVE_SIZE_REQUIRED');
  return n;
}
export function validatePhoenixSignalPolicy(bot: TradingBot) {
  const size = signalMicros(bot.maxPositionSize), capital = signalMicros(bot.totalInvestment);
  if (bot.botType !== 'signal' || bot.sourcePublishedBotId || !['both','long','short'].includes(bot.side)
    || !Number.isInteger(bot.leverage) || bot.leverage < 1 || size > capital * BigInt(bot.leverage)
    || bot.market !== process.env.PHOENIX_CANARY_MARKET || phoenixMarket(bot.market).isolatedOnly
    || bot.profitReinvest || bot.autoTopUp || bot.autoParkIdle || bot.autoCollateralTopUp || bot.autoRepayEnabled || bot.vaultAllOut
    || bot.autoWithdrawThreshold || bot.signalConfig && Object.keys(bot.signalConfig).length) throw new Error('PHOENIX_FIXED_SIGNAL_ONLY');
  const risk = bot.riskConfig;
  if (!risk || Object.keys(risk).some(k => !['stopLossPercent','takeProfitPercent'].includes(k))
    || ![risk.stopLossPercent, risk.takeProfitPercent].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0.01 && v <= 50 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-8)) throw new Error('PHOENIX_NATIVE_TP_SL_REQUIRED');
  if (!phoenixCanaryAllows('entry', { botId: bot.id, ownerWallet: bot.walletAddress, notionalMicros: size.toString(), leverage: String(bot.leverage) })) throw new Error('PHOENIX_ENTRY_DISABLED');
  return { size, capital, stopLossBps: Math.round(risk.stopLossPercent! * 100), takeProfitBps: Math.round(risk.takeProfitPercent! * 100) };
}

/** Only stored fixed USDC sizing and an executable native quote affect the order. */
export function sizePhoenixSignal(bot: TradingBot, draft: PhoenixOrderIntent, authority: PhoenixOrderAuthority): PhoenixOrderIntent {
  const policy = validatePhoenixSignalPolicy(bot), m = phoenixMarket(bot.market);
  const ticks = phoenixPriceUsdToTicks(authority.price.usd, m);
  const lotCost = ticks * BigInt(m.tickSize), lots = policy.size * 10000n / (lotCost * 10025n);
  if (lots <= 0n) throw new Error('PHOENIX_ROUNDED_DUST');
  const scale = m.baseLotsDecimals;
  const digits = scale >= 0 ? lots.toString().padStart(scale + 1, '0') : '';
  const baseUnits = scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : scale === 0 ? lots.toString() : (lots * 10n ** BigInt(-scale)).toString();
  const long = draft.side === 'buy', sl = BigInt(policy.stopLossBps), tp = BigInt(policy.takeProfitBps);
  return { ...draft, baseUnits, maxNotionalMicros: policy.size.toString(), leverage: String(bot.leverage),
    lastValidSlot: (BigInt(authority.slot) + 20n).toString(),
    protection: { tp: { triggerTicks: (ticks * (long ? 10000n + tp : 10000n - tp) / 10000n).toString(), slippageBps: 25 },
      sl: { triggerTicks: (ticks * (long ? 10000n - sl : 10000n + sl) / 10000n).toString(), slippageBps: 1000 } } };
}
