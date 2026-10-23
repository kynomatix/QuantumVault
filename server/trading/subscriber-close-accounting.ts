import DecimalJs from 'decimal.js';
const Decimal = DecimalJs.clone({ precision: 48 });
import type { ProtocolAdapter } from '../protocol/adapter';
import type { CloseResult, CloseSnapshot } from '../protocol/close-outcome';
import type { TradeRecord } from '../protocol/protocol-types';

/** Close-only net PnL; entry fees, funding and subscription HWM belong to U4. */
export interface SubscriberCloseAccounting {
  version: 1;
  account: string;
  market: string;
  orderId: string | null;
  outcome: CloseResult['outcome'];
  size: string | null;
  price: string | null;
  fee: string | null;
  pnl: string | null;
  volume: string | null;
  entryPrice: string | null;
  fillIds: string[];
  timestamp: number | null;
  reason: string | null;
  pnlConvention: 'net_of_close_fee';
  /** Original observation and request identity survive delayed history/restarts. */
  recovery?: Omit<SubscriberCloseEvidenceInput, 'trades' | 'observedAt'>;
}

export interface SubscriberCloseEvidenceInput {
  account: string;
  market: string;
  orderId?: string;
  openSide: 'long' | 'short';
  requestedSize: number;
  sentAt: number;
  observedAt: number;
  baseline?: CloseSnapshot;
  closeResult?: CloseResult;
  trades: TradeRecord[];
}

/** The history reader is account-scoped; order, market, direction and time all
 * have to agree. Never consume adapter submit prices or unlabelled venue PnL. */
export function subscriberCloseAccounting(input: SubscriberCloseEvidenceInput): SubscriberCloseAccounting {
  const result: SubscriberCloseAccounting = {
    version: 1, account: input.account, market: input.market, orderId: input.orderId ?? null,
    outcome: input.closeResult?.outcome ?? 'unknown', size: null, price: null, fee: null,
    pnl: null, volume: null, entryPrice: null, fillIds: [], timestamp: null,
    reason: 'attributable_close_fills_unavailable', pnlConvention: 'net_of_close_fee',
    recovery: { account: input.account, market: input.market, orderId: input.orderId,
      openSide: input.openSide, requestedSize: input.requestedSize, sentAt: input.sentAt,
      baseline: input.baseline, closeResult: input.closeResult },
  };
  const unavailable = (reason: string) => ({ ...result, reason });
  if (!input.account || !input.orderId || !Number.isFinite(input.sentAt)
    || !Number.isFinite(input.observedAt) || input.observedAt < input.sentAt
    || !Number.isFinite(input.requestedSize) || input.requestedSize <= 0
    || !['long', 'short'].includes(input.openSide)) return unavailable('invalid_close_identity');
  const rows = input.trades.filter(row => row.orderId === input.orderId);
  if (!rows.length) return result;
  const closeSide = input.openSide === 'long' ? 'short' : 'long';
  const closeKind = input.openSide === 'long' ? 'close_long' : 'close_short';
  const ids = new Set<string>();
  let size = new Decimal(0), notional = new Decimal(0), fee = new Decimal(0);
  let exactFee = true;
  for (const row of rows) {
    if (!row.tradeId?.trim() || ids.has(row.tradeId) || row.internalSymbol !== input.market
      || row.side !== closeSide || (row.venueEventKind && row.venueEventKind !== closeKind)
      || (row.subaccountId && row.subaccountId !== input.account)
      || !Number.isFinite(row.timestamp) || row.timestamp < input.sentAt || row.timestamp > input.observedAt
      || !Number.isFinite(row.size) || row.size <= 0 || !Number.isFinite(row.price) || row.price <= 0) {
      return unavailable('ambiguous_or_invalid_close_fills');
    }
    ids.add(row.tradeId);
    size = size.plus(row.size);
    notional = notional.plus(new Decimal(row.size).times(row.price));
    if (typeof row.fee !== 'number' || !Number.isFinite(row.fee) || row.fee < 0) exactFee = false;
    else fee = fee.plus(row.fee);
  }
  // Decimal comparisons prevent a fuzzy 95% match from becoming complete economics.
  if (size.gt(input.requestedSize)) return unavailable('close_fill_quantity_exceeds_request');
  result.size = size.toFixed();
  result.price = notional.div(size).toFixed();
  result.volume = notional.toFixed();
  result.fee = exactFee ? fee.toFixed() : null;
  result.fillIds = [...ids].sort();
  result.timestamp = Math.max(...rows.map(row => row.timestamp));
  const close = input.closeResult;
  if (close?.account !== input.account || close.market !== input.market || close.outcome !== 'confirmed') {
    return unavailable('close_not_confirmed');
  }
  if (!size.eq(input.requestedSize)) return unavailable('close_fill_coverage_incomplete');
  const baseline = input.baseline;
  const position = baseline?.positions.find(row => row.internalSymbol === input.market);
  if (!baseline || baseline.evidence.account !== input.account
    || close.baseline?.requestId !== baseline.evidence.requestId
    || !position || !Number.isFinite(position.baseSize)
    || (position.baseSize > 0) !== (input.openSide === 'long')
    || !new Decimal(position.baseSize).abs().eq(input.requestedSize)
    || !Number.isFinite(position.entryPrice) || position.entryPrice <= 0) {
    return unavailable('confirmed_entry_basis_unavailable');
  }
  result.entryPrice = String(position.entryPrice);
  if (!exactFee) return unavailable('exact_close_fee_unavailable');
  const entryNotional = size.times(position.entryPrice);
  const gross = input.openSide === 'long' ? notional.minus(entryNotional) : entryNotional.minus(notional);
  result.pnl = gross.minus(fee).toFixed();
  result.reason = null;
  return result;
}

export async function readSubscriberCloseAccounting(
  adapter: ProtocolAdapter, input: Omit<SubscriberCloseEvidenceInput, 'trades' | 'observedAt'>,
): Promise<SubscriberCloseAccounting> {
  let trades: TradeRecord[] = [];
  if (adapter.protocolName === 'pacifica' && input.orderId) {
    try {
      trades = await adapter.getTradeHistory(input.account, {
        internalSymbol: input.market, startTime: input.sentAt, endTime: Date.now(), limit: 200, maxPages: 10,
      });
    } catch { /* A submitted close is never retried because history is unavailable. */ }
  }
  return subscriberCloseAccounting({ ...input, trades, observedAt: Date.now() });
}

/** Shared persistence seam for full, FLIP and partial subscriber closes. Required
 * numeric columns use a labelled placeholder only when no fill was observed. */
export function subscriberClosePersistence(accounting: SubscriberCloseAccounting) {
  return {
    size: accounting.size ?? '0', price: accounting.price ?? '0', fee: accounting.fee, pnl: accounting.pnl,
    webhookPayload: {
      subscriberCloseAccounting: accounting,
      closeAccounting: accounting.reason
        ? { kind: 'unavailable', reason: accounting.reason, observedAt: accounting.timestamp ?? Date.now() }
        : { kind: 'venue_exact', protocolFillId: accounting.orderId, fillPrice: accounting.price,
            fee: accounting.fee, pnl: accounting.pnl, pnlConvention: accounting.pnlConvention },
      priceRole: accounting.price === null ? 'unavailable_placeholder' : 'venue_fill',
      sizeRole: accounting.size === null ? 'unavailable_placeholder' : 'venue_fill',
    },
    pnlDelta: accounting.pnl === null ? 0 : Number(accounting.pnl),
    volumeDelta: accounting.pnl === null ? 0 : Number(accounting.volume),
    shareEligible: accounting.reason === null && accounting.outcome === 'confirmed'
      && accounting.pnl !== null && new Decimal(accounting.pnl).gt(0),
  };
}

/** Candidate money for the existing partial-position authority/CAS boundary.
 * This is never a payable full close; no deltas are applied until that boundary
 * independently confirms the exact actual reduction and locks the entry epoch. */
export function subscriberPartialExecution(accounting: SubscriberCloseAccounting) {
  const input = accounting.recovery;
  const position = input?.baseline?.positions.find(row => row.internalSymbol === accounting.market);
  const incomplete = { price: accounting.price === null ? null : Number(accounting.price),
    fee: accounting.fee === null ? null : Number(accounting.fee), pnl: null as number | null };
  if (accounting.outcome !== 'partial' || accounting.reason !== 'close_not_confirmed'
      || !input || input.baseline?.evidence.account !== accounting.account
      || !position || !Number.isFinite(position.baseSize) || position.baseSize === 0
      || (position.baseSize > 0) !== (input.openSide === 'long')
      || !Number.isFinite(position.entryPrice) || position.entryPrice <= 0
      || accounting.size === null || accounting.price === null || accounting.fee === null
      || !accounting.fillIds.length || new Decimal(accounting.size).gte(Math.abs(position.baseSize))) return incomplete;
  const gross = new Decimal(accounting.price).minus(position.entryPrice)
    .times(accounting.size).times(input.openSide === 'long' ? 1 : -1);
  return { ...incomplete, pnl: gross.minus(accounting.fee).toNumber() };
}
