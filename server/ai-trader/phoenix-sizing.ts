import type { AiTraderBot } from '@shared/schema';
import type { ClampedDecision } from './guardrails';
import type { PhoenixOrderAuthority, PhoenixOrderIntent } from '../protocol/phoenix/order-contract';
import { admitPhoenixOrder } from '../protocol/phoenix/order-contract';
import { phoenixPriceUsdToTicks } from '../protocol/phoenix/sdk-boundary';
import { assertPhoenixAiBinding } from './phoenix-policy';

function rational(value: string): [bigint, bigint] {
  if (typeof value !== 'string' || !/^[0-9]{1,20}(?:\.[0-9]{1,18})?$/.test(value) || value.includes('\n')) {
    throw new Error('Invalid Phoenix AI decimal');
  }
  const [whole, fraction = ''] = value.split('.');
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}
function micros(value: string): bigint { const [n, d] = rational(value); return n * 1000000n / d; }
function decimalLots(lots: bigint, decimals: number): string {
  if (decimals <= 0) return String(lots * 10n ** BigInt(-decimals));
  const s = String(lots).padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** The context's price, base size, notional and margin have no authority here.
 * Recompute size from the bound mandate and fresh U05 execution price. U05
 * separately proves account fees, lot/tick terms, bracket and actual margin. */
export function buildPhoenixAiEntry(bot: AiTraderBot, decisionId: string, decision: ClampedDecision,
  a: PhoenixOrderAuthority, sequence: string, now: number, equityMicros?: string): PhoenixOrderIntent {
  const binding = assertPhoenixAiBinding(bot);
  if (!['long', 'short'].includes(decision.action) || !Number.isSafeInteger(decision.leverage)
    || decision.leverage! < 1 || decision.leverage! > Math.min(bot.maxLeverage, 5)
    || !Number.isSafeInteger(a.baseLotsDecimals) || Math.abs(a.baseLotsDecimals) > 18
    || a.market !== bot.market || a.price.source !== 'phoenix-execution') throw new Error('Phoenix AI mandate unavailable');
  const leverage = BigInt(decision.leverage!);
  const allocation = micros(bot.allocatedUsdc);
  if (allocation <= 0n) throw new Error('Phoenix AI allocation unavailable');
  const [pn, pd] = rational(a.price.usd);
  if (pn === 0n) throw new Error('Phoenix execution price unavailable');
  const sl = decision.stopLossPrice, tp = decision.takeProfitPrice;
  if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl! <= 0 || tp! <= 0) throw new Error('Phoenix AI bracket unavailable');
  const stop = micros(String(sl)), mark = pn * 1000000n / pd;
  // Repeat the live liquidation buffer using the fresh execution price.
  const distance = decision.action === 'long' ? mark - stop : stop - mark;
  if (distance <= 0n || distance * leverage * 100n >= mark * 95n) throw new Error('Phoenix AI stop outside liquidation buffer');
  let notional: bigint;
  if (bot.sizingMode === 'risk_based') {
    if (!equityMicros || !/^[0-9]{1,30}$/.test(equityMicros) || equityMicros.includes('\n')) throw new Error('Phoenix AI equity unknown');
    const equity = BigInt(equityMicros), base = (equity < allocation ? equity : allocation) * 95n / 100n;
    const min = micros(bot.riskMinPct ?? '0.50'), max = micros(bot.riskMaxPct ?? '1.50');
    if (base <= 0n || min < 100000n || max > 3000000n || min > max
      || !Number.isInteger(decision.confidence) || decision.confidence < 1 || decision.confidence > 10
      || distance * 10000n < mark * 60n) throw new Error('Phoenix AI risk mandate unavailable');
    const riskPct = min + (max - min) * BigInt(decision.confidence - 1) / 9n;
    notional = base * riskPct / 100000000n * mark / distance;
    const ceiling = base * leverage;
    if (notional > ceiling) notional = ceiling;
  } else {
    if (bot.sizingMode !== 'discretionary' || !Number.isFinite(decision.sizePct)
      || decision.sizePct! < 10 || decision.sizePct! > 90) throw new Error('Phoenix AI size mandate unavailable');
    const [n, d] = rational(String(decision.sizePct));
    notional = allocation * n * leverage / (d * 100n);
  }
  // Round down to venue lots; scientific notation never enters a signing intent.
  const scale = 10n ** BigInt(Math.abs(a.baseLotsDecimals));
  const lots = a.baseLotsDecimals >= 0 ? notional * pd * scale / (pn * 1000000n)
    : notional * pd / (pn * 1000000n * scale);
  if (lots <= 0n) throw new Error('Phoenix AI rounded dust');
  const i: PhoenixOrderIntent = { botId: binding.executionBotId, ownerWallet: bot.walletAddress,
    requestKey: `ai:entry:${decisionId}`, identity: binding.identity, market: bot.market, sequence,
    action: 'entry', side: decision.action === 'long' ? 'buy' : 'sell', baseUnits: decimalLots(lots, a.baseLotsDecimals),
    leverage: String(leverage), maxNotionalMicros: String(allocation * BigInt(bot.maxLeverage)),
    fillPolicy: 'IOC', minFillLots: '0', slippageBps: 30, expiresAt: now + 30000,
    lastValidSlot: String(BigInt(a.slot) + 100n), protection: {
      tp: { triggerTicks: String(phoenixPriceUsdToTicks(String(tp), a)), slippageBps: 25 },
      sl: { triggerTicks: String(phoenixPriceUsdToTicks(String(sl), a)), slippageBps: 1000 },
    } };
  admitPhoenixOrder(i, a, now);
  return i;
}

/** Confirmed fills, never the decision context or order acknowledgement. */
export function phoenixAiFill(order: import('../protocol/phoenix/order-store').PhoenixOrderRecord) {
  if (!['landed', 'settled'].includes(order.state) || !order.data.orderId || !order.data.positionEpoch
    || !order.data.outcomeSource || !order.data.outcomeReference || !order.data.fills?.length) throw new Error('Phoenix AI fill unknown');
  const ids = new Set<string>();
  let lots = 0n, quote = 0n, fees = 0n;
  for (const f of order.data.fills) {
    if (!f.fillId || ids.has(f.fillId) || f.orderId !== order.data.orderId) throw new Error('Phoenix AI fill identity mismatch');
    ids.add(f.fillId);
    for (const n of [f.baseLots, f.quoteMicros, f.feeMicros]) if (!/^[0-9]{1,30}$/.test(n) || n.includes('\n')) throw new Error('Phoenix AI fill malformed');
    lots += BigInt(f.baseLots); quote += BigInt(f.quoteMicros); fees += BigInt(f.feeMicros);
  }
  if (lots <= 0n || quote <= 0n) throw new Error('Phoenix AI fill empty');
  const decimals = order.data.admission.authority.baseLotsDecimals;
  const sizeBase = Number(decimalLots(lots, decimals)), entryPrice = Number(quote) / 1000000 / sizeBase;
  if (!Number.isFinite(sizeBase) || !Number.isFinite(entryPrice) || sizeBase <= 0 || entryPrice <= 0) throw new Error('Phoenix AI fill overflow');
  return { entryPrice, sizeBase, fee: Number(fees) / 1000000, lots: String(lots) };
}
