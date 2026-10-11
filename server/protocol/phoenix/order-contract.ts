import { createHash } from 'node:crypto';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { units } from './funding-contract';
import { PHOENIX_PUBLIC_ADDRESSES, phoenixBaseUnitsToLots, phoenixPriceUsdToTicks } from './sdk-boundary';
import { assertProtectionSnapshot, desiredProtection, type ProtectionPrices, type ProtectionSnapshot } from './protection-contract';

export interface PhoenixOrderIntent {
  botId: string; ownerWallet: string; requestKey: string;
  identity: PhoenixTraderIdentity; market: string;
  /** Monotonic strategy sequence, shared by manual/signal/close ingress. Never arrival time. */
  sequence: string; action: 'entry' | 'close'; side: 'buy' | 'sell';
  baseUnits: string; leverage: string; maxNotionalMicros: string;
  fillPolicy: 'IOC' | 'FOK'; minFillLots: string; slippageBps: number;
  expiresAt: number; lastValidSlot: string;
  protection?: ProtectionPrices;
}
export interface PhoenixOrderAuthority {
  venue: 'phoenix'; trader: string; market: string; assetId: number; collateralMint: string;
  source: string; reference: string; observedAt: number; refreshFailed: boolean;
  status: 'active' | 'reduce_only' | 'halted'; isolatedOnly: boolean;
  tickSize: string; baseLotsDecimals: number;
  price: { usd: string; observedAt: number; source: 'phoenix-execution'; reference: string };
  slot: string;
  /** Entry authority is deliberately separable from exit execution metadata. */
  entry: null | { observedAt: number; minimumNotionalMicros: string; maxNotionalMicros: string;
    maxLeverage: string; takerFeePpm: string; feeReference: string; feeObservedAt: number;
    freeMarginMicros: string; fundableMicros: string; marginObservedAt: number };
  position: { observedAt: number; side: 'long' | 'short' | 'flat'; baseLots: string; epoch: string };
  protection?: ProtectionSnapshot;
}
export interface PhoenixOrderPacket {
  side: 'buy' | 'sell'; priceInTicks: string; numBaseLots: string; minBaseLotsToFill: string;
  minQuoteLotsToFill: '0'; numQuoteLots: null; selfTradeBehavior: 'Abort'; matchLimit: null;
  clientOrderId: string; lastValidSlot: string; orderFlags: 0 | 128; cancelExisting: false;
}
export interface PhoenixAdmission {
  packet: PhoenixOrderPacket; authority: PhoenixOrderAuthority;
  notionalMicros: string; requiredMarginMicros: string; fundingShortfallMicros: string;
}
export function orderIntentHash(value: unknown): string {
  function canonical(v: any): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    // PostgreSQL JSON drops undefined optional object fields. Hash the same shape
    // so a close with omitted protection retains its identity after restart.
    if (v && typeof v === 'object') return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function validateOrderIntent(i: PhoenixOrderIntent): void {
  assertPhoenixIdentity(i.identity);
  for (const value of [i.botId, i.ownerWallet, i.requestKey, i.market]) {
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(value) || value.includes('\n')) throw new Error('Invalid order identity');
  }
  if (!['entry', 'close'].includes(i.action) || !['buy', 'sell'].includes(i.side)
    || !['IOC', 'FOK'].includes(i.fillPolicy) || !Number.isInteger(i.slippageBps) || i.slippageBps < 0 || i.slippageBps > 1000
    || !Number.isSafeInteger(i.expiresAt) || units(i.sequence) === 0n || units(i.lastValidSlot) === 0n
    || units(i.leverage) === 0n || units(i.maxNotionalMicros) === 0n) throw new Error('Invalid order policy');
  units(i.minFillLots);
  if (phoenixBaseUnitsToLots(i.baseUnits, 18) === 0n) throw new Error('Invalid base quantity');
}
function fresh(observedAt: number, now: number, ttl = 5000) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(observedAt) || observedAt > now || now - observedAt >= ttl) throw new Error('Phoenix authority stale');
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** No defaults, display caches, Pacifica helpers, floating point quantities or global allowlist. */
export function admitPhoenixOrder(input: PhoenixOrderIntent, snapshot: PhoenixOrderAuthority, now: number,
  funded = false): PhoenixAdmission {
  const i = structuredClone(input), a = structuredClone(snapshot); validateOrderIntent(i);
  if (now >= i.expiresAt || i.expiresAt - now > 60_000 || units(i.lastValidSlot) <= units(a.slot)
    || units(i.lastValidSlot) - units(a.slot) > 150n) throw new Error('Order expired or lifetime too wide');
  if (a.venue !== 'phoenix' || a.trader !== i.identity.traderAccountAddress || a.market !== i.market
    || a.collateralMint !== PHOENIX_PUBLIC_ADDRESSES.usdcMint || !a.source || !a.reference || a.refreshFailed
    || !Number.isInteger(a.assetId) || a.assetId < 0 || !['active', 'reduce_only'].includes(a.status)
    || a.isolatedOnly !== false) throw new Error('Phoenix market authority unavailable');
  fresh(a.observedAt, now); fresh(a.price.observedAt, now); fresh(a.position.observedAt, now);
  if (a.price.source !== 'phoenix-execution' || !a.price.reference || !a.position.epoch) throw new Error('Phoenix price/position unknown');
  const lots = phoenixBaseUnitsToLots(i.baseUnits, a.baseLotsDecimals);
  if (lots === 0n || lots > 18446744073709551615n) throw new Error('Rounded dust or quantity overflow');
  if (i.action === 'entry') {
    const protection = a.protection;
    if (!protection || !i.protection) throw new Error('Phoenix entry protection unknown');
    assertProtectionSnapshot(protection, { identity: i.identity, market: i.market, assetId: a.assetId }, now, a.slot);
    if (protection.slot !== a.slot || !protection.conditionalExists || protection.position.side !== 'flat'
      || protection.position.epoch !== a.position.epoch || protection.orderbookOrderIds.length
      || protection.legs.some(l => l.assetId === a.assetId)) throw new Error('Phoenix entry protection unresolved');
    desiredProtection(i.protection, i.side === 'buy' ? 'long' : 'short', lots.toString(), protection.markTicks);
  }
  // Price conversion is exact rational arithmetic; round buy DOWN / sell UP to stay inside slippage.
  const parts = a.price.usd.split('.');
  if (!/^\d+(\.\d+)?$/.test(a.price.usd) || a.price.usd.length > 60) throw new Error('Invalid execution price');
  const scale = 10n ** BigInt((parts[1] || '').length);
  const numerator = BigInt(parts.join('')) * 1_000_000n;
  const decimals = a.baseLotsDecimals;
  // Validate lot decimals and tick before exponentiation.
  phoenixPriceUsdToTicks(a.price.usd, a);
  const tickNumerator = units(a.tickSize) * (decimals >= 0 ? 10n ** BigInt(decimals) : 1n);
  const tickDenominator = decimals < 0 ? 10n ** BigInt(-decimals) : 1n;
  if (tickNumerator === 0n || numerator === 0n) throw new Error('Zero price/tick');
  const bps = BigInt(i.slippageBps);
  const n = numerator * tickDenominator * (i.side === 'buy' ? 10000n + bps : 10000n - bps);
  const d = scale * tickNumerator * 10000n;
  const ticks = i.side === 'buy' ? n / d : ceil(n, d);
  if (ticks === 0n || ticks > 18446744073709551615n) throw new Error('Invalid price ticks');
  const min = units(i.minFillLots);
  if (min > lots || (i.fillPolicy === 'FOK' && min !== lots)) throw new Error('Explicit minimum fill mismatch');
  const markNumerator = lots * numerator * (decimals < 0 ? 10n ** BigInt(-decimals) : 1n);
  const markDenominator = scale * (decimals >= 0 ? 10n ** BigInt(decimals) : 1n);
  const markNotional = ceil(markNumerator, markDenominator);
  const limitNotional = lots * ticks * units(a.tickSize);
  const notional = markNotional > limitNotional ? markNotional : limitNotional;
  let margin = 0n, shortfall = 0n;
  if (i.action === 'entry') {
    const e = a.entry;
    if (a.status !== 'active' || !e || !e.feeReference || a.position.side !== 'flat' || units(a.position.baseLots) !== 0n) throw new Error('Entry authority unavailable or exposure exists');
    fresh(e.observedAt, now); fresh(e.feeObservedAt, now); fresh(e.marginObservedAt, now);
    const leverage = units(i.leverage), maximum = units(e.maxLeverage), fee = units(e.takerFeePpm);
    const minimum = units(e.minimumNotionalMicros);
    if (minimum === 0n || units(e.maxNotionalMicros) === 0n || leverage > maximum || fee > 1_000_000n
      || markNumerator < minimum * markDenominator || limitNotional < minimum || notional > units(e.maxNotionalMicros)
      || notional > units(i.maxNotionalMicros)) throw new Error('Phoenix minimum, leverage, fee or size limit');
    margin = ceil(notional, leverage) + ceil(notional * fee, 1_000_000n);
    const free = units(e.freeMarginMicros);
    shortfall = margin > free ? margin - free : 0n;
    if (shortfall > (funded ? 0n : units(e.fundableMicros))) throw new Error('Unknown or insufficient margin');
  } else {
    if (!['long', 'short'].includes(a.position.side) || (a.position.side === 'long' ? i.side !== 'sell' : i.side !== 'buy')
      || lots > units(a.position.baseLots)) throw new Error('Close must reduce the observed position');
  }
  return { authority: a, notionalMicros: notional.toString(), requiredMarginMicros: margin.toString(), fundingShortfallMicros: shortfall.toString(),
    packet: { side: i.side, priceInTicks: ticks.toString(), numBaseLots: lots.toString(), minBaseLotsToFill: min.toString(),
      minQuoteLotsToFill: '0', numQuoteLots: null, selfTradeBehavior: 'Abort', matchLimit: null,
      clientOrderId: BigInt(`0x${orderIntentHash(i).slice(0, 32)}`).toString(), lastValidSlot: i.lastValidSlot,
      orderFlags: i.action === 'close' ? 128 : 0, cancelExisting: false } };
}
