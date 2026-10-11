import type { AiTraderBot } from '@shared/schema';
import { getAdapter } from '../protocol/adapter-registry';
import type { ProtocolAdapter } from '../protocol/adapter';
import { getPhoenixReader } from '../protocol/phoenix/runtime';
import { getPhoenixAiService } from './phoenix-runtime';

/** Analysis facade only, kept out of the money adapter registry. Unsupported
 * methods throw. Live execution and recovery go exclusively through U05/U06. */
export function getAiTraderAdapter(bot: Pick<AiTraderBot, 'protocol' | 'paperMode' | 'market'> & Partial<AiTraderBot>): ProtocolAdapter {
  if (bot.protocol !== 'phoenix') return getAdapter(bot.protocol);
  const reads: Partial<ProtocolAdapter> = bot.paperMode ? {
    protocolName: 'phoenix',
    getPrice: async market => { const p = getPhoenixReader()?.getPrice(market); return p?.state === 'fresh' ? p.value : null; },
    getFundingRate: async internalSymbol => ({ internalSymbol, rate: NaN, nextFundingTime: NaN, timestamp: Date.now() }),
    getFeeRateQuote: async () => ({ availability: 'unavailable', reason: 'capability_unavailable' }),
    getPositions: async () => { throw new Error('Paper Phoenix has no live account authority'); },
    // Explicit paper simulation inputs. They can never reach live sizing.
    getMaintenanceMarginWeight: () => 0,
    quantizeOrderSize: (_market, size) => size,
  } : getPhoenixAiService()?.analysis(bot as AiTraderBot) ?? {};
  return new Proxy(reads, { get(target, key) {
    if (key === 'protocolName') return 'phoenix';
    if (key in target) return target[key as keyof ProtocolAdapter];
    throw new Error(`Phoenix AI analysis capability unavailable: ${String(key)}`);
  } }) as ProtocolAdapter;
}
