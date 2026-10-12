import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { assertProtectionSnapshot, protectionAddresses, type ProtectionLeg, type ProtectionSnapshot, type ProtectionTarget } from './protection-contract';

/** Structural subset of the pinned Rise decoders. Inputs must come from one finalized
 * getMultipleAccounts context, including trader, book, collection and StopLosses.
 * A missing account is explicit null; a failed/missing API page is NEVER null. */
interface Trigger {
  triggerPrice: bigint; executionPrice: bigint; positionSequenceNumber: number; isActive: boolean;
  executionDirection: number; tradeSide: number; orderKind: number;
}
export interface DecodedProtectionAccounts {
  context: { slot: string; observedAt: number; source: string; reference: string; finalized: true; complete: true; refreshFailed: false };
  position: ProtectionSnapshot['position']; markTicks: string; orderbookOrderIds: string[];
  collection: null | { address: string; owner: string; header: { traderKey: string; sequenceNumber: bigint; len: number; capacity: number };
    activeOrderIndices: number[]; orders: { sequenceNumber: bigint; orderId: { priceInTicks: bigint; orderSequenceNumber: bigint } | null;
      maxSize: bigint; fillableSize: bigint; filledSize: bigint; assetId: number; usePercent: boolean; percent: number;
      isActive: boolean; greaterTriggerOrder: Trigger; lessTriggerOrder: Trigger }[] };
  standalone: null | { address: string; owner: string; traderKey: string; assetId: bigint; fundingKey: string; isInitialized: boolean;
    stopLosses: (Trigger & { sequenceNumber: bigint; tradeSize: bigint })[] };
}
export function readProtectionAccounts(target: ProtectionTarget, input: DecodedProtectionAccounts, now: number): ProtectionSnapshot {
  const a = structuredClone(input), addresses = protectionAddresses(target.identity.traderAccountAddress, target.assetId), legs: ProtectionLeg[] = [];
  const min = (x: bigint, y: bigint) => x < y ? x : y;
  const trigger = (t: Trigger) => {
    if (![0, 1].includes(t.executionDirection) || ![0, 1].includes(t.tradeSide) || ![0, 1].includes(t.orderKind)) throw new Error('Unknown trigger enum');
    return { positionSequence: t.positionSequenceNumber, side: t.tradeSide === 0 ? 'buy' as const : 'sell' as const,
      direction: t.executionDirection === 0 ? 'greater' as const : 'less' as const, kind: t.orderKind === 0 ? 'IOC' as const : 'Limit' as const,
      triggerTicks: t.triggerPrice.toString(), executionTicks: t.executionPrice.toString() };
  };
  const c = a.collection;
  if (c) {
    if (c.address !== addresses.conditionalAccount || c.owner !== PHOENIX_PUBLIC_ADDRESSES.program || c.header.traderKey !== target.identity.traderAccountAddress
      || c.header.capacity !== c.orders.length || c.header.len !== c.activeOrderIndices.length
      || new Set(c.activeOrderIndices).size !== c.activeOrderIndices.length
      || c.orders.some((o, i) => o.isActive !== c.activeOrderIndices.includes(i))) throw new Error('Incomplete conditional collection');
    for (const index of c.activeOrderIndices) {
      const o = c.orders[index];
      if (!o || index < 1 || index > 191 || !o.isActive || o.filledSize < 0n || o.fillableSize < o.filledSize
        || o.maxSize < o.fillableSize || (o.usePercent && (!Number.isInteger(o.percent) || o.percent < 1 || o.percent > 100))) throw new Error('Invalid conditional quantity');
      const available = o.usePercent && o.orderId === null ? BigInt(a.position.baseLots) * BigInt(o.percent) / 100n : min(o.maxSize, o.fillableSize) - o.filledSize;
      for (const t of [o.greaterTriggerOrder, o.lessTriggerOrder]) if (t.isActive) legs.push({
        surface: 'conditional', index, sequence: o.sequenceNumber.toString(), assetId: o.assetId,
        parentOrderId: o.orderId ? `${o.orderId.priceInTicks}:${o.orderId.orderSequenceNumber}` : null,
        remainingLots: min(available, BigInt(a.position.baseLots)).toString(), sizePercent: o.usePercent ? o.percent : null,
        rawMaxLots: o.maxSize.toString(), rawFillableLots: o.fillableSize.toString(), rawFilledLots: o.filledSize.toString(), ...trigger(t),
      });
    }
  }
  const standalone = a.standalone;
  if (standalone) {
    if (standalone.address !== addresses.standaloneAccount || standalone.owner !== PHOENIX_PUBLIC_ADDRESSES.program
      || standalone.traderKey !== target.identity.traderAccountAddress || standalone.assetId !== BigInt(target.assetId)
      || !standalone.isInitialized || standalone.stopLosses.length !== 2) throw new Error('Invalid standalone account');
    standalone.stopLosses.forEach((s, index) => {
      if (s.isActive) legs.push({ surface: 'standalone', index, sequence: s.sequenceNumber.toString(), assetId: target.assetId,
        parentOrderId: null, sizePercent: null, remainingLots: min(s.tradeSize, BigInt(a.position.baseLots)).toString(),
        rawMaxLots: s.tradeSize.toString(), rawFillableLots: s.tradeSize.toString(), rawFilledLots: '0', ...trigger(s) });
    });
  }
  const result: ProtectionSnapshot = { venue: 'phoenix', trader: target.identity.traderAccountAddress, market: target.market, assetId: target.assetId,
    ...a.context, ...addresses, conditionalExists: c !== null, standaloneFunder: standalone?.fundingKey ?? null,
    collectionSequence: c?.header.sequenceNumber.toString() ?? '0', position: a.position, markTicks: a.markTicks,
    orderbookOrderIds: a.orderbookOrderIds, legs };
  assertProtectionSnapshot(result, target, now); return result;
}
