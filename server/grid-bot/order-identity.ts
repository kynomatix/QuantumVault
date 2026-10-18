import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import { createHash } from 'node:crypto';
import { canonicalRequest, requestDigest as canonicalDigest } from './request-digest.js';
import Decimal from 'decimal.js';
import type { MarketConstraintObservation } from '../protocol/market-constraints.js';
import { checkEntryConstraints } from '../protocol/market-constraints.js';
import { type GridFeeQuote, validateGridFeeQuote, restoreGridFeeQuoteOrder } from './fee-authority.js';
import { gridRuntimePolicy } from './runtime-policy.js';
const D = Decimal.clone({ precision: 100 });
// Fixed UUID namespace (RFC-4122), retained from the reviewed WO-07 golden vector.
const namespace = Buffer.from('e1f1198e94155b78a409c77fd7c73cc8', 'hex');
export const isGridClientOrderId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export function gridClientOrderId(input: { botId: string; level: number; attempt: number; leg: 'entry' | 'profit' }): string {
  if (!input.botId || input.botId.trim() !== input.botId || !Number.isSafeInteger(input.level) || input.level < 1
    || !Number.isSafeInteger(input.attempt) || input.attempt < 0 || !['entry', 'profit'].includes(input.leg)) throw new Error('Invalid Grid order identity');
  const bytes = createHash('sha1').update(namespace).update(JSON.stringify({ v: 1, botId: input.botId, level: input.level, attempt: input.attempt, leg: input.leg })).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export interface GridVenueOrder {
  orderId: string; clientOrderId: string | null; symbol: string; side: 'long' | 'short';
  price: string; amount: string; filledAmount: string; cancelledAmount: string | null;
  reduceOnly: boolean; orderType: string; createdAt: number; updatedAt: number;
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';
  reason?: string | null;
}
const exactAmount = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
export function parseGridVenueOrders(raw: unknown, history = false): GridVenueOrder[] {
  if (!Array.isArray(raw)) throw new Error('Grid order inventory unavailable');
  return raw.map((r: Record<string, unknown>) => {
    if (!r || typeof r !== 'object') throw new Error('Malformed Grid venue order');
    const id = typeof r.order_id === 'string' && /^[1-9]\d*$/.test(r.order_id) ? r.order_id
      : Number.isSafeInteger(r.order_id) && (r.order_id as number) > 0 ? String(r.order_id) : null;
    const price = history ? r.initial_price : r.price;
    const amount = history ? r.amount : r.initial_amount;
    const status = history ? r.order_status : 'open';
    if (!id || typeof r.symbol !== 'string' || !r.symbol || !['bid', 'ask'].includes(r.side as string)
      || (r.client_order_id !== null && r.client_order_id !== undefined && !isGridClientOrderId(r.client_order_id))
      || !exactAmount(price) || !exactAmount(amount) || !exactAmount(r.filled_amount)
      || (!history && !exactAmount(r.cancelled_amount)) || typeof r.reduce_only !== 'boolean'
      || typeof r.order_type !== 'string' || !r.order_type || !Number.isSafeInteger(r.created_at)
      || !Number.isSafeInteger(r.updated_at) || (r.created_at as number) < 0 || (r.updated_at as number) < (r.created_at as number)
      || !['open', 'partially_filled', 'filled', 'cancelled', 'rejected'].includes(status as string)
      || !new D(amount).gt(0) || (!history && r.order_type === 'limit' && !new D(price).gt(0)) || new D(r.filled_amount).gt(amount)
      || (!history && new D(r.filled_amount).plus(r.cancelled_amount as string).gt(amount))) throw new Error('Malformed Grid venue order');
    return { orderId: id, clientOrderId: r.client_order_id as string | undefined ?? null, symbol: r.symbol, side: r.side === 'bid' ? 'long' : 'short',
      price, amount, filledAmount: r.filled_amount, cancelledAmount: history ? null : r.cancelled_amount as string,
      reduceOnly: r.reduce_only, orderType: r.order_type, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
      status: status as GridVenueOrder['status'], ...(history ? {reason:typeof r.reason==='string'?r.reason:null}: {}) };
  });
}
export interface GridOrderLookup { state: 'open' | 'filled' | 'cancelled' | 'unknown'; orderId: string | null; reason: string | null; order?: GridVenueOrder }
export function resolveGridOrder(clientOrderId: string, symbol: string, open: GridVenueOrder[], history: GridVenueOrder[] | null): GridOrderLookup {
  const unknown = (reason: string): GridOrderLookup => ({ state: 'unknown', orderId: null, reason });
  if (!isGridClientOrderId(clientOrderId) || !symbol) return unknown('invalid_identity');
  const live = open.filter(o => o.clientOrderId === clientOrderId);
  if (live.length > 1 || live.some(o => o.symbol !== symbol)) return unknown('conflicting_open_identity');
  if (live.length === 1) return { state: 'open', orderId: live[0].orderId, reason: null, order: live[0] };
  if (history === null) return unknown('history_unavailable_or_incomplete');
  const matches = history.filter(o => o.clientOrderId === clientOrderId);
  if (matches.length !== 1 || matches.some(o => o.symbol !== symbol)) return unknown(matches.length ? 'conflicting_history_identity' : 'absence_is_not_settlement');
  const o = matches[0];
  if (o.status === 'filled' && new D(o.filledAmount).eq(o.amount)) return { state: 'filled', orderId: o.orderId, reason: null, order: o };
  if (o.status === 'cancelled') return { state: 'cancelled', orderId: o.orderId, reason: null, order: o };
  return unknown('no_terminal_settlement');
}
export interface GridOrderIntent {
  runtimePolicyVersion?: string;
  account: string; subaccountId: string | null; market: string; protocolSymbol: string;
  signerPublicKey: string; signerGeneration: string; deployment: string; endpoint: string;
  clientOrderId: string; side: 'long' | 'short'; price: string; amount: string; reduceOnly: boolean;
  signingTimestamp: number; signingExpiryMs: number;
}
export interface PreparedGridOrder {
  version: 1; intent: GridOrderIntent; feeQuote: GridFeeQuote; constraint: MarketConstraintObservation;
  policyDigest: string; constraintDigest: string; requestDigest: string;
  unsigned: { account: string; subaccount_id?: string; symbol: string; price: string; amount: string;
    side: 'bid' | 'ask'; tif: 'ALO'; reduce_only: boolean; client_order_id: string; builder_code?: string };
}
const digest = (value: unknown, runtimeVersion?: string) => isGridCyclePolicyVersion(runtimeVersion)
  ? canonicalDigest(value) : createHash('sha256').update(JSON.stringify(value)).digest('hex');
const feeIdentity = (intent: GridOrderIntent, quote: GridFeeQuote) => ({ account: intent.account, subaccountId: intent.subaccountId,
  market: intent.market, liquidityRole: 'maker' as const, builderCode: quote.builderCode, intent: intent.reduceOnly ? 'profit' as const : 'entry' as const });
export function prepareGridOrder(intent: GridOrderIntent, quote: GridFeeQuote, constraint: MarketConstraintObservation, now: number): PreparedGridOrder {
  const runtime = gridRuntimePolicy(intent.runtimePolicyVersion ?? '1.0.0');
  if(isGridCyclePolicyVersion(intent.runtimePolicyVersion))quote = restoreGridFeeQuoteOrder(quote);
  if (!runtime) throw new Error('Unknown Grid runtime policy');
  if (!intent.account || !intent.signerPublicKey || !intent.signerGeneration || !intent.deployment || intent.endpoint !== 'https://api.pacifica.fi/api/v1/orders/create' || !intent.protocolSymbol || intent.market !== `${intent.protocolSymbol}-PERP`
    || !isGridClientOrderId(intent.clientOrderId) || !['long', 'short'].includes(intent.side) || typeof intent.reduceOnly !== 'boolean'
    || !exactAmount(intent.price) || !exactAmount(intent.amount) || !new D(intent.price).gt(0) || !new D(intent.amount).gt(0)
    || !Number.isSafeInteger(intent.signingTimestamp) || intent.signingTimestamp !== now || !Number.isSafeInteger(intent.signingExpiryMs)
    || intent.signingExpiryMs <= 0 || intent.signingExpiryMs > 15_000 || (intent.subaccountId !== null && !intent.subaccountId)) throw new Error('Invalid Grid order intent');
  if (!validateGridFeeQuote(quote, feeIdentity(intent, quote), now) || !checkEntryConstraints(constraint, intent.market, now).ok) throw new Error('Grid authority unavailable');
  if ([constraint.tick, constraint.lot, constraint.openingMinimum].some(c => !c || !exactAmount(c.exact) || !new D(c.exact).gt(0)
    || !Number.isFinite(c.value) || Number(c.exact) !== c.value)) throw new Error('Malformed Grid market constraints');
  // Preserve exact planned geometry; do not re-quantize an authorized request.
  if (!new D(intent.price).mod(constraint.tick!.exact).eq(0) || !new D(intent.amount).mod(constraint.lot!.exact).eq(0)
    || (!intent.reduceOnly && new D(intent.price).mul(intent.amount).lt(constraint.openingMinimum!.exact))) throw new Error('Grid geometry violates market constraints');
  const unsigned: PreparedGridOrder['unsigned'] = { account: intent.account,
    ...(intent.subaccountId === null ? {} : { subaccount_id: intent.subaccountId }), symbol: intent.protocolSymbol,
    price: intent.price, amount: intent.amount, side: intent.side === 'long' ? 'bid' : 'ask', tif: 'ALO', reduce_only: intent.reduceOnly,
    client_order_id: intent.clientOrderId, ...(quote.builder === null ? {} : { builder_code: quote.builder.code }) };
  const value = { version: 1 as const, intent: { ...intent }, feeQuote: quote, constraint: structuredClone(constraint),
    policyDigest: runtime.digest, constraintDigest: digest(constraint, intent.runtimePolicyVersion), unsigned };
  return { ...value, requestDigest: digest(value, intent.runtimePolicyVersion) };
}
export function validatePreparedGridOrder(prepared: PreparedGridOrder, current: { account: string; subaccountId: string | null;
  signerPublicKey: string; signerGeneration: string; deployment: string; endpoint: string; constraint: MarketConstraintObservation; runtimePolicyVersion?: string }, now: number): boolean {
  try {
    const { requestDigest, ...value } = prepared;
    const runtime = gridRuntimePolicy(current.runtimePolicyVersion ?? '1.0.0');
    if (!runtime || (prepared.intent.runtimePolicyVersion ?? '1.0.0') !== (current.runtimePolicyVersion ?? '1.0.0')
      || requestDigest !== digest(value, current.runtimePolicyVersion) || prepared.policyDigest !== runtime.digest || prepared.constraintDigest !== digest(current.constraint, current.runtimePolicyVersion)
      || Object.entries(current).some(([k, v]) => k !== 'constraint' && k !== 'runtimePolicyVersion' && prepared.intent[k as keyof GridOrderIntent] !== v)
      || now < prepared.intent.signingTimestamp || now >= prepared.intent.signingTimestamp + prepared.intent.signingExpiryMs) return false;
    const rebuilt = prepareGridOrder({ ...prepared.intent, signingTimestamp: now }, prepared.feeQuote, current.constraint, now);
    // JSONB and exact-request persistence may reorder every object key. V1 bytes stay unchanged.
    return isGridCyclePolicyVersion(current.runtimePolicyVersion)
      ? canonicalRequest(rebuilt.unsigned) === canonicalRequest(prepared.unsigned)
      : JSON.stringify(rebuilt.unsigned) === JSON.stringify(prepared.unsigned);
  } catch { return false; }
}
/** Unit 4 can compose this fee/identity check with funding, stop, quota and runtime gates before signing. */
export async function withGridOrderAuthority<T>(prepared: PreparedGridOrder, current: Parameters<typeof validatePreparedGridOrder>[1], now: number,
  dispatch: (request: PreparedGridOrder['unsigned']) => Promise<T>): Promise<{ disposition: 'not_sent' } | { disposition: 'dispatched'; result: T }> {
  if (!validatePreparedGridOrder(prepared, current, now)) return { disposition: 'not_sent' };
  // Copy so a dispatch implementation cannot mutate the retained request evidence.
  return { disposition: 'dispatched', result: await dispatch({ ...prepared.unsigned }) };
}
