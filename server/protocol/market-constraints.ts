import Decimal from 'decimal.js';

/** Pacifica /info authority. A copied observation retains its original clock. */
export interface MarketConstraintObservation {
  venue: 'pacifica';
  market: string;
  source: '/info';
  observedAt: number;
  expiresAt: number;
  refreshFailed: boolean;
  tick: DecimalConstraint | null;
  lot: DecimalConstraint | null;
  openingMinimum: DecimalConstraint | null;
}

export interface DecimalConstraint {
  exact: string;
  value: number;
  unit: 'USD' | 'base' | 'price';
}

export type ConstraintRejectionCode =
  | 'mark_price_unavailable'
  | 'exit_position_sources_exhausted'
  | 'constraint_unavailable'
  | 'constraint_expired'
  | 'price_unavailable'
  | 'invalid_intended_order'
  | 'below_opening_minimum';

export type ConstraintAdmission =
  | { ok: true }
  | { ok: false; code: ConstraintRejectionCode; reason: string; candidate?: OpeningPriceCandidateName; floorUsd?: number; sourcesAttempted?: string[]; missing?: string[]; httpStatus?: number };

export class ConstraintAdmissionError extends Error {
  constructor(readonly rejection: Extract<ConstraintAdmission, { ok: false }>) {
    super(rejection.reason);
    this.name = 'ConstraintAdmissionError';
  }
}

export type OpeningPriceCandidateName = 'limit' | 'mark' | 'trigger';

// H.53 M2 production sampling is required before changing this conservative bound.
export const MARK_MAX_AGE_MS = 5_000;
const ENTRY_AGE_MS = 5 * 60 * 1000;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Reject prefixes, whitespace, wrong types and non-finite or nonpositive values. */
export function parseVenueDecimal(raw: unknown, unit: DecimalConstraint['unit']): DecimalConstraint | null {
  if (typeof raw !== 'string' || raw.trim() !== raw || !DECIMAL.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? { exact: raw, value, unit } : null;
}

export function observePacificaConstraints(raw: {
  tick_size?: unknown;
  lot_size?: unknown;
  min_order_size?: unknown;
}, market: string, observedAt: number): MarketConstraintObservation {
  return {
    venue: 'pacifica', market, source: '/info', observedAt,
    expiresAt: observedAt + ENTRY_AGE_MS, refreshFailed: false,
    tick: parseVenueDecimal(raw.tick_size, 'price'),
    lot: parseVenueDecimal(raw.lot_size, 'base'),
    openingMinimum: parseVenueDecimal(raw.min_order_size, 'USD'),
  };
}

export function checkEntryConstraints(
  observation: MarketConstraintObservation | null | undefined,
  market: string,
  now: number,
): ConstraintAdmission {
  if (!observation || observation.venue !== 'pacifica' || observation.source !== '/info'
      || observation.market !== market || observation.refreshFailed
      || !observation.tick || !observation.lot || !observation.openingMinimum) {
    return { ok: false, code: 'constraint_unavailable', reason: `${market}: complete Pacifica /info constraints unavailable` };
  }
  if (!Number.isFinite(now) || !Number.isFinite(observation.observedAt) || observation.observedAt > now
      || now > observation.expiresAt || observation.expiresAt !== observation.observedAt + ENTRY_AGE_MS) {
    return { ok: false, code: 'constraint_expired', reason: `${market}: Pacifica /info observation expired` };
  }
  return { ok: true };
}

export interface OpeningPriceCandidates {
  /** The final quantity and price values that will be signed. */
  quantityBase: number;
  kind: 'market' | 'limit' | 'stop_market' | 'stop_limit';
  limit?: number;
  mark?: number | string;
  trigger?: number;
  reduceOnly?: boolean;
}

function openingPrices(order: Pick<OpeningPriceCandidates, 'kind' | 'mark' | 'limit' | 'trigger'>):
  Array<[OpeningPriceCandidateName, number | string | undefined]> {
  const candidates: Array<[OpeningPriceCandidateName, number | string | undefined]> = [['mark', order.mark]];
  if (order.kind === 'limit' || order.kind === 'stop_limit') candidates.push(['limit', order.limit]);
  if (order.kind === 'stop_market' || order.kind === 'stop_limit') candidates.push(['trigger', order.trigger]);
  return candidates;
}

/** Strictest H.29 valuation price for a pre-intent Signal sizing bump. */
export function minimumOpeningPriceForSizing(
  order: Pick<OpeningPriceCandidates, 'kind' | 'mark' | 'limit' | 'trigger'>,
): number | null {
  const prices = openingPrices(order).map(([, price]) => price === undefined ? undefined : Number(price));
  return prices.every((price): price is number => price !== undefined && Number.isFinite(price) && price > 0)
    ? Math.min(...prices) : null;
}

/** H.29: mark, plus a limit or stop's own signed price, must clear the USD floor. */
export function evaluateOpeningMinimum(
  order: OpeningPriceCandidates,
  floorUsd: number | string,
): ConstraintAdmission {
  if (order.reduceOnly) return { ok: true };
  const floorValue = Number(floorUsd);
  if (!Number.isFinite(order.quantityBase) || order.quantityBase <= 0
      || !Number.isFinite(floorValue) || floorValue <= 0) {
    return { ok: false, code: 'invalid_intended_order', reason: 'Opening quantity or USD floor is invalid' };
  }
  const candidates = openingPrices(order);
  for (const [name, price] of candidates) {
    if (price === undefined || !Number.isFinite(Number(price)) || Number(price) <= 0) {
      return { ok: false, code: 'price_unavailable', candidate: name, floorUsd: floorValue,
        reason: `${name} price unavailable; opening floor $${floorUsd}` };
    }
    const candidateUsd = new Decimal(order.quantityBase).times(new Decimal(price));
    if (candidateUsd.lessThan(new Decimal(floorUsd))) {
      return { ok: false, code: 'below_opening_minimum', candidate: name, floorUsd: floorValue,
        reason: `${name} values opening at $${candidateUsd.toString()}, below floor $${floorUsd}` };
    }
  }
  return { ok: true };
}

export function isValidMultiple(value: number, step: number | string): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const increment = new Decimal(step);
  return increment.isFinite() && increment.greaterThan(0)
    && new Decimal(String(value)).mod(increment).isZero();
}

export type MarkUnavailableReason = 'capability_missing' | 'quota_unavailable' | 'rate_limited'
  | 'transport_failed' | 'http_error' | 'invalid_envelope' | 'symbol_missing' | 'symbol_ambiguous'
  | 'invalid_mark' | 'invalid_timestamp' | 'future_timestamp' | 'clock_regression' | 'stale';
interface MarkProvenance {
  venue: 'pacifica'; internalSymbol: string; protocolSymbol: string;
  source: '/info/prices'; field: 'mark';
}
export type MarkPriceAuthority = (MarkProvenance & {
  kind: 'available'; exact: string; observedAt: number; receivedAt: number; expiresAt: number;
}) | (MarkProvenance & {
  kind: 'unavailable'; code: 'mark_price_unavailable'; candidate: 'mark';
  reason: MarkUnavailableReason; httpStatus?: number; floorUsd?: number;
});

export function unavailableMark(internalSymbol: string, protocolSymbol: string,
  reason: MarkUnavailableReason, httpStatus?: number): Extract<MarkPriceAuthority, { kind: 'unavailable' }> {
  return { kind: 'unavailable', code: 'mark_price_unavailable', candidate: 'mark', venue: 'pacifica',
    internalSymbol, protocolSymbol, source: '/info/prices', field: 'mark', reason,
    ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function checkMarkPrice(mark: MarkPriceAuthority, internalSymbol: string, now: number): MarkPriceAuthority {
  if (mark.kind === 'unavailable') return mark;
  const fail = (reason: MarkUnavailableReason) => unavailableMark(internalSymbol, mark.protocolSymbol, reason);
  if (mark.venue !== 'pacifica' || mark.source !== '/info/prices' || mark.field !== 'mark'
      || mark.internalSymbol !== internalSymbol || !mark.protocolSymbol) return fail('symbol_missing');
  if (!parseVenueDecimal(mark.exact, 'price')) return fail('invalid_mark');
  if (!Number.isSafeInteger(mark.observedAt) || mark.observedAt < 0
      || !Number.isSafeInteger(mark.receivedAt) || !Number.isSafeInteger(now)
      || mark.expiresAt !== mark.observedAt + MARK_MAX_AGE_MS)
    return fail('invalid_timestamp');
  if (now < mark.receivedAt) return fail('clock_regression');
  if (now < mark.observedAt) return fail('future_timestamp');
  if (now > mark.expiresAt) return fail('stale');
  return mark;
}

export async function acquireMarkPrice(adapter: {
  getMarkPrice?: (symbol: string) => Promise<MarkPriceAuthority>;
}, market: string): Promise<MarkPriceAuthority> {
  if (!adapter.getMarkPrice) return unavailableMark(market, '', 'capability_missing');
  try { return checkMarkPrice(await adapter.getMarkPrice(market), market, Date.now()); }
  catch { return unavailableMark(market, '', 'transport_failed'); }
}

/** Check the same Pacifica authority immediately before an opening-side effect. */
export async function checkOpeningEffectAuthority(
  adapter: Pick<import('./adapter').ProtocolAdapter, 'protocolName' | 'getMarkets' | 'getMarkPrice'>,
  market: string,
): Promise<ConstraintAdmission> {
  if (adapter.protocolName !== 'pacifica') return { ok: true };
  let row: import('./protocol-types').ProtocolMarket | undefined;
  try {
    row = (await adapter.getMarkets()).find(candidate => candidate.internalSymbol === market);
  } catch {
    return { ok: false, code: 'constraint_unavailable', reason: `${market}: Pacifica /info constraints unavailable` };
  }
  const beforeMark = checkEntryConstraints(row?.constraintObservation, market, Date.now());
  if (!beforeMark.ok) return beforeMark;
  const mark = await acquireMarkPrice(adapter, market);
  if (mark.kind === 'unavailable') return { ok: false, ...mark };
  if (!row || mark.protocolSymbol !== row.protocolSymbol) {
    return { ok: false, code: 'mark_price_unavailable', candidate: 'mark', reason: 'symbol_missing' };
  }
  const afterMark = checkEntryConstraints(row.constraintObservation, market, Date.now());
  if (!afterMark.ok) return afterMark;
  const checked = checkMarkPrice(mark, market, Date.now());
  return checked.kind === 'available' ? { ok: true } : { ok: false, ...checked };
}

export type PacificaConstraintAuthority =
  | (MarketConstraintObservation & { state: 'available'; tick: DecimalConstraint;
      lot: DecimalConstraint; openingMinimum: DecimalConstraint })
  | { state: 'unavailable'; venue: 'pacifica'; market: string; source: '/info'; reason: string;
      observedAt?: number; expiresAt?: number; refreshFailed: boolean };

export function marketConstraintView(observation: MarketConstraintObservation, now: number):
  import('./protocol-types').PacificaMarketConstraints {
  const admission = checkEntryConstraints(observation, observation.market, now);
  if (admission.ok && observation.tick && observation.lot && observation.openingMinimum) {
    return { constraintAuthority: { ...observation, state: 'available', tick: observation.tick,
      lot: observation.lot, openingMinimum: observation.openingMinimum },
      tickSize: observation.tick.value, lotSize: observation.lot.value,
      minOrderSizeBase: observation.lot.value, minOrderSizeUsd: observation.openingMinimum.value };
  }
  return { constraintAuthority: { state: 'unavailable', venue: 'pacifica', market: observation.market,
    source: '/info', observedAt: observation.observedAt, expiresAt: observation.expiresAt,
    refreshFailed: observation.refreshFailed, reason: admission.ok ? 'invalid_fields' : admission.reason } };
}

/** Revoke compatibility numbers on the same object retained by registry readers. */
export function refreshMarketConstraintView(market: import('./protocol-types').ProtocolMarket, now: number): void {
  if (!market.constraintAuthority || !market.constraintObservation) return;
  for (const field of ['tickSize', 'lotSize', 'minOrderSizeBase', 'minOrderSizeUsd']) Reflect.deleteProperty(market, field);
  Object.assign(market, marketConstraintView(market.constraintObservation, now));
}

export function hasNumericMarketConstraints(market: import('./protocol-types').ProtocolMarket):
  market is import('./protocol-types').ProtocolMarket & {
    tickSize: number; lotSize: number; minOrderSizeBase: number; minOrderSizeUsd: number;
  } {
  refreshMarketConstraintView(market, Date.now());
  return (!market.constraintAuthority || market.constraintAuthority.state === 'available')
    && [market.tickSize, market.lotSize, market.minOrderSizeBase, market.minOrderSizeUsd]
      .every(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
}
