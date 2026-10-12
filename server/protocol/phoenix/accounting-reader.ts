import { accountingId, assertEvent, unsigned, type AccountingEvent, type AccountingTarget, type EventOrder } from './accounting-contract';

/** Structural subset of Rise FillRecord. Never accept another account's row just
 * because the request URL named our trader; validate the decoded trader IDs. */
export interface RiseAccountingFill extends EventOrder {
  traderId: number; traderPdaIndex: number; subaccountIndex: number; marketSymbol: string;
  signature: string | null; fillId: string | null; timestamp: number;
  baseLotsBefore: string; baseLotsAfter: string; baseLotsDelta: string;
  realizedPnl: string | null; fees: string | null;
  orderSequenceNumber: number | null; tradeType: 'limit' | 'market' | 'liquidation' | 'adl';
}
export function usdMicros(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,25})(\.[0-9]{1,6})?$/.test(value)) throw new Error('Inexact USDC history amount');
  const negative = value.startsWith('-'), [whole, decimal = ''] = (negative ? value.slice(1) : value).split('.');
  return ((BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, '0'))) * (negative ? -1n : 1n)).toString();
}
export function mapPhoenixFill(target: AccountingTarget, raw: RiseAccountingFill, evidence: {
  traderId: number; source: string; reference: string; feeTierReference: string | null;
  /** Must be verified against pinned venue semantics, not guessed from the API field name. */
  pnlBasis: 'gross_excluding_fees_and_funding'; feesAreSignedCosts: true;
}): AccountingEvent {
  if (!Number.isSafeInteger(evidence.traderId) || raw.traderId !== evidence.traderId
    || raw.traderPdaIndex !== target.identity.portfolioIndex || raw.subaccountIndex !== target.identity.subaccountIndex
    || evidence.pnlBasis !== 'gross_excluding_fees_and_funding' || evidence.feesAreSignedCosts !== true
    || !raw.signature || !['limit', 'market', 'liquidation', 'adl'].includes(raw.tradeType)
    || (raw.orderSequenceNumber !== null && (!Number.isSafeInteger(raw.orderSequenceNumber) || raw.orderSequenceNumber < 0))) throw new Error('Unverified Phoenix fill binding/semantics');
  if (BigInt(raw.baseLotsAfter) - BigInt(raw.baseLotsBefore) !== BigInt(raw.baseLotsDelta)) throw new Error('Inconsistent fill delta');
  unsigned(raw.slot);
  const id = accountingId([target.identity, raw.marketSymbol, raw.signature, raw.slot, raw.slotIndex, raw.instructionIndex, raw.eventIndex]);
  const e: AccountingEvent = { id, trader: target.identity.traderAccountAddress, market: raw.marketSymbol,
    signature: raw.signature, timestamp: raw.timestamp, slot: raw.slot, slotIndex: raw.slotIndex,
    instructionIndex: raw.instructionIndex, eventIndex: raw.eventIndex,
    source: evidence.source, reference: evidence.reference,
    kind: raw.tradeType === 'liquidation' || raw.tradeType === 'adl' ? raw.tradeType : 'fill',
    beforeLots: raw.baseLotsBefore, afterLots: raw.baseLotsAfter,
    // Native coordinates remain exact identity even when the indexer omits fillId.
    fillId: raw.fillId, orderId: raw.orderSequenceNumber === null ? null : String(raw.orderSequenceNumber), fundingEpochOpeningEventId: null,
    grossPnlMicros: usdMicros(raw.realizedPnl), feeMicros: usdMicros(raw.fees), fundingMicros: '0', feeTierReference: evidence.feeTierReference };
  assertEvent(e, target); return e;
}
