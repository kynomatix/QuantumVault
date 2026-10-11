import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
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
export function createGridFeeQuote(identity: GridFeeIdentity, account: unknown, overview: unknown, approvals: unknown, now: number, ttlMs = 15_000): GridFeeResult {
  const deny = (reason: string): GridFeeResult => ({ availability: 'unavailable', reason });
  if (!identity.account || !identity.market || !['maker', 'taker'].includes(identity.liquidityRole) || !['entry', 'profit'].includes(identity.intent)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15_000) return deny('invalid_identity');
  if (identity.builderCode !== 'CARRY') return deny('grid_builder_required');
  if (!account || typeof account !== 'object') return deny('account_unavailable');
  const a = account as Record<string, unknown>;
  if ((a.subaccount_id ?? null) !== identity.subaccountId || (a.account !== undefined && a.account !== identity.account)) return deny('identity_mismatch');
  const baseRate = gridDecimal(a[identity.liquidityRole === 'maker' ? 'maker_fee' : 'taker_fee'], identity.liquidityRole === 'maker');
  if (baseRate === null) return deny('fee_unavailable');
  let builder: GridFeeQuote['builder'] = null;
  if (identity.builderCode !== null) {
    if (!identity.builderCode || !Array.isArray(overview) || !Array.isArray(approvals)) return deny('builder_unavailable');
    const rows = overview.filter(r => r?.builder_code === identity.builderCode);
    const grants = approvals.filter(r => r?.builder_code === identity.builderCode);
    if (rows.length !== 1 || grants.length !== 1) return deny('builder_identity_ambiguous');
    const rate = gridDecimal(rows[0]?.fee_rate), ceiling = gridDecimal(grants[0]?.max_fee_rate);
    if (rate === null || ceiling === null || new D(rate).gt(ceiling)) return deny('builder_not_approved');
    builder = { code: identity.builderCode, rate, approvalCeiling: ceiling };
  }
  const builderRate = builder?.rate ?? '0';
  const unsigned = { ...identity, version: 1 as const, protocol: 'pacifica' as const, baseRate, builderRate,
    effectiveRate: new D(baseRate).plus(builderRate).toFixed(), builder,
    provenance: `pacifica:/account.${identity.liquidityRole}_fee+/builder/overview.fee_rate+/account/builder_codes/approvals.max_fee_rate:fresh-required`,
    observedAt: now, expiresAt: now + ttlMs };
  return { availability: 'available', quote: Object.freeze({ ...unsigned, builder: builder ? Object.freeze(builder) : null, quoteDigest: digest(unsigned) }) };
}
/** Validate the retained quote; never silently fetch or substitute new economics. */
export function validateGridFeeQuote(quote: GridFeeQuote, identity: GridFeeIdentity, now: number): boolean {
  try {
  if (!quote || !Number.isSafeInteger(now) || now < quote.observedAt || now >= quote.expiresAt || quote.expiresAt - quote.observedAt > 15_000) return false;
  const { quoteDigest, ...unsigned } = quote;
  return quoteDigest === digest(unsigned) && quote.version === 1 && quote.protocol === 'pacifica' && quote.builderCode === 'CARRY'
    && Object.entries(identity).every(([k, v]) => unsigned[k as keyof typeof unsigned] === v)
    && gridDecimal(quote.baseRate, quote.liquidityRole === 'maker') !== null && gridDecimal(quote.builderRate) !== null
    && new D(quote.baseRate).plus(quote.builderRate).eq(quote.effectiveRate)
    && (quote.builderCode === null ? quote.builder === null && quote.builderRate === '0' : quote.builder?.code === quote.builderCode
      && quote.builder.rate === quote.builderRate && gridDecimal(quote.builder.approvalCeiling) !== null && new D(quote.builder.rate).lte(quote.builder.approvalCeiling));
  } catch { return false; }
}
