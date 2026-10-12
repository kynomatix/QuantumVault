import { PublicKey } from '@solana/web3.js';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { units } from './funding-contract';

// Explicit project policy, including automatic and breakeven changes. No SDK defaults.
export const PROTECTION_SLIPPAGE_LIMIT_BPS = { tp: 25, sl: 1000 } as const;
export type ProtectionRole = 'tp' | 'sl';
export interface ProtectionPrices {
  tp: { triggerTicks: string; slippageBps: number };
  sl: { triggerTicks: string; slippageBps: number };
}
export interface ProtectionLeg {
  surface: 'conditional' | 'standalone'; index: number; sequence: string;
  assetId: number; parentOrderId: string | null; positionSequence: number;
  side: 'buy' | 'sell'; direction: 'greater' | 'less'; kind: 'IOC' | 'Limit';
  triggerTicks: string; executionTicks: string; remainingLots: string;
  sizePercent: number | null; rawMaxLots: string; rawFillableLots: string; rawFilledLots: string;
}
export interface ProtectionSnapshot {
  venue: 'phoenix'; trader: string; market: string; assetId: number;
  source: string; reference: string; observedAt: number; slot: string;
  finalized: true; complete: true; refreshFailed: false;
  conditionalAccount: string; conditionalExists: boolean; standaloneAccount: string; standaloneFunder: string | null;
  position: { side: 'long' | 'short' | 'flat'; baseLots: string; sequence: number; epoch: string };
  markTicks: string; orderbookOrderIds: string[]; legs: ProtectionLeg[];
  /** Retained for reconciliation; native cancellation has no sequence precondition. */
  collectionSequence: string;
}
export interface ProtectionTarget { identity: PhoenixTraderIdentity; market: string; assetId: number }
export interface ProtectionRequest extends ProtectionTarget {
  botId: string; ownerWallet: string; requestKey: string;
  action: 'replace' | 'breakeven' | 'cancel' | 'pause'; prices?: ProtectionPrices;
}
export type ProtectionCommand = { kind: 'cancel-book' }
  | { kind: 'cancel-conditional'; index: number; sequence: string }
  | { kind: 'cancel-standalone'; direction: 'greater' | 'less'; sequence: string; funder: string }
  | { kind: 'place'; role: ProtectionRole; side: 'buy' | 'sell'; direction: 'greater' | 'less'; triggerTicks: string; executionTicks: string; baseLots: string };
export interface ProtectionTerms { request: ProtectionRequest; before: ProtectionSnapshot; commands: ProtectionCommand[] }
export interface ProtectionProgress {
  step: number; before: ProtectionSnapshot; after: ProtectionSnapshot;
  remainingLegs: ProtectionLeg[]; allOrdersCancelled: boolean; protected: boolean;
  reason?: string;
}
export function protectionAddresses(trader: string, assetId: number) {
  if (!Number.isInteger(assetId) || assetId < 0 || assetId > 0xffffffff) throw new Error('Invalid protection asset');
  const program = new PublicKey(PHOENIX_PUBLIC_ADDRESSES.program), key = new PublicKey(trader), id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(assetId));
  return {
    conditionalAccount: PublicKey.findProgramAddressSync([Buffer.from('conditional_orders'), key.toBuffer()], program)[0].toBase58(),
    standaloneAccount: PublicKey.findProgramAddressSync([Buffer.from('stoploss'), key.toBuffer(), id], program)[0].toBase58(),
  };
}
export function assertProtectionSnapshot(s: ProtectionSnapshot, target: ProtectionTarget, now: number, minimumSlot = '0') {
  assertPhoenixIdentity(target.identity);
  const addresses = protectionAddresses(target.identity.traderAccountAddress, target.assetId);
  if (!s || s.venue !== 'phoenix' || s.trader !== target.identity.traderAccountAddress || s.market !== target.market
    || s.assetId !== target.assetId || s.conditionalAccount !== addresses.conditionalAccount || s.standaloneAccount !== addresses.standaloneAccount
    || s.finalized !== true || s.complete !== true || s.refreshFailed !== false || !s.source || !s.reference
    || !Number.isSafeInteger(s.observedAt) || s.observedAt > now || now - s.observedAt >= 5000
    || units(s.slot) < units(minimumSlot) || !s.position?.epoch || !Number.isInteger(s.position.sequence)
    || s.position.sequence < 0 || s.position.sequence > 65535 || !['long', 'short', 'flat'].includes(s.position.side)
    || (s.position.side === 'flat') !== (units(s.position.baseLots) === 0n)
    || !Array.isArray(s.legs) || !Array.isArray(s.orderbookOrderIds)
    || new Set(s.orderbookOrderIds).size !== s.orderbookOrderIds.length) throw new Error('Protection authority unavailable');
  units(s.collectionSequence); units(s.markTicks);
  const seen = new Set<string>();
  for (const leg of s.legs) {
    const id = `${leg.surface}:${leg.index}:${leg.direction}`;
    if (seen.has(id) || !['conditional', 'standalone'].includes(leg.surface) || !['buy', 'sell'].includes(leg.side)
      || !['greater', 'less'].includes(leg.direction) || !['IOC', 'Limit'].includes(leg.kind)
      || !Number.isInteger(leg.index) || (leg.surface === 'conditional' ? leg.index < 1 || leg.index > 191 : leg.index < 0 || leg.index > 1)
      || !Number.isInteger(leg.assetId) || leg.assetId < 0 || !Number.isInteger(leg.positionSequence)
      || leg.positionSequence < 0 || leg.positionSequence > 65535
      || (leg.sizePercent !== null && (!Number.isInteger(leg.sizePercent) || leg.sizePercent < 1 || leg.sizePercent > 100))
      || units(leg.triggerTicks) === 0n || units(leg.executionTicks) === 0n) throw new Error('Invalid protection leg');
    units(leg.sequence); units(leg.remainingLots); units(leg.rawMaxLots); units(leg.rawFillableLots); units(leg.rawFilledLots);
    seen.add(id);
  }
  if (!s.conditionalExists && s.legs.some(l => l.surface === 'conditional')) throw new Error('Missing conditional account');
  if (s.legs.some(l => l.surface === 'standalone') && !s.standaloneFunder) throw new Error('Missing standalone funder');
}
export function protectionExecutionTicks(role: ProtectionRole, side: 'buy' | 'sell', triggerTicks: string, bps: number) {
  const t = units(triggerTicks);
  if (!t || !Number.isInteger(bps) || bps < 0 || bps > PROTECTION_SLIPPAGE_LIMIT_BPS[role]) throw new Error('Protection slippage outside explicit bound');
  const n = t * BigInt(side === 'buy' ? 10000 + bps : 10000 - bps);
  const price = side === 'buy' ? n / 10000n : (n + 9999n) / 10000n;
  if (!price || price > 18446744073709551615n) throw new Error('Invalid protection execution ticks');
  return price.toString();
}
export function desiredProtection(prices: ProtectionPrices, side: 'long' | 'short', lots: string, markTicks: string): Extract<ProtectionCommand, { kind: 'place' }>[] {
  if (!prices?.tp || !prices?.sl || units(lots) === 0n || units(markTicks) === 0n) throw new Error('Both protection legs required');
  return (['tp', 'sl'] as const).map(role => {
    const direction = (side === 'long') === (role === 'tp') ? 'greater' : 'less';
    const price = prices[role], t = units(price.triggerTicks), mark = units(markTicks);
    if (direction === 'greater' ? t <= mark : t >= mark) throw new Error('Protection trigger already crossed or wrong side');
    const tradeSide = side === 'long' ? 'sell' : 'buy';
    return { kind: 'place', role, side: tradeSide, direction, triggerTicks: price.triggerTicks,
      executionTicks: protectionExecutionTicks(role, tradeSide, price.triggerTicks, price.slippageBps), baseLots: lots };
  });
}
export function matchingLeg(s: ProtectionSnapshot, c: Extract<ProtectionCommand, { kind: 'place' }>) {
  return s.legs.filter(l => l.assetId === s.assetId && l.positionSequence === s.position.sequence && l.side === c.side
    && l.kind === 'IOC' && l.direction === c.direction && l.triggerTicks === c.triggerTicks && l.executionTicks === c.executionTicks
    && l.parentOrderId === null && units(l.remainingLots) === units(s.position.baseLots));
}
export function protectionStatus(s: ProtectionSnapshot, prices?: ProtectionPrices) {
  const stale = s.legs.filter(l => l.assetId === s.assetId && (s.position.side === 'flat'
    || l.positionSequence !== s.position.sequence || l.side !== (s.position.side === 'long' ? 'sell' : 'buy')));
  let protectedPosition = false;
  if (prices && s.position.side !== 'flat' && !stale.length && s.legs.filter(l => l.assetId === s.assetId).length === 2) {
    try { protectedPosition = desiredProtection(prices, s.position.side, s.position.baseLots, s.markTicks).every(c => matchingLeg(s, c).length === 1); } catch { /* Crossed triggers need reconciliation. */ }
  }
  return { protected: protectedPosition, staleLegs: stale,
    orphanLegs: s.legs.filter(l => l.parentOrderId !== null && !s.orderbookOrderIds.includes(l.parentOrderId)),
    remainingLegs: structuredClone(s.legs), allOrdersCancelled: s.orderbookOrderIds.length === 0 && s.legs.filter(l => l.assetId === s.assetId).length === 0 };
}
export function planProtection(request: ProtectionRequest, before: ProtectionSnapshot, now: number): ProtectionTerms {
  assertProtectionSnapshot(before, request, now);
  if (!['replace', 'breakeven', 'cancel', 'pause'].includes(request.action)) throw new Error('Invalid protection action');
  const commands: ProtectionCommand[] = [];
  // Cancel the book first: cancelling parents can change child state. Every next step re-reads it.
  if (request.action === 'pause') commands.push({ kind: 'cancel-book' });
  const indices = new Map<number, string>();
  for (const l of before.legs.filter(l => l.assetId === request.assetId)) {
    if (l.surface === 'conditional') indices.set(l.index, l.sequence);
    else commands.push({ kind: 'cancel-standalone', direction: l.direction, sequence: l.sequence, funder: before.standaloneFunder! });
  }
  commands.push(...[...indices].map(([index, sequence]) => ({ kind: 'cancel-conditional' as const, index, sequence })));
  if (request.action === 'replace' || request.action === 'breakeven') {
    if (before.position.side === 'flat' || !before.conditionalExists) throw new Error('No position or conditional account');
    if (before.orderbookOrderIds.length) throw new Error('Resolve live parent orders before position replacement');
    const desired = desiredProtection(request.prices!, before.position.side, before.position.baseLots, before.markTicks);
    if (request.action === 'breakeven') {
      const stops = before.legs.filter(l => l.assetId === before.assetId && l.positionSequence === before.position.sequence
        && l.direction === (before.position.side === 'long' ? 'less' : 'greater'));
      const next = units(request.prices!.sl.triggerTicks);
      if (stops.some(l => before.position.side === 'long' ? next < units(l.triggerTicks) : next > units(l.triggerTicks))) throw new Error('Breakeven cannot loosen stop');
    }
    // Place SL first, so a failed TP leg retains a stop and explicit evidence of it.
    commands.push(desired[1], desired[0]);
  }
  return structuredClone({ request, before, commands });
}
