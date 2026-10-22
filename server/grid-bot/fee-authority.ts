import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { canonicalRequest } from './request-digest';
const D = Decimal.clone({ precision: 100, toExpNeg: -100, toExpPos: 100 });
export function gridDecimal(raw: unknown, signed = false): string | null {
  if (typeof raw !== 'string' || raw.length > 80 || !(signed ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/).test(raw)) return null;
  const d = new D(raw); return d.isFinite() && d.abs().lt(1) ? d.toFixed() : null;
}
export interface GridFeeIdentity { account: string; subaccountId: string | null; market: string; liquidityRole: 'maker' | 'taker'; builderCode: string | null; intent: 'entry' | 'profit' }
export interface GridFeeQuote extends GridFeeIdentity {
  version: 1; protocol: 'pacifica'; baseRate: string; builderRate: string; effectiveRate: string;
  builder: { code: string; rate: string; approvalCeiling: string } | null;
  provenance: string; observedAt: number; expiresAt: number; quoteDigest: string;
}
export type GridFeeResult = { availability: 'available'; quote: GridFeeQuote } | { availability: 'unavailable'; reason: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createGridFeeQuote(identity: GridFeeIdentity, account: unknown, _overview: unknown, _approvals: unknown, now: number, ttlMs = 15_000): GridFeeResult {
  const deny = (reason: string): GridFeeResult => ({ availability: 'unavailable', reason });
  if (!identity.account || !identity.market || !['maker', 'taker'].includes(identity.liquidityRole) || !['entry', 'profit'].includes(identity.intent)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15_000) return deny('invalid_identity');
  // Grid is exempt by owner policy, regardless of generic builder configuration.
  if (identity.builderCode !== null) return deny('grid_builder_exempt');
  if (!account || typeof account !== 'object') return deny('account_unavailable');
  const a = account as Record<string, unknown>;
  if ((a.subaccount_id ?? null) !== identity.subaccountId || (a.account !== undefined && a.account !== identity.account)) return deny('identity_mismatch');
  const baseRate = gridDecimal(a[identity.liquidityRole === 'maker' ? 'maker_fee' : 'taker_fee'], identity.liquidityRole === 'maker');
  if (baseRate === null) return deny('fee_unavailable');
  const builder = null, builderRate = '0';
  const unsigned = { ...identity, version: 1 as const, protocol: 'pacifica' as const, baseRate, builderRate,
    effectiveRate: baseRate, builder,
    provenance: `pacifica:/account.${identity.liquidityRole}_fee:fresh-required`,
    observedAt: now, expiresAt: now + ttlMs };
  return { availability: 'available', quote: Object.freeze({ ...unsigned, quoteDigest: digest(unsigned) }) };
}
/** Validate the retained quote; never silently fetch or substitute new economics. */
export function validateGridFeeQuote(quote: GridFeeQuote, identity: GridFeeIdentity, now: number): boolean {
  try {
  if (!quote || !Number.isSafeInteger(now) || !Number.isSafeInteger(quote.observedAt) || !Number.isSafeInteger(quote.expiresAt)
    || now < quote.observedAt || now >= quote.expiresAt || quote.expiresAt - quote.observedAt > 15_000) return false;
  const { quoteDigest, ...unsigned } = quote;
  return quoteDigest === digest(unsigned) && quote.version === 1 && quote.protocol === 'pacifica' && quote.builderCode === null && identity.builderCode === null
    && Object.entries(identity).every(([k, v]) => unsigned[k as keyof typeof unsigned] === v)
    && gridDecimal(quote.baseRate, quote.liquidityRole === 'maker') !== null
    && quote.effectiveRate === quote.baseRate && quote.builder === null && quote.builderRate === '0';
  } catch { return false; }
}

/** Restore the production quote's original byte order after JSONB storage; preserve its digest. */
export function restoreGridFeeQuoteOrder(q: GridFeeQuote): GridFeeQuote {
  const restored: GridFeeQuote = { account:q.account, subaccountId:q.subaccountId, market:q.market, liquidityRole:q.liquidityRole,
    builderCode:q.builderCode, intent:q.intent, version:q.version, protocol:q.protocol, baseRate:q.baseRate, builderRate:q.builderRate,
    effectiveRate:q.effectiveRate, builder:q.builder===null?null:{code:q.builder.code,rate:q.builder.rate,approvalCeiling:q.builder.approvalCeiling},
    provenance:q.provenance, observedAt:q.observedAt, expiresAt:q.expiresAt, quoteDigest:q.quoteDigest };
  if(canonicalRequest(restored)!==canonicalRequest(q))throw Error('Grid retained fee quote changed');
  return restored;
}
